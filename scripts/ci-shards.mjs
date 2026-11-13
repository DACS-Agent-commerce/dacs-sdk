// CI shards for the two long build-test suites (seller and client), so each runs as parallel jobs instead of one.
//
//   node scripts/ci-shards.mjs plan --event <github.event_name>   matrix JSON for the build-test shard job
//   node scripts/ci-shards.mjs check                              every test file (and every test of a split file)
//                                                                 is in exactly one shard
//   node scripts/ci-shards.mjs verify --node <v> --event <e> --jobs <file>
//                                                                 the run's jobs for one Node leg all passed
//
// Files are assigned by weight (seconds per file from a recent CI run), heaviest first, each to the shard with the
// least weight so far; ties go to the lower shard, then to the earlier file name. A file with no recorded weight gets
// DEFAULT_WEIGHT, so a new test file always lands in some shard. The weights only balance the shards: a stale weight
// makes the split uneven, never incomplete.
//
// A file in SPLIT_FILES is not assigned whole: each of its top-level tests is assigned on its own, by the same rule,
// alongside the whole files. Its test names are listed by loading it without running any test
// (scripts/ci-test-names.mjs). A shard that holds some of its tests runs the file once with every other test skipped
// by exact name, and run-client-tests.mjs checks that the tests that ran are exactly the ones this shard was given,
// so a test the listing missed fails every shard instead of going unrun.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listTests } from "./ci-test-names.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const NODE_LEGS = ["22", "24"];
export const SHARDS = { seller: 2, client: 4 };
export const DEFAULT_WEIGHT = 30;
export const DEFAULT_TEST_WEIGHT = 60;

// Client files whose tests are spread over the shards one by one. delta-provenance re-checks the whole delta history
// in most of its 27 tests, so as one file it took about 50 minutes in a single job.
export const SPLIT_FILES = { seller: [], client: ["scripts/delta-provenance.test.mjs"] };

// Seconds per file on the hosted runner. The weights only balance the shards; a missing or stale entry never drops a
// file (see check).
// - client: the time between consecutive "[client-tests] <file>" lines in a client shard job's log.
// - seller: the old one-job layout ran all seller files in one process, so each file was timed alone on a test machine
//   and the times scaled to add up to that job's seller step. seller-host-native-delivery.test.mjs is set to the time
//   it ran on its own in that job's log.
export const WEIGHTS = {
  seller: {
    "admission-docs.test.mjs": 1,
    "agent-construction.test.mjs": 17,
    "approval-ledger.test.mjs": 1,
    "approval-regressions.test.mjs": 5,
    "approval-retained.test.mjs": 8,
    "approval-stop.test.mjs": 1,
    "artifact-lane-recovery.test.mjs": 1,
    "artifact-observations.test.mjs": 1,
    "artifact-publication.test.mjs": 1,
    "artifact-sdk-admission.test.mjs": 1,
    "bilateral-vet.test.mjs": 1,
    "bounded-reads.test.mjs": 1,
    "buyer-access.test.mjs": 1,
    "canonical-job-boundaries.test.mjs": 1,
    "challenge-ledger.test.mjs": 26,
    "challenge-route-wire.test.mjs": 28,
    "commitment-recovery.test.mjs": 44,
    "confirmed-native-transfer-fixture.test.mjs": 1,
    "context-admission-transaction.test.mjs": 39,
    "context-budgets.test.mjs": 3,
    "context-compensation.test.mjs": 14,
    "context-hold-startup.test.mjs": 12,
    "d5-admission.test.mjs": 2,
    "d5-challenge-retention.test.mjs": 11,
    "d5-limits-before-effects.test.mjs": 9,
    "d5-recovery.test.mjs": 11,
    "d5-vet-decisions.test.mjs": 1,
    "deliverable-restart-resend.test.mjs": 1,
    "deliverable-wallet-journal.test.mjs": 1,
    "delivery-capabilities.test.mjs": 1,
    "delivery-context-bounds.test.mjs": 1,
    "delivery-context-capabilities.test.mjs": 1,
    "delivery-context-deadline.test.mjs": 1,
    "delivery-context-reconstruction.test.mjs": 1,
    "demos-claims.test.mjs": 1,
    "devnet-delivery-wallet-refusal.test.mjs": 1,
    "devnet-storage-write-recovery.test.mjs": 1,
    "durable-approval-ledger.test.mjs": 1,
    "durable-effects.test.mjs": 7,
    "durable-initialization.test.mjs": 1,
    "durable-sessions.test.mjs": 2,
    "effect-history.test.mjs": 1,
    "finalized-commitment-reader.test.mjs": 1,
    "host-lifecycle.test.mjs": 6,
    "host-wire-state.test.mjs": 7,
    "http-command-boundaries.test.mjs": 1,
    "installed-package.test.mjs": 1,
    "kit-operation-guard.test.mjs": 1,
    "listing-stop-after-approval.test.mjs": 1,
    "native-payment-evidence-consumer.test.mjs": 1,
    "native-payment-stage.test.mjs": 1,
    "negotiate-phase-after-readback.test.mjs": 2,
    "one-seller-nonce.test.mjs": 20,
    "operator-custody-directory-sync.test.mjs": 1,
    "operator-custody-durability.test.mjs": 1,
    "operator-custody-parent-durability.test.mjs": 1,
    "operator-custody-retained-sync.test.mjs": 1,
    "operator-inputs.test.mjs": 1,
    "party-vet-store.test.mjs": 1,
    "payment-evidence-wallet-journal.test.mjs": 3,
    "prepare-consumer.test.mjs": 1,
    "presentation-signing.test.mjs": 1,
    "process-lease.test.mjs": 1,
    "proposal-admission.test.mjs": 3,
    "proposal-phase.test.mjs": 1,
    "proposal-terminal-fence.test.mjs": 5,
    "purchase-protocol.test.mjs": 1,
    "rail-session-admission.test.mjs": 1,
    "readback-deadline.test.mjs": 8,
    "readme-contract.test.mjs": 1,
    "readme-imports.test.mjs": 1,
    "refused-create-retry.test.mjs": 1,
    "refused-deliverable-republish.test.mjs": 1,
    "request-validation.test.mjs": 1,
    "reservation-accounting.test.mjs": 37,
    "reservation-retention.test.mjs": 1,
    "retained-vet-readers.test.mjs": 6,
    "seller-agent-contracts.test.mjs": 1,
    "seller-client-deadline.test.mjs": 1,
    "seller-host-native-delivery.test.mjs": 2000,
    "seller-issuance.test.mjs": 1,
    "seller-key-diagnostics.test.mjs": 1,
    "seller-key-revoked-binding.test.mjs": 1,
    "seller-key-roles.test.mjs": 1,
    "seller-key.test.mjs": 1,
    "seller-lifecycle-gates.test.mjs": 53,
    "seller-payment-retry.test.mjs": 11,
    "seller-raw-json.test.mjs": 1,
    "seller-settlement-profile.test.mjs": 54,
    "seller-state-stale-locks.test.mjs": 1,
    "seller-substrate-profile.test.mjs": 1,
    "seller-transport-auth.test.mjs": 1,
    "seller-wire-client-auth.test.mjs": 2,
    "session-challenge-restore.test.mjs": 5,
    "settlement-collisions.test.mjs": 1,
    "signed-listing.test.mjs": 1,
    "signing-gate-bind.test.mjs": 1,
    "sr2-fixture-evidence-marking.test.mjs": 1,
    "sr2-foreign-readback-budget.test.mjs": 1,
    "sr2-readback.test.mjs": 1,
    "sr2-receipt-verification.test.mjs": 1,
    "transport-readback.test.mjs": 6,
    "transport-reconciliation.test.mjs": 41,
    "transport-session-restore.test.mjs": 1,
    "vet-anchor-retry.test.mjs": 1,
    "vet-challenge-retry.test.mjs": 1,
    "vet-checkpoints.test.mjs": 1,
    "vet-evidence-resolvers.test.mjs": 1,
    "vet-issuance-retry.test.mjs": 1,
    "vet-late-sign-recheck.test.mjs": 1,
    "vet-legacy-lifecycle.test.mjs": 1,
    "vet-lifecycle.test.mjs": 1,
    "vet-orchestrator-anchor.test.mjs": 1,
    "vet-orchestrator-consumers.test.mjs": 33,
    "vet-orchestrator-producer.test.mjs": 13,
    "vet-orchestrator-retained-mode.test.mjs": 14,
    "vet-orchestrator-route.test.mjs": 1,
    "vet-presence.test.mjs": 1,
    "vet-price-terms.test.mjs": 1,
    "vet-production.test.mjs": 1,
    "vet-resume.test.mjs": 1,
    "vet-run-recovery.test.mjs": 1,
    "vet-way-back.test.mjs": 1,
    "vetted-proposal.test.mjs": 8,
    "wallet-recovery-docs.test.mjs": 1,
    "wire-first-proposal.test.mjs": 1,
    "wire-signed-routes.test.mjs": 29,
  },
  client: {
    "scripts/check-hold.test.mjs": 9,
    "scripts/check-provenance.test.mjs": 2,
    "scripts/delta-continuity.test.mjs": 4,
    "scripts/delta-frontier.test.mjs": 755,
    "scripts/test-layout.test.mjs": 1,
    "test/bound-terms-mismatch.test.mjs": 1,
    "test/buyer-chain-indeterminate.test.mjs": 1,
    "test/chain-nonce-slot.test.mjs": 1,
    "test/commitment-contradiction-classifier.test.mjs": 1,
    "test/completion-readiness.test.mjs": 5,
    "test/completion-receipt-profile.test.mjs": 1,
    "test/config-nonce-slot-proof.test.mjs": 1,
    "test/d11-deadline-watch.test.mjs": 1,
    "test/d11-import-boundary.test.mjs": 1,
    "test/d11-purchase-actions.test.mjs": 1,
    "test/d11-seam-parameters.test.mjs": 1,
    "test/delivery-access-model.test.mjs": 1,
    "test/delivery-evidence-gate.test.mjs": 1,
    "test/delta-ledger-gate.test.mjs": 639,
    "test/diagnostic-bounds.test.mjs": 6,
    "test/diagnostic-projection.test.mjs": 2,
    "test/diagnostic-reader.test.mjs": 1,
    "test/diagnostic-store-regressions.test.mjs": 1,
    "test/directory-byte-budget.test.mjs": 1,
    "test/durable-journal-owned-append.test.mjs": 1,
    "test/durable-journal-recovery.test.mjs": 1,
    "test/durable-journal-rejections.test.mjs": 1,
    "test/engine-floor-portability.test.mjs": 1,
    "test/fetch-abort-settle.test.mjs": 1,
    "test/guarded-sqlite.test.mjs": 1,
    "test/host-observations.test.mjs": 29,
    "test/ingress-admission.test.mjs": 1,
    "test/intent-canonical-depth.test.mjs": 1,
    "test/job-id-uniqueness.test.mjs": 1,
    "test/native-adapter-auth.test.mjs": 1,
    "test/native-broadcast-once.test.mjs": 1,
    "test/native-lock-order.test.mjs": 1,
    "test/native-payment-evidence-shape.test.mjs": 1,
    "test/native-stage-help.test.mjs": 1,
    "test/native-supersession-unavailable.test.mjs": 1,
    "test/negotiate-phase-after-readback.test.mjs": 1,
    "test/node-demos-loading.test.mjs": 13,
    "test/node-wallet-demosdk.test.mjs": 1,
    "test/node-wallet-final-content.test.mjs": 2,
    "test/node-wallet-fresh-child.test.mjs": 2,
    "test/node-wallet-lanes.test.mjs": 4,
    "test/node-wallet-rpc-bounds.test.mjs": 4,
    "test/node-wallet-rpc-clock.test.mjs": 1,
    "test/node-wallet-session.test.mjs": 2,
    "test/operator-approval-request-bytes.test.mjs": 1,
    "test/package-contents.test.mjs": 142,
    "test/packed-consumer.test.mjs": 140,
    "test/passive-observation.test.mjs": 1,
    "test/portal-capability.test.mjs": 2,
    "test/price-bound.test.mjs": 1,
    "test/public-admission.test.mjs": 1,
    "test/public-api-inventory.test.mjs": 46,
    "test/public-api.test.mjs": 1,
    "test/public-composition.test.mjs": 1,
    "test/public-demos-reader-construction.test.mjs": 1,
    "test/public-demos-reader-consumers.test.mjs": 1,
    "test/public-demos-reader-errors.test.mjs": 1,
    "test/public-demos-reader-first-read.test.mjs": 1,
    "test/public-demos-reader-purchase-observation.test.mjs": 1,
    "test/public-demos-reader-surface.test.mjs": 1,
    "test/public-guidance.test.mjs": 100,
    "test/public-readback.test.mjs": 1,
    "test/purchase-executed-only.test.mjs": 2,
    "test/purchase-integrity.test.mjs": 1,
    "test/purchase-review-races.test.mjs": 1,
    "test/purchase-state-schema.test.mjs": 1,
    "test/purchase-tx-admission.test.mjs": 6,
    "test/purchase-tx-boundary.test.mjs": 1,
    "test/purchase-tx-nesting.test.mjs": 1,
    "test/purchase-tx-result-options.test.mjs": 1,
    "test/purchase-tx-results.test.mjs": 1,
    "test/readback-review-decisions.floor.test.mjs": 2,
    "test/readback-review-decisions.test.mjs": 2,
    "test/readme-contract.test.mjs": 2,
    "test/rpc-byte-budget.test.mjs": 1,
    "test/runtime-floor.test.mjs": 1,
    "test/seller-session-delegation-job-id.test.mjs": 1,
    "test/signatures-claim-ref.test.mjs": 1,
    "test/sqlite-floor-iterators.test.mjs": 1,
    "test/sqlite-iterator-own-methods.test.mjs": 1,
    "test/sqlite-iterator-own-next-refusal.test.mjs": 1,
    "test/sqlite-lease-result-options.test.mjs": 1,
    "test/sqlite-purchase-journal.test.mjs": 1,
    "test/sqlite-purchase-result-options.test.mjs": 1,
    "test/sqlite-purchase-temp-admission.test.mjs": 1,
    "test/sqlite-statement-boundary-regressions.test.mjs": 2,
    "test/sqlite-statement-boundary.test.mjs": 1,
    "test/sqlite-statement-policy.test.mjs": 1,
    "test/sqlite-write-lease.test.mjs": 1,
    "test/storage-read-nonobservation.test.mjs": 1,
    "test/store-host-boundary.test.mjs": 1,
    "test/sweep-contracts.test.mjs": 1,
  },
};

// Seconds per test of each file in SPLIT_FILES, from the same run (that job's duration_ms per test). A test with no
// entry gets DEFAULT_TEST_WEIGHT.
export const TEST_WEIGHTS = {
  "scripts/delta-provenance.test.mjs": {
    "committed delta history and generated per-file table agree": 106,
    "callback history explains the superseded guard and preserves the write-lease tree": 1,
    "callback history check needs no ancestry beyond the checked-out commit": 1,
    "SQLite split history distinguishes the lease from the later transaction adapter": 1,
    "the publication inventory cannot omit an outside-only commit or name an absent hash": 210,
    "an unenumerated working-tree edit is refused": 105,
    "a deletion needs a named delta": 109,
    "removing a delta record cannot hide its historical file changes": 106,
    "removing a bookkeeping checkpoint is also refused": 105,
    "a later commit with an unlisted moved-file edit is refused": 55,
    "the per-file Markdown table is checked, not trusted": 105,
    "a committed deletion without a named delta is refused": 55,
    "a staged moved-file edit with restored working bytes is refused": 105,
    "archived source and pre-publication delta evidence cannot be rewritten": 104,
    "launch review: unrelated future SDK commits do not need a client re-pin": 56,
    "launch review: unrelated main commits and a PR merge preserve client provenance": 35,
    "launch review: unrelated main commits and a PR merge preserve client provenance from a detached HEAD": 33,
    "D11 source history accepts delta(client) records": 113,
    "D11 source history accepts fix(client) records": 113,
    "two commits sharing a subject need SHA-qualified selectors": 227,
    "a commit reached only through a content-free merge is still audited": 34,
    "the inventory cannot name an unreachable commit": 106,
    "a hashed inventory row must carry its commit subject, and one commit has one row": 214,
    "a record that names its full commit hash needs no delta prefix in the subject, an unqualified one does": 113,
    "a WF delta record is accepted and an unlisted delta id is still refused": 118,
    "a WF record selected by its full commit hash may carry a fix(client) subject; the same subject without the hash is refused": 112,
    "the ledger gate refuses each fault in a PR's own delta records, one table row per fault, each run in a scratch clone of the checked head, and the committed head passes with every WF record listing the files its PR changed at their committed blobs": 543,
  },
};

// Which Node legs run each suite. client: node 22 only. seller: both legs on every event, pull requests included, so a
// node 24 seller failure shows before the merge.
export function suiteRuns(suite, node) {
  if (suite === "client") return node === "22";
  if (suite === "seller") return NODE_LEGS.includes(node);
  throw new Error(`unknown suite ${suite}`);
}

// The events ci.yml runs on. The plan is the same for each; an unknown event (a new trigger or a typo) is refused rather
// than silently planned.
export const EVENTS = ["pull_request", "push", "merge_group", "workflow_dispatch"];

/** The shard job's matrix entries for one event: one per (Node leg, suite, shard) that runs. */
export function plan(event) {
  if (!EVENTS.includes(event)) throw new Error(`unknown event ${event}: expected one of ${EVENTS.join(", ")}`);
  const include = [];
  for (const node of NODE_LEGS) {
    for (const [suite, count] of Object.entries(SHARDS)) {
      if (!suiteRuns(suite, node)) continue;
      for (let index = 1; index <= count; index += 1) {
        include.push({ "node-version": node, part: `${suite}-${index}`, suite, shard: `${index}/${count}` });
      }
    }
  }
  return include;
}

/** Test names of each split file of suite that is among files (paths relative to baseDir), listed by loading it. */
export function splitTests(suite, files, baseDir) {
  const out = {};
  for (const file of SPLIT_FILES[suite] ?? []) {
    if (!files.includes(file)) continue;
    const names = listTests(file, baseDir);
    if (names.length === 0) throw new Error(`${suite} ${file}: no top-level tests found to split`);
    const twice = names.filter((name, index) => names.indexOf(name) !== index);
    if (twice.length > 0) throw new Error(`${suite} ${file}: test names used twice: ${[...new Set(twice)].join(" | ")}`);
    out[file] = names;
  }
  return out;
}

/**
 * Splits the suite's work into SHARDS[suite] shards. Each shard is a list (sorted by file name) of entries
 * { file, tests }: tests is null for a whole file, or the names (in source order) of the split file's tests it runs.
 * Every whole file and every test of a split file is in exactly one shard.
 */
export function assignUnits(suite, files, split = {}) {
  const count = SHARDS[suite];
  if (!count) throw new Error(`unknown suite ${suite}`);
  const weights = WEIGHTS[suite];
  const units = [];
  for (const file of new Set(files)) {
    if (Object.hasOwn(split, file)) {
      const tw = TEST_WEIGHTS[file] ?? {};
      for (const test of split[file]) units.push({ file, test, weight: Object.hasOwn(tw, test) ? tw[test] : DEFAULT_TEST_WEIGHT });
    } else {
      units.push({ file, test: null, weight: Object.hasOwn(weights, file) ? weights[file] : DEFAULT_WEIGHT });
    }
  }
  const key = (unit) => `${unit.file}\u0000${unit.test ?? ""}`;
  units.sort((a, b) => b.weight - a.weight || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const shards = Array.from({ length: count }, () => ({ units: [], weight: 0 }));
  for (const unit of units) {
    let target = shards[0];
    for (const shard of shards) if (shard.weight < target.weight) target = shard;
    target.units.push(unit);
    target.weight += unit.weight;
  }
  return shards.map((shard) => {
    const byFile = new Map();
    for (const unit of shard.units) {
      if (unit.test === null) byFile.set(unit.file, null);
      else byFile.set(unit.file, [...(byFile.get(unit.file) ?? []), unit.test]);
    }
    return [...byFile.keys()].sort().map((file) => {
      const tests = byFile.get(file);
      return { file, tests: tests === null ? null : split[file].filter((name) => tests.includes(name)) };
    });
  });
}

/** Splits files into SHARDS[suite] lists (each sorted by name); every file is in exactly one. No file is split. */
export function assign(suite, files) {
  return assignUnits(suite, files).map((shard) => shard.map((entry) => entry.file));
}

/** "K/N" for suite: K in 1..N and N equal to SHARDS[suite], so a stale count in a caller fails instead of skipping files. */
export function parseShard(text, suite) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(String(text ?? "").trim());
  const count = SHARDS[suite];
  if (!match || Number(match[2]) !== count || Number(match[1]) > count) {
    throw new Error(`shard "${text}" is not K/${count} for the ${suite} suite`);
  }
  return { index: Number(match[1]), count };
}

export const shardFiles = (suite, files, index) => assign(suite, files)[index - 1];
export const shardEntries = (suite, files, split, index) => assignUnits(suite, files, split)[index - 1];

export const shardJobName = (node, part) => `build-test shard (node ${node}, ${part})`;
export const mainJobName = (node) => `build-test main (node ${node})`;

/** Failures (empty when the leg passed): the main job and every planned shard of this leg must have succeeded. */
export function verify(node, event, jobs) {
  const expected = [mainJobName(node), ...plan(event).filter((entry) => entry["node-version"] === node)
    .map((entry) => shardJobName(node, entry.part))];
  const failures = [];
  for (const name of expected) {
    const found = jobs.filter((job) => job.name === name);
    if (found.length !== 1) failures.push(`${name}: ${found.length} jobs in this run, expected 1`);
    else if (found[0].conclusion !== "success") failures.push(`${name}: ${found[0].status}/${found[0].conclusion}`);
  }
  return { expected, failures };
}

export function sellerFiles() {
  const child = spawnSync(process.execPath, [join(repoRoot, "scripts/run-seller-tests.mjs"), "--list"], {
    encoding: "utf8", env: { ...process.env, DACS_SELLER_TEST_SHARD: "" },
  });
  if (child.status !== 0) throw new Error(`run-seller-tests.mjs --list failed: ${child.stderr}`);
  return JSON.parse(child.stdout);
}

export const clientDir = join(repoRoot, "packages/dacs-client");

export async function clientFiles() {
  const { discoverTests } = await import(pathToFileURL(join(repoRoot, "packages/dacs-client/scripts/test.mjs")).href);
  return discoverTests(join(repoRoot, "packages/dacs-client"));
}

/**
 * Failures (empty when complete): each file of each suite is selected by exactly one shard and nothing else is; for a
 * split file, each of its tests is instead, and the file is never also selected whole.
 */
export function checkPartition(suite, files, split = {}) {
  const shards = assignUnits(suite, files, split);
  const failures = [];
  const seen = new Map();
  const note = (unit, index) => seen.set(unit, [...(seen.get(unit) ?? []), index + 1]);
  shards.forEach((list, index) => list.forEach((entry) => {
    if (entry.tests === null) note(entry.file, index);
    else for (const test of entry.tests) note(`${entry.file} > ${test}`, index);
  }));
  const want = files.flatMap((file) => (Object.hasOwn(split, file) ? split[file].map((test) => `${file} > ${test}`) : [file]));
  for (const unit of want) {
    const at = seen.get(unit) ?? [];
    if (at.length !== 1) failures.push(`${suite} ${unit}: selected by ${at.length} shards`);
  }
  for (const unit of seen.keys()) if (!want.includes(unit)) failures.push(`${suite} ${unit}: not a test file or test`);
  const size = shards.reduce((sum, list) => sum + list.reduce((n, entry) => n + (entry.tests?.length ?? 1), 0), 0);
  if (size !== want.length) failures.push(`${suite}: shard sizes do not add up`);
  for (const file of SPLIT_FILES[suite] ?? []) if (!files.includes(file)) failures.push(`${suite} ${file}: listed in SPLIT_FILES but not a test file`);
  return { shards, failures };
}

/** Failures (empty when complete): wherever a suite runs, the plan has each of its shards exactly once. */
export function checkPlan() {
  const failures = [];
  for (const event of EVENTS) {
    const entries = plan(event);
    for (const node of NODE_LEGS) {
      for (const [suite, count] of Object.entries(SHARDS)) {
        const shards = entries.filter((entry) => entry["node-version"] === node && entry.suite === suite)
          .map((entry) => entry.shard).sort();
        const want = suiteRuns(suite, node) ? Array.from({ length: count }, (_, i) => `${i + 1}/${count}`) : [];
        if (JSON.stringify(shards) !== JSON.stringify(want)) failures.push(`plan ${event} node ${node} ${suite}: ${shards.join(",") || "none"}, expected ${want.join(",") || "none"}`);
      }
    }
  }
  return failures;
}

const option = (args, name) => {
  const at = args.indexOf(name);
  if (at < 0 || at + 1 >= args.length) throw new Error(`missing ${name}`);
  return args[at + 1];
};

async function main(args) {
  const [command] = args;
  if (command === "plan") {
    process.stdout.write(`${JSON.stringify({ include: plan(option(args, "--event")) })}\n`);
    return 0;
  }
  if (command === "check") {
    const planFailures = checkPlan();
    for (const failure of planFailures) console.error(`[ci-shards] FAIL ${failure}`);
    let failed = planFailures.length > 0;
    for (const [suite, files, baseDir] of [["seller", sellerFiles(), null], ["client", await clientFiles(), clientDir]]) {
      let split;
      try {
        split = baseDir === null ? {} : splitTests(suite, files, baseDir);
      } catch (error) {
        console.error(`[ci-shards] FAIL ${error.message}`);
        failed = true;
        continue;
      }
      const { shards, failures } = checkPartition(suite, files, split);
      const weight = (list) => list.reduce((sum, entry) => sum + (entry.tests === null
        ? (WEIGHTS[suite][entry.file] ?? DEFAULT_WEIGHT)
        : entry.tests.reduce((n, test) => n + (TEST_WEIGHTS[entry.file]?.[test] ?? DEFAULT_TEST_WEIGHT), 0)), 0);
      const tests = Object.values(split).reduce((sum, names) => sum + names.length, 0);
      console.log(`[ci-shards] ${suite}: ${files.length} files${tests ? ` (${Object.keys(split).length} split into ${tests} tests)` : ""} in ${shards.length} shards: ${shards
        .map((list, index) => `${index + 1}/${shards.length} ${list.length} files ~${Math.round(weight(list) / 60)} min`).join(", ")}`);
      for (const failure of failures) console.error(`[ci-shards] FAIL ${failure}`);
      failed ||= failures.length > 0;
    }
    return failed ? 1 : 0;
  }
  if (command === "verify") {
    const node = option(args, "--node");
    const event = option(args, "--event");
    const jobs = readFileSync(option(args, "--jobs"), "utf8").split("\n").filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    const { expected, failures } = verify(node, event, jobs);
    for (const name of expected) if (!failures.some((failure) => failure.startsWith(`${name}:`))) console.log(`[ci-shards] ok ${name}`);
    for (const failure of failures) console.error(`[ci-shards] FAIL ${failure}`);
    return failures.length > 0 ? 1 : 0;
  }
  console.error("usage: ci-shards.mjs plan --event <e> | check | verify --node <v> --event <e> --jobs <file>");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2));
