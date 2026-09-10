"use client";

// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";
import {
  AdminButton,
  AdminConfirmDialog,
  AdminDate,
  AdminDateTime,
  AdminErrorBanner,
  AdminSectionHeading,
  AdminPageHeader,
  AdminPill,
  AdminTable,
  AdminToggle,
  ATd,
} from "@/components/admin-shell";
import { adminAuthedFetch, useAdminRoleGates } from "@/lib/admin-auth";
import { useAdminToast } from "@/lib/admin-toast";

interface AdminApiKey {
  id: string;
  keyPrefix: string;
  scopes: string[];
  ownerEmail: string | null;
  ownerDisplayName: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

/** Real (not mock) cross-user API key roster — admin/member/support only,
 * enforced server-side. Replaces the old hardcoded `API_KEYS` array and its
 * "(mock)" revoke button, which only flipped local React state and never
 * called the backend. No "calls (7d)" column here (the old mock had one):
 * per-key rate-limit buckets are pruned after ~10 minutes, so no durable
 * per-key call count exists yet — dropped rather than faked. */
function ApiKeysSection() {
  const { pushToast } = useAdminToast();
  const [keys, setKeys] = useState<AdminApiKey[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AdminApiKey | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await adminAuthedFetch("/v1/admin/api-keys");
      if (!res.ok) {
        // A failed fetch must never render as the same empty state as a
        // genuine zero-keys response — that silently hid real outages
        // (including a 403 misroute) behind "No API keys have been issued
        // yet.", which looked like a healthy, empty result.
        setError(`Failed to load API keys (HTTP ${res.status}).`);
        return;
      }
      const body = await res.json();
      setKeys(body.keys ?? []);
      setError(null);
    } catch {
      setError("Could not reach the server to load API keys.");
    }
  }, []);

  useEffect(() => {
    // False positive: refresh awaits a network fetch before any setState,
    // so nothing sets state synchronously inside the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const revoke = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      const res = await adminAuthedFetch(`/v1/admin/api-keys/${id}/revoke`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Failed to revoke the key.");
      }
      await refresh();
      pushToast({ variant: "success", title: "API key revoked" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to revoke the key.";
      setError(message);
      pushToast({ variant: "error", title: "Couldn't revoke the key", body: message });
    } finally {
      setBusyId(null);
      setRevokeTarget(null);
    }
  };

  return (
    <section className="rounded-xl border border-dark-line bg-dark-card p-6">
      <AdminSectionHeading
        title="// api_keys"
        sub="Every API key issued across all users. Revoking here takes effect immediately, independent of the key owner's own session."
      />
      {error ? (
        <p className="text-[12px] text-rose-400">{error}</p>
      ) : keys.length === 0 ? (
        <p className="text-[12px] text-dark-dim">No API keys have been issued yet.</p>
      ) : (
        <AdminTable headers={["key", "owner", "scopes", "created", "last used", "expires", "status", "action"]}>
          {keys.map((k) => {
            const isRevoked = !!k.revokedAt;
            return (
              <tr key={k.id}>
                <ATd className="font-semibold">{k.keyPrefix}••••</ATd>
                <ATd className="text-dark-soft">
                  {k.ownerDisplayName}
                  {k.ownerEmail ? ` · ${k.ownerEmail}` : ""}
                </ATd>
                <ATd className="text-dark-soft">{k.scopes.join(", ") || "—"}</ATd>
                <ATd className="text-dark-soft">
                  <AdminDate iso={k.createdAt} />
                </ATd>
                <ATd className="text-dark-soft">
                  {k.lastUsedAt ? <AdminDateTime iso={k.lastUsedAt} /> : "—"}
                </ATd>
                <ATd className="text-dark-soft">{k.expiresAt ? <AdminDate iso={k.expiresAt} /> : "—"}</ATd>
                <ATd>
                  <AdminPill tone={isRevoked ? "danger" : "success"}>
                    {isRevoked ? "revoked" : "active"}
                  </AdminPill>
                </ATd>
                <ATd>
                  {isRevoked ? (
                    <span className="font-mono text-[11px] text-dark-dim">—</span>
                  ) : (
                    <AdminButton variant="danger" disabled={busyId === k.id} onClick={() => setRevokeTarget(k)}>
                      {busyId === k.id ? "Revoking…" : "Revoke"}
                    </AdminButton>
                  )}
                </ATd>
              </tr>
            );
          })}
        </AdminTable>
      )}

      <AdminConfirmDialog
        open={revokeTarget !== null}
        title="Revoke this API key?"
        description={
          <>
            <span className="font-mono text-dark-text">{revokeTarget?.keyPrefix}••••</span> belongs to{" "}
            <span className="font-mono text-dark-text">{revokeTarget?.ownerDisplayName}{revokeTarget?.ownerEmail ? ` (${revokeTarget.ownerEmail})` : ""}</span>.
            Revoking it takes effect immediately and permanently — any integration still using this key will start
            failing authentication right away, independent of the owner&rsquo;s own session. This cannot be undone.
          </>
        }
        confirmLabel="Revoke key"
        busy={busyId === revokeTarget?.id}
        onConfirm={() => { if (revokeTarget) void revoke(revokeTarget.id); }}
        onCancel={() => setRevokeTarget(null)}
      />
    </section>
  );
}

interface SettingCatalogEntry {
  key: string;
  description: string;
  defaultValue: unknown;
}

interface SettingRow {
  key: string;
  value: unknown;
}

/** Every scalar/array setting round-trips through JSON — a plain number stays
 * `5`, a string stays `"5"`, an array stays `[1,2,3]`. This is the one text
 * encoding that needs no per-key parsing logic on the client: the backend's
 * `validateAdminSettingValue` (in admin-settings.ts) is the single source of
 * truth for what's actually a legal value per key, so a bad edit here is
 * caught server-side with the real reason, not silently coerced client-side. */
function toEditText(value: unknown): string {
  return JSON.stringify(value, null, value && typeof value === "object" ? 0 : undefined);
}

function parseEditText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Not valid JSON — strings need quotes, e.g. \"non_exclusive\" or 30.");
  }
}

/** Pick the editor widget from the value's shape. Booleans get a real ON/OFF
 * toggle, plain numbers a number input, everything else (strings, arrays,
 * objects) falls back to the JSON textarea. The catalog `defaultValue` is the
 * type authority — the live value always matches its declared schema type. */
type SettingKind = "boolean" | "number" | "json";
function settingKind(entry: SettingCatalogEntry, current: string): SettingKind {
  let live: unknown = entry.defaultValue;
  try {
    live = parseEditText(current);
  } catch {
    // Fall through to the catalog default's type if the buffer is mid-edit.
  }
  const t = typeof live === "boolean" ? "boolean" : typeof live === "number" ? "number" : typeof entry.defaultValue;
  if (t === "boolean") return "boolean";
  if (t === "number") return "number";
  return "json";
}

/** Generic, catalog-driven settings editor: renders every `admin_settings`
 * key the backend knows about (GET /v1/admin/settings → { settings, catalog })
 * grouped by dot-prefix namespace, instead of a hardcoded per-key list. A new
 * settings key added to admin-settings.ts's catalog appears here automatically
 * — no matching frontend change required. Validation is server-side only
 * (PUT /v1/admin/settings/:key already runs validateAdminSettingValue); this
 * component just edits and displays whatever comes back. */
function PlatformSettingsSection({ enabled }: { enabled: boolean }) {
  const { pushToast } = useAdminToast();
  const [catalog, setCatalog] = useState<SettingCatalogEntry[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!enabled) return;
    adminAuthedFetch("/v1/admin/settings")
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to load settings.");
        const body = (await res.json()) as { settings?: SettingRow[]; catalog?: SettingCatalogEntry[] };
        const rows = new Map((body.settings ?? []).map((s) => [s.key, s.value]));
        const nextValues: Record<string, string> = {};
        for (const entry of body.catalog ?? []) {
          nextValues[entry.key] = toEditText(rows.has(entry.key) ? rows.get(entry.key) : entry.defaultValue);
        }
        setCatalog(body.catalog ?? []);
        setValues(nextValues);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load settings."));
  }, [enabled]);

  useEffect(() => {
    load();
  }, [load]);

  /** Persist a concrete value (already the right JS type) to the same endpoint
   * the JSON textarea uses. Toggles/number inputs pass their value directly so
   * a fast double-click can't race the string-state round-trip. */
  const saveValue = async (key: string, value: unknown) => {
    setBusy((b) => ({ ...b, [key]: true }));
    setSavedKey(null);
    setErrors((e) => ({ ...e, [key]: "" }));
    try {
      const res = await adminAuthedFetch(`/v1/admin/settings/${key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Failed to save ${key}.`);
      }
      setSavedKey(key);
      pushToast({ variant: "success", title: `Saved ${key}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : `Failed to save ${key}.`;
      setErrors((e) => ({ ...e, [key]: message }));
      pushToast({ variant: "error", title: `Couldn't save ${key}`, body: message });
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  };

  /** Save the raw JSON-encoded edit text (textarea path). */
  const save = async (key: string) => {
    let value: unknown;
    try {
      value = parseEditText(values[key] ?? "");
    } catch (err) {
      setErrors((e) => ({ ...e, [key]: err instanceof Error ? err.message : `Failed to save ${key}.` }));
      return;
    }
    await saveValue(key, value);
  };

  const toggleBoolean = async (key: string, next: boolean) => {
    setValues((prev) => ({ ...prev, [key]: JSON.stringify(next) }));
    await saveValue(key, next);
  };

  const namespaces = Array.from(new Set(catalog.map((c) => c.key.split(".")[0]))).sort();

  return (
    <section className="rounded-xl border border-dark-line bg-dark-card p-6">
      <AdminSectionHeading
        title="// platform_settings"
        sub="Every admin-configurable business rule, read straight from the live catalog — no code deploy needed to add or change one."
      />
      {!enabled ? (
        <p className="text-sm text-dark-soft">Admin access required.</p>
      ) : loadError ? (
        <AdminErrorBanner message={loadError} onRetry={load} />
      ) : catalog.length === 0 ? (
        <p className="text-sm text-dark-soft">Loading…</p>
      ) : (
        <div className="space-y-5">
          {namespaces.map((ns) => (
            <div key={ns}>
              <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.05em] text-dark-dim">{ns}</div>
              <div className="grid gap-4 sm:grid-cols-2">
                {catalog
                  .filter((c) => c.key.startsWith(`${ns}.`))
                  .map((entry) => {
                    const raw = values[entry.key] ?? "";
                    const kind = settingKind(entry, raw);
                    const boolVal = raw === "true";
                    return (
                      <div key={entry.key} className="min-w-0 rounded-lg border border-dark-line bg-dark-deep p-3">
                        {kind === "boolean" ? (
                          <>
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="break-words font-mono text-[12px] text-dark-text">{entry.key}</div>
                                <div className="mt-0.5 break-words text-[11px] text-dark-soft">{entry.description}</div>
                              </div>
                              <AdminToggle
                                checked={boolVal}
                                disabled={busy[entry.key]}
                                label={`${entry.key} — ${boolVal ? "enabled" : "disabled"}`}
                                onChange={(next) => void toggleBoolean(entry.key, next)}
                              />
                            </div>
                            <div className="mt-2 flex items-center gap-3">
                              <span className="font-mono text-[11px] text-dark-dim">
                                {busy[entry.key] ? "Saving…" : boolVal ? "ON" : "OFF"}
                              </span>
                              {savedKey === entry.key && (
                                <span className="font-mono text-[11px] text-emerald-400">Saved</span>
                              )}
                              {errors[entry.key] && (
                                <span className="text-[11px] text-rose-400">{errors[entry.key]}</span>
                              )}
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="break-words font-mono text-[12px] text-dark-text">{entry.key}</div>
                            <div className="mt-0.5 break-words text-[11px] text-dark-soft">{entry.description}</div>
                            {kind === "number" ? (
                              <input
                                type="number"
                                value={raw}
                                onChange={(e) => setValues((prev) => ({ ...prev, [entry.key]: e.target.value }))}
                                className="mt-2 w-full min-w-0 rounded-lg border border-dark-line bg-dark px-3 py-2 font-mono text-[13px] text-dark-text outline-none transition-colors focus:border-dark-hover"
                              />
                            ) : (
                              <textarea
                                rows={1}
                                value={raw}
                                onChange={(e) => setValues((prev) => ({ ...prev, [entry.key]: e.target.value }))}
                                className="mt-2 w-full min-w-0 resize-y rounded-lg border border-dark-line bg-dark px-3 py-2 font-mono text-[13px] text-dark-text outline-none transition-colors focus:border-dark-hover"
                              />
                            )}
                            <div className="mt-2 flex items-center gap-3">
                              <AdminButton
                                variant="ghost"
                                disabled={busy[entry.key]}
                                onClick={() => void save(entry.key)}
                              >
                                {busy[entry.key] ? "Saving…" : "Save"}
                              </AdminButton>
                              {savedKey === entry.key && (
                                <span className="font-mono text-[11px] text-emerald-400">Saved</span>
                              )}
                              {errors[entry.key] && (
                                <span className="text-[11px] text-rose-400">{errors[entry.key]}</span>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

interface SettingsHistoryEntry {
  id: string;
  key: string;
  action: string;
  oldValue: unknown;
  newValue: unknown;
  changedBy: { id: string; email?: string | null; displayName?: string | null } | null;
  createdAt: string;
}

function formatSettingValue(value: unknown): string {
  if (value === null || value === undefined) return "unset";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function SettingsHistorySection({ enabled }: { enabled: boolean }) {
  const [history, setHistory] = useState<SettingsHistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    adminAuthedFetch("/v1/admin/settings-history?limit=25")
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to load settings history.");
        const body = await res.json();
        if (!cancelled) setHistory(body.history ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load settings history.");
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return (
    <section className="rounded-xl border border-dark-line bg-dark-card p-6">
      <AdminSectionHeading
        title="// settings_history"
        sub="Business-rule audit trail: who changed each value, what changed, and when."
      />
      {!enabled ? (
        <p className="text-sm text-dark-soft">Admin access required.</p>
      ) : error ? (
        <p className="text-sm text-rose-400">{error}</p>
      ) : history.length === 0 ? (
        <p className="text-sm text-dark-soft">No settings changes recorded yet.</p>
      ) : (
        <AdminTable headers={["setting", "old", "new", "changed by", "when"]}>
          {history.map((entry) => (
            <tr key={entry.id}>
              <ATd className="font-semibold">{entry.key}</ATd>
              <ATd className="max-w-56 truncate font-mono text-[12px] text-dark-soft">
                {formatSettingValue(entry.oldValue)}
              </ATd>
              <ATd className="max-w-56 truncate font-mono text-[12px] text-dark-text">
                {formatSettingValue(entry.newValue)}
              </ATd>
              <ATd className="text-dark-soft">
                {entry.changedBy?.email || entry.changedBy?.displayName || entry.changedBy?.id || "system"}
              </ATd>
              <ATd className="text-dark-soft">
                <AdminDateTime iso={entry.createdAt} />
              </ATd>
            </tr>
          ))}
        </AdminTable>
      )}
    </section>
  );
}

interface AdminInvite {
  id: string;
  email: string;
  role: "admin" | "member" | "support";
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  invitedBy: { displayName: string; email: string | null };
}

function inviteStatus(inv: AdminInvite): { label: string; tone: "success" | "danger" | "neutral" } {
  if (inv.acceptedAt) return { label: "accepted", tone: "success" };
  if (inv.revokedAt) return { label: "revoked", tone: "danger" };
  if (new Date(inv.expiresAt) < new Date()) return { label: "expired", tone: "danger" };
  return { label: "pending", tone: "neutral" };
}

/** Real (not mock) admin-invitation management — admin only; the API
 * enforces that, this section just also hides itself for member/support. */
function InvitesSection() {
  const { pushToast } = useAdminToast();
  const [invites, setInvites] = useState<AdminInvite[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member" | "support">("admin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AdminInvite | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // A failed load must not render as "no pending invitations" — an empty
    // table and a 403 looked identical here, so a swallowed error read as a
    // clean state.
    try {
      const res = await adminAuthedFetch("/v1/admin/invites");
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setLoadError(body?.message ?? `Could not load invitations (HTTP ${res.status}).`);
        return;
      }
      const body = await res.json();
      setInvites(body.invites ?? []);
      setLoadError(null);
    } catch {
      setLoadError("Could not load invitations.");
    }
  }, []);

  useEffect(() => {
    // False positive: refresh awaits a network fetch before any setState,
    // so nothing sets state synchronously inside the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const sendInvite = async () => {
    if (!email.includes("@") || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await adminAuthedFetch("/v1/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Failed to send the invitation.");
      }
      setEmail("");
      await refresh();
      pushToast({ variant: "success", title: "Invitation sent", body: email });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send the invitation.";
      setError(message);
      pushToast({ variant: "error", title: "Couldn't send the invitation", body: message });
    } finally {
      setBusy(false);
    }
  };

  const revokeInvite = async (id: string) => {
    setRevoking(true);
    try {
      const res = await adminAuthedFetch(`/v1/admin/invites/${id}`, { method: "DELETE" });
      if (res.ok) {
        await refresh();
        pushToast({ variant: "success", title: "Invitation revoked" });
      } else {
        const body = await res.json().catch(() => ({}));
        pushToast({ variant: "error", title: "Couldn't revoke the invitation", body: body.message });
      }
    } finally {
      setRevoking(false);
      setRevokeTarget(null);
    }
  };

  return (
    <section className="rounded-xl border border-dark-line bg-dark-card p-6">
      <AdminSectionHeading
        title="// admin_invitations"
        sub="Invite someone to the admin console. Links are single-use, email-bound, and expire in 7 days."
      />
      <div className="flex flex-wrap items-end gap-2.5">
        <label className="block min-w-56 flex-1">
          <span className="micro-label mb-1 block text-dark-dim">email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
            className="w-full rounded-lg border border-dark-line bg-dark px-3 py-2 text-sm text-dark-text outline-none focus:border-dark-hover"
          />
        </label>
        <label className="block">
          <span className="micro-label mb-1 block text-dark-dim">role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "admin" | "member" | "support")}
            className="rounded-lg border border-dark-line bg-dark px-3 py-2 text-sm text-dark-text outline-none focus:border-dark-hover"
          >
            <option value="admin">admin</option>
            <option value="member">member</option>
            <option value="support">support</option>
          </select>
        </label>
        <AdminButton variant="primary" onClick={() => void sendInvite()}>
          {busy ? "Sending…" : "Send invite"}
        </AdminButton>
      </div>
      {error && <p className="mt-2 text-[12px] text-rose-400">{error}</p>}
      {loadError && (
        <p role="alert" className="mt-2 text-[12px] text-rose-400">
          {loadError} The list below may be incomplete.
        </p>
      )}
      {invites.length > 0 && (
        <div className="mt-4">
          <AdminTable headers={["email", "role", "invited by", "sent", "status", "action"]}>
            {invites.map((inv) => {
              const status = inviteStatus(inv);
              return (
                <tr key={inv.id}>
                  <ATd className="font-semibold">{inv.email}</ATd>
                  <ATd className="text-dark-soft">{inv.role}</ATd>
                  <ATd className="text-dark-soft">{inv.invitedBy.displayName}</ATd>
                  <ATd className="text-dark-soft">
                    <AdminDate iso={inv.createdAt} />
                  </ATd>
                  <ATd>
                    <AdminPill tone={status.tone}>{status.label}</AdminPill>
                  </ATd>
                  <ATd>
                    {status.label === "pending" ? (
                      <AdminButton variant="danger" onClick={() => setRevokeTarget(inv)}>
                        Revoke
                      </AdminButton>
                    ) : (
                      <span className="font-mono text-[11px] text-dark-dim">—</span>
                    )}
                  </ATd>
                </tr>
              );
            })}
          </AdminTable>
        </div>
      )}

      <AdminConfirmDialog
        open={revokeTarget !== null}
        title="Revoke this invitation?"
        description={
          <>
            The invitation to <span className="font-mono text-dark-text">{revokeTarget?.email}</span> ({revokeTarget?.role})
            has not been accepted yet, but the link stays live until revoked. Revoking it permanently invalidates the
            link so it can no longer be used to join the admin console.
          </>
        }
        confirmLabel="Revoke invitation"
        busy={revoking}
        onConfirm={() => { if (revokeTarget) void revokeInvite(revokeTarget.id); }}
        onCancel={() => setRevokeTarget(null)}
      />
    </section>
  );
}

export default function AdminSettingsPage() {
  const { isAdmin } = useAdminRoleGates();

  return (
    <div className="space-y-5">
      <AdminPageHeader
        title="Platform settings"
        sub="Karma economics, validation thresholds, notification delivery, and compliance knobs."
      />

      <PlatformSettingsSection enabled={isAdmin} />
      <SettingsHistorySection enabled={isAdmin} />

      {isAdmin && <InvitesSection />}

      <ApiKeysSection />
    </div>
  );
}
