"use client";

// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";
import { adminAuthedFetch } from "@/lib/admin-auth";
import { useAdminToast } from "@/lib/admin-toast";
import {
  AdminButton,
  AdminConfirmDialog,
  AdminPill,
  AdminSectionHeading,
  type AdminPillTone,
} from "@/components/admin-shell";

/**
 * Verification-harness panel for sponsor custom/forked dataset types
 * (CUSTOM_TYPE_HARNESS_BINDING_PLAN.md). Admin authors a harness, proves it
 * against expected-pass AND expected-fail samples in the real sandbox, and
 * only then can bind it. Loosely bound: everything arrives via props, all
 * data flows through the admin API layer (adminAuthedFetch), no page coupling.
 */

type HarnessStatus = "draft" | "proof_pending" | "verified" | "retired";

interface ProofSampleResult {
  index: number;
  label: string | null;
  expected: "pass" | "fail";
  // `harness_fault` (the harness threw) and `no_verdict` (ran but produced no
  // contract verdict) are distinct from a submission failing — they block the
  // bind and must read as "fix the harness", never as "the sample was bad".
  actual: "pass" | "fail" | "harness_fault" | "no_verdict" | "runtime_unavailable" | "error";
  logsExcerpt: string;
}

interface ProofEvidence {
  outcome: "passed" | "failed";
  sourceSha: string;
  samples: ProofSampleResult[];
  ranAt: string;
  reason?: string;
}

interface ProofSample {
  payload: Record<string, unknown>;
  expected: "pass" | "fail";
  label?: string;
}

interface HarnessRow {
  id: string;
  version: number;
  status: HarnessStatus;
  source: string;
  sourceSha: string;
  declaredRuntimes: string[];
  proofEvidence: ProofEvidence | null;
  /** The sample set the last proof was requested with, so a reload does not
   * force the admin to retype it. Evidence keeps each sample's verdict but not
   * its payload, which is why this is stored separately. */
  proofSamples: ProofSample[] | null;
  updatedAt: string;
}

const STATUS_TONE: Record<HarnessStatus, AdminPillTone> = {
  draft: "neutral",
  proof_pending: "info",
  verified: "success",
  retired: "neutral",
};

const STATUS_LABEL: Record<HarnessStatus, string> = {
  draft: "draft",
  proof_pending: "proof running",
  verified: "verified · bound",
  retired: "retired",
};

const SAMPLES_PLACEHOLDER = JSON.stringify(
  [
    { payload: { field_key: "a valid example" }, expected: "pass", label: "clean row" },
    { payload: { field_key: "a deliberately broken example" }, expected: "fail", label: "must be rejected" },
  ],
  null,
  2
);

const inputCls =
  "w-full rounded-lg border border-dark-line-soft bg-dark-field px-3 py-2 font-mono text-xs text-dark-text transition-colors focus:border-dark-hover focus:outline-none";

export function HarnessPanel({ datasetTypeId, typeIsActive, isAdmin }: { datasetTypeId: string; typeIsActive: boolean; isAdmin: boolean }) {
  const { pushToast } = useAdminToast();
  const [rows, setRows] = useState<HarnessRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceDraft, setSourceDraft] = useState("");
  const [runtimesDraft, setRuntimesDraft] = useState("");
  const [samplesDraft, setSamplesDraft] = useState(SAMPLES_PLACEHOLDER);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"bind" | "retire" | null>(null);

  // Prefill the editors once per loaded row, inside the fetch callback rather
  // than an effect (drafts are the admin's in-progress edit after that).
  const prefilledFor = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await adminAuthedFetch(`/v1/admin/dataset-types/${encodeURIComponent(datasetTypeId)}/harness`);
      const data = (await response.json().catch(() => null)) as { harnesses?: HarnessRow[]; message?: string } | null;
      if (!response.ok) throw new Error(data?.message ?? "Could not load harnesses.");
      const fetched = data?.harnesses ?? [];
      setRows(fetched);
      const head = fetched[0];
      if (head && prefilledFor.current !== head.id) {
        prefilledFor.current = head.id;
        setSourceDraft(head.source);
        setRuntimesDraft(head.declaredRuntimes.join(", "));
        // Remembered samples beat the placeholder: re-proving an edited harness
        // should not mean retyping the cases it must still satisfy.
        if (head.proofSamples?.length) setSamplesDraft(JSON.stringify(head.proofSamples, null, 2));
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load harnesses.");
    }
  }, [datasetTypeId]);

  useEffect(() => {
    // Deferred a tick (same pattern as the dataset detail page's search-params
    // read) so the lint-guarded "no synchronous setState in effects" rule holds.
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // A running proof resolves asynchronously in the worker — poll while pending.
  const latest = rows?.[0] ?? null;
  useEffect(() => {
    if (latest?.status !== "proof_pending") return;
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [latest?.status, load]);

  const call = async (path: string, body?: unknown): Promise<boolean> => {
    setBusy(true);
    try {
      const response = await adminAuthedFetch(`/v1/admin/dataset-types/${encodeURIComponent(datasetTypeId)}/harness${path}`, {
        method: path === "" ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const data = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) throw new Error(data?.message ?? "The harness action failed.");
      await load();
      return true;
    } catch (cause) {
      pushToast({ variant: "error", title: cause instanceof Error ? cause.message : "The harness action failed." });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async () => {
    const declaredRuntimes = runtimesDraft
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    if (await call("", { source: sourceDraft, declaredRuntimes })) {
      pushToast({ variant: "success", title: "Harness draft saved", body: "Run a proof before it can be bound." });
    }
  };

  const draftWithAi = async () => {
    setBusy(true);
    try {
      const response = await adminAuthedFetch(`/v1/admin/dataset-types/${encodeURIComponent(datasetTypeId)}/harness/draft-assist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await response.json().catch(() => null)) as {
        draft?: { source: string; declaredRuntimes: string[]; notes: string[] } | null;
        message?: string;
      } | null;
      if (!response.ok) throw new Error(data?.message ?? "AI drafting is unavailable.");
      if (!data?.draft) {
        pushToast({ variant: "info", title: "No AI draft available", body: "Author the harness manually." });
        return;
      }
      setSourceDraft(data.draft.source);
      setRuntimesDraft(data.draft.declaredRuntimes.join(", "));
      pushToast({
        variant: "success",
        title: "AI draft loaded into the editor",
        body: "Review and edit it — it still needs a passing proof run before it can be bound.",
      });
    } catch (cause) {
      pushToast({ variant: "error", title: cause instanceof Error ? cause.message : "AI drafting is unavailable." });
    } finally {
      setBusy(false);
    }
  };

  const runProof = async () => {
    let samples: unknown;
    try {
      samples = JSON.parse(samplesDraft);
    } catch {
      pushToast({ variant: "error", title: "Proof samples are not valid JSON" });
      return;
    }
    // Pin the request to the source this panel is showing: another admin may
    // have saved a new version since it loaded, and proving/binding theirs under
    // this operator's review would bind code nobody on screen reviewed.
    if (await call("/proof-run", { samples, expectedSourceSha: latest?.sourceSha })) {
      pushToast({ variant: "success", title: "Proof run queued", body: "Results appear here when the sandbox finishes." });
    }
  };

  const evidence = latest?.proofEvidence ?? null;
  const boundRow = rows?.find((r) => r.status === "verified") ?? null;
  const canBind = latest?.status === "draft" && evidence?.outcome === "passed" && evidence.sourceSha === latest.sourceSha;

  return (
    <section className="space-y-4">
      <AdminSectionHeading
        title="Verification harness"
        sub="Admin-authored execution harness for this sponsor type. It must prove itself against at least one expected-pass and one expected-fail sample in the real sandbox before it can be bound — until then, submissions honestly route to human audit."
      />
      {error && (
        <p role="alert" className="text-sm text-rose-300">
          {error}
        </p>
      )}
      {rows && rows.length === 0 && (
        <p className="text-sm text-dark-soft">
          No harness yet — this type&apos;s execution stage reports <span className="font-mono">no_executable_harness</span> and items route to
          human audit. Author one below to enable real execution verification.
        </p>
      )}
      {latest && (
        <div className="flex flex-wrap items-center gap-2">
          <AdminPill tone={STATUS_TONE[latest.status]}>{STATUS_LABEL[latest.status]}</AdminPill>
          <AdminPill tone="neutral">v{latest.version}</AdminPill>
          <span className="font-mono text-[10px] text-dark-dim">sha {latest.sourceSha.slice(0, 12)}…</span>
          {boundRow && boundRow.id !== latest.id && <AdminPill tone="success">v{boundRow.version} currently bound</AdminPill>}
        </div>
      )}

      {isAdmin && !typeIsActive && (
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1.5 block font-mono text-[9px] uppercase tracking-[0.05em] text-dark-dim">
              harness.js source — module.exports.verify(row, h)
            </span>
            <textarea
              className={`${inputCls} min-h-[180px]`}
              value={sourceDraft}
              onChange={(e) => setSourceDraft(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block font-mono text-[9px] uppercase tracking-[0.05em] text-dark-dim">
              declared runtimes (comma-separated; must already be baked into the sandbox image)
            </span>
            <input className={inputCls} value={runtimesDraft} onChange={(e) => setRuntimesDraft(e.target.value)} placeholder="node, python3" />
          </label>
          <label className="block">
            <span className="mb-1.5 block font-mono text-[9px] uppercase tracking-[0.05em] text-dark-dim">
              proof samples — JSON array; at least one expected-pass and one expected-fail
            </span>
            <textarea
              className={`${inputCls} min-h-[120px]`}
              value={samplesDraft}
              onChange={(e) => setSamplesDraft(e.target.value)}
              spellCheck={false}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <AdminButton
              variant="ghost"
              onClick={() => void draftWithAi()}
              disabled={busy}
              tooltip="Flag-gated (planner.harness_draft.enabled, off by default). Advisory only — you still review, prove and bind."
            >
              Draft with AI
            </AdminButton>
            <AdminButton variant="ghost" onClick={() => void saveDraft()} disabled={busy || sourceDraft.trim().length < 20}>
              Save draft
            </AdminButton>
            <AdminButton
              variant="ghost"
              onClick={() => void runProof()}
              disabled={busy || !latest || latest.status === "proof_pending"}
              tooltip="Runs every sample through the real sandbox; results are recorded as immutable evidence."
            >
              {latest?.status === "proof_pending" ? "Proof running…" : "Run proof"}
            </AdminButton>
            <AdminButton
              variant="primary"
              onClick={() => setConfirm("bind")}
              disabled={busy || !canBind}
              tooltip="Makes this harness the type's execution verifier. Enabled only after a passing proof run for this exact source."
            >
              Bind harness
            </AdminButton>
            {boundRow && (
              <AdminButton variant="danger" onClick={() => setConfirm("retire")} disabled={busy}>
                Retire bound harness
              </AdminButton>
            )}
          </div>
        </div>
      )}
      {isAdmin && typeIsActive && (
        <p className="text-sm text-dark-soft">
          This type is active, so its verified harness is immutable — create and activate a new type version to change it.
        </p>
      )}

      {evidence && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <AdminPill tone={evidence.outcome === "passed" ? "success" : "danger"}>proof {evidence.outcome}</AdminPill>
            <span className="font-mono text-[10px] text-dark-dim">ran {new Date(evidence.ranAt).toLocaleString()}</span>
          </div>
          {evidence.reason && <p className="text-sm text-amber-400">{evidence.reason}</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-[11px] text-dark-soft">
              <thead>
                <tr className="text-dark-dim">
                  <th className="py-1 pr-3">#</th>
                  <th className="py-1 pr-3">sample</th>
                  <th className="py-1 pr-3">expected</th>
                  <th className="py-1 pr-3">actual</th>
                  <th className="py-1">log</th>
                </tr>
              </thead>
              <tbody>
                {evidence.samples.map((s) => (
                  <tr key={s.index} className="border-t border-dark-line-soft align-top">
                    <td className="py-1.5 pr-3">{s.index}</td>
                    <td className="py-1.5 pr-3">{s.label ?? "—"}</td>
                    <td className="py-1.5 pr-3">{s.expected}</td>
                    <td className={`py-1.5 pr-3 ${s.actual === s.expected ? "text-emerald-400" : "text-rose-400"}`}>{s.actual}</td>
                    <td className="max-w-[360px] whitespace-pre-wrap break-words py-1.5">{s.logsExcerpt.slice(0, 300)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <AdminConfirmDialog
        open={confirm === "bind"}
        title="Bind this harness?"
        description="Submissions to this type will be execution-verified by this exact source. The passing proof evidence is stored immutably against its hash."
        confirmLabel="Bind harness"
        danger={false}
        busy={busy}
        onConfirm={() => {
          void call("/bind", { expectedSourceSha: latest?.sourceSha }).then((ok) => {
            if (ok) pushToast({ variant: "success", title: "Harness bound" });
            setConfirm(null);
          });
        }}
        onCancel={() => setConfirm(null)}
      />
      <AdminConfirmDialog
        open={confirm === "retire"}
        title="Retire the bound harness?"
        description="The type falls back to the honest no-harness state: execution reports no_executable_harness and items route to human audit."
        confirmLabel="Retire harness"
        busy={busy}
        onConfirm={() => {
          void call("/retire").then((ok) => {
            if (ok) pushToast({ variant: "success", title: "Harness retired" });
            setConfirm(null);
          });
        }}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}
