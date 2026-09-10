// SPDX-License-Identifier: Apache-2.0

import type { LlmFeature, LlmProviderName } from "./types.js";

/**
 * Audit sink. Ported from v1's `services/llm/audit.ts`. Every call emits one
 * record with HASHES of the prompt/output — never the raw content, never keys.
 * Pluggable so tests can swap it; the default is the Prisma-backed sink
 * (`audit-prisma.ts`) wired in `service.ts`.
 */
export interface LlmAuditRecord {
  feature: LlmFeature;
  provider: LlmProviderName;
  model: string;
  userId?: string;
  accountId?: string;
  promptHash: string;
  /** Which admin-editable system-prompt version framed this call. */
  promptVersion: string;
  outputHash: string;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  fallbackUsed: boolean;
  failoverUsed: boolean;
  latencyMs: number;
  ok: boolean;
  error?: string;
}

export interface LlmAuditSink {
  record(rec: LlmAuditRecord): Promise<void> | void;
}

/** Fallback sink — one structured line, no raw content. */
export const consoleAuditSink: LlmAuditSink = {
  record(rec) {
    console.info("[llm.audit]", JSON.stringify(rec));
  },
};

let sink: LlmAuditSink = consoleAuditSink;

export function setAuditSink(s: LlmAuditSink): void {
  sink = s;
}

export function auditSink(): LlmAuditSink {
  return sink;
}
