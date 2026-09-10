"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { UploadHandoffStage, UploadStateCard, UploadTrustNote, WorkspaceLink } from "@/components/upload-handoff";
import { API } from "@/lib/api-endpoints";
import { apiClient, ApiError } from "@/lib/api-client";
import { rememberDraftToken } from "@/lib/upload-draft-session";

/** Redeems the short-lived opaque browser handoff and immediately removes it
 * from the visible URL.
 *
 * NO SIGN-IN REQUIRED. The link IS the credential. Redemption returns a
 * draft-scoped access token, kept in sessionStorage for this tab. */
export default function UploadHandoffView() {
  const params = useParams<{ token?: string | string[] }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const token = Array.isArray(params.token) ? params.token[0] : params.token;
  const redeemStartedRef = useRef(false);

  useEffect(() => {
    if (!token || redeemStartedRef.current) return;
    redeemStartedRef.current = true;
    apiClient
      .post<{ draftId: string; accessToken: string; redirectPath: string }>(API.uploadReviewDrafts.redeem, { token })
      .then(({ draftId, accessToken, redirectPath }) => {
        if (accessToken) rememberDraftToken(draftId, accessToken);
        router.replace(redirectPath);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError && cause.status === 404
          ? "This upload link has already been used or timed out — for your security they only stay open for a few minutes. No problem: head back to your workspace and start a fresh upload; it only takes a moment."
          : "We couldn't open this upload review just now. Please try again in a moment — your work is safe.");
        if (typeof window !== "undefined") window.history.replaceState(null, "", "/upload");
      });
  }, [token, router]);

  return (
    <UploadHandoffStage center focus="center" width="narrow">
      {error ? (
        <UploadStateCard role="alert" icon="alert" tone="danger" title="This upload link isn’t active" message={error}>
          <WorkspaceLink />
        </UploadStateCard>
      ) : <UploadStateCard busy title="Opening your upload" message="Verifying your secure upload link…" />}
      <UploadTrustNote className="mt-6" />
    </UploadHandoffStage>
  );
}
