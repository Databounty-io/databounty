"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from "react";
import Script from "next/script";
import { useRouter, useSearchParams } from "next/navigation";
import { useDemo } from "@/lib/store";
import { resolveHomeRoute } from "@/lib/home-route";
import type { Persona, SourceId, SponsorScope } from "@/lib/store";
import type { DatasetCategory } from "@/lib/types";
import type { DomainId } from "@/lib/dataset-types";
import { API_URL, LANDING_URL } from "@/lib/urls";
import { API } from "@/lib/api-endpoints";
import { type McpClientIcon } from "@/lib/mcp-connection-guide";
import { readHandleAvailability } from "@/lib/handle-availability";
import { PUBLIC_PROFILE_RETURN_PARAM, publicProfileReturnUrl, readPublicProfileReturnHandle } from "@/lib/public-profile-return";
import { Brandmark } from "./brand";
import { Icon, type IconName } from "./icons";
import { PasswordInput } from "./password-input";
import { AsyncState, Button, ConfirmDialog, Modal } from "./ui";
import { McpClientPicker } from "./mcp-client-picker";

// Fastify's built-in 404 handler writes messages of the exact shape
// "Route POST:/v1/foo/bar not found" whenever a route genuinely doesn't
// exist server-side — a routing implementation detail, never something a
// real handler would phrase that way. Trusting it blindly meant a missing
// backend route displayed that raw string instead of a friendly fallback.
const FASTIFY_ROUTE_NOT_FOUND = /^Route (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS):.* not found$/;
function safeMessage(message: string | undefined, fallback: string): string {
  if (!message || FASTIFY_ROUTE_NOT_FOUND.test(message)) return fallback;
  return message;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (resp: { credential: string }) => void;
          }) => void;
          renderButton: (el: HTMLElement, options: Record<string, string>) => void;
        };
      };
    };
  }
}

function OnboardingMcpClientLogo({ name }: { name: McpClientIcon }) {
  const className = "h-3.5 w-3.5 shrink-0";
  if (name === "claude") return <svg aria-hidden="true" viewBox="0 0 24 24" className={className}><path fill="#D97757" fillRule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" clipRule="evenodd" /></svg>;
  if (name === "codex") return <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#171717]"><svg viewBox="0 0 24 24" className="h-3 w-3"><path fill="white" fillRule="evenodd" d="M8.086.457a6.105 6.105 0 0 1 3.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 0 0 .107.029c1.408-.346 2.762-.224 4.061.366l.217.106c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 0 1-.18 1.631.167.167 0 0 0 .04.155 5.982 5.982 0 0 1 1.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 0 1-2.934 1.851.162.162 0 0 0-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 0 0-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 0 1-2.595-.622 6.058 6.058 0 0 1-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 0 1-.495-1.283 6.11 6.11 0 0 1-.017-3.064.166.166 0 0 0 .008-.074.115.115 0 0 0-.037-.064 5.958 5.958 0 0 1-1.38-2.202 5.196 5.196 0 0 1-.333-1.589 6.915 6.915 0 0 1 .188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 0 0 .087-.087A6.016 6.016 0 0 1 5.635 2.31C6.315 1.464 7.132.846 8.086.457Zm-.804 7.85a.848.848 0 0 0-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 0 0 1.46.864l1.94-3.272a.849.849 0 0 0 .007-.854l-1.94-3.393Zm5.446 6.24a.849.849 0 0 0 0 1.695h4.848a.849.849 0 0 0 0-1.696h-4.848Z" clipRule="evenodd" /></svg></span>;
  if (name === "cursor") return <svg aria-hidden="true" viewBox="0 0 466.73 532.09" className={className}><path fill="currentColor" d="M457.43 125.94 244.42 2.96a22.1 22.1 0 0 0-22.12 0L9.3 125.94A18.6 18.6 0 0 0 0 142.05v247.99a18.6 18.6 0 0 0 9.3 16.11l213.01 122.98a22.1 22.1 0 0 0 22.12 0l213.01-122.98a18.6 18.6 0 0 0 9.3-16.11V142.05a18.6 18.6 0 0 0-9.3-16.11h-.01Zm-13.38 26.05-205.63 356.16c-1.39 2.4-5.06 1.42-5.06-1.36V273.58c0-4.66-2.49-8.97-6.53-11.31L24.87 145.67c-2.4-1.39-1.42-5.06 1.36-5.06h411.26c5.84 0 9.49 6.33 6.57 11.39h-.01Z" /></svg>;
  if (name === "windsurf") return <span aria-hidden="true" className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] bg-[#111827]"><svg viewBox="0 0 1024 1024" className="h-2 w-2"><path fill="#fff" d="M897.246 286.869h-7.427c-39.084-.061-70.802 31.591-70.802 70.67v158.05c0 31.561-26.087 57.127-57.135 57.127-18.446 0-36.862-9.283-47.789-24.866L552.673 317.304c-13.393-19.144-35.187-30.557-58.778-30.557-36.801 0-69.919 31.287-69.919 69.91v158.962c0 31.562-25.873 57.127-57.134 57.127-18.507 0-36.893-9.283-47.821-24.865L138.395 289.882c-4.079-5.844-13.241-2.952-13.241 4.17v137.84c0 6.97 2.131 13.727 6.118 19.448L309.037 705.2c10.502 15.004 25.994 26.144 43.863 30.192 44.716 10.165 85.87-24.257 85.87-68.114V508.406c0-31.561 25.569-57.127 57.134-57.127h.091c19.025 0 36.862 9.283 47.79 24.866l161.45 230.516c13.424 19.174 34.092 30.557 58.748 30.557 37.623 0 69.858-31.318 69.858-69.91V508.376c0-31.561 25.569-57.127 57.134-57.127h6.301a7.154 7.154 0 0 0 7.154-7.152v-150.076a7.154 7.154 0 0 0-7.154-7.152h-.03Z" /></svg></span>;
  if (name === "openclaw") return <svg aria-hidden="true" viewBox="0 0 120 120" className={className} fill="none"><defs><linearGradient id="onboarding-openclaw-gradient" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#ff4d4d" /><stop offset="100%" stopColor="#991b1b" /></linearGradient></defs><path fill="url(#onboarding-openclaw-gradient)" d="M60 10C30 10 15 35 15 55c0 20 15 40 30 45v10h10v-10s5 2 10 0v10h10v-10c15-5 30-25 30-45 0-20-15-45-45-45Z" /><path fill="url(#onboarding-openclaw-gradient)" d="M20 45C5 40 0 50 5 60c5 10 15 5 20-5 3-7 0-10-5-10Zm80 0c15-5 20 5 15 15-5 10-15 5-20-5-3-7 0-10 5-10Z" /><path d="M45 15Q35 5 30 8m45 7Q85 5 90 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round" /><circle cx="45" cy="35" r="6" fill="#050810" /><circle cx="75" cy="35" r="6" fill="#050810" /><circle cx="46" cy="34" r="2.5" fill="#00e5cc" /><circle cx="76" cy="34" r="2.5" fill="#00e5cc" /></svg>;
  if (name === "chatgpt") return <svg aria-hidden="true" viewBox="0 0 24 24" className={className}><path fill="currentColor" d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 0 0-.856 0l-5.97 3.473Zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 0 1 .476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163ZM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898ZM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128Zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472Zm-5.637-5.303-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 0 1 4.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 0 1-.476 0Zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523Zm5.899 2.83a5.947 5.947 0 0 0 5.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0 0 10.205 0a5.947 5.947 0 0 0-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19.999-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 0 0 4.162 1.713Z" /></svg>;
  if (name === "code") return <svg aria-hidden="true" viewBox="0 0 24 24" className={className}><path fill="#007ACC" d="m17.6 2.7-6.4 5.1-3.4-2-2.2 1.3 3.5 3-3.5 3 2.2 1.3 3.4-2 6.4 5.1 3.4-1.7V4.4l-3.4-1.7Zm-.4 5v8.6l-4.1-3.2 2.7-2.2-2.7-2.2 4.1-3.2Z"/></svg>;
  return null;
}

function OnboardingFeatureIllustration({ kind }: { kind: "karma" | "reputation" | "access" }) {
  const svgClass = "h-7 w-7";
  if (kind === "karma") return (
    <svg aria-hidden viewBox="0 0 32 32" className={svgClass} fill="none">
      <circle cx="16" cy="16" r="11" fill="currentColor" opacity=".15" />
      <path d="m16 6 1.8 4 4.2.5-3 2.9.8 4.1-3.8-2-3.8 2 .8-4.1-3-2.9 4.2-.5L16 6Z" fill="currentColor" opacity=".95" />
      <circle cx="16" cy="16" r="3.5" fill="white" opacity=".9" />
    </svg>
  );
  if (kind === "reputation") return (
    <svg aria-hidden viewBox="0 0 32 32" className={svgClass} fill="none">
      <path d="m16 4 2.3 5 5.4.6-4 3.7 1.1 5.3-4.8-2.7-4.8 2.7 1.1-5.3-4-3.7 5.4-.6L16 4Z" fill="currentColor" opacity=".95" />
      <path d="M11 19.5 9 28l7-3 7 3-2-8.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m14.1 12 1.3 1.3 2.7-2.9" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  return (
    <svg aria-hidden viewBox="0 0 32 32" className={svgClass} fill="none">
      <path d="M6 9.5c0-1.7 1.3-3 3-3h14c1.7 0 3 1.3 3 3v13c0 1.7-1.3 3-3 3H9c-1.7 0-3-1.3-3-3v-13Z" fill="currentColor" opacity=".95" />
      <path d="M10 11.5h7M10 15h5" stroke="white" strokeWidth="1.8" strokeLinecap="round" opacity=".85" />
      <path d="m21.2 12 .9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z" fill="white" />
      <path d="m24.7 5 .55 1.25L26.5 6.8l-1.25.55-.55 1.25-.55-1.25-1.25-.55 1.25-.55L24.7 5Z" fill="currentColor" />
    </svg>
  );
}

let gsiInitialized = false;

function GoogleSignInButton() {
  const { applyAuthedSession, pushToast } = useDemo();
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const signingInRef = useRef(false);

  const applyRef = useRef(applyAuthedSession);
  useEffect(() => {
    applyRef.current = applyAuthedSession;
  }, [applyAuthedSession]);

  const toastRef = useRef(pushToast);
  useEffect(() => {
    toastRef.current = pushToast;
  }, [pushToast]);

  useEffect(() => {
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!clientId) {
      // One-time config validation on mount, not derived render state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("Google sign-in is not configured (missing client ID).");
      return;
    }

    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 50;
    const tryInit = () => {
      if (cancelled) return;
      if (!window.google || !containerRef.current) {
        if (++attempts >= MAX_ATTEMPTS) {
          setError("Couldn't load Google sign-in. Check your connection or disable blockers, then retry.");
          return;
        }
        setTimeout(tryInit, 100);
        return;
      }
      if (!gsiInitialized) {
        gsiInitialized = true;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: async (resp) => {
            if (signingInRef.current) return;
            signingInRef.current = true;
            setError(null);
            setSigningIn(true);
            try {
              const r = await fetch(`${API_URL}/v1/auth/google`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ idToken: resp.credential }),
              });
              if (!r.ok) {
                const body = await r.json().catch(() => ({}));
                const message = safeMessage(body.message, "Google sign-in failed.");
                setError(message);
                toastRef.current({ variant: "error", title: "Google sign-in failed", body: message });
                return;
              }

              const session = await fetch(`${API_URL}${API.auth.me}`, {
                credentials: "include",
              });
              if (!session.ok) {
                const message =
                  "Google verified your account, but this browser did not keep the session. Please allow cookies and try again.";
                setError(message);
                toastRef.current({ variant: "error", title: "Session not saved", body: message });
                return;
              }
              const data = await session.json();
              applyRef.current("google", data.user);
              toastRef.current({ variant: "success", title: "Signed in" });
            } catch {
              const message = "Couldn't reach the sign-in server. Is the API running?";
              setError(message);
              toastRef.current({ variant: "error", title: "Sign-in failed", body: message });
            } finally {
              signingInRef.current = false;
              setSigningIn(false);
            }
          },
        });
      }
      const buttonWidth = Math.min(400, Math.floor(containerRef.current.clientWidth || 320));
      window.google.accounts.id.renderButton(containerRef.current, {
        type: "standard",
        theme: "outline",
        size: "large",
        width: String(buttonWidth),
        text: "continue_with",
      });
    };
    tryInit();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <Script src="https://accounts.google.com/gsi/client" strategy="lazyOnload" />
      <div ref={containerRef} className="w-full" />
      {signingIn && <p className="mt-1.5 text-center text-[12px] text-ink-soft">Signing in securely…</p>}
      {error && <p className="mt-1.5 text-center text-[12px] text-red-600">{error}</p>}
    </div>
  );
}

export function SignInCard() {
  const { signInWithEmail, signUpWithEmail, pushToast } = useDemo();
  const [mode, setMode] = useState<"choose" | "email">("choose");
  const [emailMode, setEmailMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validEmail = email.includes("@");
  const canSubmit =
    validEmail && password.length >= 8 && (emailMode === "signin" || displayName.trim().length > 0);

  const handleEmailSubmit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (emailMode === "signup") {
        await signUpWithEmail(email, password, displayName.trim());
        pushToast({ variant: "success", title: "Account created" });
      } else {
        await signInWithEmail(email, password);
        pushToast({ variant: "success", title: "Signed in" });
      }
    } catch (err) {
      let message = err instanceof Error ? err.message : "Something went wrong. Please try again.";
      if (emailMode === "signin" && message === "Invalid email or password") {
        message += " If you signed up with Google, use 'Continue with Google' instead.";
      }
      setError(message);
      pushToast({ variant: "error", title: emailMode === "signup" ? "Couldn't create account" : "Sign-in failed", body: message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center overflow-y-auto bg-paper px-4 py-10">
      <div className="card w-[calc(100vw-2rem)] max-w-sm px-5 py-9 sm:px-8">
        <div className="flex flex-col items-center text-center">
          <Brandmark size={38} />
          <h1 className="mt-4 font-mono text-lg font-bold">Sign in to DataBounty</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            Earn <strong className="font-semibold text-ink">karma</strong> just by contributing
            dataset items. More karma, more perks — and your agent can contribute over MCP.
          </p>
        </div>

        {mode === "choose" && (
          <p className="mt-3 text-center text-[12px] leading-snug text-ink-faint">
            Karma is reputation, not cash ·{" "}
            <a
              href={`${LANDING_URL}/agents/`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded font-medium text-lime-ink underline decoration-lime-ink/40 underline-offset-2 hover:decoration-lime-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              MCP setup →
            </a>
          </p>
        )}

        {mode === "choose" && (
          <div className="mt-4 space-y-2.5">
            <GoogleSignInButton />
            <button
              onClick={() => {
                setMode("email");
                setError(null);
              }}
              className="flex w-full cursor-pointer items-center justify-center gap-2.5 rounded-lg border border-line-strong bg-white px-4 py-2.5 text-sm font-medium transition-colors hover:border-ink hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              <Icon name="mail" size={16} /> Continue with email
            </button>
          </div>
        )}

        {mode === "email" && (
          <div className="mt-7 space-y-3">
            <div className="flex rounded-lg border border-line-strong bg-panel p-1">
              {(["signin", "signup"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setEmailMode(m);
                    setError(null);
                  }}
                  className={`flex-1 cursor-pointer rounded-md py-1.5 font-mono text-[12px] font-medium transition-colors ${
                    emailMode === m ? "bg-white text-ink shadow-sm" : "text-ink-soft"
                  }`}
                >
                  {m === "signin" ? "sign in" : "create account"}
                </button>
              ))}
            </div>

            {emailMode === "signup" && (
              <label className="block">
                <span className="micro-label mb-1.5 block text-ink-faint">name</span>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Ada Lovelace"
                  autoComplete="name"
                  className="w-full rounded-lg border border-line-strong bg-white px-3 py-2.5 text-sm outline-none focus:border-ink focus:ring-1 focus:ring-ink"
                />
              </label>
            )}
            <label className="block">
              <span className="micro-label mb-1.5 block text-ink-faint">email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoFocus
                autoComplete="username"
                className="w-full rounded-lg border border-line-strong bg-white px-3 py-2.5 text-sm outline-none focus:border-ink focus:ring-1 focus:ring-ink"
              />
            </label>
            <label className="block">
              <span className="micro-label mb-1.5 block text-ink-faint">password</span>
              <PasswordInput
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleEmailSubmit()}
                placeholder={emailMode === "signup" ? "at least 8 characters" : "••••••••"}
                minLength={8}
                autoComplete={emailMode === "signup" ? "new-password" : "current-password"}
                className="w-full rounded-lg border border-line-strong bg-white px-3 py-2.5 text-sm outline-none focus:border-ink focus:ring-1 focus:ring-ink"
              />
            </label>
            <button
              onClick={handleEmailSubmit}
              disabled={!canSubmit || submitting}
              className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2.5 font-mono text-[13px] font-medium text-lime transition-colors hover:bg-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-70"
            >
              {submitting
                ? emailMode === "signup"
                  ? "creating account…"
                  : "signing in…"
                : emailMode === "signup"
                  ? "create account"
                  : "sign in"}
            </button>
            {error && <p className="text-center text-[12px] text-red-600">{error}</p>}
            {emailMode === "signin" && (
              <a
                href="/forgot-password"
                className="block text-center font-mono text-[12px] text-ink-soft hover:text-ink"
              >
                forgot password?
              </a>
            )}
            <button
              onClick={() => {
                setMode("choose");
                setError(null);
              }}
              className="w-full cursor-pointer py-1 font-mono text-[12px] text-ink-soft hover:text-ink"
            >
              ← other options
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const PERSONA_OPTIONS: {
  key: NonNullable<Persona>;
  label: string;
  tagline: string;
  body: string;
  icon: IconName;
}[] = [
  {
    key: "sponsor",
    label: "Sponsor",
    tagline: "I need datasets",
    body: "Create community requests and receive verified datasets.",
    icon: "database",
  },
  {
    key: "contributor",
    label: "Contributor",
    tagline: "I build datasets",
    body: "Claim task batches and earn karma for accepted work.",
    icon: "code",
  },
  {
    key: "validator",
    label: "Validator",
    tagline: "I review work",
    body: "Audit submitted items and earn issue bonuses.",
    icon: "shield",
  },
];

const ONBOARDING_DRAFT_STORAGE_KEY = "databounty:onboarding-draft:v2";

type OnboardingDraft = {
  persona: Persona;
  step: number;
};

function readOnboardingDraft(): OnboardingDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ONBOARDING_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as Partial<OnboardingDraft>;
    if (typeof draft.step !== "number") return null;
    const persona = draft.persona;
    return {
      persona:
        persona === "sponsor" || persona === "contributor" || persona === "validator"
          ? persona
          : null,
      step: Math.max(0, Math.floor(draft.step)),
    };
  } catch {
    return null;
  }
}

const SPONSOR_VOLUMES: { value: string; label: string }[] = [
  { value: "under_500", label: "Under 500" },
  { value: "v500_2k", label: "500–2k" },
  { value: "v2k_10k", label: "2k–10k" },
  { value: "v10k_plus", label: "10k+ items" },
];

export const CREDENTIAL_SOURCES: { id: SourceId; label: string; color: string }[] = [
  { id: "linkedin", label: "LinkedIn", color: "#0A66C2" },
  { id: "github", label: "GitHub", color: "#181717" },
  { id: "scholar", label: "Google Scholar", color: "#4285F4" },
  { id: "orcid", label: "ORCID", color: "#A6CE39" },
  { id: "kaggle", label: "Kaggle", color: "#20BEFF" },
  { id: "x", label: "X", color: "#000000" },
  { id: "website", label: "Website", color: "#64748B" },
];

export function isCredentialSourceAvailable(id: SourceId, oauthCapable: boolean) {
  // "website" used to be hardcoded always-available on the theory that a
  // self-entered URL needs no OAuth — but its connect/verify mutation
  // routes (POST /profile-sources/website/start, /verify) were never built
  // (see the API's GET /profile-sources comment: it groups "manual-entry"
  // in with the same OAuth-mutation schema gap, not as something separately
  // ready). The button 404'd on click and surfaced the raw Fastify routing
  // error to the user. Until that backend exists, treat it the same as
  // every other unbuilt source: honestly unavailable, never a live button
  // for a capability that doesn't exist server-side.
  return oauthCapable;
}

export function orderCredentialSources<T extends { id: SourceId }>(
  sourceList: readonly T[],
  oauthCapableFor: (id: SourceId) => boolean
) {
  return [...sourceList].sort(
    (a, b) =>
      Number(isCredentialSourceAvailable(b.id, oauthCapableFor(b.id))) -
      Number(isCredentialSourceAvailable(a.id, oauthCapableFor(a.id)))
  );
}

export function CredentialSourceGlyph({ id, color }: { id: SourceId; color: string }) {
  const common = { width: 15, height: 15, viewBox: "0 0 24 24", fill: color, "aria-hidden": true } as const;
  switch (id) {
    case "linkedin":
      return (
        <svg {...common}>
          <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14zM8.34 18.34V9.75H5.67v8.59h2.67zM7 8.57a1.55 1.55 0 1 0 0-3.1 1.55 1.55 0 0 0 0 3.1zm11.34 9.77v-4.71c0-2.52-1.35-3.69-3.15-3.69a2.72 2.72 0 0 0-2.46 1.35h-.04V9.75h-2.56v8.59h2.67v-4.25c0-1.12.21-2.2 1.6-2.2 1.37 0 1.39 1.28 1.39 2.28v4.17h2.55z" />
        </svg>
      );
    case "github":
      return (
        <svg {...common}>
          <path d="M12 1.5A10.5 10.5 0 0 0 8.68 22a.55.55 0 0 0 .74-.53v-2c-3 .58-3.64-1.24-3.64-1.24a2.86 2.86 0 0 0-1.2-1.58c-.98-.67.08-.66.08-.66a2.27 2.27 0 0 1 1.65 1.11 2.3 2.3 0 0 0 3.14.9 2.3 2.3 0 0 1 .68-1.44c-2.4-.27-4.92-1.2-4.92-5.34a4.18 4.18 0 0 1 1.11-2.9 3.88 3.88 0 0 1 .11-2.86s.9-.29 2.96 1.1a10.2 10.2 0 0 1 5.38 0c2.05-1.39 2.96-1.1 2.96-1.1a3.88 3.88 0 0 1 .1 2.86 4.17 4.17 0 0 1 1.12 2.9c0 4.15-2.53 5.06-4.94 5.33a2.58 2.58 0 0 1 .73 2v2.96a.55.55 0 0 0 .75.53A10.5 10.5 0 0 0 12 1.5z" />
        </svg>
      );
    case "scholar":
      return (
        <svg {...common}>
          <path d="M12 3 1 9l11 6 9-4.91V17h2V9L12 3z" />
          <path d="M5 13.18v3.32L12 20l7-3.5v-3.32L12 17l-7-3.82z" opacity=".55" />
        </svg>
      );
    case "orcid":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="11" />
          <path
            fill="#fff"
            d="M8.2 7.6a1 1 0 1 1-2 0 1 1 0 0 1 2 0zM7 9.4h1.4v7.2H7V9.4zm3.1 0h3.3c3.1 0 4.5 2.2 4.5 3.6 0 1.5-1.2 3.6-4.5 3.6h-3.3V9.4zm1.4 1.3v4.6h1.8c2.5 0 3.1-1.9 3.1-2.3 0-.7-.4-2.3-3.1-2.3h-1.8z"
          />
        </svg>
      );
    case "kaggle":
      return (
        <svg {...common}>
          <path d="M16.5 21 10 14.2l6.2-6.2a.4.4 0 0 0-.3-.7h-2.5a.7.7 0 0 0-.5.2L7.6 13V3.4a.4.4 0 0 0-.4-.4H5.4a.4.4 0 0 0-.4.4v17.2c0 .2.2.4.4.4h1.8a.4.4 0 0 0 .4-.4v-4l1.2-1.2 4.4 5.4c.1.2.3.2.5.2h2.4c.3 0 .5-.4.4-.6z" />
        </svg>
      );
    case "x":
      return (
        <svg {...common}>
          <path d="M18.24 2.25h3.3l-7.2 8.24L23 21.75h-6.63l-5.2-6.8-5.94 6.8H1.9l7.7-8.8L1.24 2.25h6.8l4.7 6.22 5.5-6.22zm-1.16 17.5h1.83L7.02 4.13H5.06l12.02 15.62z" />
        </svg>
      );
    case "website":
    default:
      return (
        <svg
          width={15}
          height={15}
          viewBox="0 0 24 24"
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z" />
        </svg>
      );
  }
}

function Chip({
  on,
  onClick,
  children,
  disabled,
  title,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-full border px-3 py-1.5 font-mono text-[11.5px] transition-colors ${
        disabled
          ? "cursor-not-allowed border-line text-ink-faint opacity-60"
          : "cursor-pointer"
      } ${
        on
          ? "border-ink bg-ink text-lime"
          : disabled
          ? ""
          : "border-line text-ink-soft hover:border-slate-300 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function toggle<K extends string>(set: Record<K, boolean>, key: K): Record<K, boolean> {
  return { ...set, [key]: !set[key] };
}

type Taxonomy = ReturnType<typeof useDemo>["taxonomy"];

interface SponsorScopeFieldsState {
  domainSel: Record<string, boolean>;
  setDomainSel: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  typeSel: Record<string, boolean>;
  setTypeSel: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  langSel: Record<string, boolean>;
  setLangSel: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  volume: string | null;
  setVolume: React.Dispatch<React.SetStateAction<string | null>>;
  note: string;
  setNote: (note: string) => void;
}

function SponsorScopeFields({
  taxonomy,
  taxonomyStatus,
  loadTaxonomy,
  state,
}: {
  taxonomy: Taxonomy;
  taxonomyStatus: "loading" | "error" | "ready";
  loadTaxonomy: () => void;
  state: SponsorScopeFieldsState;
}) {
  const { domainSel, setDomainSel, typeSel, setTypeSel, langSel, setLangSel, volume, setVolume, note, setNote } =
    state;

  const selectedDomains = Object.keys(domainSel).filter((k) => domainSel[k]);
  const typeOptions = taxonomy.datasetTypes.filter(
    (t) => t.status === "active" && (selectedDomains.length === 0 || selectedDomains.includes(t.domain))
  );

  if (taxonomyStatus !== "ready") {
    return (
      <div className="mt-5">
        <AsyncState
          status={taxonomyStatus}
          icon="database"
          loadingText="Loading dataset catalog…"
          errorTitle="Couldn't load the dataset catalog"
          errorDescription="Check your connection and try again."
          emptyAction={
            <button
              onClick={loadTaxonomy}
              className="cursor-pointer font-mono text-[12px] font-bold text-ink underline"
            >
              Retry
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="mt-5 space-y-4">
      <div>
        <span className="micro-label mb-2 block text-ink-faint">domain</span>
        <div className="flex flex-wrap gap-1.5">
          {taxonomy.domains.map((d) => (
            <Chip
              key={d.id}
              on={!!domainSel[d.id]}
              disabled={d.status !== "live"}
              title={d.status !== "live" ? `${d.name} — coming soon` : undefined}
              onClick={() => {
                if (d.status !== "live") return;
                const nextDomainSel = toggle(domainSel, d.id);
                const nextSelectedDomains = Object.keys(nextDomainSel).filter((k) => (nextDomainSel as Record<string, boolean>)[k]);
                setDomainSel(nextDomainSel);
                if (nextSelectedDomains.length) {
                  setTypeSel((s) => {
                    const next = { ...s };
                    for (const t of taxonomy.datasetTypes) {
                      if (next[t.id] && !nextSelectedDomains.includes(t.domain)) delete next[t.id];
                    }
                    return next;
                  });
                }
              }}
            >
              {d.name}
              {d.status !== "live" ? " · soon" : ""}
            </Chip>
          ))}
        </div>
      </div>

      <div>
        <span className="micro-label mb-2 block text-ink-faint">dataset type</span>
        <div className="flex flex-wrap gap-1.5">
          {typeOptions.length === 0 && (
            <span className="text-[12.5px] text-ink-faint">Loading catalog…</span>
          )}
          {typeOptions.map((t) => (
            <Chip key={t.id} on={!!typeSel[t.id]} onClick={() => setTypeSel((s) => toggle(s, t.id))}>
              {t.name}
            </Chip>
          ))}
        </div>
      </div>

      <div>
        <span className="micro-label mb-2 block text-ink-faint">primary languages</span>
        <div className="flex flex-wrap gap-1.5">
          {taxonomy.languages.map((l) => (
            <Chip key={l} on={!!langSel[l]} onClick={() => setLangSel((s) => toggle(s, l))}>
              {l}
            </Chip>
          ))}
        </div>
      </div>

      <div>
        <span className="micro-label mb-2 block text-ink-faint">rough volume</span>
        <div className="flex flex-wrap gap-1.5">
          {SPONSOR_VOLUMES.map((v) => (
            <Chip
              key={v.value}
              on={volume === v.value}
              onClick={() => setVolume((cur) => (cur === v.value ? null : v.value))}
            >
              {v.label}
            </Chip>
          ))}
        </div>
      </div>

      <label className="block">
        <span className="micro-label mb-1.5 block text-ink-faint">anything specific?</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="e.g. React + TypeScript bug fixes with passing tests, edge-case heavy…"
          className="w-full resize-none rounded-lg border border-line bg-white px-3 py-2.5 text-sm outline-none focus:border-ink"
        />
      </label>
    </div>
  );
}

function buildSponsorScope(
  taxonomy: Taxonomy,
  state: SponsorScopeFieldsState
): SponsorScope {
  const selectedDomains = Object.keys(state.domainSel).filter((k) => (state.domainSel as Record<string, boolean>)[k]) as DomainId[];
  const pickedTypeIds = Object.keys(state.typeSel).filter((k) => state.typeSel[k]);
  return {
    domains: selectedDomains,
    datasetTypeIds: pickedTypeIds,
    categories: Array.from(
      new Set(
        taxonomy.datasetTypes
          .filter((t) => pickedTypeIds.includes(t.id))
          .map((t) => t.category)
      )
    ) as DatasetCategory[],
    languages: Object.keys(state.langSel).filter((k) => state.langSel[k]),
    volume: state.volume,
    uses: ["training"],
    note: state.note.trim(),
  };
}

export function SponsorScopeModal({
  open,
  initialScope,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  initialScope: SponsorScope | null;
  onCancel: () => void;
  onSubmit: (scope: SponsorScope) => Promise<void>;
}) {
  const { taxonomy, refreshTaxonomy } = useDemo();
  const [taxonomyLoaded, setTaxonomyLoaded] = useState(false);
  const loadTaxonomy = useMemo(
    () => () => {
      setTaxonomyLoaded(false);
      void refreshTaxonomy().finally(() => setTaxonomyLoaded(true));
    },
    [refreshTaxonomy]
  );
  const taxonomyStatus: "loading" | "error" | "ready" = !taxonomyLoaded
    ? "loading"
    : taxonomy.domains.length === 0 && taxonomy.datasetTypes.length === 0
    ? "error"
    : "ready";

  const toRecord = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, true]));
  const [domainSel, setDomainSel] = useState<Record<string, boolean>>({});
  const [typeSel, setTypeSel] = useState<Record<string, boolean>>({});
  const [langSel, setLangSel] = useState<Record<string, boolean>>({});
  const [volume, setVolume] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Re-fetch the catalog and re-seed from the current saved scope every time
  // the modal (re)opens — not just on mount, since this component stays
  // mounted (hidden) between opens. One-shot reset driven by the `open`
  // transition, not a React-state sync, so the lint rule against
  // setState-in-effect doesn't apply cleanly here.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadTaxonomy();
    setDomainSel(toRecord(initialScope?.domains ?? []));
    setTypeSel(toRecord(initialScope?.datasetTypeIds ?? []));
    setLangSel(toRecord(initialScope?.languages ?? []));
    setVolume(initialScope?.volume ?? null);
    setNote(initialScope?.note ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialScope]);

  const state: SponsorScopeFieldsState = {
    domainSel,
    setDomainSel,
    typeSel,
    setTypeSel,
    langSel,
    setLangSel,
    volume,
    setVolume,
    note,
    setNote,
  };

  const handleSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(buildSponsorScope(taxonomy, state));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onCancel}
      panelClassName="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-[14px] border border-line bg-white shadow-xl"
    >
      <header className="shrink-0 border-b border-line-soft bg-white px-7 py-5">
        <div className="flex items-center gap-2.5">
          <Brandmark size={30} />
          <span className="font-mono text-[13px] font-bold">Scope your dataset</span>
        </div>
        <h2 className="mt-3 font-mono text-lg font-bold tracking-tight">
          What datasets are you looking for?
        </h2>
        <p className="mt-1 text-[13px] text-ink-soft">
          This helps us pre-fill your request and match the right contributors.
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
        <SponsorScopeFields taxonomy={taxonomy} taxonomyStatus={taxonomyStatus} loadTaxonomy={loadTaxonomy} state={state} />
      </div>

      <footer className="flex shrink-0 items-center justify-between border-t border-line-soft bg-white px-7 py-4">
        <button
          onClick={onCancel}
          disabled={submitting}
          className="cursor-pointer font-mono text-[12px] text-ink-soft hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
        >
          cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={submitting || taxonomyStatus !== "ready"}
          className="cursor-pointer rounded-lg bg-ink px-5 py-2.5 font-mono text-[13px] font-medium text-lime transition-colors hover:bg-black disabled:cursor-not-allowed disabled:opacity-45"
        >
          save &amp; enable
        </button>
      </footer>
    </Modal>
  );
}

export function OnboardingFlow({
  onDone,
  embedded = false,
  modal = false,
}: {
  onDone?: (destination?: string) => void;
  embedded?: boolean;
  modal?: boolean;
}) {
  const { completeOnboarding, sources, connectSource, taxonomy, refreshTaxonomy, onboarded } = useDemo();

  const [taxonomyLoaded, setTaxonomyLoaded] = useState(false);
  const loadTaxonomy = useMemo(
    () => () => {
      setTaxonomyLoaded(false);
      void refreshTaxonomy().finally(() => setTaxonomyLoaded(true));
    },
    [refreshTaxonomy]
  );
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadTaxonomy();
  }, [loadTaxonomy]);
  const taxonomyStatus: "loading" | "error" | "ready" = !taxonomyLoaded
    ? "loading"
    : taxonomy.domains.length === 0 && taxonomy.datasetTypes.length === 0
    ? "error"
    : "ready";

  const [draft] = useState<OnboardingDraft | null>(() => (onboarded ? null : readOnboardingDraft()));
  const [chosenPersona, setChosenPersona] = useState<Persona>(() => draft?.persona ?? null);

  const pickPersona = (choice: NonNullable<Persona>) => {
    setChosenPersona((current) => (current === choice ? null : choice));
  };

  const [domainSel, setDomainSel] = useState<Record<string, boolean>>({});
  const [typeSel, setTypeSel] = useState<Record<string, boolean>>({});
  const [langSel, setLangSel] = useState<Record<string, boolean>>({});
  const [volume, setVolume] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const sponsorScopeState: SponsorScopeFieldsState = {
    domainSel,
    setDomainSel,
    typeSel,
    setTypeSel,
    langSel,
    setLangSel,
    volume,
    setVolume,
    note,
    setNote,
  };

  const screens = useMemo<("intents" | "handle" | "sponsor" | "pitch" | "done" | "community" | "mcp")[]>(() => {
    return ["handle", "community", "mcp"];
  }, []);

  const [idx, setIdx] = useState(() => draft?.step ?? 0);
  const safeIdx = Math.min(idx, screens.length - 1);
  const current = screens[safeIdx];
  const total = screens.length;
  const contentRef = useRef<HTMLDivElement>(null);
  const [measuredGateReady, setScrollGateReady] = useState(!modal);
  const [measuredRequiresScroll, setRequiresScroll] = useState(false);
  const scrollGateReady = modal ? measuredGateReady : true;
  const requiresScroll = modal ? measuredRequiresScroll : false;

  useEffect(() => {
    if (!modal) return;
    const element = contentRef.current;
    if (!element) return;
    const updateGate = () => {
      const needsScroll = element.scrollHeight > element.clientHeight + 1;
      setRequiresScroll(needsScroll);
      setScrollGateReady(!needsScroll || element.scrollTop + element.clientHeight >= element.scrollHeight - 4);
    };
    const frame = requestAnimationFrame(updateGate);
    element.addEventListener("scroll", updateGate, { passive: true });
    const observer = new ResizeObserver(updateGate);
    observer.observe(element);
    const contentObserver = new MutationObserver(updateGate);
    contentObserver.observe(element, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("scroll", updateGate);
      observer.disconnect();
      contentObserver.disconnect();
    };
  }, [current, modal]);

  useEffect(() => {
    if (onboarded || typeof window === "undefined") return;
    window.localStorage.setItem(
      ONBOARDING_DRAFT_STORAGE_KEY,
      JSON.stringify({ persona: chosenPersona, step: safeIdx } satisfies OnboardingDraft)
    );
  }, [onboarded, chosenPersona, safeIdx]);

  const clearDraft = () => {
    if (typeof window !== "undefined") window.localStorage.removeItem(ONBOARDING_DRAFT_STORAGE_KEY);
  };

  const [submitting, setSubmitting] = useState(false);
  const [persistError, setPersistError] = useState<string | null>(null);
  const [handleInput, setHandleInput] = useState("");
  const [handleError, setHandleError] = useState<string | null>(null);
  const [handleCheckNonce, setHandleCheckNonce] = useState(0);
  const [changingClaimedHandle, setChangingClaimedHandle] = useState(false);
  const [changeHandleConfirmOpen, setChangeHandleConfirmOpen] = useState(false);
  const [ownedHandle, setOwnedHandle] = useState<string | null>(null);
  // Gates the auto-suggest effect and the claim button below. Without this,
  // "does this user already have a handle" and "suggest a random one" were
  // two independent mount-time fetches racing on the same `ownedHandle ===
  // null` initial state — under load the suggestion could resolve first and
  // briefly render as an ENABLED "claim" for a random handle, on the
  // deliberately re-visitable /onboarding route, for a user who already owns
  // one. It self-corrected once the real fetch landed, but a click inside
  // that window would have submitted a real, unintended handle change.
  const [handleCheckReady, setHandleCheckReady] = useState(false);
  const [handleAvailability, setHandleAvailability] = useState<{
    handle: string;
    status: "checking" | "available" | "unavailable" | "invalid" | "unknown";
    claimed?: boolean;
    reason?: string;
    suggestions?: string[];
  } | null>(null);
  const handleIsCurrentOwned = ownedHandle === handleInput.trim();
  const handleCanContinue =
    handleIsCurrentOwned ||
    (handleCheckReady &&
      handleAvailability?.status === "available" &&
      handleAvailability.handle === handleInput.trim());
  const handleAlreadyClaimed = handleIsCurrentOwned || (handleCanContinue && handleAvailability?.claimed === true);
  const handlePrefilledRef = useRef(false);
  const suggestionAppliedRef = useRef<string | null>(null);
  const claimedHandleRef = useRef<string | null>(null);
  const handleInputRef = useRef<HTMLInputElement>(null);

  const applyHandleSuggestion = (suggestion: string) => {
    suggestionAppliedRef.current = suggestion;
    handlePrefilledRef.current = true;
    setHandleInput(suggestion);
  };

  const [generatingHandle, setGeneratingHandle] = useState(false);
  const suggestAvailableHandle = async () => {
    setGeneratingHandle(true);
    setHandleError(null);
    try {
      const res = await fetch(`${API_URL}${API.me.publicProfileHandleSuggestions(1)}`, { credentials: "include" });
      const body = res.ok ? (await res.json().catch(() => ({}))) as { suggestions?: string[] } : {};
      const candidate = body.suggestions?.[0];
      if (candidate) applyHandleSuggestion(candidate);
      else setHandleError("Couldn't find an available name right now — try again.");
    } finally {
      setGeneratingHandle(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void fetch(`${API_URL}${API.me.publicProfile}`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { handle?: string | null } | null) => {
        if (cancelled || !body?.handle) return;
        claimedHandleRef.current = body.handle;
        setOwnedHandle(body.handle);
        setHandleInput(body.handle);
        setHandleError(null);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setHandleCheckReady(true);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!handleCheckReady || handlePrefilledRef.current || handleInput || ownedHandle) return;
    void suggestAvailableHandle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleCheckReady, ownedHandle]);

  useEffect(() => {
    // Debounced-search pattern: resetting/kicking off an availability check as
    // the input changes, not a value derived purely from props/state.
    const candidate = handleInput.trim();
    if (!candidate) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHandleAvailability(null);
      return;
    }
    if (candidate.length < 3) {
      setHandleAvailability({ handle: candidate, status: "invalid", reason: "Handle must be at least 3 characters." });
      return;
    }
    if (suggestionAppliedRef.current === candidate) {
      setHandleAvailability({ handle: candidate, status: "available" });
      return;
    }
    const controller = new AbortController();
    setHandleAvailability({ handle: candidate, status: "checking" });
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${API_URL}${API.me.publicProfileHandleAvailability(candidate)}`, {
          credentials: "include",
          signal: controller.signal,
        });
        const body = await readHandleAvailability(res);
        if (!res.ok) {
          setHandleAvailability({ handle: candidate, status: "unknown" });
          return;
        }
        setHandleAvailability({
          handle: candidate,
          status: body.available ? "available" : "unavailable",
          claimed: body.claimed,
          reason: body.reason,
          suggestions: body.suggestions,
        });
        if (body.claimed) {
          claimedHandleRef.current = candidate;
          setOwnedHandle(candidate);
        }
      } catch (error) {
        if ((error as DOMException).name !== "AbortError") {
          setHandleAvailability({ handle: candidate, status: "unknown" });
        }
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [handleInput, handleCheckNonce]);

  const retryHandleAvailability = () => {
    suggestionAppliedRef.current = null;
    setHandleCheckNonce((n) => n + 1);
  };

  const claimHandle = async (): Promise<boolean> => {
    const requestedHandle = handleInput.trim();
    try {
      const response = await fetch(`${API_URL}${API.me.publicProfileHandle}`, {
        method: changingClaimedHandle ? "PUT" : "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: requestedHandle }),
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string; handle?: string };
      if (!response.ok) {
        const profile = (await fetch(`${API_URL}${API.me.publicProfile}`, { credentials: "include" })
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null)) as { handle?: string | null } | null;
        if (profile?.handle === requestedHandle) {
          claimedHandleRef.current = requestedHandle;
          setOwnedHandle(requestedHandle);
          setHandleError(null);
          return true;
        }
        if (!changingClaimedHandle && body.message === "Your handle has already been claimed.") {
          setChangeHandleConfirmOpen(true);
          return false;
        }
        // Only a genuine collision says anything about the handle itself.
        // A 403 (unverified email), 429 (rate limit) or 5xx means the name is
        // still free and the caller simply is not allowed to take it yet —
        // relabelling it "unavailable" would both misinform and print the
        // server's message twice, since the availability reason and
        // handleError render in separate places.
        if (response.status === 409) {
          setHandleAvailability({ handle: requestedHandle, status: "unavailable", reason: safeMessage(body.message, "That handle isn't available.") });
        }
        setHandleError(safeMessage(body.message, "Could not claim that handle."));
        return false;
      }
      if (body.handle) setOwnedHandle(body.handle);
      return true;
    } catch {
      setHandleError("Could not reach the server to claim that handle.");
      return false;
    }
  };

  const claimAndContinue = async () => {
    if (submitting || !handleCanContinue) return;
    setSubmitting(true);
    setHandleError(null);
    const claimed = await claimHandle();
    setSubmitting(false);
    if (claimed) {
      claimedHandleRef.current = handleInput.trim();
      setChangingClaimedHandle(false);
      goNext();
    }
  };

  const startHandleChange = () => {
    setChangingClaimedHandle(true);
    setOwnedHandle(null);
    setHandleInput("");
    setHandleAvailability(null);
    setHandleError(null);
    suggestionAppliedRef.current = null;
  };

  const cancelHandleChange = () => {
    const owned = claimedHandleRef.current;
    setChangingClaimedHandle(false);
    setHandleError(null);
    if (!owned) return;
    setOwnedHandle(owned);
    setHandleInput(owned);
    setHandleAvailability({ handle: owned, status: "available", claimed: true });
  };

  const editHandle = () => {
    if (handleAlreadyClaimed && !changingClaimedHandle) {
      setChangeHandleConfirmOpen(true);
      return;
    }
    handleInputRef.current?.focus();
    handleInputRef.current?.select();
  };

  const finish = async (destination?: string) => {
    if (submitting) return;
    setSubmitting(true);
    setPersistError(null);
    setHandleError(null);
    if (handleInput.trim() && ownedHandle !== handleInput.trim()) {
      const claimed = await claimHandle();
      if (!claimed) {
        setIdx(screens.indexOf("handle"));
        setSubmitting(false);
        return;
      }
    }
    const persisted = await completeOnboarding(chosenPersona);
    setSubmitting(false);
    if (!persisted) {
      setPersistError("Couldn't finish setting up your account. Please try again.");
      return;
    }
    clearDraft();
    onDone?.(destination);
  };

  const skip = async () => {
    if (submitting) return;
    setSubmitting(true);
    setPersistError(null);
    const persisted = await completeOnboarding(null);
    setSubmitting(false);
    if (!persisted) {
      setPersistError("Couldn't finish setting up your account. Please try again.");
      return;
    }
    clearDraft();
    onDone?.();
  };

  const scrollContentToBottom = () => {
    const element = contentRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };

  const goBack = () => setIdx((i) => Math.max(0, i - 1));
  const goNext = () => setIdx((i) => Math.min(screens.length - 1, i + 1));

  const stepLabel = `step ${safeIdx + 1} of ${total}`;

  return (
    <div
      className={
        modal
          ? "flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-[14px] border border-line bg-white shadow-xl"
          : embedded
            ? ""
            : "card w-full max-w-lg p-7"
      }
    >
      <div
        className={
          modal
            ? "flex shrink-0 items-center justify-between gap-2.5 border-b border-line-soft bg-white px-7 py-5"
            : "mb-1 flex items-center justify-between gap-2.5"
        }
      >
        <div className="flex items-center gap-2.5">
          <Brandmark size={30} />
          <span className="font-mono text-[13px] font-bold">
            {current === "intents"
              ? "Welcome to DataBounty"
              : current === "sponsor"
              ? "Scope your dataset"
              : current === "pitch"
              ? "Get matched to work"
              : current === "handle"
              ? "Make your mark"
              : current === "community"
              ? "Built for meaningful work"
              : current === "mcp"
              ? "Bring your AI"
              : "Welcome to DataBounty"}
          </span>
        </div>
        <span className="font-mono text-[11px] text-ink-faint">{stepLabel}</span>
      </div>

      <div className={modal ? "relative flex min-h-0 flex-1 flex-col" : ""}>
        <div ref={contentRef} className={modal ? "min-h-0 flex-1 overflow-y-auto px-7 py-5" : ""}>

        {current === "intents" && (
          <>
            <h2 className="mt-3 font-mono text-lg font-bold tracking-tight">
              What brings you here?
            </h2>
            <p className="mt-1 text-[13px] text-ink-soft">
              This only picks the dashboard you land on — you can do all three
              whatever you choose, and change it anytime in Profile &amp; settings.
            </p>
            <div className="mt-5 space-y-2.5" role="radiogroup" aria-label="What brings you here">
              {PERSONA_OPTIONS.map((it) => {
                const on = chosenPersona === it.key;
                return (
                  <button
                    key={it.key}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => pickPersona(it.key)}
                    className={`flex w-full cursor-pointer items-center gap-3.5 rounded-xl border p-4 text-left transition-colors ${
                      on ? "border-ink bg-panel" : "border-line hover:border-slate-300"
                    }`}
                  >
                    <span
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                        on ? "bg-ink text-lime" : "bg-brand-soft text-ink-soft"
                      }`}
                    >
                      <Icon name={it.icon} size={18} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-bold">
                        {it.label} <span className="font-normal text-ink-soft">({it.tagline})</span>
                      </span>
                      <span className="block text-[12.5px] text-ink-soft">{it.body}</span>
                    </span>
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[3px] border ${
                        on ? "border-ink bg-ink text-lime" : "border-line"
                      }`}
                    >
                      {on && <Icon name="check" size={12} />}
                    </span>
                  </button>
                );
              })}
            </div>

            {persistError && (
              <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12.5px] text-amber-800">
                {persistError}
              </p>
            )}
            <div className={`${modal ? "hidden" : "mt-6 flex"} items-center justify-between`}>
              <button
                onClick={skip}
                disabled={submitting || !scrollGateReady}
                className="cursor-pointer font-mono text-[12px] text-ink-soft hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
              >
                skip for now
              </button>
              <button
                onClick={goNext}
                disabled={!scrollGateReady}
                className="cursor-pointer rounded-lg bg-ink px-5 py-2.5 font-mono text-[13px] font-medium text-lime transition-colors hover:bg-black disabled:cursor-not-allowed disabled:opacity-45"
              >
                continue →
              </button>
            </div>
          </>
        )}

        {current === "handle" && (
          <>
            <h2 className="mt-3 font-mono text-lg font-bold tracking-tight">
              Make your work recognizable.
            </h2>
            <p className="mt-1 text-[13px] text-ink-soft">
              {changingClaimedHandle
                ? "Choose the name you want attached to every contribution, review, and request."
                : "Choose the name people will remember. Build a track record you can share wherever your work matters."}
            </p>
            <div className="mt-5">
              <label htmlFor="onboarding-handle" className="block font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">Handle</label>
              <div className="mt-1.5 flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <input
                    id="onboarding-handle"
                    ref={handleInputRef}
                    value={handleInput}
                    onChange={(event) => {
                      setHandleInput(event.target.value.toLowerCase());
                      setHandleError(null);
                    }}
                    disabled={handleAlreadyClaimed && !changingClaimedHandle}
                    maxLength={20}
                    placeholder="your-handle"
                    className="w-full rounded-lg border border-ink bg-white px-3 py-2.5 pr-10 font-mono text-sm outline-none focus:ring-1 focus:ring-ink disabled:cursor-not-allowed disabled:bg-panel disabled:text-ink-soft"
                  />
                  {(handleAvailability?.status === "available" || handleAlreadyClaimed) && <Icon name="check" size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-600" />}
                </div>
                {!handleAlreadyClaimed && (
                  <button
                    type="button"
                    onClick={suggestAvailableHandle}
                    disabled={generatingHandle}
                    title="Suggest an available handle"
                    aria-label="Suggest an available handle"
                    className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-ink bg-white text-ink transition-colors hover:bg-panel disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Icon name="refresh" size={15} className={generatingHandle ? "animate-spin" : undefined} />
                  </button>
                )}
                {handleAlreadyClaimed && !changingClaimedHandle && (
                  <button
                    type="button"
                    onClick={editHandle}
                    title="Change handle"
                    aria-label="Change handle"
                    className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-ink bg-white text-ink transition-colors hover:bg-panel"
                  >
                    <Icon name="edit" size={15} />
                  </button>
                )}
              </div>
              {handleAvailability?.status === "checking" && <p className="mt-2 font-mono text-[11px] text-ink-faint">checking…</p>}
              {handleAlreadyClaimed && <p className="mt-2 font-mono text-[11px] text-emerald-600">this handle is yours</p>}
              {!handleAlreadyClaimed && handleAvailability?.status === "available" && <p className="mt-2 font-mono text-[11px] text-emerald-600">available</p>}
              {!handleAlreadyClaimed && (handleAvailability?.status === "unavailable" || handleAvailability?.status === "invalid") && (
                <p className="mt-2 font-mono text-[11px] text-rose-700">{handleAvailability.reason ?? "That handle isn't available."}</p>
              )}
              {!handleAlreadyClaimed && handleAvailability?.status === "unknown" && (
                <p className="mt-2 font-mono text-[11px] text-amber-700">
                  Couldn&apos;t check that handle right now.{" "}
                  <button type="button" onClick={retryHandleAvailability} className="cursor-pointer underline underline-offset-2 hover:text-ink">
                    retry
                  </button>
                </p>
              )}
              {!handleAlreadyClaimed && handleAvailability?.status === "unavailable" && handleAvailability.suggestions && handleAvailability.suggestions.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {handleAvailability.suggestions.map((suggestion) => (
                    <button key={suggestion} type="button" onClick={() => applyHandleSuggestion(suggestion)} className="cursor-pointer rounded border border-line px-2 py-1 font-mono text-[11px] text-ink-soft hover:border-ink hover:text-ink">
                      {suggestion}
                    </button>
                  ))}
                </div>
              )}
              <p className="mt-3 break-all rounded-lg bg-panel px-3 py-2 font-mono text-[12px] text-ink-soft">
                {LANDING_URL.replace(/^https?:\/\//, "")}/{handleInput || "yourhandle"}
              </p>
              <p className="mt-3 text-[12px] text-ink-soft">
                {changingClaimedHandle
                  ? "Your public page moves to this address. Anything you have hidden stays hidden."
                  : "Your page goes live here when you claim it, so your work builds a track record you can share. Switch it off, or hide any section, from Profile at any time."}
              </p>
              {handleError && <p role="alert" className="mt-2 font-mono text-[11px] text-rose-700">{handleError}</p>}
            </div>
            <div className={`${modal ? "hidden" : "mt-6 flex"} items-center justify-between`}>
              <div>{changingClaimedHandle && <button onClick={cancelHandleChange} className="cursor-pointer font-mono text-[12px] text-ink-soft hover:text-ink">cancel change</button>}</div>
              <button
                onClick={handleAlreadyClaimed ? goNext : claimAndContinue}
                disabled={!handleCanContinue || submitting || !scrollGateReady}
                className="cursor-pointer rounded-lg bg-ink px-5 py-2.5 font-mono text-[13px] font-medium text-lime transition-colors hover:bg-black disabled:cursor-not-allowed disabled:opacity-45"
              >
                {submitting ? "saving…" : handleAlreadyClaimed ? "continue →" : changingClaimedHandle ? "save change →" : "claim →"}
              </button>
            </div>
          </>
        )}

        {current === "sponsor" && (
          <>
            <h2 className="mt-3 font-mono text-lg font-bold tracking-tight">
              What datasets are you looking for?
            </h2>
            <p className="mt-1 text-[13px] text-ink-soft">
              This helps us pre-fill your request and match the right contributors.
            </p>

            <SponsorScopeFields
              taxonomy={taxonomy}
              taxonomyStatus={taxonomyStatus}
              loadTaxonomy={loadTaxonomy}
              state={sponsorScopeState}
            />

            <div className={`${modal ? "hidden" : "mt-6 flex"} items-center justify-between`}>
              <button onClick={goBack} className="cursor-pointer font-mono text-[12px] text-ink-soft hover:text-ink">
                ← back
              </button>
              <button
                onClick={goNext}
                disabled={taxonomyStatus !== "ready" || !scrollGateReady}
                className="cursor-pointer rounded-lg bg-ink px-5 py-2.5 font-mono text-[13px] font-medium text-lime transition-colors hover:bg-black disabled:cursor-not-allowed disabled:opacity-45"
              >
                continue →
              </button>
            </div>
          </>
        )}

        {current === "pitch" && (
          <>
            <h2 className="mt-3 font-mono text-lg font-bold tracking-tight">
              Get matched to community work.
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
              Earn karma for every accepted item and completed audit. The more
              credentials you connect, the higher your reputation score.
            </p>

            <div className="mt-4 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {orderCredentialSources(CREDENTIAL_SOURCES, (id) => !!sources[id]?.oauthCapable).map((s) => {
                const source = sources[s.id];
                const on = source?.connected;
                const verified = source?.verified;
                const available = isCredentialSourceAvailable(s.id, !!source?.oauthCapable);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => !on && available && connectSource(s.id)}
                    disabled={on || !available}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                      on
                        ? "cursor-default border-ink bg-panel"
                        : !available
                        ? "cursor-not-allowed border-line opacity-55"
                        : "cursor-pointer border-line hover:border-ink hover:bg-panel"
                    }`}
                  >
                    <CredentialSourceGlyph id={s.id} color={s.color} />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-medium">
                      {s.label}
                    </span>
                    {verified ? (
                      <Icon name="check" size={13} className="shrink-0 text-emerald-600" />
                    ) : on ? (
                      <span className="shrink-0 font-mono text-[9px] text-amber-700">added</span>
                    ) : !available ? (
                      <span className="shrink-0 font-mono text-[9px] text-ink-faint">soon</span>
                    ) : (
                      <Icon name="plus" size={13} className="shrink-0 text-ink-faint" />
                    )}
                  </button>
                );
              })}
            </div>

            <p className="mt-4 rounded-lg bg-panel px-3.5 py-2.5 text-[12.5px] text-ink-soft">
              <span className="font-semibold text-ink">Private by default</span> — only
              used to match you to relevant work. Only sources with live verification can
              be connected; manage them anytime on your{" "}
              <span className="font-semibold text-ink">Profile &amp; reputation</span> page.
            </p>

            <div className={`${modal ? "hidden" : "mt-6 flex"} items-center justify-between`}>
              <button onClick={goBack} className="cursor-pointer font-mono text-[12px] text-ink-soft hover:text-ink">
                ← back
              </button>
              <button
                onClick={goNext}
                disabled={!scrollGateReady}
                className="cursor-pointer rounded-lg bg-ink px-5 py-2.5 font-mono text-[13px] font-medium text-lime transition-colors hover:bg-black"
              >
                continue →
              </button>
            </div>
          </>
        )}

        {current === "community" && (
          <>
            <h2 className="mt-3 font-mono text-lg font-bold tracking-tight">
              Turn good work into momentum.
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
              Join community pools to earn <strong className="font-semibold text-ink">Karma</strong>, build your profile, and help publish open datasets.
            </p>

            <div className="mt-5 grid grid-cols-2 gap-3" aria-label="How DataBounty creates momentum">
              {[
                ["reputation", "Reputation", "Karma & profile", "Earn Karma and build a verified track record.", "bg-[#f3f7e8] text-accent-strong"],
                ["access", "Access", "Priority & perks", "Karma tiers unlock priority across community work.", "bg-[#f4f0fb] text-[#7653ae]"],
              ].map(([icon, eyebrow, label, detail, tone]) => (
                <div key={label} className="flex min-w-0 flex-col items-center rounded-xl border border-line bg-white px-2 py-3 text-center shadow-[0_1px_2px_rgba(15,20,12,0.04)]">
                  <span className={`flex h-11 w-11 items-center justify-center rounded-xl ${tone}`}>
                    <OnboardingFeatureIllustration kind={icon as "karma" | "reputation" | "access"} />

                  </span>
                  <span className="mt-2 font-mono text-[8.5px] font-semibold uppercase tracking-[0.12em] text-ink-faint">{eyebrow}</span>
                  <span className="mt-1.5 font-mono text-[10.5px] font-semibold text-ink">{label}</span>
                  <span className="mt-1 text-[9.5px] leading-tight text-ink-faint">{detail}</span>
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-lg border border-accent-soft-border bg-[#f7faef] px-3.5 py-3 text-[12.5px] leading-relaxed text-accent-strong-hover">
              <span className="font-semibold">Build your name with every accepted item.</span>{" "}
              <strong>Karma</strong> tiers unlock priority and perks across the platform—and your
              public profile can show the work you are proud of.
            </div>
            <div className={`${modal ? "hidden" : "mt-6 flex"} items-center justify-between`}>
              <button onClick={goBack} className="cursor-pointer font-mono text-[12px] text-ink-soft hover:text-ink">← back</button>
              <button onClick={goNext} className="cursor-pointer rounded-lg bg-ink px-5 py-2.5 font-mono text-[13px] font-medium text-lime transition-colors hover:bg-black">
                <span className="flex items-center gap-2"><Icon name="zap" size={14} /> Connect your AI <Icon name="chevron-right" size={14} /></span>
              </button>
            </div>
          </>
        )}

        {current === "mcp" && (
          <>
            <h2 className="mt-3 font-mono text-lg font-bold tracking-tight">
              Put your AI on the job.
            </h2>
            <p className="mt-1 text-[13px] text-ink-soft">
              Turn the AI you already use into a DataBounty copilot—discover
              eligible work, understand the task, and take actions you approve.
            </p>

            <div className="mt-5 rounded-xl border border-line bg-panel p-4">
              <McpClientPicker onSelect={(client) => void finish(`/developers?connect=${encodeURIComponent(client.name)}`)} renderLogo={(icon) => <OnboardingMcpClientLogo name={icon} />} />
              <p className="mt-2 text-[11px] text-ink-faint">
                Swipe to see more clients, or{" "}
                <button type="button" onClick={() => void finish("/developers")} disabled={submitting} className="font-medium text-accent-strong underline underline-offset-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-45">
                  set up API &amp; MCP later
                </button>.
              </p>
            </div>

            {persistError && (
              <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12.5px] text-amber-800">
                {persistError}
              </p>
            )}

            <div className={`${modal ? "hidden" : "mt-6 flex"} items-center justify-between`}>
              <button onClick={goBack} className="cursor-pointer font-mono text-[12px] text-ink-soft hover:text-ink">← back</button>
              <button
                onClick={() => void finish("/developers")}
                disabled={submitting || !scrollGateReady}
                className="cursor-pointer rounded-lg bg-ink px-5 py-2.5 font-mono text-[13px] font-medium text-lime transition-colors hover:bg-black disabled:cursor-not-allowed disabled:opacity-45"
              >
                {submitting
                  ? "saving…"
                  : "continue to API & MCP →"}
              </button>
            </div>
          </>
        )}
        </div>

        {modal && requiresScroll && !scrollGateReady && (
          <>
            <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-white via-white/85 to-transparent" />
            <button
              type="button"
              onClick={scrollContentToBottom}
              aria-label="Scroll to the bottom to continue"
              className="absolute bottom-4 left-1/2 flex -translate-x-1/2 cursor-pointer items-center gap-2 rounded-full bg-ink px-4 py-2 font-mono text-[11.5px] font-medium text-lime shadow-lg transition-colors hover:bg-black"
            >
              scroll to continue
              <Icon name="chevron-down" size={14} className="bounce-down" />
            </button>
          </>
        )}
      </div>

      {modal && (
        <footer className="flex shrink-0 items-center justify-between border-t border-line-soft bg-white px-7 py-4">
          {current === "intents" && (
            <>
              <button onClick={skip} disabled={submitting || !scrollGateReady} className="cursor-pointer font-mono text-[12px] text-ink-soft hover:text-ink disabled:cursor-not-allowed disabled:opacity-45">
                skip for now
              </button>
              <Button size="lg" onClick={goNext} disabled={!scrollGateReady}>
                continue →
              </Button>
            </>
          )}
          {current === "handle" && (
            <>
              <div>{changingClaimedHandle && <button onClick={cancelHandleChange} className="cursor-pointer font-mono text-[12px] text-ink-soft hover:text-ink">cancel change</button>}</div>
              <Button size="lg" onClick={handleAlreadyClaimed ? goNext : claimAndContinue} disabled={!handleCanContinue || submitting || !scrollGateReady}>
                {submitting ? "saving…" : handleAlreadyClaimed ? "continue →" : changingClaimedHandle ? "save change →" : "claim →"}
              </Button>
            </>
          )}
          {current === "community" && (
            <>
              <button onClick={goBack} className="cursor-pointer font-mono text-[12px] text-ink-soft hover:text-ink">← back</button>
              <Button size="lg" onClick={goNext} disabled={!scrollGateReady}>
                <span className="flex items-center gap-2"><Icon name="zap" size={14} /> Connect your AI <Icon name="chevron-right" size={14} /></span>
              </Button>
            </>
          )}
          {current === "sponsor" && (
            <>
              <button onClick={goBack} className="cursor-pointer font-mono text-[12px] text-ink-soft hover:text-ink">← back</button>
              <Button size="lg" onClick={goNext} disabled={taxonomyStatus !== "ready" || !scrollGateReady}>
                continue →
              </Button>
            </>
          )}
          {current === "pitch" && (
            <>
              <button onClick={goBack} className="cursor-pointer font-mono text-[12px] text-ink-soft hover:text-ink">← back</button>
              <Button size="lg" onClick={goNext} disabled={!scrollGateReady}>
                continue →
              </Button>
            </>
          )}
          {current === "mcp" && (
            <>
              <button onClick={goBack} className="cursor-pointer font-mono text-[12px] text-ink-soft hover:text-ink">← back</button>
              <Button size="lg" onClick={() => void finish("/developers")} disabled={submitting || !scrollGateReady}>
                {submitting ? "saving…" : "continue to API & MCP →"}
              </Button>
            </>
          )}
        </footer>
      )}
      <ConfirmDialog
        open={changeHandleConfirmOpen}
        title="Change your handle?"
        description="Your existing URL stays active until you save an available replacement. After saving, the previous URL is released and may be claimed by another user."
        confirmLabel="choose new handle"
        danger={false}
        overlayClassName="z-[80]"
        onConfirm={() => {
          setChangeHandleConfirmOpen(false);
          startHandleChange();
        }}
        onCancel={() => setChangeHandleConfirmOpen(false)}
      />
    </div>
  );
}

export function OnboardingModal() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { persona } = useDemo();
  const publicProfileHandle = readPublicProfileReturnHandle(searchParams.get(PUBLIC_PROFILE_RETURN_PARAM));

  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, []);

  return (
    <Modal
      open
      overlayClassName="z-[60] backdrop-blur-sm"
      panelClassName="w-full max-w-lg"
    >
      <OnboardingFlow
        modal
        onDone={(destination) => {
          if (publicProfileHandle) {
            window.location.assign(publicProfileReturnUrl(publicProfileHandle));
            return;
          }
          router.replace(destination ?? resolveHomeRoute(persona));
        }}
      />
    </Modal>
  );
}
