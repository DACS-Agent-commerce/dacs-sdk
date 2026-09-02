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
// Currently: DACS-Standard PR #362 exact head, repairing the CORE §B.2
// signature-omitted VerifyResult reference hashes in the signed DACS-1 v0.7 /
// DACS-2 v0.6 38-case presence-only corpus.
// Previous pin: 662be1d (adopted DACS-Standard PR #335 merge).
// That prior pin also added the B.7 evidence-bound bundle, pointer and
// prior-payment-disposition separators used by the integrated security stack.
// See SDK #147, Standard #359/#362, and SDK #263.
const REF =
  process.env.DACS_STANDARD_REF || "f2e96627d9f5251cb32c69a31f44b35cda613b64";

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
