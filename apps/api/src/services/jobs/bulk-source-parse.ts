// SPDX-License-Identifier: Apache-2.0

/**
 * `bulk_source.parse` — turns an uploaded `bulk_submission_source` artifact
 * into reviewable rows.
 *
 * Ported from v1 `databounty-api/src/services/artifact-jobs.ts`
 * (`handleBulkSourceParse` / `commitBulkChunk` / `enqueueBulkSourceParse`),
 * with one deliberate difference in DESTINATION: v1 committed parsed rows
 * straight into `Submission` rows via submitItemsToBatch/submitItemsToPool.
 * This rebuild puts a human review gate in front of that — the
 * `SubmissionUploadDraft` browser-handoff flow (routes/v1/upload-review-drafts.ts)
 * — and its schema carries `SubmissionUploadDraftItem(rowNumber, payload,
 * errorCode, errorMessage)` plus the `Artifact.bulkParse*` progress columns
 * precisely for this job. So the parse lands in draft items, and the draft's
 * own submit step (owned elsewhere) is what creates submissions. Nothing here
 * submits anything.
 *
 * Two properties carried over unchanged from v1, because they are what make a
 * multi-million-row source survivable:
 *
 *  - **Resumable.** `Artifact.bulkParseCursor` is the highest row number
 *    already committed. A crashed or retried job re-reads the file but skips
 *    everything at or before the cursor, so a committed chunk is never redone.
 *  - **Counted, not silently dropped.** A row the parser could not use is
 *    persisted as a draft item WITH its error, and counted in
 *    `bulkParseSkippedRows`. Without that, a source whose rows mostly failed
 *    would finish `done` and read as a clean full ingest.
 */
import { ArtifactKind, ArtifactStatus, BulkParseStatus, type Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { getArtifactData } from "../storage.js";
import { enqueueJob, workspaceKeyForUser } from "../jobs.js";

/** Rows committed per transaction. Small enough to stay well under the
 * statement/tx timeout, large enough that a huge source does not spend all its
 * time on per-transaction overhead. */
const CHUNK_SIZE = 200;

/** Rows committed per JOB RUN before the job re-enqueues itself. Bounds how
 * long one claimed job holds its lease, which is what keeps a giant file from
 * looking like a stuck worker. */
const ROWS_PER_RUN = 5_000;

/** Version marker written into `SubmissionUploadDraft.previewSummary.parserVersion`.
 * Distinct from `Artifact.parserVersion` (the format-registry handler
 * version) — this one identifies THIS bulk-source row parser, so the web
 * review page can show a stable provenance string for the summary it
 * displays. Bump it if `parseBulkSource`'s row-shape rules change. */
const BULK_SOURCE_PARSER_VERSION = "1";

/** Draft statuses that are still "in flight" toward review — a completion or
 * failure write is only honest while the draft is still in one of these.
 * Anything else (already `review_ready`, `cancelled`, `submitted`, etc.) means
 * something else already decided the draft's fate and this job's write must
 * not clobber it. */
const PRE_TERMINAL_DRAFT_STATUSES = ["awaiting_upload", "uploading", "parsing"] as const;

/**
 * Whole-buffer read ceiling. The artifact's own verified upload size is
 * already capped upstream; this is the second, independent guard so a
 * mis-recorded size cannot turn into an unbounded allocation in the worker.
 */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

export class BulkParseError extends Error {
  constructor(
    message: string,
    /** Permanent failures (malformed container, wrong kind, no draft) are not
     * retryable: burning the retry budget cannot change the underlying facts,
     * and leaving the artifact `processing` would misreport progress. */
    public readonly permanent: boolean
  ) {
    super(message);
  }
}

export interface ParsedRow {
  rowNumber: number;
  payload: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/** Minimal RFC-4180 field splitter: honours double-quoted fields, escaped
 * `""`, and embedded delimiters/newlines inside quotes. Written out rather
 * than regex-split because a regex cannot see quote state, and a source whose
 * fields contain commas would silently mis-column. */
export function splitDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  // Trailing field/row only counts when something was actually read — a file
  // ending in a newline must not yield a phantom empty final row.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Parse the source text into numbered rows. Row numbers are 1-based and
 * stable for a given file, which is what makes the cursor meaningful and what
 * lets a reviewer's "row 4,182 is wrong" refer to the same thing on a retry.
 *
 * Supported containers: JSONL/NDJSON (one JSON value per line), a single JSON
 * array of objects, and CSV/TSV with a header row. Anything else fails closed
 * as a permanent error rather than being guessed at.
 */
export function parseBulkSource(text: string, filename: string, contentType: string): ParsedRow[] {
  const name = filename.toLowerCase();
  const ct = contentType.toLowerCase().split(";")[0]!.trim();

  const asRow = (rowNumber: number, value: unknown): ParsedRow => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return {
        rowNumber,
        payload: null,
        errorCode: "NOT_AN_OBJECT",
        errorMessage: "row must be a JSON object of field values",
      };
    }
    return { rowNumber, payload: value as Record<string, unknown>, errorCode: null, errorMessage: null };
  };

  if (name.endsWith(".jsonl") || name.endsWith(".ndjson") || ct === "application/x-ndjson") {
    const rows: ParsedRow[] = [];
    let rowNumber = 0;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue; // blank separator lines are not rows
      rowNumber += 1;
      try {
        rows.push(asRow(rowNumber, JSON.parse(trimmed)));
      } catch {
        rows.push({ rowNumber, payload: null, errorCode: "INVALID_JSON", errorMessage: "line is not valid JSON" });
      }
    }
    return rows;
  }

  if (name.endsWith(".json") || ct === "application/json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new BulkParseError("source is not valid JSON", true);
    }
    if (!Array.isArray(parsed)) throw new BulkParseError("a JSON source must be an array of item objects", true);
    return parsed.map((value, index) => asRow(index + 1, value));
  }

  if (name.endsWith(".csv") || name.endsWith(".tsv") || ct === "text/csv" || ct === "text/tab-separated-values") {
    const delimiter = name.endsWith(".tsv") || ct === "text/tab-separated-values" ? "\t" : ",";
    const table = splitDelimited(text, delimiter);
    const header = table.shift();
    if (!header || header.length === 0) throw new BulkParseError("delimited source has no header row", true);
    const columns = header.map((h) => h.trim());
    return table.map((cells, index) => {
      const rowNumber = index + 1;
      if (cells.length !== columns.length) {
        return {
          rowNumber,
          payload: null,
          errorCode: "COLUMN_COUNT_MISMATCH",
          errorMessage: `row has ${cells.length} fields, header declares ${columns.length}`,
        };
      }
      const payload: Record<string, unknown> = {};
      columns.forEach((column, i) => {
        payload[column] = cells[i] ?? "";
      });
      return { rowNumber, payload, errorCode: null, errorMessage: null };
    });
  }

  throw new BulkParseError(`unsupported bulk source container: ${filename}`, true);
}

/**
 * `bulk_source.parse` handler.
 *
 * Fails closed on every precondition: a source that is not `ready` (still
 * scanning, or quarantined) is never parsed, and a source with no draft
 * attached has nowhere honest to put its rows.
 */
export async function runBulkSourceParseJob(artifactId: string): Promise<{ created: number; done: boolean }> {
  const artifact = await prisma.artifact.findUnique({ where: { id: artifactId } });
  if (!artifact) throw new BulkParseError("ARTIFACT_NOT_FOUND", true);
  if (artifact.kind !== ArtifactKind.bulk_submission_source) {
    throw new BulkParseError("artifact is not a bulk submission source", true);
  }
  if (artifact.status !== ArtifactStatus.ready) {
    // Not an error to retry away: the scan decides `ready` vs `quarantined`,
    // and a quarantined source must never be parsed. Record the honest state.
    throw new BulkParseError(`bulk source is ${artifact.status}, not ready to parse`, artifact.status !== ArtifactStatus.scanning);
  }
  if (artifact.bulkParseStatus === BulkParseStatus.done) return { created: 0, done: true };
  if (artifact.bulkParseStatus === BulkParseStatus.skipped) return { created: 0, done: true };

  const draft = await prisma.submissionUploadDraft.findUnique({
    where: { sourceArtifactId: artifact.id },
    select: { id: true, status: true },
  });
  if (!draft) throw new BulkParseError("no upload review draft references this source", true);

  const bytes = await getArtifactData(artifact.storageKey);
  if (bytes.byteLength > MAX_SOURCE_BYTES) {
    const reason = `source exceeds the ${MAX_SOURCE_BYTES}-byte in-worker parse limit`;
    await markFailed(artifact.id, draft.id, reason);
    throw new BulkParseError("BULK_SOURCE_TOO_LARGE", true);
  }

  let rows: ParsedRow[];
  try {
    rows = parseBulkSource(bytes.toString("utf8"), artifact.filename, artifact.contentType);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markFailed(artifact.id, draft.id, message);
    throw error instanceof BulkParseError ? error : new BulkParseError(message, true);
  }

  const cursorAtStart = artifact.bulkParseCursor;
  const pending = rows.filter((row) => row.rowNumber > cursorAtStart);
  await prisma.artifact.update({
    where: { id: artifact.id },
    data: {
      bulkParseStatus: BulkParseStatus.processing,
      bulkParseRowCount: rows.length,
      bulkParseError: null,
    },
  });

  let created = 0;
  const budget = pending.slice(0, ROWS_PER_RUN);
  for (let offset = 0; offset < budget.length; offset += CHUNK_SIZE) {
    const chunk = budget.slice(offset, offset + CHUNK_SIZE);
    const lastRowNumber = chunk[chunk.length - 1]!.rowNumber;
    const chunkSkipped = chunk.filter((row) => row.errorCode !== null).length;
    await prisma.$transaction(async (tx) => {
      await tx.submissionUploadDraftItem.createMany({
        data: chunk.map((row) => ({
          draftId: draft.id,
          rowNumber: row.rowNumber,
          payload: (row.payload ?? undefined) as Prisma.InputJsonValue | undefined,
          errorCode: row.errorCode,
          errorMessage: row.errorMessage,
        })),
        // A retry that crashed AFTER createMany but BEFORE the cursor advanced
        // re-offers rows already stored; the (draftId, rowNumber) unique makes
        // that a skip rather than a duplicate-key failure.
        skipDuplicates: true,
      });
      // Cursor advances in the SAME transaction as the rows it accounts for —
      // that is the entire crash-safety argument. A guard on the previous
      // cursor value keeps two overlapping runs from moving it backwards.
      await tx.artifact.updateMany({
        where: { id: artifact.id, bulkParseCursor: { lt: lastRowNumber } },
        data: {
          bulkParseCursor: lastRowNumber,
          bulkParseCreated: { increment: chunk.length - chunkSkipped },
          bulkParseSkippedRows: { increment: chunkSkipped },
        },
      });
    });
    created += chunk.length - chunkSkipped;
  }

  const remaining = pending.length - budget.length;
  if (remaining > 0) {
    // Self-reschedule rather than run unbounded inside one lease.
    await enqueueBulkSourceParse(artifact.id, { force: true });
    return { created, done: false };
  }

  const final = await prisma.artifact.findUniqueOrThrow({
    where: { id: artifact.id },
    select: { bulkParseCreated: true, bulkParseSkippedRows: true },
  });
  await prisma.$transaction(async (tx) => {
    await tx.artifact.update({
      where: { id: artifact.id },
      data: { bulkParseStatus: BulkParseStatus.done },
    });
    // "review_ready" is the honest next state: rows exist and are viewable,
    // and nothing has been submitted. The counts are the review summary, and
    // `rejectedRows > 0` is surfaced rather than hidden so a reviewer sees a
    // partial parse for what it is. Field names here MUST match what
    // apps/web's upload-review page reads (Summary type in
    // upload-review/[draftId]/view.tsx) — rowsRead/acceptedRows/rejectedRows,
    // not this job's own internal totalRows/usableRows/skippedRows naming.
    //
    // Guarded `updateMany` instead of `update`: a draft the contributor
    // cancelled (or that some other terminal path already moved on) WHILE
    // this job's parse was still running must never be resurrected back to a
    // live status by this completion write. `revokedAt: null` plus the
    // pre-terminal status list means "nothing else has decided this draft's
    // fate yet" — if that's no longer true, count is 0 and there is nothing
    // more to do here.
    const result = await tx.submissionUploadDraft.updateMany({
      where: { id: draft.id, revokedAt: null, status: { in: [...PRE_TERMINAL_DRAFT_STATUSES] } },
      data: {
        status: "review_ready",
        previewSummary: {
          rowsRead: rows.length,
          acceptedRows: final.bulkParseCreated,
          rejectedRows: final.bulkParseSkippedRows,
          parserVersion: BULK_SOURCE_PARSER_VERSION,
          parsedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
    if (result.count === 0) {
      // Not an error: the draft moved on for a legitimate reason (cancelled,
      // or already terminal by some other path) before this job's parse
      // finished. The parsed rows already committed to
      // SubmissionUploadDraftItem stay as-is; nothing reads them for a draft
      // that isn't `review_ready`, so there is nothing to roll back.
    }
  });
  return { created, done: true };
}

/**
 * Records a permanent parse failure on both the artifact (existing
 * `bulkParseStatus`/`bulkParseError` progress columns) AND the draft itself —
 * without the second write, a failed parse left the draft stuck at whatever
 * pre-terminal status it already had (`uploading`), and the web review page's
 * dedicated `failed` UI branch was unreachable because the draft's `status`
 * never actually became `"failed"`.
 *
 * Guarded the same way as the success path: only moves a draft that is still
 * pre-terminal and not already revoked, so a cancelled-mid-parse draft is
 * never overwritten here either.
 */
async function markFailed(artifactId: string, draftId: string, reason: string): Promise<void> {
  const message = reason.slice(0, 500);
  await prisma.artifact.update({
    where: { id: artifactId },
    data: { bulkParseStatus: BulkParseStatus.failed, bulkParseError: message },
  });
  await prisma.submissionUploadDraft.updateMany({
    where: { id: draftId, revokedAt: null, status: { in: [...PRE_TERMINAL_DRAFT_STATUSES] } },
    data: {
      status: "failed",
      previewSummary: { error: message } as Prisma.InputJsonValue,
    },
  });
}

/**
 * Producer. Called after a bulk source's scan clears it for read (see
 * services/artifacts.ts) and chained by the handler itself when a source is
 * larger than one run's row budget.
 *
 * The key is the artifact id alone, so re-arming an exhausted/failed job (an
 * operator retry) reuses the same row — with the cursor already persisted,
 * that resumes rather than restarts.
 */
export async function enqueueBulkSourceParse(
  artifactId: string,
  opts: { force?: boolean; tx?: Prisma.TransactionClient } = {}
): Promise<void> {
  const client = opts.tx ?? prisma;
  const artifact = await client.artifact.findUnique({
    where: { id: artifactId },
    select: { kind: true, ownerUserId: true, workspaceId: true, bulkParseStatus: true },
  });
  if (!artifact) return;
  if (artifact.kind !== ArtifactKind.bulk_submission_source) return;
  if (!opts.force && artifact.bulkParseStatus === BulkParseStatus.skipped) return;
  // `pending` is what makes "queued but not started" visible on the artifact
  // itself rather than only in the queue table — the honest state between
  // enqueue and the handler's first chunk. Never downgrade a terminal `done`.
  if (artifact.bulkParseStatus !== BulkParseStatus.done && artifact.bulkParseStatus !== BulkParseStatus.processing) {
    await client.artifact.update({
      where: { id: artifactId },
      data: { bulkParseStatus: BulkParseStatus.pending, bulkParseError: null },
    });
  }
  await enqueueJob(
    "bulk_source.parse",
    { artifactId },
    {
      idempotencyKey: `bulk_source.parse:${artifactId}`,
      workspaceId: artifact.workspaceId ?? (artifact.ownerUserId ? workspaceKeyForUser(artifact.ownerUserId) : undefined),
      maxAttempts: 5,
      tx: opts.tx,
    }
  );
}
