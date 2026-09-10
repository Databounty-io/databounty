"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { adminAuthedFetch, useAdminRoleGates } from "@/lib/admin-auth";
import { useAdminToast } from "@/lib/admin-toast";
import {
  AdminButton,
  AdminConfirmDialog,
  AdminPageHeader,
  AdminPill,
  AdminSectionHeading,
  AdminTable,
  ATd,
} from "@/components/admin-shell";
import { Icon } from "@/components/icons";
import { TypePreview } from "@/components/type-preview";
import { HarnessPanel } from "@/components/harness-panel";
import {
  DOMAINS,
  TRUST_TIER_LABELS,
  typeToYaml,
  type DatasetType,
  type DatasetTypeSample,
  type TrustTier,
  type TypeStatus,
  type VerificationCheck,
} from "@/lib/dataset-types";

const TIER_TONE: Record<TrustTier, "lime" | "info" | "violet"> = {
  execution_verified: "lime",
  llm_verified: "info",
  expert_audited: "violet",
};

const STATUS_LABEL: Record<TypeStatus, string> = {
  active: "active",
  draft: "draft",
  coming_soon: "coming soon",
  platform_review: "needs review",
};

const STATUS_TONE = {
  active: "success",
  draft: "neutral",
  coming_soon: "info",
  platform_review: "warning",
} as const;

const inputCls =
  "w-full rounded-lg border border-dark-line-soft bg-dark-field px-3 py-2 font-mono text-xs text-dark-text transition-colors focus:border-dark-hover focus:outline-none";

const PIPELINE_STAGES: Array<{ id: VerificationCheck; label: string; detail: string; locked?: boolean }> = [
  { id: "dedupe", label: "Duplicate", detail: "Exact submission identity", locked: true },
  { id: "ai_attribution", label: "AI attribution", detail: "Platform-wide disclosure and evidence check", locked: true },
  { id: "execution", label: "Execution", detail: "Sandbox tests" },
  { id: "llm", label: "LLM review", detail: "Configured quality rubric" },
  { id: "human_audit", label: "Validator audit", detail: "Independent validator decision; always last" },
];

function Micro({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.05em] text-dark-dim">
      {children}
    </div>
  );
}

export default function AdminDatasetTypeDetail() {
  const router = useRouter();
  const { isAdmin } = useAdminRoleGates();
  const [liveType, setLiveType] = useState<DatasetType | null>(null);
  const [loading, setLoading] = useState(true);
  const { pushToast } = useAdminToast();
  const [saving, setSaving] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const t = liveType;

  const [name, setName] = useState(t?.name ?? "");
  const [description, setDescription] = useState(t?.description ?? "");
  const [complexityScoreDraft, setComplexityScoreDraft] = useState(t?.complexityScore != null ? String(t.complexityScore) : "");
  const [verificationUnitsDraft, setVerificationUnitsDraft] = useState(t?.verificationUnits != null ? String(t.verificationUnits) : "");
  const [pipelineDraft, setPipelineDraft] = useState<VerificationCheck[]>([]);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [sampleAssetsDraft, setSampleAssetsDraft] = useState("[]");
  const [sampleAssetsError, setSampleAssetsError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    | { kind: "activate"; status: TypeStatus }
    | { kind: "review"; approve: boolean }
    | null
  >(null);
  const [rejectReason, setRejectReason] = useState("");

  // Derived, not latched on mount: Next does not remount on a query-only
  // change, so a one-shot read kept rendering (and editing) the previous type
  // after "create editable version" moved the URL to the new draft id.
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  useEffect(() => {
    if (!id) return;
    void adminAuthedFetch(`/v1/admin/dataset-types/${encodeURIComponent(id)}`)
      .then(async (response) => {
        const data = (await response.json().catch(() => null)) as { datasetType?: DatasetType; message?: string } | null;
        if (!response.ok) throw new Error(data?.message ?? "Could not load dataset type.");
        const found = data?.datasetType;
        if (!found) throw new Error("Dataset type not found.");
        setLiveType(found);
        setName(found.name);
        setDescription(found.description);
        setComplexityScoreDraft(found.complexityScore != null ? String(found.complexityScore) : "");
        setVerificationUnitsDraft(found.verificationUnits != null ? String(found.verificationUnits) : "");
        setPipelineDraft(found.verification.pipeline);
        setSampleAssetsDraft(JSON.stringify(found.sampleAssets ?? [], null, 2));
        setSampleAssetsError(null);
        setLiveError(null);
      })
      .catch((cause) => setLiveError(cause instanceof Error ? cause.message : "Could not load dataset type."))
      .finally(() => setLoading(false));
  }, [id]);

  // A missing ?id= is a derived fact about the URL, not loading state.
  if (loading && id !== null) {
    return <div role="status" className="font-mono text-sm text-dark-soft">Loading live dataset type…</div>;
  }

  if (!t) {
    return (
      <div className="space-y-4">
        <h1 className="font-mono text-2xl font-bold tracking-tight text-dark-text">
          Type not found
        </h1>
        <p role="alert" className="text-sm text-rose-300">
          {id === null ? "No dataset type id given." : liveError ?? "Dataset type not found in the live catalog."}
        </p>
        <Link
          href="/datasets"
          className="inline-flex items-center gap-2 font-mono text-xs text-lime hover:text-lime-bright"
        >
          ← back to catalog
        </Link>
      </div>
    );
  }

  const domain = DOMAINS.find((d) => d.id === t.domain);
  const dirty = name !== t.name || description !== t.description;
  const pricingIsSet = t.complexityScore != null && t.verificationUnits != null;
  const complexityScoreCurrent = t.complexityScore != null ? String(t.complexityScore) : "";
  const verificationUnitsCurrent = t.verificationUnits != null ? String(t.verificationUnits) : "";
  const pricingDirty = complexityScoreDraft !== complexityScoreCurrent || verificationUnitsDraft !== verificationUnitsCurrent;

  const persistPatch = async (patch: Partial<DatasetType>) => {
    if (saving) return;
    setSaving(true);
    try {
      const response = await adminAuthedFetch(`/v1/admin/dataset-types/${t.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = (await response.json().catch(() => null)) as { datasetType?: DatasetType; message?: string } | null;
      if (!response.ok) throw new Error(data?.message ?? "Could not save dataset type");
      if (!data?.datasetType) throw new Error("The saved dataset-type response was invalid.");
      setLiveType(data.datasetType);
      setPipelineDraft(data.datasetType.verification.pipeline);
      setSampleAssetsDraft(JSON.stringify(data.datasetType.sampleAssets ?? [], null, 2));
      setLiveError(null);
      pushToast({ variant: "success", title: "Dataset type saved" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save dataset type";
      setLiveError(message);
      pushToast({ variant: "error", title: "Couldn't save dataset type", body: message });
    } finally {
      setSaving(false);
    }
  };

  const saveMeta = () => {
    void persistPatch({
      name: name.trim() || t.name,
      description: description.trim() || t.description,
    });
  };

  // Karma rate axes — deliberately NOT part of the locked "active
  // contract" set, so these stay editable even once a type is active (a
  // complexity/verification-unit judgement is a karma-rate input, not part of
  // the contributor contract). Blank clears the field back to no karma rate, which
  // activation fails closed on — and which the server rejects outright on an
  // already-ACTIVE type, since bounties already open would otherwise keep
  // awarding on the flat fallback (KARMA_PRICING_MATRIX_PLAN.md).
  const savePricing = () => {
    const trimmedScore = complexityScoreDraft.trim();
    const trimmedUnits = verificationUnitsDraft.trim();
    const complexityScore = trimmedScore === "" ? null : Number(trimmedScore);
    const verificationUnits = trimmedUnits === "" ? null : Number(trimmedUnits);
    if (complexityScore !== null && (!Number.isInteger(complexityScore) || complexityScore < 1 || complexityScore > 4)) {
      pushToast({ variant: "error", title: "Complexity score must be an integer 1–4" });
      return;
    }
    if (verificationUnits !== null && (!Number.isInteger(verificationUnits) || verificationUnits < 0)) {
      pushToast({ variant: "error", title: "Verification units must be a non-negative integer" });
      return;
    }
    void persistPatch({ complexityScore, verificationUnits });
  };

  const setStatus = (status: TypeStatus) => {
    if (status === "active") {
      setConfirmAction({ kind: "activate", status });
      return;
    }
    void persistPatch({ status });
  };

  const toggleRequired = (key: string) => {
    void persistPatch({
      fields: t.fields.map((f) =>
        f.key === key ? { ...f, required: !f.required } : f
      ),
    });
  };

  const pipelineDirty = pipelineDraft.join("|") !== t.verification.pipeline.join("|");
  const pipelineEditable = isAdmin && t.status !== "active";
  const hasDecisionGate = pipelineDraft.some((stage) => !["dedupe"].includes(stage));

  const togglePipelineStage = (stage: VerificationCheck) => {
    if (!pipelineEditable || stage === "dedupe") return;
    setPipelineDraft((current) => {
      if (current.includes(stage)) return current.filter((item) => item !== stage);
      if (stage === "human_audit") return [...current, stage];
      const auditIndex = current.indexOf("human_audit");
      if (auditIndex < 0) return [...current, stage];
      return [...current.slice(0, auditIndex), stage, ...current.slice(auditIndex)];
    });
  };

  const movePipelineStage = (stage: VerificationCheck, direction: -1 | 1) => {
    if (!pipelineEditable || ["dedupe", "human_audit"].includes(stage)) return;
    setPipelineDraft((current) => {
      const index = current.indexOf(stage);
      const target = index + direction;
      if (index < 1 || target < 1 || target >= current.length || current[target] === "human_audit") return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  };

  const savePipeline = () => {
    if (!pipelineEditable || !hasDecisionGate) return;
    void persistPatch({ verification: { ...t.verification, pipeline: pipelineDraft } });
  };

  // sampleAssets is not part of the locked "active contract" set (fields,
  // verification, trustTier, category) — only the general active-type gate
  // applies: an admin may edit it any time, a member only while the type is
  // still a draft.
  const sampleAssetsEditable = isAdmin || t.status !== "active";
  const currentSampleAssetsJson = JSON.stringify(t.sampleAssets ?? [], null, 2);
  const sampleAssetsDirty = sampleAssetsDraft !== currentSampleAssetsJson;

  const saveSampleAssets = () => {
    if (!sampleAssetsEditable || saving) return;
    let parsedValue: DatasetTypeSample[];
    try {
      const raw: unknown = JSON.parse(sampleAssetsDraft);
      if (!Array.isArray(raw)) throw new Error("Sample assets must be a JSON array.");
      parsedValue = raw as DatasetTypeSample[];
    } catch (parseError) {
      setSampleAssetsError(parseError instanceof Error ? parseError.message : "Invalid JSON.");
      return;
    }
    setSampleAssetsError(null);
    void persistPatch({ sampleAssets: parsedValue.length ? parsedValue : null });
  };

  const createVersion = async () => {
    if (!isAdmin || saving) return;
    setSaving(true);
    try {
      const response = await adminAuthedFetch(`/v1/admin/dataset-types/${t.id}/versions`, { method: "POST" });
      const data = (await response.json().catch(() => null)) as { datasetType?: DatasetType; message?: string } | null;
      if (!response.ok || !data?.datasetType) throw new Error(data?.message ?? "Could not create an editable version.");
      pushToast({ variant: "success", title: "Editable version created" });
      router.push(`/datasets/view?id=${encodeURIComponent(data.datasetType.id)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create an editable version.";
      setLiveError(message);
      pushToast({ variant: "error", title: "Couldn't create version", body: message });
      setSaving(false);
    }
  };

  const decideReview = (approve: boolean) => {
    setRejectReason("");
    setConfirmAction({ kind: "review", approve });
  };

  const runConfirmAction = () => {
    if (!confirmAction) return;
    if (confirmAction.kind === "activate") {
      void persistPatch({ status: confirmAction.status });
    } else if (confirmAction.approve) {
      void persistPatch({ status: "active" });
    } else {
      if (!rejectReason.trim()) return;
      void persistPatch({ status: "draft", reviewNote: rejectReason.trim() });
    }
    setConfirmAction(null);
  };

  return (
    <div className="space-y-6">
      {/* ===== header ===== */}
      <div>
        <Link
          href="/datasets"
          className="font-mono text-[11px] text-dark-soft transition-colors hover:text-dark-text"
        >
          ← dataset types
        </Link>
        <div className="mt-2">
          <AdminPageHeader
            title={t.name}
            actions={(
              <>
                <AdminPill tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</AdminPill>
                <AdminPill tone={TIER_TONE[t.trustTier]}>{TRUST_TIER_LABELS[t.trustTier]}</AdminPill>
              </>
            )}
          />
        </div>
        <div className="mt-1.5 font-mono text-[11px] text-dark-dim">
          {t.id} · v{t.version} · {domain?.name ?? t.domain} · origin:{" "}
          {t.origin} ·{" "}
          {t.usageCount > 0
            ? `used by ${t.usageCount} pool${t.usageCount > 1 ? "s" : ""}`
            : "not yet used by any pool"}
        </div>
        <p className="mt-2.5 max-w-2xl text-sm leading-relaxed text-dark-soft">
          {t.description}
        </p>
      </div>
      {liveError && (
        <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
          {liveError} No local-only change was applied.
        </div>
      )}

      {/* ===== platform review decision ===== */}
      {t.status === "platform_review" && (
        <div className="rounded-[11px] border border-dark-warn-border bg-amber-400/10 p-[18px]">
          <div className="flex items-start gap-3">
            <Icon
              name="alert"
              size={16}
              strokeWidth={2}
              className="mt-0.5 shrink-0 text-amber-400"
            />
            <div className="flex-1">
              <div className="font-mono text-xs font-bold text-amber-400">
                Sponsor-submitted type — platform review required
              </div>
              <p className="mt-1 font-mono text-[11px] leading-relaxed text-dark-soft">
                Check the schema, verification pipeline, and the three surfaces
                below. Approving activates the type immediately; rejecting
                returns it to the sponsor as a draft.
              </p>
              <div className="mt-3 flex gap-2">
                <AdminButton variant="primary" disabled={saving} onClick={() => decideReview(true)}>
                  approve → active
                </AdminButton>
                <AdminButton variant="danger" disabled={saving} onClick={() => decideReview(false)}>
                  reject → draft
                </AdminButton>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-[1.15fr_1fr] gap-5 max-lg:grid-cols-1">
        {/* ===== left: schema + verification ===== */}
        <div className="space-y-6">
          <section>
            <AdminSectionHeading
              title="Schema fields"
              sub="Field roles drive all three surfaces. Toggle required per field."
            />
            <AdminTable
              headers={["key", "label", "role", "lang", "options", "required"]}
            >
              {t.fields.map((f) => (
                <tr key={f.key}>
                  <ATd className="font-semibold">{f.key}</ATd>
                  <ATd className="text-dark-soft">{f.label}</ATd>
                  <ATd>
                    <AdminPill tone="neutral">{f.role}</AdminPill>
                  </ATd>
                  <ATd className="text-dark-soft">{f.lang ?? "—"}</ATd>
                  <ATd className="max-w-44 text-dark-soft">
                    {f.options ? f.options.join(", ") : "—"}
                  </ATd>
                  <ATd>
                    <button
                      disabled={!pipelineEditable || saving}
                      onClick={() => toggleRequired(f.key)}
                      className={`rounded-full border px-3 py-1.5 font-mono text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-60 sm:px-2.5 sm:py-0.5 sm:text-[10px] ${
                        f.required
                          ? "border-lime/25 bg-lime/10 text-lime"
                          : "border-dark-line-soft text-dark-dim hover:text-dark-soft"
                      }`}
                    >
                      {f.required ? "required" : "optional"}
                    </button>
                  </ATd>
                </tr>
              ))}
            </AdminTable>
          </section>

          <section>
            <AdminSectionHeading
              title="Verification pipeline"
              sub="Enable stages and reorder automated gates. Duplicate and AI-attribution checks are mandatory; validator audit remains last."
            />
            <div className="space-y-4 rounded-xl border border-dark-line bg-dark-card p-[18px]">
              {t.status === "active" && isAdmin && (
                <div className="rounded-lg border border-sky-400/25 bg-sky-400/10 px-4 py-3">
                  <div className="font-mono text-xs font-bold text-sky-300">Active v{t.version} is immutable</div>
                  <p className="mt-1 text-xs leading-relaxed text-dark-soft">
                    Existing pools keep this exact contract. Create a draft version to change ordering or feature switches safely.
                  </p>
                  <AdminButton className="mt-3" disabled={saving} onClick={() => void createVersion()}>
                    {saving ? "creating…" : `create editable v${t.version + 1}`}
                  </AdminButton>
                </div>
              )}
              {!isAdmin && (
                <div className="rounded-lg border border-dark-line-soft bg-dark-field px-4 py-3 font-mono text-[11px] text-dark-soft">
                  Read only. Pipeline changes require Admin.
                </div>
              )}
              <div className="space-y-2" aria-label="Validation pipeline stages">
                {PIPELINE_STAGES.map((stage) => {
                  // This is injected server-side immediately after dedupe for
                  // every template, including legacy contracts that predate it.
                  const platformWideStage = stage.id === "ai_attribution";
                  const enabled = platformWideStage || pipelineDraft.includes(stage.id);
                  const rawIndex = pipelineDraft.indexOf(stage.id);
                  const index = platformWideStage
                    ? 2
                    : rawIndex + (pipelineDraft.includes("ai_attribution") ? 0 : 1);
                  const canMoveUp = pipelineEditable && enabled && !stage.locked && stage.id !== "human_audit" && rawIndex > 2;
                  const canMoveDown = pipelineEditable && enabled && !stage.locked && stage.id !== "human_audit" && rawIndex >= 2 && rawIndex < pipelineDraft.length - 1 && pipelineDraft[rawIndex + 1] !== "human_audit";
                  return (
                    <div key={stage.id} className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${enabled ? "border-dark-hover bg-[#11140f]" : "border-dark-line-soft bg-dark-field opacity-70"}`}>
                      <input
                        type="checkbox"
                        checked={enabled}
                        disabled={!pipelineEditable || stage.locked || saving}
                        onChange={() => togglePipelineStage(stage.id)}
                        aria-label={`${enabled ? "Disable" : "Enable"} ${stage.label}`}
                        className="h-4 w-4 accent-[#c9ff3d]"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-xs font-bold text-dark-text">{stage.label}</div>
                        <div className="mt-0.5 text-[11px] text-dark-dim">{stage.detail}</div>
                      </div>
                      {enabled && <span className="font-mono text-[10px] text-dark-dim">#{index + 1}</span>}
                      <div className="flex gap-1">
                        <button type="button" disabled={!canMoveUp || saving} onClick={() => movePipelineStage(stage.id, -1)} aria-label={`Move ${stage.label} earlier`} className="h-9 w-9 rounded border border-dark-line font-mono text-xs sm:h-7 sm:w-7 text-dark-soft hover:text-dark-text disabled:cursor-not-allowed disabled:opacity-30">↑</button>
                        <button type="button" disabled={!canMoveDown || saving} onClick={() => movePipelineStage(stage.id, 1)} aria-label={`Move ${stage.label} later`} className="h-9 w-9 rounded border border-dark-line font-mono text-xs sm:h-7 sm:w-7 text-dark-soft hover:text-dark-text disabled:cursor-not-allowed disabled:opacity-30">↓</button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {!hasDecisionGate && (
                <div role="alert" className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">
                  Enable at least one quality gate or validator audit. Duplicate and AI-attribution checks alone cannot approve accepted work.
                </div>
              )}
              <div className="flex items-center gap-3">
                <AdminButton variant="primary" disabled={!pipelineEditable || !pipelineDirty || !hasDecisionGate || saving} onClick={savePipeline}>
                  {saving ? "saving…" : "save pipeline"}
                </AdminButton>
                {pipelineDirty && <span className="font-mono text-[10px] text-amber-400">unsaved pipeline changes</span>}
              </div>
              <div className="grid grid-cols-3 gap-4 max-sm:grid-cols-1">
                <div>
                  <Micro>execution env</Micro>
                  <div className="font-mono text-xs text-dark-text">
                    {t.verification.executionEnv ?? "none"}
                  </div>
                </div>
                <div>
                  <Micro>dedupe embed fields</Micro>
                  <div className="font-mono text-xs text-dark-text">
                    {t.verification.dedupeFields.join(", ")}
                  </div>
                </div>
                <div>
                  <Micro>validator audit options</Micro>
                  <div className="font-mono text-xs text-dark-text">
                    {t.verification.auditOptions.map((o) => `${o}%`).join(" / ")}
                  </div>
                </div>
              </div>
              <div>
                <Micro>difficulty levels</Micro>
                <div className="flex gap-1.5">
                  {t.difficultyLevels.map((d) => (
                    <AdminPill key={d} tone="neutral">
                      {d}
                    </AdminPill>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section>
            <AdminSectionHeading
              title="Tweak"
              sub={`Editing this draft keeps v${t.version}; active contracts require a cloned version so live pools remain reproducible.`}
            />
            <div className="space-y-4 rounded-xl border border-dark-line bg-dark-card p-[18px]">
              <div>
                <div className="mb-1.5 flex items-center gap-2">
                  <Micro>karma rate</Micro>
                  <AdminPill tone={pricingIsSet ? "success" : "warning"}>
                    {pricingIsSet ? "rate set" : "no rate — activation blocked"}
                  </AdminPill>
                </div>
                <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
                  <div>
                    <Micro>complexity score (1–4)</Micro>
                    <input
                      type="number"
                      min={1}
                      max={4}
                      placeholder="—"
                      value={complexityScoreDraft}
                      onChange={(e) => setComplexityScoreDraft(e.target.value)}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <Micro>verification units</Micro>
                    <input
                      type="number"
                      min={0}
                      placeholder="—"
                      value={verificationUnitsDraft}
                      onChange={(e) => setVerificationUnitsDraft(e.target.value)}
                      className={inputCls}
                    />
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <AdminButton variant="primary" disabled={!pricingDirty || saving} onClick={savePricing}>
                    save karma rate
                  </AdminButton>
                  {pricingDirty && <span className="font-mono text-[10px] text-amber-400">unsaved karma rate changes</span>}
                </div>
              </div>
              <div>
                <Micro>status</Micro>
                <div className="flex flex-wrap gap-2">
                  {(["active", "draft", "coming_soon"] as TypeStatus[]).map(
                    (s) => (
                      <button
                        key={s}
                        disabled={saving || !isAdmin || (t.status === "active" && t.usageCount > 0 && s !== "active")}
                        onClick={() => t.status !== s && setStatus(s)}
                        className={`cursor-pointer rounded-full border px-3.5 py-1.5 font-mono text-xs transition-colors ${
                          t.status === s
                            ? "border-lime bg-lime text-dark"
                            : "border-dark-line text-dark-soft hover:border-dark-hover hover:text-dark-text"
                        }`}
                      >
                        {STATUS_LABEL[s]}
                      </button>
                    )
                  )}
                </div>
              </div>
              <div>
                <Micro>name</Micro>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <Micro>description</Micro>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  className={`${inputCls} resize-none leading-relaxed`}
                />
              </div>
              <div className="flex items-center gap-3">
                <AdminButton
                  variant="primary"
                  disabled={!dirty || saving}
                  onClick={saveMeta}
                >
                  save changes
                </AdminButton>
                {dirty && (
                  <span className="font-mono text-[10px] text-amber-400">
                    unsaved changes
                  </span>
                )}
              </div>
            </div>
          </section>

          <section>
            <AdminSectionHeading
              title="Sample preview"
              sub="Curated example item(s) shown on the template card. Null/empty renders an honest 'no sample yet' state — never fabricate a row here."
            />
            <div className="space-y-3 rounded-xl border border-dark-line bg-dark-card p-[18px]">
              {!sampleAssetsEditable && (
                <div className="rounded-lg border border-dark-line-soft bg-dark-field px-4 py-3 font-mono text-[11px] text-dark-soft">
                  Read only. Editing an active type&apos;s sample requires Admin.
                </div>
              )}
              <p className="font-mono text-[10px] leading-relaxed text-dark-dim">
                JSON array of {"{ fields?: Record<key,string>, media?: {key,url,kind,alt?}[], caption? }"}. Only real, licence-cleared examples belong here.
              </p>
              <textarea
                value={sampleAssetsDraft}
                onChange={(e) => setSampleAssetsDraft(e.target.value)}
                disabled={!sampleAssetsEditable || saving}
                rows={8}
                spellCheck={false}
                className={`${inputCls} resize-y overflow-x-auto font-mono leading-relaxed disabled:cursor-not-allowed disabled:opacity-60`}
              />
              {sampleAssetsError && (
                <div role="alert" className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">
                  {sampleAssetsError}
                </div>
              )}
              <div className="flex items-center gap-3">
                <AdminButton
                  variant="primary"
                  disabled={!sampleAssetsEditable || !sampleAssetsDirty || saving}
                  onClick={saveSampleAssets}
                >
                  {saving ? "saving…" : "save sample"}
                </AdminButton>
                {sampleAssetsDirty && (
                  <span className="font-mono text-[10px] text-amber-400">unsaved changes</span>
                )}
              </div>
            </div>
          </section>

          {/* Sponsor's own plain-text request for execution verification,
              written at fork/custom creation time — never executable code.
              Shown here, right above where an admin would actually author
              the real harness, so the request and the action live together. */}
          {t.origin === "sponsor" && t.sponsorHarnessNote && (
            <section className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-4">
              <AdminSectionHeading title="Sponsor requested execution verification" />
              <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-amber-100">
                {t.sponsorHarnessNote}
              </p>
              <p className="mt-2 text-[10px] text-amber-200/70">
                Plain-text request from the sponsor — not code, and nothing here has run. Author and verify the
                real harness below if you approve this request.
              </p>
            </section>
          )}

          {/* Bound execution harness — sponsor custom/forked types only; the
              33 platform categories keep their file-registry harnesses. */}
          {t.origin === "sponsor" && (
            <HarnessPanel datasetTypeId={t.id} typeIsActive={t.status === "active"} isAdmin={isAdmin} />
          )}
        </div>

        {/* ===== right: surfaces + yaml ===== */}
        <div className="space-y-6">
          <section>
            <AdminSectionHeading
              title="Surfaces"
              sub="Sponsor spec · contributor form · validator review — auto-rendered from field roles."
            />
            <TypePreview type={t} dark />
          </section>

          <section>
            <button
              onClick={() => setYamlOpen((o) => !o)}
              className="flex w-full cursor-pointer items-center justify-between rounded-xl border border-dark-line bg-dark-card px-[18px] py-3.5 font-mono text-xs text-dark-text transition-colors hover:border-dark-hover"
            >
              <span className="font-bold">
                YAML definition{" "}
                <span className="font-normal text-dark-dim">
                  — what the platform stores
                </span>
              </span>
              <Icon
                name={yamlOpen ? "chevron-down" : "chevron-right"}
                size={14}
                strokeWidth={2}
                className="text-dark-soft"
              />
            </button>
            {yamlOpen && (
              <pre className="mt-2 overflow-x-auto rounded-xl border border-dark-line bg-dark p-[18px] font-mono text-[11px] leading-relaxed text-dark-soft">
                {typeToYaml(t)}
              </pre>
            )}
          </section>
        </div>
      </div>

      <AdminConfirmDialog
        open={!!confirmAction}
        title={
          confirmAction?.kind === "activate"
            ? "Activate this dataset type?"
            : confirmAction?.approve
              ? "Approve and activate this type?"
              : "Reject this type?"
        }
        description={
          confirmAction?.kind === "activate" ? (
            "This makes it available for new community pools."
          ) : confirmAction?.approve ? (
            "This activates the sponsor-submitted type for new community pools."
          ) : (
            <div className="space-y-2">
              <p>The sponsor sees this reason on their submission.</p>
              <textarea
                autoFocus
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Why is this being declined?"
                rows={3}
                className={`${inputCls} resize-none leading-relaxed`}
              />
            </div>
          )
        }
        confirmLabel={confirmAction?.kind === "review" && !confirmAction.approve ? "Reject" : "Activate"}
        danger={confirmAction?.kind === "review" && !confirmAction.approve}
        confirmDisabled={confirmAction?.kind === "review" && !confirmAction.approve && !rejectReason.trim()}
        busy={saving}
        onConfirm={runConfirmAction}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}
