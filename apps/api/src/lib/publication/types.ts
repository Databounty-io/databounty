// SPDX-License-Identifier: Apache-2.0

/**
 * Publication provider abstraction. Product/API code never talks to a
 * concrete dataset-hosting provider directly; it goes through this port so
 * Hugging Face and GitHub today, and another provider later, can be added
 * without touching the publish job or the routes that serve publication
 * state. Ported from v1 (`databounty-api/src/lib/publication/types.ts`),
 * trimmed to the two providers this rebuild actually wires (Hugging Face,
 * GitHub) — the manual-portal AIKosh provider is intentionally out of scope.
 */
export interface DatasetStats {
  /** Null when the provider has no download-count concept, not zero. */
  downloads: number | null;
}

/** One file to include in a dataset publication. `content` is the raw bytes;
 * text files (JSONL, README) are just UTF-8 buffers. */
export interface PublishFile {
  /** Repo-relative path, e.g. `data/items.jsonl` or `README.md`. */
  path: string;
  content: Buffer;
}

export interface PublishDatasetInput {
  /** Fully-resolved repo id `namespace/name` (the caller owns slug policy). */
  repoId: string;
  files: PublishFile[];
  /** Human-readable commit summary recorded on the provider. */
  commitMessage: string;
  /** Default false — community datasets are public. */
  private?: boolean;
}

export interface PublishDatasetResult {
  /** The repo id the dataset now lives at (echoes input.repoId). */
  repoId: string;
  /** Public web URL of the published dataset. */
  url: string;
}

export interface UnpublishDatasetInput {
  /** Fully-resolved repo id `namespace/name` of the published dataset. */
  repoId: string;
}

export interface UnpublishDatasetResult {
  /** The repo id whose public access was removed (echoes input.repoId). */
  repoId: string;
  /**
   * How access was removed. `made_private` keeps the repo and its history at
   * the provider but takes it off the public web — deliberately reversible,
   * and it preserves the contributor provenance the platform is accountable
   * for. A provider with no private mode would add its own variant here
   * rather than silently hard-deleting. `folder_removed` is for a provider
   * where many datasets share ONE repo (GitHub): retracting one dataset must
   * not flip visibility for every other dataset sharing that repo, so it
   * removes just that dataset's folder from the tree (as a commit, so
   * history/provenance survives) instead.
   */
  mode: "made_private" | "folder_removed";
}

export interface PublicationProvider {
  /** Provider id persisted on the DatasetPublication row (`huggingface`, `github`). */
  readonly name: string;

  /**
   * `automated` — the platform pushes and a provider response proves the
   * result. `assisted_manual` — no ingest API exists, so the provider can
   * only produce a bundle (`prepareBundle`) and a human completes the
   * upload; the recorded `published` state is then a human attestation, and
   * every surface must label it as one. Read by the job runner to decide
   * which path to run, and by an admin surface to decide which controls to
   * show. Both providers in this rebuild are `automated`.
   */
  readonly kind: "automated" | "assisted_manual";

  /**
   * Whether this target is currently usable, and if not, why — in operator
   * language. Single source of truth for "is this set up": the enqueue-time
   * filter, the job's pre-flight check, and any admin panel all call this
   * rather than each re-deriving the answer from env and drifting apart.
   * `namespace` is the target's configured namespace/owner.
   */
  isConfigured(namespace: string): Promise<{ ok: boolean; reason?: string }>;

  /**
   * Fetch current public stats for an already-published dataset. `identifier`
   * is the provider-specific dataset reference (e.g. a Hugging Face repo id
   * like `org/dataset-name`). Throws on a provider/network error; callers
   * must not treat a throw as "zero downloads".
   */
  getDatasetStats(identifier: string): Promise<DatasetStats>;

  /**
   * Create/update the dataset repo and commit `files` to it. Throws on any
   * provider, auth, or network error — callers MUST NOT treat a throw as a
   * successful publish (trust-honesty invariant). Idempotent to re-run: an
   * already-created repo is reused, and re-committing identical content is a
   * no-op commit.
   */
  publishDataset?(input: PublishDatasetInput): Promise<PublishDatasetResult>;

  /**
   * Remove public access to an already-published dataset (admin retraction).
   * Throws on any provider, auth, or network error. Callers MUST NOT treat a
   * throw as a successful retraction (trust-honesty invariant): a dataset
   * that is still publicly reachable must never be recorded as retracted.
   * Idempotent to re-run: withdrawing an already-withdrawn dataset succeeds.
   */
  unpublishDataset?(input: UnpublishDatasetInput): Promise<UnpublishDatasetResult>;
}
