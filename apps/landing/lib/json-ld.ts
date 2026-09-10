// SPDX-License-Identifier: Apache-2.0

/**
 * Safe serializer for a JSON-LD object injected via `dangerouslySetInnerHTML`
 * into a `<script type="application/ld+json">` tag.
 *
 * `JSON.stringify` alone does NOT escape `<`, `>`, or `/` — a string value
 * containing `</script>` closes the script tag early and turns everything
 * after it into real, browser-parsed HTML. Found live and exploitable
 * (2026-09-03 QA audit): a public profile's sponsor-controlled `displayName`
 * containing `</script><img src=x onerror=alert(1)>` executed the injected
 * handler for every anonymous visitor of that profile page, since
 * `[handle]/view.tsx` embeds `profile.displayName` unescaped into this exact
 * pattern. `changelog/page.tsx` uses the same pattern with server-authored
 * content (not currently attacker-reachable), hardened here too rather than
 * leaving one of the two call sites unguarded.
 *
 * Standard mitigation (same one Next.js's own docs and `serialize-javascript`
 * use): escape the three characters that can break out of an HTML script
 * context, as their `\uXXXX` equivalents so the JSON value is unchanged but
 * can never be parsed as markup.
 */
export function safeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}
