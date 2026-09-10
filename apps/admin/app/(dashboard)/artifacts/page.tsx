"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AdminDateTime,
  AdminErrorBanner,
  AdminPageHeader,
  AdminPill,
  AdminSectionHeading,
  AdminTable,
  AdminTableSkeletonRows,
  ATd,
  type AdminPillTone,
} from "@/components/admin-shell";
import { Icon } from "@/components/icons";
import { adminAuthedFetch } from "@/lib/admin-auth";
import { SponsorReviewControl } from "@/components/sponsor-review-control";

/* Format-registry evidence surface (gap fix): before this page existed, an
 * admin had no way to find an artifact with a missing/stale/unsupported
 * check without already knowing its id — GET /v1/artifacts/:id/processing-
 * events existed but nothing listed artifacts platform-wide. Every status
 * below is server-computed the same way that per-artifact route computes it;
 * this page must never collapse missing/stale/unsupported/unconfigured into
 * a fake green "passed" state (root trust invariant). */

type StageStatus = "missing" | "stale" | "not_supported" | "passed" | "failed" | "pending";

interface StageEvidence {
  stage: "parse" | "preview" | "similarity_check";
  status: StageStatus;
  handlerVersion: string | null;
  createdAt: string | null;
}

interface ArtifactRow {
  id: string;
  filename: string;
  kind: string;
  modality: string | null;
  unconfigured: boolean;
  artifactStatus: string;
  // Malware/AV verdict, separate from artifactStatus. `ready` only means the
  // bytes landed — a file uploaded while scanning is switched on but no
  // ARTIFACT_SCAN_URL is set is recorded `not_required` and still becomes
  // `ready`, so without this column the console cannot tell an operator that
  // nothing was scanned. null = no verdict recorded at all.
  scanStatus: string | null;
  bountyId: string | null;
  submissionId: string | null;
  createdAt: string;
  currentHandlerVersion: string;
  stages: StageEvidence[];
  // Sponsor reference-example review state — null on every kind except
  // "sponsor_reference". Reviewed here, not on a separate page, so an admin
  // never needs to already know an artifact id to act on it.
  sponsorReviewStatus: string | null;
  sponsorReviewNote: string | null;
  datasetRequestId: string | null;
}

interface ArtifactsPage {
  artifacts: ArtifactRow[];
  nextCursor: string | null;
}

type StatusFilter = "all" | "missing" | "stale" | "unsupported" | "unconfigured" | "passed" | "failed" | "pending";

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "all" },
  { key: "missing", label: "missing" },
  { key: "stale", label: "stale" },
  { key: "unsupported", label: "unsupported / skipped" },
  { key: "unconfigured", label: "unconfigured" },
  { key: "failed", label: "failed" },
  { key: "pending", label: "pending" },
  { key: "passed", label: "passed" },
];

const STAGE_LABEL: Record<StageEvidence["stage"], string> = {
  parse: "parse",
  preview: "preview",
  similarity_check: "similarity",
};

// Never renders a missing/stale/unsupported/pending check as if it passed —
// each gets its own distinct, honestly-labeled tone.
const STAGE_TONE: Record<StageStatus, AdminPillTone> = {
  passed: "success",
  missing: "neutral",
  stale: "warning",
  not_supported: "neutral",
  failed: "danger",
  pending: "info",
};

const STAGE_TEXT: Record<StageStatus, string> = {
  passed: "passed",
  missing: "missing",
  stale: "stale",
  not_supported: "unsupported",
  failed: "failed",
  pending: "pending",
};

const PAGE_SIZE = 25;

function StageChip({ evidence }: { evidence: StageEvidence }) {
  return (
    <span title={evidence.handlerVersion ? `handler v${evidence.handlerVersion}` : "no handler run yet"}>
      <AdminPill tone={STAGE_TONE[evidence.status]}>
        {STAGE_LABEL[evidence.stage]}: {STAGE_TEXT[evidence.status]}
      </AdminPill>
    </span>
  );
}

export default function AdminArtifactsPage() {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [rows, setRows] = useState<ArtifactRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const reqId = useRef(0);
  // Tracks what the last (possibly failed) request actually asked for, so
  // retrying a failed "load more" resumes with append=true at that cursor
  // instead of replaying the current `cursor` state as a fresh, non-append
  // load — which would silently drop every row loaded before the failure.
  const lastAttempt = useRef<{ cursor: string | null; append: boolean }>({ cursor: null, append: false });

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (nextCursorArg: string | null, append: boolean) => {
      const id = ++reqId.current;
      lastAttempt.current = { cursor: nextCursorArg, append };
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const query = new URLSearchParams({ limit: String(PAGE_SIZE), status: filter });
        if (debouncedSearch) query.set("search", debouncedSearch);
        if (nextCursorArg) query.set("cursor", nextCursorArg);
        const res = await adminAuthedFetch(`/v1/admin/artifacts?${query}`);
        if (id !== reqId.current) return;
        if (!res.ok) throw new Error("Artifact evidence is unavailable.");
        const body = (await res.json()) as ArtifactsPage;
        setRows((prev) => (append ? [...prev, ...body.artifacts] : body.artifacts));
        setNextCursor(body.nextCursor);
        setError("");
      } catch {
        if (id !== reqId.current) return;
        setError("Artifact evidence is unavailable.");
        if (!append) setRows([]);
      } finally {
        if (id === reqId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [filter, debouncedSearch]
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load(null, false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <div className="space-y-5">
      <AdminPageHeader
        title="Artifacts"
        sub="Format-registry evidence per uploaded file — parse, preview, and similarity checks, platform-wide."
      />

      {error && (
        <AdminErrorBanner
          message={error}
          onRetry={() => void load(lastAttempt.current.cursor, lastAttempt.current.append)}
        />
      )}

      <AdminSectionHeading
        title="Evidence"
        sub="Every check below is a real stored ArtifactProcessingEvent row (or its explicit absence) — a missing, stale, or unsupported check is never shown as passed."
      />

      <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`cursor-pointer rounded-full border px-3.5 py-2.5 transition-colors sm:py-1.5 ${
              filter === f.key
                ? "border-lime bg-lime text-dark"
                : "border-dark-line text-dark-soft hover:border-dark-hover hover:text-dark-text"
            }`}
          >
            {f.label}
          </button>
        ))}
        <div className="relative ml-auto">
          <Icon
            name="search"
            size={13}
            strokeWidth={2}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dark-dim"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search filename"
            className="w-60 rounded-lg border border-dark-line bg-dark-card py-1.5 pl-8 pr-3 font-mono text-xs text-dark-text placeholder:text-dark-dim focus:border-dark-hover focus:outline-none"
          />
        </div>
      </div>

      <AdminTable headers={["file", "modality", "kind", "scan", "checks", "sponsor review", "created", "record"]}>
        {loading && rows.length === 0 ? (
          <AdminTableSkeletonRows columns={8} rows={6} />
        ) : rows.length ? (
          rows.map((a) => (
            <tr key={a.id}>
              <ATd>
                <div className="max-w-64 truncate font-semibold leading-snug text-dark-text">{a.filename}</div>
                <div className="mt-0.5 text-[10px] text-dark-dim">{a.id}</div>
              </ATd>
              <ATd>
                {a.unconfigured ? (
                  <AdminPill tone="warning">unconfigured</AdminPill>
                ) : (
                  <span className="text-dark-soft">{a.modality}</span>
                )}
              </ATd>
              <ATd className="text-dark-soft">{a.kind.replaceAll("_", " ")}</ATd>
              {/* An unscanned file must never read as a clean one. `clean` is the
                  only positive tone here; `not_required` (scanning off, or on with
                  no scanner wired) and a missing verdict both render as warnings,
                  and `infected`/`error` as danger. */}
              <ATd>
                {a.scanStatus === "clean" ? (
                  <AdminPill tone="success">clean</AdminPill>
                ) : a.scanStatus === "infected" || a.scanStatus === "error" ? (
                  <AdminPill tone="danger">{a.scanStatus}</AdminPill>
                ) : (
                  <AdminPill tone="warning">{a.scanStatus ? a.scanStatus.replaceAll("_", " ") : "not scanned"}</AdminPill>
                )}
              </ATd>
              <ATd>
                <div className="flex flex-wrap gap-1">
                  {a.stages.map((s) => (
                    <StageChip key={s.stage} evidence={s} />
                  ))}
                </div>
              </ATd>
              <ATd>
                {a.kind === "sponsor_reference" ? (
                  <SponsorReviewControl
                    artifact={a}
                    onReviewed={(id, status, note) =>
                      setRows((prev) =>
                        prev.map((r) => (r.id === id ? { ...r, sponsorReviewStatus: status, sponsorReviewNote: note } : r))
                      )
                    }
                  />
                ) : (
                  <span className="text-[10px] text-dark-dim">n/a</span>
                )}
              </ATd>
              <ATd className="whitespace-nowrap text-dark-soft">
                <AdminDateTime iso={a.createdAt} />
              </ATd>
              {/* Every row already carries its submission/bounty id. Without a
                  link here a quarantined or failing file was a dead end — no
                  way to reach the item it belongs to. */}
              <ATd>
                <div className="flex flex-col gap-0.5">
                  {a.submissionId && (
                    <Link
                      href={`/details?kind=submission&id=${encodeURIComponent(a.submissionId)}`}
                      className="font-mono text-xs text-lime underline"
                    >
                      submission →
                    </Link>
                  )}
                  {a.bountyId && (
                    <Link
                      href={`/details?kind=bounty&id=${encodeURIComponent(a.bountyId)}`}
                      className="font-mono text-xs text-lime underline"
                    >
                      pool →
                    </Link>
                  )}
                  {!a.submissionId && !a.bountyId && (
                    <span className="text-[10px] text-dark-dim">not linked to a record</span>
                  )}
                </div>
              </ATd>
            </tr>
          ))
        ) : (
          <tr>
            <ATd colSpan={8} className="text-dark-soft">
              No artifacts match this filter.
            </ATd>
          </tr>
        )}
      </AdminTable>

      {nextCursor && (
        <div className="flex justify-center">
          <button
            onClick={() => void load(nextCursor, true)}
            disabled={loadingMore}
            className="cursor-pointer rounded-full border border-dark-line px-4 py-2.5 font-mono text-xs text-dark-soft transition-colors hover:border-dark-hover hover:text-dark-text disabled:opacity-50 sm:py-1.5"
          >
            {loadingMore ? "loading…" : "load more"}
          </button>
        </div>
      )}
    </div>
  );
}
