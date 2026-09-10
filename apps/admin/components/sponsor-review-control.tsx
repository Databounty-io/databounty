"use client";

// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { AdminPill, type AdminPillTone } from "@/components/admin-shell";
import { adminAuthedFetch } from "@/lib/admin-auth";

/* Shared with the Artifacts page (app/(dashboard)/artifacts/page.tsx) and the
 * Open Program "Sample review" tab (app/(dashboard)/open-program/sponsor-
 * samples.tsx) — one implementation, so both surfaces call the exact same
 * POST /v1/artifacts/:id/sponsor-review endpoint the exact same way instead
 * of drifting into two slightly different review widgets. */

export interface SponsorReviewable {
  id: string;
  sponsorReviewStatus: string | null;
  sponsorReviewNote: string | null;
}

const SPONSOR_REVIEW_TONE: Record<string, AdminPillTone> = {
  approved: "success",
  needs_changes: "warning",
  rejected: "danger",
};

/**
 * Approve / needs-changes / reject for one sponsor_reference artifact —
 * `POST /v1/artifacts/:id/sponsor-review`. This is the piece that was
 * genuinely missing platform-wide: `sponsorReviewStatus` had columns, a
 * count-gate that reads it, and a review job whose own comment says
 * "sponsorReviewStatus stays whatever the admin set it to" — but nothing
 * anywhere ever set it. Without this control a sponsor's uploaded reference
 * examples could never leave "pending", so no community pool could ever
 * satisfy its sample gate.
 */
export function SponsorReviewControl<T extends SponsorReviewable>({
  artifact,
  onReviewed,
}: {
  artifact: T;
  onReviewed: (id: string, status: string, note: string | null) => void;
}) {
  const [note, setNote] = useState("");
  const [showNoteFor, setShowNoteFor] = useState<"needs_changes" | "rejected" | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (decision: "approved" | "needs_changes" | "rejected") => {
    if ((decision === "needs_changes" || decision === "rejected") && !note.trim()) {
      setShowNoteFor(decision);
      return;
    }
    setSaving(true);
    setErr("");
    try {
      const res = await adminAuthedFetch(`/v1/artifacts/${artifact.id}/sponsor-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note: note.trim() || undefined }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message || "Review failed.");
      }
      onReviewed(artifact.id, decision, note.trim() || null);
      setShowNoteFor(null);
      setNote("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Review failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <AdminPill tone={artifact.sponsorReviewStatus ? SPONSOR_REVIEW_TONE[artifact.sponsorReviewStatus] ?? "neutral" : "neutral"}>
          {artifact.sponsorReviewStatus ? artifact.sponsorReviewStatus.replaceAll("_", " ") : "pending review"}
        </AdminPill>
      </div>
      {artifact.sponsorReviewNote && (
        <div className="max-w-52 text-[10px] leading-snug text-dark-dim">{artifact.sponsorReviewNote}</div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={saving}
          onClick={() => void submit("approved")}
          className="cursor-pointer rounded-full border border-lime/50 px-2.5 py-1 font-mono text-[10px] text-lime hover:bg-lime/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          approve
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => (showNoteFor === "needs_changes" ? void submit("needs_changes") : setShowNoteFor("needs_changes"))}
          className="cursor-pointer rounded-full border border-amber-500/50 px-2.5 py-1 font-mono text-[10px] text-amber-400 hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          needs changes
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => (showNoteFor === "rejected" ? void submit("rejected") : setShowNoteFor("rejected"))}
          className="cursor-pointer rounded-full border border-rose-500/50 px-2.5 py-1 font-mono text-[10px] text-rose-400 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          reject
        </button>
      </div>
      {showNoteFor && (
        <div className="flex flex-col gap-1">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Explain what the sponsor must change…"
            className="w-52 rounded-md border border-dark-line bg-dark-panel p-1.5 font-mono text-[10px] text-dark-text focus:border-lime focus:outline-none"
          />
          <button
            type="button"
            disabled={saving || !note.trim()}
            onClick={() => void submit(showNoteFor)}
            className="cursor-pointer self-start rounded-full border border-dark-line px-2.5 py-1 font-mono text-[10px] text-dark-soft hover:border-dark-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "saving…" : `confirm ${showNoteFor.replaceAll("_", " ")}`}
          </button>
        </div>
      )}
      {err && <div className="text-[10px] text-rose-400">{err}</div>}
    </div>
  );
}
