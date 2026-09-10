"use client";

// SPDX-License-Identifier: Apache-2.0

import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/app-shell";
import { OnboardingFlow } from "@/components/auth";
import { useDemo } from "@/lib/store";
import { resolveHomeRoute } from "@/lib/home-route";

export function OnboardingView() {
  const router = useRouter();
  const { persona } = useDemo();

  return (
    <>
      <PageHeader
        title="Onboarding"
        sub="Set up what you're here to do — you can revisit this anytime."
      />
      <div className="mx-auto w-full max-w-lg">
        <div className="card p-7">
          <OnboardingFlow embedded onDone={(destination) => router.push(destination ?? resolveHomeRoute(persona))} />
        </div>
      </div>
    </>
  );
}

export default function OnboardingPage() {
  return <OnboardingView />;
}
