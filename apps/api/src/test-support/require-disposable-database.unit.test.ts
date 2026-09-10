// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { requireDisposableDatabase } from "./require-disposable-database.js";

const local = (name: string) => `postgresql://postgres:pw@localhost:5432/${name}?schema=public`;

describe("requireDisposableDatabase", () => {
  it("allows the historical shared verification database", () => {
    expect(() => requireDisposableDatabase(local("databounty_community_parity_verify"))).not.toThrow();
  });

  // The whole point of the change: two sessions on their own copies at once.
  it("allows a per-session suffix of it", () => {
    expect(() =>
      requireDisposableDatabase(local("databounty_community_parity_verify_allflags_20260902")),
    ).not.toThrow();
  });

  it("allows any name carrying a disposable marker", () => {
    for (const n of ["community_test", "dbty_shadow", "anything_scratch", "foo_verify_2"]) {
      expect(() => requireDisposableDatabase(local(n)), n).not.toThrow();
    }
  });

  it("refuses the V1 local dev database by name", () => {
    expect(() => requireDisposableDatabase(local("databounty"))).toThrow(/real database/);
  });

  it("refuses the frozen staging snapshot", () => {
    expect(() => requireDisposableDatabase(local("databounty_staging_backup_20260902"))).toThrow(/real database/);
  });

  it("refuses an unmarked database even on localhost", () => {
    expect(() => requireDisposableDatabase(local("some_project_db"))).toThrow(/not marked as disposable/);
  });

  // This is the check that actually protects staging: the hosted pooler is
  // refused on host alone, before any name rule is consulted.
  it("refuses a non-local host outright", () => {
    expect(() =>
      requireDisposableDatabase(
        "postgresql://u:p@aws-1-ap-south-1.pooler.supabase.com:5432/databounty_community_parity_verify",
      ),
    ).toThrow(/non-local host/);
  });

  // `undefined` deliberately means "read process.env.DATABASE_URL" (the
  // default parameter), so it is NOT the way to test the unset case — under
  // vitest the env var is set, so nothing throws. This test asserted a throw
  // on `undefined` and failed for exactly that reason; the empty string is
  // the honest stand-in for "no URL", and the env fallback is covered
  // separately below.
  it("refuses an empty or unparseable URL", () => {
    expect(() => requireDisposableDatabase("")).toThrow(/is not set/);
    expect(() => requireDisposableDatabase("not-a-url")).toThrow(/parseable/);
  });

  it("falls back to DATABASE_URL when called with no argument", () => {
    const saved = process.env.DATABASE_URL;
    try {
      process.env.DATABASE_URL = local("databounty");
      expect(() => requireDisposableDatabase()).toThrow(/real database/);
      delete process.env.DATABASE_URL;
      expect(() => requireDisposableDatabase()).toThrow(/is not set/);
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });
});
