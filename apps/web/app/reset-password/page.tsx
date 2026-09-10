"use client";

// SPDX-License-Identifier: Apache-2.0

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { API_URL } from "@/lib/urls";
import { API } from "@/lib/api-endpoints";
import { safeMessage } from "@/lib/store";
import { Brandmark } from "@/components/brand";
import { Button } from "@/components/ui";
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
      const res = await fetch(`${API_URL}${API.auth.resetPassword}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(safeMessage(body.message, "Reset link is invalid or expired."));
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
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">
        This link is missing its reset token — request a new one from the{" "}
        <Link href="/forgot-password" className="font-medium text-ink underline">
          forgot password
        </Link>{" "}
        page.
      </p>
    );
  }

  if (done) {
    return (
      <>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Password updated. All previous sessions were signed out — sign in
          again with your new password.
        </p>
        <Button size="lg" onClick={() => router.push("/")} className="mt-6 w-full">
          go to sign in
        </Button>
      </>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-7 space-y-3 text-left">
      <label className="block">
        <span className="micro-label mb-1.5 block text-ink-faint">new password</span>
        <PasswordInput
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          minLength={8}
          autoFocus
          autoComplete="new-password"
          className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm outline-none focus:border-ink"
        />
      </label>
      <Button size="lg" type="submit" disabled={submitting} className="w-full">
        {submitting ? "updating…" : "set new password"}
      </Button>
      {error && <p className="text-center text-[12px] text-red-600">{error}</p>}
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="card w-full max-w-md px-8 py-9 text-center">
        <div className="flex justify-center">
          <Brandmark size={38} />
        </div>
        <h1 className="mt-4 font-mono text-lg font-bold">Set a new password</h1>
        <Suspense fallback={null}>
          <ResetPasswordForm />
        </Suspense>
      </div>
    </div>
  );
}
