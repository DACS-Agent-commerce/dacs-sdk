#!/usr/bin/env node
// Sync the DACS-Standard §14 conformance vectors (the test oracle) into vendor/.
// The SDK's conformance suite runs against these — the dependency points
// SDK → spec, so the SDK is tested against a reproducible, pinned dacs-verify
// vector set (IMPLEMENTATION.md §1.4).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "vendor", "DACS-Standard");

const REPO =
  process.env.DACS_STANDARD_REPO ||
  "https://github.com/DACS-Agent-commerce/DACS-Standard.git";
// Pinned for reproducible conformance runs. The pin is the SDK's test oracle,
// so moving it changes what "conformant" means — bump deliberately, in a
// change that re-runs the suite and reconciles any drift.
// Currently: adopted DACS-Standard PR #335 merge, including DACS-1 v0.7 /
// DACS-2 v0.6 PCR-1..PCR-6 and its exact signed 38-case corpus.
// Previous pin: 965df755 (DACS-4 v0.6 settlement identities).
// See SDK #147 and Standard #334/#335.
const REF =
  process.env.DACS_STANDARD_REF || "662be1d4899a2cadf327fe2d5523e93a80334e5f";

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "inherit" });
}

mkdirSync(join(ROOT, "vendor"), { recursive: true });

if (!existsSync(join(VENDOR, ".git"))) {
  if (existsSync(VENDOR)) rmSync(VENDOR, { recursive: true, force: true });
  console.log(`[sync-vectors] cloning ${REPO}`);
  git(["clone", REPO, VENDOR]);
}

console.log(`[sync-vectors] checking out ${REF}`);
git(["fetch", "origin"], VENDOR);
git(["checkout", "--quiet", REF], VENDOR);
console.log(`[sync-vectors] DACS-Standard pinned at ${REF}`);
