// SPDX-License-Identifier: Apache-2.0

/**
 * Daily digest payload construction — the one place that turns a day's
 * buffered `digesting` notification rows into the structured summary the
 * email/chat adapters render.
 *
 * Ported from v1's services/notifications/digest.ts. The v1 version also
 * embedded `digest-stats.ts` "platform pulse" / "momentum" blocks; those are
 * NOT ported — several of their stat groups are money figures (escrow held,
 * payouts released), and porting the shape without those numbers would leave
 * an empty section that looks like a broken feature. The section/count/link
 * structure below is the part that carries the actual information.
 *
 * Pure: no DB, no transport. `href` resolution is injected so this module
 * never imports the notification service (cycle-free).
 */
import { config } from "../../config.js";
import { EVENTS, type EventCategory, type EventDefinition } from "./events.js";
import { isAdminNotificationType } from "./href.js";

/** Max lines rendered per section. Beyond this the section shows an
 * "+N more" tail — the count stays truthful even when the list is trimmed. */
export const DIGEST_ITEMS_PER_SECTION = 6;
/** Max lines across the whole digest, so a 500-event day cannot produce a
 * multi-megabyte email. */
export const DIGEST_MAX_ITEMS = 24;

export type DigestSectionKey = EventCategory | "other";

export interface DigestItem {
  title: string;
  body: string;
  /** Absolute deep link — admin rows point at the admin console origin. */
  href: string;
  /** ISO timestamp. */
  at: string;
}

export interface DigestSection {
  key: DigestSectionKey;
  label: string;
  /** True count of rows in this section, independent of how many are listed. */
  count: number;
  items: DigestItem[];
  href: string;
}

export interface DigestPayload {
  version: 1;
  /** Total rows collapsed into this digest — always equals the sum of section
   * counts, so the headline can never disagree with the sections. */
  total: number;
  /** Local calendar day the digest covers, e.g. "2026-08-31". */
  day: string;
  timeZone: string;
  sections: DigestSection[];
  primary: { label: string; href: string };
}

/** Section order = descending "needs your attention". */
const SECTION_ORDER: DigestSectionKey[] = ["admin", "account", "sponsor", "validator", "contributor", "other"];

const SECTION_LABELS: Record<DigestSectionKey, string> = {
  admin: "Admin console",
  account: "Your account",
  sponsor: "Your datasets",
  validator: "Validation queue",
  contributor: "Your work",
  other: "Other updates",
};

const SECTION_PATHS: Record<DigestSectionKey, string> = {
  admin: "/admin",
  account: "/notifications",
  sponsor: "/sponsor",
  validator: "/validator",
  contributor: "/contributor",
  other: "/notifications",
};

export interface DigestSourceRow {
  type: string;
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  linkBountyId: string | null;
  createdAt: Date;
}

export function sectionFor(type: string): DigestSectionKey {
  if (isAdminNotificationType(type)) return "admin";
  const category = (EVENTS as Record<string, EventDefinition | undefined>)[type]?.category;
  return category ?? "other";
}

function origin(section: DigestSectionKey): string {
  return (section === "admin" ? config.adminUrl : config.appUrl).replace(/\/+$/, "");
}

/** Admin section paths are served by the console without the `/admin` prefix
 * (same rule as absoluteNotificationUrl). */
function absolute(section: DigestSectionKey, path: string): string {
  if (section !== "admin") return `${origin(section)}${path}`;
  const stripped = path === "/admin" || path.startsWith("/admin/") ? path.slice("/admin".length) || "/" : path;
  return `${origin(section)}${stripped}`;
}

/**
 * Build the structured digest for one user's buffered rows.
 *
 * `resolveHref` is injected (the flusher passes `notificationHref`) purely to
 * keep this module free of a cycle back into the notification service; it
 * returns a path and this function prefixes the audience-correct origin.
 */
export function buildDigestPayload(
  rows: DigestSourceRow[],
  resolveHref: (
    type: string,
    entityType?: string | null,
    entityId?: string | null,
    linkBountyId?: string | null
  ) => string,
  day: string,
  timeZone: string
): DigestPayload {
  const buckets = new Map<DigestSectionKey, DigestSourceRow[]>();
  for (const row of rows) {
    const key = sectionFor(row.type);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }

  let budget = DIGEST_MAX_ITEMS;
  const sections: DigestSection[] = [];
  for (const key of SECTION_ORDER) {
    const bucket = buckets.get(key);
    if (!bucket || bucket.length === 0) continue;
    // Newest first: on a trimmed section the lines a reader actually sees are
    // the most recent ones.
    const ordered = [...bucket].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    // Charge the budget for lines actually rendered, NOT for the per-section
    // cap — otherwise four small sections exhaust DIGEST_MAX_ITEMS and every
    // later section renders as a bare "+N more" with nothing above it.
    const take = Math.max(0, Math.min(DIGEST_ITEMS_PER_SECTION, budget, ordered.length));
    budget -= take;
    sections.push({
      key,
      label: SECTION_LABELS[key],
      count: bucket.length,
      href: absolute(key, SECTION_PATHS[key]),
      items: ordered.slice(0, take).map((row) => ({
        title: row.title,
        body: row.body,
        href: absolute(key, resolveHref(row.type, row.entityType, row.entityId, row.linkBountyId)),
        at: row.createdAt.toISOString(),
      })),
    });
  }

  const adminOnly = sections.length > 0 && sections.every((s) => s.key === "admin");
  return {
    version: 1,
    total: rows.length,
    day,
    timeZone,
    sections,
    primary: adminOnly
      ? { label: "Open admin console", href: absolute("admin", "/admin") }
      : { label: "Open DataBounty", href: absolute("account", "/notifications") },
  };
}

/** Subject line / in-app title. Leads with the count because that is the one
 * thing a reader decides on before opening. */
export function digestTitle(payload: DigestPayload): string {
  return payload.total === 1 ? "1 update from DataBounty" : `${payload.total} updates from DataBounty`;
}

/**
 * Plain-text body — the in-app feed row and every chat channel render this.
 * Grouped with per-section counts so the text version carries the same
 * information as the email, not a flat list of titles.
 */
export function digestText(payload: DigestPayload): string {
  const blocks = payload.sections.map((section) => {
    const lines = section.items.map((item) => `• ${item.title}`);
    const hidden = section.count - section.items.length;
    if (hidden > 0) lines.push(`• +${hidden} more`);
    return [`${section.label} (${section.count})`, ...lines].join("\n");
  });
  return blocks.join("\n\n");
}

/** Render the digest as HTML for the email adapter. Chat channels use
 * `digestText` — none of the six webhook/bot transports render HTML.
 *
 * `unsubscribeUrl` is the signed capability link from
 * lib/digest-unsubscribe-token.ts. It is appended as a visible footer only on
 * the email transport, because a chat webhook is not a mailing list and its
 * "unsubscribe" is disconnecting the channel. When omitted (any non-email
 * caller) no footer is rendered — the digest never claims an unsubscribe
 * affordance it does not have. */
export function digestHtml(payload: DigestPayload, unsubscribeUrl?: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const sections = payload.sections
    .map((section) => {
      const items = section.items
        .map(
          (item) =>
            `<li style="margin:0 0 8px 0"><a href="${esc(item.href)}" style="color:#1a5cff;text-decoration:none">${esc(item.title)}</a>` +
            (item.body ? `<br><span style="color:#555;font-size:13px">${esc(item.body)}</span>` : "") +
            `</li>`
        )
        .join("");
      const hidden = section.count - section.items.length;
      const more = hidden > 0 ? `<li style="color:#777">+${hidden} more</li>` : "";
      return (
        `<h3 style="margin:20px 0 8px 0;font-size:15px">` +
        `<a href="${esc(section.href)}" style="color:#111;text-decoration:none">${esc(section.label)}</a> ` +
        `<span style="color:#777;font-weight:normal">(${section.count})</span></h3>` +
        `<ul style="margin:0;padding-left:18px">${items}${more}</ul>`
      );
    })
    .join("");
  const footer = unsubscribeUrl
    ? `<p style="margin:18px 0 0;color:#8a8f83;font-size:11px;line-height:1.45">You received this because routine notification digests are enabled for your DataBounty account. <a href="${esc(unsubscribeUrl)}" style="color:#5c6354;text-decoration:underline">Unsubscribe from digest emails</a>. Security, verification and deadline messages are not affected.</p>`
    : "";
  return (
    `<p style="margin:0 0 4px 0;font-size:14px;color:#555">${esc(payload.day)} · ${esc(payload.timeZone)}</p>` +
    sections +
    `<p style="margin:24px 0 0 0"><a href="${esc(payload.primary.href)}" style="color:#1a5cff">${esc(payload.primary.label)}</a></p>` +
    footer
  );
}

/**
 * Read back the structured digest payload stored on a `digest.summary` row.
 *
 * Validated rather than cast: the column is nullable and rows written by an
 * older API version (or a future `version: 2`) carry a shape this build cannot
 * render. Returning `undefined` is the honest fallback — the adapter then
 * renders the plain-text `body`, which is always populated, rather than
 * throwing mid-dispatch and dead-lettering a deliverable notification.
 */
export function digestPayloadFor(row: { type: string; data: unknown }): DigestPayload | undefined {
  if (row.type !== "digest.summary" || !row.data || typeof row.data !== "object" || Array.isArray(row.data)) {
    return undefined;
  }
  const candidate = row.data as DigestPayload;
  if (candidate.version !== 1 || !Array.isArray(candidate.sections) || !candidate.primary) return undefined;
  return candidate;
}
