"use client";

// SPDX-License-Identifier: Apache-2.0

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { API_URL } from "@/lib/urls";
import { Brandmark } from "@/components/brand";
import { PasswordInput } from "@/components/password-input";

function ResetPasswordForm() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [newPassword, setNewPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/v1/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Reset link is invalid or expired.");
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) {
    return (
      <p className="mt-3 text-sm text-dark-muted">
        This link is missing its reset token — request a new one from the{" "}
        <Link href="/forgot-password" className="text-dark-text underline">
          forgot password
        </Link>{" "}
        page.
      </p>
    );
  }

  if (done) {
    return (
      <>
        <p className="mt-3 text-sm text-dark-muted">
          Password updated. All previous sessions were signed out — sign in
          again with your new password.
        </p>
        <button
          onClick={() => router.push("/login")}
          className="mt-6 w-full cursor-pointer rounded-lg bg-lime px-4 py-2.5 font-mono text-[13px] font-medium text-dark transition-colors hover:bg-lime-bright"
        >
          go to sign in
        </button>
      </>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 space-y-2.5 text-left">
      <label className="block">
        <span className="micro-label mb-1 block text-dark-dim">new password</span>
        <PasswordInput
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
          className="w-full rounded-lg border border-dark-line bg-dark px-3 py-2 text-base text-dark-text outline-none focus:border-dark-hover sm:text-sm"
        />
      </label>
      <button
        type="submit"
        disabled={submitting}
        className="w-full cursor-pointer rounded-lg bg-lime px-4 py-2.5 font-mono text-[13px] font-medium text-dark transition-colors hover:bg-lime-bright disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "updating…" : "set new password"}
      </button>
      {error && <p className="text-[12px] text-red-400">{error}</p>}
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-dark px-4">
      <div className="w-full max-w-sm rounded-2xl border border-dark-line bg-dark-card p-8 text-center">
        <div className="flex justify-center">
          <Brandmark size={40} />
        </div>
        <h1 className="mt-4 font-mono text-lg font-bold text-dark-text">Set a new password</h1>
        <Suspense fallback={null}>
          <ResetPasswordForm />
        </Suspense>
      </div>
    </div>
  );
}
