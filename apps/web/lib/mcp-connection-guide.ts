// SPDX-License-Identifier: Apache-2.0

export type McpClientIcon = "claude" | "openclaw" | "chatgpt" | "codex" | "cursor" | "windsurf" | "code";

export type McpClient = {
  name: string;
  note: string;
  icon: McpClientIcon;
  auth: "OAuth" | "API key" | "OAuth or API key";
};

export type McpConnectionGuide = {
  steps: string[];
  label: string;
  code: string;
  keyRequired: boolean;
};

export type McpConnectionAuth = "oauth" | "apikey";

export const MCP_CLIENTS: McpClient[] = [
  { name: "Claude Desktop", note: "Settings → Developer → Edit Config", icon: "claude", auth: "OAuth or API key" },
  { name: "Codex", note: "open ~/.codex/config.toml or Settings → MCP servers", icon: "codex", auth: "OAuth or API key" },
  { name: "Claude Code", note: "run the command below in your terminal", icon: "claude", auth: "OAuth or API key" },
  { name: "Cursor", note: "create .cursor/mcp.json in your project", icon: "cursor", auth: "OAuth or API key" },
  { name: "Windsurf", note: "open ~/.codeium/windsurf/mcp_config.json", icon: "windsurf", auth: "OAuth or API key" },
  { name: "OpenClaw", note: "add the server in openclaw.json or Settings → MCP", icon: "openclaw", auth: "API key" },
  { name: "ChatGPT", note: "Workspace settings → Apps → Create", icon: "chatgpt", auth: "OAuth" },
  { name: "VS Code (Cline / Continue)", note: "open your extension's MCP settings", icon: "code", auth: "OAuth or API key" },
];

export function remoteMcpConfig(remoteUrl: string, includeApiKey = true): string {
  return `{
  "mcpServers": {
    "databounty": {
      "url": "${remoteUrl}"${includeApiKey ? `,
      "headers": {
        "Authorization": "Bearer db_live_sk_..."
      }` : ""}
    }
  }
}`;
}

export function connectionGuide(client: McpClient, mcpRemoteUrl: string, auth: McpConnectionAuth): McpConnectionGuide {
  if (client.name === "Claude Code") return {
    steps: auth === "oauth"
      ? ["Run this command to register DataBounty as a remote HTTP MCP server.", "No manual client registration is needed: Claude Code identifies itself automatically (a client ID metadata document or dynamic registration), and DataBounty accepts both.", "Run /mcp in Claude Code, select DataBounty, and complete the DataBounty browser sign-in.", "Return to Claude Code and ask it to call whoami. A successful account response is the final connection check."]
      : ["Create a scoped DataBounty API key.", "Run this command to register the remote HTTP MCP server with that key.", "Confirm the DataBounty tools appear in the /mcp server list."],
    label: "terminal command",
    code: auth === "oauth"
      ? `claude mcp add --transport http databounty ${mcpRemoteUrl}`
      : `claude mcp add --transport http databounty ${mcpRemoteUrl} --header "Authorization: Bearer db_live_sk_..."`,
    keyRequired: auth === "apikey",
  };
  if (client.name === "Codex") return {
    steps: auth === "oauth"
      ? ["Codex CLI: run the two commands below. The first registers the DataBounty MCP server; the second opens your browser for the DataBounty sign-in — approve the requested scopes there.", "Codex desktop app instead: open Plugins or MCP servers from the sidebar, select the + button to add a server (or Settings → MCP servers → Add server), choose Streamable HTTP, paste the DataBounty MCP URL, save, and select Authenticate. Alternatively add the config.toml entry shown below to ~/.codex/config.toml and restart Codex.", "Return to a Codex task and ask it to call whoami. A successful account response is the final connection check.", "If the DataBounty tools stop appearing later, run codex mcp login databounty again (or select Authenticate in the app) — Codex asks for a new sign-in whenever it cannot renew its stored credential, and reconnecting replaces it without touching your account or your work."]
      : ["Create a scoped DataBounty API key and export it as DATABOUNTY_API_KEY in your shell before starting Codex.", "Codex CLI: run the command below to register the server with that environment variable. Codex desktop app instead: add the config.toml entry shown below to ~/.codex/config.toml (or the trusted project's .codex/config.toml).", "Restart Codex to connect using the scoped API key, then confirm the DataBounty tools appear."],
    label: auth === "oauth" ? "terminal commands (or config.toml)" : "terminal command (or config.toml)",
    code: auth === "oauth"
      ? `# Codex CLI\ncodex mcp add databounty --url ${mcpRemoteUrl}\ncodex mcp login databounty\n\n# or: ~/.codex/config.toml\n[mcp_servers.databounty]\nurl = "${mcpRemoteUrl}"`
      : `# Codex CLI\ncodex mcp add databounty --url ${mcpRemoteUrl} --bearer-token-env-var DATABOUNTY_API_KEY\n\n# or: ~/.codex/config.toml\n[mcp_servers.databounty]\nurl = "${mcpRemoteUrl}"\nbearer_token_env_var = "DATABOUNTY_API_KEY"`,
    keyRequired: auth === "apikey",
  };
  if (client.name === "OpenClaw") return {
    steps: ["Add this server definition to OpenClaw's mcp.servers configuration, or use Settings → MCP.", "Replace the example value with a scoped DataBounty API key.", "Reload the OpenClaw MCP configuration, then use openclaw mcp doctor databounty --probe to verify the connection."],
    label: "openclaw.json entry",
    code: `{\n  "url": "${mcpRemoteUrl}",\n  "transport": "streamable-http",\n  "headers": { "Authorization": "Bearer db_live_sk_..." }\n}`,
    keyRequired: true,
  };
  if (client.name === "ChatGPT") return {
    steps: ["Sign in to the eligible ChatGPT Business, Enterprise, or Edu workspace.", "Open Plugins from the sidebar and click the + button in the top-right to add an app. If you do not see Plugins, ask a workspace admin to enable Developer mode.", "Choose a custom MCP app, paste the DataBounty remote MCP URL below, and save it.", "Test the OAuth sign-in, then publish or enable the app for the people who should be able to use DataBounty."],
    label: "remote MCP URL",
    code: mcpRemoteUrl,
    keyRequired: false,
  };
  return {
    steps: auth === "oauth"
      ? ["Open the location shown below in your client.", "Add this remote MCP configuration without a static credential.", "Save it, reconnect the server, and complete the client's OAuth sign-in prompt."]
      : ["Open the location shown below in your client.", "Add this remote MCP configuration and replace the example value with a scoped DataBounty API key.", "Save the configuration and reconnect the MCP server."],
    label: client.name === "Claude Desktop" ? "claude_desktop_config.json" : "mcp.json",
    code: remoteMcpConfig(mcpRemoteUrl, auth === "apikey"),
    keyRequired: auth === "apikey",
  };
}
