"use client";

// SPDX-License-Identifier: Apache-2.0

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Brandmark } from "@/components/brand";
import { Button } from "@/components/ui";
import { useDemo } from "@/lib/store";
import { resolveHomeRoute } from "@/lib/home-route";
import { PUBLIC_PROFILE_RETURN_PARAM, publicProfileReturnUrl, readPublicProfileReturnHandle } from "@/lib/public-profile-return";

const AUTH_READY_TIMEOUT_MS = 9000;

function RootRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { authReady, persona, signedIn, onboarded } = useDemo();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (authReady) {
      // Resetting a timer-driven flag back to its baseline once the external
      // condition it was guarding against no longer holds, not a derived render sync.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setTimedOut(true);
    }, AUTH_READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [authReady]);

  useEffect(() => {
    if (!authReady) return;
    const returnTo = searchParams.get("returnTo");
    const publicProfileHandle = readPublicProfileReturnHandle(searchParams.get(PUBLIC_PROFILE_RETURN_PARAM));
    if (publicProfileHandle) {
      if (signedIn && onboarded) {
        window.location.replace(publicProfileReturnUrl(publicProfileHandle));
        return;
      }
      router.replace(`/profile/?${PUBLIC_PROFILE_RETURN_PARAM}=${encodeURIComponent(publicProfileHandle)}`);
      return;
    }
    router.replace(returnTo === "/profile" || returnTo === "/profile/" ? "/profile/" : resolveHomeRoute(persona));
  }, [authReady, onboarded, persona, router, searchParams, signedIn]);

  if (timedOut) {
    return <AuthTimeoutScreen />;
  }

  return <LoadingScreen />;
}

function LoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-panel px-4">
      <div className="card w-full max-w-sm px-8 py-9 text-center">
        <div className="flex justify-center">
          <Brandmark size={32} className="pulse-soft" />
        </div>
        <p className="mt-5 font-mono text-sm text-ink-soft">Loading…</p>
      </div>
    </div>
  );
}

function AuthTimeoutScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-panel px-4">
      <div className="card w-full max-w-sm px-8 py-9 text-center">
        <div className="flex justify-center">
          <Brandmark size={32} />
        </div>
        <p className="mt-5 font-mono text-sm text-ink-soft">
          This is taking longer than expected. We couldn&apos;t confirm your sign-in status.
        </p>
        <Button
          type="button"
          variant="primary"
          className="mt-5 w-full"
          onClick={() => window.location.reload()}
        >
          Reload
        </Button>
      </div>
    </div>
  );
}

export default function RootPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <RootRedirect />
    </Suspense>
  );
}
