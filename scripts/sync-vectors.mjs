#!/usr/bin/env node
// Sync the DACS-Standard §14 conformance vectors (the test oracle) into vendor/.
// The SDK's conformance suite runs against these — the dependency points
// SDK → spec, so the SDK is provably conformant (IMPLEMENTATION.md §1.4).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "vendor", "DACS-Standard");

const REPO =
  process.env.DACS_STANDARD_REPO ||
  "https://github.com/DACS-Agent-commerce/DACS-Standard.git";
// Pinned for reproducible conformance runs. Bump deliberately.
// v0.2 tag (7a3117e) — adds SB-1..3 session-bound settlement, pay-dem, ST-9/10,
// §11.1.2 additivity. Was v0.1 (239d646). See #7.
const REF =
  process.env.DACS_STANDARD_REF || "7a3117e9e47607c7c3fec39254c7b16939245631";

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
