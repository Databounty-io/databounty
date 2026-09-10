// SPDX-License-Identifier: Apache-2.0

/**
 * Deep-link resolution for a notification row.
 *
 * Ported from v1's `notificationHref` / `absoluteNotificationUrl` in
 * services/notifications.ts, minus every paid surface (`/wallet`,
 * `/sponsor/:id/promote`, the payout/KYC admin pages).
 *
 * Pure: no DB, no transport. Two audiences resolve against two different
 * origins — admin rows belong to the admin console (`config.adminUrl`), every
 * other row to the member app (`config.appUrl`) — so an external channel
 * never mails an admin a dashboard route the dashboard has no page for.
 */
import { config } from "../../config.js";
import { EVENTS, type EventDefinition } from "./events.js";

/** Legacy call sites store `entityType` in PascalCase (`"Submission"`,
 * `"AgentIssue"`); the catalog uses snake_case. Normalise so one switch
 * handles both without every branch listing two spellings. */
function normalizeEntityType(entityType?: string | null): string | null {
  if (!entityType) return null;
  return entityType
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

export function isAdminNotificationType(type: string): boolean {
  return type.startsWith("admin.") || type === "community.request_submitted" || type === "agent_issue.created";
}

export function notificationHref(
  type: string,
  entityType?: string | null,
  entityId?: string | null,
  linkBountyId?: string | null
): string {
  const entity = normalizeEntityType(entityType);
  const record = entityId ? encodeURIComponent(entityId) : null;

  // Admin events are consumed by the admin console, so they resolve to admin
  // routes. Regular members never hold admin.* rows.
  if (isAdminNotificationType(type)) {
    if (type === "community.request_submitted" || type === "community.request_resubmitted" || type === "community.request_disputed") {
      return "/admin/community-requests";
    }
    if (type === "admin.dispute_filed") return "/admin/issues";
    if (type === "admin.validation_job_dead") {
      return record ? `/admin/submissions?id=${record}` : "/admin/submissions";
    }
    if (type === "admin.new_signup") return record ? `/admin/contributors?id=${record}` : "/admin/contributors";
    if (type === "agent_issue.created" || type === "admin.agent_issue_filed" || type === "admin.agent_issue_aging") {
      // `/admin/issues/view?id=` — the admin console has no `[id]` segment
      // under `issues/`, it has a `view/` page reading `?id=`
      // (apps/admin/app/(dashboard)/issues/view/view.tsx:69). The path form
      // used before this 2026-09-02 fix 404'd for every emailed admin alert.
      // V1 links the same shape (`/admin/issues/view?id=`).
      return record ? `/admin/issues/view?id=${encodeURIComponent(record)}` : "/admin/issues";
    }
    if (type === "admin.system_alert" || type === "admin.system_recovered") return "/admin/health";
    if (type === "admin.harness_proof_completed") {
      // Same defect: the console route is `datasets/view?id=`
      // (apps/admin/app/(dashboard)/datasets/view/view.tsx:99). There is no
      // `/admin/dataset-types` page at all.
      return record ? `/admin/datasets/view?id=${encodeURIComponent(record)}` : "/admin/datasets";
    }
    return "/admin";
  }

  // Publication events land where the published-dataset surface actually is.
  if (type === "community.bounty_published") return "/community";
  if (type === "community.publish_bonus_awarded") return "/karma";

  // The same entity type lands on a different surface depending on WHO the
  // event is for (an audit is the validator's queue but the requester's
  // dataset page), so route by the event's audience category first and fall
  // back to entity-only routing for uncatalogued rows.
  const category = (EVENTS as Record<string, EventDefinition | undefined>)[type]?.category;
  const bountyId = entity === "bounty" ? entityId : linkBountyId;
  const bountyWork = bountyId ? `/contributor?bounty=${encodeURIComponent(bountyId)}` : "/contributor";

  switch (category) {
    case "contributor":
      if (entity === "submission" && record) return `/contributor/submissions/${record}`;
      if (entity === "karma_event" || entity === "badge" || entity === "rank") return "/karma";
      return bountyWork;
    case "validator":
      if (entity === "audit" && record) return `/validator/audit/${record}`;
      if (entity === "submission" && record) return `/validator?submission=${record}`;
      return "/validator";
    case "sponsor":
      // The member app has no `/community/requests/:id`; the page is
      // `/sponsor/requests/[id]` (apps/web/app/(app)/sponsor/requests/[id]).
      // Every emailed dataset-request notification — status changed,
      // implemented, declined, changes requested, comment added — landed on a
      // 404 before this 2026-09-02 fix.
      if (entity === "dataset_request")
        return record ? `/sponsor/requests/${encodeURIComponent(record)}` : "/community";
      if (entity === "dataset_type") return "/community";
      if (entity === "bounty" && record) return `/sponsor/${record}`;
      if (entity === "submission" && record) return linkBountyId ? `/sponsor/${encodeURIComponent(linkBountyId)}` : "/sponsor";
      return linkBountyId ? `/sponsor/${encodeURIComponent(linkBountyId)}` : "/sponsor";
    case "account":
      if (entity === "profile" || entity === "rank") return "/profile";
      if (entity === "agent_issue") return record ? `/issues/${record}` : "/issues";
      // Channel confirmations are managed on this page — an honest self-link.
      return "/notifications";
    default:
      break;
  }

  // Uncatalogued types: best effort by entity type alone.
  if (entity === "submission" && record) return `/contributor/submissions/${record}`;
  if (entity === "batch") return bountyWork;
  if (entity === "bounty" && record) return `/sponsor/${record}`;
  if (entity === "audit" && record) return `/validator/audit/${record}`;
  if (entity === "dataset_request")
    return record ? `/sponsor/requests/${encodeURIComponent(record)}` : "/community";
  if (entity === "profile" || entity === "rank") return "/profile";
  if (entity === "agent_issue") return record ? `/issues/${record}` : "/issues";
  return "/notifications";
}

/**
 * The same destination as an ABSOLUTE url, for the channels that leave the app
 * (email, Telegram, Slack, Discord, Teams, Google Chat).
 *
 * The origin is chosen by namespace, not assumed: an `/admin/...` href belongs
 * to the admin console, which is a different host, and the console serves its
 * pages without the `/admin` prefix — so the prefix comes off here too.
 */
export function absoluteNotificationUrl(
  type: string,
  entityType?: string | null,
  entityId?: string | null,
  linkBountyId?: string | null
): string {
  const href = notificationHref(type, entityType, entityId, linkBountyId);
  const isAdmin = href === "/admin" || href.startsWith("/admin/");
  const origin = (isAdmin ? config.adminUrl : config.appUrl).replace(/\/+$/, "");
  return `${origin}${isAdmin ? href.slice("/admin".length) || "/" : href}`;
}
