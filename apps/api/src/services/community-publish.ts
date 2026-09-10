// SPDX-License-Identifier: Apache-2.0

import { BountyKind, CommunityPublicationStatus, PublicationTarget, SubmissionStatus, KarmaEventType, type Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { awardKarma } from "./karma.js";
import { writeAuditLog } from "../lib/audit-log.js";
import { getAdminSetting } from "./admin-settings.js";
import { buildContributorCredits, renderContributorCredits } from "./reputation.js";
import {
  PUBLICATION_TARGETS,
  PublicationError,
  defaultNamespaceForTarget,
  huggingFaceLicenseTag,
  publicationProvider,
  type PublicationTargetName,
} from "../lib/publication/index.js";
import { datasetLicense } from "../lib/publication/license-texts.js";
import type { PublishFile } from "../lib/publication/types.js";
import { storage } from "../lib/storage/index.js";
import { dbJobQueue } from "./jobs.js";

/** Off by default -- production datasets are meant to be public. Set to
 * "true" only in an environment whose publication targets point at
 * dev-only repos/orgs, so a test publish there never lands public. */
const PUBLISH_PRIVATE = process.env.COMMUNITY_PUBLISH_PRIVATE === "true";

export async function recordDatasetPublication(params: {
  bountyId: string;
  target: PublicationTarget;
  status: CommunityPublicationStatus;
  externalId?: string;
  url?: string;
  lastError?: string;
  publishedByUserId?: string;
  bundleArtifactId?: string;
}) {
  return prisma.datasetPublication.upsert({
    where: {
      bountyId_target: {
        bountyId: params.bountyId,
        target: params.target,
      },
    },
    create: {
      bountyId: params.bountyId,
      target: params.target,
      status: params.status,
      externalId: params.externalId,
      url: params.url,
      lastError: params.lastError,
      publishedByUserId: params.publishedByUserId,
      bundleArtifactId: params.bundleArtifactId,
      pushedAt: params.status === CommunityPublicationStatus.published ? new Date() : null,
    },
    update: {
      status: params.status,
      externalId: params.externalId,
      url: params.url,
      lastError: params.lastError,
      publishedByUserId: params.publishedByUserId,
      bundleArtifactId: params.bundleArtifactId,
      pushedAt: params.status === CommunityPublicationStatus.published ? new Date() : undefined,
    },
  });
}

export async function attestPublication(params: {
  bountyId: string;
  target: PublicationTarget;
  url: string;
  externalId: string;
  adminUserId: string;
  context?: { ip?: string; userAgent?: string };
}) {
  const publication = await prisma.$transaction(async (tx) => {
    const pub = await tx.datasetPublication.upsert({
      where: {
        bountyId_target: {
          bountyId: params.bountyId,
          target: params.target,
        },
      },
      create: {
        bountyId: params.bountyId,
        target: params.target,
        status: CommunityPublicationStatus.published,
        url: params.url,
        externalId: params.externalId,
        publishedByUserId: params.adminUserId,
        pushedAt: new Date(),
      },
      update: {
        status: CommunityPublicationStatus.published,
        url: params.url,
        externalId: params.externalId,
        publishedByUserId: params.adminUserId,
        pushedAt: new Date(),
      },
    });

    await tx.bounty.update({
      where: { id: params.bountyId },
      data: {
        publicationStatus: CommunityPublicationStatus.published,
        huggingFaceDataset: params.target === PublicationTarget.huggingface ? params.externalId : undefined,
      },
    });

    await writeAuditLog(tx, {
      actorUserId: params.adminUserId,
      action: "community.dataset.published_attested",
      targetType: "DatasetPublication",
      targetId: pub.id,
      after: { bountyId: params.bountyId, target: params.target, url: params.url, externalId: params.externalId },
      ip: params.context?.ip,
      userAgent: params.context?.userAgent,
    });

    return pub;
  });

  return publication;
}

// ---------------------------------------------------------------------------
// Automated push (Hugging Face / GitHub). Everything below this line is new:
// it fans out to `lib/publication/*` providers instead of only recording a
// row, and follows the same fail-closed contract as the execution sandbox
// (no credential → an honest `not_configured` outcome, never a fake pass).
// The two functions above stay unchanged and are still how an admin records
// a manual/attested publish for a target with no push automation.
// ---------------------------------------------------------------------------

/** Repo-relative path of the items file. Shared by the commit and by the
 * README's `configs:` block so the pinned path can never drift from the file
 * actually written. */
const ITEMS_PATH = "data/items.jsonl";

/** Bounty fields the publish flow needs. Selected explicitly so a schema
 * change that drops one fails to compile here, same discipline as v1's
 * `PUBLISH_BOUNTY_SELECT`. */
export const PUBLISH_BOUNTY_SELECT = {
  id: true,
  title: true,
  description: true,
  kind: true,
  requesterUserId: true,
  communityRequesterUserId: true,
  publicationStatus: true,
  huggingFaceDataset: true,
  communityLicense: true,
  communityLicenseUrl: true,
  language: true,
  framework: true,
  targetItems: true,
  finalAcceptedItems: true,
} as const;

type PublishBounty = Prisma.BountyGetPayload<{ select: typeof PUBLISH_BOUNTY_SELECT }>;

/** Runtime publish config from admin settings (read fresh, same pattern used
 * elsewhere in this service for karma settings). `enabled` is a platform
 * master switch an admin can flip with no deploy; `namespace` is a
 * Hugging-Face-only override of the `HUGGINGFACE_NAMESPACE` env default
 * (matching v1). No admin setting is registered in `services/admin-settings.ts`
 * yet — `getAdminSetting` falls back to the given default for an
 * unregistered key, so this works today and gets a proper catalog entry (for
 * admin-UI visibility) as a follow-up by whoever owns that file next. */
async function getPublishSettings(): Promise<{ enabled: boolean; namespace: string }> {
  const [enabled, namespaceOverride] = await Promise.all([
    getAdminSetting<boolean>("community.publish.enabled", false),
    getAdminSetting<string>("community.publish.namespace", ""),
  ]);
  return { enabled, namespace: namespaceOverride?.trim() || "" };
}

/** Namespace/owner a target should publish under: the admin-setting override
 * (Hugging Face only) if set, else the provider's own env default. */
function resolveNamespace(target: PublicationTargetName, settingsNamespace: string): string {
  if (target === "huggingface" && settingsNamespace) return settingsNamespace;
  return defaultNamespaceForTarget(target);
}

/** Derive a repo name from the bounty title, with a short id suffix so two
 * bounties with the same title never collide on one repo. Ported from v1's
 * `slugForBounty`. */
function slugForBounty(bounty: Pick<PublishBounty, "id" | "title">): string {
  const base = bounty.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "dataset";
  return `${base}-${bounty.id.slice(0, 8)}`;
}

/** Map an item count to Hugging Face's fixed `size_categories` bucket
 * vocabulary (an out-of-vocabulary value is a commit 400). */
function sizeCategory(n: number): string {
  if (n < 1_000) return "n<1K";
  if (n < 10_000) return "1K<n<10K";
  if (n < 100_000) return "10K<n<100K";
  if (n < 1_000_000) return "100K<n<1M";
  if (n < 10_000_000) return "1M<n<10M";
  if (n < 100_000_000) return "10M<n<100M";
  if (n < 1_000_000_000) return "100M<n<1B";
  return "n>1B";
}

/** Machine-readable provenance/credit sidecar, `manifest.json`. */
interface PublishManifest {
  bountyId: string;
  title: string;
  license: string | null;
  licenseUrl: string | null;
  language: string;
  framework: string;
  acceptedItems: number;
  generatedAt: string;
  contributors: { credited: string[]; anonymizedCount: number };
  /** What became of contributor file uploads on this run. `published <
   * resolved` means the cumulative size cap truncated the set — stated here so
   * the manifest can never imply a file is present that was not pushed. */
  attachments: { resolved: number; published: number };
}

/** Exported for tests only: the credit-manifest wiring (which contributors get
 * named on a published dataset) is exactly what this function does, so a test
 * asserting it needs to call it directly rather than reach into a private
 * function. */
export async function buildManifest(
  bounty: PublishBounty,
  acceptedItems: number,
  attachments: { resolved: number; published: number } = { resolved: 0, published: 0 }
): Promise<PublishManifest> {
  const credits = (await buildContributorCredits(bounty.id, bounty.kind)) ?? { credited: [], anonymizedCount: 0 };
  return {
    bountyId: bounty.id,
    title: bounty.title,
    license: bounty.communityLicense,
    licenseUrl: bounty.communityLicenseUrl,
    language: bounty.language,
    framework: bounty.framework,
    acceptedItems,
    generatedAt: new Date().toISOString(),
    contributors: credits,
    attachments,
  };
}

/**
 * A Hugging Face-flavoured dataset card (`README.md`). The YAML front matter
 * carries the license tag Hugging Face renders and the `configs:` pin that
 * keeps the Hub's dataset viewer from trying to merge `manifest.json` in as a
 * second, incompatible split. GitHub gets the same file — it renders as a
 * plain repo README there, front matter and all, which is harmless. Credit
 * lines are rendered by `renderContributorCredits` (services/reputation.ts),
 * built THIS session — never re-derived here, so the honesty rules around
 * opt-out/no-handle contributors live in exactly one place.
 */
export function datasetCard(bounty: PublishBounty, manifest: PublishManifest): string {
  const licenseTag = huggingFaceLicenseTag(bounty.communityLicense);
  const slugTag = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const tags = [...new Set(
    ["databounty", "community", slugTag(bounty.language), slugTag(bounty.framework)].filter((t) => t && t !== "none" && t !== "n-a")
  )];
  const front = [
    "---",
    licenseTag ? `license: ${licenseTag}` : undefined,
    `size_categories:\n  - ${sizeCategory(manifest.acceptedItems)}`,
    "tags:",
    ...tags.map((t) => `  - ${t}`),
    "configs:",
    "  - config_name: default",
    "    data_files:",
    "      - split: train",
    `        path: ${ITEMS_PATH}`,
    "---",
  ].filter(Boolean).join("\n");
  return [
    front,
    "",
    `# ${bounty.title}`,
    "",
    bounty.description || "",
    "",
    "## About",
    "",
    "This dataset was produced by the DataBounty community and published here as part of an open, karma-only program.",
    "",
    `- **Accepted items:** ${manifest.acceptedItems}`,
    `- **Language:** ${bounty.language}`,
    `- **Framework:** ${bounty.framework}`,
    bounty.communityLicense ? `- **License:** ${bounty.communityLicense}${bounty.communityLicenseUrl ? ` (${bounty.communityLicenseUrl})` : ""}` : undefined,
    "",
    "## Contributors",
    "",
    renderContributorCredits(manifest.contributors),
    "",
    "## Files",
    "",
    `- \`${ITEMS_PATH}\` — the accepted dataset items (one JSON object per line).`,
    "- `manifest.json` — machine-readable provenance, license, and credit metadata.",
    manifest.attachments.published
      ? `- \`data/contributor-items/\` — ${manifest.attachments.published} contributor-uploaded file(s); an item's file field holds the path to its file.`
      : undefined,
    manifest.attachments.published < manifest.attachments.resolved
      ? `\n**Partial upload set.** ${manifest.attachments.published} of ${manifest.attachments.resolved} contributor files are included; the rest exceeded this run's cumulative size cap. An item whose file was omitted keeps the raw artifact id rather than a path to a file that is not here.`
      : undefined,
    "",
  ].filter((line) => line !== undefined).join("\n");
}

/**
 * The GitHub flavour of the same dataset. Deliberately NOT the Hugging Face
 * card: HF's YAML front matter (`configs:`, `size_categories:`, the `license:`
 * tag) exists to drive the Hub's dataset viewer and means nothing on GitHub,
 * where it renders as a metadata block a reader has to scroll past. The body
 * is the same information, plus a Files table, because a GitHub visitor lands
 * on the README with no viewer to explain the layout.
 *
 * Credit lines still come from `renderContributorCredits` — the opt-out and
 * no-handle honesty rules live in exactly one place and are not re-derived.
 */
export function gitHubDatasetCard(bounty: PublishBounty, manifest: PublishManifest): string {
  const license = datasetLicense(bounty.communityLicense);
  const licenseLine = license
    ? `[${license.name}](${license.url}) — full text in [\`LICENSE\`](LICENSE).`
    : bounty.communityLicense
      ? `${bounty.communityLicense}${bounty.communityLicenseUrl ? ` (${bounty.communityLicenseUrl})` : ""}. Full text is not bundled in this repository.`
      : "Not specified.";
  return [
    `# ${bounty.title}`,
    "",
    bounty.description || "",
    "",
    "Produced by the DataBounty community and published as part of an open, karma-only program.",
    "",
    "## At a glance",
    "",
    "| | |",
    "|---|---|",
    `| Accepted items | ${manifest.acceptedItems} |`,
    `| Language | ${bounty.language} |`,
    `| Framework | ${bounty.framework} |`,
    `| License | ${licenseLine} |`,
    `| Generated | ${manifest.generatedAt} |`,
    "",
    "## Files",
    "",
    "| Path | What it is |",
    "|---|---|",
    `| \`${ITEMS_PATH}\` | The accepted dataset items, one JSON object per line (JSONL). |`,
    "| `manifest.json` | Machine-readable provenance, license, and credit metadata. |",
    ...(license ? ["| `LICENSE` | The full license text this dataset is released under. |"] : []),
    ...(manifest.attachments.published
      ? [`| \`data/contributor-items/\` | ${manifest.attachments.published} file(s) contributors uploaded. An item's file field holds the path to its file here. |`]
      : []),
    "",
    ...(manifest.attachments.published < manifest.attachments.resolved
      ? [
          "> **Partial upload set.** " +
            `${manifest.attachments.published} of ${manifest.attachments.resolved} contributor files are included; the rest exceeded this publish run's cumulative size cap. ` +
            "An item whose file was not included keeps the raw artifact id instead of a path, so it is visibly unresolved rather than pointing at a file that is not here.",
          "",
        ]
      : []),
    "## Contributors",
    "",
    renderContributorCredits(manifest.contributors),
    "",
  ].join("\n");
}

/**
 * `.gitattributes` for a published dataset repo. Marks the items file as
 * generated so GitHub collapses it in diffs and leaves it out of the language
 * bar — without this a JSONL export makes every dataset repo look like it is
 * written in whatever GitHub guesses JSONL to be, and a re-publish renders as
 * a thousands-of-lines diff nobody can review.
 */
const GITATTRIBUTES = [
  "# Generated by DataBounty; not hand-edited.",
  `${ITEMS_PATH} linguist-generated=true -diff`,
  "manifest.json linguist-generated=true",
  "",
].join("\n");

/**
 * The file set for one target. Both targets share the data and the manifest —
 * the same bytes, so the two publications are verifiably the same dataset —
 * and differ only in the repository furniture each host actually reads.
 *
 * GitHub additionally gets a real `LICENSE`. GitHub detects a repository's
 * license by matching that file against known texts; a repo naming its
 * license only in prose is read as "all rights reserved", which is the
 * opposite of what an open dataset intends. When the license is one we do not
 * bundle a verbatim text for, LICENSE is omitted rather than guessed, and the
 * README says so.
 */
export function buildFilesForTarget(
  target: PublicationTargetName,
  bounty: PublishBounty,
  manifest: PublishManifest,
  jsonl: string,
  attachments: Array<{ path: string; content: Buffer }> = []
): PublishFile[] {
  const shared: PublishFile[] = [
    { path: ITEMS_PATH, content: Buffer.from(jsonl) },
    { path: "manifest.json", content: Buffer.from(JSON.stringify(manifest, null, 2)) },
    // Contributor uploads, under `data/` alongside the items that name them.
    // Identical bytes on every target: the two publications must be the same
    // dataset, not two different subsets of one.
    ...attachments.map((a) => ({ path: `data/${a.path}`, content: a.content })),
  ];
  if (target === "huggingface") {
    return [...shared, { path: "README.md", content: Buffer.from(datasetCard(bounty, manifest)) }];
  }
  const license = datasetLicense(bounty.communityLicense);
  return [
    ...shared,
    { path: "README.md", content: Buffer.from(gitHubDatasetCard(bounty, manifest)) },
    { path: ".gitattributes", content: Buffer.from(GITATTRIBUTES) },
    ...(license ? [{ path: "LICENSE", content: Buffer.from(license.text) }] : []),
  ];
}

/** The accepted-items export, one JSON object per line — the same shape a
 * sponsor/requester export would serve. Scoped deliberately to text/JSON
 * payload fields only: resolving `role: "file"` attachments into pushed
 * bytes (v1's `buildPublishBundle`) is not ported here — see the gap noted
 * in the handoff report. */
type PublishSubmission = {
  id: string;
  title: string;
  payloadJson: Prisma.JsonValue;
  contributorUserId: string;
  createdAt: Date;
};

/**
 * Select the contributor rows that may enter a public dataset.
 *
 * A pool can contain more accepted rows than its target because of legacy
 * imports or a historical concurrent close-out race. Publication is the last
 * fail-closed boundary: it exports at most `targetItems`, in a stable order,
 * instead of silently making the public dataset larger than its approved
 * contract. Sponsor reference examples are artifacts, not submissions, and
 * therefore never enter this query or the public training split.
 */
export async function selectAcceptedSubmissionsForPublication(
  bountyId: string,
  targetItems: bigint
): Promise<PublishSubmission[]> {
  const limit = Number(targetItems);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new PublicationError(`Invalid publication targetItems value "${targetItems.toString()}".`, true);
  }
  return prisma.submission.findMany({
    where: { bountyId, status: SubmissionStatus.accepted },
    select: { id: true, title: true, payloadJson: true, contributorUserId: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
  });
}

function buildItemsJsonl(
  rows: PublishSubmission[],
  attachmentPaths?: Map<string, Map<string, string>>
): { jsonl: string; count: number } {
  const jsonl = rows
    .map((row) => {
      // A file field's stored value is an artifact id. Rewrite it to the path
      // the bytes were actually pushed to, so an item and the file it names
      // agree. A field whose attachment was NOT pushed (over the cap, artifact
      // not ready) keeps its id and is therefore visibly unresolvable rather
      // than pointing at a path that does not exist.
      const rewrite = attachmentPaths?.get(row.id);
      let payload = row.payloadJson;
      if (rewrite && payload && typeof payload === "object" && !Array.isArray(payload)) {
        const next: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
        for (const [fieldKey, path] of rewrite) next[fieldKey] = path;
        payload = next as typeof payload;
      }
      return JSON.stringify({ submissionId: row.id, title: row.title, payload });
    })
    .join("\n");
  return { jsonl: rows.length ? jsonl + "\n" : "", count: rows.length };
}

/** One contributor-uploaded file resolved to something publishable. */
export interface PublishAttachment {
  submissionId: string;
  fieldKey: string;
  /** Repo-relative path, under `data/` once pushed. */
  path: string;
  storageKey: string;
  sizeBytes: number;
}

/** Cumulative cap on attachment bytes in ONE publish job. Every attachment is
 * fully buffered before the HTTP push (unlike a streamed zip export), so this
 * bounds the job's memory. Matches v1's `MAX_PUBLISH_ATTACHMENT_BYTES`. */
const MAX_PUBLISH_ATTACHMENT_BYTES = 200 * 1024 * 1024;

/** Display-only filename, made safe for a repo path. The stored filename is
 * client-supplied and is never trusted as a key — it is decoration on a path
 * whose identity comes from the submission id, field key and artifact id. */
function sanitizePublishFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return cleaned.slice(0, 100) || "file";
}

/**
 * Resolve `role: "file"` fields on accepted submissions to real artifacts.
 *
 * Without this a published dataset's file fields are opaque artifact ids with
 * no bytes anywhere in the repo — a UI-bug-report dataset would ship thousands
 * of ids and no images. Only `ready` artifacts of kind `submission_attachment`
 * are eligible; anything else is skipped and its item keeps the raw id, which
 * is honest rather than a path to nothing.
 */
export async function collectSubmissionAttachments(
  fields: Array<{ key?: unknown; role?: unknown }>,
  submissions: Array<{ id: string; payloadJson: unknown }>
): Promise<PublishAttachment[]> {
  const fileKeys = fields
    .filter((f) => f && typeof f === "object" && f.role === "file" && typeof f.key === "string")
    .map((f) => f.key as string);
  if (fileKeys.length === 0) return [];

  const bySubmission = new Map<string, Map<string, string>>();
  const artifactIds = new Set<string>();
  for (const submission of submissions) {
    const payload = submission.payloadJson;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const record = payload as Record<string, unknown>;
    const map = new Map<string, string>();
    for (const key of fileKeys) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        map.set(key, value);
        artifactIds.add(value);
      }
    }
    if (map.size > 0) bySubmission.set(submission.id, map);
  }
  if (artifactIds.size === 0) return [];

  const artifacts = await prisma.artifact.findMany({
    where: { id: { in: [...artifactIds] }, status: "ready", kind: "submission_attachment" },
    select: { id: true, filename: true, sizeBytes: true, storageKey: true },
  });
  const byId = new Map(artifacts.map((a) => [a.id, a]));

  const out: PublishAttachment[] = [];
  for (const [submissionId, fieldMap] of bySubmission) {
    for (const [fieldKey, artifactId] of fieldMap) {
      const artifact = byId.get(artifactId);
      if (!artifact || !artifact.storageKey) continue;
      out.push({
        submissionId,
        fieldKey,
        path: `contributor-items/${submissionId}/${fieldKey}-${artifactId}-${sanitizePublishFilename(artifact.filename ?? "file")}`,
        storageKey: artifact.storageKey,
        sizeBytes: Number(artifact.sizeBytes ?? 0),
      });
    }
  }
  return out;
}

/**
 * Apply the cumulative byte cap. `sizeBytes` is the artifact's VERIFIED stored
 * size, not a client claim, so the cap is enforced before a single byte is
 * read. Deliberately non-fatal: a capped run still publishes, because a
 * partial dataset with an accurate manifest beats blocking the whole publish —
 * but the omission is recorded, never silent.
 */
export function applyAttachmentCap(
  attachments: PublishAttachment[],
  capBytes: number = MAX_PUBLISH_ATTACHMENT_BYTES
): PublishAttachment[] {
  let used = 0;
  const kept: PublishAttachment[] = [];
  for (const attachment of attachments) {
    if (used + attachment.sizeBytes > capBytes) continue;
    used += attachment.sizeBytes;
    kept.push(attachment);
  }
  return kept;
}

/** Read a stored object fully into memory. The cap above is what makes this
 * safe: it is applied to verified sizes BEFORE any read, so the total buffered
 * here is bounded regardless of how large the dataset's uploads are. */
async function readStorageObject(key: string): Promise<Buffer> {
  const stream = await storage().get(key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** submissionId -> (fieldKey -> repo path), for the JSONL rewrite. Built from
 * the PUBLISHED subset only, so items can never name a file the run skipped. */
export function attachmentPathsBySubmission(attachments: PublishAttachment[]): Map<string, Map<string, string>> {
  const map = new Map<string, Map<string, string>>();
  for (const attachment of attachments) {
    let inner = map.get(attachment.submissionId);
    if (!inner) map.set(attachment.submissionId, (inner = new Map()));
    inner.set(attachment.fieldKey, `data/${attachment.path}`);
  }
  return map;
}

/**
 * Enqueue (or re-arm) the async publication of a community bounty. One job
 * per bounty; the job itself fans out to every configured target inside
 * `runCommunityPublishJob`. `dbJobQueue.enqueue` upserts on `idempotencyKey`
 * and re-arms an existing dead/failed row back to `pending`, so calling this
 * again (an admin "retry" action) is always safe.
 */
export async function enqueueCommunityPublish(bountyId: string): Promise<string> {
  return dbJobQueue.enqueue({
    type: "community.publish",
    idempotencyKey: `community.publish:${bountyId}`,
    payload: { bountyId },
    maxAttempts: 5,
  });
}

/** Record a failed publish attempt for one target honestly: the row stays
 * `failed` with the reason in `lastError` and in the audit log. Never leaves
 * a dataset looking published when the push didn't happen. */
async function markTargetFailed(bountyId: string, target: PublicationTarget, reason: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const current = await tx.datasetPublication.findUnique({
      where: { bountyId_target: { bountyId, target } },
      select: { status: true },
    });
    if (current?.status === CommunityPublicationStatus.published) return; // never downgrade a real publish
    await tx.datasetPublication.upsert({
      where: { bountyId_target: { bountyId, target } },
      create: { bountyId, target, status: CommunityPublicationStatus.failed, lastError: reason.slice(0, 500), attemptCount: 1 },
      update: { status: CommunityPublicationStatus.failed, lastError: reason.slice(0, 500), attemptCount: { increment: 1 } },
    });
    await writeAuditLog(tx, {
      actorUserId: null,
      action: "community_publication.push_failed",
      targetType: "bounty",
      targetId: bountyId,
      before: { target, status: current?.status ?? null },
      after: { target, status: "failed" },
      metadata: { target, reason: reason.slice(0, 500) },
    });
  });
}

/** Record an honest "not configured" outcome for one target: enabled by the
 * platform but missing its credential/namespace, so nothing was attempted.
 * Distinct from `failed` (a real attempt that did not succeed) so an
 * operator's retry queue never fills up with rows that no retry can fix. */
async function markTargetNotConfigured(bountyId: string, target: PublicationTarget, reason: string): Promise<void> {
  await prisma.datasetPublication.upsert({
    where: { bountyId_target: { bountyId, target } },
    create: { bountyId, target, status: CommunityPublicationStatus.not_configured, lastError: reason },
    update: { status: CommunityPublicationStatus.not_configured, lastError: reason },
  });
}

/**
 * The `community.publish` job handler: build the dataset payload once and
 * push it to every configured target. Exported so it can be invoked from
 * `src/worker.ts`'s job-type switch (see the handoff diff in the task
 * report — this session does not touch `worker.ts` itself) and from tests.
 *
 * Per-target failure is isolated: a GitHub outage must not stop the Hugging
 * Face push (or vice versa), so each target's `PublicationError` is caught
 * and recorded on ITS OWN `DatasetPublication` row rather than aborting the
 * whole job. Only a TRANSIENT failure on at least one target causes this
 * function to throw (so the job-queue caller backs off and retries); a
 * PERMANENT failure or a `not_configured` target is terminal and recorded
 * without burning the retry budget — this is the same distinction
 * `errors.ts` exists for.
 */
export async function runCommunityPublishJob(bountyId: string): Promise<void> {
  const bounty = await prisma.bounty.findUnique({ where: { id: bountyId }, select: PUBLISH_BOUNTY_SELECT });
  if (!bounty) return; // deleted/missing — ack, nothing to do
  if (bounty.kind !== BountyKind.community) return; // this rebuild has no other kind, but guard anyway

  const settings = await getPublishSettings();
  if (!settings.enabled) {
    // Platform-level kill switch. Leave every target row untouched (they stay
    // whatever they were, e.g. `pending`) rather than recording a failure for
    // a push nobody authorized to run yet.
    throw new PublicationError("Community publish is disabled (community.publish.enabled admin setting).", true);
  }
  if (!bounty.communityLicense) {
    for (const target of PUBLICATION_TARGETS) {
      await markTargetFailed(bountyId, target as PublicationTarget, "Community license must be set before publishing.");
    }
    return;
  }

  // Resolve contributor file uploads to real bytes. Cap first (on VERIFIED
  // stored sizes, before reading anything), then buffer only what survives —
  // so an oversize dataset costs the cap, not its full size, in memory.
  const [accepted, totalAccepted] = await Promise.all([
    selectAcceptedSubmissionsForPublication(bountyId, bounty.targetItems),
    prisma.submission.count({ where: { bountyId, status: SubmissionStatus.accepted } }),
  ]);
  if (totalAccepted > accepted.length) {
    await writeAuditLog(prisma, {
      actorUserId: null,
      action: "community_publication.items_capped_to_target",
      targetType: "bounty",
      targetId: bountyId,
      metadata: {
        acceptedItemsAvailable: totalAccepted,
        targetItems: bounty.targetItems.toString(),
        publishedItems: accepted.length,
      },
    });
  }
  const typeRow = await prisma.bounty.findUnique({
    where: { id: bountyId },
    select: { datasetType: { select: { fields: true } } },
  });
  const declaredFields = Array.isArray(typeRow?.datasetType?.fields)
    ? (typeRow.datasetType.fields as Array<{ key?: unknown; role?: unknown }>)
    : [];
  const resolvedAttachments = await collectSubmissionAttachments(declaredFields, accepted);
  const publishedAttachments = applyAttachmentCap(resolvedAttachments);
  const attachmentBuffers: Array<{ path: string; content: Buffer }> = [];
  for (const attachment of publishedAttachments) {
    attachmentBuffers.push({ path: attachment.path, content: await readStorageObject(attachment.storageKey) });
  }

  // Honest, non-fatal: a capped run still publishes — a partial dataset with an
  // accurate manifest beats blocking the whole publish — but the omission is
  // recorded rather than silent.
  if (publishedAttachments.length < resolvedAttachments.length) {
    await writeAuditLog(prisma, {
      actorUserId: null,
      action: "community_publication.attachments_truncated",
      targetType: "bounty",
      targetId: bountyId,
      metadata: {
        resolvedAttachments: resolvedAttachments.length,
        publishedAttachments: publishedAttachments.length,
        cappedAtBytes: MAX_PUBLISH_ATTACHMENT_BYTES,
      },
    });
  }

  const { jsonl, count } = await buildItemsJsonl(accepted, attachmentPathsBySubmission(publishedAttachments));
  const manifest = await buildManifest(bounty, count, {
    resolved: resolvedAttachments.length,
    published: publishedAttachments.length,
  });

  let sawTransientFailure = false;
  let publishedHuggingFace: { repoId: string; url: string } | null = null;

  // Repo id each target already resolved on a previous push, read from its own
  // DatasetPublication row rather than only from the legacy bounty-level
  // Hugging Face mirror column. `slugForBounty` is deterministic, so for an
  // unchanged namespace this recomputes to the same id either way — but when
  // the configured namespace/owner has changed since the first push, reusing
  // the id actually recorded for THAT target is what keeps a republish
  // updating the existing repo instead of creating a second one under the new
  // namespace. The Hugging Face fallback stays for bounties published before
  // per-target rows carried an externalId.
  const priorExternalIdByTarget = new Map<string, string>();
  if (bountyId) {
    const priorRows = await prisma.datasetPublication.findMany({
      where: { bountyId, externalId: { not: null } },
      select: { target: true, externalId: true },
    });
    for (const row of priorRows) priorExternalIdByTarget.set(row.target, row.externalId!);
  }

  for (const targetName of PUBLICATION_TARGETS) {
    const target = targetName as PublicationTarget;
    const provider = publicationProvider(targetName);
    const namespace = resolveNamespace(targetName, settings.namespace);
    const configured = await provider.isConfigured(namespace);
    if (!configured.ok) {
      await markTargetNotConfigured(bountyId, target, configured.reason ?? `${targetName} is not configured.`);
      continue;
    }
    if (typeof provider.publishDataset !== "function") {
      await markTargetFailed(bountyId, target, `Publication provider ${targetName} does not support dataset push.`);
      continue;
    }

    const existingId =
      priorExternalIdByTarget.get(targetName) ??
      (bountyId && targetName === "huggingface" ? bounty.huggingFaceDataset : null);
    const repoId = existingId && existingId.includes("/") ? existingId : `${namespace}/${slugForBounty(bounty)}`;

    // Each target gets the furniture its own host reads — same data and
    // manifest bytes, different README, plus LICENSE/.gitattributes on GitHub.
    const files = buildFilesForTarget(targetName, bounty, manifest, jsonl, attachmentBuffers);

    try {
      const result = await provider.publishDataset({
        repoId,
        files,
        commitMessage: `Publish ${bounty.title}`,
        private: PUBLISH_PRIVATE,
      });
      await prisma.$transaction(async (tx) => {
        const current = await tx.datasetPublication.findUnique({
          where: { bountyId_target: { bountyId, target } },
          select: { status: true },
        });
        if (current?.status === CommunityPublicationStatus.published) return; // idempotent re-run guard
        await tx.datasetPublication.upsert({
          where: { bountyId_target: { bountyId, target } },
          create: { bountyId, target, status: CommunityPublicationStatus.published, externalId: result.repoId, url: result.url, pushedAt: new Date(), attemptCount: 1 },
          update: { status: CommunityPublicationStatus.published, externalId: result.repoId, url: result.url, pushedAt: new Date(), lastError: null, attemptCount: { increment: 1 } },
        });
        await writeAuditLog(tx, {
          actorUserId: null,
          action: "community_publication.pushed",
          targetType: "bounty",
          targetId: bountyId,
          before: { target, status: current?.status ?? null },
          after: { target, status: "published" },
          metadata: { target, url: result.url, files: files.length, acceptedItems: count },
        });
      });
      if (targetName === "huggingface") publishedHuggingFace = result;
    } catch (error) {
      if (error instanceof PublicationError && error.permanent) {
        await markTargetFailed(bountyId, target, error.message);
        continue;
      }
      // Transient (provider 5xx/down, network, timeout, 429): record nothing
      // final yet — the caller's retry/backoff decides whether this becomes a
      // recorded failure once the job's retry budget is exhausted.
      sawTransientFailure = true;
    }
  }

  // Hugging Face is the primary/legacy target: mirror its repo id onto the
  // bounty row (readers not yet migrated to per-target rows keep working) and
  // flip the bounty-level rollup only off the target the platform has always
  // exposed publicly — a GitHub-only publish, or a GitHub outage, must never
  // read as the bounty being "published" or "failed" if Hugging Face itself
  // has not resolved either way.
  if (publishedHuggingFace) {
    await prisma.bounty.update({
      where: { id: bountyId },
      data: { huggingFaceDataset: publishedHuggingFace.repoId, publicationStatus: CommunityPublicationStatus.published },
    });
  }

  if (sawTransientFailure) {
    throw new PublicationError("At least one publication target failed transiently; will retry.", false);
  }
}


/**
 * Enqueue (or re-arm) the withdrawal of a published community bounty. One job
 * per bounty, same idempotency contract as `enqueueCommunityPublish`.
 */
export async function enqueueCommunityUnpublish(bountyId: string): Promise<string> {
  return dbJobQueue.enqueue({
    type: "community.unpublish",
    idempotencyKey: `community.unpublish:${bountyId}`,
    payload: { bountyId },
    maxAttempts: 5,
  });
}

/**
 * Withdraw a bounty from every target it is currently published to.
 *
 * Both providers withdraw by flipping the repository to **private** — never a
 * delete — so the commits and the contributor provenance inside them survive
 * and the retraction stays reversible. Both treat a 404 as success: the repo is
 * already not publicly reachable, which is the state this call exists to
 * guarantee.
 *
 * The honesty rule that shapes the whole function: a target moves to
 * `retracted` ONLY after its provider returns. Any throw — auth, network,
 * provider 5xx — leaves the row `published`, because the dataset really is
 * still public, and `lastError` records why. The bounty-level rollup becomes
 * `retracted` only when every previously-published target actually withdrew;
 * a partial withdrawal must not read as a complete one.
 */
export async function runCommunityUnpublishJob(bountyId: string): Promise<void> {
  const rows = await prisma.datasetPublication.findMany({
    where: { bountyId, status: CommunityPublicationStatus.published },
    select: { target: true, externalId: true },
  });
  if (rows.length === 0) return; // nothing public to withdraw — ack, idempotent

  const settings = await getPublishSettings();
  let sawTransientFailure = false;
  let retracted = 0;

  for (const row of rows) {
    const targetName = row.target as PublicationTargetName;
    const provider = publicationProvider(targetName);
    const namespace = resolveNamespace(targetName, settings.namespace);

    const configured = await provider.isConfigured(namespace);
    if (!configured.ok) {
      await markRetractFailed(bountyId, row.target, configured.reason ?? `${targetName} is not configured.`);
      continue;
    }
    if (typeof provider.unpublishDataset !== "function") {
      await markRetractFailed(bountyId, row.target, `Publication provider ${targetName} does not support withdrawal.`);
      continue;
    }
    if (!row.externalId) {
      await markRetractFailed(
        bountyId,
        row.target,
        `No provider repo id recorded for ${targetName}; cannot withdraw without knowing what to withdraw.`
      );
      continue;
    }

    try {
      const result = await provider.unpublishDataset({ repoId: row.externalId });
      await prisma.$transaction(async (tx) => {
        await tx.datasetPublication.update({
          where: { bountyId_target: { bountyId, target: row.target } },
          data: { status: CommunityPublicationStatus.retracted, lastError: null },
        });
        await writeAuditLog(tx, {
          actorUserId: null,
          action: "community_publication.retracted",
          targetType: "bounty",
          targetId: bountyId,
          before: { target: row.target, status: "published" },
          after: { target: row.target, status: "retracted" },
          metadata: { target: row.target, repoId: result.repoId, mode: result.mode },
        });
      });
      retracted += 1;
    } catch (error) {
      if (error instanceof PublicationError && error.permanent) {
        await markRetractFailed(bountyId, row.target, error.message);
        continue;
      }
      // Transient: leave the row `published` (it is) and let the job retry.
      sawTransientFailure = true;
    }
  }

  // Roll up only on a COMPLETE withdrawal. A partially-withdrawn dataset is
  // still partly public and must not display as retracted.
  if (retracted === rows.length) {
    await prisma.bounty.update({
      where: { id: bountyId },
      data: { publicationStatus: CommunityPublicationStatus.retracted },
    });
  }

  if (sawTransientFailure) {
    throw new PublicationError(`Withdrawal incomplete for bounty ${bountyId}; retrying.`, false);
  }
}

/** A retraction that did not happen. The row stays `published` — that is the
 * true state — with the reason recorded for the admin. */
async function markRetractFailed(bountyId: string, target: PublicationTarget, reason: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.datasetPublication.update({
      where: { bountyId_target: { bountyId, target } },
      data: { lastError: reason },
    });
    await writeAuditLog(tx, {
      actorUserId: null,
      action: "community_publication.retract_failed",
      targetType: "bounty",
      targetId: bountyId,
      metadata: { target, reason },
    });
  });
}
