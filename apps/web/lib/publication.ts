// SPDX-License-Identifier: Apache-2.0

import type { DatasetPublication, PublicationState } from "@/lib/types";

const PUBLICATION_STATES: readonly PublicationState[] = [
  "not_published",
  "queued",
  "publishing",
  "published",
  "failed",
];

export function parseDatasetPublication(value: unknown): DatasetPublication | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;

  const state = row.state;
  if (typeof state !== "string" || !PUBLICATION_STATES.includes(state as PublicationState)) {
    return null;
  }
  if (typeof row.label !== "string" || typeof row.detail !== "string") return null;

  let datasetUrl: string | null = null;
  if (state === "published" && typeof row.datasetUrl === "string" && row.datasetUrl.trim()) {
    const href = row.datasetUrl.trim();
    if (/^https?:\/\//i.test(href)) datasetUrl = href;
  }

  const target =
    row.target === "huggingface" || row.target === "github" || row.target === "aikosh"
      ? row.target
      : null;

  const targets = Array.isArray(row.targets)
    ? row.targets
        .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
        .map((t) => ({
          target: (t.target === "huggingface" || t.target === "github" || t.target === "aikosh" ? t.target : "huggingface") as "huggingface" | "github" | "aikosh",
          name: typeof t.name === "string" ? t.name : "",
          state: (typeof t.state === "string" && PUBLICATION_STATES.includes(t.state as PublicationState) ? t.state : "not_published") as PublicationState,
          url: typeof t.url === "string" && /^https?:\/\//i.test(t.url.trim()) ? t.url.trim() : null,
          attested: Boolean(t.attested),
        }))
    : undefined;

  const progressValue = row.progress;
  const progress =
    progressValue && typeof progressValue === "object" &&
    Number.isSafeInteger((progressValue as Record<string, unknown>).finalAccepted) &&
    Number.isSafeInteger((progressValue as Record<string, unknown>).targetItems) &&
    Number.isSafeInteger((progressValue as Record<string, unknown>).remainingToTarget)
      ? {
          finalAccepted: (progressValue as Record<string, number>).finalAccepted,
          targetItems: (progressValue as Record<string, number>).targetItems,
          remainingToTarget: (progressValue as Record<string, number>).remainingToTarget,
        }
      : null;

  return {
    state: state as PublicationState,
    label: row.label,
    detail: row.detail,
    datasetUrl,
    target,
    targets,
    progress,
  };
}

export function parsePoolPublication(poolSummary: unknown): DatasetPublication | null {
  if (!poolSummary || typeof poolSummary !== "object") return null;
  return parseDatasetPublication((poolSummary as Record<string, unknown>).publication);
}
