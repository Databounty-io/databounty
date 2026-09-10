"use client";

// SPDX-License-Identifier: Apache-2.0

import { Suspense, useEffect, useState } from "react";
import { SignInCard } from "@/components/auth";
import { Button, Pill } from "@/components/ui";
import { SectionNote } from "@/components/workspace";
import { Icon, type IconName } from "@/components/icons";
import { Brandmark, Wordmark } from "@/components/brand";
import { useDemo } from "@/lib/store";
import { ExpiryCountdownLine } from "@/components/expiry-countdown";
import { parseServerTime, serverNowFromResponse, useExpiryCountdown } from "@/lib/use-expiry-countdown";
import { API_URL } from "@/lib/urls";

type AuthorizationRequest = {
  requestId: string;
  clientName: string;
  redirectUri: string;
  clientIdHost?: string | null;
  clientRedirectHosts?: string[];
  localhostOnlyRedirect?: boolean;
  scopes: string[];
  expiresAt: string;
  serverTime?: string;
};

const SCOPE_COPY: Record<string, { label: string; body: string; icon: IconName }> = {
  read: { label: "Browse marketplace data", body: "View community requests, batches, audits, and submission status.", icon: "database" },
  contribute: { label: "Submit contribution work", body: "Claim batches and submit or revise assigned dataset items.", icon: "upload" },
  validate: { label: "Review audit work", body: "Claim audits and approve or flag submissions.", icon: "shield" },
  artifact: { label: "Manage your files", body: "Upload, check, and delete files you are allowed to manage.", icon: "file" },
  sponsor: { label: "Manage your requests", body: "Review and manage your community requests, disputes, and delivery exports.", icon: "users" },
  account: { label: "Finish your account setup", body: "Claim your public handle and complete onboarding. Cannot change your email or password.", icon: "award" },
};

const CONNECTION_RECOVERY_COPY = "We couldn’t finish that connection just now. Nothing was granted or changed. Return to your MCP client, reconnect DataBounty, and try again.";

type RequestFailure = "not_found" | "expired" | "already_completed" | "unknown";

const FAILURE_COPY: Record<RequestFailure, { title: string; body: string; tone: "done" | "error" }> = {
  already_completed: {
    title: "Already approved",
    body: "This connection request was completed — most likely in another browser or tab. Nothing further is needed here. Close this tab and check your MCP client; it should be connected. You can review or revoke it any time under Developers.",
    tone: "done",
  },
  expired: {
    title: "This request timed out",
    body: "Connection requests are only valid for a few minutes. Nothing was granted and your account is untouched. Ask your MCP client to reconnect and you’ll land right back here.",
    tone: "error",
  },
  not_found: {
    title: "Connection request not found",
    body: "We don’t have a request with that id. It may already have been cleaned up. Ask your MCP client to reconnect DataBounty to start a fresh one.",
    tone: "error",
  },
  unknown: { title: "Could not connect MCP", body: CONNECTION_RECOVERY_COPY, tone: "error" },
};

function isRequestFailure(value: unknown): value is Exclude<RequestFailure, "unknown"> {
  return value === "not_found" || value === "expired" || value === "already_completed";
}

function McpAuthorizeInner() {
  const { authReady, hasRealSession, user, pushToast } = useDemo();
  const [request, setRequest] = useState<AuthorizationRequest | null>(null);
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [failure, setFailure] = useState<RequestFailure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [serverNow, setServerNow] = useState<number | null>(null);
  const [requestId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("request_id"),
  );

  useEffect(() => {
    if (!hasRealSession || !requestId) return;
    let cancelled = false;
    fetch(`${API_URL}/mcp/oauth/request/${encodeURIComponent(requestId)}`, { credentials: "include" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (!cancelled) setFailure(isRequestFailure(body?.reason) ? body.reason : "unknown");
          return;
        }
        if (!cancelled) {
          const authorizationRequest = body as AuthorizationRequest;
          setRequest(authorizationRequest);
          setSelectedScopes(authorizationRequest.scopes);
          setServerNow(parseServerTime(authorizationRequest.serverTime) ?? serverNowFromResponse(response));
        }
      })
      .catch(() => { if (!cancelled) setFailure("unknown"); });
    return () => { cancelled = true; };
  }, [hasRealSession, requestId]);

  const expiry = useExpiryCountdown(request?.expiresAt ?? null, serverNow);

  if (!authReady) return <StatusCard title="Restoring your session…" body="Checking your DataBounty sign-in securely." />;
  if (!hasRealSession) return <SignInCard />;
  if (!requestId) return <StatusCard title="Invalid authorization request" body="The MCP client did not provide a request id." />;
  if (failure) return <StatusCard {...FAILURE_COPY[failure]} />;
  if (!request) return <StatusCard title="Reviewing MCP access…" body="Loading the client and requested permissions." />;

  const complete = async (action: "approve" | "deny") => {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/mcp/oauth/request/${encodeURIComponent(request.requestId)}/${action}`, {
        method: "POST",
        credentials: "include",
        headers: action === "approve" ? { "content-type": "application/json" } : undefined,
        body: action === "approve" ? JSON.stringify({ scopes: selectedScopes }) : undefined,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (isRequestFailure(body?.reason)) { setFailure(body.reason); return; }
        throw new Error(CONNECTION_RECOVERY_COPY);
      }
      const target = new URL(body.redirectUri);
      if (action === "approve") target.searchParams.set("code", body.code);
      else target.searchParams.set("error", "access_denied");
      if (body.state) target.searchParams.set("state", body.state);
      // RFC 9207: the client checks `iss` so a response from another issuer
      // cannot be spliced into this flow.
      if (body.issuer) target.searchParams.set("iss", body.issuer);
      window.location.assign(target.toString());
    } catch {
      setBusy(null);
      const message = CONNECTION_RECOVERY_COPY;
      setError(message);
      pushToast({ variant: "error", title: action === "approve" ? "Couldn't authorize MCP client" : "Couldn't deny request", body: message });
    }
  };

  const clientHost = request.clientIdHost ?? request.clientRedirectHosts?.[0] ?? null;

  const toggleScope = (scope: string) => {
    setSelectedScopes((current) => current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope]);
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-paper px-4 py-3 sm:py-5">
      <section className="card w-full max-w-2xl p-4 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Brandmark size={22} />
            <Wordmark light size="sm" />
          </div>
          <Pill tone="success" className="shrink-0">signed in</Pill>
        </div>
        <div className="mt-3.5 min-w-0">
          <div className="flex items-center gap-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            <Icon name="shield" size={13} className="text-accent-strong" /> secure connection request
          </div>
          <h1 className="mt-1.5 text-lg font-bold tracking-tight text-ink sm:text-xl">Allow {request.clientName} to access DataBounty?</h1>
          {clientHost && (
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-soft">
              <Icon name="globe" size={12} className="shrink-0 text-ink-faint" />
              <span>Client host</span>
              <span className="break-all font-mono text-[12px] font-semibold text-ink">{clientHost}</span>
            </p>
          )}
          <p className="mt-1 text-[12.5px] leading-snug text-ink-soft">
            Signed in as <span className="break-all font-mono text-ink">{user?.email || "your DataBounty account"}</span>. Only approve this if you trust this client.
          </p>
        </div>

        {request.localhostOnlyRedirect && (
          <SectionNote icon="alert" className="mt-3">
            After you approve, the access code is sent to an app running on this computer, and the name shown above comes from the client itself — DataBounty has not verified it. Approve only if you just started this connection from that app.
          </SectionNote>
        )}

        <div className="mt-4">
          <div className="flex items-baseline justify-between gap-4">
            <div className="micro-label text-ink-faint">what this client can do</div>
            <span className="font-mono text-[10px] text-ink-faint">{selectedScopes.length} of {request.scopes.length} selected</span>
          </div>
          <div className="mt-2 grid gap-1 sm:grid-cols-2 sm:gap-1.5">
            {request.scopes.map((scope) => {
              const copy = SCOPE_COPY[scope] ?? { label: scope, body: "Access to this DataBounty capability.", icon: "shield" as IconName };
            return (
              <label key={scope} className={`flex min-w-0 cursor-pointer gap-2.5 rounded-lg border px-3 py-2 transition-colors ${selectedScopes.includes(scope) ? "border-line bg-white" : "border-transparent bg-brand-soft/50 opacity-70"}`}>
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={selectedScopes.includes(scope)}
                  disabled={busy !== null || (selectedScopes.length === 1 && selectedScopes.includes(scope))}
                  onChange={() => toggleScope(scope)}
                />
                <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-accent-strong">
                  {selectedScopes.includes(scope) ? <Icon name="check" size={13} /> : <Icon name={copy.icon} size={13} />}
                </span>
                <div className="min-w-0">
                  <div className="text-[12px] font-semibold leading-tight text-ink">{copy.label}</div>
                  <div className="mt-0.5 text-[11px] leading-snug text-ink-soft">{copy.body}</div>
                </div>
              </label>
            );
          })}
          </div>
        </div>

        <p className="mt-3 flex items-start gap-2 text-[11.5px] leading-snug text-ink-soft">
          <Icon name="shield" size={13} className="mt-0.5 shrink-0 text-accent-strong" />
          <span><span className="font-medium text-ink">You stay in control.</span> Grant only what you want — you can revoke this client any time from Developers.</span>
        </p>
        {expiry.expired && (
          <div role="alert" className="mt-3 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] leading-snug text-amber-900">
            <Icon name="clock" size={14} className="mt-0.5 shrink-0" />
            <p>
              <span className="font-medium">This connection request timed out.</span>{" "}
              Nothing was granted — your account is untouched. Ask your client to
              reconnect and you&rsquo;ll land right back here to approve it.
            </p>
          </div>
        )}
        {error && <p role="alert" className="mt-3 text-[11.5px] text-red-600">{error}</p>}
        <div className="mt-4 flex flex-col-reverse gap-2.5 border-t border-line pt-3.5 sm:flex-row sm:items-center sm:justify-between">
          <ExpiryCountdownLine countdown={expiry} className="font-mono text-[10.5px] text-ink-faint" />
          <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={busy !== null} onClick={() => void complete("deny")}>Cancel</Button>
          <Button variant="primary" disabled={busy !== null || selectedScopes.length === 0 || expiry.expired} onClick={() => void complete("approve")}>
            {busy === "approve" ? "Connecting…" : "Allow access"}
          </Button>
          </div>
        </div>
      </section>
    </main>
  );
}

function StatusCard({ title, body, tone = "info" }: { title: string; body: string; tone?: "info" | "done" | "error" }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-paper px-4 py-5">
      <section className="card w-full max-w-sm p-6 text-center">
        <div className="flex items-center justify-center gap-2">
          <Brandmark size={24} />
          <Wordmark light size="sm" />
        </div>
        <Icon
          name={tone === "done" ? "check" : tone === "error" ? "clock" : "zap"}
          size={18}
          className={`mx-auto mt-4 ${tone === "error" ? "text-amber-600" : "text-accent-strong"}`}
        />
        <h1 className="mt-3 font-mono text-[15px] font-bold text-ink">{title}</h1>
        <p className="mt-1.5 text-[12.5px] leading-snug text-ink-soft">{body}</p>
      </section>
    </main>
  );
}

export function McpAuthorizeView() {
  return (
    <Suspense fallback={<StatusCard title="Loading authorization…" body="Please wait." />}>
      <McpAuthorizeInner />
    </Suspense>
  );
}

export default function McpAuthorizePage() {
  return <McpAuthorizeView />;
}
