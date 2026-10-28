import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
const sealModule = "../../scripts/acceptance-seal.mjs";
const { collectEvidence, sealProject } = await import(sealModule);
function linkedTree(kind: string) {
  const root = mkdtempSync(join(tmpdir(), "dacs-seal-directories-"));
  const actual = join(root, "actual"), source = join(actual, "output"), destination = join(root, "destination");
  mkdirSync(source, { recursive: true }); mkdirSync(destination);
  writeFileSync(join(source, "package.json"), "{}\n");
  const alias = join(root, "alias");
  symlinkSync(kind === "ancestor" || kind === "hidden-parent" ? actual : source, alias);
  const path = kind === "slash" ? alias + "/" : kind === "dot" ? alias + "/." : kind === "ancestor" ? alias + "/output" :
    kind === "hidden-parent" ? alias + "/../actual/output" : kind === "relative" ? relative(process.cwd(), alias) + "/." : alias;
  return { root, source, destination, path };
}

describe("all untrusted directory components", () => {
  it.each(["root", "slash", "dot", "ancestor", "hidden-parent", "relative"].flatMap(kind => ["collect", "seal"].map(mode => [kind, mode])))(
    "refuses %s source aliases in %s before copying", (kind, mode) => {
      const { root, source, destination, path } = linkedTree(kind!);
      try {
        const context = join(destination, "context");
        const run = () => mode === "collect" ? collectEvidence(path, destination, ["package.json"]) : sealProject(path, context, ["package.json"]);
        expect(run).toThrow("not a directory (or a link to one)");
        expect(readdirSync(destination)).toEqual([]);
        expect(readFileSync(join(source, "package.json"), "utf8")).toBe("{}\n");
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  it.each(["root", "slash", "dot", "ancestor", "hidden-parent", "relative"])(
    "refuses %s destination aliases before collecting", kind => {
      const { root, source, destination, path } = linkedTree(kind);
      try {
        writeFileSync(join(destination, "evidence.json"), "{}\n");
        expect(() => collectEvidence(destination, path, ["evidence.json"])).toThrow("not a directory (or a link to one)");
        expect(readdirSync(source)).toEqual(["package.json"]);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  it("refuses a linked context parent before creating a sealed tree", () => {
    const { root, source, destination, path } = linkedTree("slash");
    try {
      expect(() => sealProject(source, path + "/context", ["package.json"])).toThrow("not a directory (or a link to one)");
      expect(existsSync(join(source, "context"))).toBe(false);
      expect(readdirSync(destination)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("refuses a linked intermediate directory even for a listed node_modules file", () => {
    const { root, source, destination } = linkedTree("root");
    try {
      const external = join(root, "external"); mkdirSync(external); writeFileSync(join(external, "fixture"), "outside\n");
      symlinkSync(external, join(source, "node_modules"));
      expect(() => sealProject(source, join(destination, "context"), ["package.json", "node_modules/fixture"]))
        .toThrow("not a directory (or a link to one)");
      expect(existsSync(join(destination, "context/node_modules/fixture"))).toBe(false);
      expect(readFileSync(join(external, "fixture"), "utf8")).toBe("outside\n");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
