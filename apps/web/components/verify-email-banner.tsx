"use client";

// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useDemo } from "@/lib/store";

/**
 * Global dashboard banner for unverified email signups.
 */
export function VerifyEmailBanner() {
  const { user, resendVerification, pushToast } = useDemo();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!user || user.emailVerified) return null;

  const resend = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await resendVerification();
      setSent(true);
      pushToast({ variant: "success", title: "Verification email sent" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setError(message);
      pushToast({ variant: "error", title: "Couldn't send verification email", body: message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3">
      <p className="text-[13px] text-amber-900">
        {sent
          ? "Verification email sent — check your inbox. The link expires in 24 hours."
          : "Please verify your email address to secure your account."}
      </p>
      {!sent && (
        <button
          type="button"
          onClick={resend}
          disabled={submitting}
          className="shrink-0 cursor-pointer font-mono text-[12px] font-medium text-amber-900 underline hover:text-amber-950 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "sending…" : "resend verification email"}
        </button>
      )}
      {error && <p className="w-full text-[12px] text-red-600">{error}</p>}
    </div>
  );
}
