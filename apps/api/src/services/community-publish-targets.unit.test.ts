// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildFilesForTarget, gitHubDatasetCard, datasetCard,
  applyAttachmentCap, attachmentPathsBySubmission, type PublishAttachment,
} from "./community-publish.js";
import { datasetLicense, BUNDLED_LICENSE_IDS } from "../lib/publication/license-texts.js";

/** Minimal stand-ins. These assert the SHAPE of what gets published, which is
 * pure given a bounty + manifest — no database needed. */
const bounty = {
  id: "b1",
  title: "SQL migration fixes",
  description: "Broken migrations paired with their fix.",
  language: "SQL",
  framework: "Postgres",
  communityLicense: "CC-BY-4.0",
  communityLicenseUrl: "https://creativecommons.org/licenses/by/4.0/",
} as unknown as Parameters<typeof buildFilesForTarget>[1];

const manifest = {
  bountyId: "b1",
  title: "SQL migration fixes",
  license: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  language: "SQL",
  framework: "Postgres",
  acceptedItems: 42,
  generatedAt: "2026-09-04T00:00:00.000Z",
  contributors: { credited: ["ada"], anonymizedCount: 2 },
  attachments: { resolved: 0, published: 0 },
} as unknown as Parameters<typeof buildFilesForTarget>[2];

const paths = (target: "huggingface" | "github") =>
  buildFilesForTarget(target, bounty, manifest, "{}\n").map((f) => f.path).sort();

describe("license-texts", () => {
  it("bundles the four licences a community bounty can carry", () => {
    expect([...BUNDLED_LICENSE_IDS].sort()).toEqual(["CC-BY-4.0", "CC-BY-SA-4.0", "CC0-1.0", "ODC-By-1.0"]);
  });

  it("looks up case-insensitively and returns null for anything unbundled", () => {
    expect(datasetLicense("cc-by-4.0")?.spdx).toBe("CC-BY-4.0");
    expect(datasetLicense("WTFPL")).toBeNull();
    expect(datasetLicense(null)).toBeNull();
  });

  it("carries real legal text, not a pointer — GitHub detects a licence by matching it", () => {
    const cc = datasetLicense("CC-BY-4.0")!;
    expect(cc.text).toContain("Section 1 -- Definitions.");
    expect(cc.text).toContain("Section 8 -- Interpretation.");
    expect(cc.text.length).toBeGreaterThan(10_000);
  });
});

describe("buildFilesForTarget", () => {
  it("gives Hugging Face exactly the three files it had before", () => {
    expect(paths("huggingface")).toEqual(["README.md", "data/items.jsonl", "manifest.json"]);
  });

  it("gives GitHub a LICENSE and .gitattributes on top", () => {
    expect(paths("github")).toEqual([".gitattributes", "LICENSE", "README.md", "data/items.jsonl", "manifest.json"]);
  });

  it("publishes byte-identical data and manifest to both targets", () => {
    const hf = buildFilesForTarget("huggingface", bounty, manifest, '{"a":1}\n');
    const gh = buildFilesForTarget("github", bounty, manifest, '{"a":1}\n');
    for (const path of ["data/items.jsonl", "manifest.json"]) {
      const a = hf.find((f) => f.path === path)!.content;
      const b = gh.find((f) => f.path === path)!.content;
      expect(a.equals(b)).toBe(true);
    }
  });

  it("writes the licence verbatim to LICENSE", () => {
    const license = buildFilesForTarget("github", bounty, manifest, "").find((f) => f.path === "LICENSE")!;
    expect(license.content.toString()).toBe(datasetLicense("CC-BY-4.0")!.text);
  });

  it("omits LICENSE rather than guessing when the licence is not bundled", () => {
    const odd = { ...bounty, communityLicense: "Proprietary-1.0" } as typeof bounty;
    const files = buildFilesForTarget("github", odd, manifest, "");
    expect(files.map((f) => f.path)).not.toContain("LICENSE");
    expect(gitHubDatasetCard(odd, manifest)).toContain("Full text is not bundled");
  });
});

describe("gitHubDatasetCard", () => {
  const card = gitHubDatasetCard(bounty, manifest);

  it("carries no Hugging Face front matter", () => {
    expect(card.startsWith("---")).toBe(false);
    expect(card).not.toContain("size_categories:");
    expect(card).not.toContain("config_name");
    // the HF card still does, so the two are genuinely different documents
    expect(datasetCard(bounty, manifest).startsWith("---")).toBe(true);
  });

  it("does not claim attachments are missing now that they are published", () => {
    expect(card).not.toContain("are **not** included");
  });

  it("links LICENSE and names the licence", () => {
    expect(card).toContain("[`LICENSE`](LICENSE)");
    expect(card).toContain("Creative Commons Attribution 4.0 International");
  });

  it("renders contributor credit through the shared renderer", () => {
    expect(card).toContain("- @ada");
  });
});


const att = (id: string, size: number, field = "screenshot"): PublishAttachment => ({
  submissionId: id, fieldKey: field, path: `contributor-items/${id}/${field}-a1-shot.png`,
  storageKey: `k/${id}`, sizeBytes: size,
});

describe("attachment cap", () => {
  it("keeps what fits and drops the rest, on verified sizes before any read", () => {
    const kept = applyAttachmentCap([att("s1", 60), att("s2", 60), att("s3", 60)], 150);
    expect(kept.map((a) => a.submissionId)).toEqual(["s1", "s2"]);
  });

  it("never lets one oversize file consume the run", () => {
    const kept = applyAttachmentCap([att("big", 500), att("small", 10)], 100);
    expect(kept.map((a) => a.submissionId)).toEqual(["small"]);
  });

  it("is a no-op when everything fits", () => {
    const all = [att("s1", 1), att("s2", 2)];
    expect(applyAttachmentCap(all, 1_000)).toHaveLength(2);
  });
});

describe("attachment path map", () => {
  it("maps only the published subset, so an item cannot name a skipped file", () => {
    const map = attachmentPathsBySubmission([att("s1", 1), att("s1", 1, "logo"), att("s2", 1)]);
    expect(map.get("s1")!.get("screenshot")).toBe("data/contributor-items/s1/screenshot-a1-shot.png");
    expect(map.get("s1")!.get("logo")).toBe("data/contributor-items/s1/logo-a1-shot.png");
    expect(map.has("s3")).toBe(false);
  });
});

describe("attachments reach both targets identically", () => {
  const buffers = [{ path: "contributor-items/s1/screenshot-a1-shot.png", content: Buffer.from("PNGBYTES") }];
  const withAtt = { ...manifest, attachments: { resolved: 1, published: 1 } } as typeof manifest;

  it("pushes the file under data/ on Hugging Face and GitHub alike", () => {
    for (const target of ["huggingface", "github"] as const) {
      const files = buildFilesForTarget(target, bounty, withAtt, "{}\n", buffers);
      const file = files.find((f) => f.path === "data/contributor-items/s1/screenshot-a1-shot.png");
      expect(file, `${target} should carry the attachment`).toBeDefined();
      expect(file!.content.toString()).toBe("PNGBYTES");
    }
  });

  it("states a truncated upload set instead of implying the dataset is whole", () => {
    const partial = { ...manifest, attachments: { resolved: 9, published: 4 } } as typeof manifest;
    expect(gitHubDatasetCard(bounty, partial)).toContain("4 of 9 contributor files are included");
    expect(datasetCard(bounty, partial)).toContain("4 of 9 contributor files are included");
  });

  it("says nothing about attachments when a dataset has none", () => {
    expect(gitHubDatasetCard(bounty, manifest)).not.toContain("contributor-items");
  });
});
