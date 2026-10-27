import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
const sealModule = "../../scripts/acceptance-seal.mjs";
const { collectEvidence, sealProject } = await import(sealModule);
const ioModule = "../../scripts/acceptance-evidence-io.mjs";
const { EVIDENCE_MAX_BYTES } = await import(ioModule);

const roots: string[] = [];
const scratch = () => { const root = mkdtempSync(join(tmpdir(), "dacs-seal-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
// A host file a planted link points at; it must never be read into evidence or changed.
function hostSecret(root: string) {
  const path = join(root, "host-secret");
  writeFileSync(path, "host-only value\n");
  return path;
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const PROJECT_FILES: Record<string, string> = {
  "package.json": "{}\n", "package-lock.json": "{\"lockfileVersion\":3}\n", Dockerfile: "FROM node:20 AS build\nRUN npm ci\nFROM node:20\n",
  ".dockerignore": "**\n", "src/service.ts": "export {};\n", "data/buyer/.gitkeep": "", "secrets/README.md": "No keys here.\n",
};
function generatedProject(root: string) {
  const project = join(root, "gen", "one-click-agent");
  for (const [name, contents] of Object.entries(PROJECT_FILES)) {
    mkdirSync(dirname(join(project, name)), { recursive: true }); writeFileSync(join(project, name), contents, { mode: 0o600 });
  }
  chmodSync(join(project, "data/buyer"), 0o700);
  mkdirSync(join(project, "node_modules/left-pad"), { recursive: true }); writeFileSync(join(project, "node_modules/left-pad/index.js"), "");
  mkdirSync(join(root, "sealed"));
  return { project, context: join(root, "sealed", "context"), names: Object.keys(PROJECT_FILES) };
}

describe("evidence collection without following links", () => {
  function evidenceDirectories() {
    const root = scratch(), source = join(root, "exec-out"), destination = join(root, "artifacts");
    mkdirSync(source); mkdirSync(destination);
    return { root, source, destination };
  }
  it("copies the named regular files byte for byte, renaming a [source, destination] pair", () => {
    const { source, destination } = evidenceDirectories();
    writeFileSync(join(source, "doctor.json"), "{\"exitCode\":5}\n"); writeFileSync(join(source, "package.json"), "{}\n");
    expect(collectEvidence(source, destination, ["doctor.json", ["package.json", "generated-package.json"]]))
      .toEqual(["doctor.json", "generated-package.json"]);
    expect(readFileSync(join(destination, "doctor.json"), "utf8")).toBe("{\"exitCode\":5}\n");
    expect(readFileSync(join(destination, "generated-package.json"), "utf8")).toBe("{}\n");
  });
  it.each([
    ["a link to a host file", /ELOOP/, (root: string, path: string) => symlinkSync(hostSecret(root), path)],
    ["a FIFO", /regular file/, (_root: string, path: string) => expect(spawnSync("mkfifo", [path]).status).toBe(0)],
    ["a directory", /regular file/, (_root: string, path: string) => mkdirSync(path)],
    ["an oversized file", /byte limit/, (_root: string, path: string) => { writeFileSync(path, ""); truncateSync(path, EVIDENCE_MAX_BYTES + 1); }],
  ])("refuses %s and exports nothing from it", (_kind, reason, plant) => {
    const { root, source, destination } = evidenceDirectories();
    plant(root, join(source, "doctor.log"));
    expect(() => collectEvidence(source, destination, ["doctor.log"], { optional: true })).toThrow(reason);
    expect(readdirSync(destination)).toEqual([]);
    if (existsSync(join(root, "host-secret"))) expect(readFileSync(join(root, "host-secret"), "utf8")).toBe("host-only value\n");
  });
  it("refuses to replace an existing destination, including a planted link", () => {
    const { root, source, destination } = evidenceDirectories();
    writeFileSync(join(source, "doctor.json"), "new\n");
    symlinkSync(hostSecret(root), join(destination, "doctor.json"));
    expect(() => collectEvidence(source, destination, ["doctor.json"])).toThrow(/EEXIST/);
    expect(readFileSync(join(root, "host-secret"), "utf8")).toBe("host-only value\n");
  });
  it("refuses a name below a directory and a linked source directory", () => {
    const { root, source, destination } = evidenceDirectories();
    mkdirSync(join(root, "elsewhere")); writeFileSync(join(root, "elsewhere", "doctor.json"), "{}\n");
    symlinkSync(join(root, "elsewhere"), join(source, "nested"));
    expect(() => collectEvidence(source, destination, ["nested/doctor.json"])).toThrow("evidence name must be a single file name");
    const linked = join(root, "linked-out"); symlinkSync(join(root, "elsewhere"), linked);
    expect(() => collectEvidence(linked, destination, ["doctor.json"])).toThrow("not a directory");
    expect(readdirSync(destination)).toEqual([]);
  });
  it("skips a missing file only when collection is optional", () => {
    const { source, destination } = evidenceDirectories();
    expect(() => collectEvidence(source, destination, ["doctor.json"])).toThrow("missing evidence: doctor.json");
    expect(collectEvidence(source, destination, ["doctor.json"], { optional: true })).toEqual([]);
  });
});

describe("sealed generated project", () => {
  it("copies exactly the listed files, without node_modules, and records each digest", () => {
    const { project, context, names } = generatedProject(scratch());
    expect(sealProject(project, context, names)).toEqual({ schema: "dacs-sealed-context/v1",
      files: Object.fromEntries(Object.entries(PROJECT_FILES).map(([name, contents]) => [name, sha256(contents)]).sort()) });
    for (const [name, contents] of Object.entries(PROJECT_FILES)) expect(readFileSync(join(context, name), "utf8")).toBe(contents);
    expect(existsSync(join(context, "node_modules"))).toBe(false);
    expect(statSync(join(context, "src/service.ts")).mode & 0o777).toBe(0o600);
    expect(statSync(join(context, "data/buyer")).mode & 0o777).toBe(0o700);
  });
  it.each([
    ["a linked last component", "unexpected project entry: .dockerignore", (root: string, project: string) => {
      rmSync(join(project, ".dockerignore")); symlinkSync(hostSecret(root), join(project, ".dockerignore"));
    }],
    ["a linked intermediate directory", "unexpected project entry: src", (root: string, project: string) => {
      cpSync(join(project, "src"), join(root, "elsewhere"), { recursive: true }); rmSync(join(project, "src"), { recursive: true });
      symlinkSync(join(root, "elsewhere"), join(project, "src"));
    }],
    ["a FIFO", "unexpected project entry: package.json", (_root: string, project: string) => {
      rmSync(join(project, "package.json")); expect(spawnSync("mkfifo", [join(project, "package.json")]).status).toBe(0);
    }],
    ["a directory in place of a file", "unexpected project entry: package.json", (_root: string, project: string) => {
      rmSync(join(project, "package.json")); mkdirSync(join(project, "package.json"));
    }],
    ["an oversized file", "cannot copy package-lock.json: evidence byte limit exceeded", (_root: string, project: string) =>
      truncateSync(join(project, "package-lock.json"), EVIDENCE_MAX_BYTES + 1)],
    ["a missing listed file", "missing project file: secrets/README.md", (_root: string, project: string) => rmSync(join(project, "secrets/README.md"))],
    ["an extra file", "unexpected project entry: Dockerfile.acceptance", (_root: string, project: string) =>
      writeFileSync(join(project, "Dockerfile.acceptance"), "FROM scratch\n")],
    ["an extra link", "unexpected project entry: acceptance-npm-http.cjs", (root: string, project: string) =>
      symlinkSync(hostSecret(root), join(project, "acceptance-npm-http.cjs"))],
  ])("refuses %s and leaves no sealed copy of it", (_kind, reason, plant) => {
    const root = scratch(); const { project, context, names } = generatedProject(root);
    plant(root, project);
    expect(() => sealProject(project, context, names)).toThrow(reason);
    expect(existsSync(join(context, "Dockerfile.acceptance")) || existsSync(join(context, "acceptance-npm-http.cjs"))).toBe(false);
    if (existsSync(join(root, "host-secret"))) {
      expect(readFileSync(join(root, "host-secret"), "utf8")).toBe("host-only value\n");
      expect(spawnSync("grep", ["-r", "host-only value", join(root, "sealed")]).status).not.toBe(0);
    }
  });
  it("refuses a linked project root and an existing context", () => {
    const root = scratch(); const { project, context, names } = generatedProject(root);
    const linked = join(root, "linked-project"); symlinkSync(project, linked);
    expect(() => sealProject(linked, context, names)).toThrow("not a directory");
    mkdirSync(context, { recursive: true });
    expect(() => sealProject(project, context, names)).toThrow(/EEXIST/);
  });
  it("seals through its command line and writes the digest record once", () => {
    const root = scratch(); const { project, context, names } = generatedProject(root);
    const record = join(root, "sealed-context.json");
    const cli = (...args: string[]) => spawnSync(process.execPath, ["scripts/acceptance-seal.mjs", ...args], { encoding: "utf8" });
    expect(cli("seal", project, context, record, ...names).status).toBe(0);
    expect(JSON.parse(readFileSync(record, "utf8")).files["package-lock.json"]).toBe(sha256(PROJECT_FILES["package-lock.json"]!));
    const evidence = join(root, "evidence"); mkdirSync(evidence);
    expect(cli("collect", "--optional", context, evidence, "package.json=generated-package.json", "absent.json").status).toBe(0);
    expect(readdirSync(evidence)).toEqual(["generated-package.json"]);
    expect(cli("collect", context, evidence, "absent.json").status).not.toBe(0);
    expect(cli("unknown").status).not.toBe(0);
  });
});

