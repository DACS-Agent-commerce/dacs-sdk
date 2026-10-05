#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PROHIBITED_PACKAGE_NAMES = ["typescript", "rubic-sdk"];

export async function inspectInstalledPackageTree(root) {
  const absoluteRoot = resolve(root);
  const packages = Object.fromEntries(
    PROHIBITED_PACKAGE_NAMES.map((name) => [name, []]),
  );

  async function inspectPackage(packageDirectory) {
    const manifest = JSON.parse(
      await readFile(join(packageDirectory, "package.json"), "utf8"),
    );
    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      throw new Error(`installed package has no name: ${packageDirectory}`);
    }
    if (PROHIBITED_PACKAGE_NAMES.includes(manifest.name)) {
      packages[manifest.name].push(relative(absoluteRoot, packageDirectory));
    }
    const nestedModules = join(packageDirectory, "node_modules");
    let nestedEntries;
    try {
      nestedEntries = await readdir(nestedModules, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await inspectModules(nestedModules, nestedEntries);
  }

  async function inspectModules(modulesDirectory, entries) {
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const entryPath = join(modulesDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`symlinked installed package is not inspectable: ${entryPath}`);
      }
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) {
        const scopedEntries = await readdir(entryPath, { withFileTypes: true });
        for (const scopedEntry of scopedEntries) {
          if (scopedEntry.isSymbolicLink()) {
            throw new Error(`symlinked installed package is not inspectable: ${join(entryPath, scopedEntry.name)}`);
          }
          if (scopedEntry.isDirectory()) {
            await inspectPackage(join(entryPath, scopedEntry.name));
          }
        }
      } else {
        await inspectPackage(entryPath);
      }
    }
  }

  await inspectModules(absoluteRoot, await readdir(absoluteRoot, { withFileTypes: true }));
  for (const name of PROHIBITED_PACKAGE_NAMES) packages[name].sort();
  return {
    schema: "dacs-installed-package-tree/v1",
    root: absoluteRoot,
    packages,
    passed: PROHIBITED_PACKAGE_NAMES.every((name) => packages[name].length === 0),
  };
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || basename(process.argv[2]) !== "node_modules") {
    process.stderr.write("usage: inspect-installed-package-tree.mjs <node_modules-directory>\n");
    process.exitCode = 2;
  } else {
    const report = await inspectInstalledPackageTree(process.argv[2]);
    process.stdout.write(JSON.stringify(report) + "\n");
  }
}
