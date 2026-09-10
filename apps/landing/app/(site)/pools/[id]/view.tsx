"use client";

// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import Link from "next/link";
import { isoDate, num, optionalNum, optionalPct } from "@/lib/format";
import {
  DATASET_TYPE_CATALOG,
  type DatasetType,
} from "@/lib/dataset-types";
import { CodeBlock } from "@/components/ui";
import { CopyButton } from "@/components/copy-button";
import { Icon } from "@/components/icons";
import { EmptyState } from "@/components/empty-state";
import type { Bounty, BountyStatus, DatasetCategory, PublicSampleArtifact } from "@/lib/types";
import { DASHBOARD_URL } from "@/lib/urls";
import { PUBLIC_API_URL } from "@/lib/public-data";

function resolveDatasetType(bounty: {
  datasetTypeId?: string;
  category: DatasetCategory;
}): DatasetType {
  return (
    (bounty.datasetTypeId
      ? DATASET_TYPE_CATALOG.find((t) => t.id === bounty.datasetTypeId)
      : undefined) ??
    DATASET_TYPE_CATALOG.find((t) => t.category === bounty.category) ??
    DATASET_TYPE_CATALOG[0]
  );
}

function parseSampleFields(content: string): Array<[string, unknown]> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.entries(parsed as Record<string, unknown>);
    }
  } catch {
    // A text artifact is rendered directly as code
  }
  return null;
}

function sampleValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "";
}

function sampleDownloadUrl(sample: PublicSampleArtifact): string {
  return `${PUBLIC_API_URL}${sample.downloadUrl}`;
}

/** A dataset-type sample field's value can be a large JSON array, a code
 * string, or a short plain value. Only the first two get code-block
 * treatment (copy + download); short values keep the compact key/value row. */
type ClassifiedField =
  | { kind: "short" }
  | { kind: "code"; ext: "json" | "txt"; mime: string; content: string };

function classifyFieldValue(value: string): ClassifiedField {
  try {
    const parsed = JSON.parse(value) as unknown;
    return {
      kind: "code",
      ext: "json",
      mime: "application/json",
      content: JSON.stringify(parsed, null, 2),
    };
  } catch {
    // Not JSON — fall through to the long-text/code check below.
  }
  if (value.includes("\n") || value.length > 100) {
    return { kind: "code", ext: "txt", mime: "text/plain", content: value };
  }
  return { kind: "short" };
}

function slugifyKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
}

function truncateLabel(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Matches CopyButton's idle-state look (same border/hover/size/focus
 * classes) so the two affordances read as one pair next to a code block. */
function DownloadFieldButton({
  filename,
  content,
  mime,
  label,
}: {
  filename: string;
  content: string;
  mime: string;
  label: string;
}) {
  const onClick = () => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Download ${label}`}
      title={`Download ${label}`}
      className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[7px] border border-dark-line-strong bg-dark-card px-2 py-1.5 font-mono text-[11px] text-dark-soft transition-colors hover:border-lime hover:text-lime focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime"
    >
      <Icon name="download" size={11} />
      <span aria-hidden>download</span>
    </button>
  );
}

function statusChip(status: BountyStatus): { label: string; className: string } {
  switch (status) {
    case "active":
      return {
        label: "● active",
        className: "border-[#1e3a2c] bg-[rgba(52,211,153,.06)] text-emerald-400",
      };
    case "completed":
    case "export_ready":
      return {
        label: "● delivered",
        className: "border-[#33421a] bg-[rgba(182,255,28,.06)] text-lime",
      };
    case "partially_completed":
      return {
        label: "◐ partial",
        className: "border-violet-400/25 bg-violet-400/5 text-violet-400",
      };
    default:
      return {
        label: `● ${status}`,
        className: "border-dark-line text-dark-soft",
      };
  }
}

const DIFFICULTY_COLORS = {
  beginner: "text-emerald-400",
  intermediate: "text-amber-400",
  advanced: "text-rose-400",
} as const;

function PublicSampleDownloadLink({ sample, className }: { sample?: PublicSampleArtifact; className: string }) {
  if (!sample) return null;
  return (
    <a href={sampleDownloadUrl(sample)} className={className}>
      download public_sample ↓
    </a>
  );
}

function PanelHeading({ title, sub }: { title: string; sub: string }) {
  return (
    <>
      <div className="mb-1 text-[15px] font-bold text-dark-text">{title}</div>
      <p className="mb-4 text-xs text-dark-soft">{sub}</p>
    </>
  );
}

/**
 * A partially-completed pool has published what it collected, so its detail
 * page reads as delivered (back-link to /delivered, sample download instead
 * of a contribute CTA) — matching how the listing treats it as no longer open.
 */
const DELIVERED_STATUSES: BountyStatus[] = ["completed", "export_ready", "partially_completed"];

/** Deterministic and stable — same pattern the admin app's `hfDatasetUrl` already uses. */
const hfDatasetUrl = (slug: string) => `https://huggingface.co/datasets/${slug}`;

export default function PoolDetailView({ bounty }: { bounty: Bounty | null }) {
  // Declared unconditionally, ahead of the early return below, so the hook
  // order stays stable across renders regardless of whether `bounty` resolves.
  const [activeSampleIndex, setActiveSampleIndex] = useState(0);

  if (!bounty) {
    return (
      <div className="bg-dark text-dark-text">
        <div className="mx-auto max-w-[1200px] px-4 py-20 sm:px-8">
          <div className="mx-auto max-w-md">
            <EmptyState
              variant="no-results"
              title="Dataset not found"
              description="The dataset spec you are looking for does not exist or has been removed."
              action={{ label: "back to datasets", href: "/pools" }}
            />
          </div>
        </div>
      </div>
    );
  }

  const datasetType = resolveDatasetType(bounty);
  // The API's own name wins over the static catalog entry we matched.
  const datasetTypeName = bounty.datasetTypeName ?? datasetType.name;
  const chip = statusChip(bounty.status);
  const isDelivered = DELIVERED_STATUSES.includes(bounty.status);
  const karmaValue = bounty.karmaPerItem ?? 0;
  const capacityReserved =
    bounty.communityProgress?.capacityReserved ?? bounty.clearedItems ?? bounty.acceptedItems;
  const finalAccepted = bounty.communityProgress?.finalAccepted ?? bounty.acceptedItems;
  const fullHuman = bounty.communityPolicy?.validation === "full_human";
  const finalPerItem = bounty.communityPolicy?.karmaRelease === "on_final_accept";
  // Only artifacts whose preview actually resolved are renderable; an
  // unavailable or non-text sample has no content to show inline.
  const allPublicSamples = bounty.publicSamples ?? [];
  const publicSamples = allPublicSamples.filter(
    (sample) => sample.sample.available && typeof sample.sample.content === "string"
  );
  const hiddenSampleCount = allPublicSamples.length - publicSamples.length;
  const downloadableSample = bounty.publicSamples?.[0];
  const datasetTypeSamples = bounty.datasetTypeSampleAssets ?? [];
  const activeSampleIndexClamped =
    datasetTypeSamples.length === 0
      ? 0
      : Math.min(Math.max(activeSampleIndex, 0), datasetTypeSamples.length - 1);

  return (
    <div className="bg-dark text-dark-text">
      <div className="mx-auto max-w-[1200px] px-4 pb-[72px] pt-9 sm:px-8">
        <Link
          href={isDelivered ? "/delivered" : "/pools"}
          className="font-mono text-xs text-dark-soft hover:text-dark-text"
        >
          ← {isDelivered ? "delivered_datasets" : "open_datasets"}
        </Link>

        {/* Title block */}
        <div className="mt-[22px] flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <div className="mb-3.5 flex flex-wrap gap-2 font-mono text-[10px]">
              <span className="rounded-[5px] border border-[#33421a] bg-[rgba(182,255,28,.06)] px-[9px] py-1 text-lime">
                {datasetTypeName.toLowerCase()}
              </span>
              <span className="rounded-[5px] border border-dark-line px-[9px] py-1 text-dark-muted">
                {bounty.language.toLowerCase()} · {bounty.framework.toLowerCase()}
              </span>
              <span className="rounded-[5px] border border-violet-400/40 bg-violet-400/10 px-[9px] py-1 text-violet-300">
                community · karma-rewarded

              </span>
              <span className={`rounded-[5px] border px-[9px] py-1 ${chip.className}`}>
                {chip.label}
              </span>
            </div>
            <h1 className="mb-3 break-words font-display text-[26px] font-bold leading-[normal] tracking-[-.03em] sm:text-[34px]">
              {bounty.title}
            </h1>
            <div className="font-mono text-xs text-dark-soft">
              sponsor: <span className="text-dark-text">{bounty.requesterNickname}</span>
              {/* `deadline` is nullable (Bounty.deadline is DateTime?) and community
                  pools do not set one, so the label and its separator are dropped
                  rather than rendered against an empty value. Omitted rather than
                  filled with a placeholder word: the parity contract forbids invented
                  copy, and omission adds no new string. */}
              {bounty.deadline ? (
                <>
                  {" "}&nbsp;·&nbsp; deadline:{" "}
                  <span className="text-dark-text">{bounty.deadline}</span>
                </>
              ) : null}
            </div>
          </div>
          {isDelivered ? (
            <PublicSampleDownloadLink
              sample={downloadableSample}
              className="shrink-0 cursor-pointer rounded-lg border border-dark-line-soft px-[18px] py-3 font-mono text-[13px] font-medium text-dark-text transition-colors hover:border-dark-hover"
            />
          ) : (
            <Link
              href={`${DASHBOARD_URL}/contributor?bounty=${bounty.id}`}
              className="shrink-0 rounded-lg bg-lime px-[18px] py-3 font-mono text-[13px] font-medium text-dark transition-colors hover:bg-lime-bright"
            >
              connect to contribute →
            </Link>
          )}
        </div>

        <p className="mb-8 mt-6 max-w-[760px] text-[15px] leading-[1.65] text-dark-muted">
          {bounty.description}
        </p>

        {/* Stat row: community economics */}
        <div className="mb-5 grid grid-cols-2 overflow-hidden rounded-[11px] border border-dark-line font-mono sm:grid-cols-3 lg:grid-cols-6">
          {[
            {
              label: "karma / item",
              value: (
                <span className="text-violet-300">
                  {num(karmaValue)}{" "}
                  <span className="text-[11px] text-dark-dim">karma</span>
                </span>
              ),
              big: true,
              lime: false,
            },
            {
              label: "capacity reserved / target",
              value: `${num(capacityReserved)} / ${num(bounty.targetItems)}`,
              big: true,
              lime: false,
            },
            {
              label: "final accepted",
              value: num(finalAccepted),
              big: true,
              lime: false,
            },
            {
              label: "contributors",
              value: optionalNum(bounty.contributorCount),
              big: true,
              lime: false,
            },
            {
              label: "license",
              value: bounty.openLicense ?? "open",
              big: false,
              lime: false,
            },
          ].map((s, i, arr) => (
            <div
              key={s.label}
              className={`bg-dark-card px-5 py-[18px] ${
                i < arr.length - 1 ? "lg:border-r lg:border-dark-line" : ""
              } border-dark-line max-lg:border-b max-lg:[&:nth-child(odd)]:border-r`}
            >
              <div className="micro-label mb-2 text-dark-dim">{s.label}</div>
              <div
                className={`font-bold ${s.big ? "text-[19px]" : "text-sm"} ${
                  s.lime ? "text-lime" : "text-dark-text"
                }`}
              >
                {s.value}
              </div>
            </div>
          ))}
        </div>

        {/* Karma + terms + quality */}
        <div className="mb-9 grid gap-4 lg:grid-cols-3">
          {/* Karma details */}
          <div className="card-dark p-[22px]">
            <PanelHeading
              title="Karma per final accepted item"
              sub={
                finalPerItem
                  ? `${fullHuman ? "Human-validator" : "Clean automated-pipeline"} approval is final: karma releases immediately and Hugging Face sync is queued. Rejected items do not qualify.`
                  : "Secured after final acceptance. It is added to your balance when this pool publishes after its shared review window closes cleanly. Rejected items do not qualify."
              }
            />
            <div className="flex flex-col gap-[11px] font-mono text-[12.5px]">
              <div className="flex justify-between">
                <span className="text-dark-muted">
                  {finalPerItem ? "released on final acceptance" : "secured on acceptance"}
                </span>
                <span className="text-violet-300">{num(karmaValue)} karma</span>
              </div>
            </div>
          </div>

          {/* Community terms */}
          <div className="card-dark p-[22px]">
            <PanelHeading
              title="Community terms"
              sub="Platform-authored spec, open on delivery."
            />
            <div className="flex flex-col gap-[11px] font-mono text-[12.5px]">
              {bounty.deadline ? (
                <div className="flex justify-between">
                  <span className="text-dark-muted">deadline</span>
                  <span className="text-dark-text">{bounty.deadline}</span>
                </div>
              ) : null}
              <div className="flex justify-between">
                <span className="text-dark-muted">publishes to</span>
                <span className="text-dark-text">hugging face</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dark-muted">license</span>
                <span className="text-dark-text">{bounty.openLicense ?? "open"}</span>
              </div>
              {isDelivered && bounty.hfSlug && (
                <div className="mt-1 border-t border-dashed border-dark-line pt-[11px] text-[11px] leading-relaxed text-dark-soft">
                  <span className="text-dark-dim">hf:</span>{" "}
                  <a
                    href={hfDatasetUrl(bounty.hfSlug)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-lime underline-offset-2 hover:underline"
                  >
                    {bounty.hfSlug}
                  </a>
                  {bounty.deliveredAt && <>{" "}· published {isoDate(bounty.deliveredAt)}</>}
                  {/* Generic: any confirmed publication target beyond Hugging
                      Face — github, aikosh, whatever comes next — renders here
                      with zero new code, matching publicPublicationsOf() on
                      the API side. */}
                  {bounty.publications?.map((p) => (
                    <span key={p.target}>
                      {" "}
                      ·{" "}
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-lime underline-offset-2 hover:underline"
                      >
                        {p.target} ↗
                      </a>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Quality panel */}
          <div className="card-dark p-[22px]">
            <PanelHeading
              title="Quality signals"
              sub="Measured pipeline stats for this dataset. A dash means the platform does not publish that measure for this pool."
            />
            <div className="flex flex-col gap-[9px] font-mono text-xs">
              <div className="flex justify-between">
                <span className="text-dark-muted">submitted items</span>
                <span className="text-dark-text">
                  {optionalNum(bounty.communityProgress?.totalSubmitted)}
                </span>
              </div>
              {/* Everything that did not clear verification, in one number —
                  flagged, rejected, and failed-automated-checks combined. Always
                  known for a community pool, unlike duplicate rate below, so
                  it renders a real count rather than a dash. */}
              <div className="flex justify-between">
                <span className="text-dark-muted">rejected items</span>
                <span
                  className="text-dark-text"
                  title="Flagged, rejected, or failed an automated check (dedup, contamination, execution, or schema)."
                >
                  {bounty.communityProgress
                    ? num(
                        (bounty.communityProgress.rejected ?? 0) +
                          (bounty.communityProgress.flagged ?? 0) +
                          (bounty.communityProgress.failedAutomatedChecks ?? 0)
                      )
                    : "—"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-dark-muted">duplicate rate</span>
                <span className="text-dark-text">{optionalPct(bounty.duplicateRate)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dark-muted">contributors</span>
                <span className="text-dark-text">{optionalNum(bounty.contributorCount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dark-muted">validators</span>
                <span className="text-dark-text">{optionalNum(bounty.validatorCount)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Slots */}
        {bounty.slots.length > 0 && (
          <div className="mb-9">
            <h2 className="mb-1 font-display text-[19px] font-bold leading-[normal]">{"// task_slots"}</h2>
            <p className="mb-4 text-[13px] text-dark-muted">
              The dataset is split into slots by topic and difficulty.
            </p>
            <div className="overflow-x-auto rounded-[11px] border border-dark-line font-mono">
              <div className="min-w-[560px]">
                <div className="micro-label grid grid-cols-[2fr_1fr_1.4fr] border-b border-dark-line bg-dark-card px-5 py-3 text-dark-dim">
                  <span>slot</span>
                  <span>difficulty</span>
                  <span>accepted / target</span>
                </div>
                {bounty.slots.map((slot, i) => {
                  const filled =
                    slot.targetItems === 0
                      ? 0
                      : Math.min(100, (slot.acceptedItems / slot.targetItems) * 100);
                  return (
                    <div
                      key={slot.id}
                      className={`grid grid-cols-[2fr_1fr_1.4fr] items-center px-5 py-3.5 text-[12.5px] ${
                        i < bounty.slots.length - 1 ? "border-b border-dark-line" : ""
                      }`}
                    >
                      <span className="text-dark-text">{slot.name}</span>
                      <span className={DIFFICULTY_COLORS[slot.difficulty]}>{slot.difficulty}</span>
                      <div>
                        <div className="mb-[5px] flex justify-between">
                          <span className="text-dark-muted">
                            {num(slot.acceptedItems)} / {num(slot.targetItems)}
                          </span>
                          <span className="text-dark-dim">{Math.round(filled)}%</span>
                        </div>
                        <div className="h-1 overflow-hidden rounded-sm bg-dark-track">
                          <div className="h-full bg-lime" style={{ width: `${filled}%` }} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Dataset-type samples — admin-authored, shown by default (not
            behind a toggle) when present. Absent/empty renders nothing: no
            placeholder, matching how this page treats other genuinely-absent
            (not just zero) data, e.g. the omitted deadline line above. */}
        {datasetTypeSamples.length > 0 && (
          <div className="mb-9">
            <h2 className="mb-1 font-display text-[19px] font-bold leading-[normal]">{"// dataset_type_samples"}</h2>
            <p className="mb-4 text-[13px] text-dark-muted">
              Illustrative samples authored for the {datasetTypeName} dataset type.
            </p>
            {datasetTypeSamples.length > 1 && (
              <div className="mb-4 flex flex-wrap gap-2 font-mono text-xs">
                {datasetTypeSamples.map((sample, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setActiveSampleIndex(i)}
                    className={`rounded-[7px] border px-3 py-1.5 transition-colors ${
                      i === activeSampleIndexClamped
                        ? "border-lime bg-[rgba(182,255,28,.06)] text-lime"
                        : "border-dark-line text-dark-soft hover:border-dark-hover hover:text-dark-text"
                    }`}
                  >
                    {sample.caption ? truncateLabel(sample.caption, 28) : `Sample ${i + 1}`}
                  </button>
                ))}
              </div>
            )}
            {(() => {
              const sample = datasetTypeSamples[activeSampleIndexClamped];
              const sampleFieldEntries = sample.fields ? Object.entries(sample.fields) : [];
              return (
                <article className="card-dark p-[22px]">
                  {sample.caption && (
                    <p className="mb-3 text-[13px] text-dark-text">{sample.caption}</p>
                  )}
                  {sampleFieldEntries.length > 0 && (
                    <div className="mb-3 flex flex-col gap-3 font-mono text-xs">
                      {sampleFieldEntries.map(([key, value]) => {
                        const classified = classifyFieldValue(value);
                        if (classified.kind === "short") {
                          return (
                            <div key={key} className="flex justify-between gap-4">
                              <span className="shrink-0 text-dark-dim">{key}</span>
                              <span className="break-words text-right text-dark-text">{value}</span>
                            </div>
                          );
                        }
                        const filename = `${datasetType.id}-sample-${activeSampleIndexClamped + 1}-${slugifyKey(key)}.${classified.ext}`;
                        return (
                          <div key={key} className="flex flex-col gap-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="micro-label text-dark-dim">{key}</span>
                              <div className="flex items-center gap-1.5">
                                <CopyButton value={classified.content} label={key} />
                                <DownloadFieldButton
                                  filename={filename}
                                  content={classified.content}
                                  mime={classified.mime}
                                  label={key}
                                />
                              </div>
                            </div>
                            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-dark-line bg-dark-card p-3 font-mono text-[11px] leading-relaxed text-dark-text">
                              {classified.content}
                            </pre>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {sample.media && sample.media.length > 0 && (
                    <div className="flex flex-wrap gap-3">
                      {sample.media.map((m) => (
                        <div key={m.key} className="w-full max-w-[280px]">
                          {m.kind === "image" && (
                            // eslint-disable-next-line @next/next/no-img-element -- read-only public preview of an admin-provided URL, not an app asset.
                            <img
                              src={m.url}
                              alt={m.alt ?? ""}
                              className="w-full rounded-md border border-dark-line"
                            />
                          )}
                          {m.kind === "video" && (
                            <video src={m.url} controls className="w-full rounded-md border border-dark-line" />
                          )}
                          {m.kind === "audio" && <audio src={m.url} controls className="w-full" />}
                          {m.kind === "file" && (
                            <a
                              href={m.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-mono text-xs text-lime hover:text-lime-bright"
                            >
                              {m.alt || "download file"} ↓
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              );
            })()}
          </div>
        )}

        {/* Sample item */}
        <div>
          <h2 className="mb-1 font-display text-[19px] font-bold leading-[normal]">{"// sample_item"}</h2>
          <p className="mb-4 text-[13px] text-dark-muted">
            Approved public samples for this {datasetTypeName} dataset. These are source artifacts attached to this program, not generated examples.
          </p>
          {publicSamples.length === 0 ? (
            <div className="card-dark p-[22px] text-sm text-dark-muted">
              No public sample item is available for this dataset yet.
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {publicSamples.map((sample) => {
                const content = sample.sample.content!;
                const fields = parseSampleFields(content);
                return (
                  <article key={sample.id} className="card-dark p-[22px]">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
                      <span className="text-dark-text">{sample.filename}</span>
                      <a href={sampleDownloadUrl(sample)} className="text-lime hover:text-lime-bright">
                        download ↓
                      </a>
                    </div>
                    {fields ? (
                      <div className="flex flex-col gap-4">
                        {fields.map(([key, value]) => (
                          <div key={key}>
                            <div className="micro-label mb-2 text-dark-dim">{key}</div>
                            <CodeBlock code={sampleValue(value)} label={key} className="border-dark-line!" />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <CodeBlock code={content} label={sample.filename} className="border-dark-line!" />
                    )}
                    {sample.sample.truncated && (
                      <p className="mt-3 text-xs text-dark-soft">Preview shortened; download the approved source file for the complete sample.</p>
                    )}
                  </article>
                );
              })}
            </div>
          )}
          {hiddenSampleCount > 0 && (
            <p className="mt-3 text-xs text-dark-soft">
              +{hiddenSampleCount} more sample{hiddenSampleCount === 1 ? "" : "s"} attached but not currently viewable.
            </p>
          )}
        </div>

        {/* Bottom CTA */}
        <div className="mt-6 flex flex-col items-start justify-between gap-4 rounded-xl border border-dark-line-soft bg-dark-deep px-[30px] py-[26px] sm:flex-row sm:items-center">
          <div>
            <div className="mb-1 text-base font-bold text-dark-text">
              {isDelivered
                ? "This dataset shipped"
                : "Ready to contribute to this dataset?"}
            </div>
            <div className="text-[13px] text-dark-muted">
              {isDelivered ? (
                <span className="font-mono">
                  <span className="text-dark-dim">hf:</span>{" "}
                  {bounty.hfSlug ? (
                    <a
                      href={hfDatasetUrl(bounty.hfSlug)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-lime underline-offset-2 hover:underline"
                    >
                      {bounty.hfSlug}
                    </a>
                  ) : (
                    <span className="text-lime">pending</span>
                  )}
                  {bounty.deliveredAt && <>{" "}· published {isoDate(bounty.deliveredAt)}</>}
                  {" "}· {bounty.openLicense}
                  {bounty.publications?.map((p) => (
                    <span key={p.target}>
                      {" "}
                      ·{" "}
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-lime underline-offset-2 hover:underline"
                      >
                        {p.target} ↗
                      </a>
                    </span>
                  ))}
                </span>
              ) : finalPerItem ? (
                `Contribute to this open pool. ${fullHuman ? "Every automation-cleared item receives a human-validator decision." : "A clean automated-pipeline result is final."} ${num(karmaValue)} karma releases immediately on final acceptance and Hugging Face sync is queued.`
              ) : (
                `Contribute to this open pool. ${num(karmaValue)} karma is secured on each final acceptance and added to your balance after verified publication.`
              )}
            </div>
          </div>
          {isDelivered ? (
            <PublicSampleDownloadLink
              sample={downloadableSample}
              className="shrink-0 cursor-pointer rounded-lg border border-dark-line-soft px-5 py-[13px] font-mono text-[13px] font-medium text-dark-text transition-colors hover:border-dark-hover"
            />
          ) : (
            <Link
              href={`${DASHBOARD_URL}/contributor?bounty=${bounty.id}`}
              className="shrink-0 rounded-lg bg-lime px-5 py-[13px] font-mono text-[13px] font-medium text-dark transition-colors hover:bg-lime-bright"
            >
              connect to contribute →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
