// SPDX-License-Identifier: Apache-2.0

import "dotenv/config";
import type { AppConfig } from "./types/index.js";

function getEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required configuration variable: ${name}`);
  }
  return value;
}

function getNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(raw) || raw < min || raw > max) {
    throw new Error(`Invalid ${name}: must be a number between ${min} and ${max}`);
  }
  return raw;
}

function getList(name: string, fallback: string[] = []): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

/** Path of the single Streamable-HTTP MCP endpoint, appended to
 *  `mcpPublicUrl` wherever the server names its own resource or issuer. */
/**
 * Parse `TRUST_PROXY` into the exact shape Fastify accepts, preserving the
 * hop count / allowlist instead of collapsing it to a boolean.
 *
 * Why this matters (SEC-04 follow-up, 2026-09-05): `infra/deploy-api.sh`
 * writes `TRUST_PROXY=2` (CloudFront -> ALB, two hops). The previous parser
 * only recognised the literal `"true"`, so `"2"` became `false` and `req.ip`
 * was the load balancer's socket address for every request — the whole
 * internet shared one rate-limit bucket. Setting a bare `true` instead would
 * trust the entire `X-Forwarded-For` chain, letting a caller choose its own
 * `req.ip` and defeat per-IP limiting. A hop count or CIDR allowlist is the
 * only shape that is both correct and non-spoofable.
 *
 *  - unset / "" / "false" / "0"    -> false (direct exposure, no proxy)
 *  - "true"                        -> true  (trust the full chain — only safe
 *                                            when the process is unreachable
 *                                            except via the proxy)
 *  - positive integer, e.g. "2"    -> 2     (trust exactly that many hops)
 *  - anything else, e.g.
 *    "loopback, 10.0.0.0/8"        -> passed through as an address allowlist
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const value = (raw ?? "").trim();
  if (value === "" || value.toLowerCase() === "false" || value === "0") return false;
  if (value.toLowerCase() === "true") return true;
  if (/^[1-9]\d*$/.test(value)) return Number(value);
  return value;
}

export const MCP_RESOURCE_PATH = "/mcp";

/**
 * `MCP_PUBLIC_URL` is documented as the API's public ORIGIN, but the value an
 * operator has in front of them is usually the URL clients paste into their
 * MCP settings — which ends in `/mcp`. Appending the resource path to that
 * produced `https://host/mcp/mcp` as issuer, token endpoint and
 * resource-metadata URL (all 404) on the first shared deployment, and no
 * client could complete discovery. Accept both spellings: strip trailing
 * slashes and one trailing resource path.
 */
export function normalizeMcpPublicUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.endsWith(MCP_RESOURCE_PATH) ? trimmed.slice(0, -MCP_RESOURCE_PATH.length).replace(/\/+$/, "") : trimmed;
}

const nodeEnv = process.env.NODE_ENV ?? "development";
// Denylist, not allowlist: a public deployment (staging, qa, or anything else
// that isn't literally "production"/"prod"/"live") must not skip the dev-secret
// and localhost-URL guards below just because its NODE_ENV has a different
// name. Only "development" and "test" are known-safe local/CI values where the
// dev_* fallbacks and localhost defaults are expected and harmless.
const isProdEnv = nodeEnv !== "development" && nodeEnv !== "test";

// --- execution timeout budget -------------------------------------------
// One outer budget, everything else derived from it, so outer > inner holds by
// construction. Hardcoded inner literals that could exceed the outer sandbox
// budget would stop the outer timeout being a backstop: a child outliving it
// can only be stopped by tearing the whole sandbox down mid-command.
const executionTimeoutMs = getNumber("EXECUTION_RUNNER_TIMEOUT_MS", 120_000, 5_000, 600_000);
// A harness runs up to two children sequentially (fixed + broken code), so
// each gets 40% of the outer budget; the remaining 20% covers process start,
// file writes and result emission.
const harnessChildTimeoutMs = Math.floor(executionTimeoutMs * 0.4);
// Runtime probes (`node --version`, …) are cheap; several may run per item.
const harnessProbeTimeoutMs = Math.min(5_000, Math.floor(executionTimeoutMs * 0.15));
// The sandbox VM must outlive the command budget or it is reaped mid-run.
const executionSandboxLifetimeMs = executionTimeoutMs + 30_000;

export const config: AppConfig & {
  isProd: boolean;
  sessionSecret: string;
  adminSessionSecret: string;
  adminUrl: string;
  appUrl: string;
  landingUrl: string;
  googleClientId?: string;
  poolSamplingHmacSecret: string;
  profileSourceSecret: string;
  publicApiBaseUrl: string;
  mcpPublicUrl: string;
  githubOAuth: { clientId?: string; clientSecret?: string };
  orcidOAuth: { clientId?: string; clientSecret?: string; apiBaseUrl: string };
  slackOAuth: { clientId?: string; clientSecret?: string };
  openRouterApiKey?: string;
  telegramBotToken?: string;
  telegramBotUsername?: string;
  email: {
    from: string;
    smtpHost?: string;
    smtpPort?: number;
    /** Implicit TLS on connect (SMTPS). `undefined` = not stated by the
     * operator, in which case the transports derive it from the port. */
    smtpSecure?: boolean;
    smtpUser?: string;
    smtpPass?: string;
  };
} = {
  env: nodeEnv,
  isProd: isProdEnv,
  port: getNumber("PORT", 4000, 1000, 65535),
  host: process.env.HOST ?? "0.0.0.0",
  logLevel: process.env.LOG_LEVEL ?? "info",
  corsOrigins: getList("CORS_ORIGINS", ["http://localhost:3000", "http://localhost:3001", "http://localhost:3002"]),
  // Origins allowed to reach `/mcp`, SEPARATE from `corsOrigins` on purpose.
  //
  // `corsOrigins` drives credentialed CORS (`credentials: true`) for the whole
  // API, so an entry there may send cookie-bearing browser requests to every
  // endpoint. A hosted MCP client is not entitled to that, and adding one to
  // `CORS_ORIGINS` to unblock a connector would be a real privilege grant, not
  // a config tweak. `/mcp` is Bearer-only — it never reads a cookie — so its
  // origin gate is pure DNS-rebinding defense-in-depth and can safely admit
  // origins that must NOT be trusted with credentials.
  //
  // The gate only fires when `Origin` is present; native clients (Claude Code,
  // Codex, mcp-remote) send none and are unaffected. Hosted connectors that
  // fetch from their own infrastructure DO attach one, and before this list
  // existed any such origin was 403'd before authentication — the one place
  // this port could reject a client v1 would have allowed (v1 has no origin
  // check on `/mcp` at all).
  mcpAllowedOrigins: getList("MCP_ALLOWED_ORIGINS", ["https://chatgpt.com", "https://chat.openai.com", "https://claude.ai"]),
  server: {
    bodyLimitBytes: getNumber("BODY_LIMIT_BYTES", 10 * 1024 * 1024, 1024, 100 * 1024 * 1024),
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  },
  sessionSecret: process.env.SESSION_SECRET ?? "dev_session_secret_databounty_community_32bytes_long",
  adminSessionSecret: process.env.ADMIN_SESSION_SECRET ?? "dev_admin_session_secret_databounty_community_32bytes",
  adminUrl: process.env.ADMIN_URL ?? "http://localhost:3002",
  appUrl: process.env.APP_URL ?? "http://localhost:3010",
  // The public landing app, which owns `/domains/:id`, `/pools` and the public
  // profiles. Distinct from `appUrl` (the member dashboard): the waitlist
  // "your domain is live" email linked `appUrl/domains/:id`, a route the member
  // app does not have, so its only CTA 404'd for every recipient. V1 carries a
  // separate `landingUrl` for exactly this.
  landingUrl: process.env.LANDING_URL ?? "http://localhost:3001",
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  // Server-only key for the deterministic HMAC-based human-audit-window
  // sampler (services/pool-lifecycle.ts). Never logged, never persisted
  // anywhere but derived rank strings. Dev fallback matches the pattern of
  // sessionSecret/adminSessionSecret above — set POOL_SAMPLING_HMAC_SECRET in
  // any real deployment.
  poolSamplingHmacSecret: process.env.POOL_SAMPLING_HMAC_SECRET ?? "dev_pool_sampling_hmac_secret_databounty_community",
  // Signs the OAuth `state` param and encrypts stored provider tokens
  // (lib/profile-source-crypto.ts). Dev fallback matches the pattern above;
  // set PROFILE_SOURCE_SECRET in any real deployment.
  profileSourceSecret: process.env.PROFILE_SOURCE_SECRET ?? "dev_profile_source_secret_databounty_community_32b",
  // Absolute base URL of this API's own public HTTP surface (no trailing
  // slash), used to build links that must resolve outside this process — the
  // routine-digest unsubscribe URL (lib/digest-unsubscribe-token.ts) and MCP
  // artifact-upload URLs (mcp/tools.ts), which an out-of-process MCP client
  // has no "current page" origin to resolve a relative path against. Dev
  // fallback matches the port this server actually binds to.
  publicApiBaseUrl: (process.env.PUBLIC_API_BASE_URL ?? `http://localhost:${process.env.PORT ?? 4000}`).replace(/\/+$/, ""),
  // Public dashboard/MCP gateway origin (services/mcp-oauth.ts). Bound
  // into every issued credential as its RFC 8707 audience, so it must be the
  // URL clients actually configure — there is no safe way to derive it from
  // the request (the Host header is attacker-controlled and would let a
  // credential be minted for someone else's audience). Dev fallback matches
  // the port this server actually binds to.
  // The fallback is `appUrl`, NOT this server's own origin. The dashboard
  // proxies `/mcp` and both `.well-known` documents (apps/web/next.config.ts),
  // so the URL a client pastes is `<dashboard>/mcp`, and that origin is the
  // RFC 8707 `resource` it sends. Defaulting to the API's own port made the
  // server claim a different resource than the one it advertises, so every
  // spec-compliant client -- which is every client since MCP 2025-11-25 --
  // was answered `invalid_target` on /authorize and could never connect.
  mcpPublicUrl: normalizeMcpPublicUrl(process.env.MCP_PUBLIC_URL ?? process.env.APP_URL ?? "http://localhost:3010"),
  githubOAuth: {
    clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
    clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
  },
  orcidOAuth: {
    clientId: process.env.ORCID_OAUTH_CLIENT_ID,
    clientSecret: process.env.ORCID_OAUTH_CLIENT_SECRET,
    apiBaseUrl: process.env.ORCID_API_BASE_URL ?? "https://orcid.org",
  },
  slackOAuth: {
    clientId: process.env.SLACK_CLIENT_ID,
    clientSecret: process.env.SLACK_CLIENT_SECRET,
  },
  openRouterApiKey: process.env.OPENROUTER_API_KEY,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME,
  email: {
    from: process.env.EMAIL_FROM ?? "noreply@databounty.io",
    smtpHost: process.env.SMTP_HOST,
    smtpPort: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined,
    // V1 reads SMTP_SECURE directly in `databounty-api/src/lib/mailer.ts`
    // (`secure: process.env.SMTP_SECURE === "true"`) and documents it in its
    // .env.example. The rebuild documented the variable but read it nowhere,
    // so an operator on a non-standard implicit-TLS port had no way to turn
    // TLS-on-connect on. Left `undefined` when unset so the existing
    // derive-from-port behaviour is unchanged rather than forced to false.
    smtpSecure:
      process.env.SMTP_SECURE === undefined || process.env.SMTP_SECURE === ""
        ? undefined
        : process.env.SMTP_SECURE === "true" || process.env.SMTP_SECURE === "1",
    smtpUser: process.env.SMTP_USER,
    smtpPass: process.env.SMTP_PASS,
  },
  artifactScan: {
    endpoint: process.env.ARTIFACT_SCAN_URL,
    token: process.env.ARTIFACT_SCAN_TOKEN,
    timeoutMs: getNumber("ARTIFACT_SCAN_TIMEOUT_MS", 15000, 1000, 120000),
  },
  storage: {
    driver: (process.env.STORAGE_DRIVER as "local" | "s3") || "local",
    localDir: process.env.STORAGE_LOCAL_DIR || "./data/artifacts",
    maxUploadBytes: getNumber("STORAGE_MAX_UPLOAD_BYTES", 100 * 1024 * 1024, 1, 500 * 1024 * 1024),
    // Large-object (multipart) direct upload. A file at or above the threshold
    // is uploaded to object storage in parts, in parallel, resumably (AWS
    // recommends multipart for objects >=100 MB; parts are 5 MB-5 GB, <=10,000).
    // maxMultipartUploadBytes deliberately dwarfs the single-PUT maxUploadBytes,
    // which stays the cap for the non-multipart path.
    multipartThresholdBytes: getNumber("STORAGE_MULTIPART_THRESHOLD_BYTES", 100 * 1024 * 1024, 5 * 1024 * 1024, 5 * 1024 * 1024 * 1024),
    multipartPartSizeBytes: getNumber("STORAGE_MULTIPART_PART_SIZE_BYTES", 16 * 1024 * 1024, 5 * 1024 * 1024, 5 * 1024 * 1024 * 1024),
    maxMultipartUploadBytes: getNumber("STORAGE_MAX_MULTIPART_UPLOAD_BYTES", 5 * 1024 * 1024 * 1024, 100 * 1024 * 1024, 5 * 1024 * 1024 * 1024 * 10),
    requestTimeoutMs: getNumber("STORAGE_REQUEST_TIMEOUT_MS", 15_000, 1_000, 120_000),
    /** Lifetime of ONE upload slot (the presigned/direct-upload capability and
     * the artifact's own `uploadExpiresAt`). Was a hardcoded 1 hour in
     * services/artifacts.ts; now the same operator-tunable key and the same
     * 900s default / 60-3600s bounds as v1 (`config.ts:381-386`). Bounds
     * matter in both directions: too short and a slow mobile upload can never
     * finish, too long and an abandoned slot holds a signed write capability
     * open for the rest of the day. */
    directUploadExpiresSeconds: getNumber("STORAGE_DIRECT_UPLOAD_EXPIRES_SECONDS", 900, 60, 3600),
    /** How many live (unexpired) `pending_upload` rows one account may hold at
     * once. Bounds the cheapest denial-of-service on this surface: slot
     * creation is a database write plus a signature, so an unbounded loop
     * fills the table and the bucket's pending-object space for free. Same key
     * and default (20) as v1. */
    maxPendingUploadsPerUser: getNumber("STORAGE_MAX_PENDING_UPLOADS_PER_USER", 20, 1, 200),
    // S3-compatible provider config — only read/required when STORAGE_DRIVER=s3.
    // No hardcoded production endpoint: bucket/region/credentials/endpoint are
    // all operator-configured via env, same names v1 uses (standard AWS env
    // vars for credentials, so a real deployment can reuse its existing role/
    // instance-profile setup without renaming anything).
    bucket: process.env.STORAGE_BUCKET || "",
    region: process.env.STORAGE_REGION || "us-east-1",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || undefined,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || undefined,
    sessionToken: process.env.AWS_SESSION_TOKEN || undefined,
    endpoint: process.env.STORAGE_ENDPOINT || undefined,
  },
  // Execution is deliberately an external trust boundary. The API never
  // evaluates contributor code in its own process; it hands a self-contained
  // script to an isolated sandbox provider and records the returned evidence.
  execution: {
    /** Outer budget for ONE sandbox command. Every in-sandbox timeout is
     * derived from this and is strictly smaller, so this stays a real backstop. */
    timeoutMs: executionTimeoutMs,
    /** Max sandbox VM lifetime — strictly greater than the command budget. */
    sandboxLifetimeMs: executionSandboxLifetimeMs,
    e2bApiKey: process.env.E2B_API_KEY ?? "",
    e2bTemplate: process.env.E2B_TEMPLATE ?? "",
    /** Derived, never set directly — see the boot invariant below. */
    harness: {
      /** Per-child-process (`node --test`, `python3`, …) budget. Two children
       * run sequentially (fixed + broken), so 2×child < outer. */
      childTimeoutMs: harnessChildTimeoutMs,
      /** `have(cmd)` runtime-probe budget — many probes may run per item. */
      probeTimeoutMs: harnessProbeTimeoutMs,
    },
    /**
     * Sandbox isolation posture. Contributor-submitted code runs here, so the
     * defaults are default-deny and the code FAILS CLOSED: if the configured
     * isolation cannot be applied AND verified, the run is abandoned with a
     * non-retryable provider error (recorded as an honest "no verdict" → human
     * review) rather than executing unrestricted.
     */
    sandbox: {
      /** Explicit opt-in to run contributor code with UNRESTRICTED network
       * egress. Default false, refused outright in production below. */
      allowEgress: getBool("EXECUTION_SANDBOX_ALLOW_EGRESS", false),
      /** Optional egress allowlist (hosts/IPs/CIDRs). When non-empty everything
       * else is denied; when empty and allowEgress is false, ALL egress is blocked. */
      egressAllowlist: getList("EXECUTION_SANDBOX_EGRESS_ALLOWLIST"),
      /** After creating the sandbox, read its state back and confirm the
       * provider actually applied the requested posture. If it will not echo it
       * back we cannot prove isolation → fail closed. */
      verifyIsolation: getBool("EXECUTION_SANDBOX_VERIFY_ISOLATION", true),
      /** Reject a sandbox whose VM is larger than this — a mis-set template
       * would silently hand untrusted code far more CPU/RAM than intended. */
      maxCpus: getNumber("EXECUTION_SANDBOX_MAX_CPUS", 2, 1, 16),
      maxMemoryMB: getNumber("EXECUTION_SANDBOX_MAX_MEMORY_MB", 4096, 256, 65_536),
      /** RLIMIT_NPROC applied inside the sandbox before exec'ing the runner —
       * this is the fork-bomb cap. */
      maxProcesses: getNumber("EXECUTION_SANDBOX_MAX_PROCESSES", 256, 16, 8192),
      /** RLIMIT_FSIZE (MiB) — bounds disk-filling writes. */
      maxFileSizeMB: getNumber("EXECUTION_SANDBOX_MAX_FILE_SIZE_MB", 256, 1, 4096),
      /** RLIMIT_NOFILE — bounds fd exhaustion. */
      maxOpenFiles: getNumber("EXECUTION_SANDBOX_MAX_OPEN_FILES", 1024, 64, 65_536),
    },
  },
};

// Execution isolation invariants, asserted at boot so a bad environment can
// never put the sandbox into a weaker posture than the code assumes.
//
// 1) Timeout ordering. Two harness children run sequentially inside one sandbox
//    command, so 2×child (plus a probe) must still fit inside the outer command
//    budget, and the sandbox VM must outlive the command.
{
  const { timeoutMs, sandboxLifetimeMs, harness } = config.execution;
  const innerWorstCase = harness.childTimeoutMs * 2 + harness.probeTimeoutMs;
  if (!(harness.childTimeoutMs < timeoutMs && innerWorstCase < timeoutMs && timeoutMs < sandboxLifetimeMs)) {
    throw new Error(
      `Execution timeout ordering violated: child=${harness.childTimeoutMs}ms probe=${harness.probeTimeoutMs}ms ` +
        `(worst case ${innerWorstCase}ms) must be < command=${timeoutMs}ms must be < sandbox lifetime=${sandboxLifetimeMs}ms`
    );
  }
}

// 2) Open egress is an explicit, loud, non-default choice. In production it is
//    refused outright — a "passed" execution verdict produced with no network
//    isolation would be a dishonest trust claim.
if (config.execution.sandbox.allowEgress) {
  if (isProdEnv) {
    throw new Error(
      "EXECUTION_SANDBOX_ALLOW_EGRESS=true in production — contributor code would run with unrestricted network egress. Refusing to start."
    );
  }
  console.warn(
    "[execution] EXECUTION_SANDBOX_ALLOW_EGRESS=true — contributor code runs with UNRESTRICTED network egress. Never use this outside local debugging."
  );
}

// 3) Isolation verification is not an optional feature. With it off, the
//    provider's posture is never read back and every run records
//    `verified: false` — a "passed" row that cannot honestly support an
//    execution-verified trust claim. Warn in dev, refuse in production.
if (!config.execution.sandbox.verifyIsolation) {
  if (isProdEnv) {
    throw new Error(
      "EXECUTION_SANDBOX_VERIFY_ISOLATION=false in production — the sandbox's applied isolation would never be read back, so every execution verdict would be recorded as unverified. Refusing to start."
    );
  }
  console.warn(
    "[execution] EXECUTION_SANDBOX_VERIFY_ISOLATION=false — sandbox isolation is NOT being confirmed; runs are recorded as unverified."
  );
}

// 4) Per-provider boot requirements live in each provider's
//    `validateBootConfig()` and are asserted by
//    `assertConfiguredProvidersBootable()` from server.ts / worker.ts. They are
//    deliberately NOT checked here: config.ts is the foundational module every
//    other module imports, so reaching the provider registry from its load-time
//    guards would create a circular import.

// 5) ADMIN_URL is what `isAdminOrigin()` (lib/session-cookie.ts) compares the
//    request Origin against to decide WHICH session cookie to read. Admin
//    sign-in always writes `db_admin_session`, but every subsequent read falls
//    back to the regular `db_session` cookie when that comparison misses — so a
//    stale or unset ADMIN_URL turns a successful login into a console where
//    every request 401s, or worse (with a shared cookie jar / COOKIE_DOMAIN
//    spanning both apps) authenticates the admin as whatever OTHER account's
//    session cookie happens to be present. Silent either way. V1 carries this
//    same guard (`databounty-api/src/config.ts`) after the bug recurred there;
//    porting it keeps the rebuild at parity. Production only — localhost:3002
//    is the correct default in dev.
if (isProdEnv && config.adminUrl === "http://localhost:3002") {
  throw new Error(
    "ADMIN_URL is unset in production — defaulting to localhost:3002 would misroute every admin-console request to the wrong session cookie. Set it to the deployed admin console's real origin (e.g. https://admin.databounty.io)."
  );
}

// 6) Session signing secrets. Both fall back to a `dev_*` literal that is
//    committed to this repository, so leaving either unset in production means
//    every session cookie is signed with a publicly known key — anyone can mint
//    a valid session for any account, including an admin one. There is no
//    runtime symptom: sign-in works, the console works, nothing logs. V1
//    carries the same guard (`databounty-api/src/config.ts`:
//    "SESSION_SECRET is set to the public dev default in production"), so
//    porting it keeps the rebuild at parity. `apps/api/.env.example` documents
//    this fail-closed behaviour; the guard is what makes that claim true.
if (isProdEnv && config.sessionSecret === "dev_session_secret_databounty_community_32bytes_long") {
  throw new Error(
    "SESSION_SECRET is the public dev default in production — every user session cookie would be signed with a key published in this repository. Set a real secret (openssl rand -hex 32). Refusing to start."
  );
}
if (isProdEnv && config.adminSessionSecret === "dev_admin_session_secret_databounty_community_32bytes") {
  throw new Error(
    "ADMIN_SESSION_SECRET is the public dev default in production — every admin session cookie would be signed with a key published in this repository. Set a real secret (openssl rand -hex 32). Refusing to start."
  );
}

// 7) Public URLs used to build links in outbound email. `appUrl` and
//    `landingUrl` fall back to localhost, and every verification, password
//    reset, admin invite and notification deep link is built from them
//    (lib/auth-notify.ts, services/notifications/href.ts,
//    services/jobs/waitlist-notify.ts). Unset in production, the product mails
//    real users a `http://localhost:...` link — the account is unrecoverable
//    and there is no server-side symptom, because sending succeeds. Guarded
//    here for the same reason ADMIN_URL is.
if (isProdEnv && config.appUrl === "http://localhost:3010") {
  throw new Error(
    "APP_URL is unset in production — every verification, password-reset and admin-invite email would link to http://localhost:3010 and be unusable. Set it to the deployed dashboard origin (e.g. https://console.databounty.io)."
  );
}
if (isProdEnv && config.landingUrl === "http://localhost:3001") {
  throw new Error(
    "LANDING_URL is unset in production — waitlist and public-profile links in outbound email would point at http://localhost:3001. Set it to the deployed landing origin (e.g. https://databounty.io)."
  );
}

// 8) The four remaining `dev_*` signing/authentication secrets. Same class of
//    defect as (6) — each falls back to a literal committed to this
//    repository, so leaving one unset in production means the key is published
//    — but these are NOT ports: V1 has none of these four variables, so there
//    was no upstream guard to copy. They are guarded here because a
//    placeholder secret is never correct in production, and because each one
//    fails silently: nothing logs, every request succeeds, and the protection
//    the secret exists to provide is simply absent.
//
//    What each one protects, and what a published key costs:
//      * POOL_SAMPLING_HMAC_SECRET — seeds the deterministic draw that decides
//        which submissions enter a human-audit window
//        (services/pool-lifecycle.ts `samplingHash`). Published, the draw is
//        reproducible by anyone: a contributor can compute which of their own
//        items will never be reviewed and target exactly those. This defeats
//        audit sampling as an integrity control, which is the point of it.
//      * PROFILE_SOURCE_SECRET — both signs the profile-source state tokens
//        and derives the key encrypting stored provider tokens
//        (lib/profile-source-crypto.ts). Published, connect-flow payloads are
//        forgeable and stored credentials are decryptable, so a verified
//        credential stops meaning anything.
if (isProdEnv && config.poolSamplingHmacSecret === "dev_pool_sampling_hmac_secret_databounty_community") {
  throw new Error(
    "POOL_SAMPLING_HMAC_SECRET is the public dev default in production — human-audit sampling would be computable by anyone reading this repository, letting a contributor predict which of their submissions are never reviewed. Set a real secret (openssl rand -hex 32). Refusing to start."
  );
}
if (isProdEnv && config.profileSourceSecret === "dev_profile_source_secret_databounty_community_32b") {
  throw new Error(
    "PROFILE_SOURCE_SECRET is the public dev default in production — credential-connect tokens would be forgeable and stored provider tokens decryptable with a key published in this repository. Set a real secret (openssl rand -hex 32). Refusing to start."
  );
}

// 9) CORS_ORIGINS. Falls back to the three localhost dev-app origins, and
//    every one of them is trusted with credentialed cross-origin requests
//    (cookies included) by the CORS middleware. Left unset in production, the
//    API's credentialed allowlist would silently be three localhost origins —
//    every real cross-origin browser request from the deployed web/admin/
//    landing apps would be rejected, and (worse, silently) anything actually
//    running on one of those localhost ports on the SAME machine as the
//    server would be trusted with cookies. No runtime symptom beyond broken
//    CORS in the browser console. Guarded the same way appUrl/landingUrl are.
if (isProdEnv && config.corsOrigins.some((origin) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin))) {
  throw new Error(
    "CORS_ORIGINS is unset (or still includes a localhost origin) in production — the credentialed CORS allowlist would trust a localhost origin instead of the deployed web/admin/landing origins. Set it to a comma-separated list of the real deployed origins (e.g. https://console.databounty.io,https://admin.databounty.io,https://databounty.io)."
  );
}

// 10) PUBLIC_API_BASE_URL. Falls back to this server's own localhost origin,
//     and is used to build absolute links that must resolve OUTSIDE this
//     process: the routine-digest unsubscribe URL mailed to real users
//     (lib/digest-unsubscribe-token.ts) and MCP artifact-upload URLs handed to
//     out-of-process MCP clients (mcp/tools.ts). Unset in production, the
//     product mails real users an unusable `http://localhost:.../unsubscribe`
//     link and hands MCP clients an upload URL nothing outside the box can
//     reach — both fail with no server-side symptom, because building the URL
//     always succeeds. Guarded the same way appUrl/landingUrl are.
if (isProdEnv && config.publicApiBaseUrl === `http://localhost:${process.env.PORT ?? 4000}`) {
  throw new Error(
    "PUBLIC_API_BASE_URL is unset in production — digest-unsubscribe emails and MCP artifact-upload links would point at http://localhost, unreachable by anyone but this box. Set it to this API's real public origin (e.g. https://api.databounty.io)."
  );
}

// 11) MCP_PUBLIC_URL. Falls back to this server's own localhost origin. It is
//     bound into every issued MCP OAuth credential as its RFC 8707 audience
//     (services/mcp-oauth.ts), so it must be the URL MCP clients actually
//     configure — there is no safe way to derive it from the request (the
//     Host header is attacker-controlled and would let a credential be minted
//     for someone else's audience). Unset in production, every issued
//     credential is bound to an audience no real client can reach, so MCP
//     auth silently never works. Guarded the same way appUrl/landingUrl are.
if (isProdEnv && /^https?:\/\/localhost(:|$)/.test(config.mcpPublicUrl)) {
  throw new Error(
    "MCP_PUBLIC_URL is unset in production — issued MCP OAuth credentials would be bound to http://localhost as their audience, which no real client can reach. Set it to the public dashboard/MCP gateway origin (e.g. https://console.databounty.io)."
  );
}
// The dashboard proxies /mcp and both `.well-known` documents, so the URL a
// client configures is `<dashboard>/mcp` and that origin is the RFC 8707
// audience it sends. If MCP_PUBLIC_URL names any other host the server
// advertises one resource and validates another, and /authorize answers
// `invalid_target` to every client. That failure is silent and total, so fail
// at boot rather than at each client's first connection attempt.
if (isProdEnv) {
  const mcpOrigin = new URL(config.mcpPublicUrl).origin;
  const appOrigin = new URL(config.appUrl).origin;
  if (mcpOrigin !== appOrigin) {
    throw new Error(
      `MCP_PUBLIC_URL (${mcpOrigin}) must be the same origin as APP_URL (${appOrigin}) — the dashboard is what proxies /mcp to this API, so the audience bound into every issued credential has to be the origin clients actually paste. Set MCP_PUBLIC_URL to APP_URL, or move the MCP gateway onto the APP_URL origin.`
    );
  }
}
