// SPDX-License-Identifier: Apache-2.0

/**
 * SEC-01 defense-in-depth regression: the local-disk driver must refuse every
 * traversal primitive in a storage key on its own, without relying on the key
 * generator in `services/artifacts.ts` having sanitised it first.
 *
 * The original check resolved the key and then asserted containment in the
 * overall storage ROOT, which is a weaker property than containment in the
 * individual artifact directory: `artifacts/kind/art_attacker/../../../
 * artifacts/kind/art_victim/proof.txt` resolves back inside the root and
 * overwrote another account's object. This file pins the pre-resolve
 * rejections that close that, and pins that a legitimate nested key still
 * round-trips.
 *
 * Real filesystem, no database, no network. Every test runs against a
 * disposable directory created by `mkdtemp` (unique by construction, so two
 * concurrent runs cannot collide) and removed afterwards — never the project's
 * own storage dir.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { LocalDiskDriver } from "./local.js";

const NUL = "\u0000";

describe("LocalDiskDriver key containment", () => {
  let sandbox: string;
  let root: string;
  let driver: LocalDiskDriver;

  beforeEach(async () => {
    // `sandbox` is the parent: it holds both the storage root and an
    // out-of-root "outside" file, so an escape is observable rather than just
    // asserted about.
    sandbox = await mkdtemp(join(tmpdir(), "databounty-local-containment-"));
    root = join(sandbox, "storage");
    await mkdir(root, { recursive: true });
    await writeFile(join(sandbox, "outside.txt"), "untouched");
    driver = new LocalDiskDriver(root);
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  const put = (key: string) => driver.put(key, Readable.from(Buffer.from("payload")), "text/plain");

  const rejected: Array<[string, string]> = [
    ["parent segment at the front", "../outside.txt"],
    ["parent segments in the middle", "artifacts/kind/art_attacker/../../../outside.txt"],
    // The SEC-01 shape: resolves back INSIDE the root, so the old root-only
    // check accepted it while it wrote into another artifact's directory.
    [
      "parent segments that resolve back inside the root but outside the artifact dir",
      "artifacts/submission_attachment/art_attacker/../../../artifacts/submission_attachment/art_victim/proof.txt",
    ],
    ["a bare parent key", ".."],
    ["a single-dot segment", "artifacts/./kind/f.txt"],
    ["a trailing parent segment", "artifacts/kind/.."],
    ["a Windows parent segment", "..\\outside.txt"],
    ["a backslash separator", "artifacts\\kind\\f.txt"],
    ["an absolute POSIX key", "/etc/passwd"],
    ["an absolute key inside the sandbox", join(tmpdir(), "absolute.txt")],
    ["a Windows drive prefix", "C:/Windows/system.ini"],
    ["a lowercase drive prefix", "c:outside.txt"],
    ["a NUL byte", `artifacts/kind/f.txt${NUL}.png`],
    ["a NUL byte truncating a traversal", `../outside.txt${NUL}safe`],
    ["a control character", "artifacts/kind/f\u001b.txt"],
    ["a DEL character", "artifacts/kind/f\u007f.txt"],
    ["an encoded separator", "artifacts%2f..%2foutside.txt"],
    ["encoded dot segments", "artifacts/kind/%2e%2e/outside.txt"],
    ["an encoded backslash", "artifacts%5c..%5coutside.txt"],
    ["an empty segment", "artifacts//kind/f.txt"],
    ["a leading separator", "/artifacts/kind/f.txt"],
    ["the empty key", ""],
    ["an over-long key", `artifacts/kind/${"a".repeat(2000)}.txt`],
    ["the root itself", "."],
  ];

  for (const [label, key] of rejected) {
    it(`put() refuses ${label}`, async () => {
      await expect(put(key)).rejects.toThrow(/escapes root/);
      // pathFor() throws before any mkdir/write, so an intact sandbox is the
      // proof nothing landed outside the root.
      expect(await readFile(join(sandbox, "outside.txt"), "utf8")).toBe("untouched");
      expect(await readdir(root)).toEqual([]);
    });

    it(`get() refuses ${label}`, async () => {
      await expect(driver.get(key)).rejects.toThrow(/escapes root/);
    });

    it(`head() refuses ${label}`, async () => {
      await expect(driver.head(key)).rejects.toThrow(/escapes root/);
    });

    it(`remove() refuses ${label}`, async () => {
      await expect(driver.remove(key)).rejects.toThrow(/escapes root/);
      expect(await readFile(join(sandbox, "outside.txt"), "utf8")).toBe("untouched");
    });
  }

  it("does not let a traversal key clobber another artifact's object", async () => {
    const victim = "artifacts/submission_attachment/art_victim/proof.txt";
    await driver.put(victim, Readable.from(Buffer.from("original victim content")), "text/plain");

    const attack = `artifacts/submission_attachment/art_attacker/../../../${victim}`;
    await expect(put(attack)).rejects.toThrow(/escapes root/);

    expect(await readFile(join(root, victim), "utf8")).toBe("original victim content");
  });

  it("still round-trips a legitimate nested key through put/get/head/remove", async () => {
    const key = "artifacts/submission_attachment/art_0123456789abcdef/my-file.name_1.txt";
    const bytes = Buffer.from("legitimate nested payload");

    const stored = await driver.put(key, Readable.from(bytes), "text/plain");
    expect(stored.sizeBytes).toBe(bytes.length);

    const chunks: Buffer[] = [];
    for await (const chunk of await driver.get(key)) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks)).toEqual(bytes);

    expect((await driver.head(key)).sizeBytes).toBe(bytes.length);

    await driver.remove(key);
    await expect(driver.get(key)).rejects.toThrow();
  });

  it("accepts a key at the maximum generated shape (120-char filename segment)", async () => {
    const key = `artifacts/submission_attachment/art_0123456789abcdef/${"a".repeat(116)}.txt`;
    await expect(put(key)).resolves.toMatchObject({ sizeBytes: 7 });
  });

  it("does not treat a sibling directory sharing the root's name prefix as inside the root", async () => {
    // `<sandbox>/storage-public` starts with `<sandbox>/storage`, so a bare
    // `startsWith` containment check would accept an escape into it.
    await mkdir(join(sandbox, "storage-public"), { recursive: true });
    await writeFile(join(sandbox, "storage-public", "leak.txt"), "untouched");

    await expect(put("../storage-public/leak.txt")).rejects.toThrow(/escapes root/);
    expect(await readFile(join(sandbox, "storage-public", "leak.txt"), "utf8")).toBe("untouched");
  });
});
