"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAdminAuth } from "@/lib/admin-auth";
import { useAdminToast } from "@/lib/admin-toast";
import { Brandmark } from "@/components/brand";
import { PasswordInput } from "@/components/password-input";

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

export default function AdminLoginPage() {
  const { status, error, signInWithGoogleIdToken, signInWithPassword } = useAdminAuth();
  const { pushToast } = useAdminToast();
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setSubmitting(true);
    try {
      await signInWithPassword(email, password);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Sign-in failed.";
      setPasswordError(message);
      pushToast({ variant: "error", title: "Sign-in failed", body: message });
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (status === "signed-in") router.replace("/");
  }, [status, router]);

  // Hold the latest sign-in handler in a ref so the GSI init effect only
  // re-runs on `status` change, not whenever the handler identity changes —
  // re-running initialize() on every render is what makes GSI log
  // "initialize() is called multiple times".
  const signInRef = useRef(signInWithGoogleIdToken);
  useEffect(() => {
    signInRef.current = signInWithGoogleIdToken;
  }, [signInWithGoogleIdToken]);

  useEffect(() => {
    if (status !== "signed-out") return;
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!clientId) {
      // One-time config validation on mount, not derived render state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfigError("Admin sign-in is not configured (missing Google client ID).");
      return;
    }

    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 50; // ~5s at 100ms — covers a slow GSI script load
    const tryInit = () => {
      if (cancelled) return;
      if (!window.google || !containerRef.current) {
        // Give up after MAX_ATTEMPTS so a blocked/failed GSI script doesn't
        // poll forever.
        if (++attempts >= MAX_ATTEMPTS) {
          setConfigError("Couldn't load Google sign-in. Check your connection or disable blockers, then retry.");
          return;
        }
        setTimeout(tryInit, 100);
        return;
      }
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (resp) => {
          signInRef.current(resp.credential).catch((err) => {
            // Error state is already surfaced via useAdminAuth().error; also
            // raise a toast so a Google sign-in failure isn't silent.
            pushToast({ variant: "error", title: "Google sign-in failed", body: err instanceof Error ? err.message : undefined });
          });
        },
      });
      // GSI renders at a fixed pixel width, so clamp it to the container: at
      // 375px the card's content box is ~279px and a hardcoded 320 would push
      // the whole document into a sideways scroll on the sign-in page.
      window.google.accounts.id.renderButton(containerRef.current, {
        type: "standard",
        theme: "filled_black",
        size: "large",
        width: String(Math.min(320, containerRef.current.clientWidth || 320)),
        text: "signin_with",
      });
    };
    tryInit();
    return () => {
      cancelled = true;
    };
  }, [status, pushToast]);

  if (status === "loading" || status === "signed-in") return null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-dark px-4">
      <div className="w-full max-w-sm rounded-2xl border border-dark-line bg-dark-card p-8 text-center">
        <div className="flex justify-center">
          <Brandmark size={40} />
        </div>
        <h1 className="mt-4 font-mono text-lg font-bold text-dark-text">Admin sign-in</h1>
        <p className="mt-1.5 text-sm text-dark-muted">
          Sign-in only — admin accounts are provisioned separately, not
          created here.
        </p>
        <div className="mt-6 flex justify-center">
          <div ref={containerRef} />
        </div>
        {(configError || error) && (
          <p className="mt-4 text-[12px] text-red-400">{configError || error}</p>
        )}

        <div className="my-5 flex items-center gap-3">
          <span className="h-px flex-1 bg-dark-line" />
          <span className="font-mono text-[11px] text-dark-dim">or</span>
          <span className="h-px flex-1 bg-dark-line" />
        </div>

        <form onSubmit={handlePasswordSubmit} className="space-y-2.5 text-left">
          <label className="block">
            <span className="micro-label mb-1 block text-dark-dim">email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="username"
              className="w-full rounded-lg border border-dark-line bg-dark px-3 py-2 text-base text-dark-text outline-none focus:border-dark-hover sm:text-sm"
            />
          </label>
          <label className="block">
            <span className="micro-label mb-1 block text-dark-dim">password</span>
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="w-full rounded-lg border border-dark-line bg-dark px-3 py-2 text-base text-dark-text outline-none focus:border-dark-hover sm:text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={submitting}
            className="w-full cursor-pointer rounded-lg bg-lime px-4 py-2.5 font-mono text-[13px] font-medium text-dark transition-colors hover:bg-lime-bright disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "signing in…" : "sign in with password"}
          </button>
          {passwordError && <p className="text-[12px] text-red-400">{passwordError}</p>}
          <Link
            href="/forgot-password"
            className="block text-center font-mono text-[12px] text-dark-soft hover:text-dark-text"
          >
            forgot password?
          </Link>
        </form>
      </div>
    </div>
  );
}
