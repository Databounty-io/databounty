// SPDX-License-Identifier: Apache-2.0

import type { Bounty } from "@/lib/types";
import { parsePoolPublication } from "@/lib/publication";

/**
 * Map a backend bounty row (GET /v1/bounties[/:id]) to the web app's Bounty
 * shape. The API is the system of record; fields it doesn't track yet
 * (per-stage counts, quality rates, slots) default to 0/empty rather than
 * showing invented numbers. Shared by the sponsor list and the tracking page.
 */
export function apiToBounty(a: Record<string, unknown>): Bounty {
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const slots = Array.isArray(a.slots)
    ? a.slots.map((slot) => {
        const row = slot as Record<string, unknown>;
        return {
          id: s(row.id),
          name: s(row.name),
          difficulty: s(row.difficulty),
          targetItems: n(row.itemCount),
          acceptedItems: n(row.filled),
          karmaPerAcceptedItem: n(a.karmaPerAcceptedItem),
        };
      })
    : [];
  return {
    id: s(a.id),
    communityPolicy: (() => {
      const summary = a.poolSummary as { policy?: unknown } | null | undefined;
      const policy = summary?.policy;
      if (!policy || typeof policy !== "object") return null;
      const row = policy as Record<string, unknown>;
      return (row.validation === "full_human" || row.validation === "automation_only")
        && row.sponsorDispute === false && row.karmaRelease === "on_final_accept"
        ? { validation: row.validation, sponsorDispute: false as const, karmaRelease: "on_final_accept" as const }
        : null;
    })(),
    // Same defensive read as `communityPolicy` above: a payload with no
    // publication block (external bounty, or an API predating it) yields null, and
    // every surface renders nothing rather than inventing "not published".
    communityPublication: parsePoolPublication(a.poolSummary),
    communityProgress: (() => {
      const summary = a.poolSummary as Record<string, unknown> | null | undefined;
      if (!summary) return null;
      return {
        totalSubmitted: n(summary.totalSubmitted), capacityReserved: n(summary.capacityReserved),
        finalAccepted: n(summary.finalAccepted), validatorReview: n(summary.validatorReview),
        processing: n(summary.processing), rejected: n(summary.rejected),
        failedAutomatedChecks: n(summary.failedAutomatedChecks),
      };
    })(),
    title: s(a.title),
    description: s(a.description),
    category: a.datasetCategory as Bounty["category"],
    datasetTypeId: (a.datasetTypeId as string | undefined) ?? undefined,
    language: s(a.language),
    framework: s(a.framework),
    targetItems: n(a.targetItems),
    requiredSponsorExamples: n(a.requiredSponsorExamples),
    approvedSponsorExamples: n(a.approvedSponsorExamples),
    contributorTargetItems: n(a.contributorTargetItems) || Math.max(0, n(a.targetItems) - n(a.requiredSponsorExamples)),
    // FINAL acceptance only (validator-passed / published), not the raw
    // `acceptedItems` column — that is the pool-fill/intake counter and also
    // counts accepted_pending_sample + in_sponsor_review. GET /v1/bounties/:id
    // (this page's data source) sends both fields verbatim under their real
    // names; without this fallback a community bounty's sponsor tracking page
    // silently showed the inflated intake count under the "accepted" label
    // (see api/src/lib/bounty-serialize.ts's BOUNTY_COUNT_FIELDS comment).
    acceptedItems: n(a.finalAcceptedItems ?? a.acceptedItems),
    submittedItems: n(a.submittedItems),
    needsFixesItems: n(a.needsFixesItems),
    rejectedItems: n(a.rejectedItems),
    // Sent by both GET /v1/bounties?mine=true and GET /v1/bounties/:id. The
    // fallback keeps a stale/cached payload honest: sum the buckets we do have
    // rather than reporting 0 submitted while showing non-zero buckets.
    totalSubmittedItems:
      n(a.totalSubmittedItems) ||
      n(a.submittedItems) + n(a.needsFixesItems) + n(a.rejectedItems) + n(a.finalAcceptedItems ?? a.acceptedItems),
    status: a.status as Bounty["status"],
    auditMode: a.auditMode as Bounty["auditMode"],
    license: a.licenseType as Bounty["license"],
    communityLicense: (a.communityLicense as string | null | undefined) ?? null,
    karmaPerAcceptedItem: n(a.karmaPerAcceptedItem),
    deadline: a.deadline ? s(a.deadline) : "",
    requesterNickname: "you",
    mine: true,
    slots,
    // Real per-bounty rates from GET /v1/bounties/:id when present (0 on list
    // payloads that don't compute them).
    duplicateRate: n(a.duplicateRate),
    llmPassRate: n(a.llmPassRate),
    executionPassRate: a.executionPassRate == null ? undefined : n(a.executionPassRate),
    // Real distinct-people counts from GET /v1/bounties/:id when present (0
    // on list payloads that don't compute them — same absent-vs-zero
    // distinction as duplicateRate/llmPassRate above).
    contributorCount: n(a.contributorCount),
    validatorCount: n(a.validatorCount),
    // Owner/admin-only karma distribution from GET /v1/bounties/:id. Absent on
    // list payloads and for non-owners, so it stays optional rather than being
    // zero-filled — 0 released karma and "we didn't tell you" are different facts.
    karma: (a.karma as Bounty["karma"]) ?? undefined,
  };
}
