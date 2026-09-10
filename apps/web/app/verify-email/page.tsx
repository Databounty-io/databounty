"use client";

// SPDX-License-Identifier: Apache-2.0

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { API_URL } from "@/lib/urls";
import { API } from "@/lib/api-endpoints";
import { safeMessage } from "@/lib/store";
import { Brandmark } from "@/components/brand";
import { Button } from "@/components/ui";

function VerifyEmailBody() {
  const token = useSearchParams().get("token") ?? "";
  const [status, setStatus] = useState<"checking" | "done" | "error">(token ? "checking" : "error");
  const [error, setError] = useState<string | null>(
    token ? null : "This link is missing its verification token."
  );

  useEffect(() => {
    if (!token) return;
    fetch(`${API_URL}${API.auth.verifyEmail}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(safeMessage(body.message, "Verification link is invalid or expired."));
        }
        setStatus("done");
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Something went wrong.");
        setStatus("error");
      });
  }, [token]);

  if (status === "checking") {
    return <p className="mt-3 text-sm text-ink-soft">Verifying…</p>;
  }

  if (status === "error") {
    return (
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">
        {error}{" "}
        <Link href="/profile" className="font-medium text-ink underline">
          Go to your profile
        </Link>{" "}
        to request a new one.
      </p>
    );
  }

  return (
    <>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">Your email is verified.</p>
      <Button size="lg" href="/" className="mt-6 w-full">
        go to dashboard
      </Button>
    </>
  );
}

export default function VerifyEmailPage() {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="card w-full max-w-md px-8 py-9 text-center">
        <div className="flex justify-center">
          <Brandmark size={38} />
        </div>
        <h1 className="mt-4 font-mono text-lg font-bold">Verify your email</h1>
        <Suspense fallback={null}>
          <VerifyEmailBody />
        </Suspense>
      </div>
    </div>
  );
}
