// SPDX-License-Identifier: Apache-2.0

/**
 * `sponsor_reference.review` — evidence pass over ONE sponsor reference
 * sample.
 *
 * Ported from v1 `databounty-api/src/services/artifact-jobs.ts`
 * (`recordSampleRecordCount`, `nearestSampleSibling`, `sampleNearDupThreshold`,
 * `normalizeSampleText`, `handleSponsorReferenceReview`,
 * `enqueueSponsorReferenceReview`). Stage names and their meanings are v1's.
 *
 * Why any of this exists: at the default gate of 3-of-3 approved samples, the
 * reference samples ARE the contributor brief. Two failure modes make the gate
 * read as satisfied while contributors get almost nothing —
 *   1. one file that actually packs 400 examples counting as one sample, and
 *   2. three near-identical files counting as three.
 * Stages `sponsor_sample_record_count` and `sponsor_sample_similarity` exist
 * to catch exactly those, and both are computed from the real bytes.
 *
 * This job NEVER approves a sample. `sponsorReviewStatus` stays whatever the
 * admin set it to; the only status this job may write is `quarantined`, and
 * only for a confirmed near-duplicate (a quarantined row is already excluded
 * from the slot count and the published brief, so it can neither satisfy the
 * gate nor reach a contributor).
 */
import { ArtifactKind, ArtifactStatus, SponsorExampleReviewStatus, type Artifact, type Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import { getArtifactData } from "../storage.js";
import { openRouterConfigured, reviewSubmissionWithLlm } from "../llm-client.js";
import { enqueueJob, workspaceKeyForUser } from "../jobs.js";

export const SAMPLE_RECORD_COUNT_STAGE = "sponsor_sample_record_count";
export const SAMPLE_SIMILARITY_STAGE = "sponsor_sample_similarity";
export const SAMPLE_LLM_REVIEW_STAGE = "sponsor_sample_llm_review";

/** Bump when the COUNTING RULE changes. Pinned to the counter rather than the
 * dataset-type contract because the bytes never change but the rule does —
 * pinning to the contract would freeze a wrong verdict from an older rule. */
export const SAMPLE_RECORD_COUNTER_VERSION = 1;

/** Counting only needs enough bytes to parse the container. Generous next to
 * the review limit, because a file too big to REVIEW is still a file whose
 * example count the gate depends on: refusing to look is how a 900 KB,
 * 400-example JSONL counts as one sample. */
const SAMPLE_COUNT_MAX_BYTES = 8 * 1024 * 1024;

/** Bounded read for the near-dup screen and the LLM review. */
const SAMPLE_REVIEW_MAX_BYTES = 512 * 1024;

/** Code default for `planner.sample_gate.near_dup_threshold`. Fails toward the
 * default rather than toward "never a duplicate", so a malformed setting can
 * never silently disable the screen. */
const DEFAULT_NEAR_DUP_THRESHOLD = 0.9;

/** Shingle width. 5-token windows over normalized text: short enough that a
 * reworded sample still overlaps, long enough that two genuinely different
 * examples of the same dataset type do not. */
const SHINGLE_SIZE = 5;

/**
 * Count the example records a container holds, or `null` when no counter
 * claims the format. `null` is NOT a failure: prose, PDFs, archives and every
 * media modality hold one example by definition.
 *
 * Exported for unit tests — this is the rule the whole record-count stage
 * rests on, and it is pure.
 */
export function countSampleRecords(params: { filename: string; contentType: string | null; content: string }): number | null {
  const name = params.filename.toLowerCase();
  const ct = (params.contentType ?? "").toLowerCase().split(";")[0]!.trim();

  if (name.endsWith(".jsonl") || name.endsWith(".ndjson") || ct === "application/x-ndjson") {
    const lines = params.content.split("\n").filter((line) => line.trim().length > 0);
    // Every line must actually be JSON, or this is not a JSONL container and
    // the counter must not claim a number it cannot stand behind.
    for (const line of lines) {
      try {
        JSON.parse(line);
      } catch {
        return null;
      }
    }
    return lines.length;
  }

  if (name.endsWith(".json") || ct === "application/json") {
    try {
      const parsed: unknown = JSON.parse(params.content);
      if (Array.isArray(parsed)) return parsed.length;
      // A single JSON object is one example.
      if (parsed !== null && typeof parsed === "object") return 1;
      return null;
    } catch {
      return null;
    }
  }

  if (name.endsWith(".csv") || name.endsWith(".tsv") || ct === "text/csv" || ct === "text/tab-separated-values") {
    const lines = params.content.split("\n").filter((line) => line.trim().length > 0);
    // First line is the header, so a well-formed single-example file has two.
    return Math.max(lines.length - 1, 0);
  }

  return null;
}

/** Normalize before shingling so reformatting, key reordering and whitespace
 * churn cannot defeat the screen. JSON is canonicalized (keys sorted); other
 * text is lowercased with collapsed whitespace. */
export function normalizeSampleText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return canonicalJson(JSON.parse(trimmed)).toLowerCase();
    } catch {
      // fall through to the plain-text path
    }
  }
  return trimmed.toLowerCase().replace(/\s+/g, " ");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** Token shingles of the normalized text. Exported for unit tests. */
export function shingles(normalized: string): string[] {
  const tokens = normalized.split(/[^a-z0-9]+/i).filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
  if (tokens.length <= SHINGLE_SIZE) return [tokens.join(" ")];
  const out: string[] = [];
  for (let i = 0; i + SHINGLE_SIZE <= tokens.length; i += 1) {
    out.push(tokens.slice(i, i + SHINGLE_SIZE).join(" "));
  }
  return out;
}

/** Jaccard similarity of two shingle sets. Exported for unit tests. */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const value of setA) if (setB.has(value)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

async function nearDupThreshold(): Promise<number> {
  const row = await prisma.adminSetting.findUnique({ where: { key: "planner.sample_gate.near_dup_threshold" } });
  const value = row?.value as unknown;
  return typeof value === "number" && value > 0 && value <= 1 ? value : DEFAULT_NEAR_DUP_THRESHOLD;
}

async function readBoundedText(storageKey: string, maxBytes: number): Promise<string | null> {
  const bytes = await getArtifactData(storageKey);
  if (bytes.byteLength > maxBytes) return null;
  return bytes.toString("utf8");
}

async function stageRecorded(artifactId: string, stage: string, handlerVersion: string): Promise<string | null> {
  const existing = await prisma.artifactProcessingEvent.findFirst({
    where: { artifactId, stage, handlerVersion },
    select: { status: true },
    orderBy: { createdAt: "desc" },
  });
  return existing?.status ?? null;
}

/**
 * "Is this file exactly ONE example?" — run FIRST, before contract resolution
 * and before any bounded read the later stages do. v1 learned this the hard
 * way: while the count ran after those, a container escaped it whenever the
 * dataset type was unresolvable or the file was merely large, which is exactly
 * the case an agent packing many examples into one upload hits.
 *
 * Returns `true` when the caller must STOP: no quality verdict belongs on a
 * bundle, because a pass on it reads as approval of one representative example.
 */
export async function recordSampleRecordCount(artifact: Artifact): Promise<boolean> {
  const handlerVersion = `records:${SAMPLE_RECORD_COUNTER_VERSION}`;
  const existing = await stageRecorded(artifact.id, SAMPLE_RECORD_COUNT_STAGE, handlerVersion);
  if (existing) return existing === "failed";

  const record = (status: string, detail: Prisma.InputJsonValue) =>
    prisma.artifactProcessingEvent.create({
      data: { artifactId: artifact.id, stage: SAMPLE_RECORD_COUNT_STAGE, status, handlerVersion, detail },
    });

  const content = await readBoundedText(artifact.storageKey, SAMPLE_COUNT_MAX_BYTES);
  if (content === null) {
    // Honest, and NOT a pass: an uncounted file is one nobody has confirmed
    // holds a single example.
    await record("not_supported", {
      reason: `This file is larger than the ${Math.round(SAMPLE_COUNT_MAX_BYTES / (1024 * 1024))} MB counting limit, so the platform could not confirm it holds exactly one example. A reviewer checks it directly.`,
      counterVersion: SAMPLE_RECORD_COUNTER_VERSION,
    });
    return false;
  }

  const recordCount = countSampleRecords({
    filename: artifact.filename,
    contentType: artifact.detectedMimeType ?? artifact.contentType,
    content,
  });
  if (recordCount === null) {
    await record("not_supported", {
      reason: "This format holds one example by definition; no record count applies.",
      counterVersion: SAMPLE_RECORD_COUNTER_VERSION,
    });
    return false;
  }
  if (recordCount === 1) {
    await record("passed", { recordCount, counterVersion: SAMPLE_RECORD_COUNTER_VERSION });
    return false;
  }
  await record("failed", {
    reason:
      recordCount === 0
        ? "This file contains no example records, so it is not a usable reference sample."
        : `This file contains ${recordCount} example records but counts as ONE reference sample. Upload one example per file.`,
    recordCount,
    counterVersion: SAMPLE_RECORD_COUNTER_VERSION,
  });
  return true;
}

/** Which pre-mint/post-mint owner scopes a sample's siblings. Exactly one of
 * these pointers is set at any time (see the Artifact model's INVARIANT note),
 * so this is a total function, not a guess. */
function ownerWhere(artifact: Artifact): Prisma.ArtifactWhereInput | null {
  if (artifact.bountyId) return { bountyId: artifact.bountyId };
  if (artifact.datasetRequestId) return { datasetRequestId: artifact.datasetRequestId };
  if (artifact.plannerSessionId) return { plannerSessionId: artifact.plannerSessionId };
  return null;
}

async function nearestSampleSibling(
  artifact: Artifact,
  content: string
): Promise<{ artifactId: string; filename: string; similarity: number } | null> {
  const owner = ownerWhere(artifact);
  if (!owner) return null;

  const siblings = await prisma.artifact.findMany({
    where: {
      ...owner,
      kind: ArtifactKind.sponsor_reference,
      id: { not: artifact.id },
      status: ArtifactStatus.ready,
      deletedAt: null,
      OR: [{ sponsorReviewStatus: null }, { sponsorReviewStatus: { not: SponsorExampleReviewStatus.rejected } }],
    },
    select: { id: true, filename: true, storageKey: true },
    take: 50,
  });
  if (siblings.length === 0) return null;

  const mine = shingles(normalizeSampleText(content));
  if (mine.length === 0) return null;

  let best: { artifactId: string; filename: string; similarity: number } | null = null;
  for (const sibling of siblings) {
    const text = await readBoundedText(sibling.storageKey, SAMPLE_REVIEW_MAX_BYTES).catch(() => null);
    if (text === null) continue;
    const similarity = jaccard(mine, shingles(normalizeSampleText(text)));
    if (!best || similarity > best.similarity) {
      best = { artifactId: sibling.id, filename: sibling.filename, similarity };
    }
  }
  return best;
}

/** Resolve the dataset-type contract a sample is meant to exemplify. Returns
 * null when there is nothing to validate against — in which case NO verdict is
 * recorded, so the admin-approval guard keeps holding the sample rather than
 * seeing a check that never ran. */
async function resolveSampleDatasetType(artifact: Artifact) {
  const typeId = artifact.bountyId
    ? (await prisma.bounty.findUnique({ where: { id: artifact.bountyId }, select: { datasetTypeId: true } }))?.datasetTypeId
    : artifact.datasetRequestId
      ? (await prisma.datasetRequest.findUnique({ where: { id: artifact.datasetRequestId }, select: { datasetTypeId: true } }))
          ?.datasetTypeId
      : null;
  if (!typeId) return null;
  return prisma.datasetType.findUnique({
    where: { id: typeId },
    select: { id: true, name: true, version: true, fields: true },
  });
}

/**
 * `sponsor_reference.review` handler.
 *
 * `attempts`/`maxAttempts` are passed in because the LLM stage's retry
 * decision depends on them: a transient provider blip should be retried (so a
 * brief outage does not permanently cost this sample its advisory verdict),
 * while a genuinely unconfigured reviewer must, on the last attempt, record an
 * honest `pending` that says the sample is waiting on a HUMAN — not on a
 * machine still working.
 */
export async function runSponsorReferenceReviewJob(
  artifactId: string,
  job: { attempts: number; maxAttempts: number }
): Promise<void> {
  const artifact = await prisma.artifact.findUnique({ where: { id: artifactId } });
  if (!artifact) return;
  if (artifact.kind !== ArtifactKind.sponsor_reference) return;
  if (artifact.status !== ArtifactStatus.ready) return;

  if (await recordSampleRecordCount(artifact)) return;

  const datasetType = await resolveSampleDatasetType(artifact);
  if (!datasetType) return;
  const handlerVersion = `contract:${datasetType.version}`;

  // Only a TERMINAL verdict short-circuits. A previously recorded `pending`
  // (no reviewer configured at the time) must NOT be permanent: configuring a
  // provider later has to let a real verdict land.
  const priorLlm = await prisma.artifactProcessingEvent.findFirst({
    where: {
      artifactId: artifact.id,
      stage: SAMPLE_LLM_REVIEW_STAGE,
      handlerVersion,
      status: { in: ["passed", "failed", "not_supported"] },
    },
    select: { id: true },
  });
  if (priorLlm) return;

  const sampleMime = (artifact.detectedMimeType ?? artifact.contentType).toLowerCase();
  const textual = /^(text\/|application\/(json|x-ndjson))/.test(sampleMime);
  if (!textual) {
    await prisma.artifactProcessingEvent.create({
      data: {
        artifactId: artifact.id,
        stage: SAMPLE_LLM_REVIEW_STAGE,
        status: "not_supported",
        handlerVersion,
        detail: {
          reason: "Reference-example machine review supports bounded text and JSON only; this modality is held for human review.",
          datasetTypeVersion: datasetType.version,
        },
      },
    });
    return;
  }

  const content = await readBoundedText(artifact.storageKey, SAMPLE_REVIEW_MAX_BYTES);
  if (content === null) {
    await prisma.artifactProcessingEvent.create({
      data: {
        artifactId: artifact.id,
        stage: SAMPLE_LLM_REVIEW_STAGE,
        status: "not_supported",
        handlerVersion,
        detail: {
          reason: "Reference example exceeds the bounded review size and is held for human review.",
          datasetTypeVersion: datasetType.version,
        },
      },
    });
    return;
  }

  // Near-duplicate screen BEFORE spending an LLM call on a file that is not
  // going to survive. The upload-time checksum guard only catches
  // byte-identical re-uploads; reformatting or changing one word defeats it.
  const near = await nearestSampleSibling(artifact, content);
  if (near) {
    const threshold = await nearDupThreshold();
    if (near.similarity >= threshold) {
      // Quarantine, not a reject verdict: the sponsor's admin has not seen this
      // file, and a quarantined row is already excluded from the slot count and
      // the published brief, so it can neither satisfy the gate nor block a
      // replacement.
      await prisma.$transaction(async (tx) => {
        await tx.artifact.update({
          where: { id: artifact.id },
          data: { status: ArtifactStatus.quarantined, deletedAt: new Date() },
        });
        await tx.artifactProcessingEvent.create({
          data: {
            artifactId: artifact.id,
            stage: SAMPLE_SIMILARITY_STAGE,
            status: "failed",
            handlerVersion,
            detail: {
              reason: `Near-duplicate of the already-attached “${near.filename}” (${near.similarity.toFixed(2)} similarity, threshold ${threshold}). Reference samples must show contributors genuinely different examples.`,
              similarity: near.similarity,
              threshold,
              comparedWithArtifactId: near.artifactId,
              comparedWithFilename: near.filename,
            },
          },
        });
        await writeAuditLog(tx, {
          actorUserId: null,
          action: "artifact.sample_near_duplicate",
          targetType: "artifact",
          targetId: artifact.id,
          metadata: { similarity: near.similarity, threshold, comparedWith: near.artifactId },
        });
      });
      return;
    }
    // Below the bar: advisory evidence only. The admin is the gate, so a
    // borderline pair is something they SEE, not something a job decides.
    await prisma.artifactProcessingEvent.create({
      data: {
        artifactId: artifact.id,
        stage: SAMPLE_SIMILARITY_STAGE,
        status: "passed",
        handlerVersion,
        detail: {
          similarity: near.similarity,
          threshold,
          comparedWithArtifactId: near.artifactId,
          comparedWithFilename: near.filename,
          note:
            near.similarity >= threshold * 0.8
              ? `Similar to “${near.filename}” but under the near-duplicate threshold — worth a look during review.`
              : null,
        },
      },
    });
  }

  if (!openRouterConfigured()) {
    // Not a verdict. `pending` with a reason that names the HUMAN as the next
    // actor — and, because `pending` is not in the terminal set above,
    // configuring a reviewer later still lets a real verdict land.
    await prisma.artifactProcessingEvent.create({
      data: {
        artifactId: artifact.id,
        stage: SAMPLE_LLM_REVIEW_STAGE,
        status: "pending",
        handlerVersion,
        detail: {
          reason:
            "No LLM reviewer is configured, so this example was not machine-checked. An admin reviews it directly; the machine verdict is advisory and is not required to approve.",
          attempts: job.attempts,
          checksumSha256: artifact.checksumSha256,
          datasetTypeId: datasetType.id,
          datasetTypeVersion: datasetType.version,
        },
      },
    });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(content);
    payload = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { sample: content };
  } catch {
    payload = { sample: content };
  }

  const fields = Array.isArray(datasetType.fields)
    ? (datasetType.fields as Array<{ key?: unknown; role?: unknown }>)
        .filter((f) => typeof f?.key === "string")
        .map((f) => ({ key: f.key as string, role: typeof f.role === "string" ? f.role : undefined }))
    : [];

  try {
    const verdict = await reviewSubmissionWithLlm({
      datasetTypeName: datasetType.name,
      contractFields: fields,
      payload,
    });
    await prisma.artifactProcessingEvent.create({
      data: {
        artifactId: artifact.id,
        stage: SAMPLE_LLM_REVIEW_STAGE,
        status: verdict.passed ? "passed" : "failed",
        handlerVersion,
        detail: {
          score: verdict.score,
          reasons: verdict.reasons,
          model: verdict.model,
          advisory: true,
          datasetTypeId: datasetType.id,
          datasetTypeVersion: datasetType.version,
        },
      },
    });
  } catch (error) {
    // A configured-but-failing reviewer is transient until the retry budget is
    // gone. Throwing hands the job back to the queue with its own backoff
    // rather than recording a verdict nobody computed.
    if (job.attempts < job.maxAttempts) throw error;
    await prisma.artifactProcessingEvent.create({
      data: {
        artifactId: artifact.id,
        stage: SAMPLE_LLM_REVIEW_STAGE,
        status: "pending",
        handlerVersion,
        detail: {
          reason: "The configured LLM reviewer did not answer within this job's retry budget. An admin reviews this example directly.",
          error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
          attempts: job.attempts,
          datasetTypeId: datasetType.id,
          datasetTypeVersion: datasetType.version,
        },
      },
    });
  }
}

/** Producer. Keyed on the artifact alone so an operator re-arm resumes the
 * same row; the per-stage `handlerVersion` guards inside the handler are what
 * make a re-run cheap rather than duplicative. */
export async function enqueueSponsorReferenceReview(
  artifact: Pick<Artifact, "id" | "kind" | "ownerUserId" | "workspaceId">,
  tx?: Prisma.TransactionClient
): Promise<void> {
  if (artifact.kind !== ArtifactKind.sponsor_reference) return;
  await enqueueJob(
    "sponsor_reference.review",
    { artifactId: artifact.id },
    {
      idempotencyKey: `sponsor_reference.review:${artifact.id}`,
      workspaceId: artifact.workspaceId ?? (artifact.ownerUserId ? workspaceKeyForUser(artifact.ownerUserId) : undefined),
      maxAttempts: 4,
      tx,
    }
  );
}
