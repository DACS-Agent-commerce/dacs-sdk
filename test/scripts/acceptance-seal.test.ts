import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
const sealModule = "../../scripts/acceptance-seal.mjs";
const { collectEvidence, sealProject } = await import(sealModule);
const buildModule = "../../scripts/bounded-build.mjs";
const { prepareBoundedBuild } = await import(buildModule);
const ioModule = "../../scripts/acceptance-evidence-io.mjs";
const { EVIDENCE_MAX_BYTES, atomicWriteFile } = await import(ioModule);

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
  it("retries a collection after copying some files and accepts an identical destination", () => {
    const { source, destination } = evidenceDirectories();
    writeFileSync(join(source, "doctor.json"), "{\"exitCode\":0}\n");
    expect(() => collectEvidence(source, destination, ["doctor.json", "missing.json"]))
      .toThrow("missing evidence: missing.json");
    writeFileSync(join(source, "missing.json"), "{}\n");
    expect(collectEvidence(source, destination, ["doctor.json", "missing.json"]))
      .toEqual(["doctor.json", "missing.json"]);
    expect(readFileSync(join(destination, "missing.json"), "utf8")).toBe("{}\n");
    writeFileSync(join(destination, "doctor.json"), "different\n");
    expect(() => collectEvidence(source, destination, ["doctor.json"])).toThrow(/EEXIST/);
    expect(readFileSync(join(destination, "doctor.json"), "utf8")).toBe("different\n");
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
  it("refuses a rename entry that is not exactly one source and one destination", () => {
    const { source, destination } = evidenceDirectories();
    writeFileSync(join(source, "doctor.json"), "{}\n");
    expect(() => collectEvidence(source, destination, [["doctor.json", "renamed.json", "ignored.json"]]))
      .toThrow("evidence entry must be a name or a [source, destination] pair");
    expect(readdirSync(destination)).toEqual([]);
  });
  it("preserves the source file and directory permission bits under a restrictive umask", () => {
    const root = scratch();
    const source = join(root, "exec-out"), destination = join(root, "artifacts");
    mkdirSync(source); mkdirSync(destination);
    writeFileSync(join(source, "doctor.json"), "{}\n"); chmodSync(join(source, "doctor.json"), 0o644);
    const project = join(root, "project"); mkdirSync(project); mkdirSync(join(project, "data"));
    writeFileSync(join(project, "package.json"), "{}\n"); chmodSync(join(project, "package.json"), 0o644);
    writeFileSync(join(project, "data", "x"), "x"); chmodSync(join(project, "data", "x"), 0o640);
    chmodSync(join(project, "data"), 0o755);
    mkdirSync(join(root, "sealed"));
    const previous = process.umask(0o077);
    try {
      collectEvidence(source, destination, ["doctor.json"]);
      sealProject(project, join(root, "sealed", "context"), ["package.json", "data/x"]);
    } finally { process.umask(previous); }
    expect(statSync(join(destination, "doctor.json")).mode & 0o777).toBe(0o644);
    expect(statSync(join(root, "sealed/context/package.json")).mode & 0o777).toBe(0o644);
    expect(statSync(join(root, "sealed/context/data/x")).mode & 0o777).toBe(0o640);
    expect(statSync(join(root, "sealed/context/data")).mode & 0o777).toBe(0o755);
  });
});

describe("durable evidence publication", () => {
  it("flushes the replacement to storage before publishing it over the old entry", () => {
    const root = scratch(), target = join(root, ".dockerignore");
    writeFileSync(target, "**\n");
    let options: unknown;
    atomicWriteFile(target, "**\n!acceptance-npm-http.cjs\n", {
      write: (temporary: string, contents: string, writeOptions: unknown) => {
        writeFileSync(temporary, contents); options = writeOptions;
      },
    });
    expect(options).toEqual({ flag: "wx", flush: true });
    expect(readFileSync(target, "utf8")).toBe("**\n!acceptance-npm-http.cjs\n");
    expect(readdirSync(root).filter(name => name.includes(".tmp-"))).toEqual([]);
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
  it("records a digest for a listed file named __proto__", () => {
    const root = scratch(), project = join(root, "project"), context = join(root, "sealed", "context");
    mkdirSync(project); mkdirSync(join(root, "sealed"));
    writeFileSync(join(project, "__proto__"), "first");
    const record = sealProject(project, context, ["__proto__"]);
    expect(Object.hasOwn(record.files, "__proto__")).toBe(true);
    expect(record.files["__proto__"]).toBe(sha256("first"));
    expect(JSON.parse(JSON.stringify(record)).files["__proto__"]).toBe(sha256("first"));
    expect(readFileSync(join(context, "__proto__"), "utf8")).toBe("first");
  });
  it("refuses a listed file inside node_modules before creating the context", () => {
    const root = scratch(), project = join(root, "project"), context = join(root, "sealed", "context");
    mkdirSync(join(project, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(project, "package.json"), "{}\n");
    writeFileSync(join(project, "node_modules", "left-pad", "index.js"), "");
    mkdirSync(join(root, "sealed"));
    expect(() => sealProject(project, context, ["package.json", "node_modules/left-pad/index.js"]))
      .toThrow("evidence name must be outside node_modules");
    expect(existsSync(context)).toBe(false);
  });
  it("removes a partial context when a listed file is found missing, so a retry can seal", () => {
    const root = scratch(); const { project, context, names } = generatedProject(root);
    rmSync(join(project, "secrets/README.md"));
    expect(() => sealProject(project, context, names)).toThrow("missing project file: secrets/README.md");
    expect(existsSync(context)).toBe(false);
    writeFileSync(join(project, "secrets/README.md"), "No keys here.\n");
    expect(sealProject(project, context, names).schema).toBe("dacs-sealed-context/v1");
  });
  it("recovers after an interrupted staging directory", () => {
    const root = scratch(); const { project, context, names } = generatedProject(root);
    const abandoned = `${context}.staging-abandoned`;
    mkdirSync(abandoned); writeFileSync(join(abandoned, "package.json"), "partial\n");
    expect(sealProject(project, context, names).schema).toBe("dacs-sealed-context/v1");
    expect(readFileSync(join(context, "package.json"), "utf8")).toBe(PROJECT_FILES["package.json"]);
  });
  it("seals a listed file under a read-only source directory and keeps its mode", () => {
    const root = scratch(), project = join(root, "project"), context = join(root, "sealed", "context");
    mkdirSync(join(root, "sealed")); mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "service.ts"), "export {};\n");
    chmodSync(join(project, "src"), 0o555);
    try {
      expect(sealProject(project, context, ["src/service.ts"]).files["src/service.ts"]).toBe(sha256("export {};\n"));
      expect(readFileSync(join(context, "src", "service.ts"), "utf8")).toBe("export {};\n");
      expect(statSync(join(context, "src")).mode & 0o777).toBe(0o555);
    } finally {
      chmodSync(join(project, "src"), 0o755);
      if (existsSync(join(context, "src"))) chmodSync(join(context, "src"), 0o755);
    }
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
    expect(cli("collect", context, evidence, "package.json=a=b").status).not.toBe(0);
    expect(readdirSync(evidence)).toEqual(["generated-package.json"]);
    expect(cli("collect", context, evidence, "absent.json").status).not.toBe(0);
    expect(cli("unknown").status).not.toBe(0);
    const existingRecord = join(root, "existing-record.json"); writeFileSync(existingRecord, "keep\n");
    const refusedContext = join(root, "sealed", "second");
    expect(cli("seal", project, refusedContext, existingRecord, ...names).status).not.toBe(0);
    expect(existsSync(refusedContext)).toBe(false);
    expect(readFileSync(existingRecord, "utf8")).toBe("keep\n");
    const linkedRecord = join(root, "linked-record.json"), host = hostSecret(root);
    symlinkSync(host, linkedRecord);
    const linkedContext = join(root, "sealed", "third");
    expect(cli("seal", project, linkedContext, linkedRecord, ...names).status).not.toBe(0);
    expect(existsSync(linkedContext)).toBe(false);
    expect(readFileSync(host, "utf8")).toBe("host-only value\n");
  });
  it("executes through a symlinked directory and stays inert on import", () => {
    const root = scratch(); const { project, context, names } = generatedProject(root);
    const alias = join(root, "scripts"); symlinkSync(resolve("scripts"), alias);
    const path = join(alias, "acceptance-seal.mjs");
    const imported = spawnSync(process.execPath, ["--input-type=module", "-e",
      "const path = process.argv[1]; process.argv[1] = process.execPath; await import(path)", path], { encoding: "utf8" });
    expect(imported.status, imported.stderr).toBe(0);
    expect(existsSync(context)).toBe(false);
    const record = join(root, "sealed-context.json");
    expect(spawnSync(process.execPath, [path, "seal", project, context, record, ...names], { encoding: "utf8" }).status).toBe(0);
    expect(JSON.parse(readFileSync(record, "utf8")).files["package.json"]).toBe(sha256(PROJECT_FILES["package.json"]!));
    expect(readFileSync(join(context, "package.json"), "utf8")).toBe(PROJECT_FILES["package.json"]);
  });
  it("removes the sealed context when the digest record cannot be published", () => {
    const root = scratch(); const { project, names } = generatedProject(root);
    const context = join(root, "sealed", "context"), record = join(root, "absent-parent", "sealed-context.json");
    const cli = spawnSync(process.execPath, ["scripts/acceptance-seal.mjs", "seal", project, context, record, ...names], { encoding: "utf8" });
    expect(cli.status).not.toBe(0);
    expect(existsSync(context)).toBe(false);
    expect(existsSync(record)).toBe(false);
  });
  it("refuses an ambiguous evidence name instead of copying a different file", () => {
    const root = scratch(), source = join(root, "exec-out"), destination = join(root, "artifacts");
    mkdirSync(source); mkdirSync(destination);
    writeFileSync(join(source, "a=b.json"), "REAL\n"); writeFileSync(join(source, "a"), "WRONG\n");
    const cli = (...args: string[]) => spawnSync(process.execPath, ["scripts/acceptance-seal.mjs", ...args], { encoding: "utf8" });
    expect(cli("collect", source, destination, "a=b.json").status).not.toBe(0);
    expect(readdirSync(destination)).toEqual([]);
    // A literal name with no competing rename source is still collectable.
    rmSync(join(source, "a"));
    expect(cli("collect", source, destination, "a=b.json").status).toBe(0);
    expect(readdirSync(destination)).toEqual(["a=b.json"]);
    expect(readFileSync(join(destination, "a=b.json"), "utf8")).toBe("REAL\n");
  });
});


describe("bounded image build preparation", () => {
  function sealedContext() {
    const root = scratch(); const { project, context, names } = generatedProject(root);
    sealProject(project, context, names);
    return { root, context };
  }
  it.each([".dockerignore", "Dockerfile"])("refuses a linked %s and leaves its target unchanged", name => {
    const { root, context } = sealedContext();
    const target = hostSecret(root); writeFileSync(target, name === "Dockerfile" ? "FROM host AS build\n" : "host-only value\n");
    const before = readFileSync(target, "utf8");
    rmSync(join(context, name)); symlinkSync(target, join(context, name));
    expect(() => prepareBoundedBuild(context)).toThrow(/ELOOP/);
    expect(readFileSync(target, "utf8")).toBe(before);
  });
  it.each(["Dockerfile.acceptance", "acceptance-npm-http.cjs"])("refuses a planted %s link instead of writing through it", name => {
    const { root, context } = sealedContext();
    const target = hostSecret(root); symlinkSync(target, join(context, name));
    expect(() => prepareBoundedBuild(context)).toThrow(/EEXIST/);
    expect(readFileSync(target, "utf8")).toBe("host-only value\n");
  });
  it("replaces the ignore file with a new one rather than writing through the old entry", () => {
    const { root, context } = sealedContext();
    const other = join(root, "other-name"); linkSync(join(context, ".dockerignore"), other);
    prepareBoundedBuild(context);
    expect(readFileSync(join(context, ".dockerignore"), "utf8")).toBe("**\n!acceptance-npm-http.cjs\n");
    expect(readFileSync(other, "utf8")).toBe("**\n");
    expect(readdirSync(context).filter(name => name.includes(".tmp-"))).toEqual([]);
  });
  // The copy a check container would make (cp -R per top-level entry) keeps a
  // planted link; preparing that copy must refuse it rather than read the host
  // file it names into the generated ignore file.
  it("refuses a context copied with its planted ignore-file link", () => {
    const root = scratch(); const { project } = generatedProject(root);
    const target = hostSecret(root); rmSync(join(project, ".dockerignore")); symlinkSync(target, join(project, ".dockerignore"));
    const copy = join(root, "copied"); mkdirSync(copy);
    for (const name of readdirSync(project).filter(name => name !== "node_modules")) {
      expect(spawnSync("cp", ["-R", join(project, name), copy]).status).toBe(0);
    }
    expect(() => prepareBoundedBuild(copy)).toThrow(/ELOOP/);
    expect(readFileSync(target, "utf8")).toBe("host-only value\n");
  });
});
