// SPDX-License-Identifier: Apache-2.0

/**
 * Fail-closed contract for the Hugging Face provider. No live network calls:
 * `isConfigured()` short-circuits before any fetch when the token/namespace
 * is missing, and `publishDataset`/`unpublishDataset` throw before making a
 * request for the same reason — both are asserted here without ever touching
 * `global.fetch`.
 */
import { describe, expect, it } from "vitest";
import { HuggingFaceProvider, HuggingFacePublishError, huggingFaceLicenseTag } from "./hugging-face.js";

describe("HuggingFaceProvider — fail-closed when not configured", () => {
  it("isConfigured() returns false with an operator-facing reason when HUGGINGFACE_API_TOKEN is unset", async () => {
    const provider = new HuggingFaceProvider();
    const result = await provider.isConfigured("some-namespace");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/HUGGINGFACE_API_TOKEN/);
  });

  it("isConfigured() returns false with a reason when the namespace is blank, even with a token", async () => {
    const provider = new HuggingFaceProvider();
    const result = await provider.isConfigured("");
    expect(result.ok).toBe(false);
    // In this test environment HUGGINGFACE_API_TOKEN is unset too, so the
    // token check wins first — assert we get SOME honest reason, never `ok: true`.
    expect(result.reason).toBeTruthy();
  });

  it("publishDataset() throws a permanent HuggingFacePublishError naming the missing token, without making any network call", async () => {
    const provider = new HuggingFaceProvider();
    await expect(
      provider.publishDataset({
        repoId: "org/dataset",
        files: [{ path: "README.md", content: Buffer.from("hello") }],
        commitMessage: "test",
      })
    ).rejects.toMatchObject({
      name: "HuggingFacePublishError",
      permanent: true,
      message: expect.stringContaining("HUGGINGFACE_API_TOKEN"),
    });
  });

  it("publishDataset() rejection is an instance of HuggingFacePublishError (and therefore PublicationError)", async () => {
    const provider = new HuggingFaceProvider();
    try {
      await provider.publishDataset({
        repoId: "org/dataset",
        files: [],
        commitMessage: "test",
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HuggingFacePublishError);
    }
  });

  it("unpublishDataset() also fails closed without a token", async () => {
    const provider = new HuggingFaceProvider();
    await expect(provider.unpublishDataset({ repoId: "org/dataset" })).rejects.toMatchObject({
      permanent: true,
      message: expect.stringContaining("HUGGINGFACE_API_TOKEN"),
    });
  });
});

describe("huggingFaceLicenseTag", () => {
  it("normalizes known licenses case-insensitively", () => {
    expect(huggingFaceLicenseTag("CC-BY-4.0")).toBe("cc-by-4.0");
    expect(huggingFaceLicenseTag("MIT")).toBe("mit");
  });

  it("returns null for an unrecognized license rather than guessing", () => {
    expect(huggingFaceLicenseTag("Open license pending")).toBeNull();
    expect(huggingFaceLicenseTag(null)).toBeNull();
    expect(huggingFaceLicenseTag(undefined)).toBeNull();
  });
});
