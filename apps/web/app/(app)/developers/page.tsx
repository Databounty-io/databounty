"use client";

// SPDX-License-Identifier: Apache-2.0

import { Suspense, useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/app-shell";
import { Button, CodeBlock, ComingSoonDialog, ConfirmDialog, CopyButton, Modal, Pill, SectionHeading } from "@/components/ui";
import { Icon } from "@/components/icons";
import { McpClientPicker } from "@/components/mcp-client-picker";
import { useDemo } from "@/lib/store";
import { apiClient, ApiError } from "@/lib/api-client";
import { API } from "@/lib/api-endpoints";
import { API_URL, MCP_URL } from "@/lib/urls";
import { connectionGuide, MCP_CLIENTS, remoteMcpConfig, type McpClientIcon, type McpConnectionAuth } from "@/lib/mcp-connection-guide";

type ApiKeyScope = "read" | "contribute" | "validate" | "artifact" | "sponsor";

interface ApiKeySummary {
  id: string;
  keyPrefix: string;
  scopes: ApiKeyScope[];
  createdAt: string;
  rotatedAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

interface IssuedKey extends ApiKeySummary {
  key: string;
}

interface McpGrant {
  clientId: string;
  clientName: string;
  scopes: string[];
  lastUsedAt: string;
}

const SCOPE_OPTIONS: { value: ApiKeyScope; label: string; desc: string }[] = [
  { value: "read", label: "read", desc: "List requests/batches, poll submissions, list audits." },
  { value: "contribute", label: "contribute", desc: "Claim batches, submit dataset items." },
  { value: "validate", label: "validate", desc: "Claim audits and submit approve/reject decisions." },
  { value: "artifact", label: "artifact", desc: "Prepare and complete authorized file uploads." },
  { value: "sponsor", label: "sponsor", desc: "Review and manage your community requests and datasets." },
];

// This dashboard is the public MCP gateway. The API-provided developer surface
// remains authoritative, but a temporary surface-fetch failure must still show
// the same endpoint clients are meant to configure rather than reverting to
// the API host.
const FALLBACK_MCP_REMOTE_URL = MCP_URL;

type Method = "GET" | "POST";

type EndpointScope = ApiKeyScope | "public";
type ToolScope = ApiKeyScope | "public";

interface EndpointDescriptor {
  method: Method;
  path: string;
  purpose: string;
  scope: EndpointScope;
}

interface McpToolDescriptor {
  name: string;
  description: string;
  scope: ToolScope;
}

interface DeveloperSurface {
  baseUrl: string;
  mcpRemoteUrl: string;
  rateLimitPerMinute: number;
  llmValidationEnabled: boolean;
  endpoints: EndpointDescriptor[];
  mcpTools: McpToolDescriptor[];
}

const SCOPE_TONE: Record<ToolScope, string> = {
  read: "text-slate-700 bg-slate-50 border-slate-200",
  contribute: "text-amber-700 bg-amber-50 border-amber-200",
  validate: "text-violet-700 bg-violet-50 border-violet-200",
  artifact: "text-cyan-700 bg-cyan-50 border-cyan-200",
  sponsor: "text-fuchsia-700 bg-fuchsia-50 border-fuchsia-200",
  public: "text-ink-faint bg-transparent border-line",
};



function McpClientLogo({ name }: { name: McpClientIcon }) {
  const className = "h-3 w-3 shrink-0";
  switch (name) {
    case "claude":
      return <svg aria-hidden="true" viewBox="0 0 24 24" className={className}><path fill="#D97757" fillRule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" clipRule="evenodd" /></svg>;
    case "openclaw":
      return <svg aria-hidden="true" viewBox="0 0 120 120" className={className}><defs><linearGradient id="openclaw-gradient" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#ff4d4d" /><stop offset="100%" stopColor="#991b1b" /></linearGradient></defs><path fill="url(#openclaw-gradient)" d="M60 10C30 10 15 35 15 55c0 20 15 40 30 45v10h10v-10s5 2 10 0v10h10v-10c15-5 30-25 30-45 0-20-15-45-45-45Z" /><path fill="url(#openclaw-gradient)" d="M20 45C5 40 0 50 5 60c5 10 15 5 20-5 3-7 0-10-5-10Zm80 0c15-5 20 5 15 15-5 10-15 5-20-5-3-7 0-10 5-10Z" /><path d="M45 15Q35 5 30 8m45 7Q85 5 90 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round" /><circle cx="45" cy="35" r="6" fill="#050810" /><circle cx="75" cy="35" r="6" fill="#050810" /><circle cx="46" cy="34" r="2.5" fill="#00e5cc" /><circle cx="76" cy="34" r="2.5" fill="#00e5cc" /></svg>;
    case "chatgpt":
      return <svg aria-hidden="true" viewBox="0 0 24 24" className={className}><path fill="currentColor" d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 0 0-.856 0l-5.97 3.473Zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 0 1 .476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163ZM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898ZM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128Zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472Zm-5.637-5.303-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 0 1 4.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 0 1-.476 0Zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523Zm5.899 2.83a5.947 5.947 0 0 0 5.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0 0 10.205 0a5.947 5.947 0 0 0-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 0 0 4.162 1.713Z" /></svg>;
    case "codex":
      return <svg aria-hidden="true" viewBox="0 0 24 24" className={className}><path fill="currentColor" fillRule="evenodd" d="M8.086.457a6.105 6.105 0 0 1 3.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 0 0 .107.029c1.408-.346 2.762-.224 4.061.366l.217.106c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 0 1-.18 1.631.167.167 0 0 0 .04.155 5.982 5.982 0 0 1 1.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 0 1-2.934 1.851.162.162 0 0 0-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 0 0-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 0 1-2.595-.622 6.058 6.058 0 0 1-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 0 1-.495-1.283 6.11 6.11 0 0 1-.017-3.064.166.166 0 0 0 .008-.074.115.115 0 0 0-.037-.064 5.958 5.958 0 0 1-1.38-2.202 5.196 5.196 0 0 1-.333-1.589 6.915 6.915 0 0 1 .188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 0 0 .087-.087A6.016 6.016 0 0 1 5.635 2.31C6.315 1.464 7.132.846 8.086.457Zm-.804 7.85a.848.848 0 0 0-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 0 0 1.46.864l1.94-3.272a.849.849 0 0 0 .007-.854l-1.94-3.393Zm5.446 6.24a.849.849 0 0 0 0 1.695h4.848a.849.849 0 0 0 0-1.696h-4.848Z" clipRule="evenodd" /></svg>;
    case "cursor":
      return <svg aria-hidden="true" viewBox="0 0 466.73 532.09" className={className}><path fill="currentColor" d="M457.43 125.94 244.42 2.96a22.1 22.1 0 0 0-22.12 0L9.3 125.94A18.6 18.6 0 0 0 0 142.05v247.99a18.6 18.6 0 0 0 9.3 16.11l213.01 122.98a22.1 22.1 0 0 0 22.12 0l213.01-122.98a18.6 18.6 0 0 0 9.3-16.11V142.05a18.6 18.6 0 0 0-9.3-16.11h-.01Zm-13.38 26.05-205.63 356.16c-1.39 2.4-5.06 1.42-5.06-1.36V273.58c0-4.66-2.49-8.97-6.53-11.31L24.87 145.67c-2.4-1.39-1.42-5.06 1.36-5.06h411.26c5.84 0 9.49 6.33 6.57 11.39h-.01Z" /></svg>;
    case "windsurf":
      return <span aria-hidden="true" className="flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] bg-[#111827]"><svg viewBox="0 0 1024 1024" className="h-2 w-2"><path fill="#fff" d="M897.246 286.869h-7.427c-39.084-.061-70.802 31.591-70.802 70.67v158.05c0 31.561-26.087 57.127-57.135 57.127-18.446 0-36.862-9.283-47.789-24.866L552.673 317.304c-13.393-19.144-35.187-30.557-58.778-30.557-36.801 0-69.919 31.287-69.919 69.91v158.962c0 31.562-25.873 57.127-57.134 57.127-18.507 0-36.893-9.283-47.821-24.865L138.395 289.882c-4.079-5.844-13.241-2.952-13.241 4.17v137.84c0 6.97 2.131 13.727 6.118 19.448L309.037 705.2c10.502 15.004 25.994 26.144 43.863 30.192 44.716 10.165 85.87-24.257 85.87-68.114V508.406c0-31.561 25.569-57.127 57.134-57.127h.091c19.025 0 36.862 9.283 47.79 24.866l161.45 230.516c13.424 19.174 34.092 30.557 58.748 30.557 37.623 0 69.858-31.318 69.858-69.91V508.376c0-31.561 25.569-57.127 57.134-57.127h6.301a7.154 7.154 0 0 0 7.154-7.152v-150.076a7.154 7.154 0 0 0-7.154-7.152h-.03Z" /></svg></span>;
    case "code":
      return <Icon name="code" size={11} className="shrink-0 text-ink-faint" />;
  }
}

function ConnectClientModal({
  client,
  mcpRemoteUrl,
  onCheckAuthorization,
  onClose,
}: {
  client: (typeof MCP_CLIENTS)[number] | null;
  mcpRemoteUrl: string;
  onCheckAuthorization: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [connectionAuth, setConnectionAuth] = useState<McpConnectionAuth>("oauth");
  const [authorizationCheck, setAuthorizationCheck] = useState<"idle" | "checking" | "connected" | "not_connected">("idle");
  if (!client) return null;
  const supportsOAuth = client.auth !== "API key";
  const supportsApiKey = client.auth !== "OAuth";
  const selectedAuth = supportsOAuth ? connectionAuth : "apikey";
  const guide = connectionGuide(client, mcpRemoteUrl, selectedAuth);
  const checkAuthorization = async () => {
    setAuthorizationCheck("checking");
    setAuthorizationCheck(await onCheckAuthorization() ? "connected" : "not_connected");
  };

  return (
    <Modal open panelClassName="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-[14px] border border-line bg-white p-6 shadow-xl">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <McpClientLogo name={client.icon} />
          <div>
            <div className="text-base font-bold tracking-tight">Connect {client.name}</div>
            <p className="mt-0.5 text-[12px] text-ink-soft">Use DataBounty&apos;s remote MCP server.</p>
          </div>
        </div>
        <button type="button" onClick={onClose} className="text-ink-faint hover:text-ink" aria-label="Close connection instructions">×</button>
      </div>

      <div className="mt-4 rounded-[8px] border border-accent-soft-border bg-[#f7faef] px-3 py-2 font-mono text-[10.5px] text-accent-strong-hover">
        Authentication: {client.auth}
      </div>

      {supportsOAuth && supportsApiKey && (
        <div className="mt-4 inline-flex rounded-[8px] border border-line bg-panel p-0.5">
          <button
            type="button"
            onClick={() => setConnectionAuth("oauth")}
            aria-pressed={connectionAuth === "oauth"}
            className={`rounded-[6px] px-3 py-1.5 font-mono text-[11px] font-medium transition-colors ${connectionAuth === "oauth" ? "bg-white text-accent-strong shadow-sm" : "text-ink-faint hover:text-ink"}`}
          >
            OAuth (recommended)
          </button>
          <button
            type="button"
            onClick={() => setConnectionAuth("apikey")}
            aria-pressed={connectionAuth === "apikey"}
            className={`rounded-[6px] px-3 py-1.5 font-mono text-[11px] font-medium transition-colors ${connectionAuth === "apikey" ? "bg-white text-accent-strong shadow-sm" : "text-ink-faint hover:text-ink"}`}
          >
            API key
          </button>
        </div>
      )}

      <ol className="mt-5 space-y-3 text-[12px] text-ink-soft">
        {guide.steps.map((step, index) => (
          <li key={step} className="flex gap-2"><span className="shrink-0 font-mono font-semibold text-accent-strong">0{index + 1}</span><span>{step}</span></li>
        ))}
      </ol>

      <div className="mt-5 flex items-center justify-between gap-2">
        <span className="micro-label text-ink-faint">{guide.label}</span>
        <CopyButton value={guide.code} label={`${client.name} connection instructions`} />
      </div>
      <CodeBlock label={guide.label} code={guide.code} />

      {selectedAuth === "oauth" && (
        <div className="mt-4 rounded-[8px] border border-line bg-panel px-3 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-mono text-[11px] font-semibold text-ink">verify authorization</div>
              <p className="mt-0.5 text-[10.5px] leading-relaxed text-ink-faint">After approving in your browser, check that DataBounty recorded an OAuth connection.</p>
            </div>
            <Button variant="secondary" size="sm" disabled={authorizationCheck === "checking"} onClick={() => void checkAuthorization()}>
              {authorizationCheck === "checking" ? "checking…" : "I finished OAuth — check"}
            </Button>
          </div>
          {authorizationCheck === "connected" && <p role="status" className="mt-2 text-[11px] text-emerald-700">OAuth authorization is recorded.</p>}
          {authorizationCheck === "not_connected" && <p role="alert" className="mt-2 text-[11px] text-amber-800">No OAuth authorization is recorded yet.</p>}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-[10.5px] text-ink-faint">{guide.keyRequired ? "This setup uses an API key." : "OAuth is preferred when your client supports it."}</span>
        {client.auth === "OAuth" ? (
          <button type="button" onClick={onClose} className="shrink-0 rounded-[8px] bg-accent-strong px-3 py-2 font-mono text-[11px] font-medium text-white hover:bg-accent-strong-hover">done</button>
        ) : (
          <a href="#api-keys" onClick={onClose} className="shrink-0 rounded-[8px] bg-accent-strong px-3 py-2 font-mono text-[11px] font-medium text-white hover:bg-accent-strong-hover">create API key</a>
        )}
      </div>
    </Modal>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback;
  return fallback;
}

function RevealKeyModal({ issued, onClose }: { issued: IssuedKey | null; onClose: () => void }) {
  if (!issued) return null;
  return (
    <Modal open panelClassName="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-[14px] border border-line bg-white p-6 shadow-xl">
      <div className="mb-1 flex items-center gap-2 text-base font-bold tracking-tight">
        <Icon name="shield" size={16} className="text-ink-soft" />
        Your new API key
      </div>
      <p className="mb-4 text-[12.5px] text-ink-soft">
        This is the only time the full key is shown. Copy it now — closing this
        dialog is permanent; DataBounty never stores it in a recoverable form.
      </p>
      <div className="rounded-[10px] border border-line bg-panel p-4">
        <div className="micro-label mb-2 text-ink-faint">secret key</div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="break-all font-mono text-[13px]">{issued.key}</span>
          <CopyButton value={issued.key} label="API key" tone="highlight" />
        </div>
      </div>
      <div className="mt-2 text-[11px] text-ink-faint">
        scopes: {issued.scopes.join(", ")} · expires {fmtDate(issued.expiresAt)}
      </div>
      <div className="mt-5 flex justify-end">
        <Button variant="primary" size="sm" onClick={onClose}>
          I&rsquo;ve saved it — close
        </Button>
      </div>
    </Modal>
  );
}

export function DevelopersView() {
  const { pushToast, user, hasRealSession } = useDemo();

  const [keys, setKeys] = useState<ApiKeySummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keysLoading, setKeysLoading] = useState(true);
  // Keys start with the full developer surface selected. Users can still
  // deselect any capability before creation; the server remains the authority
  // for the scopes it grants and enforces on every request.
  const [selectedScopes, setSelectedScopes] = useState<ApiKeyScope[]>(() => SCOPE_OPTIONS.map((scope) => scope.value));
  const [issuing, setIssuing] = useState(false);
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);
  const [revealedIssue, setRevealedIssue] = useState<IssuedKey | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeySummary | null>(null);
  const [mcpGrants, setMcpGrants] = useState<McpGrant[]>([]);
  const [revokingGrant, setRevokingGrant] = useState<string | null>(null);
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);
  const [revokingAll, setRevokingAll] = useState(false);

  const [surface, setSurface] = useState<DeveloperSurface | null>(null);
  // Kept as setter-only: loadSurface still runs because `surface` powers the
  // MCP tool list, base URL, rate limit and LLM flag. Nothing reads these two
  // since the endpoint-reference card was removed.
  const [surfaceError, setSurfaceError] = useState<string | null>(null);
  const [, setSurfaceLoading] = useState(true);
  const [mcpAuthMode, setMcpAuthMode] = useState<"oauth" | "apikey">("oauth");
  const [connectClient, setConnectClient] = useState<(typeof MCP_CLIENTS)[number] | null>(() => {
    if (typeof window === "undefined") return null;
    const requestedClient = new URLSearchParams(window.location.search).get("connect");
    return requestedClient ? MCP_CLIENTS.find((candidate) => candidate.name === requestedClient) ?? null : null;
  });
  const [expandedMcpTool, setExpandedMcpTool] = useState<string | null>(null);
  const [mcpToolsOpen, setMcpToolsOpen] = useState(false);
  const [docsComingSoonOpen, setDocsComingSoonOpen] = useState(false);

  const loadKeys = useCallback(async () => {
    setKeysLoading(true);
    try {
      const res = await apiClient.get<{ keys: ApiKeySummary[] }>(API.me.apiKeys);
      setKeys(res.keys);
      setLoadError(null);
    } catch (err) {
      setLoadError(apiErrorMessage(err, "Couldn't load API keys"));
    } finally {
      setKeysLoading(false);
    }
  }, []);

  const loadSurface = useCallback(async () => {
    setSurfaceLoading(true);
    try {
      const res = await apiClient.get<DeveloperSurface>(API.meta.developerSurface);
      setSurface(res);
      setSurfaceError(null);
    } catch (err) {
      setSurfaceError(apiErrorMessage(err, "Couldn't load the API reference"));
    } finally {
      setSurfaceLoading(false);
    }
  }, []);

  const loadMcpGrants = useCallback(async (): Promise<McpGrant[]> => {
    if (!hasRealSession) return [];
    try {
      const response = await fetch(`${API_URL}/mcp/oauth/grants`, { credentials: "include" });
      if (!response.ok) return [];
      const body = (await response.json()) as { grants?: McpGrant[] };
      const grants = body.grants ?? [];
      setMcpGrants(grants);
      return grants;
    } catch {
      return [];
    }
  }, [hasRealSession]);

  const checkMcpAuthorization = useCallback(async () => (await loadMcpGrants()).length > 0, [loadMcpGrants]);

  useEffect(() => {
    // One-shot data load on mount, not a React-state sync.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadKeys();
  }, [loadKeys]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSurface();
  }, [loadSurface]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadMcpGrants();
  }, [loadMcpGrants]);

  const activeKeys = (keys ?? []).filter((k) => !k.revokedAt);
  // The configured dashboard gateway is canonical even if an older API
  // deployment temporarily returns a request-derived/internal URL.
  const mcpRemoteUrl = FALLBACK_MCP_REMOTE_URL;
  const rateLimitPerMinute = surface?.rateLimitPerMinute ?? 300;
  const llmValidationEnabled = surface?.llmValidationEnabled ?? false;

  const toggleScope = (scope: ApiKeyScope) => {
    setSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    );
  };

  const toggleMcpTools = () => {
    const scrollTop = window.scrollY;
    setMcpToolsOpen((open) => !open);
    requestAnimationFrame(() => window.scrollTo(0, scrollTop));
  };

  const handleIssue = async () => {
    if (selectedScopes.length === 0) {
      pushToast({ variant: "error", title: "Pick at least one scope", body: "" });
      return;
    }
    setIssuing(true);
    try {
      const res = await apiClient.post<IssuedKey>(API.me.apiKeys, { scopes: selectedScopes });
      setRevealedIssue(res);
      await loadKeys();
    } catch (err) {
      pushToast({ variant: "error", title: "Couldn't create key", body: apiErrorMessage(err, "Try again.") });
    } finally {
      setIssuing(false);
    }
  };

  const handleRotate = async (id: string) => {
    setBusyKeyId(id);
    try {
      const res = await apiClient.post<IssuedKey>(API.me.apiKeyRotate(id));
      setRevealedIssue(res);
      await loadKeys();
      pushToast({ variant: "success", title: "Key rotated", body: "The previous key is now revoked." });
    } catch (err) {
      pushToast({ variant: "error", title: "Couldn't rotate key", body: apiErrorMessage(err, "Try again.") });
    } finally {
      setBusyKeyId(null);
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    const id = revokeTarget.id;
    setBusyKeyId(id);
    try {
      await apiClient.del(API.me.apiKey(id));
      await loadKeys();
      pushToast({ variant: "success", title: "Key revoked", body: "" });
    } catch (err) {
      pushToast({ variant: "error", title: "Couldn't revoke key", body: apiErrorMessage(err, "Try again.") });
    } finally {
      setBusyKeyId(null);
      setRevokeTarget(null);
    }
  };

  const handleRevokeGrant = async (clientId: string) => {
    setRevokingGrant(clientId);
    try {
      const response = await fetch(`${API_URL}/mcp/oauth/grants/${encodeURIComponent(clientId)}/revoke`, { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error("Could not revoke MCP access.");
      setMcpGrants((grants) => grants.filter((grant) => grant.clientId !== clientId));
      pushToast({ variant: "success", title: "MCP access revoked", body: "The client must sign in again to reconnect." });
    } catch (err) {
      pushToast({ variant: "error", title: "Couldn't revoke MCP access", body: err instanceof Error ? err.message : "Try again." });
    } finally {
      setRevokingGrant(null);
    }
  };

  const handleRevokeAll = async () => {
    setRevokingAll(true);
    try {
      const response = await fetch(`${API_URL}/mcp/oauth/grants/revoke-all`, { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error("Could not disconnect MCP clients.");
      setMcpGrants([]);
      pushToast({ variant: "success", title: "All MCP clients disconnected", body: "Every client must sign in again to reconnect." });
    } catch (err) {
      pushToast({ variant: "error", title: "Couldn't disconnect MCP clients", body: err instanceof Error ? err.message : "Try again." });
    } finally {
      setRevokingAll(false);
      setRevokeAllOpen(false);
    }
  };

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Developers"
        sub="REST API + MCP"
        compact
      />

      <div id="api-keys" className="card order-2 mt-6 min-w-0 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <SectionHeading icon="shield" title="API keys" info="Authenticate requests with a secret key scoped to only the actions it needs. Keys are shown in full exactly once—treat them like passwords and never commit them." />
          <span className="rounded-full border border-line bg-panel px-2.5 py-1 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-ink-faint">
            secret credentials
          </span>
        </div>
        {loadError && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[12.5px] text-red-700" role="alert">
            <span>{loadError}</span>
            <Button variant="secondary" size="sm" disabled={keysLoading} onClick={() => void loadKeys()}>
              retry
            </Button>
          </div>
        )}

        {keys === null && !loadError && (
          <div className="mb-5 rounded-[10px] border border-dashed border-line px-4 py-6 text-center text-[12.5px] text-ink-soft" role="status" aria-live="polite">
            Loading API keys…
          </div>
        )}

        {activeKeys.length > 0 && (
          <div className="mb-5 mt-5 divide-y divide-line rounded-[10px] border border-line">
            {activeKeys.map((k) => (
              <div key={k.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <div className="font-mono text-[13px] font-medium">{k.keyPrefix}••••</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {k.scopes.map((s) => (
                      <span
                        key={s}
                        className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${SCOPE_TONE[s]}`}
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                  <div className="mt-1.5 text-[11px] text-ink-faint">
                    created {fmtDate(k.createdAt)} · last used {fmtDate(k.lastUsedAt)} · expires{" "}
                    {fmtDate(k.expiresAt)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busyKeyId === k.id}
                    onClick={() => void handleRotate(k.id)}
                  >
                    <Icon name="refresh" size={13} />
                    rotate
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={busyKeyId === k.id}
                    onClick={() => setRevokeTarget(k)}
                  >
                    revoke
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {keys !== null && activeKeys.length === 0 && !loadError && (
          <div className="mb-5 mt-5 flex items-center gap-3 rounded-[10px] border border-dashed border-line bg-[#fbfcf8] px-4 py-5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#eef5dc] text-accent-strong">
              <Icon name="shield" size={16} />
            </div>
            <div>
              <div className="font-mono text-[12px] font-semibold text-ink">No active keys</div>
              <div className="mt-0.5 text-[12px] text-ink-soft">Create a scoped key below to start using the API.</div>
            </div>
          </div>
        )}

        <div className="mt-5 rounded-[10px] border border-line bg-panel p-4 sm:p-5">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <div className="micro-label text-ink-faint">create a new key</div>
              <div className="mt-1 text-[12px] text-ink-soft">Choose only the permissions this integration needs.</div>
            </div>
            <span className="font-mono text-[10.5px] text-ink-faint" aria-live="polite">
              {selectedScopes.length} scope{selectedScopes.length === 1 ? "" : "s"} selected
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {SCOPE_OPTIONS.map((opt) => {
              const on = selectedScopes.includes(opt.value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  title={opt.desc}
                  aria-pressed={on}
                  aria-label={`${opt.label} scope: ${on ? "selected" : "not selected"}. ${opt.desc}`}
                  onClick={() => toggleScope(opt.value)}
                  className={`rounded-[7px] border px-2.5 py-1.5 font-mono text-[11px] transition-colors ${
                    on
                      ? "border-accent-strong bg-accent-soft text-accent-strong"
                      : "border-line bg-white text-ink-soft hover:border-ink"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <span className="text-[11px] text-ink-faint">You can rotate or revoke keys at any time.</span>
            <Button variant="primary" size="sm" disabled={issuing} onClick={() => void handleIssue()}>
              <Icon name="plus" size={13} />
              {issuing ? "creating…" : "create key"}
            </Button>
          </div>
        </div>
      </div>

      <div className="card order-1 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3 sm:flex-nowrap">
          <div className="min-w-0 flex-1">
            <SectionHeading icon="zap" title="MCP server" info="Connect interactively with OAuth 2.1 or authenticate automation with a scoped API key. The hosted client never receives your password." />
          </div>
          <span className={`flex max-w-full shrink-0 items-center gap-1.5 break-all rounded-full border px-2.5 py-1 font-mono text-[10px] font-medium ${hasRealSession ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${hasRealSession ? "bg-emerald-500" : "bg-amber-500"}`} />
            {hasRealSession ? `signed in · ${user?.email || "dashboard session"}` : "sign-in required"}
          </span>
        </div>

        <div className="mb-4 mt-4">
          <div className="rounded-[10px] border border-line bg-panel px-4 py-3">
            <div className="mb-1.5 flex items-center gap-1.5">
              <span className="micro-label text-ink-faint">remote · http</span>
              <Pill tone="success">OAuth 2.1 + API key</Pill>
            </div>
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 break-all font-mono text-[13px] font-medium leading-relaxed">
                {mcpRemoteUrl}
              </span>
              <CopyButton value={mcpRemoteUrl} label="MCP server URL" />
            </div>
            <div className="mt-1.5 text-[10.5px] text-ink-faint">
              Interactive clients open this URL to sign in and approve
              scopes. Automation sends a scoped API key as a bearer header
              instead — pick a mode below.
            </div>
          </div>
        </div>

        <div className="mb-5 rounded-[10px] border border-dashed border-line bg-panel p-4">
          <McpClientPicker onSelect={setConnectClient} renderLogo={(icon) => <McpClientLogo name={icon} />} />
        </div>

        <div className="mb-5 rounded-[10px] border border-line bg-panel px-4 py-3.5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className="micro-label text-ink-faint">
              {mcpAuthMode === "oauth" ? "OAuth connection · browser sign-in" : "API key connection · unattended automation"}
            </span>
            <div role="tablist" aria-label="MCP connection method" className="inline-flex max-w-full flex-wrap rounded-[8px] border border-line bg-white p-0.5">
              <button
                type="button"
                id="mcp-oauth-tab"
                role="tab"
                onClick={() => setMcpAuthMode("oauth")}
                aria-selected={mcpAuthMode === "oauth"}
                aria-controls="mcp-connection-panel"
                className={`rounded-[6px] px-2.5 py-1 font-mono text-[11px] font-medium transition-colors ${
                  mcpAuthMode === "oauth" ? "bg-[#eef5dc] text-accent-strong" : "text-ink-faint hover:text-ink-soft"
                }`}
              >
                interactive · OAuth
              </button>
              <button
                type="button"
                id="mcp-apikey-tab"
                role="tab"
                onClick={() => setMcpAuthMode("apikey")}
                aria-selected={mcpAuthMode === "apikey"}
                aria-controls="mcp-connection-panel"
                className={`rounded-[6px] px-2.5 py-1 font-mono text-[11px] font-medium transition-colors ${
                  mcpAuthMode === "apikey" ? "bg-[#eef5dc] text-accent-strong" : "text-ink-faint hover:text-ink-soft"
                }`}
              >
                automation · API key
              </button>
            </div>
          </div>

          <div id="mcp-connection-panel" role="tabpanel" aria-labelledby={mcpAuthMode === "oauth" ? "mcp-oauth-tab" : "mcp-apikey-tab"}>
            {mcpAuthMode === "oauth" ? (
              <div className="grid grid-cols-1 gap-3 text-[12px] text-ink-soft sm:grid-cols-3">
              {[
                ["01", "Sign in", "Use your DataBounty dashboard account."],
                ["02", "Approve access", "Choose read, contribute, validate, or artifact scopes."],
                ["03", "Connect client", "Return to Claude, Cursor, or another MCP client."],
              ].map(([step, title, body]) => (
                <div key={step} className="flex gap-2.5">
                  <span className="font-mono text-[11px] font-semibold text-accent-strong">{step}</span>
                  <span><strong className="font-mono text-[11px] text-ink">{title}</strong><br />{body}</span>
                </div>
              ))}
              </div>
            ) : (
              <div>
              <p className="mb-2.5 text-[12px] text-ink-soft">
                No browser sign-in for unattended clients. Issue a scoped
                key, drop it into your client&rsquo;s MCP config below, and it
                authenticates on every request via a bearer header.
              </p>

              {activeKeys.length === 0 ? (
                <a
                  href="#api-keys"
                  className="mb-3 inline-flex items-center gap-1.5 rounded-[8px] border border-accent-soft-border bg-accent-soft px-3 py-1.5 font-mono text-[11.5px] font-medium text-accent-strong hover:border-accent-strong"
                >
                  <Icon name="shield" size={12} />
                  create your first API key ↓
                </a>
              ) : (
                <div className="mb-3 flex items-center gap-1.5 font-mono text-[11.5px] text-ink-faint">
                  <Icon name="check" size={12} className="text-emerald-600" />
                  you have {activeKeys.length} active key{activeKeys.length === 1 ? "" : "s"} —{" "}
                  <a href="#api-keys" className="font-medium text-accent-strong hover:underline">manage them ↓</a>
                </div>
              )}

              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="micro-label text-ink-faint">
                  paste this into your client&rsquo;s MCP config
                </span>
                <CopyButton value={remoteMcpConfig(mcpRemoteUrl)} label="remote MCP config" />
              </div>
              <CodeBlock label="mcp.json" code={remoteMcpConfig(mcpRemoteUrl)} />
              </div>
            )}
          </div>
        </div>

        {mcpGrants.length > 0 && (
          <div className="mb-5 rounded-[10px] border border-line px-4 py-3.5">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="micro-label text-ink-faint">connected MCP clients</div>
              {mcpGrants.length > 1 && (
                <Button variant="danger" size="sm" disabled={revokingAll} onClick={() => setRevokeAllOpen(true)}>
                  {revokingAll ? "disconnecting…" : "disconnect all"}
                </Button>
              )}
            </div>
            <div className="divide-y divide-line">
              {mcpGrants.map((grant) => (
                <div key={grant.clientId} className="flex flex-wrap items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[12px] font-semibold text-ink">{grant.clientName}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {grant.scopes.map((scope) => <Pill key={scope} tone="neutral">{scope}</Pill>)}
                      <span className="text-[10.5px] text-ink-faint">last authorized {fmtDate(grant.lastUsedAt)}</span>
                    </div>
                  </div>
                  <Button variant="secondary" size="sm" disabled={revokingGrant === grant.clientId} onClick={() => void handleRevokeGrant(grant.clientId)}>
                    {revokingGrant === grant.clientId ? "revoking…" : "revoke access"}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <button
              type="button"
              aria-expanded={mcpToolsOpen}
              onMouseDown={(event) => event.preventDefault()}
              onClick={toggleMcpTools}
              className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint transition-colors hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-[#aebd82]"
            >
              tools · {surface ? `${surface.mcpTools.length} live over remote transport` : surfaceError ? "unavailable" : "loading…"}
              <Icon name="chevron-right" size={13} className={`transition-transform duration-200 ${mcpToolsOpen ? "rotate-90" : "rotate-0"}`} />
            </button>
          </div>
          <div aria-hidden={!mcpToolsOpen} className={`grid overflow-hidden transition-[grid-template-rows,margin,opacity] duration-200 ease-out ${mcpToolsOpen ? "mt-2 grid-rows-[1fr] opacity-100" : "mt-0 grid-rows-[0fr] opacity-0 pointer-events-none"}`}>
            <div className="min-h-0">
              {surfaceError && !surface && (
                <div className="mb-2 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 font-sans text-[12.5px] text-amber-800" role="alert">
                  <span>Couldn&apos;t load the tool list, so it isn&apos;t shown here. The MCP server itself is unaffected.</span>
                  <Button variant="secondary" size="sm" onClick={() => void loadSurface()}>
                    retry
                  </Button>
                </div>
              )}
              <div className="grid grid-cols-1 gap-y-2 font-mono text-[12.5px]">
              {(surface?.mcpTools ?? []).map((t) => (
                <div key={t.name} className={`group relative min-w-0 overflow-hidden rounded-[8px] border transition-colors ${expandedMcpTool === t.name ? "border-[#aebd82] bg-[#fbfcf8]" : "border-line bg-white hover:border-[#cbd7a7]"}`}>
                  <button
                    type="button"
                    aria-expanded={expandedMcpTool === t.name}
                    aria-label={`${expandedMcpTool === t.name ? "Hide" : "Show"} details for ${t.name}`}
                    onClick={() => setExpandedMcpTool((current) => current === t.name ? null : t.name)}
                    className="block w-full px-3 py-2 pr-16 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#aebd82]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium text-accent-strong">{t.name}</span>
                      <Icon name={expandedMcpTool === t.name ? "chevron-down" : "chevron-right"} size={14} className="shrink-0 text-ink-faint transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-accent-strong" />
                    </div>
                    {expandedMcpTool === t.name && (
                      <div className="mt-2 flex items-start gap-2 border-t border-line pt-2">
                        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${SCOPE_TONE[t.scope]}`}>{t.scope}</span>
                        <span className="min-w-0 font-sans text-[11.5px] leading-relaxed text-ink-soft">{t.description}</span>
                      </div>
                    )}
                  </button>
                  <div className="absolute right-8 top-2 z-10">
                    <CopyButton value={t.name} label={`tool name ${t.name}`} iconOnly />
                  </div>
                </div>
              ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="order-2 mt-6 rounded-xl border border-line bg-panel p-5">
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
          <div className="flex items-start gap-2.5">
            <Icon name="clock" size={15} className="mt-0.5 shrink-0 text-ink-faint" strokeWidth={2} />
            <div>
              <div className="font-mono text-[12.5px] font-bold">Rate limits</div>
              <div className="mt-0.5 text-[12px] text-ink-soft">
                {rateLimitPerMinute} requests / minute per key. Bursts return{" "}
                <span className="font-mono">429</span> with a{" "}
                <span className="font-mono">Retry-After</span> header.
              </div>
            </div>
          </div>
          <div className="flex items-start gap-2.5">
            <Icon name="layers" size={15} className="mt-0.5 shrink-0 text-ink-faint" strokeWidth={2} />
            <div>
              <div className="font-mono text-[12.5px] font-bold">Same pipeline</div>
              <div className="mt-0.5 text-[12px] text-ink-soft">
                Programmatic submissions run the identical verification pipeline:
                dedupe → AI attribution scan → sandboxed tests →{" "}
                {llmValidationEnabled ? "LLM → human validator audit." : "human validator audit."}
              </div>
            </div>
          </div>
          <div className="flex items-start gap-2.5">
            <Icon name="file" size={15} className="mt-0.5 shrink-0 text-ink-faint" strokeWidth={2} />
            <div>
              <div className="font-mono text-[12.5px] font-bold">Full docs</div>
              <div className="mt-0.5 text-[12px] text-ink-soft">
                Complete reference, schemas, and SDKs — everything on this page is
                the full reference for now.{" "}
                <button
                  type="button"
                  onClick={() => setDocsComingSoonOpen(true)}
                  className="inline-flex items-center gap-1 font-mono text-accent-strong hover:underline"
                >
                  docs.databounty.io
                  <Icon name="external" size={11} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <RevealKeyModal issued={revealedIssue} onClose={() => setRevealedIssue(null)} />

      <ConnectClientModal key={connectClient?.name} client={connectClient} mcpRemoteUrl={mcpRemoteUrl} onCheckAuthorization={checkMcpAuthorization} onClose={() => setConnectClient(null)} />

      <ComingSoonDialog
        open={docsComingSoonOpen}
        title="Standalone docs site coming soon"
        description="docs.databounty.io isn't live yet. Until it ships, this page — endpoints, MCP tools, rate limits, and code samples — is the full API reference."
        onClose={() => setDocsComingSoonOpen(false)}
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        title="Revoke this API key?"
        description={
          revokeTarget
            ? `${revokeTarget.keyPrefix}•••• will stop working immediately. Any in-flight request using it fails on its next call — this can't be undone.`
            : ""
        }
        confirmLabel="Revoke"
        danger
        onConfirm={() => void handleRevoke()}
        onCancel={() => setRevokeTarget(null)}
      />

      <ConfirmDialog
        open={revokeAllOpen}
        title="Disconnect all MCP clients?"
        description={`Every connected client (${mcpGrants.length}) stops working immediately and must sign in again to reconnect.`}
        confirmLabel="Disconnect all"
        danger
        confirmDisabled={revokingAll}
        onConfirm={() => void handleRevokeAll()}
        onCancel={() => setRevokeAllOpen(false)}
      />
    </div>
  );
}

export default function DevelopersPage() {
  return (
    <Suspense fallback={<div className="font-mono text-xs text-ink-soft">Loading developer settings…</div>}>
      <DevelopersView />
    </Suspense>
  );
}
