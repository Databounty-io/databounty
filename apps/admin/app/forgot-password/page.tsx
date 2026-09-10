"use client";

// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import Link from "next/link";
import { API_URL } from "@/lib/urls";
import { Brandmark } from "@/components/brand";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/v1/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Something went wrong.");
      }
      // Always shows success — the API deliberately responds identically
      // whether or not the email exists/has a password, so this page must
      // not branch on that either (that's the whole point of the
      // non-enumeration design on the backend).
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-dark px-4">
      <div className="w-full max-w-sm rounded-2xl border border-dark-line bg-dark-card p-8 text-center">
        <div className="flex justify-center">
          <Brandmark size={40} />
        </div>
        <h1 className="mt-4 font-mono text-lg font-bold text-dark-text">Reset password</h1>

        {sent ? (
          <p className="mt-3 text-sm text-dark-muted">
            If an account with that email exists and has a password set, a
            reset link has been sent.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="mt-6 space-y-2.5 text-left">
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
            <button
              type="submit"
              disabled={submitting}
              className="w-full cursor-pointer rounded-lg bg-lime px-4 py-2.5 font-mono text-[13px] font-medium text-dark transition-colors hover:bg-lime-bright disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "sending…" : "send reset link"}
            </button>
            {error && <p className="text-[12px] text-red-400">{error}</p>}
          </form>
        )}

        <Link
          href="/login"
          className="mt-6 block text-center font-mono text-[12px] text-dark-soft hover:text-dark-text"
        >
          ← back to sign in
        </Link>
      </div>
    </div>
  );
}
