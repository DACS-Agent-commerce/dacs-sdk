// CI shards for the two long build-test suites (seller and client), so each runs as parallel jobs instead of one.
//
//   node scripts/ci-shards.mjs plan --event <github.event_name>   matrix JSON for the build-test shard job
//   node scripts/ci-shards.mjs check                              every test file is in exactly one shard
//   node scripts/ci-shards.mjs verify --node <v> --event <e> --jobs <file>
//                                                                 the run's jobs for one Node leg all passed
//
// Files are assigned by weight (seconds per file from a recent CI run), heaviest first, each to the shard with the
// least weight so far; ties go to the lower shard, then to the earlier file name. A file with no recorded weight gets
// DEFAULT_WEIGHT, so a new test file always lands in some shard. The weights only balance the shards: a stale weight
// makes the split uneven, never incomplete.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const NODE_LEGS = ["22", "24"];
export const SHARDS = { seller: 2, client: 2 };
export const DEFAULT_WEIGHT = 30;

// Seconds per file on the hosted runner, from one build-test (node 22) job of the one-job layout. client: the time
// between consecutive "[client-tests] <file>" lines in that job's log. seller: one process for all files, so per-file
// times come from timing each file alone on a test machine, scaled to add up to that job's seller step, with
// seller-host-native-delivery.test.mjs set to the time it ran on its own in that log. The weights only balance the
// shards; a missing or stale entry never drops a file (see check).
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
    "scripts/delta-frontier.test.mjs": 678,
    "scripts/delta-provenance.test.mjs": 2178,
    "scripts/test-layout.test.mjs": 1,
    "test/bound-terms-mismatch.test.mjs": 1,
    "test/buyer-chain-indeterminate.test.mjs": 1,
    "test/chain-nonce-slot.test.mjs": 1,
    "test/commitment-contradiction-classifier.test.mjs": 1,
    "test/completion-readiness.test.mjs": 5,
    "test/config-nonce-slot-proof.test.mjs": 1,
    "test/d11-deadline-watch.test.mjs": 1,
    "test/d11-import-boundary.test.mjs": 1,
    "test/d11-purchase-actions.test.mjs": 1,
    "test/d11-seam-parameters.test.mjs": 1,
    "test/delivery-access-model.test.mjs": 1,
    "test/delivery-evidence-gate.test.mjs": 1,
    "test/delta-ledger-gate.test.mjs": 519,
    "test/diagnostic-bounds.test.mjs": 7,
    "test/diagnostic-projection.test.mjs": 3,
    "test/diagnostic-reader.test.mjs": 1,
    "test/diagnostic-store-regressions.test.mjs": 1,
    "test/directory-byte-budget.test.mjs": 1,
    "test/durable-journal-owned-append.test.mjs": 1,
    "test/durable-journal-recovery.test.mjs": 1,
    "test/durable-journal-rejections.test.mjs": 1,
    "test/engine-floor-portability.test.mjs": 1,
    "test/fetch-abort-settle.test.mjs": 1,
    "test/host-observations.test.mjs": 29,
    "test/ingress-admission.test.mjs": 1,
    "test/intent-canonical-depth.test.mjs": 1,
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
    "test/node-wallet-fresh-child.test.mjs": 3,
    "test/node-wallet-lanes.test.mjs": 4,
    "test/node-wallet-rpc-bounds.test.mjs": 5,
    "test/node-wallet-rpc-clock.test.mjs": 1,
    "test/node-wallet-session.test.mjs": 2,
    "test/package-contents.test.mjs": 156,
    "test/packed-consumer.test.mjs": 101,
    "test/passive-observation.test.mjs": 1,
    "test/portal-capability.test.mjs": 2,
    "test/price-bound.test.mjs": 1,
    "test/public-admission.test.mjs": 1,
    "test/public-api-inventory.test.mjs": 49,
    "test/public-api.test.mjs": 1,
    "test/public-composition.test.mjs": 1,
    "test/public-guidance.test.mjs": 105,
    "test/public-readback.test.mjs": 1,
    "test/purchase-executed-only.test.mjs": 2,
    "test/purchase-integrity.test.mjs": 1,
    "test/purchase-review-races.test.mjs": 1,
    "test/purchase-state-schema.test.mjs": 1,
    "test/purchase-tx-admission.test.mjs": 7,
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

// Which Node legs run each suite. client: node 22 only.
// seller: both legs, except that a pull request runs it on node 22 only; the node 24 leg runs it on pushes and in
// the merge queue.
export function suiteRuns(suite, node, event) {
  if (suite === "client") return node === "22";
  if (suite === "seller") return node === "22" || event !== "pull_request";
  throw new Error(`unknown suite ${suite}`);
}

/** The shard job's matrix entries for one event: one per (Node leg, suite, shard) that runs. */
export function plan(event) {
  const include = [];
  for (const node of NODE_LEGS) {
    for (const [suite, count] of Object.entries(SHARDS)) {
      if (!suiteRuns(suite, node, event)) continue;
      for (let index = 1; index <= count; index += 1) {
        include.push({ "node-version": node, part: `${suite}-${index}`, suite, shard: `${index}/${count}` });
      }
    }
  }
  return include;
}

/** Splits files into SHARDS[suite] lists (each sorted by name); every file is in exactly one. */
export function assign(suite, files) {
  const count = SHARDS[suite];
  if (!count) throw new Error(`unknown suite ${suite}`);
  const weights = WEIGHTS[suite];
  const weight = (file) => (Object.hasOwn(weights, file) ? weights[file] : DEFAULT_WEIGHT);
  const order = [...new Set(files)].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const shards = Array.from({ length: count }, () => ({ files: [], weight: 0 }));
  for (const file of order) {
    let target = shards[0];
    for (const shard of shards) if (shard.weight < target.weight) target = shard;
    target.files.push(file);
    target.weight += weight(file);
  }
  return shards.map((shard) => shard.files.sort());
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

export async function clientFiles() {
  const { discoverTests } = await import(pathToFileURL(join(repoRoot, "packages/dacs-client/scripts/test.mjs")).href);
  return discoverTests(join(repoRoot, "packages/dacs-client"));
}

/** Failures (empty when complete): each file of each suite is selected by exactly one shard and nothing else is. */
export function checkPartition(suite, files) {
  const shards = assign(suite, files);
  const failures = [];
  const seen = new Map();
  shards.forEach((list, index) => list.forEach((file) => seen.set(file, [...(seen.get(file) ?? []), index + 1])));
  for (const file of files) {
    const at = seen.get(file) ?? [];
    if (at.length !== 1) failures.push(`${suite} ${file}: selected by ${at.length} shards`);
  }
  for (const file of seen.keys()) if (!files.includes(file)) failures.push(`${suite} ${file}: not a test file`);
  if (shards.reduce((sum, list) => sum + list.length, 0) !== files.length) failures.push(`${suite}: shard sizes do not add up`);
  return { shards, failures };
}

/** Failures (empty when complete): wherever a suite runs, the plan has each of its shards exactly once. */
export function checkPlan() {
  const failures = [];
  for (const event of ["pull_request", "push", "merge_group", "workflow_dispatch"]) {
    const entries = plan(event);
    for (const node of NODE_LEGS) {
      for (const [suite, count] of Object.entries(SHARDS)) {
        const shards = entries.filter((entry) => entry["node-version"] === node && entry.suite === suite)
          .map((entry) => entry.shard).sort();
        const want = suiteRuns(suite, node, event) ? Array.from({ length: count }, (_, i) => `${i + 1}/${count}`) : [];
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
    for (const [suite, files] of [["seller", sellerFiles()], ["client", await clientFiles()]]) {
      const { shards, failures } = checkPartition(suite, files);
      const weight = (list) => list.reduce((sum, file) => sum + (WEIGHTS[suite][file] ?? DEFAULT_WEIGHT), 0);
      console.log(`[ci-shards] ${suite}: ${files.length} files in ${shards.length} shards: ${shards
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
