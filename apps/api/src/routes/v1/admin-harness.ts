// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import { ADMIN_AND_ABOVE_READONLY, ADMIN_ONLY, type AuthedUser, requireRole } from "../../lib/rbac.js";
import { config } from "../../config.js";
import { configuredProviders } from "../../services/execution-providers/provider-order.js";
import { executionContractPassed } from "../../services/execution-providers/contract.js";
import { notifyAdmins } from "../../services/notifications.js";
import { dbJobQueue } from "../../services/jobs.js";

/**
 * Admin-bound execution harnesses for sponsor custom/forked dataset types.
 * Registered under `/v1/admin/dataset-types/:id/harness` (see index.ts).
 * Ported from v1's `routes/v1/admin-harness.ts` + `services/dataset-type-harness.ts`
 * onto community's `DatasetTypeHarness` model, which is structurally
 * identical to v1's.
 *
 * Authoring is ADMIN_ONLY: harness code decides execution verdicts, so
 * sponsor-supplied source is rejected structurally — there is no route a
 * sponsor credential can reach. Every mutation is audit-logged.
 *
 * `POST /proof-run` is ASYNC (matches v1's `harness.proof_run` job): it
 * validates, flips the harness to `proof_pending`, enqueues a
 * `harness.proof_run` job via `dbJobQueue`, and returns 202 immediately. The
 * real sandbox run happens in `runHarnessProofJob` below, invoked from
 * `worker.ts`. This was previously synchronous inside the request handler —
 * a prior pass here deliberately deferred the async conversion because its
 * write scope excluded `jobs.ts`/`worker.ts` (both owned by other agents at
 * the time; `jobs.ts`'s `JobType` union had no harness-proof entry). Now that
 * this pass owns all three files, the conversion is made. No admin-UI change
 * was needed: `apps/admin/components/harness-panel.tsx`'s `call()` helper
 * already ignores the POST response body and re-fetches via `GET /` (whose
 * result is what renders), and it already polls every 5s while the latest
 * row's status is `proof_pending` — it was built anticipating exactly this
 * async behavior, so the previous synchronous handler was already
 * indistinguishable from async at the UI layer (the poll just never had
 * anything to catch, since the row never spent more than one request cycle
 * `proof_pending`).
 *
 * DEVIATION FROM v1 (scope-driven, see final report):
 *  - v1's harness-assembly step (`buildBoundHarness` in the v1-only
 *    `services/execution-providers/registry-loader.ts`, which does not exist
 *    in community) wraps admin source with the same `registry/lib/helpers.js`
 *    + `run.js` scaffolding a catalog harness gets. That module is out of
 *    scope to create here, so this file assembles a minimal, self-contained
 *    Node script instead (see `buildProofScript` below): it requires the
 *    harness to `module.exports = { verify(payload, helpers) }` (or a bare
 *    `verify` export) returning `{ passed, brokenCodeFailedTests?, logs? }`
 *    or throwing, and prints a single `HARNESS_VERDICT:<json>` line the
 *    sandbox stdout is parsed for. This is REAL sandbox execution, not a
 *    stub — but it is a narrower contract than the registry harness scaffold
 *    and is flagged for owner review.
 *  - v1's `createHarnessDraft` also refuses a draft when the type still
 *    inherits a platform-registry harness that would take precedence
 *    (`inheritedRegistryHarnessName`, from the same missing
 *    `registry-loader.ts`). Not ported — flagged as a gap.
 */

const typeParams = z.object({ id: z.string().trim().min(1).max(120) }).strict();

const draftBody = z
  .object({
    source: z.string().min(20).max(100_000),
    declaredRuntimes: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  })
  .strict();

const shaField = z.string().trim().regex(/^[a-f0-9]{64}$/).optional();
const bindBody = z.object({ expectedSourceSha: shaField }).strict();

const proofBody = z
  .object({
    expectedSourceSha: shaField,
    samples: z
      .array(
        z
          .object({
            payload: z.record(z.unknown()),
            expected: z.enum(["pass", "fail"]),
            label: z.string().trim().max(120).optional(),
          })
          .strict()
      )
      .min(2)
      .max(10),
  })
  .strict();

class HarnessError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409
  ) {
    super(message);
  }
}

function sendHarnessError(
  reply: { badRequest(m: string): unknown; notFound(m: string): unknown; conflict(m: string): unknown },
  err: HarnessError
) {
  if (err.statusCode === 400) return reply.badRequest(err.message);
  if (err.statusCode === 404) return reply.notFound(err.message);
  return reply.conflict(err.message);
}

function sourceShaOf(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/**
 * Structural validation of harness source. Deliberately STATIC — no `eval`,
 * no `new Function`, no `require` of the source in this process; the only
 * place it ever runs is the no-network sandbox during a proof run. Ported
 * from v1's `harnessSourceError`.
 */
function harnessSourceError(source: string): string | null {
  const text = source.trim();
  if (text.length < 20) return "harness source is too short to be a module";
  if (!/\b(module\.exports|exports)\s*(\.\s*verify\b|=\s*\{)/.test(text) && !/\bverify\s*:/.test(text)) {
    return "harness source must export a verify function — `module.exports = { verify(row, h) { … } }` or `module.exports.verify = …`";
  }
  const banned: Array<[RegExp, string]> = [
    [/\brequire\(\s*['"]node:(net|http|https|dns|tls)['"]\s*\)/, "network modules are unavailable in the sandbox (no egress)"],
    [/\brequire\(\s*['"](net|http|https|dns|tls)['"]\s*\)/, "network modules are unavailable in the sandbox (no egress)"],
    [/\bfetch\s*\(/, "fetch is unavailable in the sandbox (no egress)"],
    [/\bprocess\s*\.\s*env\b/, "process.env is not part of the harness contract; declare runtimes instead"],
  ];
  for (const [pattern, reason] of banned) {
    if (pattern.test(text)) return `harness source rejected: ${reason}`;
  }
  return null;
}

const HARNESS_STATUS = { draft: "draft", proofPending: "proof_pending", verified: "verified", retired: "retired" } as const;
const MAX_PROOF_SAMPLES = 10;

type ProofActual = "pass" | "fail" | "harness_fault" | "no_verdict" | "runtime_unavailable" | "error";

interface ProofSampleResult {
  index: number;
  label: string | null;
  expected: "pass" | "fail";
  actual: ProofActual;
  logsExcerpt: string;
}

interface ProofEvidence {
  outcome: "passed" | "failed";
  sourceSha: string;
  samples: ProofSampleResult[];
  ranAt: string;
  reason?: string;
}

const VERDICT_PREFIX = "HARNESS_VERDICT:";

/** Minimal, self-contained proof script (see file header deviation note). No
 * network, no ambient env — the payload is inlined as a JSON literal and the
 * admin-authored source is appended verbatim. */
function buildProofScript(source: string, payload: Record<string, unknown>): string {
  return [
    "'use strict';",
    "const module = { exports: {} };",
    "const exports = module.exports;",
    `const __payload = ${JSON.stringify(payload)};`,
    "const __helpers = {};",
    "let __verdict = null;",
    "let __harnessFault = false;",
    "let __faultMessage = '';",
    "try {",
    source,
    "  const __verify = (module.exports && typeof module.exports.verify === 'function') ? module.exports.verify",
    "    : (typeof exports.verify === 'function' ? exports.verify",
    "    : (typeof verify === 'function' ? verify : null));",
    "  if (typeof __verify !== 'function') { __harnessFault = true; __faultMessage = 'no verify() export found'; }",
    "  else {",
    "    const __result = __verify(__payload, __helpers);",
    "    if (!__result || typeof __result !== 'object' || typeof __result.passed !== 'boolean') {",
    "      __harnessFault = true; __faultMessage = 'verify() did not return { passed: boolean, ... }';",
    "    } else { __verdict = __result; }",
    "  }",
    "} catch (e) { __harnessFault = true; __faultMessage = e && e.message ? String(e.message) : String(e); }",
    "console.log(" +
      `${JSON.stringify(VERDICT_PREFIX)}` +
      " + JSON.stringify(__harnessFault ? { harnessFault: true, error: __faultMessage } : __verdict));",
  ].join("\n");
}

function parseProofOutput(stdout: string): { passed?: boolean; brokenCodeFailedTests?: boolean; logs?: string; harnessFault?: boolean; error?: string } | null {
  const line = stdout.split("\n").find((l) => l.startsWith(VERDICT_PREFIX));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(VERDICT_PREFIX.length));
  } catch {
    return null;
  }
}

/** Classify one parsed harness result exactly as production would (v1's
 * `classifyProofResult`, ported). */
function classifyProofResult(parsed: { passed?: boolean; brokenCodeFailedTests?: boolean; harnessFault?: boolean }, fields: Array<{ key?: string }>, rawLogs: string): { actual: ProofActual; logs: string } {
  if (parsed.harnessFault) return { actual: "harness_fault", logs: rawLogs };
  if (typeof parsed.passed !== "boolean") return { actual: "harness_fault", logs: rawLogs };
  const contractPassed = executionContractPassed({
    runnerPassed: parsed.passed,
    brokenCodeFailedTests: parsed.brokenCodeFailedTests,
    fields,
  });
  if (contractPassed === null) {
    return { actual: "no_verdict", logs: rawLogs || "harness omitted the required broken-code assertion" };
  }
  return { actual: contractPassed ? "pass" : "fail", logs: rawLogs };
}

async function runProofSample(
  source: string,
  sample: { payload: Record<string, unknown>; expected: "pass" | "fail"; label?: string },
  fields: Array<{ key?: string }>
): Promise<{ actual: ProofActual; logs: string }> {
  const providers = configuredProviders().filter((p) => p.isConfigured());
  if (!providers.length) return { actual: "error", logs: "no sandbox provider configured" };
  const script = buildProofScript(source, sample.payload);
  const attempts: string[] = [];
  for (const provider of providers) {
    try {
      // SECURITY-RELEVANT: unverified admin-authored harness source is the
      // least-trusted code this system ever executes — no network, full
      // stop, regardless of what the surrounding sandbox posture allows.
      const raw = await provider.runScript(script, config.execution.timeoutMs, false);
      const parsed = parseProofOutput(raw.stdout);
      if (!parsed) {
        attempts.push(`${provider.name}: unparseable output ${raw.stderr.slice(0, 300)}`);
        continue;
      }
      return classifyProofResult(parsed, fields, (raw.stdout + raw.stderr).slice(0, 1_500));
    } catch (e) {
      attempts.push(`${provider.name}: ${(e as Error).message.slice(0, 300)}`);
    }
  }
  return { actual: "error", logs: attempts.join(" | ") || "no sandbox provider produced a result" };
}

export interface HarnessProofJobPayload {
  harnessId: string;
  datasetTypeId: string;
  sourceSha: string;
  samples: Array<{ payload: Record<string, unknown>; expected: "pass" | "fail"; label?: string }>;
}

/**
 * Lease derived from the worst-case job, not a flat guess: every sample is a
 * sequential sandbox command bounded by `config.execution.timeoutMs`, so at
 * the max sample count that's `MAX_PROOF_SAMPLES * timeoutMs` sequential
 * sandbox time. `worker.ts` passes this to `dbJobQueue.claim` so a second
 * worker cannot reclaim a proof job still genuinely in flight. Same reasoning
 * as v1's `PROOF_LEASE_MS` in `dataset-type-harness.ts`.
 */
export const PROOF_LEASE_MS = MAX_PROOF_SAMPLES * config.execution.timeoutMs * 2;

/**
 * `harness.proof_run` job handler, invoked from `worker.ts`. Runs the same
 * real-sandbox proof loop the route used to run inline, then writes evidence
 * exactly once (guarded on `sourceSha` + `proof_pending` so a concurrent edit
 * or a duplicate/retried job can never overwrite fresher evidence with a
 * stale run's result) and notifies admins on completion.
 */
export async function runHarnessProofJob(payload: HarnessProofJobPayload): Promise<void> {
  const row = await prisma.datasetTypeHarness.findUnique({ where: { id: payload.harnessId } });
  // Edited or retired since enqueue — the evidence would be stale. Not an
  // error: the job did its job by discovering there is nothing left to prove.
  if (!row || row.sourceSha !== payload.sourceSha || row.status !== HARNESS_STATUS.proofPending) return;

  const datasetType = await prisma.datasetType.findUnique({ where: { id: payload.datasetTypeId }, select: { name: true, fields: true } });
  const fields = Array.isArray(datasetType?.fields) ? (datasetType.fields as Array<{ key?: string }>) : [];

  const results: ProofSampleResult[] = [];
  for (const [index, sample] of payload.samples.entries()) {
    const run = await runProofSample(row.source, sample, fields);
    results.push({ index, label: sample.label ?? null, expected: sample.expected, actual: run.actual, logsExcerpt: run.logs.slice(0, 1_500) });
  }
  const unmet = results.filter((r) => r.actual !== r.expected);
  const outcome: ProofEvidence["outcome"] = unmet.length === 0 ? "passed" : "failed";
  const reason =
    outcome === "passed"
      ? undefined
      : results.some((r) => r.actual === "runtime_unavailable")
        ? "the sandbox image lacks a runtime this harness needs"
        : results.some((r) => r.actual === "harness_fault")
          ? "the harness itself threw or returned no verdict — fix the harness, not the samples"
          : results.some((r) => r.actual === "no_verdict")
            ? "the harness ran but produced no contract verdict (a broken-code contract needs brokenCodeFailedTests) — bound, it would verify nothing"
            : results.some((r) => r.actual === "error")
              ? "no sandbox provider produced a usable result — see the per-sample logs"
              : `sample(s) ${unmet.map((r) => r.index).join(", ")} did not produce the expected verdict`;
  const evidence: ProofEvidence = {
    outcome,
    sourceSha: row.sourceSha,
    samples: results,
    ranAt: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  };

  await prisma.$transaction(async (tx) => {
    const write = await tx.datasetTypeHarness.updateMany({
      where: { id: row.id, sourceSha: row.sourceSha, status: HARNESS_STATUS.proofPending },
      data: { status: HARNESS_STATUS.draft, proofEvidence: evidence as unknown as Prisma.InputJsonValue },
    });
    if (write.count === 0) return; // a concurrent edit/retire won the race; drop this run's evidence
    await notifyAdmins({
      type: "admin.harness_proof_completed",
      title: `Harness proof ${outcome} — ${datasetType?.name ?? payload.datasetTypeId}`,
      body: outcome === "passed" ? "All samples produced their expected verdicts; the harness can be bound." : (reason ?? "See the harness panel."),
      entityType: "dataset_type",
      entityId: payload.datasetTypeId,
      eventKey: `harness_proof:${row.id}:${row.sourceSha}`,
      tx,
    });
  });
}

export async function adminHarnessRoutes(app: FastifyInstance) {
  // GET / — every harness version for the type, newest first, with the
  // write-once proof evidence for each.
  app.get("/", { preHandler: requireRole(...ADMIN_AND_ABOVE_READONLY) }, async (req, reply) => {
    const { id } = typeParams.parse(req.params);
    const type = await prisma.datasetType.findUnique({ where: { id }, select: { id: true, name: true, status: true } });
    if (!type) return reply.notFound("dataset type not found");
    const harnesses = await prisma.datasetTypeHarness.findMany({ where: { datasetTypeId: id }, orderBy: { version: "desc" } });
    return reply.send({ datasetType: type, harnesses });
  });

  // PUT / — save a new draft version. Append-only: the current non-retired
  // row (if any) is retired and a fresh row gets version max+1, so proof
  // evidence on old rows is never rewritten.
  app.put("/", { preHandler: requireRole(...ADMIN_ONLY) }, async (req, reply) => {
    const { id } = typeParams.parse(req.params);
    const body = draftBody.parse(req.body);
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    try {
      const sourceError = harnessSourceError(body.source);
      if (sourceError) throw new HarnessError(sourceError, 400);
      const type = await prisma.datasetType.findUnique({ where: { id }, select: { id: true, status: true } });
      if (!type) throw new HarnessError("dataset type not found", 404);

      const row = await prisma.$transaction(async (tx) => {
        const current = await tx.datasetTypeHarness.findFirst({
          where: { datasetTypeId: id, status: { not: HARNESS_STATUS.retired } },
          orderBy: { version: "desc" },
        });
        if (type.status === "active" && current?.status === HARNESS_STATUS.verified) {
          throw new HarnessError("an active type's verified harness is immutable; create and activate a new type version instead", 409);
        }
        const latest = await tx.datasetTypeHarness.findFirst({
          where: { datasetTypeId: id },
          orderBy: { version: "desc" },
          select: { version: true },
        });
        if (current) {
          await tx.datasetTypeHarness.update({ where: { id: current.id }, data: { status: HARNESS_STATUS.retired } });
        }
        try {
          return await tx.datasetTypeHarness.create({
            data: {
              datasetTypeId: id,
              version: (latest?.version ?? 0) + 1,
              status: HARNESS_STATUS.draft,
              source: body.source,
              sourceSha: sourceShaOf(body.source),
              declaredRuntimes: body.declaredRuntimes,
              authorUserId: user.id,
              ...(current?.proofSamples ? { proofSamples: current.proofSamples as Prisma.InputJsonValue } : {}),
            },
          });
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
            throw new HarnessError("another admin saved a harness version at the same moment; reload the panel and re-apply your edit", 409);
          }
          throw e;
        }
      });
      await writeAuditLog(prisma, {
        actorUserId: user.id,
        action: "admin.dataset_type_harness.drafted",
        targetType: "DatasetType",
        targetId: id,
        after: { harnessId: row.id, version: row.version, sourceSha: row.sourceSha, declaredRuntimes: row.declaredRuntimes },
        ip: req.ip,
      });
      return reply.code(201).send({ harness: row });
    } catch (e) {
      if (e instanceof HarnessError) return sendHarnessError(reply, e);
      throw e;
    }
  });

  // POST /proof-run — enqueue a real-sandbox proof run against
  // expected-pass/expected-fail samples. ASYNC: the request only validates,
  // flips the harness to `proof_pending`, and enqueues the job — see
  // `runHarnessProofJob` (invoked from `worker.ts`) for the actual sandbox
  // execution and evidence write.
  app.post("/proof-run", { preHandler: requireRole(...ADMIN_ONLY) }, async (req, reply) => {
    const { id } = typeParams.parse(req.params);
    const body = proofBody.parse(req.body);
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    try {
      if (body.samples.length < 2 || body.samples.length > MAX_PROOF_SAMPLES) {
        throw new HarnessError(`between 2 and ${MAX_PROOF_SAMPLES} proof samples are required`, 400);
      }
      if (!body.samples.some((s) => s.expected === "pass") || !body.samples.some((s) => s.expected === "fail")) {
        throw new HarnessError("proof samples must include at least one expected-pass and one expected-fail case", 400);
      }
      const row = await prisma.datasetTypeHarness.findFirst({
        where: { datasetTypeId: id, status: { in: [HARNESS_STATUS.draft, HARNESS_STATUS.proofPending] } },
        orderBy: { version: "desc" },
      });
      if (!row) throw new HarnessError("no draft harness to prove — save a draft first", 409);
      if (body.expectedSourceSha && body.expectedSourceSha !== row.sourceSha) {
        throw new HarnessError("the harness changed since you loaded it; reload the panel and review the current source before proving it", 409);
      }

      const idempotencyKey = `harness.proof_run:${row.id}:${row.sourceSha}`;
      const jobPayload: HarnessProofJobPayload = {
        harnessId: row.id,
        datasetTypeId: id,
        sourceSha: row.sourceSha,
        samples: body.samples.map((s) => ({ payload: s.payload as Record<string, unknown>, expected: s.expected, label: s.label })),
      };

      // Not wrapped in a transaction: `dbJobQueue.enqueue` always runs against
      // the top-level `prisma` client (it takes no `tx` parameter — see
      // services/jobs.ts), matching the non-transactional
      // status-write-then-enqueue pattern already used elsewhere in this
      // codebase (e.g. `checkAndClosePoolIfTargetReached` in
      // pool-lifecycle.ts). `dbJobQueue.enqueue`'s upsert re-arms on any
      // existing row for this idempotency key, so re-requesting the same
      // source — an admin retrying a failed proof, or re-proving after
      // editing samples — is a legitimate re-run, not a no-op. The new
      // samples ride in the payload, so a re-run proves the new ones, not the
      // old.
      await prisma.datasetTypeHarness.update({
        where: { id: row.id },
        data: { status: HARNESS_STATUS.proofPending, proofSamples: body.samples as unknown as Prisma.InputJsonValue },
      });
      await dbJobQueue.enqueue({ type: "harness.proof_run", idempotencyKey, payload: jobPayload as unknown as Record<string, unknown> });

      await writeAuditLog(prisma, {
        actorUserId: user.id,
        action: "admin.dataset_type_harness.proof_requested",
        targetType: "DatasetType",
        targetId: id,
        after: { harnessId: row.id, samples: body.samples.length },
        ip: req.ip,
      });

      return reply.code(202).send({ harnessId: row.id, status: HARNESS_STATUS.proofPending, jobKey: idempotencyKey });
    } catch (e) {
      if (e instanceof HarnessError) return sendHarnessError(reply, e);
      throw e;
    }
  });

  // POST /bind — make the proven draft the type's verified harness.
  app.post("/bind", { preHandler: requireRole(...ADMIN_ONLY) }, async (req, reply) => {
    const { id } = typeParams.parse(req.params);
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const body = bindBody.parse(req.body ?? {});
    try {
      const row = await prisma.$transaction(async (tx) => {
        const [type] = await tx.$queryRaw<Array<{ status: string }>>`SELECT status::text AS status FROM dataset_types WHERE id = ${id} FOR UPDATE`;
        if (!type) throw new HarnessError("dataset type not found", 404);
        if (type.status === "active") {
          throw new HarnessError("an active type's verification contract is immutable; create and activate a new type version to bind a harness", 409);
        }
        const draft = await tx.datasetTypeHarness.findFirst({ where: { datasetTypeId: id, status: HARNESS_STATUS.draft }, orderBy: { version: "desc" } });
        if (!draft) throw new HarnessError("no proven draft harness to bind", 409);
        if (body.expectedSourceSha && body.expectedSourceSha !== draft.sourceSha) {
          throw new HarnessError("the harness changed since you loaded it; reload the panel and review the current source before binding it", 409);
        }
        const evidence = draft.proofEvidence as ProofEvidence | null;
        if (!evidence || evidence.outcome !== "passed") {
          throw new HarnessError("harness has no passing proof run; run the proof first (an expected-fail sample must fail and an expected-pass sample must pass)", 409);
        }
        if (evidence.sourceSha !== draft.sourceSha) {
          throw new HarnessError("proof evidence does not match the current source; re-run the proof", 409);
        }
        await tx.datasetTypeHarness.updateMany({
          where: { datasetTypeId: id, status: HARNESS_STATUS.verified, id: { not: draft.id } },
          data: { status: HARNESS_STATUS.retired },
        });
        return tx.datasetTypeHarness.update({ where: { id: draft.id }, data: { status: HARNESS_STATUS.verified } });
      });
      await writeAuditLog(prisma, {
        actorUserId: user.id,
        action: "admin.dataset_type_harness.bound",
        targetType: "DatasetType",
        targetId: id,
        after: { harnessId: row.id, version: row.version, sourceSha: row.sourceSha },
        ip: req.ip,
      });
      return reply.send({ harness: row });
    } catch (e) {
      if (e instanceof HarnessError) return sendHarnessError(reply, e);
      throw e;
    }
  });

  // POST /draft-assist — AI-drafted harness source. community has no LLM
  // consumer equivalent to v1's services/llm/consumers/harness-draft.ts, so
  // this is unconditionally the honest "unavailable" response (409) rather
  // than a fabricated draft or a silent 404. The panel already handles a
  // non-ok response by leaving the editor untouched.
  app.post("/draft-assist", { preHandler: requireRole(...ADMIN_ONLY) }, async (req, reply) => {
    const { id } = typeParams.parse(req.params);
    const type = await prisma.datasetType.findUnique({ where: { id }, select: { id: true } });
    if (!type) return reply.notFound("dataset type not found");
    return reply.conflict("AI harness drafting is not available in this deployment. Author the harness manually.");
  });

  // POST /retire — rollback to the honest no-harness state. Blocked while
  // the type is active.
  app.post("/retire", { preHandler: requireRole(...ADMIN_ONLY) }, async (req, reply) => {
    const { id } = typeParams.parse(req.params);
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    try {
      const row = await prisma.$transaction(async (tx) => {
        const [type] = await tx.$queryRaw<Array<{ status: string }>>`SELECT status::text AS status FROM dataset_types WHERE id = ${id} FOR UPDATE`;
        if (!type) throw new HarnessError("dataset type not found", 404);
        if (type.status === "active") {
          throw new HarnessError("an active type's verified harness is immutable; create and activate a new type version instead", 409);
        }
        const verified = await tx.datasetTypeHarness.findFirst({ where: { datasetTypeId: id, status: HARNESS_STATUS.verified } });
        if (!verified) throw new HarnessError("no verified harness to retire", 409);
        return tx.datasetTypeHarness.update({ where: { id: verified.id }, data: { status: HARNESS_STATUS.retired } });
      });
      await writeAuditLog(prisma, {
        actorUserId: user.id,
        action: "admin.dataset_type_harness.retired",
        targetType: "DatasetType",
        targetId: id,
        after: { harnessId: row.id, version: row.version },
        ip: req.ip,
      });
      return reply.send({ harness: row });
    } catch (e) {
      if (e instanceof HarnessError) return sendHarnessError(reply, e);
      throw e;
    }
  });
}
