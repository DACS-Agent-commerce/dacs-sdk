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
// Currently: DACS-Standard `next` @ 2026-09-01 (662be1d, merge of #335). This adds the
// three B.7 separators the registry below was missing (evidence-bound fault bundle,
// its pointer, prior-payment disposition) and the presence-only / APR / domain-GCR sets.
// Previous pin: 965df755 (2026-08-11); before that c2ecd9f, 625df63 and 9a77966 (234 cases).
// See #5-#7, #137, and Standard #315.
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
