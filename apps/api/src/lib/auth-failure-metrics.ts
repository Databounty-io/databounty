// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

const WINDOW_MS = 5 * 60_000;
const ALERT_THRESHOLD = 20;
const MAX_TRACKED_IPS = 10_000;

const failuresByIp = new Map<string, number[]>();

type WarnLog = { warn: (obj: Record<string, unknown>, msg: string) => void };

export function recordApiKeyAuthFailure(ip: string, log: WarnLog): void {
  const now = Date.now();
  const recent = (failuresByIp.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  failuresByIp.set(ip, recent);

  if (recent.length === ALERT_THRESHOLD) {
    log.warn(
      { ip, failures: recent.length, windowMs: WINDOW_MS, store: "memory" },
      "repeated API key auth failures from one IP"
    );
  }

  if (failuresByIp.size > MAX_TRACKED_IPS) {
    for (const [key, timestamps] of failuresByIp) {
      const fresh = timestamps.filter((t) => now - t < WINDOW_MS);
      if (fresh.length === 0) failuresByIp.delete(key);
      else if (fresh.length !== timestamps.length) failuresByIp.set(key, fresh);
    }
  }
}

const LOCKOUT_THRESHOLD = 5;
const FAILURE_WINDOW_SEC = 60 * 60;
const LOCK_STEPS_SEC = [60, 120, 300, 600, 900];

export type LoginLockState = { locked: boolean; retryAfterSec: number };
const NOT_LOCKED: LoginLockState = { locked: false, retryAfterSec: 0 };

type MemoryLoginRecord = { failures: number; windowExpiresAt: number; lockedUntil: number };
const loginFailuresByAccount = new Map<string, MemoryLoginRecord>();
const MAX_TRACKED_ACCOUNTS = 50_000;

export function loginAccountKey(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 32);
}

function lockSecondsFor(failures: number): number {
  const step = Math.min(failures - LOCKOUT_THRESHOLD, LOCK_STEPS_SEC.length - 1);
  return LOCK_STEPS_SEC[Math.max(step, 0)] ?? 60;
}

function memoryRecord(key: string, now: number): MemoryLoginRecord {
  const existing = loginFailuresByAccount.get(key);
  if (existing && existing.windowExpiresAt > now) return existing;
  return { failures: 0, windowExpiresAt: now + FAILURE_WINDOW_SEC * 1000, lockedUntil: 0 };
}

export async function checkLoginLock(accountKey: string): Promise<LoginLockState> {
  const now = Date.now();
  const record = loginFailuresByAccount.get(accountKey);
  if (record && record.lockedUntil > now) {
    return { locked: true, retryAfterSec: Math.ceil((record.lockedUntil - now) / 1000) };
  }
  return NOT_LOCKED;
}

export async function recordLoginFailure(accountKey: string, log?: WarnLog): Promise<LoginLockState> {
  const now = Date.now();
  sweepExpiredAccounts(now);
  const record = memoryRecord(accountKey, now);
  record.failures += 1;
  loginFailuresByAccount.set(accountKey, record);

  if (record.failures < LOCKOUT_THRESHOLD) return NOT_LOCKED;

  const lockSec = lockSecondsFor(record.failures);
  const lockedUntil = now + lockSec * 1000;
  record.lockedUntil = lockedUntil;
  loginFailuresByAccount.set(accountKey, record);

  log?.warn(
    { accountKey, failures: record.failures, lockSec },
    "password login locked out after repeated failures"
  );
  return { locked: true, retryAfterSec: lockSec };
}

/**
 * Drop records whose failure window AND lockout have both elapsed.
 *
 * `MAX_TRACKED_ACCOUNTS` was declared when this file was written and then
 * referenced nowhere — the cap existed only as a number. `memoryRecord` starts
 * a fresh count for an expired record but never deletes one, and nothing else
 * sweeps, so every distinct email ever submitted to the login routes left a
 * permanent entry. The key space is unauthenticated and attacker-chosen, which
 * makes an unbounded map a memory-exhaustion path rather than untidiness. The
 * per-IP map next to it has enforced its own cap all along; this is the same
 * sweep, applied where it was missing.
 *
 * Only expired records go: an entry inside its window or still locked out is
 * live security state and must survive, or an attacker could evict their own
 * lockout by flooding the map.
 */
function sweepExpiredAccounts(now: number): void {
  if (loginFailuresByAccount.size <= MAX_TRACKED_ACCOUNTS) return;
  for (const [key, record] of loginFailuresByAccount) {
    if (record.windowExpiresAt <= now && record.lockedUntil <= now) loginFailuresByAccount.delete(key);
  }
}

export async function clearLoginFailures(accountKey: string): Promise<void> {
  loginFailuresByAccount.delete(accountKey);
}

export function __resetLoginFailureState(): void {
  loginFailuresByAccount.clear();
}
