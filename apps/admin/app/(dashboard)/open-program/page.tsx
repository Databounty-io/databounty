"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AdminConfirmDialog,
  AdminEmptyState,
  AdminErrorBanner,
  AdminLoadingState,
  AdminPageHeader,
  AdminPill,
  AdminStat,
  AdminTable,
  AdminTabs,
  AdminTableSkeletonRows,
  ATd,
  type AdminPillTone,
} from "@/components/admin-shell";
import { Icon } from "@/components/icons";
import { adminAuthedFetch } from "@/lib/admin-auth";
import { useAdminToast } from "@/lib/admin-toast";
import { useAllDatasetTypes } from "@/lib/dataset-type-pages";
import { useAdminResource } from "@/lib/use-admin-resource";
import { num, pct } from "@/lib/format";
import { CommunityRequestsSection } from "../community-requests/page";
import { SponsorSamplesSection, type SponsorExamplesResponse } from "./sponsor-samples";

/* Authoritative community-program metrics (already API-backed). */
interface OpenMetrics {
  programs: number;
  /** FINAL acceptance only (validator-passed / published). */
  acceptedItems: string;
  /** Legacy pools use this automation-cleared capacity count. New per-item
   * policy pools fill only with final accepted items. */
  clearedItems?: string;
  targetItems: string;
  totalKarma: number;
  /** Every community submission right now, bucketed into exactly one of
   * three real pipeline stages (never a client-side guess). */
  pipelineBreakdown: { pending: number; inVerification: number; completed: number };
  requestCounts: Record<string, number>;
  leaders: { user: { id: string; displayName: string; handle: string | null }; karma: number }[];
}

/* Per-program fill row. Depends on an admin community-datasets endpoint
 * that exposes cursor + server-side filters (see report: API dependency).
 * Every field here is server-owned evidence; nothing is fabricated. */
interface OpenDatasetRow {
  id: string;
  title: string;
  datasetTypeName: string | null;
  /** FINAL acceptance only (validator-passed / published). */
  acceptedItems: string;
  /** Fill counter: cleared automation, holds capacity, final fate pending. */
  clearedItems?: string;
  targetItems: string;
  contributors: number;
  karmaPerAcceptedItem: number;
  publicationStatus: string;
  huggingFaceDataset: string | null;
  /** Every confirmed publication target beyond Hugging Face. */
  publications?: { target: string; url: string; pushedAt: string | null }[];
  communityLicense: string | null;
  poolSummary?: {
    policy?: {
      validation: "full_human" | "automation_only";
      sponsorDispute: false;
      karmaRelease: "on_final_accept";
    };
    capacityReserved?: number;
    finalAccepted?: number;
    validatorReview?: number;
    processing?: number;
    rejected?: number;
    failedAutomatedChecks?: number;
  } | null;
}

interface OpenDatasetPage {
  datasets: OpenDatasetRow[];
  nextCursor: string | null;
}

/** New policies fill on individual final acceptance. Legacy rows retain their
 * capacity-reservation count until their immutable policy snapshot exists. */
function fillRatio(filled: string, target: string): number {
  const a = Number(filled);
  const t = Number(target);
  return t > 0 ? Math.min(1, a / t) : 0;
}

function FillBar({ ratio }: { ratio: number }) {
  return (
    <div className="mt-1.5 h-1 w-28 overflow-hidden rounded-full bg-[#1a1d19]">
      <div
        className={`h-full rounded-full ${ratio >= 1 ? "bg-emerald-400" : "bg-lime"}`}
        style={{ width: `${Math.round(ratio * 100)}%` }}
      />
    </div>
  );
}

// Matches CommunityPublicationStatus (prisma/schema.prisma) exactly — the
// prior keys ("publishable", "draft") never occurred in real data, so most
// rows silently fell through to the "neutral" default.
const STATUS_TONE: Record<string, AdminPillTone> = {
  not_requested: "neutral",
  pending: "neutral",
  manual_review: "warning",
  publishing: "warning",
  published: "success",
  failed: "danger",
  // An admin withdrew a published dataset; public access was removed at the
  // provider before this state was recorded. Not an error, so not "danger".
  retracted: "warning",
};

type DatasetFilter = "all" | "publishable" | "published";

const DATASET_FILTERS: { key: DatasetFilter; label: string }[] = [
  { key: "all", label: "all" },
  { key: "publishable", label: "publish-ready" },
  { key: "published", label: "published" },
];

const DATASET_PAGE_SIZE = 25;

/** Public HF dataset URL from a stored slug — only rendered when a real push
 * recorded one, so the link never points at a non-existent repo. */
const hfDatasetUrl = (slug: string) => `https://huggingface.co/datasets/${slug}`;

/* One shell for every block on this page. Previously two sections were cards
 * and two were bare headings, so the page read as an unstructured stack with
 * no visible grouping. Same shell everywhere + an eyebrow that says which of
 * the three parts of the page you are in. */
function OpenSection({
  eyebrow,
  title,
  sub,
  actions,
  children,
}: {
  eyebrow?: string;
  title: string;
  sub?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-dark-line bg-dark-card p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {eyebrow && (
            <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-dark-dim">{eyebrow}</div>
          )}
          <h2 className="font-mono text-base font-bold tracking-tight text-dark-text">{title}</h2>
          {sub && <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-dark-soft">{sub}</p>}
        </div>
        {/* w-full below sm: an actions block that is itself many wrapping
           pills (e.g. the Requests tab's per-status counts) has no explicit
           width, so a flex-wrap parent gives it its unwrapped max-content
           width instead of letting it wrap — on a narrow viewport that
           pushes the whole row wider than the screen. Full width once it
           has already dropped to its own line fixes that without touching
           the shared admin-shell header, which uses the same shrink-0
           pattern for simpler 1-2-button action bars that don't hit this. */}
        {actions && <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Small inline action button for the publication workflow. */
function PubActionButton({ onClick, busy, children }: { onClick: () => void; busy: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="cursor-pointer rounded-full border border-dark-line px-3 py-2 font-mono text-[11px] text-dark-soft transition-colors hover:border-lime hover:text-lime disabled:opacity-50 sm:px-2.5 sm:py-0.5 sm:text-[10px]"
    >
      {busy ? "…" : children}
    </button>
  );
}

/* Per-program fill table. Cursor-paginated and server-filtered against the
 * admin community-datasets endpoint. When that endpoint is not yet available
 * it degrades to an explicit dependency note (never fabricated rows). */
function CommunityDatasetsSection() {
  const { pushToast } = useAdminToast();
  const [actingId, setActingId] = useState<string | null>(null);
  // Retraction removes a dataset from public view at the provider, so it is
  // confirmed explicitly rather than firing on a single click.
  const [retractTarget, setRetractTarget] = useState<OpenDatasetRow | null>(null);
  // The other publication-workflow actions used to fire immediately on click
  // while retract alone was gated — same severity class (they change public
  // state or kick off external work), so they get the same explicit-confirm
  // treatment, with "publish to HF" (a real external side effect) carrying
  // the most explicit warning copy of the three.
  const [pubActionConfirm, setPubActionConfirm] = useState<{
    row: OpenDatasetRow;
    action: "request_review" | "start_publishing" | "retry";
    label: string;
  } | null>(null);
  // ?program= is the handoff from the Requests tab's "view program →" link.
  // It is DERIVED from the URL, not copied into state, so a direct load, a
  // same-route <Link> click, and browser back/forward all filter to the right
  // program with nothing to keep in sync. The router (below) is the only
  // writer, so this value never diverges from the address bar.
  const searchParams = useSearchParams();
  const router = useRouter();
  const programId = searchParams.get("program");
  // ?filter= is the same handoff pattern, from Overview's "ready to publish"
  // tile — but read ONCE as the initial value only (unlike programId above).
  // Unlike ?program=, the filter chips below don't write this param back to
  // the URL on every click, so treating it as derived-forever would fight a
  // manual chip click with a stale param still sitting in the address bar.
  const initialFilterParam = searchParams.get("filter");
  const [filter, setFilter] = useState<DatasetFilter>(
    initialFilterParam === "publishable" || initialFilterParam === "published" ? initialFilterParam : "all"
  );
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [rows, setRows] = useState<OpenDatasetRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // "unavailable" marks a missing endpoint (404/501): a truthful "not yet
  // built" state, distinct from a transient error we should let the operator
  // retry.
  const [state, setState] = useState<"ok" | "error" | "unavailable">("ok");
  const reqId = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Clear the single-program filter by removing ?program= through the router,
  // so `programId` (derived above) updates and the address bar stays in step.
  const showAllPrograms = useCallback(() => {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.delete("program");
    const qs = params.toString();
    router.replace(`/open-program/${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [router, searchParams]);

  const load = useCallback(
    async (nextCursorArg: string | null, append: boolean) => {
      const id = ++reqId.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const query = new URLSearchParams({ limit: String(DATASET_PAGE_SIZE), filter });
        if (programId) query.set("id", programId);
        if (debouncedSearch) query.set("search", debouncedSearch);
        if (nextCursorArg) query.set("cursor", nextCursorArg);
        const res = await adminAuthedFetch(`/v1/admin/community/datasets?${query}`);
        if (id !== reqId.current) return;
        if (res.status === 404 || res.status === 501) {
          setState("unavailable");
          setRows([]);
          setNextCursor(null);
          return;
        }
        if (!res.ok) throw new Error("unavailable");
        const body = (await res.json()) as OpenDatasetPage;
        setState("ok");
        setRows((prev) => (append ? [...prev, ...body.datasets] : body.datasets));
        setNextCursor(body.nextCursor);
      } catch {
        if (id !== reqId.current) return;
        setState("error");
        if (!append) setRows([]);
      } finally {
        if (id === reqId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [filter, debouncedSearch, programId]
  );

  // Drive the publication state machine. This route is mounted under the
  // admin-community prefix; the public /v1/bounties router deliberately has
  // no publication mutation endpoint.
  // The server enforces eligibility + auth; we surface its message and reload
  // so the row reflects the real new state (never an optimistic guess).
  const act = useCallback(
    async (id: string, action: "request_review" | "start_publishing" | "retry" | "retract", label: string) => {
      setActingId(id);
      try {
        const res = await adminAuthedFetch(`/v1/admin/community/bounties/${id}/publication`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        if (!res.ok) throw new Error(body.message || body.error || `Could not ${label}.`);
        pushToast({ variant: "success", title: `${label} — done` });
        await load(null, false);
      } catch (e) {
        pushToast({ variant: "error", title: `Could not ${label}`, body: e instanceof Error ? e.message : undefined });
      } finally {
        setActingId(null);
        setPubActionConfirm(null);
      }
    },
    [load, pushToast]
  );

  // Reload from the first page whenever a server-side filter changes.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setCursor(null);
      void load(null, false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <OpenSection
      title="Community datasets"
      sub="Every community program, running or finished. “Pool fill” counts items that cleared automated checks and hold a slot; “accepted” counts only items a validator finally passed. Search and status filters run server-side; the list is cursor-paginated."
    >
      <div className="mb-3.5 flex flex-wrap items-center gap-2 font-mono text-xs">
        {DATASET_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`cursor-pointer rounded-full border px-3.5 py-1.5 transition-colors ${
              filter === f.key
                ? "border-lime bg-lime text-dark"
                : "border-dark-line text-dark-soft hover:border-dark-hover hover:text-dark-text"
            }`}
          >
            {f.label}
          </button>
        ))}
        {programId && (
          <button
            type="button"
            onClick={showAllPrograms}
            className="cursor-pointer rounded-full border border-amber-400/40 px-3.5 py-1.5 text-amber-300 transition-colors hover:border-amber-300"
          >
            viewing one program · show all
          </button>
        )}
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
            placeholder="search title or type"
            className="w-60 rounded-lg border border-dark-line bg-dark-card py-1.5 pl-8 pr-3 font-mono text-xs text-dark-text placeholder:text-dark-dim focus:border-dark-hover focus:outline-none"
          />
        </div>
      </div>

      {state === "error" && (
        <AdminErrorBanner message="Community dataset metrics are unavailable." onRetry={() => void load(cursor, false)} />
      )}

      {state === "unavailable" ? (
        <div className="rounded-[11px] border border-dark-line bg-dark-card p-[18px] font-mono text-xs text-dark-soft">
          Per-program fill metrics need the admin community-datasets endpoint
          (GET /v1/admin/community/datasets, cursor plus status/search params).
          It is not available yet, so no rows are shown here.
        </div>
      ) : (
        <>
          <AdminTable headers={["dataset", "type", "capacity reserved", "final accepted", "contributors", "karma / item", "status", "detail"]}>
            {loading && rows.length === 0 ? (
              <AdminTableSkeletonRows columns={8} rows={5} />
            ) : rows.length ? (
              rows.map((d) => {
                const reserved = String(d.poolSummary?.capacityReserved ?? d.clearedItems ?? d.acceptedItems);
                const finalAccepted = String(d.poolSummary?.finalAccepted ?? d.acceptedItems);
                const ratio = fillRatio(reserved, d.targetItems);
                return (
                  <tr key={d.id}>
                    <ATd>
                      <div className="max-w-64 font-semibold leading-snug text-dark-text">{d.title}</div>
                      <div className="mt-0.5 text-[10px] text-dark-dim">
                        {d.id}
                        {d.communityLicense ? ` · ${d.communityLicense}` : ""}
                      </div>
                    </ATd>
                    <ATd className="text-dark-soft">{d.datasetTypeName ?? "-"}</ATd>
                    {/* The bar is driven by CLEARED items, so the number beside
                        it must be the cleared count too. It previously printed
                        the finally-accepted count, which made a 0/15 row render
                        a full bar. Accepted now has its own column. */}
                    <ATd>
                      <span title="Items in processing, audit, dispute, or final acceptance reserve capacity. Failed or rejected items release it.">{num(Number(reserved))} / {num(Number(d.targetItems))}</span>
                      <FillBar ratio={ratio} />
                    </ATd>
                    <ATd className={Number(finalAccepted) > 0 ? "text-lime" : "text-dark-soft"}>
                      <span title="Only final validator decisions advance dataset completion and publication.">{num(Number(finalAccepted))}</span>
                    </ATd>
                    <ATd>{num(d.contributors)}</ATd>
                    <ATd className="font-bold text-lime">
                      {/* 0 is not a zero-karma program — it means the platform
                          karma scale (matrix or difficulty scale) rates each
                          accepted item. Rendering "+0" here would be a false
                          rate claim. */}
                      {d.karmaPerAcceptedItem > 0 ? `+${num(d.karmaPerAcceptedItem)}` : (
                        <span className="font-normal text-dark-soft">platform scale</span>
                      )}
                    </ATd>
                    <ATd>
                      <AdminPill tone={STATUS_TONE[d.publicationStatus] ?? "neutral"}>
                        {d.publicationStatus.replaceAll("_", " ")}
                      </AdminPill>
                      {d.publicationStatus === "published" && d.huggingFaceDataset && (
                        <a
                          href={hfDatasetUrl(d.huggingFaceDataset)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1 block text-[10px] text-lime underline underline-offset-2 hover:text-lime-bright"
                        >
                          {d.huggingFaceDataset} ↗
                        </a>
                      )}
                      {/* Generic: any confirmed target beyond Hugging Face
                          (github, aikosh, ...) renders here with zero new
                          code — see publicPublicationsOf() in the API. */}
                      {d.publications?.filter((p) => p.target !== "huggingface").map((p) => (
                        <a
                          key={p.target}
                          href={p.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1 block text-[10px] text-lime underline underline-offset-2 hover:text-lime-bright"
                        >
                          {p.target} ↗
                        </a>
                      ))}
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {(d.publicationStatus === "not_requested" || d.publicationStatus === "pending") && (
                          <PubActionButton busy={actingId === d.id} onClick={() => setPubActionConfirm({ row: d, action: "request_review", label: "request review" })}>
                            request review
                          </PubActionButton>
                        )}
                        {d.publicationStatus === "manual_review" && (
                          <PubActionButton busy={actingId === d.id} onClick={() => setPubActionConfirm({ row: d, action: "start_publishing", label: "publish" })}>
                            publish to HF
                          </PubActionButton>
                        )}
                        {d.publicationStatus === "failed" && (
                          <PubActionButton busy={actingId === d.id} onClick={() => setPubActionConfirm({ row: d, action: "retry", label: "retry publish" })}>
                            retry
                          </PubActionButton>
                        )}
                        {d.publicationStatus === "published" && (
                          <PubActionButton busy={actingId === d.id} onClick={() => setRetractTarget(d)}>
                            retract
                          </PubActionButton>
                        )}
                        {d.publicationStatus === "retracted" && (
                          <PubActionButton busy={actingId === d.id} onClick={() => setPubActionConfirm({ row: d, action: "request_review", label: "re-review" })}>
                            re-review
                          </PubActionButton>
                        )}
                      </div>
                    </ATd>
                    <ATd>
                      <Link href={`/details?kind=program&id=${encodeURIComponent(d.id)}`} className="font-mono text-xs text-lime underline">
                        view routing →
                      </Link>
                    </ATd>
                  </tr>
                );
              })
            ) : (
              <tr>
                <ATd colSpan={8} className="text-dark-soft">
                  No community datasets match this filter.
                </ATd>
              </tr>
            )}
          </AdminTable>

          {nextCursor && (
            <div className="mt-3 flex justify-center">
              <button
                onClick={() => {
                  setCursor(nextCursor);
                  void load(nextCursor, true);
                }}
                disabled={loadingMore}
                className="cursor-pointer rounded-full border border-dark-line px-4 py-1.5 font-mono text-xs text-dark-soft transition-colors hover:border-dark-hover hover:text-dark-text disabled:opacity-50"
              >
                {loadingMore ? "loading…" : "load more"}
              </button>
            </div>
          )}
        </>
      )}

      <AdminConfirmDialog
        open={retractTarget !== null}
        title="Retract this published dataset?"
        description={
          <>
            {retractTarget?.huggingFaceDataset ?? "This dataset"} will be made private at the publication
            provider, so it is no longer publicly downloadable. The repository and its history are kept, and
            contributors keep the karma already awarded. If the provider refuses the change, the dataset stays
            published and nothing is recorded.
          </>
        }
        confirmLabel="Retract"
        busy={actingId === retractTarget?.id}
        onConfirm={() => {
          const target = retractTarget;
          setRetractTarget(null);
          if (target) void act(target.id, "retract", "retract dataset");
        }}
        onCancel={() => setRetractTarget(null)}
      />

      <AdminConfirmDialog
        open={pubActionConfirm !== null}
        title={
          pubActionConfirm?.action === "start_publishing"
            ? "Publish this dataset to Hugging Face?"
            : pubActionConfirm?.action === "retry"
              ? "Retry this publish?"
              : pubActionConfirm?.label === "re-review"
                ? "Send this retracted dataset back for review?"
                : "Request publication review for this dataset?"
        }
        description={
          pubActionConfirm?.action === "start_publishing" ? (
            <>
              <span className="font-mono text-dark-text">{pubActionConfirm?.row.title}</span> will be pushed to Hugging Face and made
              publicly downloadable at a real, external URL — this is not a preview or a draft. Once live, anyone can find and download
              it until it is explicitly retracted. Only do this after the manual review is genuinely complete.
            </>
          ) : pubActionConfirm?.action === "retry" ? (
            <>
              This re-attempts the Hugging Face publish for{" "}
              <span className="font-mono text-dark-text">{pubActionConfirm?.row.title}</span>, which previously failed. If the
              underlying problem is not fixed, it will fail again with the same or a similar error.
            </>
          ) : pubActionConfirm?.label === "re-review" ? (
            <>
              This sends <span className="font-mono text-dark-text">{pubActionConfirm?.row.title}</span> — currently retracted from
              public view — back into the manual-review queue as a candidate to publish again.
            </>
          ) : (
            <>
              This moves <span className="font-mono text-dark-text">{pubActionConfirm?.row.title}</span> into the manual-review queue
              for publication to Hugging Face. It does not publish anything by itself, but starts that workflow.
            </>
          )
        }
        confirmLabel={pubActionConfirm?.action === "start_publishing" ? "Publish to HF" : pubActionConfirm?.action === "retry" ? "Retry publish" : "Request review"}
        danger={pubActionConfirm?.action === "start_publishing"}
        busy={actingId === pubActionConfirm?.row.id}
        onConfirm={() => {
          const target = pubActionConfirm;
          if (target) void act(target.row.id, target.action, target.label);
        }}
        onCancel={() => setPubActionConfirm(null)}
      />
    </OpenSection>
  );
}

interface SponsorTypeRow {
  id: string;
  name: string;
  status: "platform_review" | "active" | "draft" | "coming_soon";
  domain: string;
  complexityScore: number | null;
  verificationUnits: number | null;
  fields: unknown[];
  createdAt: string;
  updatedAt: string;
}

/* Sponsor-submitted dataset TYPES (fork/custom, via the planner's
 * POST /v1/planner/dataset-types/requests) — distinct from the
 * DatasetRequest "fund a community bounty" flow above. Pending tab is what
 * needs a decision; Active tab is a reference list of what's already live.
 * Karma rating (complexity score + verification units) and reject-with-a-reason
 * happen on the linked detail page, not inline here — this is a queue view.
 *
 * The rate coordinates here (complexityScore, verificationUnits) feed the
 * karma matrix; this product has no currency at all — the
 * "rate set"/"no rate" pill below is the same mechanism already verified
 * for karma awards on the /karma page. The underlying `origin=sponsor` query is
 * not itself community-scoped, but is safe by construction here since
 * Community's API/database only ever contains Community sponsors' drafts. */
function SponsorDatasetTypesSection() {
  const [tab, setTab] = useState<"pending" | "active">("pending");
  // Both tabs need EVERY row in their bucket, not the first page of it: the
  // pending tab is the queue a type gets rated and decided from, so a type
  // dropped past a fixed `limit=50` could never be acted on — and the row was
  // dropped silently, with the count pill still reporting the real total.
  // useAllDatasetTypes pages until the server's total is collected.
  const query =
    tab === "pending" ? "origin=sponsor&status=platform_review" : "origin=sponsor&status=active";
  const { data, loading, error, refresh } = useAllDatasetTypes<SponsorTypeRow>(query, {
    errorMessage: "Sponsor dataset types are unavailable.",
  });
  const rows = data?.datasetTypes ?? [];

  return (
    <OpenSection
      title="Sponsor dataset types"
      sub="New dataset TYPES a sponsor drafted in the planner (fork or custom). Different from the Requests tab, which asks for a program using a type that already exists. Karma rates and rejection happen on the type's detail page."
      actions={
        <div className="flex gap-2 font-mono text-xs">
          <button
            type="button"
            onClick={() => setTab("pending")}
            className={`cursor-pointer rounded-full border px-3.5 py-1.5 transition-colors ${
              tab === "pending" ? "border-amber-400 bg-amber-400/15 text-amber-300" : "border-dark-line text-dark-soft hover:border-dark-hover hover:text-dark-text"
            }`}
          >
            pending{data && tab === "pending" ? ` (${data.total})` : ""}
          </button>
          <button
            type="button"
            onClick={() => setTab("active")}
            className={`cursor-pointer rounded-full border px-3.5 py-1.5 transition-colors ${
              tab === "active" ? "border-lime bg-lime/15 text-lime" : "border-dark-line text-dark-soft hover:border-dark-hover hover:text-dark-text"
            }`}
          >
            active{data && tab === "active" ? ` (${data.total})` : ""}
          </button>
        </div>
      }
    >
      {error && <AdminErrorBanner message={error} onRetry={() => void refresh()} />}
      {!loading && data && rows.length === 0 ? (
        <AdminEmptyState message={tab === "pending" ? "No sponsor types awaiting review." : "No sponsor-submitted types are active yet."} />
      ) : (
        <AdminTable headers={["type", "domain", "fields", "karma rate", "submitted"]}>
          {loading && !data ? (
            <AdminTableSkeletonRows columns={5} />
          ) : rows.map((row) => {
            const priced = row.complexityScore != null && row.verificationUnits != null;
            return (
              <tr key={row.id}>
                <ATd>
                  <a href={`/datasets/view/?id=${encodeURIComponent(row.id)}`} className="font-semibold text-lime hover:text-lime-bright">
                    {row.name}
                  </a>
                  <div className="text-[10px] text-dark-dim">{row.id}</div>
                </ATd>
                <ATd className="text-dark-soft">{row.domain}</ATd>
                <ATd className="text-dark-soft">{Array.isArray(row.fields) ? row.fields.length : "-"}</ATd>
                <ATd>
                  <AdminPill tone={priced ? "success" : "warning"}>{priced ? "rate set" : "no rate"}</AdminPill>
                </ATd>
                <ATd className="text-dark-soft">{new Date(row.createdAt).toLocaleDateString()}</ATd>
              </tr>
            );
          })}
        </AdminTable>
      )}
    </OpenSection>
  );
}

/* The page is four distinct jobs (read the numbers, triage requests, triage
 * sponsor types, look one program up — "publish finished programs" folded
 * into the last one below, since it was always just that same table
 * pre-filtered to publish-ready). Stacked on one scroll they read as one
 * undifferentiated wall, so each is its own tab.
 *
 * Only the active tab's section mounts, so opening the page fires the metrics
 * call plus the two small badge calls instead of every list endpoint at once. */
type OpenTab = "overview" | "requests" | "types" | "samples" | "programs";

const OPEN_TABS: OpenTab[] = ["overview", "requests", "types", "samples", "programs"];

/** Statuses that still need an admin to act. `approved` and `implemented` are
 *  already decided, and `declined` is closed — badging those would show a
 *  standing count that no action can ever clear. */
const OPEN_REQUEST_STATUSES = ["submitted", "under_review", "changes_requested", "disputed"];

function isOpenTab(value: string | null): value is OpenTab {
  return value != null && (OPEN_TABS as string[]).includes(value);
}

export default function OpenProgramPage() {
  const { data, loading, error, refresh } = useAdminResource<OpenMetrics>("/v1/admin/community/open", {
    errorMessage: "Open Program metrics are unavailable.",
  });

  // Publish-ready rows are fetched once here and handed to the tab, so the
  // badge is accurate before the tab is ever opened (one call, not two).
  const publishReady = useAdminResource<OpenDatasetPage>(
    "/v1/admin/community/datasets?filter=publishable&limit=50",
    { errorMessage: "Publish-ready queue is unavailable.", pollMs: 0 }
  );
  // Count only — limit=1 keeps the payload to one row while `total` carries the
  // real pending figure for the badge. The tab itself pages properly.
  const pendingTypes = useAdminResource<{ total: number }>(
    "/v1/admin/dataset-types?origin=sponsor&status=platform_review&limit=1",
    { errorMessage: "Sponsor dataset types are unavailable." }
  );
  // Sponsor reference-sample review queue. This endpoint has no separate
  // count-only mode, so (like publishReady above) the full response is
  // fetched once here and handed to the tab — the badge is accurate before
  // the tab is ever opened, with no duplicate fetch when it is.
  const sponsorSamples = useAdminResource<SponsorExamplesResponse>("/v1/admin/sponsor-examples", {
    errorMessage: "Sponsor samples are unavailable.",
  });

  // The active tab is DERIVED from ?tab=, not mirrored into a separate state.
  // The query string is the single source of truth (same pattern as
  // admin-shell's sidebar selection): the Requests tab's "view program →" link
  // points at ?tab=programs&program=… on THIS same route, so following it is a
  // query-only navigation that re-renders without remounting. Deriving from
  // useSearchParams means that navigation — and back/forward — switches the tab
  // for free, with no effect and no state to keep in sync. The layout supplies
  // the Suspense boundary prerendering requires for the hook.
  const searchParams = useSearchParams();
  const router = useRouter();
  const tabParam = searchParams.get("tab");
  const tab: OpenTab = isOpenTab(tabParam) ? tabParam : "overview";

  // Write the tab through the router (not window.history) so the derived value
  // above updates immediately and never diverges from the address bar. replace
  // (not push) keeps Back going to the previous PAGE rather than walking back
  // through tab clicks; other params (e.g. program) are preserved.
  const selectTab = useCallback(
    (next: OpenTab) => {
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      if (next === "overview") params.delete("tab");
      else params.set("tab", next);
      const qs = params.toString();
      router.replace(`/open-program/${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [router, searchParams]
  );

  // Overview's "ready to publish" tile is the one entry point that should
  // land pre-filtered — the tab itself (and its own filter chips) still
  // default to "all" on a plain click, same as before this tile existed.
  const goToPublishReady = useCallback(() => {
    router.replace("/open-program/?tab=programs&filter=publishable", { scroll: false });
  }, [router]);

  // ?sampleOwnerType=/&sampleOwnerId= is the handoff from the Requests tab's
  // "review samples" link — scopes the platform-wide sponsor-samples queue
  // down to just the one request/pool the reviewer came from, the same
  // derive-from-URL pattern the Programs tab uses for ?program=. Filtering is
  // client-side (not a server query param) because this endpoint always
  // returns its full ≤100-row queue in one call already.
  const sampleOwnerType = searchParams.get("sampleOwnerType");
  const sampleOwnerId = searchParams.get("sampleOwnerId");
  const sampleOwnerLabel = searchParams.get("sampleOwnerLabel");
  const showAllSamples = useCallback(() => {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.delete("sampleOwnerType");
    params.delete("sampleOwnerId");
    params.delete("sampleOwnerLabel");
    const qs = params.toString();
    router.replace(`/open-program/${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [router, searchParams]);
  const scopedSamples: SponsorExamplesResponse | null =
    sampleOwnerId && sponsorSamples.data
      ? { examples: sponsorSamples.data.examples.filter((e) => e.owner?.type === sampleOwnerType && e.owner?.id === sampleOwnerId) }
      : sponsorSamples.data;

  const overallFill =
    data && Number(data.targetItems) > 0 ? Number(data.clearedItems ?? data.acceptedItems) / Number(data.targetItems) : 0;

  const openRequests = data
    ? OPEN_REQUEST_STATUSES.reduce((sum, status) => sum + (data.requestCounts[status] ?? 0), 0)
    : 0;
  const publishReadyRows = publishReady.data?.datasets ?? [];

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Open Program"
        sub="Authoritative community-program, request, and karma evidence."
      />
      {error && <AdminErrorBanner message={error} onRetry={() => void refresh()} />}

      <AdminTabs
        active={tab}
        onChange={selectTab}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "requests", label: "Requests", count: openRequests, tone: "alert" },
          { id: "types", label: "Dataset types", count: pendingTypes.data?.total ?? 0, tone: "alert" },
          { id: "samples", label: "Sample review", count: sponsorSamples.data?.examples.length ?? 0, tone: "alert" },
          // Publish-ready count now lives here (was its own "Publishing" tab
          // — folded in 2026-09-09, it was always just this same table
          // pre-filtered). Not "alert" tone: nothing to review or decide on,
          // just work that's ready to go.
          { id: "programs", label: "All programs", count: publishReadyRows.length },
        ]}
      />

      {tab === "overview" &&
        (loading && !data ? (
          <AdminLoadingState label="Loading program metrics…" />
        ) : data ? (
          <div className="space-y-6">
            {/* Two separate things used to sit in one undifferentiated row of
                five tiles: pool CAPACITY (how full the programs are) and
                submission COUNTS (where individual items are in the pipeline).
                They are now two labelled groups, because they do not add up to
                each other and reading them as one set is what made the page
                look self-contradictory. */}
            <OpenSection
              title="Pool capacity"
              sub="“Cleared” items passed automated checks and are holding a slot in the pool — that is what fills a program. “Accepted” is the stricter count: a validator finally passed the item. Accepted is normally lower, and is 0 while audits are still open."
            >
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
                <AdminStat label="community programs" value={num(data.programs)} />
                <AdminStat label="target items" value={num(Number(data.targetItems))} />
                <AdminStat
                  label="pool filled"
                  value={pct(overallFill)}
                  tone={overallFill >= 1 ? "lime" : "default"}
                  sub={`${num(Number(data.clearedItems ?? data.acceptedItems))} cleared / ${num(Number(data.targetItems))} target`}
                />
                <AdminStat
                  label="finally accepted"
                  value={num(Number(data.acceptedItems))}
                  tone={Number(data.acceptedItems) > 0 ? "lime" : "default"}
                  sub="validator-passed"
                />
                <AdminStat label="karma issued" value={num(data.totalKarma)} tone="lime" />
              </div>
            </OpenSection>

            {/* Every community submission right now, in exactly one real
                pipeline bucket — pending intake, mid-pipeline/audit, or a
                terminal verdict. Real row counts, not a derived guess. */}
            <OpenSection
              title="Submissions in flight"
              sub={`${num(
                data.pipelineBreakdown.pending + data.pipelineBreakdown.inVerification + data.pipelineBreakdown.completed
              )} community submissions, each counted in exactly one pipeline stage. These count submissions, not pool slots, so they do not sum to the numbers above.`}
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <AdminStat label="pending" value={num(data.pipelineBreakdown.pending)} sub="awaiting pipeline pickup" />
                <AdminStat label="in verification" value={num(data.pipelineBreakdown.inVerification)} tone="amber" sub="checks, audit, or revision" />
                <AdminStat label="completed" value={num(data.pipelineBreakdown.completed)} tone="lime" sub="accepted or rejected" />
              </div>
            </OpenSection>

            {/* What is waiting on an admin, so the Overview tab answers "is
                there anything for me to do" without opening all three queues.
                Counts come from the same fetches that feed the tab badges. */}
            <OpenSection
              title="Waiting on you"
              sub="Every open decision across the three queues. Each row opens its tab."
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <button type="button" onClick={() => selectTab("requests")} className="cursor-pointer text-left">
                  <AdminStat
                    label="requests to review"
                    value={num(openRequests)}
                    tone={openRequests > 0 ? "amber" : "default"}
                    sub="new community programs"
                  />
                </button>
                <button type="button" onClick={() => selectTab("types")} className="cursor-pointer text-left">
                  <AdminStat
                    label="dataset types to rate"
                    value={num(pendingTypes.data?.total ?? 0)}
                    tone={(pendingTypes.data?.total ?? 0) > 0 ? "amber" : "default"}
                    sub="sponsor fork / custom drafts"
                  />
                </button>
                <button type="button" onClick={goToPublishReady} className="cursor-pointer text-left">
                  <AdminStat
                    label="ready to publish"
                    value={num(publishReadyRows.length)}
                    tone={publishReadyRows.length > 0 ? "lime" : "default"}
                    sub="at 98%+ of target"
                  />
                </button>
              </div>
            </OpenSection>
          </div>
        ) : null)}

      {tab === "requests" && (
        <OpenSection
          title="Request queue"
          sub="Members asking for a new karma-only community program. Review the full request and its samples before approving; a separate, idempotent Create program step mints the program."
          actions={
            data && Object.entries(data.requestCounts).length ? (
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.requestCounts).map(([status, count]) => (
                  <AdminPill key={status}>
                    {status.replaceAll("_", " ")} · {count}
                  </AdminPill>
                ))}
              </div>
            ) : undefined
          }
        >
          {data && Object.entries(data.requestCounts).length === 0 && <AdminEmptyState message="No requests yet." />}
          <CommunityRequestsSection embedded />
        </OpenSection>
      )}

      {tab === "types" && <SponsorDatasetTypesSection />}

      {tab === "samples" && (
        <OpenSection
          title="Sponsor sample review"
          sub="Reference examples a sponsor uploaded with a request or a bounty. Approving is what the request's samples gate checks — a request can't be approved until enough of these clear."
          actions={
            sampleOwnerId && (
              <button
                type="button"
                onClick={showAllSamples}
                className="cursor-pointer rounded-full border border-amber-400/40 px-3.5 py-1.5 text-[11px] text-amber-300 transition-colors hover:border-amber-300"
              >
                viewing samples for {sampleOwnerLabel || "this request"} · show all
              </button>
            )
          }
        >
          <SponsorSamplesSection
            data={scopedSamples}
            loading={sponsorSamples.loading}
            error={sponsorSamples.error}
            refresh={() => void sponsorSamples.refresh()}
          />
        </OpenSection>
      )}

      {tab === "programs" && <CommunityDatasetsSection />}
    </div>
  );
}
