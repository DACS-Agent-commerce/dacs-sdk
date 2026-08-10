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
// Currently: DACS-Standard `next` @ 2026-08-10. This includes Standard PR #324,
// whose corrected preserve-unknown Listing fixture satisfies DACS-4 DPA-1.
// Previous pin: 625df63; before that 9a77966 (234 cases) and the v0.3 tag
// cc01cda (187 cases). See #5-#7 and #137.
const REF =
  process.env.DACS_STANDARD_REF || "c2ecd9fa658776f5511f2414d7b4c3e23b847463";

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
