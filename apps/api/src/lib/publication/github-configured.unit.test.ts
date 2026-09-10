// SPDX-License-Identifier: Apache-2.0

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const saved = {
  token: process.env.GITHUB_PUBLICATION_TOKEN,
  owner: process.env.GITHUB_PUBLICATION_OWNER,
  repo: process.env.GITHUB_PUBLICATION_REPO,
};

beforeAll(() => {
  process.env.GITHUB_PUBLICATION_TOKEN = "test-token-never-sent";
  process.env.GITHUB_PUBLICATION_OWNER = "Databounty-io";
  process.env.GITHUB_PUBLICATION_REPO = "databounty-datasets";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  if (saved.token === undefined) delete process.env.GITHUB_PUBLICATION_TOKEN;
  else process.env.GITHUB_PUBLICATION_TOKEN = saved.token;
  if (saved.owner === undefined) delete process.env.GITHUB_PUBLICATION_OWNER;
  else process.env.GITHUB_PUBLICATION_OWNER = saved.owner;
  if (saved.repo === undefined) delete process.env.GITHUB_PUBLICATION_REPO;
  else process.env.GITHUB_PUBLICATION_REPO = saved.repo;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Call = { method: string; path: string; body?: string };

function stubGitHub(refStatus = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.replace("https://api.github.com", "");
    calls.push({ method, path, body: typeof init.body === "string" ? init.body : undefined });

    if (method === "GET" && path === "/repos/Databounty-io/databounty-datasets") return json({ private: true });
    if (method === "GET" && path.endsWith("/git/ref/heads/main")) return json({ object: { sha: "parent-sha" } });
    if (method === "GET" && path.endsWith("/git/commits/parent-sha")) return json({ tree: { sha: "base-tree" } });
    if (method === "GET" && path.endsWith("/git/trees/base-tree?recursive=1")) {
      return json({
        tree: [
          { type: "blob", path: "README.md" },
          { type: "blob", path: "datasets/other-set/data/items.jsonl" },
          { type: "blob", path: "datasets/demo-set/old-file.txt" },
        ],
      });
    }
    if (method === "POST" && path.endsWith("/git/blobs")) return json({ sha: `blob-${calls.length}` });
    if (method === "POST" && path.endsWith("/git/trees")) return json({ sha: "new-tree" });
    if (method === "POST" && path.endsWith("/git/commits")) return json({ sha: "new-commit" });
    if (method === "PATCH" && path.endsWith("/git/refs/heads/main")) return json({}, refStatus);
    return json({});
  }));
  return calls;
}

describe("GitHubProvider configured shared-repository flow", () => {
  it("publishes one dataset folder without replacing another dataset and never force-updates main", async () => {
    const { GitHubProvider } = await import("./github.js");
    const calls = stubGitHub();

    const result = await new GitHubProvider().publishDataset({
      repoId: "Databounty-io/demo-set",
      files: [
        { path: "README.md", content: Buffer.from("# Demo") },
        { path: "data/items.jsonl", content: Buffer.from("{}\n") },
      ],
      commitMessage: "Publish Demo",
      private: false,
    });

    expect(result).toEqual({
      repoId: "Databounty-io/demo-set",
      url: "https://github.com/Databounty-io/databounty-datasets/tree/main/datasets/demo-set",
    });
    const tree = JSON.parse(calls.find((call) => call.method === "POST" && call.path.endsWith("/git/trees"))!.body!);
    expect(tree.base_tree).toBe("base-tree");
    expect(tree.tree.map((entry: { path: string }) => entry.path)).toEqual([
      "datasets/demo-set/README.md",
      "datasets/demo-set/data/items.jsonl",
      "datasets/demo-set/old-file.txt",
    ]);
    expect(tree.tree[2]).toMatchObject({ sha: null });
    expect(tree.tree.some((entry: { path: string }) => entry.path.includes("other-set"))).toBe(false);

    const update = calls.find((call) => call.method === "PATCH" && call.path.endsWith("/git/refs/heads/main"));
    expect(JSON.parse(update!.body!)).toEqual({ sha: "new-commit", force: false });
  });

  it("classifies a concurrent main-branch move as transient so the job retries from the new tree", async () => {
    const { GitHubProvider } = await import("./github.js");
    stubGitHub(422);

    await expect(new GitHubProvider().publishDataset({
      repoId: "Databounty-io/demo-set",
      files: [{ path: "README.md", content: Buffer.from("# Demo") }],
      commitMessage: "Publish Demo",
    })).rejects.toMatchObject({ permanent: false });
  });

  it("retracts only the selected dataset folder and uses the same non-force branch update", async () => {
    const { GitHubProvider } = await import("./github.js");
    const calls = stubGitHub();

    await expect(new GitHubProvider().unpublishDataset({ repoId: "Databounty-io/demo-set" })).resolves.toEqual({
      repoId: "Databounty-io/demo-set",
      mode: "folder_removed",
    });

    const tree = JSON.parse(calls.find((call) => call.method === "POST" && call.path.endsWith("/git/trees"))!.body!);
    expect(tree.tree).toEqual([
      { path: "datasets/demo-set/old-file.txt", mode: "100644", type: "blob", sha: null },
    ]);
    const update = calls.find((call) => call.method === "PATCH" && call.path.endsWith("/git/refs/heads/main"));
    expect(JSON.parse(update!.body!)).toEqual({ sha: "new-commit", force: false });
  });
});

/**
 * Branch+PR+merge landing path, used once `GITHUB_PUBLICATION_BRANCH_PROTECTED`
 * is on — see the class doc on `GitHubProvider` in github.ts for why a direct
 * PATCH to `refs/heads/main` (the flow covered above) stops working once the
 * shared repo grows branch protection.
 */
function stubGitHubPullRequestMode(mergeStatus = 200, mergeBody: unknown = { merged: true }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.replace("https://api.github.com", "");
    calls.push({ method, path, body: typeof init.body === "string" ? init.body : undefined });

    if (method === "GET" && path === "/repos/Databounty-io/databounty-datasets") return json({ private: true });
    if (method === "GET" && path.endsWith("/git/ref/heads/main")) return json({ object: { sha: "parent-sha" } });
    if (method === "GET" && path.endsWith("/git/commits/parent-sha")) return json({ tree: { sha: "base-tree" } });
    if (method === "GET" && path.endsWith("/git/trees/base-tree?recursive=1")) {
      return json({ tree: [{ type: "blob", path: "datasets/demo-set/old-file.txt" }] });
    }
    if (method === "POST" && path.endsWith("/git/blobs")) return json({ sha: `blob-${calls.length}` });
    if (method === "POST" && path.endsWith("/git/trees")) return json({ sha: "new-tree" });
    if (method === "POST" && path.endsWith("/git/commits")) return json({ sha: "new-commit" });
    if (method === "POST" && path.endsWith("/git/refs")) return json({ ref: JSON.parse(String(init.body)).ref });
    if (method === "POST" && path.endsWith("/pulls")) {
      return json({ number: 42, html_url: "https://github.com/Databounty-io/databounty-datasets/pull/42" });
    }
    if (method === "PUT" && path.endsWith("/pulls/42/merge")) return json(mergeBody, mergeStatus);
    if (method === "DELETE" && path.includes("/git/refs/heads/databounty-publish/")) return json({}, 204);
    return json({});
  }));
  return calls;
}

describe("GitHubProvider branch-protected (PR) landing path", () => {
  const savedFlag = process.env.GITHUB_PUBLICATION_BRANCH_PROTECTED;

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.GITHUB_PUBLICATION_BRANCH_PROTECTED;
    else process.env.GITHUB_PUBLICATION_BRANCH_PROTECTED = savedFlag;
  });

  it("direct-push behaviour is unchanged when the flag is unset", async () => {
    delete process.env.GITHUB_PUBLICATION_BRANCH_PROTECTED;
    vi.resetModules();
    const { GitHubProvider } = await import("./github.js");
    const calls = stubGitHub();

    await new GitHubProvider().publishDataset({
      repoId: "Databounty-io/demo-set",
      files: [{ path: "README.md", content: Buffer.from("# Demo") }],
      commitMessage: "Publish Demo",
    });

    expect(calls.some((call) => call.method === "PATCH" && call.path.endsWith("/git/refs/heads/main"))).toBe(true);
    expect(calls.some((call) => call.path.endsWith("/pulls"))).toBe(false);
  });

  it("publishes by creating a branch, opening a pull request, and merging it when the flag is on", async () => {
    process.env.GITHUB_PUBLICATION_BRANCH_PROTECTED = "true";
    vi.resetModules();
    const { GitHubProvider } = await import("./github.js");
    const calls = stubGitHubPullRequestMode();

    const result = await new GitHubProvider().publishDataset({
      repoId: "Databounty-io/demo-set",
      files: [{ path: "README.md", content: Buffer.from("# Demo") }],
      commitMessage: "Publish Demo",
    });

    expect(result).toEqual({
      repoId: "Databounty-io/demo-set",
      url: "https://github.com/Databounty-io/databounty-datasets/tree/main/datasets/demo-set",
    });
    expect(calls.some((call) => call.method === "PATCH" && call.path.endsWith("/git/refs/heads/main"))).toBe(false);

    const branchCreate = calls.find((call) => call.method === "POST" && call.path.endsWith("/git/refs"));
    expect(branchCreate).toBeTruthy();
    const branchBody = JSON.parse(branchCreate!.body!) as { ref: string; sha: string };
    expect(branchBody.ref).toMatch(/^refs\/heads\/databounty-publish\/demo-set-/);
    expect(branchBody.sha).toBe("new-commit");

    const prCreate = calls.find((call) => call.method === "POST" && call.path.endsWith("/pulls"));
    expect(prCreate).toBeTruthy();
    const prBody = JSON.parse(prCreate!.body!) as { base: string; head: string };
    expect(prBody.base).toBe("main");
    expect(prBody.head).toMatch(/^databounty-publish\/demo-set-/);

    expect(calls.some((call) => call.method === "PUT" && call.path.endsWith("/pulls/42/merge"))).toBe(true);
    expect(calls.some((call) => call.method === "DELETE" && call.path.includes("/git/refs/heads/databounty-publish/"))).toBe(true);
  });

  it("throws a transient PublicationError naming the pull request when GitHub reports the merge did not complete", async () => {
    process.env.GITHUB_PUBLICATION_BRANCH_PROTECTED = "true";
    vi.resetModules();
    const { GitHubProvider } = await import("./github.js");
    stubGitHubPullRequestMode(405, { merged: false, message: "Required status check has not passed" });

    await expect(
      new GitHubProvider().publishDataset({
        repoId: "Databounty-io/demo-set",
        files: [{ path: "README.md", content: Buffer.from("# Demo") }],
        commitMessage: "Publish Demo",
      })
    ).rejects.toMatchObject({
      name: "PublicationError",
      permanent: false,
      message: expect.stringMatching(/pull request.*(#42|pull\/42)/i),
    });
  });
});
