"use client";

// SPDX-License-Identifier: Apache-2.0

import Image from "next/image";
import { useState } from "react";
import { ArtifactUpload, humanSize } from "@/components/artifacts";
import { Icon } from "@/components/icons";
import { Select } from "@/components/ui";
import { artifactContentUrl, type ApiArtifact } from "@/lib/api-artifacts";
import type { DatasetType, TypeField } from "@/lib/dataset-types";

/** Modality → preview renderer. Adding a new previewable file modality means
 * registering a function here, not branching further conditionals — new
 * dataset-type file fields (any modality) render without touching this file. */
const FILE_PREVIEW_REGISTRY: Record<string, (artifact: ApiArtifact) => React.ReactNode> = {
  image: (artifact) => (
    <Image
      src={artifactContentUrl(artifact)}
      alt={artifact.filename}
      width={64}
      height={64}
      unoptimized
      className="h-16 w-16 rounded object-cover"
    />
  ),
  video: (artifact) => (
    <video src={artifactContentUrl(artifact)} className="h-16 w-28 rounded object-cover" controls muted />
  ),
  audio: (artifact) => <audio src={artifactContentUrl(artifact)} className="h-9 w-56 max-w-full" controls />,
  pdf: (artifact) => (
    <iframe
      src={artifactContentUrl(artifact)}
      title={artifact.filename}
      sandbox=""
      className="h-24 w-20 shrink-0 rounded border border-line-soft bg-white"
    />
  ),
};

function fileModality(contentType: string): string {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType === "application/pdf") return "pdf";
  return "default";
}

function FilePreviewThumb({ artifact }: { artifact: ApiArtifact }) {
  const render = FILE_PREVIEW_REGISTRY[fileModality(artifact.contentType)];
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3 rounded-lg border border-line-soft bg-panel px-3 py-2">
      {render ? render(artifact) : <Icon name="file" size={20} className="shrink-0 text-ink-soft" />}
      <div className="min-w-0">
        <p className="truncate font-mono text-xs text-ink">{artifact.filename}</p>
        <p className="font-mono text-[11px] text-ink-faint">{artifact.contentType}</p>
      </div>
    </div>
  );
}

/** File-field values live in the same per-field string slot as every other
 * field (see payloadFromValues/valuesFromPayload); multi-file fields encode
 * their artifact ids as a JSON array string so single-file fields (the
 * common case) keep the plain bare-id format unchanged. */
function parseFileIds(value: string): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // not JSON — treat as a single legacy bare artifact id
  }
  return [value];
}

function serializeFileIds(ids: string[]): string {
  return ids.length <= 1 ? (ids[0] ?? "") : JSON.stringify(ids);
}

export const inputCls =
  "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none";
export const codeCls =
  "w-full rounded-lg border border-line bg-panel px-3 py-2 font-mono text-xs leading-relaxed text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none";

export function Field({
  label,
  fieldKey,
  required = false,
  hint,
  children,
}: {
  label: string;
  fieldKey?: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <label className="micro-label text-ink-soft">
          {label}
          {required && <span className="ml-0.5 text-rose-500">*</span>}
        </label>
        {fieldKey && (
          <span className="rounded border border-line-soft bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink-faint">
            {fieldKey}
          </span>
        )}
      </div>
      {children}
      {hint && <p className="mt-1 text-xs text-ink-soft">{hint}</p>}
    </div>
  );
}

export function stringValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

export function requiredMissing(type: DatasetType | null, payload: Record<string, unknown>): string[] {
  if (!type) {
    return ["title", "prompt", "brokenCode", "fixedCode", "tests"].filter(
      (key) => stringValue(payload[key]).trim() === ""
    );
  }
  return type.fields
    .filter((field) => field.required)
    .filter((field) => {
      const raw = payload[field.key];
      if (field.role === "file" && (field.maxCount ?? 1) > 1) {
        return !Array.isArray(raw) || raw.length < (field.minCount ?? 1);
      }
      return stringValue(raw).trim() === "";
    })
    .map((field) => field.key);
}

export function fieldRows(type: DatasetType): TypeField[] {
  return type.fields;
}

/** Builds the submission payload from per-field string state, splitting
 * "list"-role fields into arrays. Mirrors the shape the API expects for
 * POST /v1/batches/:id/items and POST /v1/submissions/:id/revise. */
export function payloadFromValues(type: DatasetType, values: Record<string, string>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const field of fieldRows(type)) {
    const raw = values[field.key] ?? "";
    if (field.role === "list") {
      next[field.key] = raw
        .split(/\n|,/)
        .map((item) => item.trim())
        .filter(Boolean);
    } else if (field.role === "file" && (field.maxCount ?? 1) > 1) {
      next[field.key] = parseFileIds(raw);
    } else {
      next[field.key] = raw.trim();
    }
  }
  return next;
}

/** Inverse of payloadFromValues — seeds per-field string state from an
 * existing payload object (e.g. when opening the revision editor). */
export function valuesFromPayload(type: DatasetType, payload: Record<string, unknown> | null | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fieldRows(type)) {
    const raw = payload?.[field.key];
    if (field.role === "list" && Array.isArray(raw)) {
      values[field.key] = raw.join("\n");
    } else if (field.role === "file" && (field.maxCount ?? 1) > 1 && Array.isArray(raw)) {
      values[field.key] = serializeFileIds(raw.filter((v): v is string => typeof v === "string"));
    } else {
      values[field.key] = stringValue(raw);
    }
  }
  return values;
}

/** Uploads a media/binary field to the batch's upload scope and reports back
 * the field's value (a bare artifact id, or — for fields declaring
 * `maxCount > 1` — a JSON array of ids); the API re-parents artifacts onto the
 * submission at item-create time (POST /v1/batches/:id/items). Slot count,
 * accepted types, and per-file size limit all come from the dataset type's
 * field definition, so this one component serves every modality and every
 * bounty's contract without per-type branching. */
export function FileFieldInput({
  field,
  submissionId,
  contributorBatchId,
  bountyId,
  value,
  onChange,
}: {
  field: TypeField;
  submissionId?: string;
  // Exactly one of these should be set: a claimed ContributorBatch submission
  // passes contributorBatchId; a no-claim community open-pool submission
  // (COMMUNITY_OPEN_POOL_PLAN_V2) has no ContributorBatch and passes bountyId
  // instead — ArtifactUpload already accepts either scoping key.
  contributorBatchId?: string;
  bountyId?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const maxCount = field.maxCount ?? 1;
  const allowMultiple = maxCount > 1;
  const ids = allowMultiple ? parseFileIds(value) : value ? [value] : [];
  const [knownArtifacts, setKnownArtifacts] = useState<Record<string, ApiArtifact>>({});
  const atLimit = allowMultiple && ids.length >= maxCount;

  const addId = (id: string) => {
    onChange(allowMultiple ? serializeFileIds([...ids, id].slice(0, maxCount)) : id);
  };
  const removeId = (id: string) => {
    onChange(allowMultiple ? serializeFileIds(ids.filter((existing) => existing !== id)) : "");
    setKnownArtifacts((prev) => {
      const rest = { ...prev };
      delete rest[id];
      return rest;
    });
  };

  const countHint = allowMultiple ? ` · ${ids.length}/${maxCount} uploaded` : "";
  const sizeHint = field.maxSizeBytes ? ` · up to ${humanSize(field.maxSizeBytes)} each` : "";

  return (
    <div className="space-y-2">
      {!atLimit && (
        <ArtifactUpload
          kind="submission_attachment"
          submissionId={submissionId}
          contributorBatchId={contributorBatchId}
          bountyId={bountyId}
          accept={field.accept}
          multiple={allowMultiple}
          maxSizeBytes={field.maxSizeBytes}
          label={ids.length ? (allowMultiple ? "Add another required file" : "Replace uploaded file") : `Upload ${field.required ? "the required" : "an optional"} ${field.label}`}
          hint={"Attached to this contribution and checked before submission. " + (field.accept ? `Accepted file types: ${field.accept}` : "Any type accepted.") + sizeHint + countHint}
          onUploaded={(uploaded) => {
            setKnownArtifacts((prev) => ({ ...prev, [uploaded.id]: uploaded }));
            addId(uploaded.id);
          }}
        />
      )}
      {ids.map((id) => {
        const artifact = knownArtifacts[id];
        return (
          <div key={id} className="flex items-center gap-2">
            {artifact ? (
              <FilePreviewThumb artifact={artifact} />
            ) : (
              <p className="min-w-0 flex-1 break-all font-mono text-[11px] text-ink-faint">uploaded (id: {id})</p>
            )}
            {allowMultiple && (
              <button
                type="button"
                onClick={() => removeId(id)}
                className="shrink-0 rounded-md border border-line px-2 py-1 text-xs text-ink-soft hover:bg-panel"
              >
                Remove
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function DynamicFieldInput({
  field,
  submissionId,
  contributorBatchId,
  bountyId,
  value,
  onChange,
}: {
  field: TypeField;
  submissionId?: string;
  contributorBatchId?: string;
  bountyId?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const codeLike = ["input_code", "solution_code", "tests", "expected_output"].includes(field.role);
  if (field.role === "file") {
    return <FileFieldInput field={field} submissionId={submissionId} contributorBatchId={contributorBatchId} bountyId={bountyId} value={value} onChange={onChange} />;
  }
  if (field.role === "enum" && field.options?.length) {
    return (
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select...</option>
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
    );
  }
  return (
    <textarea
      className={codeLike ? codeCls : inputCls}
      rows={codeLike ? 8 : field.role === "list" ? 3 : 4}
      spellCheck={!codeLike}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.role === "list" ? "One item per line or comma-separated values" : field.label}
    />
  );
}

/** Schema-driven field editor shared by the first-submit form and the
 * revision editor — renders one typed input per dataset-type field so
 * revising a rejected item doesn't require hand-editing raw JSON. */
export function DynamicFieldsEditor({
  type,
  submissionId,
  contributorBatchId,
  bountyId,
  values,
  onChange,
}: {
  type: DatasetType;
  submissionId?: string;
  // Exactly one of these — see FileFieldInput above.
  contributorBatchId?: string;
  bountyId?: string;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className="grid gap-4">
      {fieldRows(type).map((field) => (
        <Field key={field.key} label={field.label} fieldKey={field.key} required={field.required} hint={field.help}>
          <DynamicFieldInput
            field={field}
            submissionId={submissionId}
            contributorBatchId={contributorBatchId}
            bountyId={bountyId}
            value={values[field.key] ?? ""}
            onChange={(value) => onChange(field.key, value)}
          />
        </Field>
      ))}
    </div>
  );
}
