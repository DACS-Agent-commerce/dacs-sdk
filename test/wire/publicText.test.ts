// The public TP-1 and wire texts carry no coordinate in the private plugin
// repository, and every opaque provenance ID they cite resolves in the private
// provenance file when DACS_TP1_PRIVATE_PROVENANCE names it.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
/** Every file the SDK ships or tracks for TP-1 and the wire, as public text. */
const PUBLIC_TEXTS = [
  "conformance/tp1-register.json",
  "docs/testnet-profile-tp1.md",
  "docs/dacs-seller-http-v1.md",
  "docs/about-the-testnet-release.md",
  "README.md",
  ...readdirSync(new URL("src/wire/", root)).filter((name) => name.endsWith(".ts")).map((name) => `src/wire/${name}`),
];
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

// Fragments keep the forbidden names out of public source, including this guard.
const INTERNAL_NAMES = new RegExp(`\\b(?:${[
  ["Ha", "yk"], ["Day", "break"], ["Co", "dex"], ["As", "tra"], ["Clau", "de worker"],
].map((parts) => parts.join("")).join("|")})\\b`, "i");

/** A path, commit, ref or pull request in the private plugin repository. */
const PRIVATE_COORDINATES: ReadonlyArray<readonly [string, RegExp]> = [
  ["a plugin repository path", /\b(?:http-mcp|stdio-mcp|demo-v[12])\//],
  ["a plugin portal path", /\bpublic\/portal\//],
  ["a private source ref", /\brefs\/src\//],
  ["a pinned plugin commit", /\b(?:82bf8c4|ffef873|febba6c|a70a697|786aa1d|5274f18|02f7070|8a24e52)/],
  ["a frontend commit citation", /\b[Ff]rontend\b[^\n]{0,80}?\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/],
  ["a frontend repository entry", /"repo"\s*:\s*"frontend"/],
  ["a frontend pull request", /\bfrontend\b\s*(?:PR\s*|pull request\s*)?#\d+/i],
];
/** Plugin source files are .mjs; the SDK's own .mjs files are its wire scripts. */
const pluginSourceFiles = (text: string) => [...text.matchAll(/[\w./-]*\.mjs\b/g)].map((m) => m[0]).filter((name) => !name.startsWith("scripts/wire/"));

describe("public TP-1 and wire texts", () => {
  it("cover the register, the three documents, the README and src/wire", () => {
    expect(PUBLIC_TEXTS.filter((path) => path.startsWith("src/wire/")).length).toBeGreaterThanOrEqual(9);
  });

  it.each(PUBLIC_TEXTS)("%s names no path, commit, ref or pull request of the private plugin repository", (path) => {
    const text = read(path);
    for (const [what, pattern] of PRIVATE_COORDINATES) expect(pattern.exec(text)?.[0], `${path}: ${what}`).toBeUndefined();
    expect(pluginSourceFiles(text), `${path}: a plugin source file`).toEqual([]);
  });

  it.each(PUBLIC_TEXTS)("%s names no reviewer or person and no 'proposed to the Standard'", (path) => {
    const text = read(path);
    expect(text).not.toMatch(INTERNAL_NAMES);
    expect(text).not.toMatch(/proposed to the Standard/i);
  });

  it("cites only well-formed provenance IDs (prov-NN)", () => {
    for (const path of PUBLIC_TEXTS) {
      for (const [token] of read(path).matchAll(/\bprov-[\w-]*/g)) expect(token, path).toMatch(/^prov-\d{2}$/);
    }
  });

  const privateFile = process.env.DACS_TP1_PRIVATE_PROVENANCE;
  it.skipIf(!privateFile)(
    `private provenance: every prov-NN ID resolves in DACS_TP1_PRIVATE_PROVENANCE${privateFile ? "" : " (SKIPPED: DACS_TP1_PRIVATE_PROVENANCE is unset, so the private entries were not checked)"}`,
    () => {
      const entries = JSON.parse(readFileSync(privateFile!, "utf8")).entries as Record<string, { citations?: Array<Record<string, unknown>> }>;
      const cited = new Set(PUBLIC_TEXTS.flatMap((path) => [...read(path).matchAll(/\bprov-\d{2}\b/g)].map((m) => m[0])));
      expect(cited.size).toBeGreaterThan(0);
      for (const id of cited) {
        expect(entries[id], `${id} resolves`).toBeDefined();
        expect(entries[id]!.citations?.length, `${id} has citations`).toBeGreaterThan(0);
      }
      for (const [id, entry] of Object.entries(entries)) {
        expect(id).toMatch(/^prov-\d{2}$/);
        for (const c of entry.citations ?? []) {
          expect(typeof c.repo === "string" && typeof c.commit === "string" && typeof c.path === "string", `${id} citation`).toBe(true);
        }
      }
    },
  );
});
