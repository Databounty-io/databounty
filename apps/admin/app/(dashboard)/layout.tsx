"use client";

// SPDX-License-Identifier: Apache-2.0

import { Suspense, useEffect } from "react";
import { useRouter } from "next/navigation";
import { AdminShell, AdminSkeleton } from "@/components/admin-shell";
import { Brandmark, Wordmark } from "@/components/brand";
import { useAdminAuth } from "@/lib/admin-auth";

/**
 * Gate for every /admin/* page. This is the actual client-side enforcement
 * point — but it's a UX convenience, not the security boundary; the real
 * boundary is the backend's requireRole() on each API call these pages
 * make. A client-side redirect alone can be bypassed by calling the API
 * directly, which is exactly why every admin/settings endpoint also checks
 * the role server-side.
 *
 * Auth state is resolved entirely client-side: the session cookie is set for
 * the API's origin, not this app's, so there is no server-side cookie read to
 * gate on even though this app is served. The `/v1/auth/me` round trip (kicked off in
 * `AdminAuthProvider`, mounted at the app root in app/layout.tsx) is
 * unavoidable and already starts as early as possible: before this layout,
 * before any page-level data fetch, and only once per app load (the
 * provider lives above the router so it isn't re-run on navigation between
 * /admin/* routes).
 */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { status, user } = useAdminAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "signed-out") router.replace("/login");
  }, [status, router]);

  if (status === "loading") {
    // Mirror AdminShell's frame (same bg, same header/sidebar geometry) so
    // there's no flash of a different background or layout shift once the
    // session check resolves and the real shell mounts.
    return (
      <div className="flex min-h-screen bg-dark-shell text-dark-text">
        <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between border-b border-dark-line bg-[#050605] px-4 lg:hidden">
          <div className="flex items-center gap-2.5">
            <Brandmark size={24} />
            <Wordmark size="sm" />
          </div>
        </header>
        <div className="fixed inset-y-0 left-0 z-20 hidden w-56 border-r border-dark-line bg-[#050605] p-4 lg:block" aria-hidden="true">
          <div className="mb-8 flex items-center gap-2.5">
            <Brandmark size={26} />
            <Wordmark size="md" />
          </div>
          <div className="space-y-2.5">
            {Array.from({ length: 6 }).map((_, i) => (
              <AdminSkeleton key={i} className="h-3 w-full max-w-[140px]" />
            ))}
          </div>
        </div>
        <main className="min-w-0 flex-1 pt-14 lg:ml-56 lg:pt-0">
          <div className="max-w-[1920px] px-4 pb-16 pt-6 sm:px-6 sm:pt-9 lg:px-10">
            <AdminSkeleton className="mb-4 h-7 w-48" />
            <div className="space-y-3">
              <AdminSkeleton className="h-24 w-full" />
              <AdminSkeleton className="h-24 w-full" />
              <AdminSkeleton className="h-24 w-full" />
            </div>
          </div>
        </main>
      </div>
    );
  }
  if (status !== "signed-in" || !user) return null; // redirect effect above is firing

  // AdminShell reads the details-page query parameter to preserve the active
  // roster item. Static export requires that router read to sit below Suspense.
  return (
    <Suspense fallback={<AdminSkeleton className="min-h-screen w-full bg-dark-shell" />}>
      <AdminShell>{children}</AdminShell>
    </Suspense>
  );
}
