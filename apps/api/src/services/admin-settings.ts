// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { writeAuditLog } from "../lib/audit-log.js";
import { CATEGORY_PRICING_SEED } from "../lib/karma-category-scores.js";
import type { Prisma } from "@prisma/client";

export interface AdminSettingCatalogEntry {
  key: string;
  description: string;
  defaultValue: unknown;
  /** Per-key value schema. Enforced on WRITE only (see
   * `validateAdminSettingValue` / `PUT /v1/admin/settings/:key`) — never on
   * read. A row stored before this schema existed keeps being served by
   * `getAdminSetting` exactly as it is; the first attempt to re-save it
   * through the console is what fails, loudly, with the reason. Validating on
   * read instead would mean a stale row silently reverting to the default
   * while the console still displayed the stored value — the same class of
   * lie this catalog exists to remove. */
  schema: z.ZodTypeAny;
}

/** What `GET /v1/admin/settings` puts on the wire. The Zod schema is a live
 * object with no meaningful JSON form (it serializes to `{}`), so it is
 * stripped at the boundary rather than shipped as a misleading empty object. */
export interface AdminSettingCatalogWireEntry {
  key: string;
  description: string;
  defaultValue: unknown;
}

const positiveInt = (max: number) => z.number().int().positive().max(max);

/** "HH:mm", 24-hour. Matches the regex `services/notifications.ts` accepts. */
const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "must be HH:mm in 24-hour time");

const ianaTimeZone = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "must be a valid IANA time zone");

/** One karma tier row. Field-for-field the shape of `KARMA_TIERS` in
 * `services/karma.ts` — deliberately NOT imported from there: that module is
 * about to read this setting back, and an import in both directions would be a
 * cycle. The `.length(4)` + distinct-id refine is what keeps the two in step. */
const karmaTierRow = z.object({
  tier: z.enum(["dharma", "bodhi", "moksha", "nirvana"]),
  label: z.string().trim().min(1).max(40),
  minKarma: z.number().int().min(0).max(100_000_000),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "must be a 6-digit hex color"),
  blurb: z.string().trim().min(1).max(240),
  perks: z.array(z.string().trim().min(1).max(200)).min(1).max(12),
  earlyAccessHours: z.number().int().min(0).max(720),
  concurrencyBonus: z.number().int().min(0).max(20),
});

const karmaTiersSchema = z
  .array(karmaTierRow)
  .length(4)
  .refine((tiers) => new Set(tiers.map((t) => t.tier)).size === 4, "all four tiers (dharma/bodhi/moksha/nirvana) must be present")
  .refine(
    (tiers) => tiers.every((t, i) => i === 0 || t.minKarma > tiers[i - 1]!.minKarma),
    "tiers must be listed in strictly ascending minKarma order"
  )
  .refine((tiers) => tiers[0]!.minKarma === 0, "the first tier must start at minKarma 0 so every balance maps to a tier");

const karmaRulesSchema = z
  .object({
    acceptedItem: z.object({
      beginner: positiveInt(10_000),
      intermediate: positiveInt(10_000),
      advanced: positiveInt(10_000),
    }),
    auditItem: positiveInt(10_000),
    confirmedFlag: positiveInt(10_000),
    requestApproved: positiveInt(10_000),
    publishBonus: positiveInt(10_000),
    bountyPublished: positiveInt(10_000),
  })
  // A validator's per-item audit rate must stay below a contributor's per-item
  // rate at every difficulty, so routine auditing never out-earns routine
  // contributing on the same volume. Rejected on save (400, visible) rather
  // than silently corrected at read time.
  .refine(
    (rules) =>
      rules.auditItem <
      Math.min(rules.acceptedItem.beginner, rules.acceptedItem.intermediate, rules.acceptedItem.advanced),
    { message: "auditItem must be lower than every acceptedItem rate (beginner/intermediate/advanced)", path: ["auditItem"] }
  );

/** Per-category pricing inputs, keyed on the registry `datasetType` id. An
 * entry is REQUIRED to be complete: a category present with a missing axis
 * would be an unpriced category masquerading as a priced one, which must fail
 * closed at mint rather than default to a middle score. Categories absent from
 * the map stay deliberately unpriced (see `lib/karma-category-scores.ts`). */
const karmaMatrixSchema = z
  .record(
    z.string().trim().min(1).max(80),
    z.object({
      complexityScore: z.number().int().min(1).max(4),
      verificationUnits: z.number().int().min(0).max(64),
    })
  )
  .refine((map) => Object.keys(map).length > 0, "the pricing matrix must score at least one category");

/** The full catalog of admin-configurable business rules: key, human
 * description, and default value. This is the single source of truth for
 * both `getAdminSetting`'s fallback and the `/settings` admin-console page,
 * which renders one card per entry (grouped by dot-prefix namespace) — a new
 * key added here appears there automatically, no frontend change required. */
export const SETTINGS_CATALOG: AdminSettingCatalogEntry[] = [
  /* ---------------------------------------------------------------- community */
  {
    key: "community.dispute_window_hours",
    description: "Hours a contributor has to dispute a rejected/flagged submission before it becomes final.",
    schema: positiveInt(24 * 365),
    defaultValue: 48,
  },
  {
    key: "community.karma_holds.enabled",
    description:
      "Hold an accepted item's karma in PendingKarmaAward through the dispute window instead of awarding it " +
      "immediately. Holding means the karma is provisional and invisible on the balance/leaderboard until the " +
      "window passes undisputed; an upheld dispute during the window then simply declines to release it instead " +
      "of needing a claw-back. Defaults on because immediate-award bypasses the dispute window entirely.",
    schema: z.boolean(),
    defaultValue: true,
  },
  {
    key: "community.human_audit_window_size",
    description: "How many submissions one human-audit window holds — the batch a validator claims. 50–100 (owner requirement).",
    schema: z.number().int().min(50).max(100),
    defaultValue: 50,
  },
  {
    key: "community.human_audit_failure_threshold_pct",
    description:
      "Percent of a human-audit window's selected items that must be rejected for the whole window to fail. " +
      "Platform-wide fallback for a bounty that carries no `humanAuditFailureThresholdPct` of its own.",
    schema: z.number().int().min(0).max(100),
    defaultValue: 20,
  },
  {
    key: "community.min_karma_to_request",
    description: "Minimum karma total a member needs before they can file a new community dataset request. 0 disables the gate.",
    schema: z.number().int().min(0).max(100_000_000),
    defaultValue: 50,
  },
  {
    key: "community.leaderboard.page_size",
    description:
      "Default page size for GET /v1/community/leaderboard when the caller sends no `limit`. An explicit " +
      "`limit` still wins, and both are capped by community.leaderboard.max_page_size.",
    schema: z.number().int().min(1).max(500),
    defaultValue: 50,
  },
  {
    key: "community.leaderboard.max_page_size",
    description:
      "Hard ceiling on rows one leaderboard request may return, applied to the caller's `limit` as well as " +
      "to the default above, so a settings typo cannot turn one public request into an unbounded scan.",
    schema: z.number().int().min(1).max(500),
    defaultValue: 100,
  },

  /* -------------------------------------------------------------------- auth */
  {
    key: "auth.email_verification.ttl_hours",
    description: "Hours an email-verification link stays valid after being sent.",
    schema: positiveInt(720),
    defaultValue: 24,
  },

  /* ----------------------------------------------------------- notifications
   * These five delivery/digest keys are the ones `services/notifications.ts`
   * (getNotificationRuntimeSettings) actually live-reads. They were missing
   * from the catalog, so the console never rendered them and an operator
   * editing "digest schedule" was editing a key nothing consumed. The
   * defaults below are exactly DEFAULT_NOTIFICATION_SETTINGS, and each bound
   * matches that file's own clamp so a value the console accepts can never be
   * one the reader silently discards. */
  {
    key: "notifications.digest.enabled",
    description: "Whether the periodic notification digest email is sent at all.",
    schema: z.boolean(),
    defaultValue: true,
  },
  {
    key: "notifications.delivery.max_attempts",
    description: "How many times a notification delivery is retried before it is parked in the dead-letter state.",
    schema: z.number().int().min(1).max(20),
    defaultValue: 8,
  },
  {
    key: "notifications.delivery.lease_seconds",
    description: "Seconds a dispatch worker holds an exclusive lease on a queued notification before it is redeliverable.",
    schema: z.number().int().min(1).max(3_600),
    defaultValue: 60,
  },
  {
    key: "notifications.delivery.backoff_seconds",
    description: "Retry backoff ladder, in seconds — attempt N waits for the Nth entry, and the last entry repeats.",
    schema: z.array(positiveInt(86_400)).min(1).max(20),
    defaultValue: [30, 60, 300, 900, 3_600, 10_800, 21_600],
  },
  {
    key: "notifications.digest.time",
    description: "Local 24-hour clock time (HH:mm, in notifications.digest.timezone) the daily digest is flushed.",
    schema: clockTime,
    defaultValue: "09:00",
  },
  {
    key: "notifications.digest.timezone",
    description: "IANA time zone that notifications.digest.time is interpreted in.",
    schema: ianaTimeZone,
    defaultValue: "UTC",
  },

  /* ------------------------------------------------------------------ launch */
  {
    key: "launch.community.enabled",
    description: "Master switch for community karma activity (session-connect CTAs, claiming, submitting). Off keeps the product in browse-only mode.",
    schema: z.boolean(),
    defaultValue: false,
  },
  {
    key: "launch.dashboard_submissions.enabled",
    description: "Whether dataset items may be submitted from the dashboard UI itself, as opposed to only through the API/MCP.",
    schema: z.boolean(),
    defaultValue: false,
  },
  {
    key: "launch.community_requests.enabled",
    description: "Controls authenticated submission of community dataset requests. Disabled must reject new requests server-side, not merely hide the form.",
    schema: z.boolean(),
    defaultValue: false,
  },
  {
    key: "launch.api_submissions.enabled",
    description: "Controls submitting dataset items with a direct API-key call rather than through the dashboard. Disabled must reject those submits server-side.",
    schema: z.boolean(),
    defaultValue: false,
  },
  {
    key: "launch.public_profiles.enabled",
    description: "Controls anonymous public-profile reads. Disabled must return the same not-found response as an unknown handle.",
    schema: z.boolean(),
    defaultValue: false,
  },

  /* -------------------------------------------------------------- reputation */
  {
    key: "reputation.score.base",
    description: "Base reputation score every member starts with before any verified-credential bonus.",
    schema: z.number().int().min(0).max(100),
    defaultValue: 52,
  },
  {
    key: "reputation.score.per_verified_credential",
    description: "Reputation score points added per verified credential source, up to the 100-point cap.",
    schema: z.number().int().min(0).max(50),
    defaultValue: 12,
  },

  /* ------------------------------------------------------------------- karma
   * Defaults transcribed from the constants that are currently hardcoded in
   * `services/karma.ts` (KARMA_TIERS, KARMA_RULES) and the seed table in
   * `lib/karma-category-scores.ts`. Defining them here does not by itself
   * change behaviour: until karma.ts reads these keys, they are published
   * configuration nothing consumes. The defaults are byte-equal to the
   * constants so the read landing later is a no-op on a fresh environment. */
  {
    key: "karma.tiers",
    description:
      "Karma tier ladder, ascending by minKarma: tier id, label, karma threshold, accent colour, blurb, " +
      "perk list, early-access hours ahead of general release, and concurrent-claim bonus. Exactly four " +
      "tiers (dharma/bodhi/moksha/nirvana); the first must start at 0 so every balance maps to a tier.",
    schema: karmaTiersSchema,
    defaultValue: [
      {
        tier: "dharma",
        label: "Dharma",
        minKarma: 0,
        color: "#8a9382",
        blurb: "The path is taken. Every accepted item carries the contributor's name.",
        perks: ["Leaderboard listing", "Tier badge on profile", "Named credit on published dataset cards you contributed to"],
        earlyAccessHours: 0,
        concurrencyBonus: 0,
      },
      {
        tier: "bodhi",
        label: "Bodhi",
        minKarma: 5_000,
        color: "#d4a24e",
        blurb: "Awakening. The platform sees you before the crowd.",
        perks: ["Everything in Dharma", "24h early access to new community dataset pools", "Batch sizes up to 25 items"],
        earlyAccessHours: 24,
        concurrencyBonus: 1,
      },
      {
        tier: "moksha",
        label: "Moksha",
        minKarma: 50_000,
        color: "#b6ff1c",
        blurb: "Liberation. Work recognized across domains.",
        perks: ["Everything in Bodhi", "48h early access", "Claim priority queue", "Validator qualification fast-track"],
        earlyAccessHours: 48,
        concurrencyBonus: 2,
      },
      {
        tier: "nirvana",
        label: "Nirvana",
        minKarma: 500_000,
        color: "#b9a6f2",
        blurb: "The summit. Direct invites to featured dataset programs.",
        perks: ["Everything in Moksha", "72h first look", "Direct invites to featured dataset programs"],
        earlyAccessHours: 72,
        concurrencyBonus: 3,
      },
    ],
  },
  {
    key: "karma.rules",
    description:
      "Flat karma award rates: per accepted item by difficulty, per audited item, per confirmed flag, per " +
      "approved dataset request, the top-contributor publication bonus, and the per-bounty publication award. " +
      "`auditItem` must stay below every `acceptedItem` rate so routine auditing never out-earns routine contributing.",
    schema: karmaRulesSchema,
    defaultValue: {
      acceptedItem: { beginner: 10, intermediate: 25, advanced: 60 },
      auditItem: 8,
      confirmedFlag: 25,
      requestApproved: 25,
      publishBonus: 150,
      bountyPublished: 50,
    },
  },
  {
    key: "karma.matrix",
    description:
      "Per-category karma pricing inputs, keyed on the registry dataset-type id: `complexityScore` (1-4, what " +
      "it takes to verify an item is correct) and `verificationUnits` (template fields that undergo machine-run " +
      "verification). A category absent from this map is deliberately UNPRICED and must fail closed at mint " +
      "rather than default to a middle score — never add a partial row to make a mint go through.",
    schema: karmaMatrixSchema,
    defaultValue: CATEGORY_PRICING_SEED,
  },

  /* -------------------------------------------------------------- validation */
  {
    key: "validation.dedupe.reject_threshold",
    description:
      "Duplicate score at or above which a submission is a near-certain duplicate and is auto-rejected by the " +
      "dedupe stage, no human needed. Must stay above validation.dedupe.review_threshold. Scores are 0-1; a " +
      "submission with no computed score is never rejected on this axis.",
    schema: z.number().min(0).max(1),
    defaultValue: 0.9,
  },
  {
    key: "validation.dedupe.review_threshold",
    description:
      "Duplicate score at or above which a submission is a probabilistic near-dup signal — flagged for a human " +
      "to confirm rather than auto-rejected, since similarity systems can false-positive on legitimately " +
      "similar-but-distinct content (e.g. two independent FizzBuzz solutions) and auto-rejecting them destroys " +
      "valid work. Must stay below validation.dedupe.reject_threshold. Scores are 0-1.",
    schema: z.number().min(0).max(1),
    defaultValue: 0.8,
  },
  {
    key: "validation.llm.enabled",
    description:
      "Controls the LLM submission-review stage platform-wide. Off by default: deterministic checks and human " +
      "validator audit are the real verification gate. While off, submissions must skip the stage entirely and " +
      "record no LLM score or claim — never a fabricated pass.",
    schema: z.boolean(),
    defaultValue: false,
  },

  /* ------------------------------------------------------------- submissions */
  {
    key: "submissions.max_revisions",
    description:
      "Maximum revision attempts a contributor's submission may take before final rejection. 0 means unlimited — " +
      "an explicit operator choice, not the default: an unbounded revision loop is free-labour extraction and an " +
      "agentic attack surface.",
    schema: z.number().int().min(0).max(1_000),
    defaultValue: 3,
  },
  {
    key: "submissions.max_items_per_request",
    description:
      "Absolute ceiling for one submission request. The pool-specific inline limit is the lower bulk threshold, " +
      "so larger sets must use the browser upload-and-review flow rather than holding one long database transaction.",
    schema: z.number().int().min(1).max(100),
    defaultValue: 100,
  },
  {
    key: "submissions.mcp_bulk_threshold_items",
    description:
      "Live community-pool inline limit. Above this count MCP must create a browser upload-and-review handoff; " +
      "the browser parses and lets the contributor review the rows before submission.",
    schema: z.number().int().min(1).max(100),
    defaultValue: 20,
  },

  /* ---------------------------------------------------------------- artifacts */
  {
    key: "artifacts.malware_scan.enabled",
    description:
      "Master switch for malware/AV scanning of uploaded files — the only control, there is no env override. " +
      "Off by default: uploads are NOT scanned and are recorded and shown as `not_required`, never `clean` or " +
      "passed, so the trust claim stays honest while malicious files can still reach validators. Turn on to " +
      "require every upload to pass the configured scanner (ARTIFACT_SCAN_URL). IMPORTANT — turning this on WITHOUT a " +
      "scanner endpoint now fails closed (SEC-08, 2026-09-05): nothing is scanned, the scan job records " +
      "`scanStatus = error`, the artifact stays in `scanning` and is NOT downloadable until an endpoint is configured " +
      "or this switch is turned back off. Evidence stays honest either way: an unscanned file is never recorded " +
      "`clean` or passed. Owner decision 2026-09-05: the scanner is optional and OFF by default in every environment, " +
      "production included — an absent row is read as off, never as an unknown policy.",
    schema: z.boolean(),
    defaultValue: false,
  },

  /* --------------------------------------------------------------- ratelimit */
  {
    key: "ratelimit.global.max",
    description:
      "Requests one client may make per global rate-limit window before receiving 429s. Read once at " +
      "process boot (`app.ts`) when the @fastify/rate-limit plugin is registered — a saved change takes " +
      "effect on the next restart/deploy, not immediately, since checking this on every single request " +
      "would mean an uncached database read on the one hook whose job is to shed load.",
    schema: positiveInt(1_000_000),
    defaultValue: 300,
  },
  {
    key: "ratelimit.global.window_seconds",
    description:
      "Length of the global rate-limit window, in seconds. Same boot-time-only caveat as " +
      "`ratelimit.global.max` — see that entry.",
    schema: positiveInt(86_400),
    defaultValue: 60,
  },
];

const CATALOG_BY_KEY = new Map(SETTINGS_CATALOG.map((entry) => [entry.key, entry]));

/**
 * Validate a candidate value for `key` against the catalog.
 *
 * Two distinct failures, both rejected:
 *  - the key is not in the catalog at all. Unlike v1 (which passes unknown
 *    keys through), an unknown key is refused here: the catalog is the single
 *    source of truth for what a setting IS, and a typo'd key silently
 *    persisting a row nothing reads is exactly the class of dead-config
 *    defect this catalog exists to prevent.
 *  - the value fails that key's schema.
 *
 * Write-path only. Values already stored are never re-validated on read (see
 * `AdminSettingCatalogEntry.schema`).
 */
export function validateAdminSettingValue(
  key: string,
  value: unknown
): { ok: true; value: unknown } | { ok: false; reason: "unknown_key" | "invalid_value"; message: string } {
  const entry = CATALOG_BY_KEY.get(key);
  if (!entry) {
    return { ok: false, reason: "unknown_key", message: `Unknown setting key "${key}". Settings must exist in the catalog before they can be set.` };
  }
  const parsed = entry.schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return { ok: false, reason: "invalid_value", message: `Invalid value for ${key}: ${path}${issue?.message ?? "invalid setting"}` };
  }
  return { ok: true, value: parsed.data };
}

/** Back-compat flat key->defaultValue map, derived from the catalog above.
 * Used internally by `getAdminSetting`'s fallback path. */
export const DEFAULT_SETTINGS: Record<string, unknown> = Object.fromEntries(
  SETTINGS_CATALOG.map((entry) => [entry.key, entry.defaultValue])
);

export async function getAdminSetting<T = unknown>(key: string, defaultValue?: T): Promise<T> {
  const row = await prisma.adminSetting.findUnique({ where: { key } });
  if (row) {
    return row.value as T;
  }
  if (defaultValue !== undefined) return defaultValue;
  return (DEFAULT_SETTINGS[key] as T) ?? (null as unknown as T);
}

export const LLM_VALIDATION_ENABLED_KEY = "validation.llm.enabled";

/**
 * Platform switch for the LLM submission-review stage — the ONE reader of
 * `validation.llm.enabled`. Every surface that claims to know whether machine
 * quality review is on must call this rather than inferring it from provider
 * env presence (`openRouterConfigured()`) or hardcoding an answer: the two are
 * independent facts, and three call sites previously disagreed with each other
 * and with the published setting.
 *
 * FAILS CLOSED to `false`, matching v1's
 * `services/validation-pipeline.ts:llmValidationEnabled()`:
 *  - a stored non-boolean value (a hand-edited row, a pre-catalog write) is
 *    not coerced — an unreadable switch is an off switch;
 *  - a settings-store outage resolves to off, never to a fabricated "on".
 *
 * `false` here means the stage must be SKIPPED ENTIRELY (no ValidationResult
 * row, no score, no claim) — never a fabricated pass. The deterministic checks
 * (dedupe, AI attribution, execution) and the human validator audit remain the
 * real verification gate regardless of this setting.
 *
 * This is the FLAG ALONE. It deliberately says nothing about whether a
 * provider is configured — a caller that needs the combined "will a real model
 * actually score this item" answer must read `openRouterConfigured()`
 * (services/llm-client.ts) as a second, separately-named fact, so flag-off and
 * flag-on-but-unconfigured stay distinguishable on the wire.
 */
export async function llmValidationEnabled(): Promise<boolean> {
  try {
    const value = await getAdminSetting<unknown>(LLM_VALIDATION_ENABLED_KEY, false);
    return value === true;
  } catch {
    return false;
  }
}

export async function setAdminSetting(params: {
  key: string;
  value: unknown;
  updatedByUserId: string;
  context?: { ip?: string; userAgent?: string };
}): Promise<{ key: string; value: unknown }> {
  const existing = await prisma.adminSetting.findUnique({ where: { key: params.key } });
  const oldValue = existing?.value ?? null;

  const result = await prisma.$transaction(async (tx) => {
    const row = await tx.adminSetting.upsert({
      where: { key: params.key },
      create: {
        key: params.key,
        value: params.value as Prisma.InputJsonValue,
        updatedBy: params.updatedByUserId,
      },
      update: {
        value: params.value as Prisma.InputJsonValue,
        updatedBy: params.updatedByUserId,
      },
    });

    await tx.adminSettingHistory.create({
      data: {
        key: params.key,
        oldValue: oldValue !== null ? (oldValue as Prisma.InputJsonValue) : undefined,
        newValue: params.value as Prisma.InputJsonValue,
        action: existing ? "update" : "create",
        changedBy: params.updatedByUserId,
      },
    });

    await writeAuditLog(tx, {
      actorUserId: params.updatedByUserId,
      action: "admin.setting.updated",
      targetType: "AdminSetting",
      targetId: params.key,
      before: oldValue,
      after: params.value,
      ip: params.context?.ip,
      userAgent: params.context?.userAgent,
    });

    return row;
  });

  return { key: result.key, value: result.value };
}

/** Internal object-shaped view (key -> live-or-default value), kept for any
 * caller that wants the flattened form. Not what the `/settings` HTTP route
 * returns — see `listAdminSettingsForApi` below for the array shape the
 * admin console's `PlatformSettingsSection` actually renders. */
export async function listAdminSettings(): Promise<Record<string, unknown>> {
  const rows = await prisma.adminSetting.findMany();
  const result: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    result[r.key] = r.value;
  }
  return result;
}

/** Wire shape for `GET /v1/admin/settings`: `settings` is the array of
 * {key, value} rows the console's editor `.map()`s over (only overridden
 * keys plus catalog defaults for anything never saved), and `catalog` is the
 * full descriptive schema (key/description/defaultValue) that drives the
 * editor's widget-per-key rendering and namespace grouping. */
export async function listAdminSettingsForApi(): Promise<{
  settings: Array<{ key: string; value: unknown }>;
  catalog: AdminSettingCatalogWireEntry[];
}> {
  const flat = await listAdminSettings();
  const settings = Object.entries(flat).map(([key, value]) => ({ key, value }));
  const catalog = SETTINGS_CATALOG.map(({ key, description, defaultValue }) => ({ key, description, defaultValue }));
  return { settings, catalog };
}

export async function getAdminSettingHistory(params?: {
  key?: string;
  limit?: number;
  offset?: number;
}) {
  const take = Math.min(params?.limit ?? 50, 100);
  const skip = params?.offset ?? 0;
  const where = params?.key ? { key: params.key } : {};

  const [items, total] = await Promise.all([
    prisma.adminSettingHistory.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      skip,
    }),
    prisma.adminSettingHistory.count({ where }),
  ]);

  return { items, total, limit: take, offset: skip };
}
