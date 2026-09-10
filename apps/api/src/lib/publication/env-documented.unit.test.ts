// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The publication adapters read `process.env` directly, so nothing forces a
 * new variable to reach `.env.example`. It did drift: `GITHUB_PUBLICATION_*`
 * shipped working but undocumented, and `HUGGINGFACE_API_TOKEN` was first
 * documented under the wrong name — a self-hoster following the example file
 * would set a variable nothing reads and see "not configured" with no clue why.
 *
 * This asserts the example file mentions every variable the adapters read.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), "utf8");

describe(".env.example documents the publication variables", () => {
  const example = read("../../../.env.example");
  const sources = ["./hugging-face.ts", "./github.ts", "./index.ts"].map(read).join("\n");
  const referenced = [...new Set([...sources.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]!))];

  it("reads at least the four credentials publishing needs", () => {
    for (const name of ["HUGGINGFACE_API_TOKEN", "HUGGINGFACE_NAMESPACE", "GITHUB_PUBLICATION_TOKEN", "GITHUB_PUBLICATION_OWNER"]) {
      expect(referenced, `${name} should be read by an adapter`).toContain(name);
    }
  });

  it("documents every variable the adapters read", () => {
    const missing = referenced.filter((name) => !example.includes(name));
    expect(missing, `undocumented in .env.example: ${missing.join(", ")}`).toEqual([]);
  });
});
