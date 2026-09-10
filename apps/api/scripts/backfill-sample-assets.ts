// SPDX-License-Identifier: Apache-2.0
// One-off backfill: copy admin-approved sponsor_reference artifacts into
// DatasetType.sample_assets for already-minted community bounties, using the
// exact same eligibility rules as the mint-time fix in admin-community.ts:
//   - dataset_type.sample_assets currently null
//   - no OTHER community bounty shares this dataset_type_id
//   - at least one approved sponsor_reference artifact on the bounty's
//     originating dataset_request
// Reuses the app's own prisma client and storage driver (never reimplemented).
// Read-only (DRY_RUN=1, default) unless DRY_RUN=0 is set.
import { prisma } from "../src/lib/prisma.js";
import { getArtifactData } from "../src/services/storage.js";

const DRY_RUN = process.env.DRY_RUN !== "0";

async function main() {
  console.log(`=== backfill sample_assets — DRY_RUN=${DRY_RUN} ===`);

  const bounties = await prisma.bounty.findMany({
    where: { kind: "community", datasetTypeId: { not: null } },
    select: { id: true, title: true, datasetTypeId: true },
  });

  let skippedSharedType = 0;
  let skippedNoRequest = 0;
  let skippedNoApproved = 0;
  let skippedAlreadySet = 0;
  let updated = 0;

  for (const bounty of bounties) {
    const datasetType = await prisma.datasetType.findUnique({
      where: { id: bounty.datasetTypeId! },
      select: { id: true, sampleAssets: true },
    });
    if (!datasetType) continue;
    if (datasetType.sampleAssets != null) {
      skippedAlreadySet++;
      continue;
    }

    const otherBounties = await prisma.bounty.count({
      where: { datasetTypeId: bounty.datasetTypeId!, kind: "community", id: { not: bounty.id } },
    });
    if (otherBounties > 0) {
      skippedSharedType++;
      console.log(`SKIP shared-type: ${bounty.id} "${bounty.title}" (type ${bounty.datasetTypeId} used by ${otherBounties} other bounty/ies)`);
      continue;
    }

    const request = await prisma.datasetRequest.findFirst({
      where: { mintedBountyId: bounty.id },
      select: { id: true },
    });

    // Approved sponsor_reference samples can be attached two ways: pre-mint,
    // on the originating dataset_request (rare once a bounty is live — the
    // live DB shows almost none this way), or directly on the live bounty
    // itself (apps/web/components/dataset-request-detail.tsx-style post-mint
    // attachment) — the overwhelmingly common case. Check both; a bounty with
    // neither has genuinely never received a sample, not a bug.
    const approved = await prisma.artifact.findMany({
      where: {
        kind: "sponsor_reference",
        sponsorReviewStatus: "approved",
        deletedAt: null,
        OR: [{ bountyId: bounty.id }, ...(request ? [{ datasetRequestId: request.id }] : [])],
      },
      orderBy: { createdAt: "asc" },
      take: 5,
      select: { storageKey: true },
    });
    if (!request && approved.length === 0) {
      skippedNoRequest++;
      continue;
    }
    if (approved.length === 0) {
      skippedNoApproved++;
      continue;
    }

    const sampleAssets: Array<{ fields: Record<string, string> }> = [];
    for (const artifact of approved) {
      try {
        const parsed: unknown = JSON.parse((await getArtifactData(artifact.storageKey)).toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const fields: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === "string" && key.length <= 80 && value.length <= 2000) fields[key] = value;
        }
        if (Object.keys(fields).length > 0) sampleAssets.push({ fields });
      } catch (e) {
        console.log(`  WARN: could not parse artifact ${artifact.storageKey}: ${(e as Error).message}`);
      }
    }

    if (sampleAssets.length === 0) {
      skippedNoApproved++;
      continue;
    }

    console.log(`${DRY_RUN ? "WOULD UPDATE" : "UPDATING"}: bounty ${bounty.id} "${bounty.title}" -> dataset_type ${bounty.datasetTypeId}, ${sampleAssets.length} sample(s)`);
    if (!DRY_RUN) {
      await prisma.datasetType.update({
        where: { id: bounty.datasetTypeId! },
        data: { sampleAssets },
      });
    }
    updated++;
  }

  console.log("");
  console.log("=== summary ===");
  console.log(`total community bounties checked: ${bounties.length}`);
  console.log(`updated (or would update): ${updated}`);
  console.log(`skipped — already had sample_assets: ${skippedAlreadySet}`);
  console.log(`skipped — shared dataset_type (other bounty uses it): ${skippedSharedType}`);
  console.log(`skipped — no originating dataset_request found: ${skippedNoRequest}`);
  console.log(`skipped — no approved sponsor_reference samples: ${skippedNoApproved}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });