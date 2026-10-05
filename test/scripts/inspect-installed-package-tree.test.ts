import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scannerPath = "../../scripts/inspect-installed-package-tree.mjs";
const { inspectInstalledPackageTree } = await import(scannerPath);
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dacs-installed-tree-"));
  roots.push(root);
  const modules = join(root, "node_modules");
  await mkdir(modules);
  return modules;
}

async function addPackage(directory: string, name: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("installed production package tree scanner", () => {
  it("accepts an empty production tree", async () => {
    const result = await inspectInstalledPackageTree(await fixture());
    expect(result.passed).toBe(true);
    expect(result.packages).toEqual({ typescript: [], "rubic-sdk": [] });
  });

  it("finds nested forbidden packages, including beneath scoped packages", async () => {
    const modules = await fixture();
    await addPackage(join(modules, "parent"), "parent");
    await addPackage(join(modules, "parent/node_modules/typescript"), "typescript");
    await addPackage(join(modules, "@scope/parent"), "@scope/parent");
    await addPackage(join(modules, "@scope/parent/node_modules/rubic-sdk"), "rubic-sdk");
    const result = await inspectInstalledPackageTree(modules);
    expect(result.passed).toBe(false);
    expect(result.packages.typescript).toEqual(["parent/node_modules/typescript"]);
    expect(result.packages["rubic-sdk"]).toEqual(["@scope/parent/node_modules/rubic-sdk"]);
  });

  it("rejects malformed package manifests and symlinked package entries", async () => {
    const modules = await fixture();
    await mkdir(join(modules, "broken"));
    await expect(inspectInstalledPackageTree(modules)).rejects.toThrow();
    await rm(join(modules, "broken"), { recursive: true });
    await addPackage(join(modules, "real"), "real");
    await symlink(join(modules, "real"), join(modules, "linked"));
    await expect(inspectInstalledPackageTree(modules)).rejects.toThrow(/symlinked/);
  });
});
