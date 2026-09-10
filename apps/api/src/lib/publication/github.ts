// SPDX-License-Identifier: Apache-2.0

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
export type { CatalogReadmeRow } from "./types.js";

/**
 * Builds the FULL repo-root `README.md` from a code template (not by
 * round-tripping the live file's markdown) — the static sections rarely
 * change and a template is exact and diffable, where find-and-replace on
 * fetched markdown would be fragile against manual edits or formatting
 * drift. Keep this in sync with the live file's static prose if it is ever
 * hand-edited; the "Published datasets" section below is the only part this
 * function owns going forward.
 */
function buildCatalogReadme(rows: CatalogReadmeRow[], top: number, repoUrl: string): string {
  const sorted = [...rows].sort((a, b) => b.pushedAt.getTime() - a.pushedAt.getTime());
  const shown = sorted.slice(0, top);
  const remaining = sorted.length - shown.length;
  const lastUpdated = sorted[0] ? sorted[0].pushedAt.toISOString().slice(0, 10) : "—";

  const tableRows = shown
    .map(
      (r) =>
        `| ${r.title} | ${r.pushedAt.toISOString().slice(0, 10)} | ${r.itemCount.toLocaleString()} | [Browse files](${r.folder}/) | ${
          r.huggingFaceUrl ? `[Open dataset](${r.huggingFaceUrl})` : "—"
        } |`
    )
    .join("\n");

  const moreLine =
    remaining > 0
      ? `\n\n${remaining} more dataset${remaining === 1 ? "" : "s"} not shown above (newest ${top} listed here) — ` +
        `browse the full catalogue in [\`datasets/\`](${repoUrl}/tree/main/datasets).`
      : "";

  const tableSection = sorted.length
    ? `_Last updated: **${lastUpdated}** (UTC) · ${sorted.length} dataset${sorted.length === 1 ? "" : "s"} published, newest first._\n\n` +
      `| Dataset | Published | Released contributor items | GitHub | Hugging Face |\n` +
      `|---|---|---:|---|---|\n` +
      `${tableRows}${moreLine}`
    : "_No datasets published yet._";

  return `# DataBounty Datasets

> Open, community-built coding datasets — released with clear provenance, licensing, and contributor credit.

[DataBounty](https://databounty.io) is a community programme for building useful datasets. This repository is the public GitHub catalogue for released dataset artifacts. For browsing and large-file tooling, each release is also available on [Hugging Face](https://huggingface.co/databounty-io).

## What is published

Every dataset folder contains only the artifacts approved for that release:

- accepted contributor items;
- a human-readable dataset card;
- a machine-readable manifest with counts, provenance, licence, and attribution metadata; and
- the dataset's licence text when it is bundled.

Sponsor reference material, unpublished submissions, review evidence, credentials, personal data, and application code are never published here.

## Published datasets

${tableSection}

## Repository layout

\`\`\`text
datasets/
  <dataset-slug>/
    README.md          Purpose, scope, source notes, and contributor credits
    data/items.jsonl   One accepted contributor item per line
    manifest.json      Release metadata, counts, provenance, and integrity fields
    LICENSE            Licence for this dataset, where bundled
\`\`\`

### Using a release

- Read the dataset folder's \`README.md\` before use; its stated licence and scope apply to that release.
- Use \`data/items.jsonl\` as the released item stream. Each line is one JSON object.
- Treat \`manifest.json\` as the authoritative machine-readable release record. It records the accepted-item count, dataset contract, contributor-credit policy, licence, and release metadata.
- Use the matching Hugging Face dataset for common dataset-tooling workflows and larger-file access.

## Release and correction policy

DataBounty publishes only release-approved community artifacts. A release is folder-scoped: adding, correcting, or retracting one dataset never replaces another dataset's files.

If you find a metadata error, licensing concern, broken link, or need to request a correction or withdrawal, please [open an issue](${repoUrl}/issues/new) without including credentials, private data, or unpublished material.

Contributions are submitted and reviewed through [DataBounty](https://databounty.io), not through pull requests to this catalogue repository.

## Security and privacy boundary

This repository is intentionally limited to released dataset artifacts. Do not commit access tokens, application configuration, unpublished submissions, or personal data. Publication credentials are held only by DataBounty's deployment secret manager.

Questions about a release or this catalogue: [support@databounty.io](mailto:support@databounty.io).
`;
}

/**
 * Env-driven config for this provider only — see the matching comment in
 * `hugging-face.ts` for why this reads `process.env` directly instead of a
 * shared config module. Names match v1 exactly.
 */
const GITHUB_API_URL = process.env.GITHUB_PUBLICATION_API_URL ?? "https://api.github.com";
const GITHUB_TOKEN = process.env.GITHUB_PUBLICATION_TOKEN ?? "";
const GITHUB_OWNER = process.env.GITHUB_PUBLICATION_OWNER ?? "";
// Every dataset lands as its OWN FOLDER inside this ONE shared repo, rather
// than a repo of its own — see the class doc below for why.
const GITHUB_DATASETS_REPO = process.env.GITHUB_PUBLICATION_REPO ?? "databounty-datasets";
const REQUEST_TIMEOUT_MS = Number(process.env.PUBLICATION_REQUEST_TIMEOUT_MS ?? 10_000);
const UPLOAD_TIMEOUT_MS = Number(process.env.PUBLICATION_UPLOAD_TIMEOUT_MS ?? 300_000);
/**
 * Off by default so today's direct-push behaviour is completely unchanged
 * until an operator turns this on. Flip to `"true"` once the shared
 * `databounty-datasets` repo grows branch protection on `main` (required
 * pull requests) — see the class doc below for what changes when it is on.
 * Parsed the same simple way every other GitHub/HF boolean env var in this
 * codebase is (`=== "true"`, e.g. `SMTP_SECURE` in `../../config.ts`).
 */
const GITHUB_BRANCH_PROTECTED = process.env.GITHUB_PUBLICATION_BRANCH_PROTECTED === "true";

/** The owner (org or user) datasets are published under. Exported so
 * `services/community-publish.ts` can resolve the same default the provider
 * itself would use. */
export function gitHubDefaultOwner(): string {
  return GITHUB_OWNER;
}

/**
 * GitHub's hard ceiling for a blob created through the Git Data API. Files at
 * or above this must go through Git LFS, which needs a separate LFS endpoint
 * and server-side LFS enablement on the repo — deliberately out of scope
 * here, same as v1. An oversize file fails PERMANENTLY with a message naming
 * the file, rather than being silently dropped from the commit.
 */
const MAX_BLOB_BYTES = 100 * 1024 * 1024;

/** GitHub's regular file mode for a non-executable blob. */
const FILE_MODE = "100644";

/**
 * GitHub adapter. Every dataset lands as its OWN FOLDER (`datasets/<slug>/`)
 * inside ONE shared repo — `<owner>/<GITHUB_DATASETS_REPO>` — rather than a
 * repo of its own. That shared repo is the org's dataset store/index; giving
 * every dataset its own repository would need repo-creation rights (org
 * Administration: write) on the token, when a folder-scoped `contents:write`
 * on one named repo is enough and is the narrower credential.
 *
 * The whole export lands as ONE commit built through the Git Data API
 * (blobs → tree → commit → ref). Unlike a one-repo-per-dataset design, the
 * tree here IS built with a `base_tree` (the shared repo's current tree), so
 * a publish only touches this dataset's own folder and never clobbers any
 * other dataset sharing the repo. To keep the same "a withdrawn file must
 * actually disappear" guarantee that a full-replacement tree gave for free,
 * every existing path under this dataset's folder that this run's file list
 * no longer mentions is explicitly deleted from the tree (`sha: null`).
 * Adapted from v1 (`databounty-api/src/lib/publication/github.ts`) after v1
 * itself moved off one-repo-per-dataset to this shared-repo design.
 *
 * Landing that commit onto `main` has two modes, chosen by
 * `GITHUB_PUBLICATION_BRANCH_PROTECTED`. The default, direct-push mode does
 * a compare-and-swap PATCH on `refs/heads/main` (`advanceMain`) — fine while
 * the shared repo takes pushes straight to `main`. Once that repo grows
 * branch protection requiring pull requests, a direct PATCH is rejected by
 * GitHub, so the flag switches to a branch+PR+merge path instead
 * (`landCommitViaPullRequest`): the just-built commit is pushed to a new,
 * uniquely-named branch, a pull request from that branch into `main` is
 * opened, and it is merged immediately — there is no human review step,
 * because the commit was already built and validated the same way the
 * direct-push path builds it, and this repo is a machine-managed dataset
 * store, not a reviewed application codebase. A merge GitHub reports as not
 * completed (pending required checks, unsatisfied required reviews, a
 * conflict) is never reported as a successful publish: it throws a
 * transient `PublicationError` naming the pull request so the job retries
 * rather than silently leaving the dataset unpublished while claiming
 * success. Both modes end in the same place — `main` contains the commit —
 * so `publishDataset`/`unpublishDataset` call one dispatcher (`landCommit`)
 * and do not need to know which mode actually ran.
 */
export class GitHubProvider implements PublicationProvider {
  readonly name = "github";
  readonly kind = "automated" as const;

  async isConfigured(owner: string): Promise<{ ok: boolean; reason?: string }> {
    if (!GITHUB_TOKEN) {
      return { ok: false, reason: "GitHub write token is not set (GITHUB_PUBLICATION_TOKEN)." };
    }
    if (!owner) {
      return { ok: false, reason: "GitHub owner is not set (GITHUB_PUBLICATION_OWNER)." };
    }
    return { ok: true };
  }

  /** `datasets/<slug>` — every published file for one dataset lives under this
   * prefix in the shared repo, so a dataset is fully addressable by folder. */
  private static folderFor(slug: string): string {
    return `datasets/${slug}`;
  }

  /**
   * GitHub has no download counter for a repository. Returning `null` (not 0)
   * is the honest answer: stars and clone counts measure something else
   * entirely and must never be rendered as downloads.
   */
  async getDatasetStats(_identifier: string): Promise<DatasetStats> {
    return { downloads: null };
  }

  async publishDataset(input: PublishDatasetInput): Promise<PublishDatasetResult> {
    if (!GITHUB_TOKEN) {
      throw new PublicationError(
        "GitHub write token is not configured (GITHUB_PUBLICATION_TOKEN); cannot push a dataset.",
        true
      );
    }
    // `owner` is the org/user; the second segment of repoId is the dataset's
    // slug, which is now a FOLDER name, not a repo name — the repo itself is
    // always the fixed, shared GITHUB_DATASETS_REPO.
    const { owner, repo: slug } = this.splitRepoId(input.repoId);
    const repo = GITHUB_DATASETS_REPO;
    const folder = GitHubProvider.folderFor(slug);
    const oversize = input.files.find((f) => f.content.length >= MAX_BLOB_BYTES);
    if (oversize) {
      throw new PublicationError(
        `File "${oversize.path}" is ${(oversize.content.length / 1_048_576).toFixed(1)} MB, at or over GitHub's ${MAX_BLOB_BYTES / 1_048_576} MB per-file API limit. Publishing it needs Git LFS, which this target does not yet enable.`,
        true
      );
    }

    // 1) Create the shared repo if it somehow isn't there yet (normally a
    //    no-op — provisioned once, up front, not per dataset). `auto_init`
    //    gives us a `main` with one commit, so step 2 has a parent to build
    //    on. Deliberately NO per-publish visibility PATCH here: unlike the
    //    old one-repo-per-dataset design, this repo's visibility is shared
    //    across every dataset, so it is a one-time operator decision, never
    //    something a single dataset's publish job may flip on its own.
    await this.ensureRepo(owner, repo, input.private ?? false);

    // One blob per file, paths rewritten under the dataset's folder — deleted
    // paths (dropped from this run) are computed inside `commitFilesToMain`
    // against whatever currently lives under that folder prefix.
    const scopedFiles = input.files.map((f) => ({ ...f, path: `${folder}/${f.path}` }));
    await this.commitFilesToMain(owner, repo, scopedFiles, `${folder}/`, input.commitMessage, slug);

    return { repoId: input.repoId, url: `${this.siteOrigin()}/${owner}/${repo}/tree/main/${folder}` };
  }

  /**
   * Shared blob→tree→commit→land pipeline used by both a dataset's own
   * publish (`publishDataset`, folder-scoped) and the repo-root catalogue
   * README refresh (`updateCatalogReadme`, unscoped — `deletionPrefix: null`
   * touches only the exact paths in `files`, nothing else). Extracted once
   * both needed the identical "read current head → diff a path scope →
   * blob/tree/commit → land" sequence, so there is exactly one place that
   * builds a GitHub commit in this adapter, not two copies to keep in sync.
   *
   * `deletionPrefix`: when set, every existing blob under that prefix not
   * present in `files` this run is explicitly deleted (a `base_tree` overlay
   * otherwise leaves "unmentioned" paths unchanged, not removed) — this is
   * `publishDataset`'s per-folder behavior. `null` means "touch only the
   * given files, never delete anything else" — the README refresh's only
   * concern is the one root file it was given.
   */
  private async commitFilesToMain(
    owner: string,
    repo: string,
    files: PublishFile[],
    deletionPrefix: string | null,
    commitMessage: string,
    landSlug: string
  ): Promise<void> {
    // Current head and its tree — the base this commit overlays onto.
    const ref = (await this.apiJson(`/repos/${owner}/${repo}/git/ref/heads/main`)) as {
      object?: { sha?: string };
    };
    const parentSha = ref.object?.sha;
    if (!parentSha) {
      throw new PublicationError(`GitHub repo ${owner}/${repo} has no main branch to commit onto.`, false);
    }
    const parentCommit = (await this.apiJson(`/repos/${owner}/${repo}/git/commits/${parentSha}`)) as {
      tree?: { sha?: string };
    };
    const baseTreeSha = parentCommit.tree?.sha;
    if (!baseTreeSha) {
      throw new PublicationError(`GitHub commit ${parentSha} in ${owner}/${repo} has no tree.`, false);
    }

    const tree = await this.createBlobs(owner, repo, files);
    let deletions: Array<{ path: string; mode: string; type: "blob"; sha: null }> = [];
    if (deletionPrefix) {
      const existing = (await this.apiJson(`/repos/${owner}/${repo}/git/trees/${baseTreeSha}?recursive=1`)) as {
        tree?: Array<{ path: string; type: string }>;
      };
      const existingPaths = new Set(
        (existing.tree ?? []).filter((e) => e.type === "blob" && e.path.startsWith(deletionPrefix)).map((e) => e.path)
      );
      const newPaths = new Set(tree.map((e) => e.path));
      deletions = [...existingPaths]
        .filter((p) => !newPaths.has(p))
        .map((path) => ({ path, mode: FILE_MODE, type: "blob" as const, sha: null }));
    }

    const created = (await this.apiJson(`/repos/${owner}/${repo}/git/trees`, {
      method: "POST",
      body: JSON.stringify({ base_tree: baseTreeSha, tree: [...tree, ...deletions] }),
    })) as { sha?: string };
    if (!created.sha) throw new PublicationError(`GitHub returned no tree sha for ${owner}/${repo} (${landSlug}).`, false);

    // The commit, then advance `main` only if it still descends from the
    // parent read above. A concurrent commit may have moved the ref
    // meanwhile; force-updating here would erase that winner's change.
    // `advanceMain` turns the non-fast-forward response into a transient
    // error so the caller retries from the new shared-repo head instead.
    const commit = (await this.apiJson(`/repos/${owner}/${repo}/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message: commitMessage, tree: created.sha, parents: [parentSha] }),
    })) as { sha?: string };
    if (!commit.sha) throw new PublicationError(`GitHub returned no commit sha for ${owner}/${repo} (${landSlug}).`, false);

    await this.landCommit(owner, repo, commit.sha, landSlug, "Publish");
  }

  /**
   * Refresh the repo-root `README.md`'s dynamic "Published datasets" table so
   * it reflects reality without a human ever hand-editing it — added
   * 2026-09-10 after the table was found stale in prod (two real published
   * datasets missing, because nothing had ever written to this file: every
   * commit path up to this point only ever touched `datasets/<slug>/*`).
   * Called best-effort after a dataset's own publish/retract succeeds
   * (`community-publish.ts`) — a failure here must never undo or fail that
   * publish, since the dataset itself already genuinely landed.
   *
   * `rows` is the FULL current catalogue (every github-published dataset),
   * already sorted newest-first by the caller (source of truth is
   * `DatasetPublication.pushedAt`, not this file). Only the `top` most recent
   * are listed inline; the rest are reachable via the existing `datasets/`
   * folder listing on GitHub itself — no separate index page to keep in
   * sync, no broken links possible, it just IS the full list.
   */
  async updateCatalogReadme(rows: CatalogReadmeRow[], top = 10): Promise<void> {
    if (!GITHUB_TOKEN || !GITHUB_OWNER) return; // best-effort; not configured yet is not an error here
    const owner = GITHUB_OWNER;
    const repo = GITHUB_DATASETS_REPO;
    const content = buildCatalogReadme(rows, top, `${this.siteOrigin()}/${owner}/${repo}`);
    await this.commitFilesToMain(
      owner,
      repo,
      [{ path: "README.md", content: Buffer.from(content, "utf-8") }],
      null,
      "Update published datasets catalogue",
      "catalogue-readme"
    );
  }

  /**
   * Withdraw by deleting just this dataset's folder from the shared repo — a
   * commit, not a force-push replacement, so the repo's history (and every
   * OTHER dataset's folder) survives untouched. This repo holds many
   * datasets, so retraction can never flip the whole repo private: that
   * would take every other published dataset down with it. A 404 (repo,
   * ref, or an already-empty folder) counts as success (idempotent).
   */
  async unpublishDataset(input: UnpublishDatasetInput): Promise<UnpublishDatasetResult> {
    if (!GITHUB_TOKEN) {
      throw new PublicationError(
        "GitHub write token is not configured (GITHUB_PUBLICATION_TOKEN); cannot withdraw a dataset.",
        true
      );
    }
    const { owner, repo: slug } = this.splitRepoId(input.repoId);
    const repo = GITHUB_DATASETS_REPO;
    const folder = GitHubProvider.folderFor(slug);

    const refResp = await this.request(`/repos/${owner}/${repo}/git/ref/heads/main`, {}, [404]);
    if (refResp.status === 404) return { repoId: input.repoId, mode: "folder_removed" };
    const ref = (await refResp.json().catch(() => ({}))) as { object?: { sha?: string } };
    const parentSha = ref.object?.sha;
    if (!parentSha) return { repoId: input.repoId, mode: "folder_removed" };

    const parentCommit = (await this.apiJson(`/repos/${owner}/${repo}/git/commits/${parentSha}`)) as {
      tree?: { sha?: string };
    };
    const baseTreeSha = parentCommit.tree?.sha;
    if (!baseTreeSha) return { repoId: input.repoId, mode: "folder_removed" };

    const existing = (await this.apiJson(`/repos/${owner}/${repo}/git/trees/${baseTreeSha}?recursive=1`)) as {
      tree?: Array<{ path: string; type: string }>;
    };
    const toDelete = (existing.tree ?? []).filter((e) => e.type === "blob" && e.path.startsWith(`${folder}/`));
    if (toDelete.length === 0) return { repoId: input.repoId, mode: "folder_removed" }; // already gone: idempotent

    const created = (await this.apiJson(`/repos/${owner}/${repo}/git/trees`, {
      method: "POST",
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: toDelete.map((e) => ({ path: e.path, mode: FILE_MODE, type: "blob" as const, sha: null })),
      }),
    })) as { sha?: string };
    if (!created.sha) throw new PublicationError(`GitHub returned no tree sha retracting ${owner}/${repo}/${folder}.`, false);

    const commit = (await this.apiJson(`/repos/${owner}/${repo}/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message: `Retract ${slug}`, tree: created.sha, parents: [parentSha] }),
    })) as { sha?: string };
    if (!commit.sha) throw new PublicationError(`GitHub returned no commit sha retracting ${owner}/${repo}/${folder}.`, false);

    await this.landCommit(owner, repo, commit.sha, slug, "Retract");
    return { repoId: input.repoId, mode: "folder_removed" };
  }

  /** Compare-and-swap the shared repository's branch. GitHub returns 422 when
   * another publish moved `main` after our parent was read. That is retryable,
   * not a permanent provider error: the next job attempt rebuilds its overlay
   * from the new head and therefore preserves both dataset folders. */
  private async advanceMain(owner: string, repo: string, commitSha: string): Promise<void> {
    const response = await this.request(
      `/repos/${owner}/${repo}/git/refs/heads/main`,
      { method: "PATCH", body: JSON.stringify({ sha: commitSha, force: false }) },
      [422]
    );
    if (response.status === 422) {
      throw new PublicationError(
        `GitHub repo ${owner}/${repo} changed during publication; retrying from the latest main branch preserves concurrent dataset commits.`,
        false
      );
    }
  }

  /**
   * Land `commitSha` onto `main` — the single call site `publishDataset` and
   * `unpublishDataset` use, so neither needs to know which of the two
   * landing modes actually ran. Direct-push (`advanceMain`) is the default;
   * `landCommitViaPullRequest` is used once `GITHUB_PUBLICATION_BRANCH_PROTECTED`
   * is on, because a direct PATCH to `refs/heads/main` is exactly what
   * branch protection is configured to reject.
   */
  private async landCommit(owner: string, repo: string, commitSha: string, slug: string, action: "Publish" | "Retract"): Promise<void> {
    if (!GITHUB_BRANCH_PROTECTED) {
      await this.advanceMain(owner, repo, commitSha);
      return;
    }
    await this.landCommitViaPullRequest(owner, repo, commitSha, slug, action);
  }

  /**
   * Branch+PR+merge landing path for a shared repo whose `main` requires
   * pull requests. `commitSha` was already built by the same blob→tree→commit
   * steps the direct-push path uses, so there is nothing left to review here
   * — this repo is a machine-managed dataset store, not an application
   * codebase a human reviews before merge. The PR exists only because
   * branch protection demands one as the mechanism to land a commit, not
   * because a human gate is wanted.
   *
   * Branch-name collision on retry: a retried publish (after a transient
   * failure elsewhere in this same attempt) must not collide with a branch
   * a still-in-flight or previously-failed attempt already created, which
   * would 422 on the ref-create call. Rather than special-casing "branch
   * already exists", the branch name carries enough entropy — a millisecond
   * timestamp plus a random suffix — that two attempts for the same dataset
   * essentially never collide, matching how `advanceMain` already leans on
   * "retry from a fresh read" rather than explicit conflict recovery.
   */
  private async landCommitViaPullRequest(
    owner: string,
    repo: string,
    commitSha: string,
    slug: string,
    action: "Publish" | "Retract"
  ): Promise<void> {
    // Best-effort cleanup of any branch+PR this same dataset left behind on a
    // PRIOR failed attempt (e.g. the PR couldn't be created/merged and the
    // job retried from scratch, per the unique-name-per-attempt design
    // below). Without this, every retry piles up one more open PR and one
    // more stale branch — harmless to `main`, but real operational debris
    // that only grows the longer something stays broken (observed directly:
    // repeated retries during a real credential outage left multiple
    // abandoned `databounty-publish/<slug>-*` branches/PRs). Closing a PR
    // that was already merged is a no-op GitHub rejects harmlessly; deleting
    // an already-gone branch 404s harmlessly — both swallowed, since this
    // must never fail the publish attempt that is actually in progress.
    try {
      // GitHub's `head` list filter needs an EXACT branch name — the
      // timestamp+random suffix makes every attempt's name unique, so an
      // exact filter would never match a prior attempt. List open PRs
      // against `main` and filter client-side instead.
      //
      // `databounty-datasets` is a real public repo with PRs enabled
      // (`has_pull_requests`, `pull_request_creation_policy: "all"`), so
      // external contributors can open their own PRs there — this cleanup
      // (and the merge call below) must NEVER touch anything this job did
      // not itself create. Branch-name prefix alone is not enough: filter
      // additionally on the PR's AUTHOR being this token's own account, so
      // a coincidental branch-name collision from an external PR can never
      // be closed or deleted by this job. The merge call two steps below is
      // separately safe by construction — it only ever acts on `pr.number`,
      // the PR this exact call just opened, never a listed/matched one.
      const viewer = (await this.apiJson(`/user`)) as { login?: string };
      const openPrs = (await this.apiJson(`/repos/${owner}/${repo}/pulls?state=open&base=main&per_page=100`)) as Array<{
        number: number;
        head?: { ref?: string };
        user?: { login?: string };
      }>;
      const stalePrefix = `databounty-publish/${slug}-`;
      const stale = (Array.isArray(openPrs) ? openPrs : []).filter(
        (p) => p.head?.ref?.startsWith(stalePrefix) && viewer.login && p.user?.login === viewer.login
      );
      for (const p of stale) {
        await this.request(`/repos/${owner}/${repo}/pulls/${p.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) }, [404, 422]).catch(() => undefined);
        if (p.head?.ref) {
          await this.request(`/repos/${owner}/${repo}/git/refs/heads/${p.head.ref}`, { method: "DELETE" }, [404, 422]).catch(() => undefined);
        }
      }
    } catch {
      // Listing itself failing (network blip, rate limit) must not block
      // this attempt — the stale branch/PR just lingers one more cycle.
    }

    const branch = `databounty-publish/${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    await this.apiJson(`/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitSha }),
    });

    const pr = (await this.apiJson(`/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: `${action} dataset ${slug}`,
        head: branch,
        base: "main",
        body:
          `Automated ${action.toLowerCase()} of the \`datasets/${slug}\` folder, opened by DataBounty's ` +
          `publication job because \`main\` on this repo requires pull requests. This pull request is ` +
          `merged immediately by the same job — it is a mechanical landing step, not a human review gate.`,
      }),
    })) as { number?: number; html_url?: string };
    if (!pr.number) {
      throw new PublicationError(`GitHub returned no pull request number opening ${action.toLowerCase()} PR for ${owner}/${repo} branch "${branch}".`, false);
    }
    const prLabel = pr.html_url ?? `${owner}/${repo}#${pr.number}`;

    // 405/409 are GitHub's "not mergeable right now" responses (pending
    // required status checks, unsatisfied required reviews, a merge
    // conflict) — accepted here so the body can be inspected instead of
    // being turned into an opaque generic-status error by `request`.
    const mergeResponse = await this.request(
      `/repos/${owner}/${repo}/pulls/${pr.number}/merge`,
      { method: "PUT", body: JSON.stringify({ merge_method: "squash" }) },
      [405, 409]
    );
    const mergeBody = (await mergeResponse.json().catch(() => ({}))) as { merged?: boolean; message?: string };
    if (mergeBody.merged !== true) {
      // Never report this landing as done when GitHub did not confirm a
      // merge (trust-honesty invariant) — the caller's commit never reached
      // `main`, so the job must retry rather than record success.
      throw new PublicationError(
        `GitHub pull request ${prLabel} did not merge${mergeBody.message ? ` (${mergeBody.message})` : ""}; ` +
          `retrying will re-check whether it can now be merged.`,
        false
      );
    }

    // Best-effort branch cleanup. A branch left behind after a successful
    // merge is cosmetic — it never reappears in `main`'s tree — so a
    // failure to delete it must never fail the publish that already
    // succeeded.
    await this.request(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, { method: "DELETE" }, [404, 422]).catch(() => undefined);
  }

  /**
   * Create the repo unless it already exists. An owner may be an organisation
   * or a user and the create endpoints differ, so an org create that 404s
   * falls back to the authenticated-user endpoint — but ONLY when the
   * configured owner IS the token's own account (otherwise a misconfigured
   * org would silently produce a stray repo elsewhere).
   */
  private async ensureRepo(owner: string, repo: string, isPrivate: boolean): Promise<void> {
    const existing = await this.request(`/repos/${owner}/${repo}`, {}, [404]);
    if (existing.status !== 404) return;

    const body = JSON.stringify({
      name: repo,
      private: isPrivate,
      auto_init: true,
      description: "Dataset published by DataBounty.",
      has_issues: true,
      has_wiki: false,
    });
    const asOrg = await this.request(`/orgs/${owner}/repos`, { method: "POST", body }, [404, 422]);
    if (asOrg.ok || asOrg.status === 422) return;

    const viewer = (await this.apiJson(`/user`)) as { login?: string };
    if (viewer.login?.toLowerCase() !== owner.toLowerCase()) {
      throw new PublicationError(
        `GitHub owner "${owner}" is not an organisation this token can create repositories in, and it is not the token's own account ("${viewer.login ?? "unknown"}"). Fix GITHUB_PUBLICATION_OWNER or the token's org access.`,
        true
      );
    }
    await this.api(`/user/repos`, { method: "POST", body }, [422]);
  }

  /** Upload each file as a blob and return the tree entries referencing them.
   * Sequential on purpose: a dataset can carry thousands of attachments, and
   * firing them all at once would trip GitHub's secondary rate limits. */
  private async createBlobs(
    owner: string,
    repo: string,
    files: PublishFile[]
  ): Promise<Array<{ path: string; mode: string; type: "blob"; sha: string }>> {
    const entries: Array<{ path: string; mode: string; type: "blob"; sha: string }> = [];
    for (const file of files) {
      const blob = (await this.apiJson(
        `/repos/${owner}/${repo}/git/blobs`,
        { method: "POST", body: JSON.stringify({ content: file.content.toString("base64"), encoding: "base64" }) },
        [],
        UPLOAD_TIMEOUT_MS
      )) as { sha?: string };
      if (!blob.sha) throw new PublicationError(`GitHub returned no blob sha for "${file.path}".`, false);
      entries.push({ path: file.path, mode: FILE_MODE, type: "blob", sha: blob.sha });
    }
    return entries;
  }

  private splitRepoId(repoId: string): { owner: string; repo: string } {
    const slash = repoId.indexOf("/");
    if (slash <= 0 || slash === repoId.length - 1) {
      throw new PublicationError(`Invalid GitHub repo id "${repoId}" (expected "owner/name").`, true);
    }
    return { owner: repoId.slice(0, slash), repo: repoId.slice(slash + 1) };
  }

  /** Human-facing origin (e.g. `https://github.com`), derived from the API
   * base so a GitHub Enterprise host still yields correct repo URLs. */
  private siteOrigin(): string {
    return GITHUB_API_URL.replace(/^https:\/\/api\.github\.com$/, "https://github.com").replace(/\/api\/v3\/?$/, "");
  }

  /** fetch with a hard timeout and GitHub's required headers. Non-2xx (except
   * `okStatuses`) throws a PublicationError whose `permanent` flag follows
   * the shared 4xx≠429 rule; a network error or timeout is transient. */
  private async request(path: string, init: RequestInit = {}, okStatuses: number[] = [], timeoutMs?: number): Promise<Response> {
    const url = path.startsWith("http") ? path : `${GITHUB_API_URL}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs ?? REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "databounty-publication",
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new PublicationError(`Request failed for ${url}: ${reason}`, false);
    } finally {
      clearTimeout(timeout);
    }
    if (response.ok || okStatuses.includes(response.status)) return response;
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new PublicationError(
      `GitHub API ${response.status} for ${url}${detail ? `: ${detail}` : ""}`,
      this.isPermanent(response, detail)
    );
  }

  /**
   * GitHub signals BOTH its primary and secondary rate limits with **403**,
   * not 429 — and a dataset with a few thousand attachments uploads a blob at
   * a time, which is exactly what trips the secondary limit. A 403 is treated
   * as TRANSIENT when GitHub says the limit is the reason (`retry-after`
   * header, `x-ratelimit-remaining: 0`, or rate-limit wording in the body);
   * any other 403 (a genuinely missing scope, SAML enforcement) stays
   * permanent.
   */
  private isPermanent(response: Response, body: string): boolean {
    if (response.status !== 403) return isPermanentStatus(response.status);
    if (response.headers.get("retry-after")) return false;
    if (response.headers.get("x-ratelimit-remaining") === "0") return false;
    return !/rate limit|secondary rate|abuse detection/i.test(body);
  }

  private async api(path: string, init: RequestInit = {}, okStatuses: number[] = []): Promise<void> {
    await this.request(path, init, okStatuses);
  }

  private async apiJson(path: string, init: RequestInit = {}, okStatuses: number[] = [], timeoutMs?: number): Promise<unknown> {
    const response = await this.request(path, init, okStatuses, timeoutMs);
    return response.json().catch(() => ({}));
  }
}
