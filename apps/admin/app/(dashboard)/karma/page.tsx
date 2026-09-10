"use client";

// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AdminButton,
  AdminConfirmDialog,
  AdminEmptyState,
  AdminErrorBanner,
  AdminLoadingState,
  AdminPageHeader,
  AdminPill,
  AdminSectionHeading,
  AdminTable,
  ATd,
} from "@/components/admin-shell";
import { adminAuthedFetch } from "@/lib/admin-auth";
import { useAdminToast } from "@/lib/admin-toast";
import { fetchAllDatasetTypes } from "@/lib/dataset-type-pages";

type AcceptedItemRates = { beginner: number; intermediate: number; advanced: number };
type KarmaRules = {
  acceptedItem: AcceptedItemRates;
  auditItem: number;
  confirmedFlag: number;
  requestApproved: number;
  publishBonus: number;
  bountyPublished: number;
};
// Community's tier editor doesn't surface early-access or concurrency-bonus
// controls (no bond waivers here — `bondFree` is not part of this karma-only
// API's schema), but `karma.tiers`'s write-path Zod schema
// (community api `services/admin-settings.ts`) still requires
// `earlyAccessHours`/`concurrencyBonus` on every row. sanitizeTier() keeps
// them (untouched, non-editable) purely so a save round-trips the values the
// server already has instead of dropping required fields and 400ing.
type KarmaTier = {
  tier: string;
  label: string;
  minKarma: number;
  color: string;
  blurb: string;
  perks: string[];
  earlyAccessHours: number;
  concurrencyBonus: number;
};
type Setting = { key: string; value: unknown };
type CatalogEntry = { key: string; defaultValue: unknown };

type DatasetTypeRow = {
  id: string;
  name: string;
  status: string;
  domain: string;
  complexityScore: number | null;
  verificationUnits: number | null;
};

type Badge = {
  id: string;
  key: string;
  family: string;
  label: string;
  criteria: string;
  icon: string;
  metric: string;
  threshold: number;
  minSample: number;
  autoGranted: boolean;
  active: boolean;
  sortOrder: number;
  earnedBy: number;
};
type MetricOption = { metric: string; label: string; thresholdMeans: string; autoGrantable: boolean };
type BadgeCatalogBody = { badges: Badge[]; metrics: MetricOption[]; families: string[]; icons: string[] };

const inputClass =
  "block w-full rounded-[9px] border border-dark-line-soft bg-dark-field px-3 py-2 font-mono text-sm text-dark-text focus:border-dark-hover focus:outline-none";

/** A blank row for the add-badge form. Kept outside the component so a reset
 * cannot accidentally carry over state from the previous submission. */
const EMPTY_DRAFT = {
  key: "",
  family: "build",
  label: "",
  criteria: "",
  icon: "award",
  metric: "accepted_items",
  threshold: 1,
  minSample: 0,
  active: true,
};

/** Keeps `earlyAccessHours`/`concurrencyBonus` untouched (this page has no
 * editor for either) so a later save round-trips the required fields instead
 * of dropping them — see the KarmaTier comment above. Any OTHER field the API
 * response carries beyond this shape (e.g. an unused `bondFree`) is still
 * dropped, since this page never reads or re-sends those. */
function sanitizeTier(raw: unknown): KarmaTier | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (
    typeof t.tier !== "string" ||
    typeof t.label !== "string" ||
    typeof t.minKarma !== "number" ||
    typeof t.color !== "string" ||
    typeof t.blurb !== "string" ||
    !Array.isArray(t.perks) ||
    typeof t.earlyAccessHours !== "number" ||
    typeof t.concurrencyBonus !== "number"
  )
    return null;
  return {
    tier: t.tier,
    label: t.label,
    minKarma: t.minKarma,
    color: t.color,
    blurb: t.blurb,
    perks: t.perks as string[],
    earlyAccessHours: t.earlyAccessHours,
    concurrencyBonus: t.concurrencyBonus,
  };
}

function asRules(value: unknown): KarmaRules | null {
  if (!value || typeof value !== "object") return null;
  const rules = value as Record<string, unknown>;
  const accepted = rules.acceptedItem as Record<string, unknown> | undefined;
  const flatOk = (["auditItem", "confirmedFlag", "requestApproved", "publishBonus", "bountyPublished"] as const).every(
    (key) => typeof rules[key] === "number"
  );
  const acceptedOk =
    accepted != null &&
    (["beginner", "intermediate", "advanced"] as const).every((level) => typeof accepted[level] === "number");
  return flatOk && acceptedOk ? (rules as KarmaRules) : null;
}

export default function AdminKarmaPage() {
  const { pushToast } = useAdminToast();
  const [rules, setRules] = useState<KarmaRules | null>(null);
  const [tiers, setTiers] = useState<KarmaTier[]>([]);
  // The last values the server confirmed. Comparing the editable state against
  // these is what keeps a Save button disabled until something actually
  // changed, so an admin cannot fire a no-op write into the audit history.
  const [savedRules, setSavedRules] = useState<string>("");
  const [savedTiers, setSavedTiers] = useState<string>("");
  const [types, setTypes] = useState<DatasetTypeRow[]>([]);
  // Per-type karma-rate edits, held until the row is saved so a half-typed score is
  // never PATCHed. Keyed by dataset-type id.
  const [typeDraft, setTypeDraft] = useState<Record<string, { complexityScore: string; verificationUnits: string }>>({});
  const [catalog, setCatalog] = useState<BadgeCatalogBody | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ ...EMPTY_DRAFT });
  const [pendingDelete, setPendingDelete] = useState<Badge | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settingsRes, badgesRes, allTypes] = await Promise.all([
        adminAuthedFetch("/v1/admin/settings"),
        adminAuthedFetch("/v1/admin/badges"),
        // Every type, so the rate-coverage table can show the unrated ones —
        // those are the point of the panel, and a default page size would hide
        // them behind pagination. This asked for one fixed `limit=100` page,
        // which silently dropped every type past the 100th: a dropped type has
        // no row here, so its karma rate could never be set at all. The helper
        // pages until the server's reported total is collected.
        fetchAllDatasetTypes<DatasetTypeRow>(),
      ]);
      if (!settingsRes.ok) throw new Error(`Could not load settings (HTTP ${settingsRes.status}).`);
      if (!badgesRes.ok) throw new Error(`Could not load the badge catalog (HTTP ${badgesRes.status}).`);
      if (!allTypes.ok) throw new Error(`Could not load the dataset-type catalog (HTTP ${allTypes.status}).`);

      const body = (await settingsRes.json()) as { settings?: Setting[]; catalog?: CatalogEntry[] };
      const stored = new Map((body.settings ?? []).map((setting) => [setting.key, setting.value]));
      const defaults = new Map((body.catalog ?? []).map((entry) => [entry.key, entry.defaultValue]));
      const effective = (key: string) => stored.get(key) ?? defaults.get(key);
      const loadedRules = asRules(effective("karma.rules"));
      const rawTiers = Array.isArray(effective("karma.tiers")) ? (effective("karma.tiers") as unknown[]) : [];
      const loadedTiers = rawTiers.map(sanitizeTier).filter((t): t is KarmaTier => t !== null);
      setRules(loadedRules);
      setTiers(loadedTiers);
      setSavedRules(JSON.stringify(loadedRules));
      setSavedTiers(JSON.stringify(loadedTiers));
      setCatalog((await badgesRes.json()) as BadgeCatalogBody);
      const loadedTypes = allTypes.datasetTypes;
      setTypes(loadedTypes);
      // Reset the per-row drafts to whatever the server just confirmed, so a
      // reload after a save never leaves a stale edit sitting in an input.
      setTypeDraft(
        Object.fromEntries(
          loadedTypes.map((type) => [
            type.id,
            {
              complexityScore: type.complexityScore === null ? "" : String(type.complexityScore),
              verificationUnits: type.verificationUnits === null ? "" : String(type.verificationUnits),
            },
          ])
        )
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Karma settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const saveSetting = async (key: string, value: unknown) => {
    setSaving(key);
    setNotice(null);
    setError(null);
    try {
      const res = await adminAuthedFetch(`/v1/admin/settings/${key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Could not save ${key}.`);
      }
      setNotice(`${key} saved. The change is recorded in the admin audit history.`);
      await load();
      pushToast({ variant: "success", title: `Saved ${key}` });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : `Could not save ${key}.`;
      setError(message);
      pushToast({ variant: "error", title: `Couldn't save ${key}`, body: message });
    } finally {
      setSaving(null);
    }
  };

  /** One request helper for every badge mutation, so each one surfaces the
   * server's real message and refetches the catalog rather than patching local
   * state — holder counts and auto-grant coercions come from the server. */
  const mutateBadge = async (token: string, path: string, init: RequestInit, successMessage: string) => {
    setSaving(token);
    setNotice(null);
    setError(null);
    try {
      const res = await adminAuthedFetch(path, {
        headers: init.body ? { "Content-Type": "application/json" } : undefined,
        ...init,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message || `Request failed (HTTP ${res.status}).`);
      }
      setNotice(successMessage);
      await load();
      pushToast({ variant: "success", title: successMessage });
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The badge change did not save.";
      setError(message);
      pushToast({ variant: "error", title: "Couldn't save the badge change", body: message });
      return false;
    } finally {
      setSaving(null);
    }
  };

  const rulesDirty = rules !== null && JSON.stringify(rules) !== savedRules;
  const tiersDirty = tiers.length > 0 && JSON.stringify(tiers) !== savedTiers;

  /** Save one type's karma-rate axes. An empty input means *no karma rate* and is
   * sent as null. On a draft/review type that is a legitimate retraction, and every
   * read path fails closed on null rather than assuming a middle score. On an ACTIVE
   * type the server rejects it with 409 (an active type must keep a rate): clearing a live
   * score would leave bounties already open awarding on the flat fallback, so a
   * wrong score is retracted by re-scoring or by moving the type off active. The
   * server's message is surfaced verbatim below. */
  const saveTypePricing = async (type: DatasetTypeRow) => {
    const draft = typeDraft[type.id];
    if (!draft) return;
    const complexityScore = draft.complexityScore.trim() === "" ? null : Number(draft.complexityScore);
    const verificationUnits = draft.verificationUnits.trim() === "" ? null : Number(draft.verificationUnits);
    setSaving(`type:${type.id}`);
    setNotice(null);
    setError(null);
    try {
      const res = await adminAuthedFetch(`/v1/admin/dataset-types/${type.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ complexityScore, verificationUnits }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message || `Could not save the karma rate for ${type.id} (HTTP ${res.status}).`);
      }
      setNotice(`${type.id} karma rate saved. The change is recorded in the admin audit history.`);
      await load();
      pushToast({ variant: "success", title: `Saved ${type.id} karma rate` });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : `Could not save the karma rate for ${type.id}.`;
      setError(message);
      pushToast({ variant: "error", title: "Couldn't save the karma rate", body: message });
    } finally {
      setSaving(null);
    }
  };

  const pricedTypeCount = types.filter((type) => type.complexityScore !== null).length;
  const typeRowDirty = (type: DatasetTypeRow) => {
    const draft = typeDraft[type.id];
    if (!draft) return false;
    const asText = (value: number | null) => (value === null ? "" : String(value));
    return (
      draft.complexityScore.trim() !== asText(type.complexityScore) ||
      draft.verificationUnits.trim() !== asText(type.verificationUnits)
    );
  };

  const metricByName = useMemo(
    () => new Map((catalog?.metrics ?? []).map((metric) => [metric.metric, metric])),
    [catalog]
  );
  const draftMetric = metricByName.get(draft.metric);
  const canAddBadge = draft.key.trim() !== "" && draft.label.trim() !== "" && draft.criteria.trim() !== "";

  const addBadge = async () => {
    const created = await mutateBadge(
      "badge:new",
      "/v1/admin/badges",
      {
        method: "POST",
        body: JSON.stringify({
          ...draft,
          key: draft.key.trim(),
          label: draft.label.trim(),
          criteria: draft.criteria.trim(),
          threshold: Math.max(1, draft.threshold),
          autoGranted: draftMetric?.autoGrantable ?? true,
        }),
      },
      `Badge "${draft.label.trim()}" added to the catalog.`
    );
    if (created) setDraft({ ...EMPTY_DRAFT });
  };

  const badgesByFamily = useMemo(() => {
    const grouped = new Map<string, Badge[]>();
    for (const family of catalog?.families ?? []) grouped.set(family, []);
    for (const badge of catalog?.badges ?? []) {
      grouped.set(badge.family, [...(grouped.get(badge.family) ?? []), badge]);
    }
    return grouped;
  }, [catalog]);

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Karma & badges"
        sub="Publication awards, tier thresholds, and the badge catalog. Every value on this page is stored in the database, served to the member dashboard, and written to the admin audit history on save."
      />
      {error && <AdminErrorBanner message={error} onRetry={() => void load()} />}
      {notice && (
        <div className="rounded-lg border border-lime/30 bg-lime/10 px-4 py-3 text-sm text-lime">{notice}</div>
      )}

      {loading ? (
        <AdminLoadingState label="Loading live configuration…" />
      ) : (
        <>
          <section className="rounded-xl border border-dark-line bg-dark-card p-5">
            <AdminSectionHeading
              title="Publication awards"
              sub="These fixed awards release only after verified publication. Contributor and validator item amounts are configured per dataset type in the per-type karma rate table below."
            />
            {rules && (
              <div className="space-y-5">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {(
                    [
                      ["confirmedFlag", "Confirmed flag"],
                      ["requestApproved", "Published request"],
                      ["bountyPublished", "Published dataset"],
                      ["publishBonus", "Publish bonus"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="block">
                      <span className="font-mono text-[10px] uppercase tracking-[.05em] text-dark-dim">{label}</span>
                      <input
                        type="number"
                        min={1}
                        max={10_000}
                        value={rules[key]}
                        onChange={(event) => setRules({ ...rules, [key]: Number(event.target.value) })}
                        className={`${inputClass} mt-1`}
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-4">
              <AdminButton
                variant="primary"
                disabled={!rules || !rulesDirty || saving === "karma.rules"}
                tooltip={rules && !rulesDirty ? "No changes to save." : undefined}
                onClick={() => rules && void saveSetting("karma.rules", rules)}
              >
                {saving === "karma.rules" ? "Saving…" : "Save rates"}
              </AdminButton>
            </div>
          </section>

          <section className="rounded-xl border border-dark-line bg-dark-card p-5">
            <AdminSectionHeading
              title="Tier thresholds"
              sub="Karma required to enter each tier. Dharma is fixed at 0. The member dashboard receives these exact thresholds, blurbs, and perks."
            />
            <div className="space-y-3">
              {tiers.map((tier, index) => {
                const updateTier = (patch: Partial<KarmaTier>) =>
                  setTiers(tiers.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
                const cleanPerks = tier.perks.map((p) => p.trim()).filter(Boolean);
                return (
                  <div key={tier.tier} className="rounded-lg border border-dark-line bg-dark-deep p-4">
                    <div className="flex items-center gap-2 font-mono text-xs font-semibold text-dark-text">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: tier.color }} />
                      {tier.label}
                    </div>

                    <div className="mt-3 grid gap-4 lg:grid-cols-[112px_1fr]">
                      <label className="block">
                        <span className="font-mono text-[10px] uppercase tracking-[.05em] text-dark-dim">
                          min. karma
                        </span>
                        <input
                          type="number"
                          min={tier.tier === "dharma" ? 0 : 1}
                          disabled={tier.tier === "dharma"}
                          value={tier.minKarma}
                          onChange={(event) => updateTier({ minKarma: Number(event.target.value) })}
                          className={`${inputClass} mt-1 disabled:opacity-50`}
                        />
                      </label>

                      <div className="space-y-3">
                        {/* Full width of the column, not a 2-up grid with
                            perks below, and a wrapping textarea rather than
                            a single-line input — this field allows up to 240
                            chars and was clipping/horizontally-scrolling its
                            own value with no way to read it all while
                            editing. Still stored as one plain-text string
                            (rendered on its own line on the member page, per
                            the preview below); Enter is stripped so editing
                            here can never introduce a literal line break. */}
                        <label className="block">
                          <span className="font-mono text-[10px] uppercase tracking-[.05em] text-dark-dim">
                            blurb
                          </span>
                          <textarea
                            value={tier.blurb}
                            maxLength={240}
                            rows={2}
                            placeholder="One-line description shown under the tier name"
                            onChange={(event) => updateTier({ blurb: event.target.value.replace(/\n/g, " ") })}
                            className={`${inputClass} mt-1 resize-y font-sans text-xs leading-snug`}
                          />
                        </label>
                        <label className="block">
                          <span className="font-mono text-[10px] uppercase tracking-[.05em] text-dark-dim">
                            perks — one per line
                          </span>
                          <textarea
                            value={tier.perks.join("\n")}
                            onChange={(event) => updateTier({ perks: event.target.value.split("\n") })}
                            rows={Math.max(3, tier.perks.length)}
                            placeholder={"Priority review on flagged submissions\nBatch sizes up to 25 items"}
                            className={`${inputClass} mt-1 resize-y font-sans text-[11px] leading-relaxed`}
                          />
                        </label>
                      </div>
                    </div>

                    {/* Exactly what the member Karma page will render for this tier. */}
                    <div className="mt-3 rounded-md border border-dark-line-soft bg-[#0b0d0b] px-3 py-2">
                      <span className="font-mono text-[9px] uppercase tracking-[.05em] text-dark-dim">
                        member preview
                      </span>
                      <p className="mt-1 text-xs text-dark-soft">{tier.blurb || <em className="text-dark-dim">no blurb set</em>}</p>
                      <p className="mt-1 text-[11px] leading-relaxed text-dark-dim">
                        {cleanPerks.length ? cleanPerks.join(" · ") : <em>no perks set</em>}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 font-mono text-[11px] leading-relaxed text-dark-dim">
              Perks are display text only — no separate enforcement fields are attached to a tier.
            </p>
            <div className="mt-4">
              <AdminButton
                variant="primary"
                disabled={!tiersDirty || saving === "karma.tiers"}
                tooltip={!tiersDirty ? "No changes to save." : undefined}
                onClick={() =>
                  void saveSetting(
                    "karma.tiers",
                    // Blank textarea lines are a typing artifact, not a real
                    // perk — strip them only at save time so a mid-edit blank
                    // line doesn't get silently deleted from under the cursor.
                    tiers.map((tier) => ({ ...tier, blurb: tier.blurb.trim(), perks: tier.perks.map((p) => p.trim()).filter(Boolean) }))
                  )
                }
              >
                {saving === "karma.tiers" ? "Saving…" : "Save thresholds"}
              </AdminButton>
            </div>
          </section>

          <section className="rounded-xl border border-dark-line bg-dark-card p-5">
            <AdminSectionHeading
              title="Per-type karma rates"
              sub="Which complexity score and how many machine-verified fields each dataset type declares. A type with no complexity score has NO KARMA RATE — that is a real state, not a zero, and it is what an admin assigns at template review."
            />
            <p className="mb-3 font-mono text-[11px] text-dark-dim">
              {pricedTypeCount} of {types.length} types rated
              {types.length > pricedTypeCount && ` · ${types.length - pricedTypeCount} awaiting a complexity score`}
            </p>
            {types.length === 0 ? (
              <AdminEmptyState message="No dataset types loaded." />
            ) : (
              <AdminTable headers={["type", "status", "complexity", "verif. units", ""]}>
                {types.map((type) => {
                  const draft = typeDraft[type.id] ?? { complexityScore: "", verificationUnits: "" };
                  return (
                    <tr key={type.id} className={type.complexityScore === null ? "bg-amber-500/5" : ""}>
                      <ATd className="font-semibold">
                        {type.name}
                        <span className="ml-2 font-mono text-[10px] font-normal text-dark-dim">{type.id}</span>
                      </ATd>
                      <ATd>
                        <AdminPill tone={type.status === "active" ? "lime" : "info"}>{type.status}</AdminPill>
                      </ATd>
                      <ATd>
                        <input
                          type="number"
                          min={1}
                          max={4}
                          placeholder="—"
                          value={draft.complexityScore}
                          onChange={(event) =>
                            setTypeDraft({
                              ...typeDraft,
                              [type.id]: { ...draft, complexityScore: event.target.value },
                            })
                          }
                          className="w-20 rounded border border-dark-line bg-dark-deep px-2 py-1 font-mono text-sm text-dark-text"
                        />
                      </ATd>
                      <ATd>
                        <input
                          type="number"
                          min={0}
                          placeholder="—"
                          value={draft.verificationUnits}
                          onChange={(event) =>
                            setTypeDraft({
                              ...typeDraft,
                              [type.id]: { ...draft, verificationUnits: event.target.value },
                            })
                          }
                          className="w-20 rounded border border-dark-line bg-dark-deep px-2 py-1 font-mono text-sm text-dark-text"
                        />
                      </ATd>
                      <ATd>
                        <AdminButton
                          variant="ghost"
                          disabled={!typeRowDirty(type) || saving === `type:${type.id}`}
                          tooltip={typeRowDirty(type) ? "Save this type's karma rate axes." : "No changes to save."}
                          onClick={() => void saveTypePricing(type)}
                        >
                          {saving === `type:${type.id}` ? "Saving…" : "Save"}
                        </AdminButton>
                      </ATd>
                    </tr>
                  );
                })}
              </AdminTable>
            )}
            <p className="mt-2 font-mono text-[11px] leading-relaxed text-dark-dim">
              Verification units are a property of the template — the fields the pipeline actually compiles, runs, or
              machine-checks — never a per-submission count, which a contributor could influence.
            </p>
          </section>

          <section className="rounded-xl border border-dark-line bg-dark-card p-5">
            <AdminSectionHeading
              title="Add badge"
              sub="New badges join the catalog immediately. Auto-granted badges must name a metric the platform measures — write labels as factual statements, not titles. Use {value} in a label to insert the measured amount."
            />
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              <label className="block">
                <span className="font-mono text-[10px] uppercase tracking-[.05em] text-dark-dim">key</span>
                <input
                  value={draft.key}
                  onChange={(event) => setDraft({ ...draft, key: event.target.value })}
                  placeholder="items_1000"
                  className={`${inputClass} mt-1`}
                />
              </label>
              <label className="block">
                <span className="font-mono text-[10px] uppercase tracking-[.05em] text-dark-dim">label</span>
                <input
                  value={draft.label}
                  onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                  placeholder="{value} items accepted"
                  className={`${inputClass} mt-1`}
                />
              </label>
              <label className="block">
                <span className="font-mono text-[10px] uppercase tracking-[.05em] text-dark-dim">criteria</span>
                <input
                  value={draft.criteria}
                  onChange={(event) => setDraft({ ...draft, criteria: event.target.value })}
                  placeholder="1,000 accepted items across all pools"
                  className={`${inputClass} mt-1`}
                />
              </label>
              <label className="block">
                <span className="font-mono text-[10px] uppercase tracking-[.05em] text-dark-dim">family</span>
                <select
                  value={draft.family}
                  onChange={(event) => setDraft({ ...draft, family: event.target.value })}
                  className={`${inputClass} mt-1`}
                >
                  {(catalog?.families ?? []).map((family) => (
                    <option key={family} value={family}>
                      {family}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="font-mono text-[10px] uppercase tracking-[.05em] text-dark-dim">metric</span>
                <select
                  value={draft.metric}
                  onChange={(event) => setDraft({ ...draft, metric: event.target.value })}
                  className={`${inputClass} mt-1`}
                >
                  {(catalog?.metrics ?? []).map((metric) => (
                    <option key={metric.metric} value={metric.metric}>
                      {metric.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="font-mono text-[10px] uppercase tracking-[.05em] text-dark-dim">icon</span>
                <select
                  value={draft.icon}
                  onChange={(event) => setDraft({ ...draft, icon: event.target.value })}
                  className={`${inputClass} mt-1`}
                >
                  {(catalog?.icons ?? []).map((icon) => (
                    <option key={icon} value={icon}>
                      {icon}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="font-mono text-[10px] uppercase tracking-[.05em] text-dark-dim">threshold</span>
                <input
                  type="number"
                  min={1}
                  disabled={!draftMetric?.autoGrantable}
                  value={draft.threshold}
                  onChange={(event) => setDraft({ ...draft, threshold: Number(event.target.value) })}
                  className={`${inputClass} mt-1 disabled:opacity-50`}
                />
                <span className="mt-1 block text-[11px] leading-relaxed text-dark-dim">
                  {draftMetric?.thresholdMeans ?? ""}
                </span>
              </label>
              <label className="block">
                <span className="font-mono text-[10px] uppercase tracking-[.05em] text-dark-dim">minimum sample</span>
                <input
                  type="number"
                  min={0}
                  disabled={draft.metric !== "flag_accuracy_pct"}
                  value={draft.minSample}
                  onChange={(event) => setDraft({ ...draft, minSample: Number(event.target.value) })}
                  className={`${inputClass} mt-1 disabled:opacity-50`}
                />
                <span className="mt-1 block text-[11px] leading-relaxed text-dark-dim">
                  {draft.metric === "flag_accuracy_pct"
                    ? "Decisions required before this percentage may award."
                    : "Only used by percentage metrics."}
                </span>
              </label>
              <div className="flex items-end gap-2.5">
                <AdminPill tone={draftMetric?.autoGrantable ? "lime" : "info"}>
                  {draftMetric?.autoGrantable ? "auto-granted" : "admin-granted"}
                </AdminPill>
                <AdminButton variant="primary" disabled={!canAddBadge || saving === "badge:new"} onClick={() => void addBadge()}>
                  {saving === "badge:new" ? "Adding…" : "Add badge"}
                </AdminButton>
              </div>
            </div>
          </section>

          {[...badgesByFamily.entries()].map(([family, badges]) => (
            <section key={family} className="space-y-3">
              <AdminSectionHeading title={`${family} badges`} />
              {badges.length === 0 ? (
                <AdminEmptyState message="No badges in this family yet." />
              ) : (
                <AdminTable headers={["badge", "criteria", "metric", "threshold", "granting", "earned by", "actions"]}>
                  {badges.map((badge) => (
                    <tr key={badge.id} className={badge.active ? "" : "opacity-55"}>
                      <ATd className="font-semibold">
                        {badge.label}
                        {!badge.active && (
                          <span className="ml-2 font-mono text-[10px] font-normal text-dark-dim">inactive</span>
                        )}
                      </ATd>
                      <ATd className="text-dark-soft">{badge.criteria}</ATd>
                      <ATd className="text-dark-soft">{metricByName.get(badge.metric)?.label ?? badge.metric}</ATd>
                      <ATd>
                        <input
                          type="number"
                          min={1}
                          defaultValue={badge.threshold}
                          disabled={badge.metric === "manual"}
                          onBlur={(event) => {
                            const threshold = Number(event.target.value);
                            if (threshold === badge.threshold || threshold < 1) return;
                            void mutateBadge(
                              `badge:${badge.id}`,
                              `/v1/admin/badges/${badge.id}`,
                              { method: "PATCH", body: JSON.stringify({ threshold }) },
                              `"${badge.label}" threshold updated to ${threshold}.`
                            );
                          }}
                          className="w-24 rounded border border-dark-line bg-dark-deep px-2 py-1 font-mono text-sm text-dark-text disabled:opacity-50"
                        />
                      </ATd>
                      <ATd>
                        <AdminPill tone={badge.autoGranted ? "lime" : "info"}>
                          {badge.autoGranted ? "auto" : "admin"}
                        </AdminPill>
                      </ATd>
                      <ATd className="text-dark-soft">{badge.earnedBy.toLocaleString()}</ATd>
                      <ATd>
                        <div className="flex gap-2">
                          <AdminButton
                            variant="ghost"
                            disabled={saving === `badge:${badge.id}`}
                            tooltip={
                              badge.active
                                ? "Stop awarding this badge and hide it from member dashboards. Existing awards are kept."
                                : "Resume awarding this badge and show it on member dashboards again."
                            }
                            onClick={() =>
                              void mutateBadge(
                                `badge:${badge.id}`,
                                `/v1/admin/badges/${badge.id}`,
                                { method: "PATCH", body: JSON.stringify({ active: !badge.active }) },
                                `"${badge.label}" is now ${badge.active ? "inactive" : "active"}.`
                              )
                            }
                          >
                            {badge.active ? "Deactivate" : "Activate"}
                          </AdminButton>
                          <AdminButton
                            variant="danger"
                            disabled={saving === `badge:${badge.id}`}
                            tooltip="Permanently delete this badge and every award of it."
                            onClick={() => setPendingDelete(badge)}
                          >
                            Delete
                          </AdminButton>
                        </div>
                      </ATd>
                    </tr>
                  ))}
                </AdminTable>
              )}
            </section>
          ))}

          <p className="font-mono text-[11px] leading-relaxed text-dark-dim">
            Auto badges are awarded by the platform the moment their measured criteria are met, and are never awarded
            for anything the platform did not measure. Admin badges are granted by hand from this console. Badges are
            records, not perks: perks come from karma tiers.
          </p>
        </>
      )}

      <AdminConfirmDialog
        open={pendingDelete !== null}
        title={`Delete "${pendingDelete?.label ?? ""}"?`}
        description={
          pendingDelete
            ? `This removes the badge and all ${pendingDelete.earnedBy.toLocaleString()} award${pendingDelete.earnedBy === 1 ? "" : "s"} of it from member profiles. Deactivating instead keeps the history and can be undone.`
            : undefined
        }
        confirmLabel="Delete badge"
        busy={saving === `badge:${pendingDelete?.id}`}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const badge = pendingDelete;
          if (!badge) return;
          void mutateBadge(
            `badge:${badge.id}`,
            `/v1/admin/badges/${badge.id}`,
            { method: "DELETE" },
            `"${badge.label}" deleted from the catalog.`
          ).then(() => setPendingDelete(null));
        }}
      />
    </div>
  );
}
