"use client";

// SPDX-License-Identifier: Apache-2.0

import { Icon } from "@/components/icons";
import { Pill, type PillTone } from "@/components/ui";
import type { DatasetPublication, PublicationState } from "@/lib/types";

const STATE_TONE: Record<PublicationState, PillTone> = {
  not_published: "neutral",
  queued: "info",
  publishing: "info",
  published: "lime",
  failed: "warning",
};

export function PublicationStatus({
  publication,
  className = "",
  compact = false,
}: {
  publication: DatasetPublication | null | undefined;
  className?: string;
  compact?: boolean;
}) {
  if (!publication) return null;

  const { state, label, detail, datasetUrl, progress } = publication;
  const link = state === "published" && datasetUrl ? datasetUrl : null;

  if (compact) {
    return (
      <span className={`inline-flex items-center gap-2 ${className}`}>
        <Pill tone={STATE_TONE[state]}>{label}</Pill>
        {state === "not_published" && progress && (
          <span className="font-mono text-[11px] text-ink-faint">
            {progress.finalAccepted.toLocaleString()} / {progress.targetItems.toLocaleString()} final
          </span>
        )}
        {link && !publication.targets?.length && <PublicationLink href={link} target={publication.target} />}
      </span>
    );
  }

  return (
    <div className={`rounded-xl border border-line bg-panel px-4 py-3 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="micro-label text-ink-faint">dataset publication</div>
        <Pill tone={STATE_TONE[state]}>{label}</Pill>
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-soft">{detail}</p>
      {link && !publication.targets?.length && (
        <div className="mt-2">
          <PublicationLink href={link} target={publication.target} />
        </div>
      )}
      {publication.targets?.filter((target) => target.state === "published" && target.url).map((target) => (
        <div className="mt-2" key={target.target}>
          <PublicationLink href={target.url!} target={target.target} attested={target.attested} />
        </div>
      ))}
    </div>
  );
}

function PublicationLink({ href, target, attested = false }: { href: string; target: DatasetPublication["target"]; attested?: boolean }) {
  const label = target === "github" ? "View dataset on GitHub" : target === "aikosh" ? "View dataset on AIKosh" : "View dataset on Hugging Face";
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-mono text-[12px] font-medium text-lime-700 underline underline-offset-2 hover:text-lime-800"
    >
      {label}{attested ? " (admin-attested)" : ""}
      <Icon name="external" size={12} />
    </a>
  );
}
