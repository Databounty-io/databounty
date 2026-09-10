"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminButton, AdminErrorBanner, AdminModal, AdminPageHeader, AdminPill, AdminTable, AdminTableSkeletonRows, ATd } from "@/components/admin-shell";
import { adminAuthedFetch } from "@/lib/admin-auth";
import { useAdminResource } from "@/lib/use-admin-resource";
import { useAdminToast } from "@/lib/admin-toast";
import { COMMUNITY_REQUEST_STATUS_TONE, type CommunityRequestStatus as RequestStatus } from "@/lib/format";
type KarmaPricing = { contributorPerItem: number; contributorTotal: number; validatorPerAuditedItem: number; plannedAuditItems: number; validatorTotal: number; matrixVersion: number | null; complexityScore: number | null; verificationUnits: number | null; difficulty: string };
type Row = { id: string; title: string; description: string; proposedLicense: string; language?: string | null; framework?: string | null; targetItems?: number | null; difficultyMix?: string | null; auditCoveragePct?: number | null; status: RequestStatus; adminNote?: string | null; // `id` is sent by the API and was simply never declared here, so the sponsor
// column had no route to the account behind the request.
requester: { id: string; displayName: string; handle?: string | null }; datasetType?: { name: string } | null; mintedBounty?: { id: string; status: string } | null; karmaPreview?: KarmaPricing | null; createdAt: string; sampleGate?: SampleGate | null };
type NoteModal = { id: string; decision: "under_review" | "approved" | "declined" | "changes_requested" };

/** Reference-sample state for a request. Approving is GATED on this and minting
 *  re-checks it, so deciding without it on screen is deciding blind — and the
 *  samples themselves are reviewed in the Bounties review queue before a
 *  request can be approved. */
type SampleGate = { ok: boolean; approved: number; pending: number; rejected: number; min: number; max: number; reason: string | null };
type ImplementModal = { id: string; requestedItems: number | null };
export function CommunityRequestsSection({ embedded = false }: { embedded?: boolean }) {
  const [statusFilter, setStatusFilter] = useState<"all" | RequestStatus>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [selected, setSelected] = useState<Row | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  const query = new URLSearchParams({ limit: "25", ...(cursor ? { cursor } : {}), ...(statusFilter !== "all" ? { status: statusFilter } : {}), ...(debouncedSearch ? { search: debouncedSearch } : {}) }).toString();
  const { data, loading, error, refresh } = useAdminResource<{ requests: Row[]; nextCursor: string | null }>(`/v1/admin/community/requests?${query}`, { errorMessage: "Community requests are unavailable." });
  const [busy, setBusy] = useState<string | null>(null); const { pushToast } = useAdminToast();
  const [noteModal, setNoteModal] = useState<NoteModal | null>(null); const [adminNote, setAdminNote] = useState("");
  const [implementModal, setImplementModal] = useState<ImplementModal | null>(null); const [targetItems, setTargetItems] = useState("100");

  const resetPage = () => { setCursor(null); setCursorStack([null]); };

  const decide = async (id: string, decision: NoteModal["decision"], note: string) => {
    setBusy(id);
    try {
      const res = await adminAuthedFetch(`/v1/admin/community/requests/${id}/decision`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision, adminNote: note.trim() || undefined }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message ?? "Decision failed.");
      pushToast({ variant: "success", title: decision === "approved" ? "Request approved" : decision === "declined" ? "Request declined" : decision === "changes_requested" ? "Changes requested" : "Marked under review" });
      await refresh();
    } catch (e) { pushToast({ variant: "error", title: "Decision failed", body: e instanceof Error ? e.message : undefined }); }
    finally { setBusy(null); }
  };
  const implement = async (id: string, items: number) => {
    setBusy(id);
    try {
      const res = await adminAuthedFetch(`/v1/admin/community/requests/${id}/implement`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetItems: items }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message ?? "Implementation failed.");
      pushToast({ variant: "success", title: "Community program created" });
      await refresh();
    } catch (e) { pushToast({ variant: "error", title: "Implementation failed", body: e instanceof Error ? e.message : undefined }); }
    finally { setBusy(null); }
  };
  const openNoteModal = (id: string, decision: NoteModal["decision"]) => { setAdminNote(""); setNoteModal({ id, decision }); };
  // A decline reason (or a change request) reaches the requester, so it can't
  // be empty — an unexplained decline is both unhelpful and dishonest about
  // why it happened, and "request changes" with no note tells them nothing to
  // change. Both mirror the server's mandatory-note rule.
  const noteRequired = noteModal?.decision === "declined" || noteModal?.decision === "changes_requested";
  const noteValid = !noteRequired || adminNote.trim().length > 0;
  const submitNoteModal = async () => { if (!noteModal || !noteValid) return; const { id, decision } = noteModal; setNoteModal(null); await decide(id, decision, adminNote); };
  // Prefill from the request itself. This used to default to a flat "100" —
  // an admin approving a 2,000-item request would silently mint 100 unless
  // they noticed. Requests filed before the planner collected a count fall
  // back to the old default.
  const openImplementModal = (id: string) => {
    const row = data?.requests.find((r) => r.id === id);
    setTargetItems(String(row?.targetItems ?? 100));
    setImplementModal({ id, requestedItems: row?.targetItems ?? null });
  };
  const implementValid = Number.isInteger(Number(targetItems)) && Number(targetItems) >= 1;
  const submitImplementModal = async () => { if (!implementModal || !implementValid) return; const { id } = implementModal; setImplementModal(null); await implement(id, Number(targetItems)); };

  return <div className={embedded ? "mt-5" : "space-y-5"}>
    {!embedded && <AdminPageHeader title="Community requests" sub="Review the complete request before an approved, karma-only community program is created." />}
    {error && <AdminErrorBanner message={error} onRetry={() => void refresh()} />}
    <div className="flex flex-wrap gap-3">
      <input value={search} onChange={(event) => { setSearch(event.target.value); resetPage(); }} placeholder="Search request, sponsor, or handle" className="min-w-[240px] flex-1 rounded-lg border border-dark-line-soft bg-transparent px-3 py-2 text-sm text-dark-text outline-none focus:border-lime focus:ring-1 focus:ring-lime/30" />
      <select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as typeof statusFilter); resetPage(); }} className="rounded-lg border border-dark-line-soft bg-transparent px-3 py-2 text-sm text-dark-text outline-none focus:border-lime focus:ring-1 focus:ring-lime/30" aria-label="Filter by request status">
        <option value="all">All statuses</option><option value="submitted">Submitted</option><option value="under_review">In review</option><option value="changes_requested">Changes requested</option><option value="disputed">Disputed</option><option value="approved">Approved</option><option value="declined">Declined</option><option value="implemented">Implemented</option>
      </select>
    </div>
    <AdminTable headers={["Request", "Sponsor", "License", "Status", "Actions"]}>
      {loading ? <AdminTableSkeletonRows columns={5} rows={6} /> : data?.requests.length ? data.requests.map((r) => <tr key={r.id}>
        <ATd><button type="button" onClick={() => setSelected(r)} className="rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime"><div className="font-medium text-dark-text hover:underline">{r.title}</div><div className="mt-1 max-w-xl truncate text-xs text-dark-dim">{r.description}</div></button></ATd>
        <ATd>
          <Link href={`/users/view?id=${encodeURIComponent(r.requester.id)}`} className="text-lime underline">
            {r.requester.handle ? `@${r.requester.handle}` : r.requester.displayName}
          </Link>
        </ATd>
        <ATd>{r.proposedLicense}</ATd>
        <ATd>
          <AdminPill tone={COMMUNITY_REQUEST_STATUS_TONE[r.status]}>{r.status.replaceAll("_", " ")}</AdminPill>
          {/* Approving is gated on the samples and minting re-checks them, so
              the reviewer needs this before deciding — not after a 409. The
              samples are reviewed on Bounties, hence the link. */}
          {r.sampleGate && (
            <div className="mt-1">
              <AdminPill tone={r.sampleGate.ok ? "success" : "warning"}>
                samples {r.sampleGate.approved}/{r.sampleGate.min}
              </AdminPill>
              {/* The review queue lives on Open Program's Sample review tab,
                  not on the bounty's own detail page (which has no
                  sample-review UI) — same destination whether or not this
                  request has a minted bounty yet, so there's no reason to
                  branch on mintedBounty here any more (beyond picking the
                  right owner id/type below, so the tab opens scoped to THIS
                  request/pool instead of the platform-wide queue). */}
              {!r.sampleGate.ok && (
                <Link
                  href={`/open-program/?tab=samples&sampleOwnerType=${r.mintedBounty ? "bounty" : "dataset_request"}&sampleOwnerId=${encodeURIComponent(r.mintedBounty ? r.mintedBounty.id : r.id)}&sampleOwnerLabel=${encodeURIComponent(r.title)}`}
                  className="ml-2 text-[10px] text-dark-dim underline hover:text-dark-text"
                >
                  review samples
                </Link>
              )}
              {r.sampleGate.reason && (
                <div className="mt-0.5 max-w-xs text-[10px] leading-snug text-dark-dim">{r.sampleGate.reason}</div>
              )}
            </div>
          )}
        </ATd>
        <ATd><div className="flex flex-wrap gap-2">
          {r.status === "submitted" && <AdminButton onClick={() => openNoteModal(r.id, "under_review")} disabled={busy === r.id}>review</AdminButton>}
          {["submitted", "under_review", "changes_requested", "disputed"].includes(r.status) && <>
            <AdminButton onClick={() => openNoteModal(r.id, "approved")} disabled={busy === r.id}>approve</AdminButton>
            <AdminButton variant="danger" onClick={() => openNoteModal(r.id, "declined")} disabled={busy === r.id}>decline</AdminButton>
          </>}
          {["submitted", "under_review"].includes(r.status) && <AdminButton variant="ghost" onClick={() => openNoteModal(r.id, "changes_requested")} disabled={busy === r.id}>request changes</AdminButton>}
          {r.status === "approved" && <>
            <AdminButton variant="primary" onClick={() => openImplementModal(r.id)} disabled={busy === r.id}>create program</AdminButton>
            <AdminButton variant="ghost" onClick={() => openNoteModal(r.id, "changes_requested")} disabled={busy === r.id}>reopen for changes</AdminButton>
          </>}
          {r.status === "implemented" && r.mintedBounty && <Link href={`/open-program/?tab=programs&program=${encodeURIComponent(r.mintedBounty.id)}`} className="font-mono text-[11px] text-lime underline underline-offset-2 hover:text-lime-bright">view program →</Link>}
        </div></ATd>
      </tr>) : <tr><ATd colSpan={5}><p className="py-8 text-center text-sm text-dark-dim">No community requests.</p></ATd></tr>}
    </AdminTable>
    <div className="flex justify-end gap-2"><AdminButton variant="ghost" disabled={cursorStack.length <= 1 || loading} onClick={() => { const next = cursorStack.slice(0, -1); setCursorStack(next); setCursor(next[next.length - 1] ?? null); }}>Previous</AdminButton><AdminButton variant="ghost" disabled={!data?.nextCursor || loading} onClick={() => { if (!data?.nextCursor) return; setCursorStack((stack) => [...stack, data.nextCursor]); setCursor(data.nextCursor); }}>Next</AdminButton></div>

    <AdminModal open={selected !== null} onClose={() => setSelected(null)} panelClassName="w-full max-w-2xl rounded-[14px] border border-dark-line bg-dark-card p-5 shadow-xl">
      {selected && <><div className="font-mono text-[15px] font-bold text-dark-text">{selected.title}</div><dl className="mt-4 grid gap-3 text-sm"><div><dt className="text-dark-dim">Sponsor</dt><dd className="text-dark-text">{selected.requester.handle ? `@${selected.requester.handle}` : selected.requester.displayName}</dd></div><div><dt className="text-dark-dim">Dataset type</dt><dd className="text-dark-text">{selected.datasetType?.name ?? "Requires an admin-selected active type"}</dd></div><div><dt className="text-dark-dim">Requested license</dt><dd className="text-dark-text">{selected.proposedLicense}</dd></div><div><dt className="text-dark-dim">Requested scope</dt><dd className="text-dark-text">{selected.targetItems ? <>{selected.targetItems.toLocaleString()} items · {selected.language ?? "unspecified language"}{selected.framework ? ` · ${selected.framework}` : ""} · {(selected.difficultyMix ?? "unspecified").replaceAll("_", " ")} · {selected.auditCoveragePct ?? 0}% validator audit</> : <span className="text-dark-dim">Filed before scope was collected — set the item count when minting.</span>}</dd></div><div><dt className="text-dark-dim">Full request</dt><dd className="mt-1 whitespace-pre-wrap text-dark-text">{selected.description}</dd></div>{selected.adminNote && <div><dt className="text-dark-dim">Latest admin note</dt><dd className="mt-1 whitespace-pre-wrap text-dark-text">{selected.adminNote}</dd></div>}</dl><div className="mt-5 flex justify-end"><AdminButton variant="ghost" onClick={() => setSelected(null)}>Close</AdminButton></div></>}
    </AdminModal>

    <AdminModal open={noteModal !== null} onClose={() => setNoteModal(null)} panelClassName="w-full max-w-sm rounded-[14px] border border-dark-line bg-dark-card p-5 shadow-xl">
      <div className="font-mono text-[15px] font-bold text-dark-text">{noteModal?.decision === "declined" ? "Reason for declining" : noteModal?.decision === "changes_requested" ? "What should the sponsor change?" : "Review note"}</div>
      <p className="mt-1 text-[13px] text-dark-soft">{noteModal?.decision === "declined" ? "Required. The sponsor is notified of this decision and sees this reason — explain why it was declined." : noteModal?.decision === "changes_requested" ? "Required. The sponsor is notified and sees this — spell out exactly what to change before resubmitting." : "Optional. Shared with the sponsor and other admins on this request."}</p>
      <textarea autoFocus value={adminNote} onChange={(e) => setAdminNote(e.target.value)} maxLength={4000} rows={3} className="mt-3 w-full rounded-lg border border-dark-line-soft bg-transparent px-3 py-2 text-sm text-dark-text" placeholder={noteModal?.decision === "declined" ? "Why is this request being declined?" : noteModal?.decision === "changes_requested" ? "What needs to change?" : "Note (optional)"} />
      {noteRequired && !noteValid && <p className="mt-1 text-[11px] text-rose-400">{noteModal?.decision === "changes_requested" ? "Describe the changes needed." : "A reason is required to decline."}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <AdminButton variant="ghost" onClick={() => setNoteModal(null)}>Cancel</AdminButton>
        <AdminButton variant="primary" onClick={() => void submitNoteModal()} disabled={busy === noteModal?.id || !noteValid}>{noteModal?.decision === "declined" ? "Decline" : noteModal?.decision === "approved" ? "Approve" : noteModal?.decision === "changes_requested" ? "Request changes" : "Mark reviewed"}</AdminButton>
      </div>
    </AdminModal>

    <AdminModal open={implementModal !== null} onClose={() => setImplementModal(null)} panelClassName="w-full max-w-sm rounded-[14px] border border-dark-line bg-dark-card p-5 shadow-xl">
      <div className="font-mono text-[15px] font-bold text-dark-text">Create community program</div>
      <p className="mt-1 text-[13px] text-dark-soft">Mints exactly one karma-only community program as an open pool — anyone submits directly, no claim step, up to the item target. The sponsor is notified.</p>
      <label className="mt-3 block text-xs text-dark-dim">Target accepted items
        <input autoFocus type="number" min={1} value={targetItems} onChange={(e) => setTargetItems(e.target.value)} className="mt-1 w-full rounded-lg border border-dark-line-soft bg-transparent px-3 py-2 text-sm text-dark-text" />
      </label>
      {implementModal?.requestedItems != null && Number(targetItems) !== implementModal.requestedItems && (
        <p className="mt-1 text-[11px] text-amber-400">Overriding the requested {implementModal.requestedItems.toLocaleString()} items.</p>
      )}
      {(() => {
        const row = data?.requests.find((r) => r.id === implementModal?.id);
        const preview = row?.karmaPreview;
        return preview ? <div className="mt-3 rounded-lg border border-violet-400/30 bg-violet-500/5 p-3 text-xs text-dark-soft">
          <div className="font-medium text-violet-200">Karma matrix preview — frozen on creation</div>
          <div className="mt-1">Contributor: <span className="text-dark-text">+{preview.contributorPerItem} / accepted item · up to +{preview.contributorTotal.toLocaleString()} total</span></div>
          <div>Validator: <span className="text-dark-text">+{preview.validatorPerAuditedItem} / audited item · +{preview.validatorTotal.toLocaleString()} across {preview.plannedAuditItems.toLocaleString()} planned audits</span></div>
          <div className="mt-1 text-[11px] text-dark-dim">Matrix v{preview.matrixVersion ?? "—"} · complexity {preview.complexityScore ?? "unset"} · {preview.verificationUnits ?? "unset"} verification units · {preview.difficulty}</div>
          {/* Coverage sampling of clean items isn't live (every cleared item
              is currently a forced escalation), so the "planned audits"
              figure above is a design target, not what will actually
              happen, for any coverage between 1-99%. */}
          {typeof row?.auditCoveragePct === "number" && row.auditCoveragePct > 0 && row.auditCoveragePct < 100 && (
            <div className="mt-1 text-[11px] text-amber-300">Every item that clears automated checks currently gets a full validator review — this coverage % does not reduce that below 100% yet. Only 0% changes behavior, routing cleared items to the sponsor instead of a validator.</div>
          )}
        </div> : <p className="mt-3 text-[11px] leading-relaxed text-amber-300">The karma rate cannot be resolved yet. Set a complexity score (1–4) and verification units on the selected dataset type before creating this program.</p>;
      })()}
      <div className="mt-4 flex justify-end gap-2">
        <AdminButton variant="ghost" onClick={() => setImplementModal(null)}>Cancel</AdminButton>
        <AdminButton variant="primary" onClick={() => void submitImplementModal()} disabled={!implementValid || busy === implementModal?.id}>Create program</AdminButton>
      </div>
    </AdminModal>
  </div>;
}

export default function CommunityRequestsPage() {
  // This route exists only so an old bookmark/link to "community requests"
  // still resolves — the actual review UI is the Requests tab on Open
  // Program (see CommunityRequestsSection above, embedded there). Redirect
  // straight to that tab instead of Overview, or the redirect defeats its
  // own purpose.
  redirect("/open-program?tab=requests");
}
