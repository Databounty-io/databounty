// SPDX-License-Identifier: Apache-2.0

import { providerKey } from "../config.js";
import {
  LlmProviderError,
  type LlmProvider,
  type LlmProviderName,
  type ProviderRequest,
  type ProviderResult,
} from "../types.js";

/**
 * Shared adapter for OpenAI's Chat Completions API and any OpenAI-compatible
 * gateway (OpenRouter speaks the same shape). Ported from v1's
 * `services/llm/providers/openai-compatible.ts`. Transport only; global fetch,
 * no SDK dependency.
 *
 * v1's Anthropic-direct adapter is NOT ported: this deployment wires no
 * `ANTHROPIC_API_KEY` and `registry.ts` therefore has no Anthropic-direct
 * model entry, so that adapter would be unreachable code. The Anthropic models
 * this app uses are reached through OpenRouter.
 */
export class OpenAiCompatibleAdapter implements LlmProvider {
  constructor(
    readonly name: LlmProviderName,
    private readonly baseUrl: string,
    private readonly keyName: "openai" | "openrouter"
  ) {}

  isConfigured(): boolean {
    return !!providerKey(this.keyName);
  }

  async complete(req: ProviderRequest): Promise<ProviderResult> {
    const key = providerKey(this.keyName);
    if (!key) throw new LlmProviderError(`${this.keyName} key not set`, this.name, false);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), req.params.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.params.maxTokens,
          temperature: req.params.temperature,
          ...(req.json ? { response_format: { type: "json_object" } } : {}),
          // OpenRouter otherwise balances providers primarily for price. The
          // interactive planner has a user waiting, so prefer low-latency
          // providers. Both of these are PREFERENCES — they reorder endpoints,
          // they do not exclude any.
          //
          // `require_parameters: true` used to be here as well and was removed:
          // it is a HARD filter, and combined with `response_format:
          // json_object` it eliminated every endpoint for a model that does not
          // itself declare native JSON-mode support, so OpenRouter answered 404
          // "No endpoints found". Verified live against this deployment's key:
          // `anthropic/claude-sonnet-4` + response_format + require_parameters
          // => 404, while the same request without require_parameters, and the
          // same request for `anthropic/claude-haiku-4.5` (which does declare
          // it), both succeed on Amazon Bedrock. That silently disqualified
          // `submission_review`'s PRIMARY model — the higher-reasoning route
          // the admin console advertises for the quality gate — leaving every
          // review to land on the haiku failover with `failover_used = true`.
          // The flag bought nothing here: this layer never relies on native
          // JSON mode. `guardrails.extractJson` strips a code fence or
          // surrounding prose, `parseSchema` validates against the caller's
          // schema, and `service.callOne` spends one bounded repair round-trip
          // before moving on — so a provider that ignores `response_format` is
          // already handled, whereas a 404 is a non-retryable error that burns
          // the candidate outright.
          ...(this.keyName === "openrouter"
            ? { provider: { sort: "latency", preferred_max_latency: { p90: 3 } } }
            : {}),
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
    } catch (e) {
      const aborted = (e as Error).name === "AbortError";
      throw new LlmProviderError(
        aborted ? `${this.name} timeout` : `${this.name} fetch failed: ${(e as Error).message}`,
        this.name
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new LlmProviderError(`${this.name} ${res.status}`, this.name, retryable);
    }

    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: body.choices?.[0]?.message?.content ?? "",
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    };
  }
}

export const openAiAdapter = () => new OpenAiCompatibleAdapter("openai", "https://api.openai.com/v1", "openai");
export const openRouterAdapter = () =>
  new OpenAiCompatibleAdapter("openrouter", "https://openrouter.ai/api/v1", "openrouter");
