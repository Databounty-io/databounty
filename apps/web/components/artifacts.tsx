"use client";

// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { authedFetch } from "@/lib/store";
import { humanizeKey } from "@/lib/format";
import { valuesFromPayload } from "@/components/dynamic-item-fields";
import type { DatasetType } from "@/lib/dataset-types";
import {
  uploadArtifact,
  deleteArtifact,
  listBountyArtifacts,
  occupiesSampleSlot,
  getArtifactProcessingEvents,
  type ApiArtifact,
  type ArtifactKind,
  type ArtifactProcessingEventsResponse,
} from "@/lib/api-artifacts";
import { ModalityCheckCard } from "@/components/stage-evidence-cards";
import { prepareSampleFiles } from "@/lib/sample-expansion";
import { useArtifactStatusPolling } from "@/lib/use-artifact-status-polling";

/* ------------------------------------------------------------------ */
/* Viewer — renders ANY file type: image/video/audio/pdf inline,       */
/* text/csv/json as expandable text, everything else as a download.    */
/* Bytes are fetched via authedFetch (cookies + CORS credentials) and  */
/* shown from an object URL, so cross-origin auth always works.        */
/* ------------------------------------------------------------------ */

export function humanSize(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ViewMode = "image" | "video" | "audio" | "pdf" | "text" | "download";

/** Text-ish content types the artifact accept list actually admits. Kept as a
 *  set rather than a hardcoded triple because `sponsor_reference` accepts
 *  .txt/.md/.csv/.json/.jsonl/.ndjson — a `.jsonl` sample normalizes to
 *  `application/x-ndjson`, which used to fall through to "download" and so
 *  could never be previewed or parsed at all. */
const TEXT_CONTENT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/x-ndjson",
]);

function viewModeFor(contentType: string): ViewMode {
  const ct = contentType.toLowerCase().split(";")[0].trim();
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("audio/")) return "audio";
  if (ct === "application/pdf") return "pdf";
  if (TEXT_CONTENT_TYPES.has(ct) || ct.startsWith("text/")) return "text";
  return "download";
}

async function fetchBlob(downloadUrl: string): Promise<Blob | null> {
  const res = await authedFetch(downloadUrl);
  if (!res.ok) return null;
  return res.blob();
}

/**
 * Every check the platform ran on ONE uploaded file, in one place.
 *
 * The card header can only say `ready`, which covers bytes + the malware/
 * magic-byte scan and nothing else. For a sponsor's own reference samples that
 * was the whole story on screen — so a sample sitting at "ready · review:
 * pending" gave no way to tell whether the content-type gate had sniffed
 * something different from what was declared, whether the parse/preview checks
 * had run, or why the LLM review had not approved it yet. Each row below is
 * either real stored evidence or an explicit unknown; nothing here infers a
 * pass from the absence of a failure.
 */
export function ArtifactChecksPanel({ artifact }: { artifact: ApiArtifact }) {
  // One state cell tagged with the artifact it belongs to, so "loading" is
  // DERIVED (no result for this id yet) rather than a second flag set from
  // inside the effect. A `setLoading(true)` in the effect body is a cascading
  // render the lint rule correctly rejects, and stale-result guarding falls out
  // of the tag for free.
  const [result, setResult] = useState<{ id: string; data: ArtifactProcessingEventsResponse | null } | null>(null);
  const loading = result?.id !== artifact.id;

  useEffect(() => {
    let alive = true;
    void getArtifactProcessingEvents(artifact.id).then((data) => {
      if (alive) setResult({ id: artifact.id, data });
    });
    return () => { alive = false; };
  }, [artifact.id]);

  // A declared content type the byte-sniffer disagreed with is the single most
  // important thing on this panel, so it is called out rather than shown as
  // just another value row.
  const declared = artifact.contentType.toLowerCase().split(";")[0].trim();
  const detected = artifact.detectedMimeType?.toLowerCase().split(";")[0].trim() ?? null;
  const mismatch = detected != null && detected !== declared;

  return (
    <div className="border-t border-line bg-panel/40 p-3">
      <dl className="grid gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-2">
        <CheckRow
          label="file stored"
          value={artifact.status === "ready" ? "yes" : humanizeKey(artifact.status)}
          tone={artifact.status === "ready" ? "ok" : artifact.status === "quarantined" ? "bad" : "unknown"}
        />
        <CheckRow
          label="security scan"
          // No scanStatus is NOT a pass. An older row, or a deployment with no
          // scanner wired, has nothing recorded — say so.
          value={artifact.scanStatus ? humanizeKey(artifact.scanStatus) : "no scan recorded"}
          // `not_required` is a legitimate non-failure (no scanner is configured
          // for this driver/type), so it must not render in the failure colour —
          // red on a row that did not fail is its own false claim. It is not
          // green either: nothing was scanned. Neutral, with the real word.
          tone={
            artifact.scanStatus === "clean" || artifact.scanStatus === "passed"
              ? "ok"
              : artifact.scanStatus == null || artifact.scanStatus === "not_required" || artifact.scanStatus === "skipped"
                ? "unknown"
                : artifact.scanStatus === "pending" || artifact.scanStatus === "scanning"
                  ? "pending"
                  : "bad"
          }
        />
        <CheckRow
          label="declared type"
          value={declared}
          tone={mismatch ? "bad" : "ok"}
        />
        <CheckRow
          label="detected type"
          value={detected ?? "not sniffed"}
          tone={mismatch ? "bad" : detected == null ? "unknown" : "ok"}
        />
        <CheckRow
          label="modality"
          value={artifact.modality ? humanizeKey(artifact.modality) : "not classified"}
          tone={artifact.modality ? "ok" : "unknown"}
        />
        <CheckRow
          label="content review"
          value={artifact.sponsorReviewStatus ? humanizeKey(artifact.sponsorReviewStatus) : "not reviewed"}
          tone={
            artifact.sponsorReviewStatus === "approved"
              ? "ok"
              : artifact.sponsorReviewStatus === "pending" || artifact.sponsorReviewStatus == null
                ? "pending"
                : "bad"
          }
        />
      </dl>
      {mismatch && (
        <p className="mt-2 text-[11px] text-rose-600" role="alert">
          The bytes in this file don’t match the type it was uploaded as. It will not count towards your
          required examples until it is replaced with a file whose contents match.
        </p>
      )}
      <div className="mt-3">
        <ModalityCheckCard filename={artifact.filename} data={result?.data ?? null} loading={loading} />
      </div>
    </div>
  );
}

function CheckRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ok" | "bad" | "pending" | "unknown";
}) {
  const cls =
    tone === "ok" ? "text-accent-strong" : tone === "bad" ? "text-rose-600" : tone === "pending" ? "text-amber-700" : "text-ink-faint";
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line-soft py-1 last:border-b-0">
      <dt className="text-ink-soft">{label}</dt>
      <dd className={`text-right font-mono ${cls}`}>{value}</dd>
    </div>
  );
}

function ArtifactCard({
  artifact,
  onDeleted,
  deletable,
  showChecks = false,
}: {
  artifact: ApiArtifact;
  onDeleted?: (id: string) => void;
  deletable?: boolean;
  /** Surface the per-check evidence expander (see `ArtifactChecksPanel`). */
  showChecks?: boolean;
}) {
  const mode = viewModeFor(artifact.contentType);
  const [open, setOpen] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revoke = useRef<string | null>(null);

  useEffect(() => () => {
    if (revoke.current) URL.revokeObjectURL(revoke.current);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const blob = await fetchBlob(artifact.downloadUrl);
    if (!blob) {
      setError("Couldn’t load this file.");
      setLoading(false);
      return;
    }
    if (mode === "text") {
      setText(await blob.text());
    } else {
      const url = URL.createObjectURL(blob);
      revoke.current = url;
      setObjectUrl(url);
    }
    setLoading(false);
  }, [artifact.downloadUrl, mode]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !objectUrl && text == null && !loading) await load();
  };

  const download = async () => {
    const blob = await fetchBlob(artifact.downloadUrl);
    if (!blob) {
      setError("Couldn’t download this file.");
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = artifact.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-lg border border-line bg-white">
      <div className="flex items-center gap-3 px-3 py-2">
        <span className="text-sm">{fileEmoji(mode)}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-ink">{artifact.filename}</div>
          {/* A live region for the same reason the sample surfaces have one:
              `useArtifactStatusPolling` rewrites this line out-of-band when the
              async scan resolves, long after the last thing the person did. The
              node is always mounted and only its text changes, so the flip to
              "ready" (or to quarantined) is announced; nothing is announced
              while the text is unchanged. */}
          <div className="text-[11px] text-ink-faint" role="status" aria-live="polite">
            {artifact.contentType}
            {artifact.sizeBytes != null ? ` · ${humanSize(artifact.sizeBytes)}` : ""}
            {artifact.status === "scanning"
              ? " · file stored · security scan in progress"
              : artifact.status === "quarantined"
                ? " · security verification held this file"
              : artifact.status !== "ready"
                ? ` · ${humanizeKey(artifact.status)}`
                : " · ready"}
            {artifact.sponsorReviewStatus ? ` · review: ${humanizeKey(artifact.sponsorReviewStatus)}` : ""}
          </div>
          {artifact.sponsorReviewNote && (
            <div className="mt-1 text-[11px] text-amber-700">Review note: {artifact.sponsorReviewNote}</div>
          )}
        </div>
        {showChecks && (
          <button
            type="button"
            onClick={() => setChecksOpen((v) => !v)}
            aria-expanded={checksOpen}
            className="rounded-md border border-line px-2 py-1 text-xs text-ink-soft hover:bg-panel"
          >
            {checksOpen ? "Hide checks" : "Checks"}
          </button>
        )}
        {artifact.status === "ready" && mode !== "download" && (
          <button
            type="button"
            onClick={toggle}
            className="rounded-md border border-line px-2 py-1 text-xs text-ink-soft hover:bg-panel"
          >
            {open ? "Hide" : "View"}
          </button>
        )}
        <button
          type="button"
          onClick={download}
          disabled={artifact.status !== "ready"}
          className="rounded-md border border-line px-2 py-1 text-xs text-ink-soft hover:bg-panel"
        >
          Download
        </button>
        {deletable && onDeleted && (
          <button
            type="button"
            onClick={async () => {
              setError(null);
              // Removal is refused server-side once a set is frozen (active
              // bounty, or a request past its editable stages). Swallowing
              // that made the button look inert — the sponsor clicks, nothing
              // moves, and there is nothing on screen saying why.
              if (await deleteArtifact(artifact.id)) onDeleted(artifact.id);
              else setError("Couldn’t remove this file — it may be locked with an active or already-reviewed spec.");
            }}
            className="rounded-md border border-rose-300 px-2 py-1 text-xs text-rose-600 hover:bg-rose-50"
          >
            Remove
          </button>
        )}
      </div>

      {/* Rendered outside the preview panel: a failed Remove or Download has
          nothing to do with the preview being open, and hiding the reason
          behind an expander is why the failure read as a dead button. */}
      {error && !open && (
        <div className="border-t border-line px-3 py-2 text-xs text-rose-600" role="alert">{error}</div>
      )}

      {showChecks && checksOpen && <ArtifactChecksPanel artifact={artifact} />}

      {open && mode !== "download" && (
        <div className="border-t border-line p-3">
          {loading && <div className="text-xs text-ink-faint">Loading…</div>}
          {error && <div className="text-xs text-rose-600">{error}</div>}
          {!loading && !error && mode === "image" && objectUrl && (
            // Dynamic user-uploaded blob with unknown intrinsic size, so we
            // can't set real width/height (next/image also can't optimize a
            // blob: URL, and optimization is disabled repo-wide anyway) —
            // instead reserve a fixed-size box via aspect-ratio + object-fit
            // so the preview can't cause layout shift once it decodes.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={objectUrl}
              alt={artifact.filename}
              className="max-h-[420px] w-full max-w-full rounded-md object-contain"
              style={{ aspectRatio: "16 / 9", background: "var(--panel, #f3f3f3)" }}
            />
          )}
          {!loading && !error && mode === "video" && objectUrl && (
            <video src={objectUrl} controls className="max-h-[420px] max-w-full rounded-md" />
          )}
          {!loading && !error && mode === "audio" && objectUrl && (
            <audio src={objectUrl} controls className="w-full" />
          )}
          {!loading && !error && mode === "pdf" && objectUrl && (
            <iframe src={objectUrl} title={artifact.filename} className="h-[520px] w-full rounded-md" />
          )}
          {!loading && !error && mode === "text" && text != null && (
            <pre className="max-h-[420px] overflow-auto rounded-md bg-panel p-3 text-xs text-ink-soft">
              {text}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function fileEmoji(mode: ViewMode): string {
  switch (mode) {
    case "image":
      return "🖼️";
    case "video":
      return "🎬";
    case "audio":
      return "🎵";
    case "pdf":
      return "📄";
    case "text":
      return "📃";
    default:
      return "📎";
  }
}

export function ArtifactList({
  artifacts,
  emptyLabel = "No files.",
  onDeleted,
  deletable = false,
  showChecks = false,
}: {
  artifacts: ApiArtifact[];
  emptyLabel?: string;
  onDeleted?: (id: string) => void;
  deletable?: boolean;
  /** Give each row a "Checks" expander with its stored per-check evidence. */
  showChecks?: boolean;
}) {
  if (!artifacts.length) return <div className="text-xs text-ink-faint">{emptyLabel}</div>;
  return (
    <div className="flex flex-col gap-2">
      {artifacts.map((a) => (
        <ArtifactCard key={a.id} artifact={a} onDeleted={onDeleted} deletable={deletable} showChecks={showChecks} />
      ))}
    </div>
  );
}

/** One sample's bytes, read as a structured item when they parse as one.
 *  `raw` is always kept so a file that is not a structured item still shows
 *  its real content rather than nothing. */
type ParsedSample =
  | { state: "error"; message: string }
  | { state: "unstructured"; raw: string }
  | { state: "parsed"; item: Record<string, unknown>; raw: string };

/** Read one item out of a sample file. Accepts a bare JSON object, a JSON
 *  array (first element), or JSONL/NDJSON (first non-empty line) — the three
 *  shapes the upload gate actually admits. Anything else stays `unstructured`
 *  and is shown as raw text rather than guessed at. */
function parseDelimitedItem(raw: string, delimiter: string): Record<string, unknown> | null {
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) return null;
  const split = (line: string) => line.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, ""));
  const headers = split(lines[0]);
  const cells = split(lines[1]);
  if (headers.length === 0) return null;
  return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
}

function parseSampleItem(raw: string, contentType: string): Record<string, unknown> | null {
  const ct = contentType.toLowerCase().split(";")[0].trim();
  if (ct === "text/csv") return parseDelimitedItem(raw, ",");
  if (ct === "text/tab-separated-values") return parseDelimitedItem(raw, "\t");
  const asRecord = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  try {
    const whole = JSON.parse(raw) as unknown;
    if (Array.isArray(whole)) return asRecord(whole[0]);
    const rec = asRecord(whole);
    if (rec) return rec;
  } catch {
    // Not one JSON document — fall through to the line-delimited attempt.
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      return asRecord(JSON.parse(trimmed) as unknown);
    } catch {
      return null;
    }
  }
  return null;
}

/** Field values are edited as text, so render them as text — an object or
 *  array value is pretty-printed rather than shown as "[object Object]". */
function sampleValueToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

/**
 * Contributor-facing sponsor brief. References are server-approved work-brief
 * artifacts, so this exposes read-only viewing: contributors cannot edit,
 * remove, or replace the sponsor's immutable example set.
 *
 * When a sample parses as a structured item it is shown field-by-field against
 * the contract (`fields`), because that is the comparison a contributor
 * actually needs — a raw JSON blob makes them diff the format by eye. Keys the
 * contract does not declare are still listed, marked as such, so the table
 * never silently hides part of what the sponsor supplied.
 *
 * `onPrefill` copies the sample into the submission form. It is a starting
 * point, never a submission: the contributor still has to edit and submit it,
 * and dedupe would reject a verbatim copy anyway.
 */
export function SponsorReferenceExamples({
  artifacts,
  type,
  onPrefill,
}: {
  artifacts: ApiArtifact[];
  /** The dataset contract. Drives labels, ordering, and — via
   *  `valuesFromPayload` — the role-aware conversion into form values. Omit
   *  and the table falls back to the sample's own raw keys. */
  type?: DatasetType | null;
  /** Copy this sample's values into the item form. Omitted = no prefill action. */
  onPrefill?: (values: Record<string, string>) => void;
}) {
  const fields = type?.fields;
  const [selectedId, setSelectedId] = useState<string | null>(artifacts[0]?.id ?? null);
  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? artifacts[0];
  const [parsedById, setParsedById] = useState<Record<string, ParsedSample>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const selectedId2 = selected?.id;
  const selectedUrl = selected?.downloadUrl;
  const selectedType = selected?.contentType;
  // Ids already fetched (or in flight). A ref, not state, so marking one does
  // not itself trigger a render — and so the effect never has to depend on the
  // result map it writes into, which would re-run it on its own output.
  const requestedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!selectedId2 || !selectedUrl) return;
    if (requestedRef.current.has(selectedId2)) return;
    // Only text-ish samples can be a structured item. A media sample keeps the
    // existing inline viewer below instead of being force-parsed.
    if (viewModeFor(selectedType ?? "") !== "text") return;
    requestedRef.current.add(selectedId2);
    // Deliberately NOT cancelled on cleanup. Results are stored per artifact
    // id, so a late write is correct rather than stale — and under React's
    // development double-mount the ref above already suppressed the second
    // fetch, so discarding the first one's result on the first cleanup left
    // the panel stuck on "Loading sample…" forever.
    void fetchBlob(selectedUrl)
      .then(async (blob) => {
        if (!blob) {
          setParsedById((prev) => ({ ...prev, [selectedId2]: { state: "error", message: "Couldn’t load this sample." } }));
          return;
        }
        const raw = await blob.text();
        const item = parseSampleItem(raw, selectedType ?? "");
        setParsedById((prev) => ({
          ...prev,
          [selectedId2]: item ? { state: "parsed", item, raw } : { state: "unstructured", raw },
        }));
      })
      .catch(() => {
        setParsedById((prev) => ({ ...prev, [selectedId2]: { state: "error", message: "Couldn’t load this sample." } }));
      });
  }, [selectedId2, selectedUrl, selectedType]);

  if (!selected) return null;
  const parsed = parsedById[selected.id];
  const loadingSample = !parsed && viewModeFor(selected.contentType) === "text";

  // Contract fields first (in contract order), then anything extra the sample
  // carries. Both are shown — an undeclared key is a real difference the
  // contributor should see, not something to quietly drop.
  const rows: { key: string; label: string; value: string; declared: boolean; required: boolean }[] = [];
  // One conversion for both the table and the prefill, so a contributor never
  // reads one rendering and gets a different one in the form. A `list` field
  // shows the newline-per-entry form the contract's help text describes and
  // the editor actually uses — not the JSON array literal it is stored as.
  const converted = parsed?.state === "parsed" && type ? valuesFromPayload(type, parsed.item) : {};
  if (parsed?.state === "parsed") {
    const seen = new Set<string>();
    for (const f of fields ?? []) {
      seen.add(f.key);
      const rawValue = parsed.item[f.key];
      rows.push({
        key: f.key,
        label: f.label || humanizeKey(f.key),
        // A file field's stored value is an artifact id, which is meaningless
        // to a contributor — say what it is instead of printing the id.
        value:
          f.role === "file" && rawValue != null
            ? "— a file the sponsor attached; open “raw file” below to view it"
            : (converted[f.key] ?? sampleValueToText(rawValue)),
        declared: true,
        required: f.required === true,
      });
    }
    for (const [k, v] of Object.entries(parsed.item)) {
      if (seen.has(k)) continue;
      rows.push({ key: k, label: humanizeKey(k), value: sampleValueToText(v), declared: false, required: false });
    }
  }
  // Role-aware conversion, not a raw string copy. `valuesFromPayload` is the
  // canonical inverse of what the form submits, so a `list` field arrives as
  // newline-joined entries instead of a JSON literal that the submit path
  // would then re-split into garbage.
  //
  // File fields are deliberately dropped: their value is an artifact id owned
  // by the SPONSOR, so copying it would attach the sponsor's file to the
  // contributor's submission as if they had produced it.
  const prefillValues = (): Record<string, string> => {
    if (!parsed || parsed.state !== "parsed") return {};
    const out: Record<string, string> = {};
    for (const f of fields ?? []) {
      if (f.role === "file") continue;
      const v = converted[f.key];
      if (typeof v === "string" && v.trim() !== "") out[f.key] = v;
    }
    return out;
  };
  const prefillable = Object.keys(prefillValues()).length > 0;
  const skippedFileFields = (fields ?? []).filter(
    (f) => f.role === "file" && parsed?.state === "parsed" && parsed.item[f.key] != null
  ).length;

  return (
    <section className="card mb-6 overflow-hidden" aria-label="Sponsor reference examples">
      <div className="border-b border-line-soft px-5 py-4">
        <h2 className="font-mono text-sm font-bold text-ink">Sponsor reference examples</h2>
        <p className="mt-1 text-xs text-ink-soft">
          Read-only examples of the requested format. Preview or download them to guide your submission; you cannot change them.
        </p>
      </div>
      <div className="border-b border-line-soft px-5 pt-3">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Sponsor examples">
          {artifacts.map((artifact, index) => {
            const selectedTab = artifact.id === selected.id;
            return (
              <button
                key={artifact.id}
                id={`sponsor-example-tab-${artifact.id}`}
                type="button"
                role="tab"
                aria-selected={selectedTab}
                aria-controls={`sponsor-example-panel-${artifact.id}`}
                onClick={() => setSelectedId(artifact.id)}
                className={`rounded-t-md border px-3 py-2 font-mono text-xs ${selectedTab ? "border-line border-b-white bg-white font-semibold text-ink" : "border-transparent text-ink-soft hover:bg-panel"}`}
              >
                Sample {index + 1}
              </button>
            );
          })}
        </div>
      </div>
      <div
        id={`sponsor-example-panel-${selected.id}`}
        role="tabpanel"
        aria-labelledby={`sponsor-example-tab-${selected.id}`}
        className="px-5 py-4"
      >
        {loadingSample && <p className="text-xs text-ink-soft">Loading sample…</p>}
        {parsed?.state === "error" && <p className="text-xs text-red-700">{parsed.message}</p>}
        {parsed?.state === "unstructured" && (
          <p className="mb-3 text-xs text-ink-soft">
            This sample isn’t a single structured item, so it’s shown as the raw file below.
          </p>
        )}

        {parsed?.state === "parsed" && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] border-collapse text-left">
                <thead>
                  <tr className="border-b border-line-soft">
                    <th scope="col" className="w-1/3 py-2 pr-3 font-mono text-[11px] uppercase tracking-[.05em] text-ink-faint">Field</th>
                    <th scope="col" className="py-2 font-mono text-[11px] uppercase tracking-[.05em] text-ink-faint">Sponsor’s example value</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.key} className="border-b border-line-soft align-top last:border-0">
                      <td className="py-2.5 pr-3">
                        <div className="font-mono text-xs font-semibold text-ink">{row.label}</div>
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {row.required && <span className="font-mono text-[10px] text-ink-faint">required</span>}
                          {/* Honest about scope: a key the contract does not
                              declare will not be submitted, so say so rather
                              than letting it read as part of the format. */}
                          {!row.declared && (
                            <span className="rounded-full bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700">not in contract</span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5">
                        {row.value === "" ? (
                          <span className="font-mono text-xs text-ink-faint">— not provided in this sample</span>
                        ) : (
                          <textarea
                            readOnly
                            aria-label={`${row.label} — sponsor example value`}
                            value={row.value}
                            rows={Math.min(10, Math.max(2, row.value.split("\n").length))}
                            className="w-full resize-y rounded-md border border-line bg-panel px-2.5 py-2 font-mono text-[12px] leading-relaxed text-ink"
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {onPrefill && (
              <div className="mt-3 flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  disabled={!prefillable}
                  className="rounded-md border border-line bg-white px-3 py-2 font-mono text-xs font-semibold text-ink hover:bg-panel disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => {
                    onPrefill(prefillValues());
                    setCopiedId(selected.id);
                  }}
                >
                  Use as a starting point
                </button>
                <span className="text-[11px] leading-snug text-ink-soft">
                  {!prefillable
                    ? "Nothing in this sample maps to a text field you fill in."
                    : copiedId === selected.id
                      ? "Copied into the item form below — edit it into your own item before submitting."
                      : "Fills the item form below with these values. Submitting an unchanged copy will be rejected as a duplicate."}
                  {skippedFileFields > 0 && (
                    <>
                      {" "}
                      {skippedFileFields === 1 ? "The file field is" : `${skippedFileFields} file fields are`} not copied — upload your own.
                    </>
                  )}
                </span>
              </div>
            )}
          </>
        )}

        {/* A media/PDF/archive sample has no field table to show, so its
            viewer is the primary content and must not be buried behind a
            toggle. Only collapse the raw file when a table is already
            rendering the same sample's content above. */}
        {parsed?.state === "parsed" ? (
          <details className="mt-4">
            <summary className="cursor-pointer font-mono text-[11px] text-ink-faint hover:text-ink">raw file</summary>
            <div className="mt-2"><ArtifactList artifacts={[selected]} /></div>
          </details>
        ) : (
          <div className="mt-2"><ArtifactList artifacts={[selected]} /></div>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Uploader — drop or pick any file; posts to the API and reports back.*/
/* ------------------------------------------------------------------ */

export function ArtifactUpload({
  kind,
  bountyId,
  submissionId,
  contributorBatchId,
  onUploaded,
  onSettled,
  label = "Add a file",
  hint = "Images, video, PDFs, datasets (JSON/CSV/JSONL), docs — any type.",
  accept,
  multiple = true,
  maxSizeBytes,
}: {
  kind: Extract<ArtifactKind, "sponsor_reference" | "submission_attachment" | "bulk_submission_source">;
  bountyId?: string;
  submissionId?: string;
  contributorBatchId?: string;
  onUploaded?: (a: ApiArtifact) => void;
  onSettled?: () => void;
  label?: string;
  hint?: string;
  accept?: string;
  multiple?: boolean;
  /** client-side pre-check only, per file; server re-validates and is authoritative. */
  maxSizeBytes?: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  /** What sample expansion did to the picked files. Informational — kept out of
   *  `error` so a successful split is not painted as a failure. */
  const [notes, setNotes] = useState<string[]>([]);
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (successTimer.current) clearTimeout(successTimer.current);
  }, []);

  const showSuccess = useCallback((message: string) => {
    if (successTimer.current) clearTimeout(successTimer.current);
    setSuccess(message);
    // Successful upload feedback is transient: leave the completed artifact
    // visible in its parent, then automatically dismiss only this notice.
    // Errors deliberately do not use this timer so a user can read and retry.
    successTimer.current = setTimeout(() => setSuccess(null), 3_000);
  }, []);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (busy || !files || !files.length) return;
      if (!multiple && files.length > 1) {
        setError("Choose one file at a time.");
        if (inputRef.current) inputRef.current.value = "";
        return;
      }
      setBusy(true);
      setError(null);
      setNotes([]);
      setSuccess(null);
      const failed: string[] = [];
      try {
        // Sponsor reference samples are counted one Artifact row per example,
        // so a container file (multi-record .jsonl/.ndjson, an array or wrapped
        // .json, a multi-row .csv/.tsv) has to become one file per record here
        // too — otherwise this uploader disagrees with the planner and the
        // request panel about how many examples the same file is worth.
        //
        // This dropzone keeps its own chrome (drag-and-drop over a whole panel,
        // shared with submission attachments and bulk sources) but runs the
        // SAME decision as `SampleUploadField` via `prepareSampleFiles`, so the
        // two can never disagree about what one file is worth. Slot bounds are
        // the server's to enforce on this surface: a minted bounty's cap is
        // `requiredSponsorExamples`, which this generic component does not know.
        let picked = Array.from(files);
        if (kind === "sponsor_reference") {
          const prepared = await prepareSampleFiles({
            files: picked,
            slotMax: Number.POSITIVE_INFINITY,
            slotsUsed: 0,
          });
          picked = prepared.files;
          setNotes(prepared.notes);
          if (prepared.error) {
            setError(prepared.error);
            return;
          }
        }
        for (const file of picked) {
          if (maxSizeBytes != null && file.size > maxSizeBytes) {
            failed.push(`${file.name}: exceeds ${humanSize(maxSizeBytes)} limit`);
            continue;
          }
          let failureMessage: string | null = null;
          const artifact = await uploadArtifact(
            file,
            { kind, bountyId, submissionId, contributorBatchId },
            (message) => {
              failureMessage = message;
            }
          );
          if (artifact) {
            onUploaded?.(artifact);
            // The scan is asynchronous and scales with file size, so a large
            // upload can arrive `scanning`/pending rather than `ready`. Report
            // that honestly instead of claiming it's verified — the row shows
            // its live status pill and finalizes on the next refresh.
            showSuccess(
              artifact.status === "ready"
                ? `“${file.name}” uploaded and verified.`
                : `“${file.name}” uploaded — still processing (${humanizeKey(artifact.status)}). It’ll finish shortly.`
            );
          }
          else failed.push(failureMessage ? `${file.name}: ${failureMessage}` : file.name);
        }
        if (failed.length) {
          setError(
            failed.length === 1
              ? `Upload failed for “${failed[0]}”. Choose the file again to retry.`
              : `Uploads failed for: ${failed.join("; ")}. Choose them again to retry.`
          );
        }
      } finally {
        if (inputRef.current) inputRef.current.value = "";
        setBusy(false);
        onSettled?.();
      }
    },
    [busy, multiple, kind, bountyId, submissionId, contributorBatchId, onUploaded, onSettled, showSuccess, maxSizeBytes]
  );

  return (
    <div>
      <div
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-disabled={busy}
        onKeyDown={(e) => {
          if (!busy && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          if (!busy) setDragOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = busy ? "none" : "copy";
          if (!busy) setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!busy) void handleFiles(e.dataTransfer.files);
        }}
        onClick={() => {
          if (!busy) inputRef.current?.click();
        }}
        className={`flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center transition ${
          busy ? "cursor-wait border-line opacity-70" : "cursor-pointer hover:border-ink-faint"
        } ${
          dragOver ? "border-[#5b8a00] bg-lime/10" : "border-line"
        }`}
      >
        <Icon name="upload" size={20} className="mb-1 text-ink-soft" />
        <div className="text-sm text-ink-soft">{busy ? "Uploading…" : label}</div>
        <div className="text-[11px] text-ink-faint">{hint}</div>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          disabled={busy}
          className="hidden"
          onChange={(e) => void handleFiles(e.target.files)}
        />
      </div>
      {success && <div className="mt-1 text-xs text-emerald-700" role="status" aria-live="polite">{success}</div>}
      {notes.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1" role="status" aria-live="polite">
          {notes.map((note) => (
            <li key={note} className="text-[11.5px] leading-snug text-ink-soft">{note}</li>
          ))}
        </ul>
      )}
      {error && <div className="mt-1 break-words text-xs text-rose-600" role="alert">{error}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sponsor-facing manager: load + upload + remove reference files for  */
/* a real bounty. Self-contained state so it drops into any page.      */
/* ------------------------------------------------------------------ */

export function SponsorReferenceManager({
  bountyId,
  requiredCount,
  locked = false,
  onChanged,
}: {
  bountyId: string;
  requiredCount: number;
  locked?: boolean;
  onChanged?: () => void;
}) {
  const [artifacts, setArtifacts] = useState<ApiArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  // The ref MUST be re-armed on mount, not only cleared on unmount. React's
  // dev-mode double-invoke (and any real remount) runs the cleanup once before
  // mounting again; with a clear-only effect the flag stayed false forever, the
  // `if (!mountedRef.current) return` guard below swallowed every load, and the
  // sponsor's reference-sample list sat on "Loading files…" permanently — no
  // filenames, no review states, no way to see which check was outstanding.
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const reload = useCallback(async () => {
    const rows = await listBountyArtifacts(bountyId, "sponsor_reference");
    if (!mountedRef.current) return;
    setArtifacts(rows);
    setLoading(false);
  }, [bountyId]);

  useEffect(() => { void reload(); }, [reload]);

  // A completed browser upload can legitimately remain `scanning` while the
  // server worker verifies it. Refresh that one transient state in place;
  // never make the upload control wait for an unrelated background job.
  useArtifactStatusPolling(artifacts.some((artifact) => artifact.status === "scanning"), reload);

  const readyCount = artifacts.filter((artifact) => artifact.status === "ready" && artifact.sponsorReviewStatus === "approved").length;
  // Slot accounting mirrors the server (`sampleSlotError`): a rejected sample
  // frees its slot so the replacement can be uploaded without deleting first.
  // Counting it here hid this control at the one moment it was needed.
  const activeCount = artifacts.filter(occupiesSampleSlot).length;
  const canUpload = !locked && activeCount < requiredCount;

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-line bg-panel px-3 py-2 text-xs text-ink-soft">
        <span className="font-mono font-semibold text-ink">{readyCount}/{requiredCount}</span>{" "}
        examples approved · {Math.max(0, requiredCount - readyCount)} remaining
        {locked ? " · locked with the active spec" : ""}
      </div>
      {canUpload && (
        <ArtifactUpload
          kind="sponsor_reference"
          bountyId={bountyId}
          label={`Upload example ${activeCount + 1} of ${requiredCount}`}
          hint="The server verifies type, size, checksum and scan result before this example counts."
          multiple={false}
          onUploaded={(a) => {
            setArtifacts((prev) => [a, ...prev.filter((row) => row.id !== a.id)]);
            onChanged?.();
          }}
          onSettled={() => {
            reload();
            onChanged?.();
          }}
        />
      )}
      {loading ? (
        <div className="text-xs text-ink-faint">Loading files…</div>
      ) : (
        <ArtifactList
          artifacts={artifacts}
          emptyLabel="No reference files yet. Contributors and validators will see whatever you upload here."
          deletable={!locked}
          // The sponsor's own samples gate their bounty: an unapproved set
          // defines the brief on the
          // community one. "ready · review: pending" alone gave them no way to
          // see WHICH check was outstanding.
          showChecks
          onDeleted={(id) => {
            setArtifacts((prev) => prev.filter((a) => a.id !== id));
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}
