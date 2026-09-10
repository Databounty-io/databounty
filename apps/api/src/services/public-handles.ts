// SPDX-License-Identifier: Apache-2.0

/**
 * Public-handle normalization, reserved names, and suggestion generation.
 *
 * Ported from V1 (`databounty-api/src/services/public-profiles.ts`) to close a
 * parity gap: `apps/web` was ported faithfully and calls
 * `/v1/me/public-profile/handle-availability`, `…/handle-suggestions` and
 * `…/handle`, but this API had only a weaker `/v1/me/handle/availability` +
 * `/v1/me/handle/claim` pair at different paths. Every one of those client
 * calls 404'd, which left the claim button permanently disabled and made
 * onboarding step 1 impossible to complete in the UI.
 *
 * V1's rules are reproduced exactly rather than re-invented, because the rules
 * ARE the parity surface — a handle is claimed once and becomes the member's
 * permanent public profile URL and the name their dataset credit is attributed
 * to. What this API had before diverged on four counts: it allowed 30
 * characters (V1: 20), permitted underscores and rejected hyphens (V1 is the
 * exact inverse), had no `--` guard, and had no reserved-name list at all — so
 * `admin`, `terms`, `privacy`, `changelog` and every other landing route name
 * was claimable, and claiming one would shadow that route and leave the
 * profile permanently unreachable.
 */
import { prisma } from "../lib/prisma.js";

/**
 * Withheld for two distinct reasons, kept in one set because the check is the
 * same. First: names that are (or could become) a real path on the landing
 * host — public profiles are served from `/{handle}` there, so a collision
 * shadows the route. Second: names a visitor would reasonably read as
 * DataBounty itself; `databounty.io/support` in a screenshot is
 * indistinguishable from an official page, so these are withheld whether or
 * not a route exists today.
 */
export const RESERVED_PUBLIC_HANDLES = new Set([
  // Routes and route-shaped names.
  "about", "admin", "agents", "api", "assets", "auth", "blog", "bounties",
  "careers", "cdn", "changelog", "contact", "dashboard", "databounty",
  "delivered", "developers", "docs", "domains", "health", "help",
  "how-it-works", "login", "logout", "mcp", "me", "notifications", "oauth",
  "open", "pools", "pricing", "privacy", "profile", "settings", "signin",
  "signup", "sitemap", "static", "status", "terms", "user", "users",
  "validator", "wallet", "www",
  // Impersonation-prone names.
  "abuse", "billing", "legal", "moderator", "noreply", "official", "payments",
  "root", "security", "staff", "support", "system", "team",
]);

/** Lowercase alphanumerics and single interior hyphens, 3–20 characters, and
 * never leading or trailing a hyphen. Identical to V1's `HANDLE_RE`. */
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$/;

export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 20;

export function normalizePublicHandle(value: string): { handle?: string; reason?: string } {
  const handle = value.trim().toLowerCase();
  if (handle.length < HANDLE_MIN_LENGTH) return { reason: `Handle must be at least ${HANDLE_MIN_LENGTH} characters.` };
  if (handle.length > HANDLE_MAX_LENGTH) return { reason: `Handle must be at most ${HANDLE_MAX_LENGTH} characters.` };
  if (!HANDLE_RE.test(handle) || handle.includes("--")) {
    return { reason: "Use lowercase letters, numbers, and single hyphens only." };
  }
  if (RESERVED_PUBLIC_HANDLES.has(handle)) return { reason: "That handle is reserved." };
  return { handle };
}

// Suffixes tried (in order) when the requested handle is taken. Numeric-only,
// so every candidate satisfies HANDLE_RE without further massaging.
const SUGGESTION_SUFFIXES = ["2", "3", "4", "7", "9", "21", "42"];

/**
 * Pure candidate generation (no database) — the requested handle plus a short
 * numeric suffix, each re-validated through `normalizePublicHandle` so a
 * suggestion can never violate the length, charset or reserved-word rules even
 * after being truncated to fit.
 */
export function buildHandleSuggestionCandidates(base: string): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const suffix of SUGGESTION_SUFFIXES) {
    const maxBaseLen = Math.max(1, HANDLE_MAX_LENGTH - suffix.length);
    const combined = `${base.slice(0, maxBaseLen)}${suffix}`;
    if (seen.has(combined)) continue;
    seen.add(combined);
    const { handle } = normalizePublicHandle(combined);
    if (handle && handle !== base) candidates.push(handle);
  }
  return candidates;
}

/**
 * Word lists for generated handle suggestions.
 *
 * Curated here rather than pulled from a general-purpose name generator's
 * dictionaries. Those are built for throwaway container names and contain
 * plainly unflattering adjectives — a handle is claimed ONCE, becomes the
 * member's public profile URL, and is the name their published dataset credit
 * is attributed to, so offering an insult as a permanent professional identity
 * is not acceptable. An agent reading a list back to someone also has no way
 * to know which entries are unflattering.
 *
 * Every adjective is positive or neutral and reads well next to every animal.
 * No word appears in both lists, so a draw can never produce a stutter like
 * "swiftswift". 54 x 45 = 2,430 combinations, and the result is filtered
 * against the database anyway.
 */
const HANDLE_ADJECTIVES = [
  "able", "agile", "amber", "ample", "arctic", "bold", "brave", "bright",
  "calm", "candid", "civic", "clear", "clever", "coastal", "cobalt", "crisp",
  "curious", "daring", "deft", "eager", "early", "exact", "fleet", "focused",
  "frank", "golden", "granite", "hardy", "honest", "keen", "kindly", "lively",
  "loyal", "lucid", "merry", "nimble", "noble", "north", "patient", "polar",
  "prime", "quick", "quiet", "rapid", "ready", "solar", "steady", "swift",
  "tidal", "true", "vivid", "wander", "wise", "zesty",
];

const HANDLE_ANIMALS = [
  "badger", "bison", "cobra", "condor", "coyote", "crane", "dolphin", "eagle",
  "falcon", "ferret", "finch", "gecko", "heron", "ibex", "impala", "jaguar",
  "kestrel", "koala", "lemur", "lynx", "magpie", "marlin", "marten",
  "mongoose", "narwhal", "ocelot", "orca", "osprey", "otter", "owl", "panda",
  "panther", "pelican", "puffin", "puma", "raven", "sable", "salmon", "seal",
  "sparrow", "stork", "tapir", "tern", "walrus", "wombat",
];

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

/** Readable adjective+animal candidate ("braveotter"), concatenated without a
 * separator — two words already give a large enough space that repeated rolls
 * do not burn through common single words. */
export function generateHandleCandidate(): string {
  return `${pick(HANDLE_ADJECTIVES)}${pick(HANDLE_ANIMALS)}`;
}

/**
 * A starter list of confirmed-free handles for someone who has not thought of
 * one yet. Suggesting is not choosing: nothing here is reserved, and the claim
 * route is still the only thing that takes a name — two people can be shown
 * the same suggestion and the unique index decides.
 *
 * Over-generates so collisions and the length/charset/reserved-word filter
 * still leave `count` usable options, then resolves them in ONE `IN` query
 * rather than probing per candidate. The draw loop is bounded rather than
 * looping until `count` unique names exist: the dictionary is finite and this
 * runs on a rate-limited route, so a pathological run must end in constant
 * time rather than spin.
 */
export async function suggestAvailableHandles(count = 8): Promise<string[]> {
  const wanted = Math.min(Math.max(count, 1), 10);
  const pool = new Set<string>();
  for (let draw = 0; draw < wanted * 4; draw++) {
    const { handle } = normalizePublicHandle(generateHandleCandidate());
    if (handle) pool.add(handle);
  }
  const candidates = [...pool];
  if (candidates.length === 0) return [];
  const taken = await prisma.user.findMany({
    where: { handle: { in: candidates } },
    select: { handle: true },
  });
  const takenSet = new Set(taken.map((u) => u.handle));
  return candidates.filter((c) => !takenSet.has(c)).slice(0, wanted);
}

/** Batch-checks the suffix candidates against the database in a single `IN`
 * query (not N+1), returning only confirmed-available ones, most-preferred
 * first. */
export async function findAvailableHandleSuggestions(base: string, limit = 5): Promise<string[]> {
  const candidates = buildHandleSuggestionCandidates(base);
  if (candidates.length === 0) return [];
  const taken = await prisma.user.findMany({
    where: { handle: { in: candidates } },
    select: { handle: true },
  });
  const takenSet = new Set(taken.map((u) => u.handle));
  return candidates.filter((c) => !takenSet.has(c)).slice(0, limit);
}
