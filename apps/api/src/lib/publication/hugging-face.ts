// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { PublicationError, isPermanentStatus } from "./errors.js";
import type {
  DatasetStats,
  PublicationProvider,
  PublishDatasetInput,
  PublishFile,
  PublishDatasetResult,
  UnpublishDatasetInput,
  UnpublishDatasetResult,
  CatalogReadmeRow,
} from "./types.js";

/**
 * Env-driven config for this provider only. Deliberately self-contained
 * (reads `process.env` directly rather than importing `../../config.js`) so
 * this file stays inside the write-scope of the publication feature and
 * never needs a change to the shared config module, which other sessions may
 * be editing concurrently. Names match v1
 * (`databounty-api/src/config.ts` `publication.*`) exactly, so an operator
 * who has already provisioned v1 can reuse the same secrets here.
 */
const HF_API_URL = process.env.HUGGINGFACE_API_URL ?? "https://huggingface.co/api";
const HF_TOKEN = process.env.HUGGINGFACE_API_TOKEN ?? "";
const HF_NAMESPACE = process.env.HUGGINGFACE_NAMESPACE ?? "";
const REQUEST_TIMEOUT_MS = Number(process.env.PUBLICATION_REQUEST_TIMEOUT_MS ?? 10_000);
const UPLOAD_TIMEOUT_MS = Number(process.env.PUBLICATION_UPLOAD_TIMEOUT_MS ?? 300_000);

/** Namespace (org or user) datasets are published under, e.g. `databounty`.
 * Blank means push is unconfigured: `isConfigured` returns false with a
 * clear reason rather than guessing a namespace. Exported so
 * `services/community-publish.ts` can resolve the same default the provider
 * itself would use, before an admin-setting override is layered on top. */
export function huggingFaceDefaultNamespace(): string {
  return HF_NAMESPACE;
}

/**
 * Files at or above this size are uploaded via Git LFS (batch API → storage
 * PUT → pointer in the commit) instead of being base64-inlined in the commit
 * body. Hugging Face's own regular-file ceiling is ~10 MB; we use a lower
 * threshold so a large `items.jsonl` streams to object storage rather than
 * bloating (and risking a reject on) the JSON commit request.
 */
const LFS_THRESHOLD_BYTES = 5 * 1024 * 1024;

/**
 * Hard ceiling on a single file regardless of transport — a sanity guard, not
 * a protocol limit (LFS itself handles far larger). Prevents a pathological
 * multi-GB payload from being attempted; such a case fails fast and permanent.
 */
const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * A Hugging Face publish failure. Kept as a named subclass so callers can
 * pattern-match on it specifically, but the `permanent` contract — and the
 * job runner's fail-fast-vs-back-off branch — lives on the shared
 * `PublicationError` base so a GitHub failure is classified by the exact
 * same rule instead of falling through to a blind retry.
 */
export class HuggingFacePublishError extends PublicationError {
  constructor(message: string, permanent: boolean) {
    super(message, permanent);
    this.name = "HuggingFacePublishError";
  }
}

/**
 * Map a free-text license (e.g. "CC-BY-4.0", "cc-by-4.0", "MIT") to a
 * canonical Hugging Face license identifier for the dataset-card YAML. HF
 * rejects a commit whose `license:` tag isn't one of its allowed values, so
 * an unrecognized license returns null and the caller omits the YAML tag
 * entirely (keeping the human-readable license in the card body). Ported
 * verbatim from v1.
 */
export function huggingFaceLicenseTag(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, "-");
  const known = new Set([
    "apache-2.0", "mit", "cc0-1.0", "cc-by-4.0", "cc-by-sa-4.0", "cc-by-nc-4.0",
    "cc-by-nc-sa-4.0", "cc-by-nd-4.0", "cc-by-3.0", "cc", "bsd", "bsd-2-clause",
    "bsd-3-clause", "gpl-3.0", "gpl-2.0", "lgpl-3.0", "agpl-3.0", "mpl-2.0",
    "odc-by", "odbl", "other", "unknown",
  ]);
  return known.has(normalized) ? normalized : null;
}

/**
 * Builds the FULL org profile card (`<namespace>/README`'s `README.md`) from
 * a code template — same reasoning as GitHub's `buildCatalogReadme`: the
 * static sections (banner, mission copy, workflow explainer) rarely change
 * and a template is exact, where round-tripping the live file would be
 * fragile against manual edits. Only the stats line and the "Featured
 * datasets" table are regenerated here every call; everything else must stay
 * byte-identical to what's live unless a human deliberately changes the copy
 * in this function.
 */
function buildOrgProfileCard(rows: CatalogReadmeRow[], top: number): string {
  const sorted = [...rows].sort((a, b) => b.pushedAt.getTime() - a.pushedAt.getTime());
  const shown = sorted.slice(0, top);
  const remaining = sorted.length - shown.length;
  const totalItems = sorted.reduce((sum, r) => sum + r.itemCount, 0);

  const tableRows = shown
    .map(
      (r) =>
        `| ${r.title} | ${r.pushedAt.toISOString().slice(0, 10)} | ${r.itemCount.toLocaleString()} | ${
          r.huggingFaceUrl ? `[Dataset](${r.huggingFaceUrl})` : "—"
        } |`
    )
    .join("\n");

  const moreLine =
    remaining > 0
      ? `\n\n${remaining} more dataset${remaining === 1 ? "" : "s"} not shown above (newest ${top} listed here) — ` +
        `see the full list under [Datasets](https://huggingface.co/${HF_NAMESPACE}) on this org page.`
      : "";

  const featuredSection = sorted.length
    ? `| Dataset | Published | Items | Open it |\n` +
      `|---|---|---:|---|\n` +
      `${tableRows}${moreLine}`
    : "_No datasets published yet._";

  return `---
title: DataBounty
emoji: 🧭
colorFrom: green
colorTo: blue
sdk: static
pinned: false
---

![DataBounty — open datasets, community built](https://raw.githubusercontent.com/Databounty-io/.github/main/profile/banner.svg)

# Dataset infrastructure for community-built AI data

DataBounty turns a real data gap into a traceable, release-ready public dataset. A sponsor defines an open specification, contributors create the items, validators make the release decision, and the finished corpus is published with its licence, provenance, and contributor credit.

| ${sorted.length} public dataset${sorted.length === 1 ? "" : "s"} | ${totalItems.toLocaleString()} released items | CC BY 4.0 releases |
|---:|---:|---:|

[Explore DataBounty](https://databounty.io) · [Open the console](https://console.databounty.io) · [GitHub](https://github.com/Databounty-io) · [Contact support](mailto:support@databounty.io)

## Recent updates

- **Public-release navigation:** featured releases link back to the public DataBounty organisation and their dataset cards.
- **Clearer release evidence:** releases document their scope, licence, provenance metadata, contributor credit, and machine-readable manifest.
- **One visible workflow:** DataBounty connects an open data need to community contributions, validation, and a reusable public release.

## From a data gap to a public release

\`data gap → open work spec → community contributions → validation → published dataset\`

The public site shows open specifications, validation activity, and released datasets. The [DataBounty console](https://console.databounty.io) is where people request a dataset, contribute to open pools, audit submissions, and follow the release process. Coding is live today; the platform is designed to extend to other expert-validated domains.

## What every release includes

- accepted items, a dataset card, and a machine-readable manifest;
- licence, provenance metadata, and named contributor credit; and
- a clear privacy boundary: sponsor references, unpublished submissions, reviewer evidence, credentials, and personal data are never public.

## Featured datasets

${featuredSection}

Read each dataset card and licence before use. For corrections, withdrawal requests, or licensing questions, contact [support@databounty.io](mailto:support@databounty.io).
`;
}

/**
 * Hugging Face Hub adapter. `identifier` is a dataset repo id, e.g.
 * `databounty/sql-migration-fixes`. Uses the public Hub HTTP API — no SDK
 * dependency. A write token is required for `publishDataset`/`unpublishDataset`
 * (never for a plain public read).
 */
export class HuggingFaceProvider implements PublicationProvider {
  readonly name = "huggingface";
  readonly kind = "automated" as const;

  /** Push needs a write token AND a namespace to create the repo under. Both
   * are checked here so the enqueue-time filter and the job runner's
   * pre-flight check read the same answer instead of each re-deriving it. */
  async isConfigured(namespace: string): Promise<{ ok: boolean; reason?: string }> {
    if (!HF_TOKEN) {
      return { ok: false, reason: "Hugging Face write token is not set (HUGGINGFACE_API_TOKEN)." };
    }
    if (!namespace) {
      return { ok: false, reason: "Hugging Face namespace is not set (HUGGINGFACE_NAMESPACE, or community.publish.namespace admin setting)." };
    }
    return { ok: true };
  }

  async getDatasetStats(identifier: string): Promise<DatasetStats> {
    const url = `${HF_API_URL}/datasets/${identifier}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : undefined,
      });
      if (!response.ok) {
        throw new Error(`Hugging Face API returned ${response.status} for ${identifier}`);
      }
      const body = (await response.json()) as { downloads?: unknown };
      const downloads = typeof body.downloads === "number" ? body.downloads : null;
      return { downloads };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Publish a dataset by creating (or reusing) the repo and committing all
   * files in a single regular-file commit. A write token is required; without
   * one, or on any non-2xx from the Hub, this throws so the caller records a
   * failed publish instead of a fake "published" state.
   */
  async publishDataset(input: PublishDatasetInput): Promise<PublishDatasetResult> {
    if (!HF_TOKEN) {
      throw new HuggingFacePublishError(
        "Hugging Face write token is not configured (HUGGINGFACE_API_TOKEN); cannot push a dataset.",
        true
      );
    }
    const oversize = input.files.find((f) => f.content.length > MAX_FILE_BYTES);
    if (oversize) {
      throw new HuggingFacePublishError(
        `File "${oversize.path}" is ${(oversize.content.length / 1_073_741_824).toFixed(1)} GB, over the ${MAX_FILE_BYTES / 1_073_741_824} GB per-file ceiling.`,
        true
      );
    }
    const slash = input.repoId.indexOf("/");
    if (slash <= 0 || slash === input.repoId.length - 1) {
      throw new HuggingFacePublishError(`Invalid Hugging Face repo id "${input.repoId}" (expected "namespace/name").`, true);
    }
    const namespace = input.repoId.slice(0, slash);
    const name = input.repoId.slice(slash + 1);
    const authHeader = { Authorization: `Bearer ${HF_TOKEN}` };

    // 1) Create the repo. A 409 means it already exists — fine, we reuse it and
    //    fall through to the commit (makes the whole publish safely re-runnable).
    await this.hubFetch(`${HF_API_URL}/repos/create`, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "dataset", name, organization: namespace, private: input.private ?? false }),
    }, [409]);

    // 1b) Assert the intended visibility explicitly on every publish, not just
    //    on create — `repos/create` only applies `private` when it actually
    //    creates the repo, so the 409-reuse path above would otherwise leave a
    //    stale visibility silently winning after a retraction.
    await this.hubFetch(`${HF_API_URL}/datasets/${input.repoId}/settings`, {
      method: "PUT",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ private: input.private ?? false }),
    }, []);

    // 2) Split by size: small files inline as base64 in the commit; large files
    //    go through Git LFS (upload the bytes first, then reference the pointer).
    const regular = input.files.filter((f) => f.content.length < LFS_THRESHOLD_BYTES);
    const large = input.files.filter((f) => f.content.length >= LFS_THRESHOLD_BYTES);
    const lfsPointers = large.length ? await this.uploadLfsObjects(input.repoId, authHeader, large) : [];

    // 3) One commit: header + inline files + LFS pointers.
    const lines = [
      JSON.stringify({ key: "header", value: { summary: input.commitMessage } }),
      ...regular.map((file) =>
        JSON.stringify({ key: "file", value: { path: file.path, encoding: "base64", content: file.content.toString("base64") } })
      ),
      ...lfsPointers.map((p) =>
        JSON.stringify({ key: "lfsFile", value: { path: p.path, algo: "sha256", oid: p.oid, size: p.size } })
      ),
    ];
    await this.hubFetch(
      `${HF_API_URL}/datasets/${input.repoId}/commit/main`,
      { method: "POST", headers: { ...authHeader, "Content-Type": "application/x-ndjson" }, body: lines.join("\n") + "\n" },
      []
    );

    return { repoId: input.repoId, url: `${this.siteOrigin()}/datasets/${input.repoId}` };
  }

  /**
   * Withdraw a published dataset by flipping the Hub repo to private. The repo
   * and its commit history survive — only public reachability is removed — so
   * a retraction stays reversible and the contributor provenance is not
   * destroyed. A 404 is treated as success: the repo is already not publicly
   * reachable, which is the state this call exists to guarantee.
   */
  async unpublishDataset(input: UnpublishDatasetInput): Promise<UnpublishDatasetResult> {
    if (!HF_TOKEN) {
      throw new HuggingFacePublishError(
        "Hugging Face write token is not configured (HUGGINGFACE_API_TOKEN); cannot withdraw a dataset.",
        true
      );
    }
    const slash = input.repoId.indexOf("/");
    if (slash <= 0 || slash === input.repoId.length - 1) {
      throw new HuggingFacePublishError(`Invalid Hugging Face repo id "${input.repoId}" (expected "namespace/name").`, true);
    }
    await this.hubFetch(
      `${HF_API_URL}/datasets/${input.repoId}/settings`,
      { method: "PUT", headers: { Authorization: `Bearer ${HF_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ private: true }) },
      [404]
    );
    return { repoId: input.repoId, mode: "made_private" };
  }

  /**
   * Git-LFS upload for large files: the batch API returns a per-object upload
   * action (usually a presigned object-storage URL); we PUT the bytes there,
   * then the caller references the pointer in the commit. An object the
   * server already has (no `actions.upload`) is skipped — makes re-publish
   * idempotent. Returns `{ path, oid, size }` for each file, in input order.
   */
  private async uploadLfsObjects(
    repoId: string,
    authHeader: { Authorization: string },
    files: PublishFile[]
  ): Promise<{ path: string; oid: string; size: number }[]> {
    const metas = files.map((f) => ({
      file: f,
      oid: createHash("sha256").update(f.content).digest("hex"),
      size: f.content.length,
    }));

    const batchUrl = `${this.siteOrigin()}/datasets/${repoId}.git/info/lfs/objects/batch`;
    const batch = (await this.hubFetchJson(batchUrl, {
      method: "POST",
      headers: {
        ...authHeader,
        "Content-Type": "application/vnd.git-lfs+json",
        Accept: "application/vnd.git-lfs+json",
      },
      body: JSON.stringify({
        operation: "upload",
        transfers: ["basic"],
        objects: metas.map((m) => ({ oid: m.oid, size: m.size })),
      }),
    })) as { objects?: { oid: string; actions?: { upload?: { href: string; header?: Record<string, string> } } }[] };

    const actionByOid = new Map((batch.objects ?? []).map((o) => [o.oid, o.actions?.upload]));
    for (const m of metas) {
      const upload = actionByOid.get(m.oid);
      if (!upload) continue; // server already has this object — nothing to send
      await this.request(
        upload.href,
        { method: "PUT", headers: { ...(upload.header ?? {}), "Content-Length": String(m.size) }, body: m.file.content },
        UPLOAD_TIMEOUT_MS
      );
    }
    return metas.map((m) => ({ path: m.file.path, oid: m.oid, size: m.size }));
  }

  /** Human-facing origin (e.g. `https://huggingface.co`) derived from the API
   * base by stripping a trailing `/api`, so a self-hosted/mirror API URL
   * still yields a correct dataset web URL. */
  private siteOrigin(): string {
    return HF_API_URL.replace(/\/api\/?$/, "");
  }

  /**
   * Refresh the org's public profile card — added 2026-09-10 after it was
   * found stale in prod (missing 2 of 5 real published datasets, and a
   * "3 public datasets / 3,000 released items" summary line that hadn't
   * moved since the 3rd dataset published). An HF org's profile page is
   * backed by a conventionally-named Space repo, `<namespace>/README`
   * (confirmed live by inspecting the org page's own HTML — there is no
   * documented public API for this, it is the same mechanism GitHub uses for
   * a `.github/<org>` profile repo), committed to the exact same way any
   * other Space's `README.md` is. Best-effort: called after a dataset's own
   * HF publish/retract already succeeded, and a failure here must never
   * undo or fail that.
   *
   * `rows` uses the SAME shape and newest-first/top-N contract as GitHub's
   * `updateCatalogReadme` — kept in one visual format across both catalogues
   * rather than the hand-written per-dataset description this card used to
   * carry, which had no automatic source and was exactly why the table went
   * stale (nothing could regenerate prose nobody had written yet).
   */
  async updateOrgProfileCard(rows: CatalogReadmeRow[], top = 10): Promise<void> {
    if (!HF_TOKEN || !HF_NAMESPACE) return; // best-effort; not configured is not an error here
    const repoId = `${HF_NAMESPACE}/README`;
    const authHeader = { Authorization: `Bearer ${HF_TOKEN}` };
    const content = buildOrgProfileCard(rows, top);
    const lines = [
      JSON.stringify({ key: "header", value: { summary: "Update published datasets table" } }),
      JSON.stringify({
        key: "file",
        value: { path: "README.md", encoding: "base64", content: Buffer.from(content, "utf-8").toString("base64") },
      }),
    ];
    await this.hubFetch(
      `${HF_API_URL}/spaces/${repoId}/commit/main`,
      { method: "POST", headers: { ...authHeader, "Content-Type": "application/x-ndjson" }, body: lines.join("\n") + "\n" },
      []
    );
  }

  /** fetch with a hard timeout. Non-2xx (except `okStatuses`, e.g. a 409 "repo
   * exists") throws a HuggingFacePublishError carrying the response text and
   * a `permanent` flag (4xx≠429 can't be fixed by retrying; 5xx/429 can). A
   * network error or timeout (fetch rejects / AbortError) is transient. */
  private async request(url: string, init: RequestInit, timeoutMs: number, okStatuses: number[] = []): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new HuggingFacePublishError(`Request failed for ${url}: ${reason}`, false);
    } finally {
      clearTimeout(timeout);
    }
    if (response.ok || okStatuses.includes(response.status)) return response;
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new HuggingFacePublishError(
      `Hugging Face API ${response.status} for ${url}${detail ? `: ${detail}` : ""}`,
      isPermanentStatus(response.status)
    );
  }

  private async hubFetch(url: string, init: RequestInit, okStatuses: number[]): Promise<void> {
    await this.request(url, init, REQUEST_TIMEOUT_MS, okStatuses);
  }

  private async hubFetchJson(url: string, init: RequestInit, okStatuses: number[] = []): Promise<unknown> {
    const response = await this.request(url, init, REQUEST_TIMEOUT_MS, okStatuses);
    return response.json().catch(() => ({}));
  }
}
