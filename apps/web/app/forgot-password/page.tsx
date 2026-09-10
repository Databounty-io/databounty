"use client";

// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import Link from "next/link";
import { API_URL } from "@/lib/urls";
import { API } from "@/lib/api-endpoints";
import { safeMessage } from "@/lib/store";
import { Brandmark } from "@/components/brand";
import { Button } from "@/components/ui";

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
      const res = await fetch(`${API_URL}${API.auth.forgotPassword}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(safeMessage(body.message, "Something went wrong."));
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
    <div className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="card w-full max-w-md px-8 py-9 text-center">
        <div className="flex justify-center">
          <Brandmark size={38} />
        </div>
        <h1 className="mt-4 font-mono text-lg font-bold">Reset your password</h1>

        {sent ? (
          <p className="mt-3 text-sm leading-relaxed text-ink-soft">
            If an account with that email exists and has a password set, a
            reset link has been sent.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="mt-7 space-y-3 text-left">
            <label className="block">
              <span className="micro-label mb-1.5 block text-ink-faint">email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                autoComplete="username"
                className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm outline-none focus:border-ink"
              />
            </label>
            <Button size="lg" type="submit" disabled={submitting} className="w-full">
              {submitting ? "sending…" : "send reset link"}
            </Button>
            {error && <p className="text-center text-[12px] text-red-600">{error}</p>}
          </form>
        )}

        <Link
          href="/"
          className="mt-6 block text-center font-mono text-[12px] text-ink-soft hover:text-ink"
        >
          ← back to sign in
        </Link>
      </div>
    </div>
  );
}
