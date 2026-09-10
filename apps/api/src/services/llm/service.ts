// SPDX-License-Identifier: Apache-2.0

import { auditSink, setAuditSink, type LlmAuditRecord } from "./audit.js";
import { prismaAuditSink } from "./audit-prisma.js";
import { getGovernanceConfig, resolveFeaturePlan, resolveSystemPrompt, type Candidate } from "./config.js";
import { checkGovernor } from "./governor.js";
import { cacheGet, cachePut, cacheKey } from "./cache.js";
import { isOpen, recordFailure, recordSuccess } from "./breaker.js";
import { openAiAdapter, openRouterAdapter } from "./providers/openai-compatible.js";
import { estimateCostMicroUsd } from "./registry.js";
import { assertSizeWithin, hashMessages, hashText, parseSchema, redactMessages } from "./guardrails.js";
import {
  LlmProviderError,
  LlmUnavailableError,
  type LlmMessage,
  type LlmProvider,
  type LlmProviderName,
  type LlmRequest,
  type LlmResult,
  type ProviderRequest,
} from "./types.js";

/**
 * LlmService — the one entry point. Ported from v1's `services/llm/service.ts`.
 * Callers use `complete`; everything internal (routing, redaction, size caps,
 * failover, JSON repair, cost accounting, audit, deterministic fallback)
 * happens here so no call site ever touches a provider.
 *
 * THE CONTRACT CALLERS RELY ON: `complete` never throws, as long as the caller
 * supplied a `fallback`. Every consumer in `consumers/` supplies one, so every
 * planner assist works with ZERO API keys configured. `fallbackUsed` on the
 * result says which path answered, and consumers must report that honestly —
 * a fallback is never labelled as an LLM result.
 *
 * NOT ported from v1 (see `governor.ts` for the full reasoning): the sharded
 * pre-egress quota reservation. This service checks the governor before
 * egress, but that check is post-hoc against settled audit rows.
 */

const MAX_PROMPT_CHARS = 200_000; // coarse outbound cap; refuse rather than overspend

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class LlmService {
  private readonly adapters: Partial<Record<Exclude<LlmProviderName, "fallback">, LlmProvider>> = {
    openai: openAiAdapter(),
    openrouter: openRouterAdapter(),
  };

  async complete<T = string>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const started = Date.now();
    const [plan, prompt, gov] = await Promise.all([
      resolveFeaturePlan(req.feature, req.accountId),
      resolveSystemPrompt(req.feature, req.accountId),
      getGovernanceConfig(),
    ]);

    // Prepend the TRUSTED, admin-editable system prompt (never redacted — it is
    // our instruction, not user data). Redact the caller content ONLY for
    // features whose content is incidental; submission review keeps it intact
    // and relies on data-class routing to cleared providers instead.
    const caller = plan.redactContent ? redactMessages(req.messages) : req.messages;
    const messages: LlmMessage[] = [{ role: "system", content: prompt.text }, ...caller];
    try {
      assertSizeWithin(messages, MAX_PROMPT_CHARS);
    } catch (e) {
      // A guardrail refusal is still a no-throw path for the caller.
      return this.fallback(req, started, "n/a", prompt.version, (e as Error).message);
    }
    const promptHash = hashMessages(messages);
    const pv = prompt.version;

    // Disabled feature or nothing safe to route to -> deterministic fallback.
    if (!plan.enabled || plan.candidates.length === 0) {
      return this.fallback(req, started, promptHash, pv, plan.enabled ? "no capable model" : "feature disabled");
    }

    // No credential for ANY routed provider is the normal local/zero-key case.
    // Short-circuit before the governor so the overwhelmingly common
    // "no key configured" path costs no metering queries at all.
    const anyConfigured = plan.candidates.some((c) =>
      this.adapters[c.model.provider as Exclude<LlmProviderName, "fallback">]?.isConfigured()
    );
    if (!anyConfigured) {
      return this.fallback(req, started, promptHash, pv, "no provider credential configured");
    }

    // Dedupe: for deterministic (temp 0) calls or an explicit idempotencyKey, a
    // shared cache hit skips the provider entirely (no spend, no rate cost).
    //
    // NEVER for a `proprietary`-class feature. Today that is `submission_review`
    // alone (`features.ts`), whose whole job is to judge THIS contributor's
    // bytes: a cached verdict is a claim about a model run that did not happen
    // for this item, which is the same class of dishonesty as a fabricated
    // score. The cache key does incorporate the message hash, so a hit would
    // require byte-identical content — but the cost of being wrong here is a
    // false trust claim on a submission, and re-asking a live model is cheap
    // next to that, so the gate is on the data class rather than on the
    // circumstances. (v1 instead relies on `submission_review` always being
    // called with a per-submission idempotencyKey; this is the same intent
    // enforced by the layer rather than by every caller remembering.) An
    // idempotencyKey passed for such a feature still serves its other role:
    // the audit-log correlation id.
    const primary = plan.candidates[0]!;
    const deterministic = primary.params.temperature === 0;
    const cacheable = plan.dataClass !== "proprietary";
    const ck =
      cacheable && gov.cacheTtlMs > 0 && (req.idempotencyKey || deterministic)
        ? cacheKey({
            feature: req.feature,
            model: primary.model.id,
            promptVersion: pv,
            promptHash,
            idempotencyKey: req.idempotencyKey,
          })
        : null;
    if (ck) {
      const cached = await cacheGet<LlmResult<T>>(ck);
      if (cached) return cached;
    }

    const decision = await checkGovernor(req.feature, req.userId, gov);
    if (decision.blocked) {
      return this.fallback(req, started, promptHash, pv, decision.reason ?? "governor blocked");
    }

    // Failover chain. Skip circuit-open providers. Within a candidate, retry
    // ONCE on a retryable error (429 / 5xx / timeout) with jitter before
    // advancing — a transient blip shouldn't consume a failover slot. A
    // non-retryable error (bad request, auth, unparseable output) advances
    // immediately. Only a model AFTER the first to answer counts as a failover.
    let lastErr = "";
    for (let i = 0; i < plan.candidates.length; i++) {
      const cand = plan.candidates[i]!;
      const provider = cand.model.provider as Exclude<LlmProviderName, "fallback">;
      if (isOpen(provider)) {
        lastErr = `${provider} circuit open`;
        continue;
      }
      const adapter = this.adapters[provider];
      if (!adapter?.isConfigured()) {
        lastErr = `${provider} not configured`;
        continue;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await this.callOne<T>(req, cand, messages, promptHash, pv, started, i > 0);
          recordSuccess(provider);
          if (ck) void cachePut(ck, req.feature, result, gov.cacheTtlMs); // best-effort
          return result;
        } catch (e) {
          lastErr = e instanceof LlmProviderError ? e.message : (e as Error).message;
          const retryable = e instanceof LlmProviderError ? e.retryable : false;
          // Only transient transport failures affect provider health; a schema
          // parse failure is model quality, not an outage.
          if (retryable) recordFailure(provider, gov.breakerThreshold, gov.breakerCooldownMs);
          if (retryable && attempt === 0) {
            await sleep(120 + Math.random() * 280); // jittered same-model retry
            continue;
          }
          break; // give up on this candidate -> advance
        }
      }
    }

    // Every live model exhausted -> deterministic fallback.
    return this.fallback(req, started, promptHash, pv, `all providers failed: ${lastErr}`);
  }

  /** One candidate call, incl. the single bounded JSON-repair round-trip. */
  private async callOne<T>(
    req: LlmRequest<T>,
    cand: Candidate,
    messages: LlmMessage[],
    promptHash: string,
    promptVersion: string,
    started: number,
    failoverUsed: boolean
  ): Promise<LlmResult<T>> {
    const adapter = this.adapters[cand.model.provider as Exclude<LlmProviderName, "fallback">]!;
    const wantJson = !!req.schema;
    const base: ProviderRequest = {
      model: cand.model.id,
      messages,
      params: { ...cand.params, ...req.overrides },
      json: wantJson,
    };

    const first = await adapter.complete(base);
    let text = first.text;
    let inTok = first.inputTokens;
    let outTok = first.outputTokens;

    if (req.schema) {
      let parsed = parseSchema(req.schema, text);
      if (!parsed.ok) {
        // One repair round-trip: re-ask with the validation error.
        const repair = await adapter.complete({
          ...base,
          messages: [
            ...messages,
            { role: "assistant", content: text },
            {
              role: "user",
              content: `Your reply failed validation: ${parsed.error}. Reply again with ONLY valid JSON.`,
            },
          ],
        });
        text = repair.text;
        inTok += repair.inputTokens;
        outTok += repair.outputTokens;
        parsed = parseSchema(req.schema, text);
        if (!parsed.ok) {
          throw new LlmProviderError(
            `schema parse failed after repair: ${parsed.error}`,
            adapter.name,
            false
          );
        }
      }
      return this.finish(req, cand, promptHash, promptVersion, text, inTok, outTok, started, failoverUsed, parsed.value);
    }

    return this.finish(
      req, cand, promptHash, promptVersion, text, inTok, outTok, started, failoverUsed,
      text as unknown as T
    );
  }

  private async finish<T>(
    req: LlmRequest<T>,
    cand: Candidate,
    promptHash: string,
    promptVersion: string,
    text: string,
    inputTokens: number,
    outputTokens: number,
    started: number,
    failoverUsed: boolean,
    data: T
  ): Promise<LlmResult<T>> {
    const costMicroUsd = estimateCostMicroUsd(cand.model, inputTokens, outputTokens);
    const audited = await this.emit({
      feature: req.feature,
      provider: cand.model.provider,
      model: cand.model.id,
      userId: req.userId,
      accountId: req.accountId,
      promptHash,
      promptVersion,
      outputHash: hashText(text),
      inputTokens,
      outputTokens,
      costMicroUsd,
      fallbackUsed: false,
      failoverUsed,
      latencyMs: Date.now() - started,
      ok: true,
    });
    if (!audited) {
      // We may already have paid the provider, so do not retry it. The outer
      // request returns the caller's fallback rather than an unaudited result:
      // the audit log is also the spend/rate ledger, so an unrecorded call is
      // an unbounded one.
      throw new LlmProviderError(
        "LLM audit evidence could not be persisted",
        cand.model.provider as LlmProviderName,
        false
      );
    }
    return {
      data,
      provider: cand.model.provider,
      model: cand.model.id,
      usage: { inputTokens, outputTokens, costMicroUsd },
      fallbackUsed: false,
      failoverUsed,
    };
  }

  /** Deterministic fallback — the caller's safe default. Never throws unless the
   * caller supplied none (then LlmUnavailableError). Always audited. */
  private async fallback<T>(
    req: LlmRequest<T>,
    started: number,
    promptHash: string,
    promptVersion: string,
    reason: string
  ): Promise<LlmResult<T>> {
    if (req.fallback === undefined) {
      await this.emit(this.failRecord(req, promptHash, promptVersion, started, reason));
      throw new LlmUnavailableError(req.feature, reason);
    }
    const data =
      typeof req.fallback === "function" ? await (req.fallback as () => T | Promise<T>)() : req.fallback;
    await this.emit({
      feature: req.feature,
      provider: "fallback",
      model: "deterministic",
      userId: req.userId,
      accountId: req.accountId,
      promptHash,
      promptVersion,
      outputHash: "n/a",
      inputTokens: 0,
      outputTokens: 0,
      costMicroUsd: 0,
      fallbackUsed: true,
      failoverUsed: false,
      latencyMs: Date.now() - started,
      ok: true,
      error: reason,
    });
    return {
      data,
      provider: "fallback",
      model: "deterministic",
      usage: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 },
      fallbackUsed: true,
      failoverUsed: false,
    };
  }

  private failRecord(
    req: LlmRequest<unknown>,
    promptHash: string,
    promptVersion: string,
    started: number,
    reason: string
  ): LlmAuditRecord {
    return {
      feature: req.feature,
      provider: "fallback",
      model: "none",
      userId: req.userId,
      accountId: req.accountId,
      promptHash,
      promptVersion,
      outputHash: "n/a",
      inputTokens: 0,
      outputTokens: 0,
      costMicroUsd: 0,
      fallbackUsed: true,
      failoverUsed: false,
      latencyMs: Date.now() - started,
      ok: false,
      error: reason,
    };
  }

  private async emit(rec: LlmAuditRecord): Promise<boolean> {
    try {
      await auditSink().record(rec);
      return true;
    } catch {
      return false;
    }
  }
}

/** The shared singleton. Import this everywhere. */
export const llm = new LlmService();

// Durable audit is the default — every call lands in llm_audit_log, which is
// also the governor's source of truth. Overridable via setAuditSink (e.g. tests).
setAuditSink(prismaAuditSink);
