"use client";

// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { AdminPageHeader, AdminSectionHeading, AdminButton } from "@/components/admin-shell";
import { useAdminAuth } from "@/lib/admin-auth";
import { PasswordInput } from "@/components/password-input";

function Field({
  label,
  value,
  onChange,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[11px] uppercase tracking-[0.05em] text-dark-dim">{label}</span>
      <PasswordInput
        value={value}
        onChange={(e) => onChange(e.target.value)}
        minLength={8}
        autoComplete={autoComplete}
        className="mt-1.5 w-full rounded-lg border border-dark-line bg-dark-deep px-3 py-2 font-mono text-[13px] text-dark-text outline-none transition-colors focus:border-dark-hover"
      />
    </label>
  );
}

function ChangePasswordCard() {
  const { changePassword } = useAdminAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (submitting || next.length < 8 || current.length === 0) return;
    setSubmitting(true);
    setError(null);
    setDone(false);
    try {
      await changePassword(current, next);
      setCurrent("");
      setNext("");
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-xl border border-dark-line bg-dark-card p-6">
      <AdminSectionHeading title="Change password" sub="Requires your current password." />
      <div className="max-w-sm space-y-3">
        <Field label="current password" value={current} onChange={setCurrent} autoComplete="current-password" />
        <Field label="new password" value={next} onChange={setNext} autoComplete="new-password" />
        <AdminButton
          variant="primary"
          onClick={submit}
          disabled={submitting || next.length < 8 || current.length === 0}
        >
          {submitting ? "saving…" : "change password"}
        </AdminButton>
        {error && <p className="text-[12px] text-rose-400">{error}</p>}
        {done && !error && <p className="text-[12px] text-emerald-400">Password changed.</p>}
      </div>
    </section>
  );
}

function SetPasswordViaEmailCard() {
  const { requestSetPasswordEmail } = useAdminAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setDone(false);
    try {
      await requestSetPasswordEmail();
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-xl border border-dark-line bg-dark-card p-6">
      <AdminSectionHeading
        title="Set a password"
        sub="This account signed in with Google and has no password yet — get an emailed link to set one, so you can also sign in with email."
      />
      <div className="max-w-sm space-y-3">
        <AdminButton variant="primary" onClick={submit} disabled={submitting}>
          {submitting ? "sending…" : "email me a link to set a password"}
        </AdminButton>
        {error && <p className="text-[12px] text-rose-400">{error}</p>}
        {done && !error && (
          <p className="text-[12px] text-emerald-400">Check your email for a link to set a password.</p>
        )}
      </div>
    </section>
  );
}

export default function AdminAccountPage() {
  const { user } = useAdminAuth();

  return (
    <div className="space-y-8">
      <AdminPageHeader
        title="Your account"
        sub={user ? `${user.displayName} · ${user.email ?? "no email"}` : undefined}
      />
      {user?.hasPassword ? <ChangePasswordCard /> : <SetPasswordViaEmailCard />}
    </div>
  );
}
