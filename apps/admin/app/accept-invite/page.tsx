"use client";

// SPDX-License-Identifier: Apache-2.0

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { API_URL } from "@/lib/urls";
import { Brandmark } from "@/components/brand";
import { PasswordInput } from "@/components/password-input";

function AcceptInviteForm() {
  const token = useSearchParams().get("token") ?? "";
  // The first submit sends only the token; if the API answers 422 with
  // needsAccount, the invited email has no account yet and we show the
  // create-account fields for a second submit.
  const [needsAccount, setNeedsAccount] = useState(false);
  const [inviteEmail, setInviteEmail] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (body: Record<string, string>) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/v1/auth/accept-invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const parsed = await res.json().catch(() => ({}));
      if (res.status === 422 && parsed.needsAccount) {
        setNeedsAccount(true);
        setInviteEmail(parsed.email ?? null);
        return;
      }
      if (!res.ok) {
        throw new Error(parsed.message || "This invitation is invalid, expired, or already used.");
      }
      // The API set the httpOnly session cookie on this response — a full
      // navigation lets AdminAuthProvider restore from it.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) {
    return (
      <p className="mt-3 text-sm text-dark-muted">
        This link is missing its invitation token — ask the admin who
        invited you to send a fresh link.
      </p>
    );
  }

  if (!needsAccount) {
    return (
      <>
        <p className="mt-3 text-sm text-dark-muted">
          You&apos;ve been invited to the DataBounty admin console. Accepting
          signs you in with the invited role.
        </p>
        <button
          onClick={() => submit({ token })}
          disabled={submitting}
          className="mt-6 w-full cursor-pointer rounded-lg bg-lime px-4 py-2.5 font-mono text-[13px] font-medium text-dark transition-colors hover:bg-lime-bright disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "accepting…" : "accept invitation"}
        </button>
        {error && <p className="mt-3 text-[12px] text-red-400">{error}</p>}
      </>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit({ token, displayName: displayName.trim(), password });
      }}
      className="mt-6 space-y-2.5 text-left"
    >
      <p className="text-sm text-dark-muted">
        {inviteEmail ? (
          <>
            No account exists for <span className="text-dark-text">{inviteEmail}</span> yet —
            set one up to accept.
          </>
        ) : (
          "No account exists for this email yet — set one up to accept."
        )}
      </p>
      <label className="block">
        <span className="micro-label mb-1 block text-dark-dim">display name</span>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          autoComplete="name"
          className="w-full rounded-lg border border-dark-line bg-dark px-3 py-2 text-base text-dark-text outline-none focus:border-dark-hover sm:text-sm"
        />
      </label>
      <label className="block">
        <span className="micro-label mb-1 block text-dark-dim">password</span>
        <PasswordInput
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
          className="w-full rounded-lg border border-dark-line bg-dark px-3 py-2 text-base text-dark-text outline-none focus:border-dark-hover sm:text-sm"
        />
      </label>
      <button
        type="submit"
        disabled={submitting || !displayName.trim() || password.length < 8}
        className="w-full cursor-pointer rounded-lg bg-lime px-4 py-2.5 font-mono text-[13px] font-medium text-dark transition-colors hover:bg-lime-bright disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "creating account…" : "create account & accept"}
      </button>
      {error && <p className="text-[12px] text-red-400">{error}</p>}
    </form>
  );
}

export default function AcceptInvitePage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-dark px-4">
      <div className="w-full max-w-sm rounded-2xl border border-dark-line bg-dark-card p-8 text-center">
        <div className="flex justify-center">
          <Brandmark size={40} />
        </div>
        <h1 className="mt-4 font-mono text-lg font-bold text-dark-text">Admin invitation</h1>
        <Suspense fallback={null}>
          <AcceptInviteForm />
        </Suspense>
      </div>
    </div>
  );
}
