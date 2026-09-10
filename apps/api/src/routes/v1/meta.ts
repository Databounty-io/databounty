// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import { KARMA_RULES, KARMA_TIERS } from "../../services/karma.js";
import { getAdminSetting, llmValidationEnabled } from "../../services/admin-settings.js";
import { openRouterConfigured } from "../../services/llm-client.js";
import { DatasetCategory, DatasetTypeStatus, DomainId, TrustTier } from "@prisma/client";
import { tools as mcpTools } from "../../mcp/tools.js";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../lib/rbac.js";
import { config, MCP_RESOURCE_PATH } from "../../config.js";

// Ported from V1's routes/v1/meta.ts DOMAIN_COPY — real display copy per
// domain, shared by both /public-catalog and /taxonomy below so the two
// routes can never disagree about a domain's name/tagline.
const DOMAIN_COPY: Record<string, { name: string; tagline: string; expertPitch: string }> = {
  coding: {
    name: "Coding",
    tagline: "Debugging, implementation, tests, SQL, regex — execution-verified where possible.",
    expertPitch: "Software engineers earn per accepted item across the active dataset types.",
  },
  legal: {
    name: "Legal",
    tagline: "Contract clauses, jurisdictional reasoning, case analysis — expert-audited.",
    expertPitch: "Licensed attorneys review and author verified legal reasoning data.",
  },
  healthcare: {
    name: "Healthcare",
    tagline: "Clinical notes, diagnostic reasoning, coding — expert-audited.",
    expertPitch: "Clinicians and medical coders review and author verified healthcare data.",
  },
  finance: {
    name: "Finance",
    tagline: "Financial analysis, risk modeling, regulatory reasoning — expert-audited.",
    expertPitch: "Finance professionals review and author verified financial reasoning data.",
  },
  science: {
    name: "Science",
    tagline: "Scientific literature analysis, data extraction, reasoning — expert-audited.",
    expertPitch: "Researchers review and author verified scientific reasoning data.",
  },
};

function categoryLabel(id: string): string {
  return id.split("_").map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ");
}

// Same static default the root `/` route already declares (line ~57 below)
// — reused here rather than duplicated so /taxonomy can't silently disagree
// with it. No admin-configurable language list exists in this deployment
// (V1 reads one from notification runtime settings; not ported here).
const DEFAULT_LANGUAGES = ["TypeScript", "JavaScript", "Python", "Java", "Go", "Rust", "C++", "SQL"];

export async function metaRoutes(app: FastifyInstance) {
  // GET /v1/meta/upload-limits — ported from V1's routes/v1/meta.ts. The
  // numbers a client must agree with to upload at all: which path a file takes
  // (single PUT vs multipart) and how it must be split. Public and
  // non-sensitive; the same four values `get_file_upload_limits` already serves
  // over MCP (mcp/tools.ts), so REST and MCP callers read one source.
  //
  // This route's absence was not cosmetic. apps/web/lib/api-artifacts.ts calls
  // it on every upload and treats its own NEXT_PUBLIC_* constants as the
  // offline fallback only; with the route missing (404) the browser was
  // permanently on that fallback, so a deployment that did not pass those build
  // args had no server value to recover from and rejected every file client-side.
  app.get("/upload-limits", async () => ({
    maxUploadBytes: config.storage.maxUploadBytes,
    multipartThresholdBytes: config.storage.multipartThresholdBytes,
    multipartPartSizeBytes: config.storage.multipartPartSizeBytes,
    maxMultipartUploadBytes: config.storage.maxMultipartUploadBytes,
  }));

  // Public, session-independent launch switches — the web app fetches this
  // once and uses it to decide what to show (session-connect CTAs, whether
  // dashboard submission is live) instead of hardcoding assumptions.
  // Fail-closed: any read error must resolve to the conservative false
  // default, never a fabricated "on".
  app.get("/launch-flags", async (_req, reply) => {
    const [live, dashboardSubmissions] = await Promise.all([
      getAdminSetting<boolean>("launch.community.enabled", false),
      getAdminSetting<boolean>("launch.dashboard_submissions.enabled", false),
    ]);
    return reply.send({
      live: live === true,
      dashboardSubmissions: dashboardSubmissions === true,
    });
  });

  // Backs the Developers page's Base URL/MCP/rate-limit panel (both
  // community/apps/web and enterprise/apps/web). The tool list is read
  // straight from mcp/tools.ts (the actual MCP server's own registry) — this
  // route has NO hand-maintained copy of names/descriptions/scopes, per the
  // documented lesson (API_KEYS_AND_MCP_PLAN.md "H8"): a static copy already
  // drifted from the real backend twice before. `endpoints` intentionally
  // stays empty rather than hand-listing REST routes here — a hand-written
  // list would be exactly the same drift risk this endpoint exists to avoid,
  // and nothing in this codebase yet derives it from the real Fastify route
  // table.
  //
  // `llmValidationEnabled` used to be a hardcoded `false` here, which was a
  // lie in the other direction the moment an operator turned the setting on:
  // this route reported "off" while the published control said "on". It now
  // reads the real `validation.llm.enabled` switch (fails closed to false),
  // and `llmProviderConfigured` reports the independent provider-key fact
  // beside it so a client can tell "switched off" from "switched on but no
  // provider wired up" — two different honest states this endpoint previously
  // collapsed into one.
  app.get("/developer-surface", async (_req, reply) => {
    const llmEnabled = await llmValidationEnabled();
    return reply.send({
      // These are deployment identities, not request identities. Landing calls
      // this route over Docker's private `http://api:4000` address, and Host is
      // caller-controlled, so deriving either URL from the request leaked the
      // internal service address into every public MCP instruction and let a
      // forged Host header rewrite the advertised endpoint.
      baseUrl: `${config.publicApiBaseUrl}/v1`,
      mcpRemoteUrl: `${config.mcpPublicUrl}${MCP_RESOURCE_PATH}`,
      rateLimitPerMinute: 300,
      llmValidationEnabled: llmEnabled,
      llmProviderConfigured: openRouterConfigured(),
      endpoints: [],
      mcpTools: mcpTools.map((t) => ({ name: t.name, description: t.description, scope: t.scope })),
    });
  });

  // Backs the landing site's homepage/bounties/delivered catalog fetch
  // (public-data.ts's `fetchLandingCatalog`). Ported from V1's `/public-catalog`
  // — public discovery metadata only (no admin/planner/waitlist-identity
  // fields), sourced from real active DatasetType rows, never a hand-copied
  // static list.
  app.get("/public-catalog", async (_req, reply) => {
    const typeRows = await prisma.datasetType.findMany({
      where: { status: DatasetTypeStatus.active },
      select: {
        id: true, version: true, name: true, description: true, domain: true,
        category: true, status: true, origin: true, trustTier: true,
        difficultyLevels: true, usageCount: true,
      },
      orderBy: [{ domain: "asc" }, { name: "asc" }],
    });
    const domainIds = Array.from(new Set(typeRows.map((t) => t.domain)));
    const categoryIds = Array.from(new Set(typeRows.map((t) => t.category)));

    return reply.send({
      domains: domainIds.map((id) => {
        const copy = DOMAIN_COPY[id] ?? { name: id, tagline: "", expertPitch: "" };
        return { id, name: copy.name, status: "live" as const, tagline: copy.tagline, expertPitch: copy.expertPitch };
      }),
      categories: categoryIds.map((id) => ({ id, label: categoryLabel(id) })),
      categoryGroups: categoryIds.map((id) => ({
        id,
        label: categoryLabel(id),
        datasetTypes: typeRows
          .filter((type) => type.category === id)
          .map(({ id: typeId, name, description, domain, trustTier, difficultyLevels }) => ({
            id: typeId, name, description, domain, trustTier, difficultyLevels,
          })),
      })),
      datasetTypes: typeRows,
    });
  });

  // Backs every "what kind of data" picker (onboarding, watch prefs, sponsor
  // scope) — the real, DB-driven source for domains/categories/datasetTypes.
  // Ported from V1's `/taxonomy`. Domains are derived from live DatasetType
  // rows so a domain going live needs zero frontend changes; `languages`
  // reuses the same static default the root `/` route already declares
  // (no admin-configurable language list exists in this deployment).
  app.get("/taxonomy", { preHandler: requireAuth }, async (_req, reply) => {
    const [typeRows, waitlistCounts] = await Promise.all([
      prisma.datasetType.findMany({
        where: { status: { in: [DatasetTypeStatus.active, DatasetTypeStatus.draft, DatasetTypeStatus.platform_review, DatasetTypeStatus.coming_soon] } },
        select: { id: true, name: true, domain: true, category: true, status: true },
        orderBy: [{ domain: "asc" }, { status: "asc" }, { name: "asc" }],
      }),
      prisma.waitlistEntry.groupBy({ by: ["domain"], _count: { _all: true } }),
    ]);

    const waitlistByDomain = Object.fromEntries(waitlistCounts.map((w) => [w.domain, w._count._all])) as Record<string, number>;
    const domainIds = Array.from(new Set(typeRows.map((t) => t.domain)));
    const domains = domainIds.map((id) => {
      const hasLiveType = typeRows.some((t) => t.domain === id && t.status === DatasetTypeStatus.active);
      const copy = DOMAIN_COPY[id] ?? { name: id, tagline: "", expertPitch: "" };
      return {
        id, name: copy.name, status: hasLiveType ? ("live" as const) : ("coming_soon" as const),
        tagline: copy.tagline, expertPitch: copy.expertPitch, waitlistCount: waitlistByDomain[id] ?? 0,
      };
    });

    const categoryIds = Array.from(new Set(typeRows.map((t) => t.category)));
    const categories = categoryIds.map((id) => ({ id, label: categoryLabel(id) }));

    return reply.send({
      domains,
      categories,
      datasetTypes: typeRows.map((t) => ({ id: t.id, name: t.name, domain: t.domain, category: t.category, status: t.status })),
      languages: DEFAULT_LANGUAGES,
    });
  });

  app.get("/", async (_req, reply) => {
    return reply.send({
      platform: "DataBounty Community",
      version: "0.1.0",
      domains: Object.values(DomainId),
      categories: Object.values(DatasetCategory),
      trustTiers: Object.values(TrustTier),
      karmaRules: KARMA_RULES,
      karmaTiers: KARMA_TIERS,
      languages: ["TypeScript", "JavaScript", "Python", "Java", "Go", "Rust", "C++", "SQL"],
    });
  });
}
