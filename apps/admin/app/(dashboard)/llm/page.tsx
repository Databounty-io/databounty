"use client";

// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AdminButton,
  AdminConfirmDialog,
  AdminErrorBanner,
  AdminPageHeader,
  AdminPill,
  AdminSectionHeading,
  AdminStat,
  AdminTable,
  ATd,
} from "@/components/admin-shell";
import { adminAuthedFetch, useAdminRoleGates } from "@/lib/admin-auth";
import { useAdminToast } from "@/lib/admin-toast";
import { PromptEditor } from "@/components/prompt-editor";
import { AdminSearchSelect } from "@/components/admin-search-select";

// Community features supported by LLM:
type FeatureName =
  | "submission_review"
  | "planner_copy"
  | "planner_answer_extract"
  | "suggest"
  | "interpret_edit_intent"
  | "dataset_type_draft";

interface RoutingOverride {
  id: string;
  feature: FeatureName;
  accountId: string | null;
  modelKey: string | null;
  maxTokens: number | null;
  temperature: number | null;
  timeoutMs: number | null;
  enabled: boolean | null;
  evalId: string | null;
}

interface FeatureRow {
  feature: FeatureName;
  highStakes: boolean;
  dataClass: string;
  defaultModels: string[];
  params: { maxTokens: number; temperature: number; timeoutMs: number };
  prompt: { text: string; source: string; version: string };
  globalOverride: RoutingOverride | null;
  accountOverride: RoutingOverride | null;
}

interface EvalRow {
  id: string;
  feature: FeatureName;
  accountId: string | null;
  target: "prompt" | "routing" | "prompt_and_routing";
  status: string;
  configHash: string;
  candidatePrompt: string | null;
  candidateConfig: Record<string, unknown> | null;
  sampleCount: number;
  passRate: number | null;
  regressionRate: number | null;
  canaryPercent: number;
  notes: string | null;
  createdAt: string;
}

interface SettingsPayload {
  features: FeatureRow[];
  evaluations: EvalRow[];
  accountId: string | null;
}

interface OpenRouterModel {
  id: string;
  name: string;
  contextWindow: number | null;
  supportsJson: boolean;
}

interface ScopeAccount {
  id: string;
  name: string;
  email: string | null;
  handle: string | null;
  status: string;
}

const featureLabel = (f: string) => f.replaceAll("_", " ");

const FEATURE_META: Partial<Record<FeatureName, { title: string; sub: string; tone: "info" | "lime" }>> = {
  planner_copy: {
    title: "Request planner · copy",
    sub: "Sponsor-facing question and hint wording. It cannot change planner values or advance the workflow.",
    tone: "info",
  },
  planner_answer_extract: {
    title: "Request planner · answer extraction",
    sub: "Reads a sponsor's chat answer into candidate fields; server validation remains authoritative.",
    tone: "info",
  },
  suggest: {
    title: "Request planner · title suggestions",
    sub: "Optional request-title ideas only.",
    tone: "info",
  },
  interpret_edit_intent: {
    title: "Request planner · edit intent",
    sub: "Detects an explicit request to revise an earlier planner answer; it never writes the change itself.",
    tone: "info",
  },
  dataset_type_draft: {
    title: "Dataset type drafting",
    sub: "DeepSeek proposes an editable contract only. Server validation and explicit admin activation remain authoritative.",
    tone: "lime",
  },
};

function pct(n: number | null | undefined) {
  return n == null ? "-" : `${Math.round(n * 100)}%`;
}

function EditInput({
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 w-full rounded-lg border border-dark-line bg-dark px-3 font-mono text-xs text-dark-text outline-none focus:border-lime/60"
    />
  );
}

export default function AdminLlmPage() {
  const { isAdmin } = useAdminRoleGates();
  const [accountId, setAccountId] = useState("");
  const [accounts, setAccounts] = useState<ScopeAccount[]>([]);
  const [accountSearch, setAccountSearch] = useState("");
  const [accountNextCursor, setAccountNextCursor] = useState<string | null>(null);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { pushToast } = useAdminToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Partial<RoutingOverride> & { prompt?: string; evalId?: string }>>({});
  // Confirmation gates. Routing/prompt saves are only gated when the feature
  // is flagged highStakes — a standard feature keeps saving immediately, so
  // this never adds friction the data model itself says isn't warranted.
  const [routingConfirm, setRoutingConfirm] = useState<FeatureRow | null>(null);
  const [promptConfirm, setPromptConfirm] = useState<FeatureRow | null>(null);
  const [evalCreateConfirm, setEvalCreateConfirm] = useState<FeatureRow | null>(null);
  const [evalApproveConfirm, setEvalApproveConfirm] = useState<EvalRow | null>(null);
  const [openRouterModels, setOpenRouterModels] = useState<OpenRouterModel[] | null>(null);
  const [openRouterFetchedAt, setOpenRouterFetchedAt] = useState<string | null>(null);
  const [openRouterCacheHit, setOpenRouterCacheHit] = useState<boolean | null>(null);
  const [evalDraft, setEvalDraft] = useState({
    feature: "submission_review" as FeatureName,
    target: "routing" as EvalRow["target"],
    status: "eval_passed",
    sampleCount: "50",
    passRate: "0.95",
    regressionRate: "0",
    canaryPercent: "5",
    notes: "",
  });

  const load = useCallback(() => {
    if (!isAdmin) return;
    setLoading(true);
    const q = accountId.trim() ? `?accountId=${encodeURIComponent(accountId.trim())}` : "";
    adminAuthedFetch(`/v1/admin/llm/settings${q}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to load LLM settings.");
        const body = (await res.json()) as SettingsPayload;
        setData(body);
        setError(null);
        const next: typeof drafts = {};
        for (const f of body.features) {
          const row = f.accountOverride ?? f.globalOverride;
          next[f.feature] = {
            modelKey: row?.modelKey ?? f.defaultModels[0] ?? "",
            maxTokens: row?.maxTokens ?? f.params.maxTokens,
            temperature: row?.temperature ?? f.params.temperature,
            timeoutMs: row?.timeoutMs ?? f.params.timeoutMs,
            enabled: row?.enabled ?? true,
            prompt: f.prompt.text,
            evalId: "",
          };
        }
        setDrafts(next);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load LLM settings."))
      .finally(() => setLoading(false));
  }, [accountId, isAdmin]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const loadAccounts = useCallback(async (query: string, cursor?: string | null) => {
    if (!isAdmin) return;
    setAccountsLoading(true);
    try {
      const params = new URLSearchParams({ limit: "20" });
      if (query.trim()) params.set("search", query.trim());
      if (cursor) params.set("cursor", cursor);
      const res = await adminAuthedFetch(`/v1/admin/llm/accounts?${params.toString()}`);
      const body = (await res.json().catch(() => null)) as { accounts?: ScopeAccount[]; nextCursor?: string | null; message?: string } | null;
      if (!res.ok || !body?.accounts) throw new Error(body?.message ?? "Could not load accounts.");
      setAccounts((current) => cursor ? [...current, ...body.accounts!] : body.accounts!);
      setAccountNextCursor(body.nextCursor ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load accounts.");
    } finally {
      setAccountsLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadAccounts(accountSearch); }, 250);
    return () => window.clearTimeout(timer);
  }, [accountSearch, loadAccounts]);

  const activeModels = useMemo(() => openRouterModels ?? [], [openRouterModels]);

  async function discoverOpenRouterModels(refresh = false) {
    setBusy("openrouter:discover");
    try {
      const res = await adminAuthedFetch(`/v1/admin/llm/openrouter/models${refresh ? "?refresh=true" : ""}`);
      const body = (await res.json().catch(() => null)) as { models?: OpenRouterModel[]; fetchedAt?: string; cacheHit?: boolean; message?: string } | null;
      if (!res.ok || !body?.models) throw new Error(body?.message ?? "Could not fetch OpenRouter models.");
      setOpenRouterModels(body.models);
      setOpenRouterFetchedAt(body.fetchedAt ?? null);
      setOpenRouterCacheHit(body.cacheHit ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not fetch OpenRouter models.");
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    if (!isAdmin || openRouterModels) return;
    const timer = window.setTimeout(() => void discoverOpenRouterModels(), 0);
    // Provider discovery is cached server-side; this only primes the routing
    // selectors once per page visit.
    return () => window.clearTimeout(timer);
  }, [isAdmin, openRouterModels]);

  async function saveRouting(feature: FeatureName) {
    const d = drafts[feature] ?? {};
    setBusy(`routing:${feature}`);
    try {
      const res = await adminAuthedFetch(`/v1/admin/llm/routing/${feature}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: accountId.trim() || null,
          modelKey: d.modelKey || null,
          maxTokens: Number(d.maxTokens),
          temperature: Number(d.temperature),
          timeoutMs: Number(d.timeoutMs),
          enabled: d.enabled ?? true,
          evaluationId: d.evalId || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Failed to save routing.");
      }
      load();
      pushToast({ variant: "success", title: `Routing saved for ${feature}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save routing.";
      setError(message);
      pushToast({ variant: "error", title: "Couldn't save routing", body: message });
    } finally {
      setBusy(null);
      setRoutingConfirm(null);
    }
  }

  async function savePrompt(feature: FeatureName) {
    const d = drafts[feature] ?? {};
    setBusy(`prompt:${feature}`);
    try {
      const res = await adminAuthedFetch(`/v1/admin/llm/prompts/${feature}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId || null, prompt: d.prompt ?? "", evaluationId: d.evalId || undefined }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Failed to save prompt.");
      }
      load();
      pushToast({ variant: "success", title: `Prompt saved for ${feature}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save prompt.";
      setError(message);
      pushToast({ variant: "error", title: "Couldn't save prompt", body: message });
    } finally {
      setBusy(null);
      setPromptConfirm(null);
    }
  }

  // NOTE (unresolved policy question, see Fix 5 in the confirm-dialog audit):
  // the "Advanced" panel's own copy says an approved evaluation is "required
  // for high-stakes changes", and the evaluation-picker's empty-state hint
  // says the same for a highStakes feature — but nothing here actually
  // enforces picking an approved evalId before saveRouting/savePrompt run.
  // It's ambiguous whether "create evaluation" is meant to exist BECAUSE
  // high-stakes saves are supposed to require one first (a real gate), or is
  // just an optional canary/eval record admins may attach. Until that's
  // resolved, this only adds a confirm dialog (matching the other fixes'
  // scope) rather than guessing at unbuilt enforcement.
  async function createEval(feature: FeatureRow) {
    const d = drafts[feature.feature] ?? {};
    const target = evalDraft.target;
    setBusy("eval:create");
    try {
      const res = await adminAuthedFetch("/v1/admin/llm/evaluations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feature: feature.feature,
          accountId: accountId.trim() || null,
          target,
          candidatePrompt: target === "routing" ? null : d.prompt,
          candidateConfig:
            target === "prompt"
              ? null
              : {
                  model: d.modelKey,
                  maxTokens: Number(d.maxTokens),
                  temperature: Number(d.temperature),
                  timeoutMs: Number(d.timeoutMs),
                  enabled: d.enabled ?? true,
                },
          status: evalDraft.status,
          sampleCount: Number(evalDraft.sampleCount),
          passRate: Number(evalDraft.passRate),
          regressionRate: Number(evalDraft.regressionRate),
          canaryPercent: Number(evalDraft.canaryPercent),
          notes: evalDraft.notes || null,
        }),
      });
      const body = (await res.json().catch(() => null)) as { evaluation?: EvalRow; message?: string } | null;
      if (!res.ok || !body?.evaluation) {
        throw new Error(body?.message || "Failed to create evaluation.");
      }
      setDrafts((current) => ({ ...current, [feature.feature]: { ...current[feature.feature], evalId: body.evaluation!.id } }));
      setData((current) => current ? { ...current, evaluations: [body.evaluation!, ...current.evaluations] } : current);
      pushToast({ variant: "success", title: "Evaluation created" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create evaluation.";
      setError(message);
      pushToast({ variant: "error", title: "Couldn't create evaluation", body: message });
    } finally {
      setBusy(null);
      setEvalCreateConfirm(null);
    }
  }

  async function approveEval(evaluation: EvalRow) {
    setBusy(`eval:${evaluation.id}`);
    try {
      const res = await adminAuthedFetch(`/v1/admin/llm/evaluations/${evaluation.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      });
      const body = (await res.json().catch(() => null)) as { evaluation?: EvalRow; message?: string } | null;
      if (!res.ok || !body?.evaluation) throw new Error(body?.message || "Failed to approve evaluation.");
      setDrafts((current) => ({ ...current, [evaluation.feature]: { ...current[evaluation.feature], evalId: evaluation.id } }));
      setData((current) => current ? { ...current, evaluations: current.evaluations.map((item) => item.id === evaluation.id ? body.evaluation! : item) } : current);
      pushToast({ variant: "success", title: "Evaluation approved" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to approve evaluation.";
      setError(message);
      pushToast({ variant: "error", title: "Couldn't approve evaluation", body: message });
    } finally {
      setBusy(null);
      setEvalApproveConfirm(null);
    }
  }

  if (!isAdmin) {
    return (
      <div className="space-y-5">
        <AdminPageHeader title="LLM Review Settings" sub="Admin access required." />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <AdminPageHeader
        title="AI settings"
        sub="Choose which model helps each feature. Suggestions never bypass platform validation or admin approval."
      />

      {error && <AdminErrorBanner message={error} onRetry={load} />}

      <section className="rounded-xl border border-dark-line bg-dark-card p-5">
        <AdminSectionHeading title="// account_scope" sub="Global is the platform default. Select a real account to create or view its scoped override." />
        <div className="max-w-2xl">
          <AdminSearchSelect
            value={accountId}
            onChange={setAccountId}
            options={[
              { value: "", label: "Global default", detail: "Applies to every account unless a scoped override exists." },
              ...accounts.map((account) => ({ value: account.id, label: account.name, detail: `${account.handle ? `@${account.handle} · ` : ""}${account.email ?? "no email"} · ${account.id} · ${account.status}` })),
            ]}
            placeholder="Select account scope…"
            searchPlaceholder="Search name, handle, email, or account ID…"
            searchMode="server"
            onSearchChange={setAccountSearch}
            hasMore={Boolean(accountNextCursor)}
            onLoadMore={() => void loadAccounts(accountSearch, accountNextCursor)}
            loading={accountsLoading}
            emptyLabel="No matching accounts."
          />
        </div>
      </section>

      {loading && !data && (
        <div role="status" className="font-mono text-sm text-dark-soft">Loading LLM settings…</div>
      )}

      {!loading && data && (
        <div className="grid gap-4 sm:grid-cols-3">
          <AdminStat label="provider models" value={openRouterModels?.length ?? "—"} sub="live OpenRouter catalog" />
          <AdminStat label="features" value={data.features.length} sub="routed call sites" />
          <AdminStat label="approvals" value={data.evaluations.filter((item) => item.status === "approved").length} sub="tested high-risk changes" tone="amber" />
        </div>
      )}

      {!loading && data && data.features.length === 0 && (
        <div className="rounded-xl border border-dark-line bg-dark-card px-5 py-6 text-sm text-dark-soft">
          No LLM features are configured yet.
        </div>
      )}

      <section className="space-y-4">
        {(data?.features.length ?? 0) > 0 && (
          <AdminSectionHeading title="// feature_models" sub="Select a live provider model, then save. Advanced controls are available only when needed." />
        )}
        {(data?.features ?? []).map((feature) => {
          const d = drafts[feature.feature] ?? {};
          const evaluationOptions = [
            { value: "", label: "No approval reference", detail: feature.highStakes ? "Choose an approved matching evaluation before saving." : "Not required for this standard feature." },
            ...(data?.evaluations ?? [])
              .filter((evaluation) => evaluation.feature === feature.feature && evaluation.accountId === (accountId || null))
              .map((evaluation) => ({
                value: evaluation.id,
                label: `${evaluation.status} · ${evaluation.target}`,
                detail: `${evaluation.id} · ${evaluation.sampleCount} samples · ${pct(evaluation.passRate)} pass`,
              })),
          ];
          const modelOptions = [
            ...feature.defaultModels.map((modelKey) => ({ value: modelKey, label: modelKey, detail: "Platform-approved default for this feature." })),
            ...activeModels
              .filter((model) => !feature.defaultModels.includes(model.id))
              .map((model) => ({ value: model.id, label: model.name, detail: `${model.id} · ${model.contextWindow?.toLocaleString() ?? "—"} context · ${model.supportsJson ? "JSON" : "no JSON"}` })),
          ];
          return (
            <div key={feature.feature} className="rounded-xl border border-dark-line bg-dark-card p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-mono text-base font-bold">{FEATURE_META[feature.feature]?.title ?? featureLabel(feature.feature)}</div>
                  {FEATURE_META[feature.feature] && <p className="mt-1 max-w-2xl text-xs leading-relaxed text-dark-soft">{FEATURE_META[feature.feature]?.sub}</p>}
                  <div className="mt-1 flex gap-2">
                    <AdminPill tone={feature.highStakes ? "danger" : "neutral"}>
                      {feature.highStakes ? "high stakes" : "standard"}
                    </AdminPill>
                    <AdminPill tone="info">{feature.dataClass}</AdminPill>
                    {feature.feature === "dataset_type_draft" && <AdminPill tone="lime">proposal only</AdminPill>}
                    <AdminPill tone={feature.prompt.source === "default" ? "neutral" : "warning"}>
                      prompt {feature.prompt.source}
                    </AdminPill>
                  </div>
                </div>
                <div className="font-mono text-[11px] text-dark-dim">{feature.prompt.version}</div>
              </div>

              <div className="grid gap-3 md:grid-cols-[1.2fr_0.5fr_auto] md:items-end">
                <label className="space-y-1">
                  <span className="font-mono text-[10px] uppercase text-dark-dim">model</span>
                  <AdminSearchSelect value={String(d.modelKey ?? "")} onChange={(modelKey) => setDrafts((p) => ({ ...p, [feature.feature]: { ...p[feature.feature], modelKey } }))} options={modelOptions} placeholder={openRouterModels ? "Select model…" : "Loading provider catalog…"} disabled={!openRouterModels} />
                </label>
                <label className="space-y-1">
                  <span className="font-mono text-[10px] uppercase text-dark-dim">status</span>
                  <AdminSearchSelect value={String(d.enabled ?? true)} onChange={(enabled) => setDrafts((p) => ({ ...p, [feature.feature]: { ...p[feature.feature], enabled: enabled === "true" } }))} options={[{ value: "true", label: "Enabled" }, { value: "false", label: "Disabled" }]} searchable={false} incremental={false} />
                </label>
                <AdminButton variant="primary" disabled={busy === `routing:${feature.feature}`} onClick={() => feature.highStakes ? setRoutingConfirm(feature) : void saveRouting(feature.feature)}>{busy === `routing:${feature.feature}` ? "saving…" : "save model"}</AdminButton>
              </div>

              <details className="mt-4 rounded-lg border border-dark-line-soft bg-dark-panel px-4 py-3">
                <summary className="cursor-pointer font-mono text-xs text-dark-soft">Advanced: limits, prompt, and approval evidence {feature.highStakes ? "(required for high-stakes changes)" : ""}</summary>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <label className="space-y-1"><span className="font-mono text-[10px] uppercase text-dark-dim">max tokens</span><EditInput value={String(d.maxTokens ?? "")} onChange={(v) => setDrafts((p) => ({ ...p, [feature.feature]: { ...p[feature.feature], maxTokens: Number(v) } }))} type="number" /></label>
                  <label className="space-y-1"><span className="font-mono text-[10px] uppercase text-dark-dim">temperature</span><EditInput value={String(d.temperature ?? "")} onChange={(v) => setDrafts((p) => ({ ...p, [feature.feature]: { ...p[feature.feature], temperature: Number(v) } }))} type="number" /></label>
                  <label className="space-y-1"><span className="font-mono text-[10px] uppercase text-dark-dim">timeout ms</span><EditInput value={String(d.timeoutMs ?? "")} onChange={(v) => setDrafts((p) => ({ ...p, [feature.feature]: { ...p[feature.feature], timeoutMs: Number(v) } }))} type="number" /></label>
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto]">
                  <AdminSearchSelect value={String(d.evalId ?? "")} onChange={(evalId) => setDrafts((p) => ({ ...p, [feature.feature]: { ...p[feature.feature], evalId } }))} options={evaluationOptions} searchable={evaluationOptions.length > 6} incremental={false} />
                  <AdminButton disabled={busy === "eval:create"} onClick={() => setEvalCreateConfirm(feature)}>create evaluation</AdminButton>
                </div>
                <label className="mt-4 block space-y-1"><span className="font-mono text-[10px] uppercase text-dark-dim">system prompt</span><PromptEditor value={String(d.prompt ?? "")} onChange={(v) => setDrafts((p) => ({ ...p, [feature.feature]: { ...p[feature.feature], prompt: v } }))} minHeight="180px" placeholder="System prompt sent to the model for this feature…" /></label>
                <div className="mt-3 flex justify-end"><AdminButton disabled={busy === `prompt:${feature.feature}`} onClick={() => feature.highStakes ? setPromptConfirm(feature) : void savePrompt(feature.feature)}>save prompt</AdminButton></div>
              </details>
            </div>
          );
        })}
      </section>

      <section className="rounded-xl border border-dark-line bg-dark-card p-5">
        <AdminSectionHeading title="// eval_template" sub="Used when creating a matching eval/canary record from a feature card." />
        <div className="grid gap-3 sm:grid-cols-5">
          <AdminSearchSelect value={evalDraft.target} onChange={(target) => setEvalDraft((p) => ({ ...p, target: target as EvalRow["target"] }))} options={[{ value: "routing", label: "Routing" }, { value: "prompt", label: "Prompt" }, { value: "prompt_and_routing", label: "Prompt and routing" }]} searchable={false} incremental={false} />
          <AdminSearchSelect value={evalDraft.status} onChange={(status) => setEvalDraft((p) => ({ ...p, status }))} options={[{ value: "draft", label: "Draft" }, { value: "eval_passed", label: "Eval passed" }, { value: "canary", label: "Canary" }, { value: "rejected", label: "Rejected" }]} searchable={false} incremental={false} />
          <EditInput value={evalDraft.sampleCount} onChange={(v) => setEvalDraft((p) => ({ ...p, sampleCount: v }))} type="number" />
          <EditInput value={evalDraft.passRate} onChange={(v) => setEvalDraft((p) => ({ ...p, passRate: v }))} type="number" />
          <EditInput value={evalDraft.regressionRate} onChange={(v) => setEvalDraft((p) => ({ ...p, regressionRate: v }))} type="number" />
        </div>
      </section>

      <section>
        <AdminSectionHeading title="// openrouter_catalog" sub="Live provider discovery. Results are read-only until an admin explicitly saves one as a routing override." />
        <div className="rounded-xl border border-dark-line bg-dark-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-2xl text-sm leading-relaxed text-dark-soft">Fetch supported models from OpenRouter using the server-side key. This never exposes the key and never changes routing automatically.</p>
            <div className="flex gap-2"><AdminButton disabled={busy === "openrouter:discover"} onClick={() => void discoverOpenRouterModels()}>{busy === "openrouter:discover" ? "fetching…" : "load catalog"}</AdminButton><AdminButton variant="primary" disabled={busy === "openrouter:discover"} onClick={() => void discoverOpenRouterModels(true)}>refresh live</AdminButton></div>
          </div>
          {openRouterModels && <div className="mt-4 max-h-72 overflow-y-auto rounded-lg border border-dark-line-soft"><AdminTable headers={["model", "context", "json"]}>{openRouterModels.map((model) => <tr key={model.id}><ATd className="font-semibold">{model.name}</ATd><ATd className="font-mono text-dark-soft">{model.contextWindow?.toLocaleString() ?? "—"}</ATd><ATd>{model.supportsJson ? "yes" : "no"}</ATd></tr>)}</AdminTable></div>}
          {openRouterFetchedAt && <div className="mt-2 font-mono text-[10px] text-dark-dim">{openRouterCacheHit ? "cached" : "live"} snapshot · {new Date(openRouterFetchedAt).toLocaleString()}</div>}
        </div>
      </section>

      <section>
        <AdminSectionHeading title="// evals_canaries" sub="Approved rows unlock matching high-stakes prompt/model changes." />
        <AdminTable headers={["feature", "target", "status", "samples", "pass", "regression", "canary", "hash", "action"]}>
          {(data?.evaluations ?? []).map((e) => (
            <tr key={e.id}>
              <ATd>{featureLabel(e.feature)}</ATd>
              <ATd>{e.target}</ATd>
              <ATd><AdminPill tone={e.status === "approved" ? "success" : e.status === "rejected" ? "danger" : "warning"}>{e.status}</AdminPill></ATd>
              <ATd>{e.sampleCount}</ATd>
              <ATd>{pct(e.passRate)}</ATd>
              <ATd>{pct(e.regressionRate)}</ATd>
              <ATd>{e.canaryPercent}%</ATd>
              <ATd className="font-mono text-[10px] text-dark-dim">{e.configHash.slice(0, 12)}</ATd>
              <ATd>
                {e.status !== "approved" ? (
                  <AdminButton disabled={busy === `eval:${e.id}`} onClick={() => setEvalApproveConfirm(e)}>
                    Approve
                  </AdminButton>
                ) : (
                  <span className="text-dark-dim">-</span>
                )}
              </ATd>
            </tr>
          ))}
          {!loading && (data?.evaluations.length ?? 0) === 0 && (
            <tr>
              <ATd colSpan={9} className="text-dark-soft">No evaluations have been recorded yet.</ATd>
            </tr>
          )}
        </AdminTable>
      </section>

      <AdminConfirmDialog
        open={routingConfirm !== null}
        title="Save this high-stakes routing change?"
        description={
          <>
            <span className="font-mono text-dark-text">{routingConfirm ? featureLabel(routingConfirm.feature) : ""}</span> is flagged
            high stakes ({routingConfirm?.dataClass}). This immediately changes which model handles live traffic for this feature
            {accountId.trim() ? " for the selected account" : " platform-wide"}, with no approved evaluation required by the system today.
          </>
        }
        confirmLabel="Save model"
        danger={false}
        busy={busy === `routing:${routingConfirm?.feature}`}
        onConfirm={() => { if (routingConfirm) void saveRouting(routingConfirm.feature); }}
        onCancel={() => setRoutingConfirm(null)}
      />

      <AdminConfirmDialog
        open={promptConfirm !== null}
        title="Save this high-stakes prompt change?"
        description={
          <>
            <span className="font-mono text-dark-text">{promptConfirm ? featureLabel(promptConfirm.feature) : ""}</span> is flagged
            high stakes ({promptConfirm?.dataClass}). This immediately replaces the system prompt sent to the model for this feature
            {accountId.trim() ? " for the selected account" : " platform-wide"}, with no approved evaluation required by the system today.
          </>
        }
        confirmLabel="Save prompt"
        danger={false}
        busy={busy === `prompt:${promptConfirm?.feature}`}
        onConfirm={() => { if (promptConfirm) void savePrompt(promptConfirm.feature); }}
        onCancel={() => setPromptConfirm(null)}
      />

      <AdminConfirmDialog
        open={evalCreateConfirm !== null}
        title="Create this evaluation record?"
        description={
          <>
            This records a new evaluation/canary entry for{" "}
            <span className="font-mono text-dark-text">{evalCreateConfirm ? featureLabel(evalCreateConfirm.feature) : ""}</span> using
            the values in the eval template below and the feature&rsquo;s current draft values. It does not by itself change routing
            or the live prompt — a separate save is still required to apply it.
          </>
        }
        confirmLabel="Create evaluation"
        danger={false}
        busy={busy === "eval:create"}
        onConfirm={() => { if (evalCreateConfirm) void createEval(evalCreateConfirm); }}
        onCancel={() => setEvalCreateConfirm(null)}
      />

      <AdminConfirmDialog
        open={evalApproveConfirm !== null}
        title="Approve this evaluation?"
        description={
          <>
            Approving <span className="font-mono text-dark-text">{evalApproveConfirm?.id}</span> marks it as evidence that a
            high-stakes prompt/model change for{" "}
            <span className="font-mono text-dark-text">{evalApproveConfirm ? featureLabel(evalApproveConfirm.feature) : ""}</span> passed
            review. This does not itself change routing or the live prompt, but it becomes selectable as approval evidence for future
            saves on this feature.
          </>
        }
        confirmLabel="Approve"
        danger={false}
        busy={busy === `eval:${evalApproveConfirm?.id}`}
        onConfirm={() => { if (evalApproveConfirm) void approveEval(evalApproveConfirm); }}
        onCancel={() => setEvalApproveConfirm(null)}
      />
    </div>
  );
}
