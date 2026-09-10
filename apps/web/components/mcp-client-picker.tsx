"use client";

// SPDX-License-Identifier: Apache-2.0

import { useRef } from "react";
import { MCP_CLIENTS, type McpClientIcon } from "@/lib/mcp-connection-guide";
import { Icon } from "./icons";
import { HorizontalScrollRail } from "./horizontal-scroll-rail";

export function McpClientPicker({
  onSelect,
  renderLogo,
  className = "",
}: {
  onSelect: (client: (typeof MCP_CLIENTS)[number]) => void;
  renderLogo: (icon: McpClientIcon) => React.ReactNode;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div className={className}>
      <div className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-accent-strong">
        <Icon name="code" size={14} /> work with MCP
      </div>
      <div ref={scrollRef} className="horizontal-scroll-area mt-3 grid grid-flow-col grid-rows-2 auto-cols-[12.5rem] gap-2 overflow-x-auto scroll-smooth pb-1" aria-label="Choose an MCP client to connect">
        {MCP_CLIENTS.map((client) => (
          <button key={client.name} type="button" onClick={() => onSelect(client)} className={`group flex w-full items-center gap-1.5 rounded-full border bg-white px-3 py-1.5 font-mono text-[11px] font-medium transition-colors hover:border-accent-strong hover:bg-[#f7faef] focus-visible:border-accent-strong ${client.name === "Claude Desktop" ? "border-[#aebd82] text-ink" : "border-line text-ink-soft"}`}>
            {renderLogo(client.icon)}
            <span className="min-w-0 truncate">{client.name}</span>
            <Icon name="chevron-right" size={12} className="ml-auto shrink-0 text-ink-faint transition-transform duration-150 group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5" />
          </button>
        ))}
      </div>
      <HorizontalScrollRail scrollRef={scrollRef} label="Scroll through supported MCP clients" className="mt-0.5" />
    </div>
  );
}
