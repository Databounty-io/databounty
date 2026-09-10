"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  AdminDate,
  AdminErrorBanner,
  AdminLoadingState,
  AdminPageHeader,
  AdminPill,
  AdminSectionHeading,
  AdminStat,
  AdminTable,
  AdminTabs,
  ATd,
} from "@/components/admin-shell";
import { useAdminResource } from "@/lib/use-admin-resource";
import { num, FLAG_REASON_LABELS, COMMUNITY_REQUEST_STATUS_TONE, type CommunityRequestStatus } from "@/lib/format";
import {
  formatStageScore,
  normalizeValidationStage,
  stageStateFromAdminStage,
  VALIDATION_STAGE_STATE_LABEL,
  VALIDATION_STAGE_STATE_TONE,
} from "@/lib/validation-state";

type TabId = "overview" | "sponsor" | "contributor" | "validator" | "karma";

interface BountyRef {
  id: string;
  title: string;
  kind?: string;
  datasetCategory?: string;
  datasetType?: { id: string; name: string } | null;
}

/** `status` IS the `ValidationResult.outcome` column (both admin stage builders
 *  map `status: r.outcome`). `detailJson` is optional because the API is being
 *  widened to send it: it is the ONLY way to classify `ai_attribution` and a
 *  passing `dedupe`, which are written with no `outcome` at all — absent, the
 *  decoder degrades to `outcome`/`status`. `reason` is gone: both builders
 *  hardcode it to null, so nothing ever read it. */
interface Stage {
  stage: string;
  passed: boolean;
  score: number | null;
  status: string | null;
  detailJson?: Record<string, unknown> | null;
}

interface UserDetail {
  profile: {
    id: string;
    label: string;
    email: string | null;
    handle: string | null;
    authMethod: string;
    status: string;
    onboarded: boolean;
    emailVerified: boolean;
    profilePublic: boolean;
    persona: string | null;
    createdAt: string;
    lastSeenAt: string | null;
    karmaTotal: number;
    roles: string[];
    contributorRank: string | null;
    validatorRank: string | null;
  };
  metrics: {
    sponsoredBounties: number;
    datasetRequests: number;
    /** Requests not yet minted; an implemented one is already its bounty. */
    openDatasetRequests: number;
    submissions: number;
    acceptedSubmissions: number;
    rejectedSubmissions: number;
    submissionsByStatus: Record<string, number>;
    audits: number;
    /** null = not available (no per-validator claimed-audit record exists in
     *  the schema to group by), which is a different claim from `{}` = this
     *  account has genuinely never been assigned one. Rendering the two the
     *  same way would assert something about the account the platform cannot
     *  actually determine. */
    auditsByStatus: Record<string, number> | null;
    auditsCompleted: number;
    acceptedItems: number;
    flagsRaised: number;
    abandons: number;
    contributorMissedDeadlines: number;
    validatorMissedDeadlines: number;
    karmaEvents: number;
    securedKarma?: {
      total: number;
      byRole: {
        contributor: { pending: number; awardCount: number };
        validator: { pending: number; awardCount: number };
        sponsor: { pending: number; awardCount: number };
      };
    };
    /** Distinct datasets/bounties submitted to, not raw submission count. */
    distinctDatasetsContributed: number;
  };
  sponsored: {
    bounties: {
      id: string;
      title: string;
      kind: string;
      status: string;
      datasetCategory: string;
      datasetType: { id: string; name: string } | null;
      targetItems: number;
      acceptedItems: number;
      createdAt: string;
    }[];
    datasetRequests: { id: string; title: string; status: CommunityRequestStatus; targetItems: number | null; proposedLicense: string; createdAt: string }[];
  };
  submissions: { id: string; title: string; status: string; createdAt: string; bounty: BountyRef; validationStages: Stage[] }[];
  audits: { id: string; status: string; itemCount: number; claimedAt: string | null; deadline: string | null; createdAt: string; bounty: BountyRef }[];
  flags: { id: string; reason: string; status: string; createdAt: string; submission: { id: string; title: string; bounty: BountyRef } }[];
  karmaEvents: { id: string; eventType: string; amount: number; sourceType: string; sourceId: string; createdAt: string }[];
}

function BountyCell({ bounty }: { bounty: BountyRef }) {
  return (
    <div>
      <Link href={`/details?kind=bounty&id=${encodeURIComponent(bounty.id)}`} className="text-lime underline">
        {bounty.title}
      </Link>
      <div className="text-[10px] text-dark-dim">
        {bounty.kind ?? "—"}
        {bounty.datasetType ? ` · ${bounty.datasetType.name}` : ""}
      </div>
    </div>
  );
}

/**
 * Mirrors the Stages renderer on the details page, decoded through the shared
 * validation-state contract: `passed ? "success" : "warning"` with
 * `status ?? "recorded"` rendered an `ai_attribution` flag and a TERMINAL
 * dedupe rejection as the same amber "recorded" pill a never-ran stage gets.
 *
 * The per-stage reason block is gone: both admin stage builders write
 * `reason: null` unconditionally, so the filter feeding it was always empty and
 * the block never rendered — the comment claiming `reason` "has always been on
 * the wire" was false. No reason text is invented in its place.
 */
function Stages({ stages }: { stages: Stage[] }) {
  if (!stages.length) return <span className="text-dark-dim">no stages recorded</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {stages.map((stage, index) => {
        const state = stageStateFromAdminStage(stage);
        const score = formatStageScore(stage.stage, stage.score);
        return (
          <AdminPill key={`${stage.stage}:${index}`} tone={VALIDATION_STAGE_STATE_TONE[state]}>
            {normalizeValidationStage(stage.stage).replaceAll("_", " ")}: {VALIDATION_STAGE_STATE_LABEL[state]}
            {score == null ? "" : ` · ${score}`}
          </AdminPill>
        );
      })}
    </div>
  );
}

/** The capped history lists are 100 rows; the metric beside them is the real
 * total. Say so rather than letting a truncated list read as the whole record. */
function TruncationNote({ shown, total, noun }: { shown: number; total: number; noun: string }) {
  if (total <= shown) return null;
  return (
    <p className="font-mono text-[10px] text-dark-dim">
      Showing the {num(shown)} most recent of {num(total)} {noun}.
    </p>
  );
}

/** Shows a stored rank counter beside the same figure counted from work rows.
 * They are maintained by different code paths and do drift in practice, so a
 * divergence is called out explicitly instead of one silently standing in for
 * the other. */
function CounterComparison({
  label,
  counter,
  derived,
  derivedNoun,
}: {
  label: string;
  counter: number;
  derived: number;
  derivedNoun: string;
}) {
  const diverged = counter !== derived;
  return (
    <div className={`rounded-[11px] border p-[18px] font-mono ${diverged ? "border-dark-warn-border bg-[#161309]" : "border-dark-line bg-dark-card"}`}>
      <div className="text-[9.5px] font-medium uppercase tracking-[0.05em] text-dark-dim">{label}</div>
      <div className="mt-2 flex items-baseline gap-3">
        <span className="text-xl text-dark-text">{num(counter)}</span>
        <span className="text-[10px] text-dark-dim">rank counter</span>
      </div>
      <div className="mt-1 flex items-baseline gap-3">
        <span className="text-xl text-dark-text">{num(derived)}</span>
        <span className="text-[10px] text-dark-dim">{derivedNoun}</span>
      </div>
      {diverged && (
        <div className="mt-2 text-[10px] leading-relaxed text-amber-400">
          These disagree. The rank counter is what the rank ladder reads; the work-row count is what actually exists.
        </div>
      )}
    </div>
  );
}

export default function AdminUserView() {
  // Derived from the query string, not latched into state on mount: Next does
  // not remount on a query-only change, so a one-shot read would keep showing
  // the previous account after an in-page link swapped the ?id=.
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const missingId = id === null;
  const [tab, setTab] = useState<TabId>("overview");

  const { data, loading, error, refresh } = useAdminResource<UserDetail>(
    `/v1/admin/internal/user/${encodeURIComponent(id ?? "")}`,
    {
      errorMessage: "This account record is unavailable.",
      // No background poll. This record costs ~54 SQL queries per load (the
      // nested submission/audit/flag histories expand into their own queries),
      // and an account's history is not a live surface that goes stale in
      // 30 seconds. The hook still refetches on window focus and tab visibility.
      pollMs: 0,
      enabled: Boolean(id),
    }
  );

  if (missingId) {
    return (
      <div className="space-y-5">
        <AdminPageHeader title="Account" sub="No account id given." />
        <AdminErrorBanner message="This page needs an ?id= account id. Open it from a row on the Users page." />
        <Link href="/users" className="font-mono text-xs text-lime underline">← back to Users</Link>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-5">
        <AdminPageHeader title="Account" sub="Whole-account record across every role this person has held." />
        {error && <AdminErrorBanner message={error} onRetry={() => void refresh()} />}
        {loading && !error && <AdminLoadingState label="Loading account record…" />}
      </div>
    );
  }

  const { profile, metrics } = data;
  // API-first rollout safety: an older API response renders a truthful zeroed
  // breakdown rather than crashing the admin account page during deployment.
  const securedKarma = metrics.securedKarma ?? {
    total: 0,
    byRole: {
      contributor: { pending: 0, awardCount: 0 },
      validator: { pending: 0, awardCount: 0 },
      sponsor: { pending: 0, awardCount: 0 },
    },
  };
  // An implemented request IS its minted bounty, so summing all requests with
  // all bounties double-counts one sponsored dataset. Only not-yet-minted
  // requests add to the headline figure.
  const sponsoredTotal = metrics.sponsoredBounties + metrics.openDatasetRequests;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/users" className="font-mono text-xs text-lime underline">← Users</Link>
      </div>

      <AdminPageHeader
        title={profile.label}
        sub={`${profile.email ?? "no email"}${profile.handle ? ` · @${profile.handle}` : ""} · joined ${new Date(profile.createdAt).toLocaleDateString()}`}
      />

      {error && <AdminErrorBanner message={error} onRetry={() => void refresh()} />}

      <div className="flex flex-wrap items-center gap-2">
        <AdminPill tone={profile.status === "active" ? "lime" : profile.status === "suspended" ? "danger" : "neutral"}>
          {profile.status}
        </AdminPill>
        {profile.roles.length ? (
          profile.roles.map((r) => <AdminPill key={r} tone={r === "admin" ? "lime" : "neutral"}>{r}</AdminPill>)
        ) : (
          <AdminPill tone="neutral">no admin tier</AdminPill>
        )}
        <AdminPill tone={profile.emailVerified ? "success" : "warning"}>
          {profile.emailVerified ? "email verified" : "email unverified"}
        </AdminPill>
        <AdminPill tone={profile.onboarded ? "neutral" : "warning"}>
          {profile.onboarded ? "onboarded" : "not onboarded"}
        </AdminPill>
        <AdminPill tone="neutral">auth: {profile.authMethod}</AdminPill>
        <AdminPill tone="neutral">profile {profile.profilePublic ? "public" : "private"}</AdminPill>
        {profile.persona && <AdminPill tone="info">prefers {profile.persona} view</AdminPill>}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <AdminStat label="sponsored" value={num(sponsoredTotal)} sub={`${num(metrics.sponsoredBounties)} pools · ${num(metrics.openDatasetRequests)} unminted requests`} />
        <AdminStat label="submitted" value={num(metrics.submissions)} sub={`${num(metrics.acceptedSubmissions)} accepted · ${num(metrics.distinctDatasetsContributed)} datasets`} />
        {/* Every tile above and below is a count of real work rows. The
            rank-ladder counters (Rank.acceptedItems / auditsCompleted) are a
            SEPARATE, separately-maintained quantity and are shown on their own
            in the Overview tab — pairing one with the other here produced
            readings like "audits 0 · 4 completed" straight from live data. */}
        <AdminStat label="audit batches" value={num(metrics.audits)} sub={`${num(metrics.flagsRaised)} flags raised`} />
        <AdminStat label="released karma" value={num(profile.karmaTotal)} tone="lime" sub="running balance" />
        <AdminStat
          label="secured karma"
          value={num(securedKarma.total)}
          sub={`${num(securedKarma.byRole.contributor.pending)} contributing · ${num(securedKarma.byRole.validator.pending)} validating · ${num(securedKarma.byRole.sponsor.pending)} sponsoring`}
        />
        <AdminStat
          label="deadline standing"
          value={num(metrics.abandons + metrics.contributorMissedDeadlines + metrics.validatorMissedDeadlines)}
          tone={metrics.abandons + metrics.contributorMissedDeadlines + metrics.validatorMissedDeadlines > 0 ? "amber" : "default"}
          sub={`${num(metrics.abandons)} abandons · ${num(metrics.contributorMissedDeadlines + metrics.validatorMissedDeadlines)} missed deadlines`}
        />
      </div>

      <AdminTabs<TabId>
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "sponsor", label: "Sponsor", count: sponsoredTotal },
          { id: "contributor", label: "Contributor", count: metrics.submissions },
          { id: "validator", label: "Validator", count: metrics.audits + metrics.flagsRaised },
          { id: "karma", label: "Karma", count: metrics.karmaEvents },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === "overview" && (
        <div className="space-y-5">
          <AdminSectionHeading title="Account" sub="Identity and standing as stored — no derived claims." />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <AdminStat label="signed up" value={<AdminDate iso={profile.createdAt} />} />
            <AdminStat label="last seen" value={profile.lastSeenAt ? <AdminDate iso={profile.lastSeenAt} /> : "never"} />
            <AdminStat label="contributor rank" value={profile.contributorRank ?? "unranked"} />
            <AdminStat label="validator rank" value={profile.validatorRank ?? "unranked"} />
          </div>

          <AdminSectionHeading
            title="Rank-ladder counters"
            sub="The stored counters that drive rank, shown next to the same figure counted from work rows. These are maintained separately and can legitimately disagree — neither is presented as the other."
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <CounterComparison
              label="accepted items"
              counter={metrics.acceptedItems}
              derived={metrics.acceptedSubmissions}
              derivedNoun="accepted submissions"
            />
            <CounterComparison
              label="audits completed"
              counter={metrics.auditsCompleted}
              derived={metrics.audits}
              derivedNoun="audit batches assigned"
            />
          </div>

          <AdminSectionHeading title="Submission outcomes" sub="Every submission this account has filed, by pipeline status." />
          {Object.keys(metrics.submissionsByStatus ?? {}).length ? (
            <div className="flex flex-wrap gap-2">
              {Object.entries(metrics.submissionsByStatus ?? {}).map(([status, count]) => (
                <AdminPill key={status} tone="neutral">{status.replaceAll("_", " ")}: {num(count)}</AdminPill>
              ))}
            </div>
          ) : (
            <p className="font-mono text-xs text-dark-soft">This account has never submitted an item.</p>
          )}

          <AdminSectionHeading title="Audit outcomes" sub="Every audit batch assigned to this account, by status." />
          {metrics.auditsByStatus === null || metrics.auditsByStatus === undefined ? (
            <p className="font-mono text-xs text-dark-soft">
              Not available — this platform stores audit decisions per window, not per validator, so there is no
              per-account audit record to break down. This is a missing measurement, not an empty one: it does not
              mean this account has done no audit work.
            </p>
          ) : Object.keys(metrics.auditsByStatus).length ? (
            <div className="flex flex-wrap gap-2">
              {Object.entries(metrics.auditsByStatus).map(([status, count]) => (
                <AdminPill key={status} tone="neutral">{status.replaceAll("_", " ")}: {num(count)}</AdminPill>
              ))}
            </div>
          ) : (
            <p className="font-mono text-xs text-dark-soft">This account has never been assigned an audit batch.</p>
          )}

          <p className="font-mono text-[10px] leading-relaxed text-dark-dim">
            Sponsor, contributor and validator are not granted roles — the tabs above are this account&apos;s real work
            records. An empty tab means no such work exists, not that access was withheld.
          </p>
        </div>
      )}

      {tab === "sponsor" && (
        <div className="space-y-5">
          <AdminSectionHeading title="Pools sponsored" sub="Pools minted with this account as requester." />
          <AdminTable headers={["pool", "kind", "status", "type", "target", "accepted", "created"]}>
            {data.sponsored.bounties.map((b) => (
              <tr key={b.id}>
                <ATd className="font-semibold"><BountyCell bounty={b} /></ATd>
                <ATd>{b.kind}</ATd>
                <ATd><AdminPill tone={b.status === "active" ? "lime" : "neutral"}>{b.status}</AdminPill></ATd>
                <ATd className="text-dark-soft">{b.datasetType?.name ?? b.datasetCategory}</ATd>
                <ATd>{num(b.targetItems)}</ATd>
                <ATd>{num(b.acceptedItems)}</ATd>
                <ATd><AdminDate iso={b.createdAt} /></ATd>
              </tr>
            ))}
            {!data.sponsored.bounties.length && (
              <tr><ATd colSpan={7} className="text-dark-soft">This account has never sponsored a pool.</ATd></tr>
            )}
          </AdminTable>
          <TruncationNote shown={data.sponsored.bounties.length} total={metrics.sponsoredBounties} noun="pools" />

          <AdminSectionHeading title="Community dataset requests" sub="Requests filed for admin review, whether or not they were minted." />
          <AdminTable headers={["request", "status", "target items", "license", "created"]}>
            {data.sponsored.datasetRequests.map((r) => (
              <tr key={r.id}>
                <ATd className="font-semibold">{r.title}</ATd>
                <ATd><AdminPill tone={COMMUNITY_REQUEST_STATUS_TONE[r.status]}>{r.status.replaceAll("_", " ")}</AdminPill></ATd>
                <ATd>{r.targetItems != null ? num(r.targetItems) : <span className="text-dark-dim">—</span>}</ATd>
                <ATd className="text-dark-soft">{r.proposedLicense}</ATd>
                <ATd><AdminDate iso={r.createdAt} /></ATd>
              </tr>
            ))}
            {!data.sponsored.datasetRequests.length && (
              <tr><ATd colSpan={5} className="text-dark-soft">This account has never filed a dataset request.</ATd></tr>
            )}
          </AdminTable>
        </div>
      )}

      {tab === "contributor" && (
        <div className="space-y-5">
          <AdminSectionHeading title="Submissions" sub="Newest first, with the stored validation evidence for each." />
          <AdminTable headers={["submission", "submission ID", "pool", "status", "pipeline", "created", "record"]}>
            {data.submissions.map((s) => (
              <tr key={s.id}>
                <ATd className="font-semibold">{s.title}</ATd>
                <ATd className="font-mono text-[11px] text-dark-soft break-all">{s.id}</ATd>
                <ATd><BountyCell bounty={s.bounty} /></ATd>
                <ATd><AdminPill tone={s.status === "accepted" ? "lime" : s.status === "rejected" ? "danger" : "neutral"}>{s.status.replaceAll("_", " ")}</AdminPill></ATd>
                <ATd><Stages stages={s.validationStages} /></ATd>
                <ATd><AdminDate iso={s.createdAt} /></ATd>
                <ATd>
                  <Link href={`/details?kind=submission&id=${encodeURIComponent(s.id)}`} className="font-mono text-xs text-lime underline">
                    open →
                  </Link>
                </ATd>
              </tr>
            ))}
            {!data.submissions.length && (
              <tr><ATd colSpan={7} className="text-dark-soft">This account has never submitted an item.</ATd></tr>
            )}
          </AdminTable>
          <TruncationNote shown={data.submissions.length} total={metrics.submissions} noun="submissions" />
        </div>
      )}

      {tab === "validator" && (
        <div className="space-y-5">
          <AdminSectionHeading title="Audit batches" sub="Batches assigned to this account as validator." />
          <AdminTable headers={["batch", "pool", "status", "items", "claimed", "deadline"]}>
            {data.audits.map((a) => (
              <tr key={a.id}>
                <ATd className="font-mono text-[11px]">{a.id}</ATd>
                <ATd><BountyCell bounty={a.bounty} /></ATd>
                <ATd><AdminPill tone={a.status === "settled" || a.status === "completed" ? "lime" : "neutral"}>{a.status.replaceAll("_", " ")}</AdminPill></ATd>
                <ATd>{num(a.itemCount)}</ATd>
                <ATd>{a.claimedAt ? <AdminDate iso={a.claimedAt} /> : <span className="text-dark-dim">—</span>}</ATd>
                <ATd>{a.deadline ? <AdminDate iso={a.deadline} /> : <span className="text-dark-dim">—</span>}</ATd>
              </tr>
            ))}
            {!data.audits.length && (
              <tr><ATd colSpan={6} className="text-dark-soft">This account has never been assigned an audit batch.</ATd></tr>
            )}
          </AdminTable>
          <TruncationNote shown={data.audits.length} total={metrics.audits} noun="audit batches" />

          <AdminSectionHeading title="Flags raised" sub="Items this account flagged during review." />
          <AdminTable headers={["submission", "pool", "reason", "status", "raised", "record"]}>
            {data.flags.map((f) => (
              <tr key={f.id}>
                <ATd className="font-semibold">{f.submission.title}</ATd>
                <ATd><BountyCell bounty={f.submission.bounty} /></ATd>
                <ATd className="text-dark-soft">{FLAG_REASON_LABELS[f.reason] ?? f.reason.replaceAll("_", " ")}</ATd>
                <ATd><AdminPill tone={f.status === "open" ? "warning" : "neutral"}>{f.status}</AdminPill></ATd>
                <ATd><AdminDate iso={f.createdAt} /></ATd>
                <ATd>
                  <Link href={`/details?kind=submission&id=${encodeURIComponent(f.submission.id)}`} className="font-mono text-xs text-lime underline">
                    open →
                  </Link>
                </ATd>
              </tr>
            ))}
            {!data.flags.length && (
              <tr><ATd colSpan={6} className="text-dark-soft">This account has never raised a flag.</ATd></tr>
            )}
          </AdminTable>
        </div>
      )}

      {tab === "karma" && (
        <div className="space-y-5">
          <AdminSectionHeading title="Karma history" sub="Every karma event recorded for this account, newest first." />
          <AdminTable headers={["event", "amount", "source", "recorded"]}>
            {data.karmaEvents.map((k) => (
              <tr key={k.id}>
                <ATd className="font-semibold">{k.eventType.replaceAll("_", " ")}</ATd>
                <ATd className={k.amount < 0 ? "text-rose-400" : "text-lime"}>{k.amount > 0 ? `+${num(k.amount)}` : num(k.amount)}</ATd>
                <ATd className="font-mono text-[10px] text-dark-soft">{k.sourceType} · {k.sourceId}</ATd>
                <ATd><AdminDate iso={k.createdAt} /></ATd>
              </tr>
            ))}
            {!data.karmaEvents.length && (
              <tr><ATd colSpan={4} className="text-dark-soft">No karma events recorded for this account.</ATd></tr>
            )}
          </AdminTable>
          <TruncationNote shown={data.karmaEvents.length} total={metrics.karmaEvents} noun="karma events" />
          <p className="font-mono text-[10px] text-dark-dim">
            The karma total above is the account&apos;s maintained running sum, not a sum of this page.
          </p>
        </div>
      )}
    </div>
  );
}
