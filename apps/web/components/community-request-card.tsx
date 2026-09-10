// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { Icon } from "@/components/icons";
import { Button, InfoTip, InlineStat, Pill, Progress } from "@/components/ui";
import { humanizeKey, karmaPerItemLabel, pct } from "@/lib/format";
import { FunnelCounts } from "@/components/funnel-counts";
import { communityLicenseLabel, PUBLICATION_STATUS_HELP, REQUEST_STATUS_HELP, STATUS_TONE, statusLabel, type DatasetRequestFull, type MintedBounty } from "@/components/dataset-request-detail";
import { PublicationStatus } from "@/components/publication-status";
import { parseDatasetPublication } from "@/lib/publication";

function filedLabel(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `filed ${d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })}`;
}

function MintedProgress({ mb }: { mb: MintedBounty }) {
  if (mb.status !== "active") return null;
  const accepted = mb.acceptedItems ?? 0;
  const target = mb.targetItems ?? 0;
  const percent = target > 0 ? Math.round((accepted / target) * 100) : 0;
  const karmaReleased = mb.karmaReleasedTotal ?? null;
  const karmaSecured = mb.karmaSecuredTotal ?? 0;
  const karmaTarget = mb.karmaPerAcceptedItem ? target * mb.karmaPerAcceptedItem : null;
  const immediateRelease = mb.poolSummary?.policy?.karmaRelease === "on_final_accept";
  return (
    <div className="grid gap-4 sm:grid-cols-2 sm:gap-7">
      <div>
        <div className="mb-1.5 flex justify-between font-mono text-xs">
          <span className="text-ink-soft">
            {accepted.toLocaleString()} / {target.toLocaleString()} accepted
          </span>
          <span className="font-bold">{percent}%</span>
        </div>
        <Progress value={accepted} max={target} tone="ink" track="line" className="rounded-[3px]" />
      </div>
      {karmaReleased != null && karmaTarget != null && (
        <div>
          <div className="mb-1.5 flex justify-between font-mono text-xs">
            <span>
              <span className="font-bold">{karmaReleased.toLocaleString()}</span>{" "}
              <span className="text-ink-soft">karma released</span>
            </span>
            <span className="text-ink-soft">of {karmaTarget.toLocaleString()} planned</span>
          </div>
          <Progress value={karmaReleased} max={karmaTarget} tone="olive" track="line" className="rounded-[3px]" />
        </div>
      )}
      {karmaSecured > 0 && !immediateRelease && (
        <div className="sm:col-span-2 font-mono text-[11px] text-karma">
          +{karmaSecured.toLocaleString()} karma secured for contributors and validators — released once each
          item&apos;s dispute window closes and the dataset is published
        </div>
      )}
      {immediateRelease && (
        <div className="sm:col-span-2 font-mono text-[11px] text-accent-strong">
          Final acceptance releases karma immediately. The dataset itself publishes once, as a whole, after the pool
          completes and every validator decision is in.
        </div>
      )}
    </div>
  );
}

function MintedFunnel({ bountyId, mb }: { bountyId: string; mb: MintedBounty }) {
  return (
    <FunnelCounts
      className="mt-3.5"
      liftAboveOverlay
      bountyId={bountyId}
      totalSubmitted={mb.totalSubmittedItems ?? 0}
      inPipeline={mb.submittedItems ?? 0}
      needsFixes={mb.needsFixesItems ?? 0}
      rejected={mb.rejectedItems ?? 0}
      holdingPlace={mb.clearedItems ?? 0}
      targetItems={mb.targetItems ?? 0}
    />
  );
}

export function CommunityRequestCard({ request, href }: { request: DatasetRequestFull; href: string }) {
  const mb = request.mintedBounty;
  const destination = request.mintedBountyId ? `/sponsor/${request.mintedBountyId}` : href;
  const publication = parseDatasetPublication(mb?.poolSummary?.publication);
  // PublicationStatus's own compact link is deliberately omitted whenever a
  // targets[] breakdown exists (see components/publication-status.tsx) — this
  // card renders the actual buttons itself, one per confirmed target.
  const published = mb?.publicationStatus === "published" && mb.huggingFaceDataset;
  const meta =
    [request.language, request.framework].filter(Boolean).join(" · ") ||
    (request.createdAt ? filedLabel(request.createdAt) : null);

  return (
    <div className="card group relative p-6 transition-colors hover:border-[#c9cdbf]">
      <Link
        href={destination}
        aria-label={
          request.mintedBountyId
            ? `Open the live program for ${request.title}`
            : `Open ${request.title}`
        }
        className="absolute inset-0 z-10 rounded-[inherit]"
      />
      <div className="pointer-events-none relative z-20 mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
          <div
            className="truncate text-[17px] font-bold tracking-tight group-hover:text-brand-deep"
            title={request.title}
          >
            {request.title}
          </div>
          {(request.status === "declined" || request.status === "changes_requested") && request.adminNote && (
            <p className="mt-2 text-[11px] text-ink-soft">{request.adminNote}</p>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <span className="pointer-events-auto relative z-30 inline-flex items-center gap-1">
            <Pill tone={STATUS_TONE[request.status] ?? "neutral"}>{statusLabel(request.status)}</Pill>
            {REQUEST_STATUS_HELP[request.status] && (
              <InfoTip
                label={`${statusLabel(request.status)} status`}
                text={REQUEST_STATUS_HELP[request.status]}
              />
            )}
          </span>
          {publication && (
            <span className="pointer-events-auto relative z-30">
              <PublicationStatus publication={publication} compact />
            </span>
          )}
          {!publication && mb && mb.publicationStatus && mb.publicationStatus !== "not_requested" && (
            <span className="pointer-events-auto relative z-30 inline-flex items-center gap-1">
              <Pill tone={mb.publicationStatus === "published" ? "lime" : mb.publicationStatus === "failed" ? "warning" : "neutral"}>
                {mb.publicationStatus === "publishing" ? "publishing…" : humanizeKey(mb.publicationStatus)}
              </Pill>
              {PUBLICATION_STATUS_HELP[mb.publicationStatus] && (
                <InfoTip
                  label="Hugging Face publication"
                  text={PUBLICATION_STATUS_HELP[mb.publicationStatus]}
                />
              )}
            </span>
          )}
          {meta && <span className="whitespace-nowrap font-mono text-[11px] text-ink-faint">{meta}</span>}
          {published && (
            <a
              href={`https://huggingface.co/datasets/${mb!.huggingFaceDataset}`}
              target="_blank"
              rel="noopener noreferrer"
              className="pointer-events-auto relative z-30"
            >
              <Button variant="secondary" size="sm">
                View on Hugging Face
                <Icon name="external" size={13} />
              </Button>
            </a>
          )}
          {/* Generic: any confirmed target beyond Hugging Face (github,
              aikosh, ...) renders here with zero new code — see
              publicPublicationsOf() in the API. Same z-30/pointer-events
              escape from the card's full-bleed overlay Link as the HF button
              above. */}
          {/* huggingface excluded: it already has its own dedicated button
              above (huggingFaceDataset predates the generic publications
              list and many other consumers still key off it directly). */}
          {mb?.publications?.filter((p) => p.target !== "huggingface").map((p) => (
            <a
              key={p.target}
              href={p.url}
              target="_blank"
              rel="noopener noreferrer"
              className="pointer-events-auto relative z-30"
            >
              <Button variant="secondary" size="sm">
                View on {p.target === "github" ? "GitHub" : p.target}
                <Icon name="external" size={13} />
              </Button>
            </a>
          ))}
          <Icon
            name="chevron-right"
            size={16}
            className="text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-brand-deep"
          />
        </div>
      </div>

      {mb && <MintedProgress mb={mb} />}
      {mb && request.mintedBountyId && <MintedFunnel bountyId={request.mintedBountyId} mb={mb} />}

      <div className="pointer-events-none relative z-20 mt-3.5 flex flex-wrap gap-x-7 gap-y-1 border-t border-line-soft pt-3.5 font-mono text-xs">
        {request.targetItems != null && (
          <InlineStat label="items" value={request.targetItems.toLocaleString()} />
        )}
        {mb?.karmaPerAcceptedItem != null && (
          <InlineStat label="karma/item" value={karmaPerItemLabel(mb.karmaPerAcceptedItem)} />
        )}
        {request.difficultyMix && (
          <InlineStat label="difficulty" value={humanizeKey(request.difficultyMix)} />
        )}
        {request.proposedLicense && (
          <InlineStat label="license" value={communityLicenseLabel(request.proposedLicense)} />
        )}
        {request.auditCoveragePct != null && (
          <InlineStat label="audit" value={`${request.auditCoveragePct}%`} />
        )}
        {mb?.duplicateRate != null && <InlineStat label="dup rate" value={pct(mb.duplicateRate)} />}
        {mb?.llmPassRate != null && <InlineStat label="llm pass" value={pct(mb.llmPassRate)} />}
        {mb?.executionPassRate != null && <InlineStat label="exec pass" value={pct(mb.executionPassRate)} />}
      </div>
    </div>
  );
}
