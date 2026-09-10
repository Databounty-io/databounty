// SPDX-License-Identifier: Apache-2.0

import type { DatasetType } from "@prisma/client";
import {
  languageLabel,
  LANGUAGE_RUNTIMES,
  normalizeLanguage,
  type CanonicalLanguage,
} from "../../lib/exec-languages.js";
import { configuredProviders } from "./provider-order.js";
import { installedRuntimes, setInstalledRuntimesForTest } from "./provider-runtimes.js";

// Re-exported so the manifest drift guard and the existing test seam keep one
// import site. The reading itself moved to provider-runtimes.ts, where it is
// one PROVIDER's answer (e2b's) rather than the platform's.
export { installedRuntimes, setInstalledRuntimesForTest };

/**
 * Which languages a dataset type can actually be built in — computed from the
 * contract and the sandbox image, never declared.
 *
 * The sponsor planner used to offer the same seven hardcoded chips for every
 * template, borrowed from the notification watch-preference defaults. Against
 * the live catalog that list was wrong in both directions: it offered Java on
 * all 33 active types when only 6 accept it, offered SQL when no active type
 * accepts it, and offered nothing correct at all for the C, bash, regex and
 * GraphQL templates. Nineteen of the 33 have exactly ONE possible answer that
 * their own harness fixes — so for those the planner was asking a question that
 * had no valid answer among the options it presented.
 *
 * Three inputs, intersected:
 *   1. what the type DECLARES  — enum options / executable-field `lang`
 *   2. what the harness CAN RUN — registry/lib/helpers.js `normLang` dispatch
 *   3. what the CONFIGURED SANDBOX CHAIN can execute — every provider in
 *      EXECUTION_SANDBOX_ORDER, each answering for itself (provider-runtimes.ts)
 *
 * Honesty rule (CLAUDE.md: a missing check is never presented as passed): a
 * language whose runtime is absent is still offered, because the pipeline
 * accepts those rows and routes them to human audit rather than rejecting them.
 * It is offered as `unverifiable` with the reason attached, so the UI can say
 * plainly that those items will not be execution-verified.
 */

export type LanguageStatus = "verified" | "unverifiable";

export interface SupportedLanguage {
  /** Canonical id where one exists; the raw declared value otherwise (`sh`). */
  id: string;
  /** Sponsor-facing label — also exactly what gets stored as Bounty.language. */
  label: string;
  status: LanguageStatus;
  /** Present only for `unverifiable`; names the missing runtime. */
  reason?: string;
}

export interface LanguageSupport {
  /**
   * - `fixed`  — the contract permits exactly one language. Do not ask; state it.
   * - `choice` — a closed set the sponsor picks from.
   * - `any`    — the contract constrains nothing; fall back to free text.
   * - `none`   — no executable fields at all; skip the step entirely.
   */
  mode: "fixed" | "choice" | "any" | "none";
  languages: SupportedLanguage[];
}

/** Field keys that genuinely name a language.
 *
 * Deliberately an exact-match allowlist, not a `%lang%` pattern. The catalog
 * carries three fields a pattern would wrongly harvest: `language_ecosystem`
 * (pip/npm/cargo — package managers), `query_language` (compound phrases like
 * "Python + regex" and "SQL (log data loaded into a table)") and
 * `natural_language_description` (an instruction field, not a language at all).
 */
const LANGUAGE_FIELD_KEYS = new Set(["language", "source_language", "target_language"]);

/** Roles whose content is code the sandbox executes. A type with none of these
 * has no language to speak of — media annotation, transcription, and the two
 * structural/advisory templates. */
const EXECUTABLE_ROLES = new Set(["input_code", "solution_code", "tests"]);

interface ContractField {
  key?: string;
  role?: string;
  lang?: string;
  options?: string[];
}

function fieldsOf(type: Pick<DatasetType, "fields">): ContractField[] {
  if (!Array.isArray(type.fields)) return [];
  return (type.fields as unknown[]).flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const f = raw as Record<string, unknown>;
    return [{
      key: typeof f.key === "string" ? f.key : undefined,
      role: typeof f.role === "string" ? f.role : undefined,
      lang: typeof f.lang === "string" ? f.lang : undefined,
      options: Array.isArray(f.options)
        ? f.options.filter((o): o is string => typeof o === "string")
        : undefined,
    }];
  });
}

// ----------------------------------------------------------- capability -----

/**
 * ANY configured provider being able to run a language makes it verifiable,
 * because the chain falls through: `service.ts` records `runtime_unavailable`
 * on the provider that lacks the runtime and moves to the next one, so a
 * language only fails to be execution-verified when NO provider can run it.
 * Requiring every provider to have it would mean that ADDING a narrower
 * self-hosted box to the order silently downgraded languages the managed
 * provider still runs perfectly well — capability going down as capacity goes
 * up.
 *
 * A provider whose capability answer is missing or stale is neither counted as
 * able nor as unable: it simply does not vote (see `usable` in
 * provider-runtimes.ts). If NO provider votes, nothing can be claimed and the
 * language is `unverifiable` with that stated as the reason — the honest
 * degrade, and never "supported".
 *
 * Reads `configuredProviders()` (EXECUTION_SANDBOX_ORDER), deliberately NOT
 * `isConfigured()`: this is the same capability question the activation gate
 * asks, and it must stay free of a database round-trip and of per-key
 * credential state. Whether the key is present is a liveness question answered
 * on the execution path.
 */
interface RuntimeVerdict {
  verified: boolean;
  /** Named in the `reason` when not verified. Empty when nothing could vote. */
  missing: string[];
  /** True when no provider could answer at all — "unknown", not "absent". */
  unknown: boolean;
}

function runtimeVerdictFor(canonical: CanonicalLanguage): RuntimeVerdict {
  const required = LANGUAGE_RUNTIMES[canonical];
  let voted = false;
  let closestGap: string[] | null = null;

  for (const provider of configuredProviders()) {
    const capability = provider.runtimeCapability?.();
    if (!capability || !capability.usable) continue;
    voted = true;
    const missing = required.filter((bin) => !capability.binaries.has(bin));
    if (missing.length === 0) return { verified: true, missing: [], unknown: false };
    // Report the SMALLEST gap across providers — the closest any box is to
    // being able to run it. A union across providers would name binaries that
    // are only missing somewhere the work would never have been sent.
    if (!closestGap || missing.length < closestGap.length) closestGap = missing;
  }

  if (!voted) return { verified: false, missing: [], unknown: true };
  return { verified: false, missing: closestGap ?? [...required], unknown: false };
}

// ------------------------------------------------------------- declared -----

/** Every language the contract permits, in declaration order, de-duplicated by
 * canonical identity so `py` and `Python` never both appear as chips. */
function declaredLanguages(type: Pick<DatasetType, "fields">): string[] {
  const fields = fieldsOf(type);
  const raw: string[] = [];

  for (const field of fields) {
    if (field.key && LANGUAGE_FIELD_KEYS.has(field.key) && field.options?.length) {
      raw.push(...field.options);
    }
  }
  for (const field of fields) {
    if (field.role && EXECUTABLE_ROLES.has(field.role) && field.lang?.trim()) {
      raw.push(field.lang.trim());
    }
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    const identity = normalizeLanguage(value) ?? value.trim().toLowerCase();
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    out.push(value);
  }
  return out;
}

// ------------------------------------------------------------- resolver -----

/**
 * Resolve one dataset type's language support.
 *
 * The `unverifiable` verdict is issued ONLY on positive evidence: the value
 * resolves to a language the polyglot runner dispatches, AND the image is
 * missing a binary that runner needs. Anything else stays `verified`, because
 * every active type has a human-written, human-reviewed harness in registry/ —
 * so `sh`, `regex`, `graphql` and `sql` are verified by their own category
 * harness even though the polyglot runner would not recognise them. Guessing
 * "unsupported" from an unrecognised string would invent a failure that the
 * running system does not have.
 */
export function languageSupportFor(type: Pick<DatasetType, "fields">): LanguageSupport {
  const declared = declaredLanguages(type);

  if (declared.length === 0) {
    const hasExecutable = fieldsOf(type).some((f) => f.role && EXECUTABLE_ROLES.has(f.role));
    return { mode: hasExecutable ? "any" : "none", languages: [] };
  }

  const languages: SupportedLanguage[] = declared.map((value) => {
    const canonical = normalizeLanguage(value);
    const verdict = canonical ? runtimeVerdictFor(canonical) : null;
    if (canonical && verdict && !verdict.verified) {
      return {
        id: canonical,
        label: languageLabel(value),
        status: "unverifiable" as const,
        reason: verdict.unknown
          ? `no configured execution sandbox could report whether it has ${LANGUAGE_RUNTIMES[canonical].join(" / ")} — ` +
            `items in this language are routed to human audit instead of being execution-verified`
          : `no configured execution sandbox has ${verdict.missing.join(" / ")} — items in this language ` +
            `are routed to human audit instead of being execution-verified`,
      };
    }
    return {
      id: canonical ?? value.trim().toLowerCase(),
      label: languageLabel(value),
      status: "verified" as const,
    };
  });

  return { mode: languages.length === 1 ? "fixed" : "choice", languages };
}
