import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { peerCacheFixture } from "./reference-cache-fixtures.js";

const closurePath = "../../scripts/installation-closure.mjs";
const { ARCHIVE_LIMITS, npmToolchain, runNpmNode } = await import(closurePath);
const referencePath = "../../scripts/reference-installation.mjs";
const { installationDifferences, npmInstallContract, referenceInstallation } = await import(referencePath);
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const temporary = () => {
  const path = mkdtempSync(join(tmpdir(), "reference-cache-"));
  directories.push(path);
  return path;
};

describe("explicit installer metadata", { timeout: 60_000 }, () => {
  it("replays omitted peer re-resolution using the real installer's metadata", async () => {
    const { project, input } = await peerCacheFixture(temporary());
    const reference = referenceInstallation(input);
    expect(reference.errors).toEqual([]);
    expect(installationDifferences(project, reference)).toEqual([]);
    const missing = referenceInstallation({ ...input, metadataCache: temporary() });
    if (Number(input.installer.config["npm-version"].split(".")[0]) >= 11) {
      expect(missing.errors.join()).toContain("EUSAGE");
      expect(missing.inventory).toBeNull();
    }
    const untrusted = referenceInstallation({ ...input, readArchive: () => Buffer.from("invalid archive") });
    expect(untrusted.errors.join()).toContain("does not match its integrity");
    const unavailable = referenceInstallation({ ...input, readArchive: () => { throw Error("source unavailable"); } });
    expect(unavailable.errors.join()).toContain("source unavailable");
    expect(unavailable.inventory).toBeNull();
  });

  it("refuses git resolution introduced by cached registry metadata before invoking git", async () => {
    const { project, input } = await peerCacheFixture(temporary());
    const gitCommand = join(project, "git-trap");
    writeFileSync(gitCommand, '#!/bin/sh\ntouch "$(dirname "$0")/git-called"\nexit 1\n');
    chmodSync(gitCommand, 0o755);
    input.installer.config.git = gitCommand;
    const toolchain = npmToolchain();
    const command = `const c = require('node:module').createRequire(process.argv[1])('cacache');
      (async () => {
        const cache = process.argv[2] + '/_cacache';
        const entry = Object.values(await c.ls(cache)).find(e => e.key.endsWith('/d'));
        const body = JSON.parse((await c.get(cache, entry.key)).data);
        body.versions['1.0.0'].dependencies.g = 'git+https://github.com/u/g.git';
        await c.put(cache, entry.key, JSON.stringify(body), { metadata: entry.metadata });
      })().catch(e => { throw e });`;
    runNpmNode(toolchain, ["-e", command, toolchain.cli, input.metadataCache]);
    const root = { dependencies: { d: "^1.0.0" } };
    const reference = referenceInstallation({ ...input, manifest: Buffer.from(JSON.stringify(root)),
      lock: { lockfileVersion: 3, packages: { "": root } } });
    expect(reference.errors.join()).toContain("non-registry dependency resolution");
    expect(existsSync(join(project, "git-called"))).toBe(false);
    expect(reference.inventory).toBeNull();
  });

  it.each(["index", "body"])("bounds each metadata %s file before reading", kind => {
    const project = temporary();
    const cache = join(project, "cache");
    writeFileSync(join(project, "package.json"), "{}");
    const input = { manifest: Buffer.from("{}"), lock: { lockfileVersion: 3, packages: { "": {} } },
      installer: npmInstallContract(project), metadataCache: cache, readArchive: () => { throw Error("unexpected archive read"); } };
    const toolchain = npmToolchain();
    const command = `const c = require('node:module').createRequire(process.argv[1])('cacache');
      c.put(process.argv[2] + '/_cacache', 'make-fetch-happen:request-cache:https://registry.invalid/unused', Buffer.alloc(${ARCHIVE_LIMITS.archiveBytes}),
        { metadata: { resHeaders: { 'content-type': 'application/json' } } }).catch(e => { throw e });`;
    runNpmNode(toolchain, ["-e", command, toolchain.cli, cache]);
    const index = join(cache, "_cacache/index-v5/aa/bb");
    if (kind === "index") {
      mkdirSync(index, { recursive: true });
      writeFileSync(join(index, "oversized"), "");
      truncateSync(join(index, "oversized"), ARCHIVE_LIMITS.archiveBytes);
    }
    expect(referenceInstallation(input).errors).toEqual([]); // exact limit
    if (kind === "index") {
      truncateSync(join(index, "oversized"), ARCHIVE_LIMITS.archiveBytes + 1);
    } else {
      runNpmNode(toolchain, ["-e", command.replace(`Buffer.alloc(${ARCHIVE_LIMITS.archiveBytes})`, `Buffer.alloc(${ARCHIVE_LIMITS.archiveBytes + 1})`), toolchain.cli, cache]);
    }
    const refused = referenceInstallation(input);
    expect(refused.errors.join()).toMatch(/larger than|metadata.*limit/);
    expect(refused.inventory).toBeNull();
  });
});

describe("omitted hosted git entries", { timeout: 60_000 }, () => {
  const fixture = (flag: "optional" | "dev", edge: boolean, config = `omit=${flag}\n`, target = "https://github.com/u/g#x") => {
    const project = temporary();
    const root = { name: "consumer", version: "1.0.0", [flag === "dev" ? "devDependencies" : "optionalDependencies"]: { owner: "1.0.0" } };
    const owner = { version: "1.0.0", resolved: "https://registry.invalid/owner.tgz", [flag]: true,
      ...(edge ? { dependencies: { g: target } } : {}) };
    const git = { version: "1.0.0", resolved: "git+ssh://git@github.com/u/g.git#" + "a".repeat(40), [flag]: true };
    const lock = { lockfileVersion: 3, packages: { "": root, "node_modules/owner": owner, "node_modules/g": git } };
    const gitCommand = join(project, "git-trap");
    writeFileSync(gitCommand, '#!/bin/sh\ntouch "$(dirname "$0")/git-called"\nexit 1\n');
    chmodSync(gitCommand, 0o755);
    writeFileSync(join(project, "package.json"), JSON.stringify(root));
    writeFileSync(join(project, ".npmrc"), config + `git=${gitCommand}\n`);
    return { project, input: { manifest: Buffer.from(JSON.stringify(root)), lock, installer: npmInstallContract(project),
      readArchive: () => { throw Error("omitted source unavailable"); } } };
  };
  it.each([["optional", false], ["optional", true], ["dev", false], ["dev", true]] as const)("accepts an omitted %s git source, edge=%s", (flag, edge) => {
      const { project, input } = fixture(flag, edge);
      const reference = referenceInstallation(input);
      expect(reference.errors).toEqual([]);
      expect(reference.entries.get("node_modules/g")).toMatchObject({ present: false, unverified: true });
      expect(existsSync(join(project, "git-called"))).toBe(false);
  });
  it.each([
    ["not omitted", "", "https://github.com/u/g#x"],
    ["included optional", "omit=optional\ninclude=optional\n", "https://github.com/u/g#x"],
    ["different project", "omit=optional\n", "https://github.com/u/other#x"],
    ["remote archive", "omit=optional\n", "https://github.com/u/g.tgz"],
  ])("refuses %s", (_label, config, target) => {
    const { input } = fixture("optional", true, config, target);
    expect(referenceInstallation(input).errors.join()).toContain("non-registry dependency specification");
  });
  it.each(["missing", "included", "devOptional", "shadowed"])("refuses an omitted edge with a %s target", scenario => {
    const { input } = fixture("optional", true);
    const packages: Record<string, Record<string, unknown>> = input.lock.packages;
    if (scenario === "missing") delete packages["node_modules/g"];
    if (scenario === "included") input.lock.packages["node_modules/g"].optional = false;
    if (scenario === "devOptional") Object.assign(input.lock.packages["node_modules/g"], { devOptional: true, dev: true });
    if (scenario === "shadowed") packages["node_modules/owner/node_modules/g"] = { ...input.lock.packages["node_modules/g"], optional: false };
    expect(referenceInstallation(input).errors.join()).toContain("non-registry dependency specification");
  });
  it.each(["dependencies", "optionalDependencies", "peerDependencies"])("accepts matching omitted git edges in %s", field => {
    const { input } = fixture("optional", true);
    const owner: Record<string, unknown> = input.lock.packages["node_modules/owner"];
    const edges = owner.dependencies;
    delete owner.dependencies;
    owner[field] = edges;
    expect(referenceInstallation(input).errors).toEqual([]);
  });
  it("resolves an omitted nested scoped owner through its nearest ancestor", () => {
    const { input } = fixture("optional", true);
    const packages: Record<string, Record<string, unknown>> = input.lock.packages;
    packages["node_modules/@scope/outer/node_modules/@scope/owner"] = packages["node_modules/owner"] ?? {};
    delete packages["node_modules/owner"];
    packages["node_modules/@scope/outer"] = { optional: true, version: "1.0.0", resolved: "https://registry.invalid/outer.tgz",
      dependencies: { "@scope/owner": "1.0.0" } };
    packages["node_modules/@scope/outer/node_modules/g"] = packages["node_modules/g"] ?? {};
    delete packages["node_modules/g"];
    packages[""] = { optionalDependencies: { "@scope/outer": "1.0.0" } };
    input.manifest = Buffer.from(JSON.stringify(packages[""]));
    expect(referenceInstallation(input).errors).toEqual([]);
  });
  it("keeps root git declarations refused even when the manifest carries an omission flag", () => {
    const { input } = fixture("optional", true);
    const root = { optional: true, optionalDependencies: { g: "https://github.com/u/g#x" } };
    input.manifest = Buffer.from(JSON.stringify(root));
    expect(referenceInstallation(input).errors.join()).toContain("package.json optionalDependencies.g");
  });
});
