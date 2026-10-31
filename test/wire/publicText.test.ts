// Public evidence uses opaque IDs; exact private-coordinate checks take CI input.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical/index.js";

const root = new URL("../../", import.meta.url);
const PUBLIC_TEXTS = [
  "conformance/tp1-register.json", "conformance/tp1-provenance-ids.json",
  "docs/testnet-profile-tp1.md", "docs/dacs-seller-http-v1.md", "docs/about-the-testnet-release.md",
  "README.md", "test/wire/publicText.test.ts",
  ...readdirSync(new URL("src/wire/", root)).filter(name => name.endsWith(".ts")).map(name => `src/wire/${name}`),
];
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const INTERNAL_NAMES = new RegExp(`\\b(?:${[
  ["Ha", "yk"], ["Day", "break"], ["Co", "dex"], ["As", "tra"], ["Clau", "de worker"],
].map(parts => parts.join("")).join("|")})\\b`, "i");
const PRIVATE_COORDINATES: ReadonlyArray<readonly [string, RegExp]> = [
  ["a frontend commit citation", /\b[Ff]rontend\b[^\n]{0,80}?\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/],
  ["a frontend repository entry", /"repo"\s*:\s*"frontend"/],
  ["a frontend pull request", /\bfrontend\b\s*(?:PR\s*|pull request\s*)?#\d+/i],
];
const pluginSourceFiles = (text: string) => [...text.matchAll(new RegExp("[\\w./-]*\\." + "mjs\\b", "g"))]
  .map(m => m[0]).filter(name => !name.startsWith("scripts/wire/"));
const citationPattern = () => new RegExp("\\b" + "prov" + "-\\d{2}\\b", "g");
const citedIds = () => new Set(PUBLIC_TEXTS.flatMap(path => [...read(path).matchAll(citationPattern())].map(m => m[0])));

describe("public TP-1 and wire texts", () => {
  it("includes the guard itself in the published-text scan", () => {
    expect(PUBLIC_TEXTS).toContain("test/wire/publicText.test.ts");
    expect(PUBLIC_TEXTS.filter(path => path.startsWith("src/wire/")).length).toBeGreaterThanOrEqual(9);
  });
  it.each(PUBLIC_TEXTS)("%s contains no private source coordinate", path => {
    const text = read(path);
    for (const [what, pattern] of PRIVATE_COORDINATES) expect(pattern.exec(text)?.[0], `${path}: ${what}`).toBeUndefined();
    expect(pluginSourceFiles(text), `${path}: private source file`).toEqual([]);
  });
  it.each(PUBLIC_TEXTS)("%s uses public editorial wording", path => {
    expect(read(path)).not.toMatch(INTERNAL_NAMES);
    expect(read(path)).not.toMatch(/proposed[ ]to[ ]the[ ]Standard/i);
  });
  it("resolves every opaque citation against the public ID inventory", () => {
    const ids: string[] = JSON.parse(read("conformance/tp1-provenance-ids.json"));
    expect(new Set(ids).size).toBe(ids.length);
    const tokenPattern = new RegExp("\\b" + "prov" + "-[\\w-]*", "g");
    for (const path of PUBLIC_TEXTS) for (const [token] of read(path).matchAll(tokenPattern)) expect(ids, path).toContain(token);
    expect(citedIds().size).toBeGreaterThan(0);
  });
  const privateFile = process.env.DACS_TP1_PRIVATE_PROVENANCE;
  it.skipIf(!privateFile)("private CI input resolves IDs and supplies exact forbidden coordinates", () => {
    if (!privateFile) throw new Error("private provenance input required");
    const input: { entries: Record<string, { citations: Array<{ repo: string; commit: string; path: string }> }>; forbiddenCoordinates: string[] } = JSON.parse(readFileSync(privateFile, "utf8"));
    for (const id of citedIds()) {
      const entry = input.entries[id];
      expect(entry, `${id} resolves`).toBeDefined();
      if (!entry) throw new Error(`missing private citation ${id}`);
      expect(entry.citations.length).toBeGreaterThan(0);
      for (const c of entry.citations) expect([c.repo, c.commit, c.path].every(v => typeof v === "string" && v.length > 0)).toBe(true);
    }
    expect(input.forbiddenCoordinates.length).toBeGreaterThan(0);
    for (const path of PUBLIC_TEXTS) for (const coordinate of input.forbiddenCoordinates) {
      expect(coordinate.length).toBeGreaterThan(0);
      expect(read(path).includes(coordinate), `${path}: exact private coordinate`).toBe(false);
    }
  });
});

it("register local evidence exists at this prefix", () => {
  const walk = (value: unknown, key = "") => {
    if (typeof value === "string" && (key === "pinnedBy" || key === "manifest")) expect(existsSync(new URL(value, root)), value).toBe(true);
    else if (Array.isArray(value)) for (const v of value) walk(v, key);
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(JSON.parse(read("conformance/tp1-register.json")));
});
it.each(["L2", "G10"])("%s blocks publication until failed-payment handling is qualified", id => {
  const register: typeof import("../../conformance/tp1-register.json") = JSON.parse(read("conformance/tp1-register.json"));
  expect(register.rows.find(row => row.id === id)?.blocksPublication).toBe(true);
});
it("pins register identity, tuple and qualification references independently", () => {
  const register: typeof import("../../conformance/tp1-register.json") = JSON.parse(read("conformance/tp1-register.json"));
  expect(register.base.commit).toBe("d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20");
  expect(register.tuple).toEqual({ CORE: "0.3", "DACS-1": "0.7", "DACS-2": "0.6", "DACS-3": "0.5", "DACS-4": "0.8", "DACS-5": "0.5" });
  const digest = createHash("sha256").update(canonicalize(register.network.record)).digest("hex");
  expect(digest).toBe("5c234f784b8fbbb77a53886594dbdf3689fbbc336f04c2c930edfd57f225e330");
  expect(register.network.canonicalDigest).toBe(digest);
  const ids = ["L1", "L2", "L3", "L4", ...Array.from({ length: 12 }, (_, i) => `G${i + 1}`)];
  expect(register.rows.map(row => row.id)).toEqual(ids);
  for (const q of register.qualification) {
    expect(q.result).toBe("not checked");
    for (const id of q.rows) expect(ids).toContain(id);
  }
});
