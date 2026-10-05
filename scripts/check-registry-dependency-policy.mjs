#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_DEPENDENCIES = [
  "@kynesyslabs/dacs",
  "@kynesyslabs/dacs-node",
  "@kynesyslabs/demosdk",
  "@x402/core",
  "@x402/evm",
  "@x402/fetch",
  "better-sqlite3",
  "viem",
];

function externalSourceSpec(value) {
  return /(?:^|@)(?:file|link|workspace|git(?:\+[^:]*)?|github|gitlab|bitbucket|https?|ssh):/i.test(value) ||
    /:\/\//.test(value) || /^git@/i.test(value) ||
    /^[a-z0-9_.-]+\/[a-z0-9_.-]+(?:#.*)?$/i.test(value);
}

export function inspectRegistryDependencyPolicy(manifest, lock, registry) {
  if (!manifest || typeof manifest !== "object" || !lock?.packages ||
      typeof lock.packages !== "object" || !registry || registry.endsWith("/")) {
    throw new Error("invalid generated manifest, lockfile or registry");
  }
  const dependencies = manifest.dependencies ?? {};
  const violations = [];
  for (const name of REQUIRED_DEPENDENCIES) {
    if (typeof dependencies[name] !== "string") {
      violations.push({ location: "package.json", field: `dependencies.${name}`, reason: "missing" });
    }
  }
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, value] of Object.entries(manifest[section] ?? {})) {
      if (typeof value !== "string" || externalSourceSpec(value)) {
        violations.push({ location: "package.json", field: `${section}.${name}`, value });
      }
    }
  }
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!entry || typeof entry !== "object") {
      violations.push({ location, reason: "invalid-lock-entry" });
      continue;
    }
    if (entry.link === true) violations.push({ location, reason: "linked-package" });
    if (typeof entry.resolved === "string" &&
        !entry.resolved.startsWith(`${registry}/`)) {
      violations.push({ location, field: "resolved", value: entry.resolved });
    }
    for (const field of ["version", "from"]) {
      if (typeof entry[field] === "string" && externalSourceSpec(entry[field])) {
        violations.push({ location, field, value: entry[field] });
      }
    }
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, value] of Object.entries(entry[section] ?? {})) {
        if (typeof value !== "string" || externalSourceSpec(value)) {
          violations.push({ location, field: `${section}.${name}`, value });
        }
      }
    }
  }
  for (const name of ["node_modules/@kynesyslabs/dacs", "node_modules/@kynesyslabs/dacs-node"]) {
    if (!lock.packages[name]?.resolved?.startsWith(`${registry}/`)) {
      violations.push({ location: name, field: "resolved", reason: "candidate-not-from-local-registry" });
    }
  }
  return { schema: "dacs-registry-dependency-policy/v1", passed: violations.length === 0, violations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 5) {
    process.stderr.write("usage: check-registry-dependency-policy.mjs <project> <registry> <report>\n");
    process.exitCode = 2;
  } else {
    const project = process.argv[2];
    const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
    const lock = JSON.parse(await readFile(join(project, "package-lock.json"), "utf8"));
    const report = inspectRegistryDependencyPolicy(manifest, lock, process.argv[3]);
    await writeFile(process.argv[4], JSON.stringify(report, null, 2) + "\n");
  }
}
