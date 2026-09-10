"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons";

export interface AdminSearchSelectOption {
  value: string;
  label: string;
  detail?: string;
}

export function AdminSearchSelect({
  value,
  onChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Search options…",
  pageSize = 10,
  searchable = true,
  incremental = true,
  searchMode = "client",
  onSearchChange,
  hasMore = false,
  onLoadMore,
  loading = false,
  emptyLabel = "No matching options.",
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: AdminSearchSelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  pageSize?: number;
  /** Use false for compact fixed-option selectors such as enabled/disabled. */
  searchable?: boolean;
  /** Use false to render the complete (small) option list immediately. */
  incremental?: boolean;
  /** Server mode delegates filtering and paging to the caller. */
  searchMode?: "client" | "server";
  onSearchChange?: (query: string) => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
  loading?: boolean;
  emptyLabel?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const selected = options.find((option) => option.value === value);
  const filtered = useMemo(() => {
    if (searchMode === "server") return options;
    const term = search.trim().toLowerCase();
    return term ? options.filter((option) => `${option.label} ${option.value} ${option.detail ?? ""}`.toLowerCase().includes(term)) : options;
  }, [options, search, searchMode]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const rows = incremental ? filtered.slice(0, (page + 1) * pageSize) : filtered;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(0);
      if (searchMode === "server") onSearchChange?.(search);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [onSearchChange, search, searchMode]);
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);
  useEffect(() => { if (open && searchable) searchInput.current?.focus(); }, [open, searchable]);
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button type="button" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)} className="flex h-9 w-full items-center justify-between gap-3 rounded-lg border border-dark-line bg-dark px-3 font-mono text-left text-xs text-dark-text outline-none transition-colors hover:border-dark-hover focus:border-lime/60 disabled:cursor-not-allowed disabled:opacity-50">
        <span className="min-w-0 flex-1 truncate">{selected?.label ?? (value || placeholder)}</span><Icon name="chevron-down" size={15} strokeWidth={2} className={`shrink-0 text-dark-dim transition-transform duration-150 ${open ? "rotate-180 text-lime" : ""}`} />
      </button>
      {open && <div className="absolute z-30 mt-1 w-full min-w-0 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-dark-hover bg-dark-field shadow-2xl sm:min-w-[340px]">
        {searchable && <div className="border-b border-dark-line p-2"><input ref={searchInput} value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }} placeholder={searchPlaceholder} className="h-9 w-full rounded-lg border border-dark-line bg-dark px-3 font-mono text-xs text-dark-text outline-none focus:border-lime/60" /></div>}
        <div role="listbox" onScroll={(event) => { if (!incremental) return; const element = event.currentTarget; if (element.scrollTop + element.clientHeight >= element.scrollHeight - 32) { if (searchMode === "server") { if (hasMore && !loading) onLoadMore?.(); } else if (page + 1 < pages) setPage((current) => current + 1); } }} className="max-h-72 overscroll-contain overflow-y-auto p-1.5">
          {rows.map((option) => <button key={option.value} type="button" role="option" aria-selected={option.value === value} onClick={() => { onChange(option.value); setOpen(false); }} className={`w-full rounded-lg px-3 py-2 text-left transition-colors ${option.value === value ? "bg-lime/15 text-lime" : "text-dark-text hover:bg-dark-card"}`}><div className="truncate font-mono text-xs">{option.label}</div><div className="mt-0.5 truncate font-mono text-[10px] text-dark-dim">{option.detail ?? option.value}</div></button>)}
          {rows.length === 0 && !loading && <div className="px-3 py-5 text-center font-mono text-xs text-dark-dim">{emptyLabel}</div>}
          {loading && <div className="px-3 py-3 text-center font-mono text-xs text-dark-dim">Loading…</div>}
        </div>
        {incremental && <div className="border-t border-dark-line px-3 py-2 font-mono text-[10px] text-dark-dim">{searchMode === "server" ? `${rows.length} loaded${hasMore ? " · scroll to load more" : ""}` : `showing ${rows.length} of ${filtered.length} options${rows.length < filtered.length ? " · scroll to load more" : ""}`}</div>}
      </div>}
    </div>
  );
}
