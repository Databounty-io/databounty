// SPDX-License-Identifier: Apache-2.0

/**
 * Tier-1 stdio transport (v1 parity gap #24).
 *
 * v1 ships a `StdioServerTransport` entry point plus an `"mcp"` npm script;
 * this tree had neither, so an MCP client that speaks stdio could not connect
 * at all. These tests drive the real server over a real stdio pipe pair — no
 * mock transport — so what is asserted is what a desktop client would see.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { AuthMethod, ApiKeyScope } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { issueApiKey } from "../services/api-keys.js";
import { startStdioMcpServer } from "./stdio.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

const createdUserIds: string[] = [];
let rawKey: string;
let userId: string;
const originalEnvKey = process.env.DATABOUNTY_API_KEY;

/** stdio's transport binds to process.stdin/stdout. Swap in pipes so the test
 *  runner's own streams are untouched, and restore them afterwards. */
const realStdin = process.stdin;
const realStdout = process.stdout;

function withPipedStdio(): { restore: () => void } {
  const fakeIn = new PassThrough();
  const fakeOut = new PassThrough();
  fakeOut.resume();
  Object.defineProperty(process, "stdin", { value: fakeIn, configurable: true });
  Object.defineProperty(process, "stdout", { value: fakeOut, configurable: true });
  return {
    restore: () => {
      Object.defineProperty(process, "stdin", { value: realStdin, configurable: true });
      Object.defineProperty(process, "stdout", { value: realStdout, configurable: true });
      fakeIn.destroy();
      fakeOut.destroy();
    },
  };
}

let piped: { restore: () => void } | null = null;

beforeAll(async () => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const user = await prisma.user.create({
    data: {
      email: `stdio-${stamp}@example.com`,
      handle: `stdio${stamp}`.toLowerCase().slice(0, 20),
      displayName: "stdio parity",
      authMethod: AuthMethod.email,
      passwordHash: "not-used-in-these-tests",
      emailVerifiedAt: new Date(),
      onboarded: true,
    },
  });
  createdUserIds.push(user.id);
  userId = user.id;
  const issued = await issueApiKey({ userId: user.id, scopes: [ApiKeyScope.read] });
  rawKey = issued.rawKey;
});

afterEach(() => {
  piped?.restore();
  piped = null;
  if (originalEnvKey === undefined) delete process.env.DATABOUNTY_API_KEY;
  else process.env.DATABOUNTY_API_KEY = originalEnvKey;
});

afterAll(async () => {
  await prisma.apiKey.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("24 · stdio MCP transport", () => {
  it("refuses to start with no DATABOUNTY_API_KEY, naming the variable", async () => {
    delete process.env.DATABOUNTY_API_KEY;
    await expect(startStdioMcpServer()).rejects.toThrow(/DATABOUNTY_API_KEY is not set/);
  });

  it("refuses to start with a key the server does not accept — never silently unauthenticated", async () => {
    process.env.DATABOUNTY_API_KEY = "db_live_sk_not_a_real_key";
    await expect(startStdioMcpServer()).rejects.toThrow(/was not accepted/);
  });

  it("connects over a real stdio pipe and serves the tool catalog", async () => {
    process.env.DATABOUNTY_API_KEY = rawKey;
    piped = withPipedStdio();
    const server = await startStdioMcpServer();
    expect(server).toBeTruthy();
    await server.close();
  });

  it("runs tool calls as the environment credential's own principal, over the real pipe", async () => {
    process.env.DATABOUNTY_API_KEY = rawKey;
    const fakeIn = new PassThrough();
    const fakeOut = new PassThrough();
    Object.defineProperty(process, "stdin", { value: fakeIn, configurable: true });
    Object.defineProperty(process, "stdout", { value: fakeOut, configurable: true });
    piped = {
      restore: () => {
        Object.defineProperty(process, "stdin", { value: realStdin, configurable: true });
        Object.defineProperty(process, "stdout", { value: realStdout, configurable: true });
        fakeIn.destroy();
        fakeOut.destroy();
      },
    };

    const server = await startStdioMcpServer();

    const frames: Record<string, unknown>[] = [];
    let buffered = "";
    fakeOut.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let nl = buffered.indexOf("\n");
      while (nl !== -1) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (line) frames.push(JSON.parse(line));
        nl = buffered.indexOf("\n");
      }
    });

    const send = (msg: unknown) => fakeIn.write(`${JSON.stringify(msg)}\n`);
    const waitFor = async (id: number) => {
      for (let i = 0; i < 100; i += 1) {
        const hit = frames.find((f) => f.id === id);
        if (hit) return hit as { result?: any; error?: any };
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`no stdio response for id ${id}; saw ${JSON.stringify(frames)}`);
    };

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stdio-parity", version: "0" } },
    });
    await waitFor(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    // `whoami` is `read`-scoped — exactly the scope this key carries. A call
    // that reached the gate with NO principal would 401 instead.
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami", arguments: {} } });
    const called = await waitFor(2);
    expect(called.error, JSON.stringify(called.error)).toBeUndefined();
    expect(called.result.isError, called.result.content?.[0]?.text).toBeFalsy();
    expect(JSON.parse(called.result.content[0].text).id).toBe(userId);

    // ...and a tool outside the key's scopes is still refused, so the pinned
    // principal carries the key's REAL scopes rather than a blanket grant.
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "claim_handle", arguments: { handle: "stdioprobe" } } });
    const refused = await waitFor(3);
    expect(refused.result.isError).toBe(true);
    expect(String(refused.result.content[0].text)).toMatch(/scope/i);

    await server.close();
  });

  it("is reachable through the npm script v1 ships", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.mcp).toBe("tsx src/mcp/stdio.ts");
  });
});
