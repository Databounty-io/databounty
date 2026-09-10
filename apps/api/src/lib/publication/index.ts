// SPDX-License-Identifier: Apache-2.0

import { GitHubProvider, gitHubDefaultOwner } from "./github.js";
import { HuggingFaceProvider, huggingFaceDefaultNamespace } from "./hugging-face.js";
import type { PublicationProvider } from "./types.js";

export type { DatasetStats, PublicationProvider } from "./types.js";
export { PublicationError, isPermanentStatus } from "./errors.js";
export { HuggingFacePublishError, huggingFaceLicenseTag, huggingFaceDefaultNamespace } from "./hugging-face.js";
export { gitHubDefaultOwner } from "./github.js";

const HF_API_URL = process.env.HUGGINGFACE_API_URL ?? "https://huggingface.co/api";

/** Public web URL for a Hugging Face dataset slug (`org/name`), derived from
 * the configured API base so a self-hosted/mirror host still resolves
 * correctly. Used to turn a stored `huggingFaceDataset` slug into a link. */
export function huggingFaceDatasetUrl(slug: string): string {
  const origin = HF_API_URL.replace(/\/api\/?$/, "");
  return `${origin}/datasets/${slug}`;
}

type PublicationProviderFactory = () => PublicationProvider;

const publicationProviderFactories: Record<string, PublicationProviderFactory> = {
  huggingface: () => new HuggingFaceProvider(),
  github: () => new GitHubProvider(),
  // A further provider (Kaggle, a self-hosted mirror, an AIKosh-style
  // manual-portal target, ...) adds a factory here and implements
  // `PublicationProvider` in a sibling adapter file. Nothing outside this
  // file should import a concrete adapter directly.
};

/** Every target this rebuild knows how to publish to, in the order a dataset
 * should be pushed to them. Single source of truth for the fan-out. A new
 * provider becomes live by appearing in the factory map above and this list,
 * nowhere else. Deliberately narrower than v1's `PUBLICATION_TARGETS`
 * (which also lists `aikosh`, a manual-portal target out of scope here) even
 * though the shared `PublicationTarget` Prisma enum still carries `aikosh`
 * for schema parity — no factory means it can never be selected. */
export const PUBLICATION_TARGETS = ["huggingface", "github"] as const;
export type PublicationTargetName = (typeof PUBLICATION_TARGETS)[number];

/** Default namespace/owner per target, read once from env at call time (each
 * provider owns its own env var). `services/community-publish.ts` layers an
 * optional admin-setting override (Hugging Face only, matching v1) on top of
 * this. */
export function defaultNamespaceForTarget(target: PublicationTargetName): string {
  return target === "huggingface" ? huggingFaceDefaultNamespace() : gitHubDefaultOwner();
}

const instances = new Map<string, PublicationProvider>();

/** Look up the provider for a target name. Memoized per provider name;
 * callers do not change when the backing provider changes. */
export function publicationProvider(name: string): PublicationProvider {
  const cached = instances.get(name);
  if (cached) return cached;
  const factory = publicationProviderFactories[name];
  if (!factory) throw new Error(`Unknown publication provider: ${name}`);
  const instance = factory();
  instances.set(name, instance);
  return instance;
}
