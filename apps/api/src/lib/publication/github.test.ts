// SPDX-License-Identifier: Apache-2.0

/**
 * Fail-closed contract for the GitHub provider — mirrors hugging-face.test.ts.
 * No live network calls: everything here fails before a `fetch` is ever
 * attempted, because the token/owner check runs first.
 */
import { describe, expect, it } from "vitest";
import { PublicationError } from "./errors.js";
import { GitHubProvider } from "./github.js";

describe("GitHubProvider — fail-closed when not configured", () => {
  it("isConfigured() returns false with an operator-facing reason when GITHUB_PUBLICATION_TOKEN is unset", async () => {
    const provider = new GitHubProvider();
    const result = await provider.isConfigured("some-owner");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/GITHUB_PUBLICATION_TOKEN/);
  });

  it("isConfigured() returns false with a reason when the owner is blank", async () => {
    const provider = new GitHubProvider();
    const result = await provider.isConfigured("");
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("publishDataset() throws a permanent PublicationError naming the missing token, without making any network call", async () => {
    const provider = new GitHubProvider();
    await expect(
      provider.publishDataset({
        repoId: "owner/dataset",
        files: [{ path: "README.md", content: Buffer.from("hello") }],
        commitMessage: "test",
      })
    ).rejects.toMatchObject({
      name: "PublicationError",
      permanent: true,
      message: expect.stringContaining("GITHUB_PUBLICATION_TOKEN"),
    });
  });

  it("publishDataset() rejection is an instance of PublicationError", async () => {
    const provider = new GitHubProvider();
    try {
      await provider.publishDataset({ repoId: "owner/dataset", files: [], commitMessage: "test" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PublicationError);
    }
  });

  it("unpublishDataset() also fails closed without a token", async () => {
    const provider = new GitHubProvider();
    await expect(provider.unpublishDataset({ repoId: "owner/dataset" })).rejects.toMatchObject({
      permanent: true,
      message: expect.stringContaining("GITHUB_PUBLICATION_TOKEN"),
    });
  });

  it("getDatasetStats() honestly reports null downloads (GitHub has no download counter)", async () => {
    const provider = new GitHubProvider();
    const stats = await provider.getDatasetStats("owner/dataset");
    expect(stats.downloads).toBeNull();
  });
});
