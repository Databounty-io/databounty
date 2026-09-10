"use client";

// SPDX-License-Identifier: Apache-2.0

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { authedFetch, safeMessage, useDemo, type SourceId } from "@/lib/store";
import { API } from "@/lib/api-endpoints";
import { readHandleAvailability } from "@/lib/handle-availability";
import { LANDING_URL } from "@/lib/urls";
import { CONTRIBUTOR_RANKS, VALIDATOR_RANKS } from "@/lib/format";
import { PageHeader } from "@/components/app-shell";
import { AsyncState, Button, CopyButton, Empty, Pill, SectionHeader, Toggle as ToggleSwitch } from "@/components/ui";
import { PasswordInput } from "@/components/password-input";
import { Icon, type IconName } from "@/components/icons";
import {
  CREDENTIAL_SOURCES,
  CredentialSourceGlyph,
  isCredentialSourceAvailable,
  orderCredentialSources,
  SponsorScopeModal,
} from "@/components/auth";

const formatPct = (value: number | null) => (value === null ? "no decided flags" : `${Math.round(value * 100)}%`);

const PUBLIC_VISIBILITY_ROWS: { key: "showKarma" | "showBadges" | "showDatasets" | "showActivity"; label: string }[] = [
  { key: "showKarma", label: "karma & tier" },
  { key: "showBadges", label: "badges" },
  { key: "showDatasets", label: "dataset list" },
  { key: "showActivity", label: "activity" },
];

function PublicProfileHandleCard() {
  const { profilePublic, setProfilePublic, pushToast } = useDemo();
  const [handle, setHandle] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingHandle, setEditingHandle] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<"error" | "success">("success");
  const showMessage = (text: string, tone: "error" | "success") => {
    setMessage(text);
    setMessageTone(tone);
  };
  const [checkingAvailability, setCheckingAvailability] = useState(false);
  const [generatingHandle, setGeneratingHandle] = useState(false);
  const [takenReason, setTakenReason] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [visibilityError, setVisibilityError] = useState<string | null>(null);
  const [confirmedAvailable, setConfirmedAvailable] = useState<string | null>(null);
  const [prefs, setPrefs] = useState({ showKarma: true, showBadges: true, showDatasets: true, showActivity: true });
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [savingName, setSavingName] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void authedFetch(API.me.publicProfile)
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as {
          handle?: string | null;
          displayName?: string | null;
          prefs?: Partial<{ showKarma: boolean; showBadges: boolean; showDatasets: boolean; showActivity: boolean }>;
          message?: string;
        };
        if (!res.ok) throw new Error(safeMessage(body.message, "Could not load public profile settings."));
        if (!cancelled) {
          setHandle(body.handle ?? null);
          if (typeof body.displayName === "string") setDisplayName(body.displayName);
          if (body.prefs) {
            const p = body.prefs;
            setPrefs((current) => ({
              showKarma: typeof p.showKarma === "boolean" ? p.showKarma : current.showKarma,
              showBadges: typeof p.showBadges === "boolean" ? p.showBadges : current.showBadges,
              showDatasets: typeof p.showDatasets === "boolean" ? p.showDatasets : current.showDatasets,
              showActivity: typeof p.showActivity === "boolean" ? p.showActivity : current.showActivity,
            }));
          }
        }
      })
      .catch((error) => !cancelled && showMessage(error instanceof Error ? error.message : "Could not load public profile settings.", "error"))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  const claim = async () => {
    if (!input.trim() || saving) return;
    setSaving(true);
    setMessage(null);
    setSuggestions([]);
    try {
      const res = await authedFetch(API.me.publicProfileHandle, {
        method: handle ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: input }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string; handle?: string; profilePublic?: boolean };
      if (!res.ok) {
        void authedFetch(API.me.publicProfileHandleAvailability(input.trim()))
          .then((availRes) => availRes.json().catch(() => ({})))
          .then((availBody: { suggestions?: string[] }) => setSuggestions(availBody.suggestions ?? []))
          .catch(() => {});
        throw new Error(safeMessage(body.message, "Could not claim that handle."));
      }
      setHandle(body.handle ?? input);
      if (!handle && body.profilePublic === true) setProfilePublic(true);
      setEditingHandle(false);
      setInput("");
      showMessage(handle ? "Handle updated. Your old URL is no longer yours." : "Handle claimed. Your public profile is now live.", "success");
      pushToast({ variant: "success", title: handle ? "Handle updated" : "Handle claimed" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Could not claim that handle.";
      showMessage(msg, "error");
      pushToast({ variant: "error", title: "Couldn't claim that handle", body: msg });
    } finally { setSaving(false); }
  };

  const saveName = async () => {
    const value = nameInput.trim();
    if (!value || savingName) return;
    if (value === displayName) { setEditingName(false); return; }
    setSavingName(true); setMessage(null);
    try {
      const res = await authedFetch(API.me.publicProfileDisplayName, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName: value }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string; displayName?: string };
      if (!res.ok) throw new Error(safeMessage(body.message, "Could not update your display name."));
      setDisplayName(body.displayName ?? value);
      setEditingName(false);
      showMessage("Display name updated.", "success");
      pushToast({ variant: "success", title: "Display name updated" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Could not update your display name.";
      showMessage(msg, "error");
      pushToast({ variant: "error", title: "Couldn't update display name", body: msg });
    } finally { setSavingName(false); }
  };

  const applySuggestion = (suggestion: string) => {
    setInput(suggestion);
    setMessage(null);
    setSuggestions([]);
    setTakenReason(null);
    setConfirmedAvailable(suggestion);
  };

  const generateAvailableHandle = async () => {
    setGeneratingHandle(true);
    setMessage(null);
    try {
      const response = await authedFetch(API.me.publicProfileHandleSuggestions(1));
      const body = (await response.json().catch(() => ({}))) as { suggestions?: string[] };
      const candidate = response.ok ? body.suggestions?.[0] : undefined;
      if (candidate) applySuggestion(candidate);
      else showMessage("Couldn't find an available name right now — try again.", "error");
    } catch {
      showMessage("Couldn't generate a handle right now — try again.", "error");
    } finally {
      setGeneratingHandle(false);
    }
  };

  useEffect(() => {
    const value = input.trim();
    const skip = !value || value === handle || value === confirmedAvailable;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      if (skip) {
        setCheckingAvailability(false);
        setTakenReason(null);
        return;
      }
      setCheckingAvailability(true);
      setTakenReason(null);
      void authedFetch(API.me.publicProfileHandleAvailability(value))
        .then(readHandleAvailability)
        .then((body) => {
          if (cancelled) return;
          if (body.available) {
            setConfirmedAvailable(value);
            setTakenReason(null);
            setSuggestions([]);
          } else {
            setConfirmedAvailable(null);
            setTakenReason(body.reason ?? "That handle is unavailable.");
            if (body.suggestions?.length) setSuggestions(body.suggestions);
          }
        })
        .catch(() => {})
        .finally(() => { if (!cancelled) setCheckingAvailability(false); });
    }, skip ? 0 : 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [input, handle, editingHandle, confirmedAvailable]);

  const updatePrefs = async (next: typeof prefs) => {
    setSaving(true); setMessage(null);
    try {
      const response = await authedFetch(API.me.publicProfile, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prefs: next }) });
      const body = (await response.json().catch(() => ({}))) as { message?: string; prefs?: Partial<typeof prefs> };
      if (!response.ok) throw new Error(safeMessage(body.message, "Could not update profile visibility."));
      setPrefs((current) => ({
        ...current,
        showKarma: typeof body.prefs?.showKarma === "boolean" ? body.prefs.showKarma : next.showKarma,
        showBadges: typeof body.prefs?.showBadges === "boolean" ? body.prefs.showBadges : next.showBadges,
        showDatasets: typeof body.prefs?.showDatasets === "boolean" ? body.prefs.showDatasets : next.showDatasets,
        showActivity: typeof body.prefs?.showActivity === "boolean" ? body.prefs.showActivity : next.showActivity,
      }));
      pushToast({ variant: "success", title: "Visibility updated" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Could not update profile visibility.";
      showMessage(msg, "error");
      pushToast({ variant: "error", title: "Couldn't update visibility", body: msg });
    }
    finally { setSaving(false); }
  };

  const displayHost = LANDING_URL.replace(/^https?:\/\//, "");
  const isAvailable = Boolean(confirmedAvailable) && confirmedAvailable === input.trim();

  const visibleParts: string[] = [];
  if (handle && profilePublic) {
    visibleParts.push(`@${handle}`);
    for (const row of PUBLIC_VISIBILITY_ROWS) {
      if (prefs[row.key]) visibleParts.push(row.label);
    }
  }

  return (
    <div>
      <div className="card p-[22px]">
      {!loading && displayName !== null && (
        <div className="mb-4 border-b border-line-soft pb-4">
          <span className="micro-label mb-1.5 block text-ink-faint">display name</span>
          {editingName ? (
            <div className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor="display-name">Display name</label>
              <input
                id="display-name"
                value={nameInput}
                onChange={(event) => setNameInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void saveName(); }}
                placeholder="Your name"
                maxLength={80}
                autoFocus
                className="min-w-[240px] flex-1 rounded-lg border border-line bg-white px-3 py-2 text-[13px] outline-none transition-colors focus:border-ink"
              />
              <Button onClick={() => void saveName()} disabled={savingName || !nameInput.trim() || nameInput.trim() === displayName}>
                {savingName ? "saving…" : "save"}
              </Button>
              <Button variant="secondary" onClick={() => { setEditingName(false); setMessage(null); }} disabled={savingName}>cancel</Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-[14px] font-bold tracking-tight">{displayName}</span>
              <button
                type="button"
                onClick={() => { setNameInput(displayName); setMessage(null); setEditingName(true); }}
                className="flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-white px-2.5 py-1 font-mono text-[11px] text-ink-soft transition-colors hover:border-ink hover:text-ink"
              >
                <Icon name="edit" size={11} />
                change
              </button>
            </div>
          )}
        </div>
      )}
      {loading ? <AsyncState status="loading" loadingText="Loading profile settings…" /> : handle && !editingHandle ? (
        <div className="flex flex-wrap items-center gap-2.5">
          <a
            href={`${LANDING_URL}/${handle}?me=1`}
            target="_blank"
            rel="noreferrer"
            title="Open your public page"
            className="min-w-0 cursor-pointer break-all font-mono text-[14px] font-bold tracking-tight underline decoration-transparent underline-offset-2 transition-colors hover:text-karma hover:decoration-current"
          >
            {displayHost}/{handle}
          </a>
          <CopyButton
            value={`${LANDING_URL}/${handle}`}
            label="profile link"
            className="min-w-[74px] justify-center rounded-full hover:border-ink hover:text-ink"
          />
          <button
            type="button"
            onClick={() => { setInput(handle); setMessage(null); setSuggestions([]); setConfirmedAvailable(null); setEditingHandle(true); }}
            className="flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-white px-2.5 py-1 font-mono text-[11px] text-ink-soft transition-colors hover:border-ink hover:text-ink"
          >
            <Icon name="edit" size={11} />
            change
          </button>
          <a href={`${LANDING_URL}/${handle}?me=1`} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 font-mono text-[12px] font-medium text-karma hover:underline">
            view public page
            <Icon name="external" size={12} />
          </a>
        </div>
      ) : (
        <div>
          <span className="micro-label mb-1.5 block text-ink-faint">{handle ? "change your handle" : "claim your handle"}</span>
          <div className="flex flex-wrap items-center gap-2">
            <div className={`flex min-w-[240px] flex-1 items-center rounded-lg border bg-white px-3 py-2 font-mono text-[13px] transition-colors focus-within:border-ink ${isAvailable ? "border-emerald-400" : takenReason ? "border-red-400" : "border-line"}`}>
              <span className="text-ink-faint">{displayHost}/</span>
              <label className="sr-only" htmlFor="public-handle">Handle</label>
              <input
                id="public-handle"
                value={input}
                onChange={(event) => {
                  setInput(event.target.value.toLowerCase().replace(/\s+/g, "-"));
                  setConfirmedAvailable(null);
                  setTakenReason(null);
                  setSuggestions([]);
                }}
                onKeyDown={(event) => { if (event.key === "Enter") void claim(); }}
                placeholder="your-handle"
                maxLength={20}
                spellCheck={false}
                autoCapitalize="none"
                autoFocus
                aria-invalid={Boolean(takenReason)}
                className="min-w-0 flex-1 bg-transparent outline-none"
              />
              {checkingAvailability && <Icon name="refresh" size={13} className="shrink-0 animate-spin text-ink-faint" />}
              {!checkingAvailability && isAvailable && <Icon name="check" size={13} className="shrink-0 text-emerald-600" />}
              {!checkingAvailability && takenReason && <Icon name="x" size={13} className="shrink-0 text-red-500" />}
            </div>
            <Button variant="secondary" onClick={() => void generateAvailableHandle()} disabled={saving || generatingHandle}>
              <Icon name="refresh" size={13} className={generatingHandle ? "animate-spin" : undefined} />
              {generatingHandle ? "finding…" : "generate"}
            </Button>
            <Button onClick={() => void claim()} disabled={saving || checkingAvailability || Boolean(takenReason) || !input.trim() || (handle ? input.trim() === handle : false)}>
              {saving ? "saving…" : handle ? "save" : "claim handle"}
            </Button>
            {handle && <Button variant="secondary" onClick={() => { setEditingHandle(false); setInput(""); setMessage(null); setSuggestions([]); setConfirmedAvailable(null); setTakenReason(null); }} disabled={saving}>cancel</Button>}
          </div>
          {checkingAvailability ? (
            <p className="mt-1.5 text-[12px] text-ink-soft">checking availability…</p>
          ) : takenReason ? (
            <p role="alert" className="mt-1.5 text-[12px] text-red-600">{takenReason}</p>
          ) : isAvailable ? (
            <p className="mt-1.5 flex items-center gap-1 text-[12px] text-emerald-700"><Icon name="check" size={12} /> Available</p>
          ) : handle ? (
            <p className="mt-2 text-[12px] text-amber-700">Changing your handle releases the old URL, so update any links you have shared.</p>
          ) : null}
          {suggestions.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[11px] text-ink-faint">try:</span>
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => applySuggestion(suggestion)}
                  className="cursor-pointer rounded-full border border-line bg-white px-2.5 py-1 font-mono text-[11px] text-ink-soft transition-colors hover:border-ink hover:text-ink"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {handle && (
        <>
          <div className="mt-4 flex items-center justify-between gap-4 rounded-[10px] border border-line-soft bg-panel px-4 py-3.5">
            <div className="min-w-0">
              <span className="text-[13px] font-semibold tracking-tight">Page visibility</span>
              <p className="mt-0.5 text-[12.5px] text-ink-soft">
                {profilePublic ? "Live. Anyone with the link can see it." : "Off. Only you can see this page."}
              </p>
            </div>
            <Toggle
              on={profilePublic}
              disabled={saving}
              onClick={() => {
                const next = !profilePublic;
                setVisibilityError(null);
                void setProfilePublic(next)
                  .then(() => pushToast({ variant: "success", title: next ? "Profile is now public" : "Profile is now private" }))
                  .catch((err) => {
                    const msg = err instanceof Error ? err.message : "Could not update profile visibility.";
                    setVisibilityError(msg);
                    pushToast({ variant: "error", title: "Couldn't update visibility", body: msg });
                  });
              }}
              label="Make profile public"
            />
          </div>

          <div
            className={`mt-2.5 grid gap-2 sm:grid-cols-2 ${profilePublic ? "" : "pointer-events-none opacity-40"}`}
            aria-disabled={!profilePublic}
          >
            {PUBLIC_VISIBILITY_ROWS.map((row) => (
              <div key={row.key} className="flex items-center justify-between gap-3 rounded-[10px] border border-line-soft px-3.5 py-2.5">
                <span className="font-mono text-[12px] text-ink-soft">{row.label}</span>
                <Toggle
                  on={prefs[row.key]}
                  disabled={saving}
                  onClick={() => void updatePrefs({ ...prefs, [row.key]: !prefs[row.key] })}
                  label={row.label}
                />
              </div>
            ))}
          </div>

          {profilePublic ? (
            <div className="mt-4 border-t border-line-soft pt-3.5">
              <span className="micro-label text-ink-faint">visible right now</span>
              <p className="mt-1.5 font-mono text-[12px] text-ink-soft">
                {visibleParts.length > 0
                  ? visibleParts.join(" · ")
                  : "Public, but every section is switched off — a visitor sees only your handle."}
              </p>
            </div>
          ) : (
            <div className="mt-4 rounded-[10px] border border-line-soft bg-panel px-4 py-4">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#eaf3d6] text-accent-strong">
                  <Icon name="eye" size={14} />
                </span>
                <span className="text-[13px] font-semibold tracking-tight">
                  Your work is invisible while this is off
                </span>
              </div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
                Nobody can look you up. Your karma, tier and badges, the datasets you
                helped build, and your delivery track record all stay hidden. Turn it on for a
                shareable page at{" "}
                <span className="font-mono text-ink">databounty.io/{handle ?? "your-handle"}</span>{" "}
                that proves what you&apos;ve shipped.
              </p>
              <div className="mt-3">
                <Button
                  size="sm"
                  disabled={saving}
                  onClick={() => {
                    setVisibilityError(null);
                    void setProfilePublic(true)
                      .then(() => pushToast({ variant: "success", title: "Profile is now public" }))
                      .catch((err) => {
                        const m = err instanceof Error ? err.message : "Could not update profile visibility.";
                        setVisibilityError(m);
                        pushToast({ variant: "error", title: "Couldn't update visibility", body: m });
                      });
                  }}
                >
                  <Icon name="eye" size={13} />
                  make my page public
                </Button>
              </div>
            </div>
          )}
        </>
      )}
      {visibilityError && <p role="alert" className="mt-3 text-[12px] text-red-600">{visibilityError}</p>}
      {message && (
        <p
          role={messageTone === "error" ? "alert" : "status"}
          className={`mt-3 text-[12px] ${messageTone === "error" ? "text-red-600" : "text-emerald-700"}`}
        >
          {message}
        </p>
      )}
      </div>
    </div>
  );
}

function Toggle({
  on,
  onClick,
  label,
  disabled = false,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="shrink-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
    >
      <ToggleSwitch on={on} size="md" />
    </button>
  );
}

type SourceMeta = { id: SourceId; label: string; color: string; help: string };

const SOURCE_HELP: Record<SourceId, string> = {
  linkedin: "Verify your professional background.",
  github: "Prove your code contributions.",
  scholar: "Link your published research.",
  orcid: "Connect your researcher iD.",
  kaggle: "Show your competition track record.",
  x: "Verify your public presence.",
  website: "Add your personal site or portfolio.",
};

const SOURCES: SourceMeta[] = CREDENTIAL_SOURCES.map((source) => ({ ...source, help: SOURCE_HELP[source.id] }));

function SourceCard({ meta }: { meta: SourceMeta }) {
  const { sources, connectSource, verifyWebsiteSource, disconnectSource, pushToast } = useDemo();
  const src = sources[meta.id];
  const connected = src?.connected;
  const available = isCredentialSourceAvailable(meta.id, !!src?.oauthCapable);
  const reconnectRequired = connected && !src.verified && src.oauthCapable &&
    (src.verificationState === "pending_recheck" || src.verificationState === "invalid");
  const checkDeferred = connected && src.verified && Boolean(src.verifyLastError);
  const [entering, setEntering] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitManual = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await connectSource(meta.id, draft.trim());
      setEntering(false);
      setDraft("");
      pushToast({ variant: "success", title: `${meta.label} saved` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not save source.";
      setError(msg);
      pushToast({ variant: "error", title: `Couldn't save ${meta.label}`, body: msg });
    } finally {
      setBusy(false);
    }
  };

  const startConnect = async () => {
    if (busy) return;
    if (meta.id === "website") {
      setEntering(true);
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await connectSource(meta.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not start OAuth.";
      setError(msg);
      pushToast({ variant: "error", title: `Couldn't connect ${meta.label}`, body: msg });
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await disconnectSource(meta.id);
      pushToast({ variant: "success", title: `${meta.label} disconnected` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not disconnect source.";
      setError(msg);
      pushToast({ variant: "error", title: `Couldn't disconnect ${meta.label}`, body: msg });
    } finally {
      setBusy(false);
    }
  };

  const verifyWebsite = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await verifyWebsiteSource();
      pushToast({ variant: "success", title: "Website verified" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not verify website.";
      setError(msg);
      pushToast({ variant: "error", title: "Couldn't verify website", body: msg });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-[10px] bg-white px-3.5 py-2.5 transition-colors ${
        connected ? "border-[1.5px] border-[#c9d6a6]" : "border border-line"
      } ${!available && !connected ? "opacity-60" : ""}`}
    >
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
        style={{ backgroundColor: `${meta.color}1a`, color: meta.color }}
      >
        <CredentialSourceGlyph id={meta.id} color={meta.color} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-bold tracking-tight">{meta.label}</span>
          {connected && src.verified && (
            <span className="flex items-center gap-0.5 font-mono text-[10px] text-emerald-600">
              <Icon name="check" size={10} /> verified
            </span>
          )}
          {connected && !src.verified && (
            <span className={`font-mono text-[10px] ${reconnectRequired ? "text-amber-700" : "text-ink-faint"}`}>
              {reconnectRequired ? "reconnect required" : "added"}
            </span>
          )}
          {checkDeferred && (
            <span className="font-mono text-[10px] text-amber-700">recheck delayed</span>
          )}
        </div>
        {entering ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitManual()}
            placeholder={meta.help}
            className="mt-0.5 w-full rounded border border-line bg-transparent px-1.5 py-0.5 font-mono text-[11px] outline-none focus:border-lime-500"
          />
        ) : (
          <div className="truncate font-mono text-[11px] text-ink-soft">
            {connected ? src.handle : available ? meta.help : "This source will be enabled when verification is available."}
          </div>
        )}
        {meta.id === "website" && connected && !src.verified && src.verifyChallenge && (
          <div className="mt-1 rounded border border-line-soft bg-panel px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-ink-soft">
            Add this text to your homepage, then verify:
            <span className="mt-1 block select-all break-all font-bold text-ink">
              {src.verifyChallenge}
            </span>
          </div>
        )}
      </div>
      {connected && meta.id === "website" && !src.verified ? (
        <Button size="sm" variant="secondary" onClick={verifyWebsite} disabled={busy}>
          {busy ? "checking" : "verify"}
        </Button>
      ) : reconnectRequired ? (
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="secondary" onClick={startConnect} disabled={busy}>
            {busy ? "opening" : "reconnect"}
          </Button>
          <button
            type="button"
            onClick={disconnect}
            disabled={busy}
            className="cursor-pointer font-mono text-[11px] text-ink-faint transition-colors hover:text-rose-600"
          >
            disconnect
          </button>
        </div>
      ) : connected ? (
        <button
          type="button"
          onClick={disconnect}
          disabled={busy}
          className="shrink-0 cursor-pointer font-mono text-[11px] text-ink-faint transition-colors hover:text-rose-600"
        >
          {busy ? "working" : "disconnect"}
        </button>
      ) : entering ? (
        <Button size="sm" variant="secondary" onClick={submitManual} disabled={busy}>
          {busy ? "saving" : "save"}
        </Button>
      ) : available ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={startConnect}
          disabled={busy}
        >
          {busy ? "opening" : "connect"}
        </Button>
      ) : (
        <span className="shrink-0 font-mono text-[11px] text-ink-faint">unavailable</span>
      )}
      {error && (
        <div className="basis-full break-words pl-11 text-[11px] text-red-600">{error}</div>
      )}
    </div>
  );
}

function CapacityCard({
  roleLabel,
  rank,
  ranks,
  pill,
  href,
  stats,
}: {
  roleLabel: string;
  rank: string;
  ranks: readonly string[];
  pill: string;
  href: string;
  stats: { label: string; value: string }[];
}) {
  const tierIndex = Math.max(0, ranks.indexOf(rank));
  const total = ranks.length;
  const w = total === 0 ? 0 : Math.min(100, ((tierIndex + 1) / total) * 100);
  return (
    <div className="card p-[22px]">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <div className="micro-label text-ink-faint">{roleLabel} capacity</div>
          <div className="mt-1 text-[17px] font-bold tracking-tight">{rank}</div>
        </div>
        <span className="rounded-full bg-brand-soft px-2.5 py-1.5 font-mono text-[11px] text-ink-soft">
          {pill}
        </span>
      </div>
      <div className="mb-1.5 flex justify-between font-mono text-[11px] text-ink-soft">
        <span>rank tier</span>
        <span className="text-ink">
          {tierIndex + 1} / {total}
        </span>
      </div>
      <div className="w-full overflow-hidden rounded-[3px] bg-line-soft" style={{ height: 6 }}>
        <div className="h-full bg-ink transition-all" style={{ width: `${w}%` }} />
      </div>
      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs">
        {stats.map((s) => (
          <div key={s.label}>
            <span className="text-ink-soft">{s.label}</span>{" "}
            <span className="font-bold">{s.value}</span>
          </div>
        ))}
      </div>
      <Link
        href={href}
        className="mt-4 inline-flex items-center gap-1 font-mono text-[12px] font-medium text-accent-strong hover:underline"
      >
        view details
        <Icon name="arrow-right" size={12} />
      </Link>
    </div>
  );
}

function Badge({ icon, label, title }: { icon: IconName; label: string; title?: string }) {
  return (
    <span title={title}>
      <Pill tone="lime">
        <Icon name={icon} size={12} className="text-accent-strong" />
        {label}
      </Pill>
    </span>
  );
}

function SecuritySection() {
  const { user, authReady, changePassword, requestSetPasswordEmail, pushToast } = useDemo();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [linkSent, setLinkSent] = useState(false);

  if (!authReady) {
    return (
      <div className="mt-9">
        <SectionHeader title="Password & security" sub="Sign-in methods for this account." />
        <AsyncState status="loading" loadingText="Loading your security settings…" />
      </div>
    );
  }
  if (!user) return null;
  const hasPassword = user.hasPassword;

  const submit = async () => {
    if (next.length < 8 || submitting) return;
    setSubmitting(true);
    setError(null);
    setDone(false);
    try {
      await changePassword(current, next);
      setCurrent("");
      setNext("");
      setDone(true);
      pushToast({ variant: "success", title: "Password updated" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong.";
      setError(msg);
      pushToast({ variant: "error", title: "Couldn't update password", body: msg });
    } finally {
      setSubmitting(false);
    }
  };

  if (!hasPassword) {
    // SEC-07 (2026-09-05): POST /v1/auth/set-password now requires a live
    // `set`-purpose token minted by POST /v1/auth/request-set-password and
    // delivered by mail, so a bare session can no longer plant the first
    // password in-page. The "set password" button therefore requests that
    // email; the mailed link lands on /reset-password, which submits the token
    // and the new password together. Same confirmation copy the emailed-link
    // route already rendered.
    const requestLink = async () => {
      if (submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        await requestSetPasswordEmail();
        setLinkSent(true);
        pushToast({ variant: "success", title: "Link sent", body: "Check your inbox to set a password." });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Something went wrong.";
        setError(msg);
        pushToast({ variant: "error", title: "Couldn't send link", body: msg });
      } finally {
        setSubmitting(false);
      }
    };
    return (
      <div className="mt-9">
        <SectionHeader
          title="Password & security"
          sub="Add a password so you can sign in with email too — not only Google."
        />
        <div className="card p-[22px]">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-dark text-lime">
              <Icon name="shield" size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-[13px] font-bold text-ink">No password set</p>
                <Pill tone="neutral">Google sign-in</Pill>
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
                You signed in with Google, so there&apos;s no password on this
                account yet. Add one and you can sign in with either method.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={requestLink} disabled={submitting}>
                  <Icon name="mail" size={14} />
                  {linkSent ? "resend link" : "set password"}
                </Button>
              </div>
              {linkSent && !error && (
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12.5px] font-medium text-emerald-700">
                  <Icon name="check" size={14} />
                  Link sent — check your inbox to set a password.
                </div>
              )}
              {error && <p className="mt-2 text-[12.5px] text-red-600">{error}</p>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-9">
      <SectionHeader title="Password & security" sub="Change your account password." />
      <div className="card p-[22px]">
        <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="micro-label mb-1.5 block text-ink-faint">current password</span>
          <PasswordInput
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm outline-none focus:border-ink"
          />
        </label>
        <label className="block">
          <span className="micro-label mb-1.5 block text-ink-faint">new password</span>
          <PasswordInput
            value={next}
            onChange={(e) => setNext(e.target.value)}
            minLength={8}
            placeholder="at least 8 characters"
            autoComplete="new-password"
            className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm outline-none focus:border-ink"
          />
        </label>
        </div>
        <Button className="mt-4" size="sm" onClick={submit} disabled={submitting || next.length < 8 || current.length === 0}>
          {submitting ? "saving…" : "change password"}
        </Button>
        {error && <p className="mt-3 text-[12.5px] text-red-600">{error}</p>}
        {done && !error && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12.5px] font-medium text-emerald-700">
            <Icon name="check" size={14} />
            Password changed.
          </div>
        )}
      </div>
    </div>
  );
}

function ProfileViewInner() {
  const {
    profileSummary,
    profileSourcesLoaded,
    profileSourcesError,
    refreshProfileSources,
    sources,
    authReady,
    hasRealSession,
    sponsorScope,
    saveSponsorScope,
    pushToast,
  } = useDemo();
  const [sponsorScopePromptOpen, setSponsorScopePromptOpen] = useState(false);

  const orderedSources = useMemo(
    () => orderCredentialSources(SOURCES, (id) => !!sources[id]?.oauthCapable),
    [sources],
  );

  const router = useRouter();
  const searchParams = useSearchParams();
  const handledConnectReturn = useRef<string | null>(null);
  useEffect(() => {
    const connected = searchParams.get("connected");
    const connectError = searchParams.get("connectError");
    if (!connected && !connectError) return;
    const key = `${connected ?? ""}|${connectError ?? ""}`;
    if (handledConnectReturn.current === key) return;
    handledConnectReturn.current = key;
    if (connected) {
      pushToast({ variant: "success", title: `${connected} connected`, body: "Credential verified." });
      void refreshProfileSources();
    } else if (connectError) {
      pushToast({ variant: "error", title: "Connection failed", body: connectError });
    }
    router.replace("/profile/", { scroll: false });
  }, [searchParams, pushToast, refreshProfileSources, router]);

  return (
    <div>
      <PageHeader
        title="Profile"
        sub="Your capacity and badges, your public page, and your account settings."
      />

      {profileSourcesError && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-rose-200 bg-rose-50 px-4 py-3">
          <p className="text-[13px] text-rose-900">
            Couldn&apos;t load your reputation profile: {profileSourcesError}.
            The numbers below may be stale or incomplete.
          </p>
          <button
            type="button"
            onClick={refreshProfileSources}
            className="shrink-0 cursor-pointer font-mono text-[12px] font-medium text-rose-900 underline hover:text-rose-950"
          >
            retry
          </button>
        </div>
      )}

      <PublicProfileHandleCard />

      <div className="mt-9">
        <SectionHeader title="Capacity" sub="How much you can claim at once. Reliable delivery raises it." />
        {!profileSourcesLoaded ? (
          <AsyncState status="loading" loadingText="Loading your capacity…" />
        ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <CapacityCard
            roleLabel="contributor"
            rank={profileSummary.ranks.contributor.rank}
            ranks={CONTRIBUTOR_RANKS}
            pill={`${profileSummary.ranks.contributor.maxConcurrentBatches} batch limit`}
            href="/karma"
            stats={[
              { label: "accepted items", value: String(profileSummary.ranks.contributor.acceptedItems) },
              {
                label: "clean streak",
                value: String(profileSummary.ranks.contributor.consecutiveCleanDeliveries),
              },
              { label: "missed deadlines", value: String(profileSummary.ranks.contributor.missedDeadlines) },
              { label: "abandons", value: String(profileSummary.ranks.contributor.abandons) },
            ]}
          />
          <CapacityCard
            roleLabel="validator"
            rank={profileSummary.ranks.validator.rank}
            ranks={VALIDATOR_RANKS}
            pill={`${profileSummary.ranks.validator.auditsCompleted} audits`}
            href="/karma"
            stats={[
              { label: "decided flags", value: String(profileSummary.ranks.validator.decidedFlags) },
              { label: "dismissed flags", value: String(profileSummary.ranks.validator.dismissedFlags) },
              { label: "missed deadlines", value: String(profileSummary.ranks.validator.missedDeadlines) },
              { label: "false flag rate", value: formatPct(profileSummary.ranks.validator.falseFlagRate) },
            ]}
          />
        </div>
        )}
      </div>

      <div className="mt-9">
        <SectionHeader title="Badges" sub="Earned across your contributor and validator work." />
        {!profileSourcesLoaded ? (
          <AsyncState status="loading" loadingText="Loading your badges…" />
        ) : profileSummary.badges.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {profileSummary.badges.map((b) => (
              <Badge key={b.id} icon={b.icon} label={b.label} title={b.criteria} />
            ))}
          </div>
        ) : (
          <Empty
            icon="award"
            description="No earned badges yet. Verified credentials, accepted work, clean deliveries, and completed audits will appear here automatically."
          />
        )}
      </div>

      <div className="mt-9">
        <SectionHeader
          title="Dataset interests"
          sub={
            !authReady
              ? "Loading your account…"
              : !hasRealSession
                ? "Sign in again to change this."
                : "Every account can sponsor, contribute and validate — all three, always. There is nothing to choose."
          }
        />
        <div className="card divide-y divide-line-soft">
          <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
            <div className="flex min-w-0 items-start gap-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-panel text-ink-soft">
                <Icon name="database" size={16} />
              </span>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold tracking-tight">Dataset interests</div>
                <p className="mt-0.5 max-w-xl text-[12.5px] leading-normal text-ink-soft">
                  Domains, dataset types and languages you care about. Used to
                  pre-fill community requests.
                </p>
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={!authReady || !hasRealSession}
              onClick={() => setSponsorScopePromptOpen(true)}
            >
              {sponsorScope && (sponsorScope.domains.length || sponsorScope.datasetTypeIds.length)
                ? "Edit interests"
                : "Set interests"}
            </Button>
          </div>
        </div>
      </div>

      <SponsorScopeModal
        open={sponsorScopePromptOpen}
        initialScope={sponsorScope}
        onCancel={() => setSponsorScopePromptOpen(false)}
        onSubmit={async (scope) => {
          if (await saveSponsorScope(scope)) {
            setSponsorScopePromptOpen(false);
            pushToast({ variant: "success", title: "Dataset interests saved" });
          }
        }}
      />

      <div className="mt-9">
        <SectionHeader title="Credentials" sub="Verified credentials route higher-quality assignments your way." />
        {!profileSourcesLoaded ? (
          <AsyncState status="loading" loadingText="Loading your credentials…" />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {orderedSources.map((meta) => (
              <SourceCard key={meta.id} meta={meta} />
            ))}
          </div>
        )}
      </div>

      <SecuritySection />
    </div>
  );
}

export function ProfileView() {
  return (
    <Suspense fallback={<AsyncState status="loading" loadingText="Loading profile…" />}>
      <ProfileViewInner />
    </Suspense>
  );
}

export default function ProfilePage() {
  return <ProfileView />;
}
