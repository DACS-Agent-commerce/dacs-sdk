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
// makes the split uneven, never incomplete. check refuses a weight whose key names no test file or test (staleKeys), so
// a renamed or removed test cannot leave its weight behind; a test with no weight is fine.
//
// A file in SPLIT_FILES is not assigned whole: each of its top-level tests is assigned on its own, by the same rule,
// alongside the whole files. Its test names are listed by loading it without running any test
// (scripts/ci-test-names.mjs). A shard that holds some of its tests runs the file once with every other test skipped
// by exact name, and the suite's runner (run-client-tests.mjs, run-seller-tests.mjs) checks that the tests that ran
// are exactly the ones this shard was given, so a test the listing missed fails every shard instead of going unrun.
// Listing loads the file's imports, so a split seller file can only be listed after npm run build.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listTests } from "./ci-test-names.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const NODE_LEGS = ["22", "24"];
export const SHARDS = { seller: 4, client: 4 };
export const DEFAULT_WEIGHT = 30;
export const DEFAULT_TEST_WEIGHT = 60;

// Files whose tests are spread over the shards one by one.
// - client: delta-provenance re-checks the whole delta history in most of its 27 tests, so as one file it took about
//   50 minutes in a single job.
// - seller: seller-host-native-delivery runs 236 tests (its own and the host-job capacity cases it imports) in about
//   19 minutes on a normal hosted runner and about 35 on a slow one, more than a whole shard should take.
export const SPLIT_FILES = { seller: ["seller-host-native-delivery.test.mjs"], client: ["scripts/delta-provenance.test.mjs"] };

// Seconds per file on a normal hosted runner. The weights only balance the shards; a missing entry never drops a file
// (see check), and check refuses an entry that names no test file.
// - client: the time between consecutive "[client-tests] <file>" lines in a client shard job's log. The current
//   client estimates use the mean from successful Node 22 hosted runs 45100507368 and 45103485226 (2026-11-23);
//   obvious whole-file drift is refreshed alongside the per-test timings for the split history file.
// - seller: from node 22 seller jobs of the two-shard layout. Files of the old shard 1: the sum of their tests'
//   duration_ms (mean of two jobs) plus half a second to start the file's process. Files of the old shard 2 (that log
//   has no per-file split): each file timed alone on a test machine, scaled so they add up to that shard's measured
//   test step (about 21.5 minutes). A split file has no whole-file weight; its tests are in TEST_WEIGHTS.
export const WEIGHTS = {
  seller: {
    "abandoned-purchase.test.mjs": 1,
    "admission-docs.test.mjs": 0.5,
    "agent-construction.test.mjs": 5.9,
    "approval-ledger.test.mjs": 0.5,
    "approval-regressions.test.mjs": 1.7,
    "approval-retained.test.mjs": 2.6,
    "approval-stop.test.mjs": 0.9,
    "artifact-lane-recovery.test.mjs": 0.8,
    "artifact-observations.test.mjs": 0.9,
    "artifact-publication.test.mjs": 0.8,
    "artifact-sdk-admission.test.mjs": 1.7,
    "bilateral-vet.test.mjs": 2.5,
    "bounded-reads.test.mjs": 0.9,
    "buyer-access.test.mjs": 0.5,
    "canonical-job-boundaries.test.mjs": 0.9,
    "capacity-reconciliation.test.mjs": 17.3,
    "challenge-ledger.test.mjs": 6.5,
    "challenge-route-wire.test.mjs": 14.7,
    "cli-config.test.mjs": 1.2,
    "cli-init.test.mjs": 4.1,
    "cli-main.test.mjs": 1.6,
    "closed-job-capacity-rows.test.mjs": 2.9,
    "commit-after-deadline.test.mjs": 3.2,
    "commitment-recovery.test.mjs": 50.7,
    "compensation-proof.test.mjs": 2.8,
    "completed-at-capacity.test.mjs": 7.7,
    "confirmed-native-transfer-fixture.test.mjs": 0.5,
    "context-admission-transaction.test.mjs": 30.7,
    "context-budgets.test.mjs": 1.8,
    "context-hold-startup.test.mjs": 1.5,
    "context-provider-checkpoints.test.mjs": 17.9,
    "context-records.test.mjs": 1.4,
    "context-recovery-wire.test.mjs": 28.9,
    "context-route-wire.test.mjs": 33,
    "context-start-limits-wire.test.mjs": 1.2,
    "context-wire-ports.test.mjs": 0.9,
    "context-work-registry.test.mjs": 0.9,
    "d5-admission.test.mjs": 1.4,
    "d5-challenge-retention.test.mjs": 2.3,
    "d5-limits-before-effects.test.mjs": 0.6,
    "d5-recovery.test.mjs": 0.6,
    "d5-vet-decisions.test.mjs": 0.9,
    "deliverable-restart-resend.test.mjs": 0.6,
    "deliverable-wallet-journal.test.mjs": 2,
    "delivery-capabilities.test.mjs": 1.4,
    "delivery-context-bounds.test.mjs": 1.1,
    "delivery-context-capabilities.test.mjs": 0.6,
    "delivery-context-deadline.test.mjs": 0.9,
    "delivery-context-reconstruction.test.mjs": 1.5,
    "demos-claims.test.mjs": 0.9,
    "demosdk-bare-hash-signature.test.mjs": 1,
    "devnet-delivery-wallet-refusal.test.mjs": 0.9,
    "devnet-storage-write-recovery.test.mjs": 1.1,
    "durable-approval-ledger.test.mjs": 0.8,
    "durable-effects.test.mjs": 17.6,
    "durable-file.test.mjs": 0.9,
    "durable-initialization.test.mjs": 3,
    "durable-job-capacity.test.mjs": 0.9,
    "durable-sessions.test.mjs": 4.9,
    "effect-boundary-barriers.test.mjs": 1.2,
    "effect-boundary.test.mjs": 3.2,
    "effect-history.test.mjs": 2.4,
    "finalized-commitment-reader.test.mjs": 0.9,
    "fixture-settlement-malformed-claims.test.mjs": 5.9,
    "fsync-spy.test.mjs": 0.9,
    "hold-release-store.test.mjs": 3.1,
    "hold-release.test.mjs": 7.8,
    "host-context-routes.test.mjs": 18.7,
    "host-lifecycle.test.mjs": 11.2,
    "host-wire-state.test.mjs": 25.5,
    "http-command-boundaries.test.mjs": 0.6,
    "installed-package.test.mjs": 5.1,
    "kit-operation-guard.test.mjs": 3.8,
    "kit-store-format.test.mjs": 4.7,
    "listing-stop-after-approval.test.mjs": 0.9,
    "native-delivery-read-bounds.test.mjs": 0.9,
    "native-payment-evidence-consumer.test.mjs": 1,
    "native-payment-stage.test.mjs": 2.4,
    "native-retry-seam.test.mjs": 0.9,
    "negotiate-phase-after-readback.test.mjs": 3.2,
    "no-network-trap.test.mjs": 0.9,
    "node-identity.test.mjs": 1.9,
    "old-domain-removal.test.mjs": 2.3,
    "one-seller-nonce.test.mjs": 9,
    "operator-custody-directory-sync.test.mjs": 1.2,
    "operator-custody-durability.test.mjs": 2.6,
    "operator-custody-guarded-request.test.mjs": 0.9,
    "operator-custody-parent-durability.test.mjs": 1.9,
    "operator-custody-retained-sync.test.mjs": 1.9,
    "operator-inputs.test.mjs": 0.8,
    "party-vet-store.test.mjs": 1.3,
    "payment-evidence-wallet-journal.test.mjs": 9.3,
    "payment-recovery.test.mjs": 267.7,
    "prepare-consumer.test.mjs": 5.8,
    "presentation-signing.test.mjs": 3.3,
    "process-lease.test.mjs": 2.1,
    "proposal-admission.test.mjs": 2.8,
    "proposal-phase.test.mjs": 2.2,
    "public-listener-admission.test.mjs": 12.6,
    "public-listener-modes.test.mjs": 6.6,
    "purchase-capacity.test.mjs": 17.7,
    "purchase-protocol.test.mjs": 0.7,
    "rail-session-admission.test.mjs": 0.9,
    "readback-deadline.test.mjs": 12.1,
    "readme-contract.test.mjs": 0.5,
    "readme-imports.test.mjs": 0.9,
    "refused-create-retry.test.mjs": 1,
    "refused-deliverable-republish.test.mjs": 0.9,
    "request-validation.test.mjs": 1.3,
    "reservation-accounting.test.mjs": 29.3,
    "retained-vet-readers.test.mjs": 4.3,
    "route-recovery-table.test.mjs": 68,
    "seller-agent-contracts.test.mjs": 0.9,
    "seller-client-deadline.test.mjs": 0.5,
    "seller-issuance.test.mjs": 1.1,
    "seller-key-diagnostics.test.mjs": 1.6,
    "seller-key-revoked-binding.test.mjs": 0.9,
    "seller-key-roles.test.mjs": 0.6,
    "seller-key.test.mjs": 1.1,
    "seller-lifecycle-gates.test.mjs": 44.3,
    "seller-payment-retry.test.mjs": 13.6,
    "seller-raw-json.test.mjs": 9,
    "seller-settlement-profile.test.mjs": 42.6,
    "seller-state-stale-locks.test.mjs": 3.6,
    "seller-substrate-profile.test.mjs": 0.6,
    "seller-wire-client-auth.test.mjs": 3.8,
    "session-challenge-restore.test.mjs": 9.1,
    "settlement-collisions.test.mjs": 12.9,
    "signature-domain.test.mjs": 0.9,
    "signed-listing.test.mjs": 0.6,
    "signing-gate-bind.test.mjs": 0.9,
    "slot-retirement.test.mjs": 1.8,
    "sr2-fixture-evidence-marking.test.mjs": 0.6,
    "sr2-foreign-readback-budget.test.mjs": 0.9,
    "sr2-readback.test.mjs": 0.7,
    "sr2-receipt-verification.test.mjs": 1.1,
    "terminal-session-payment.test.mjs": 11.3,
    "transaction-signature.test.mjs": 0.9,
    "transport-readback.test.mjs": 8.7,
    "transport-reconciliation.test.mjs": 19.9,
    "transport-session-restore.test.mjs": 1.5,
    "vet-anchor-retry.test.mjs": 2.3,
    "vet-challenge-retry.test.mjs": 11.3,
    "vet-checkpoints.test.mjs": 0.9,
    "vet-evidence-resolvers.test.mjs": 2.9,
    "vet-issuance-retry.test.mjs": 1.3,
    "vet-late-sign-recheck.test.mjs": 0.7,
    "vet-legacy-lifecycle.test.mjs": 1.2,
    "vet-lifecycle.test.mjs": 3.5,
    "vet-orchestrator-anchor.test.mjs": 2.4,
    "vet-orchestrator-consumers.test.mjs": 54.6,
    "vet-orchestrator-producer.test.mjs": 18,
    "vet-orchestrator-retained-mode.test.mjs": 6.5,
    "vet-orchestrator-route.test.mjs": 1.3,
    "vet-presence.test.mjs": 1.8,
    "vet-price-terms.test.mjs": 0.7,
    "vet-production.test.mjs": 4.1,
    "vet-resume.test.mjs": 0.7,
    "vet-run-recovery.test.mjs": 1.7,
    "vet-way-back.test.mjs": 1.3,
    "vet-write-inclusion-readback.test.mjs": 1.6,
    "vetted-proposal.test.mjs": 6.8,
    "wallet-recovery-docs.test.mjs": 0.9,
    "wire-commitment-recovery.test.mjs": 4.8,
    "wire-discovery-and-reads.test.mjs": 5.6,
    "wire-effect-crash-points.test.mjs": 7.8,
    "wire-effect-restart.test.mjs": 73.6,
    "wire-effect-routes.test.mjs": 61.5,
    "wire-first-proposal.test.mjs": 3,
    "wire-lapsed-attempts.test.mjs": 3.6,
    "wire-proposal-recovery.test.mjs": 2.9,
    "wire-proposal-session-fence.test.mjs": 8.4,
    "wire-request-refusals.test.mjs": 3.5,
    "wire-signed-routes.test.mjs": 32.4,
    "write-ceiling-agreement.test.mjs": 1.2,
  },
  client: {
    "scripts/check-hold.test.mjs": 56.8,
    "scripts/check-provenance.test.mjs": 2,
    "scripts/delta-anchor.test.mjs": 72.7,
    "scripts/delta-continuity.test.mjs": 4,
    "scripts/delta-frontier.test.mjs": 103.4,
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
    "test/delta-ledger-gate.test.mjs": 63.7,
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
    "test/public-api.test.mjs": 50.3,
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

// Seconds per test of each file in SPLIT_FILES. Client delta-provenance values are means of the per-test TAP durations
// from successful Node 22 hosted runs 45100507368 and 45103485226, measured 2026-11-23. A test with no entry gets
// DEFAULT_TEST_WEIGHT.
export const TEST_WEIGHTS = {
  "scripts/delta-provenance.test.mjs": {
    "committed delta history and immutable record files agree": 7.1,
    "a commit in a scratch clone starts no background git maintenance that could outlive the test": 0.4,
    "callback history explains the superseded guard and matches the recorded write-lease files": 0.1,
    "callback history check needs no ancestry beyond the checked-out commit": 1.1,
    "SQLite split history distinguishes the lease from the later transaction adapter": 0.1,
    "the publication inventory cannot omit an outside-only commit or name an absent hash": 10.6,
    "an unenumerated working-tree edit is refused": 5.5,
    "a deletion needs a named delta": 5.6,
    "removing a delta record cannot hide its historical file changes": 8.9,
    "removing a bookkeeping checkpoint is also refused": 9.2,
    "a later commit with an unlisted moved-file edit is refused": 5.4,
    "a stored per-file Markdown table is refused by the closed freeze": 1.4,
    "a committed deletion without a named delta is refused": 5.6,
    "a staged moved-file edit with restored working bytes is refused": 5.4,
    "archived source and pre-publication delta evidence cannot be rewritten": 7.1,
    "launch review: unrelated future SDK commits do not need a client re-pin": 7.2,
    "launch review: unrelated main commits and a PR merge preserve client provenance": 8.9,
    "launch review: unrelated main commits and a PR merge preserve client provenance from a detached HEAD": 8.8,
    "D11 source history accepts delta(client) records": 11,
    "D11 source history accepts fix(client) records": 10.7,
    "two commits sharing a subject need SHA-qualified selectors": 20.6,
    "a commit reached only through a content-free merge is still audited": 5.6,
    "the inventory cannot name an unreachable commit": 7.4,
    "a hashed inventory row must carry its commit subject, and one commit has one row": 10.5,
    "a record that names its full commit hash needs no delta prefix in the subject, an unqualified one does": 10.6,
    "a WF delta record is accepted and an unlisted delta id is still refused": 11.1,
    "a WF record selected by its full commit hash may carry the subject \"fix(client): TEST published fix without a delta id\"; the same subject without the hash is refused": 10.9,
    "a WF record selected by its full commit hash may carry the subject \"TEST published fix with a plain subject\"; the same subject without the hash is refused": 17.4,
    "the committed head passes and each archived record fault is refused": 46.7,
    "immutable record files refuse an omitted inventory path": 6.4,
    "immutable record files refuse a removed source-change record": 6.3,
    "immutable record files refuse a removed checkpoint": 8.5,
    "immutable record files refuse a renamed record": 6.4,
    "immutable record files refuse an unreachable commit selector": 6.6,
    "immutable record files refuse a changed subject on a hashed selector": 6.5,
    "immutable record files refuse a repeated commit selector": 9.7,
    "immutable record files refuse an unqualified subject without a delta prefix": 6.4,
    "immutable record files refuse a changed terminal blob": 9.8,
    "immutable record files refuse a changed parent blob": 6.4,
    "immutable record files refuse an ordinary record with no changed blob": 9.8,
    "immutable record files refuse an empty file list": 8.3,
    "immutable record files refuse an inventory row naming another file": 6.5,
    "immutable record files refuse an unqualified repeated subject": 8.6,
  },
  // Mean duration_ms of each test over two node 22 seller jobs on normal runners, in registration order.
  "seller-host-native-delivery.test.mjs": {
    "the shipped host admits a new job after paid work retires (restart=false)": 2.6,
    "the shipped host admits a new job after paid work retires (restart=true)": 2.2,
    "a job stays counted while its payment evidence is unsigned, and its retry finishes (finalised, restart=false)": 1.9,
    "a job stays counted while its payment evidence is unsigned, and its retry finishes (finalised, restart=true)": 2.1,
    "a job stays counted while its payment evidence is sent and unread, and its retry finishes (aborted-by-other, restart=false)": 2,
    "a job stays counted while its payment evidence is sent and unread, and its retry finishes (aborted-by-other, restart=true)": 2.1,
    "a job stays counted while its payment evidence is sent and unread, and its retry finishes (finalised, restart=false)": 2,
    "a job stays counted while its payment evidence is sent and unread, and its retry finishes (finalised, restart=true)": 2.1,
    "a job stays counted while its verified payment has no evidence yet, and its retry finishes (aborted-by-other, restart=true)": 2.2,
    "a job stays counted while its delivery evidence is unpublished, and its retry finishes (finalised, restart=false)": 2.1,
    "a job stays counted while its delivery is unsubmitted, and its retry finishes (finalised, restart=true)": 2.3,
    "a restart between the payment record and the completed outcome keeps the paid job open, and one retry finishes and delivers once (its payment evidence is unsigned)": 1.6,
    "a restart between the payment record and the completed outcome keeps the paid job open, and one retry finishes and delivers once (its payment evidence is sent and unread)": 1.7,
    "a restart between the payment record and the completed outcome keeps the paid job open, and one retry finishes and delivers once (its verified payment has no evidence yet)": 1.6,
    "a restart between the payment record and the completed outcome keeps the paid job open, and one retry finishes and delivers once (its delivery evidence is unpublished)": 1.8,
    "a restart between the payment record and the completed outcome keeps the paid job open, and one retry finishes and delivers once (its delivery is unsubmitted)": 1.9,
    "a job whose only claim found no payment frees its slot once its session ends (restart=false)": 1.1,
    "a job whose only claim found no payment frees its slot once its session ends (restart=true)": 1.2,
    "presence-only required purchase is refused before and after restart with evidence false": 0.7,
    "presence-only required purchase is refused before and after restart with evidence true": 0.6,
    "presence-only oneOf purchase is refused before and after restart with evidence false": 0.7,
    "presence-only oneOf purchase is refused before and after restart with evidence true": 0.7,
    "the host takes a native payment to anchored, read-back payment evidence and hands the order to delivery; the confirmed anchor is never sent again": 2,
    "an anchor whose answer was lost after the write is read back, not sent again": 1.6,
    "an indeterminate readback sends nothing: the anchor is sent again only on a proven absence": 1.8,
    "a confirmed anchor is not sent again when the name index later reads it absent": 1.8,
    "an anchor the wallet sent is not sent again while the name index lags: one CREATE (DACS-4 PC-7(b) write-once)": 2.3,
    "an anchor whose answer was lost after the write is not sent again while the name index lags: one CREATE (DACS-4 PC-7(b) write-once)": 2.4,
    "the host does not start without the wallet's journal question: a paid order whose anchor outcome is unknown would have no way on": 0.1,
    "the host takes the evidence anchor and its reconciliation only from one wallet journal: a scripted 'refused' or 'unsigned' answer cannot authorize a second signature": 1.6,
    "a readback outage on the buyer's retry keeps the paid order a retry: once the node answers, the evidence is anchored once and the order is delivered, also across a restart": 4.2,
    "a payment claim a crash left reserved and unfinished is not stranded: the restarted host runs the retained work again, anchors once and delivers": 4.3,
    "a paid outside buyer recovers an uncertain payment after access closes and restart, with one signed evidence CREATE": 2.6,
    "closed-access recovery uses paid-job authority for reconcile and resume; unpaid outsiders only inspect issued unknown writes": 2.6,
    "a crash during the first payment claim, before any work is retained, does not strand the paid order: the restarted host runs the claim again, anchors once and delivers": 2.2,
    "the shipped wallet journal takes a paid order to delivery with one CREATE after a throw before signing, a dropped broadcast or a lost answer, across a restart of the host and the wallet": 6.2,
    "the shipped wallet journal signs anew, once, an evidence CREATE another write of the seller wallet overtook: one CREATE and delivery, also across a restart of the host and the wallet": 5.5,
    "a wallet that threw before signing is asked its journal: nothing signed, so the same evidence is sent once more and the order is delivered, also after a restart": 4.5,
    "a sent anchor the node dropped is broadcast again as the same signed transaction, never signed anew: one CREATE, then delivery": 2.4,
    "a journal that cannot read a kept CREATE's fate signs nothing anew: the claim stays held, and once the read answers the evidence is signed anew once and delivered": 3.4,
    "settlement credit lost while the wallet reads the account nonce signs no successor and keeps the claim held": 2.7,
    "a transfer that stops verifying while the wallet reads the account nonce sends no payment evidence": 1.4,
    "a transfer that stops verifying while the wallet signs the payment evidence sends nothing and keeps the claim held": 1.1,
    "settlement credit: a transfer another job also claims is anchored for neither job and handed to no delivery": 2,
    "settlement credit is checked again right before the anchor is sent: a claim on another job during the readback stops it": 2.2,
    "a readback that is not this payment's evidence is refused before delivery": 1.3,
    "a native payment is delivered: the Deliverable CREATE reads back bound to the Agreement and the settlement": 2.7,
    "a Deliverable the producer does not bind to this job, Agreement and settlement is not sent": 3.9,
    "a producer that answers differently on every call is delivered once with the bytes it prepared, also after a restart": 10.2,
    "a capability refusal after the permit is spent is not final: the same candidate is delivered once on the next claim (restart=false)": 2.8,
    "a capability refusal after the permit is spent is not final: the same candidate is delivered once on the next claim (restart=true)": 3,
    "without a schema in the Listing, a native payment is delivered": 2.1,
    "settlement credit is checked again before the Deliverable is sent: a claim on another job during the delivery stops it": 2.2,
    "settlement credit contested during native submission prevents a CREATE, including restart=false": 2.4,
    "settlement credit contested during native submission prevents a CREATE, including restart=true": 2.6,
    "settlement credit contested while the wallet waits for approval prevents a CREATE, including restart=false": 2.5,
    "settlement credit contested while the wallet waits for approval prevents a CREATE, including restart=true": 2.7,
    "a claim on another job made after the signing check binds only once the submission has returned": 5.4,
    "a native capability without guarded submission is refused when the host starts, before any Agreement is signed": 0.1,
    "a refused unguarded start opens no seller state and releases the lock for a guarded start": 0.4,
    "a restart with an unguarded capability is refused while a paid order is undelivered, and a guarded restart delivers it once": 3,
    "a job fence lost during native submission prevents signing and recovers once after restart": 3.2,
    "a crash during a first claim that keeps nothing does not bind the job to it: the corrected claim after the restart is delivered": 5.6,
    "a consumer composed as the README shows, without a projection reader, takes a paid order to delivery: the agent reads the projection from the wallet journal": 2.8,
    "a landed Deliverable whose records were lost is not submitted again while its readback lags: one CREATE, then delivery": 4.1,
    "a Deliverable submission that fails before anything is signed does not strand the paid order: the next claim submits it once, with and without a restart": 6.4,
    "a proven absence with no reason or an empty reason does not strand the paid order: the next claim submits it once": 5.8,
    "a failed delivery does not skip the payment-evidence check: an unreadable payment holds it with no second submission": 3.3,
    "a Deliverable a capability without a wallet journal signed but lost is held, never submitted again, whatever the read says": 3,
    "a Deliverable CREATE signed and kept before a crash is sent again as the same bytes and delivered": 3.4,
    "a Deliverable CREATE signed and kept before a crash is sent again as the same bytes and delivered, across a restart of the host": 3.5,
    "a kept Deliverable CREATE is not sent again once the seller-state check, asked right before the resend, fails": 3.1,
    "a refused Deliverable CREATE whose nonce another write took is signed again once and delivered": 3.7,
    "a refused Deliverable CREATE whose nonce another write took is signed again once and delivered, across a restart of the host": 4,
    "a refused Deliverable CREATE is not signed again once the seller-state check, asked right before the new signature, fails": 3.6,
    "a refused Deliverable CREATE whose replacement was refused too is held: nothing is signed a third time": 3,
    "a Deliverable CREATE whose broadcast failed after signing is sent again as the same bytes and delivered, signed once": 3.4,
    "a Deliverable CREATE whose broadcast failed after signing is sent again as the same bytes and delivered, signed once, across a restart of the host and the wallet": 4.3,
    "a Deliverable CREATE whose broadcast the node dropped is sent again as the same bytes and delivered, signed once": 3.3,
    "a Deliverable CREATE whose broadcast the node dropped is sent again as the same bytes and delivered, signed once, across a restart of the host and the wallet": 3.4,
    "a kept Deliverable CREATE whose rebroadcast fails is held with the journal's cause, signed once": 3.5,
    "a Deliverable CREATE the node applied whose answer was lost is read back, not broadcast again": 3,
    "a Deliverable read that fails does not ask the wallet journal: nothing is sent while the readback is unknown": 2.2,
    "a Deliverable read that throws name-index-miss asks the journal: the kept bytes are sent again once, signed once": 3.3,
    "a Deliverable read that throws native-address-miss asks the journal: the kept bytes are sent again once, signed once": 3.8,
    "a Deliverable reconcile that throws name-index-miss asks the journal: the kept bytes are sent again once, signed once": 3.4,
    "a Deliverable reconcile that throws native-address-miss asks the journal: the kept bytes are sent again once, signed once": 3.5,
    "a Deliverable submission that failed before signing is signed once by the next claim on the journal's answer": 4.2,
    "another job's claim on the transfer while the Deliverable journal reads the nonce for a failed submission sends nothing more and delivers nothing": 3.9,
    "a lost job fence while the Deliverable journal reads the nonce for a failed submission sends nothing more and delivers nothing": 3.5,
    "another job's claim on the transfer while the Deliverable journal reads the nonce for an accepted submission the node dropped sends nothing more and delivers nothing": 3.5,
    "a lost job fence while the Deliverable journal reads the nonce for an accepted submission the node dropped sends nothing more and delivers nothing": 3.8,
    "a kept Deliverable CREATE another write of the wallet overtook is signed anew once, and the overtaken one never lands": 3.7,
    "an accepted Deliverable CREATE the node dropped and another write of the wallet overtook stays held: no second signature": 3.7,
    "a replaced Deliverable wallet journal is not asked: the order is held and signs nothing until the file is restored": 4.8,
    "a Deliverable submission recorded with no wallet journal is not asked of the configured one": 2.8,
    "an order recorded for the Deliverable journal is held, and no other capability signs it, when the host restarts without the journal": 6.2,
    "a Deliverable CREATE the journal kept is not signed again by a capability whose reader proves nothing was signed, once the host restarts without the journal": 4.9,
    "a fulfilment this seller never submitted is asked of the journal as unsigned when the journal is enabled after a failed submission by another capability": 4.3,
    "a Deliverable wallet journal that fails when asked keeps the order held with its cause, and the order is delivered once it answers": 4.1,
    "the host takes the Deliverable resume only from the journal whose guarded submit the capability is: a scripted answer, another journal, the evidence journal or an unguarded capability is refused": 0.5,
    "the host takes only the Listing seller bundle to delivery and refuses a session presentation, signed or forged": 3.7,
    "a seller signer failure while signing the payment evidence does not strand the paid order, also across a restart": 6.3,
    "a payment claimed with a 0x-prefixed transaction hash is delivered, its evidence naming the plain hash": 3.3,
    "a gate that refuses a held paid claim for now keeps it bound to the job: another claim cannot take it, and the claim is delivered once the gate passes": 4.7,
    "a replaced wallet-journal file never signs a second evidence CREATE for an anchor the earlier one sent": 4,
    "read-only reconciliation of a held payment claim neither signs nor sends: it is not run again": 2,
    "the package builds capabilities only for the loopback fixture node and TEST authorities: a real node endpoint and an unregistered source are refused": 0.1,
    "a paid native order with an additive signature field in its DeliverableSpec reaches delivery, including restart": 3.5,
    "a supersession decision lost before the agent checkpoint replays after restart and delivers once": 4.5,
    "a commitment readback outage holds the first payment claim before dispatch and recovers": 3.2,
    "a paid order resumes once after restart with a rotated steward and trusted historical key; new orders pin the new steward": 5.2,
    "complete payload digest includes a top-level signature and survives restart": 3.5,
    "a Promise producer gives a clear deterministic synchronous contract error": 1.8,
    "declared delivery schema is enforced before publication; conforming payload is delivered": 5.3,
    "foreign same-name binary programs do not obstruct authentic seller evidence or delivery": 3.2,
    "an unavailable schema verifier preserves the permit and recovers on retry, including after restart": 7.6,
    "a schema verifier that never-settles holds the paid order with its permit unspent, and the fixed verifier delivers it once": 4.2,
    "a schema verifier that late holds the paid order with its permit unspent, and the fixed verifier delivers it once": 4.9,
    "a schema verifier that throws holds the paid order with its permit unspent, and the fixed verifier delivers it once": 4,
    "a schema verifier that malformed holds the paid order with its permit unspent, and the fixed verifier delivers it once": 4.1,
    "a schema verifier that invalid holds the paid order with its permit unspent, and the fixed verifier delivers it once": 4.2,
    "an unspecified-size Listing with oversized actual output is refused before any Agreement": 0.6,
    "inline delivery refuses oversized Listings before signing and delivers the exact storage CREATE boundary": 3.8,
    "inline size admission accepts feasible minimal reports and refuses impossible declared sizes": 8.8,
    "producer size mismatches hold the paid permit and recover with corrected bytes, including restart": 18,
    "host maxJobs above the default transport cap admits job 10001 with the ordinary nonce budget": 5,
    "a delivery evidence publisher outage remains retryable through crash reconciliation until publication completes": 5.3,
    "ordinary commitments recover after Agreement-read and pre-publication failures, across restart, and never repeat a CREATE": 3.8,
    "a commitment CREATE is not requested when the seller loses the job during the wallet's approval wait": 1.6,
    "the native host delivers without the unused compatibility observer": 3.7,
    "an uncertain commitment CREATE only reads back after restart and is never published twice": 1.8,
    "a non-idempotent commitment publisher is called once despite a lagging index and restart": 2,
    "read-only commitment reconciliation cannot start provably unsent work": 2,
    "commitment transport reconciliation reads an uncertain retained commitment back without a resend": 1.6,
    "a pending commitment CREATE is sent again once, through the seller-state check asked right before the resend": 1.8,
    "a pending commitment CREATE is not sent again once the seller-state check, asked right before the resend, fails": 1.8,
    "the host has no operator issuance and accepts a buyer presentation of the challenge its wire issued": 1.3,
    "concurrent Agreement state reads cannot hide settlement collisions from cached delivery answers": 11.9,
    "a landed Deliverable with a lost adapter checkpoint recovers on immediately successful readback with one CREATE": 23.5,
    "native delivery recovery holds on an unauthenticated or mismatched recovery state": 30.1,
    "settlement disclosure checks durable payment identities even when this agent only cached the unpaid proposal": 6,
    "missing or malformed journal identity undefined cannot release another journal's pending CREATE": 3.3,
    "missing or malformed journal identity null cannot release another journal's pending CREATE": 3.6,
    "missing or malformed journal identity 0 cannot release another journal's pending CREATE": 3.6,
    "missing or malformed journal identity {} cannot release another journal's pending CREATE": 3.6,
    "authenticated checkpoint proof cannot return unauthenticated evidence or deliver again": 4.7,
    "authenticated checkpoint order cannot return unauthenticated evidence or deliver again": 5.1,
    "authenticated checkpoint deliveryReady cannot return unauthenticated evidence or deliver again": 4.9,
    "a retained delivery is rechecked by the agent while a repeated wire request is refused without work": 5.4,
    "a delivery is read back from the bytes that were sent, not from what the producer answers after a restart": 4.6,
    "a Deliverable that landed while the job's records were lost is recovered from the bytes that were sent, whatever the producer answers after the restart": 5.2,
    "without delivery evidence enabled a delivered order is delivery-ready and its evidence is left to the SDK finaliser": 4.2,
    "with delivery evidence enabled the SettlementEvidence is published once and read back: the answer is delivered, and repeats and a restart send nothing": 5.1,
    "a delivery evidence CREATE whose answer was lost is only read back: held while the readback is unknown, then delivered with one CREATE, across a restart": 5.5,
    "a delivery evidence publication that never reached the wallet is published again, once": 4.6,
    "a delivery evidence CREATE is not requested when another job claims the settlement during the wallet's approval wait": 5.6,
    "a resent delivery evidence CREATE is not requested when another job claims the settlement during the wallet's approval wait": 6.2,
    "resume with publication off reads back an evidence CREATE whose answer was lost: delivered, with one CREATE": 4.3,
    "resume with publication off answers a delivered order with its first evidence receipt": 4.7,
    "resume with publication off never publishes evidence that never reached the wallet; turning it on does, once": 4.9,
    "resume with publication off holds while the evidence readback is unknown, then delivers with one CREATE": 5,
    "a pending evidence CREATE is not broadcast again when the host restarts with publication off, and the claim stays held": 5.2,
    "a pending evidence CREATE is still read back with the one authorized resend while publication is on and the claim holds its lock": 6.2,
    "a pending evidence CREATE is not broadcast again once the seller-state check, asked right before the resend, fails": 7.6,
    "a refused evidence CREATE whose nonce another write took is published again once and delivered": 7.6,
    "a refused evidence CREATE whose nonce another write took is published again once and delivered, across a restart of the host": 8.1,
    "a refused evidence CREATE is not published again while delivery evidence is off, or once the seller-state check fails": 9.6,
    "a paid claim reads the commitment back passively: the readback-only commit never asks for a resend": 5.9,
    "resume with publication never on keeps a delivery-ready order retained and sends no evidence": 6.2,
    "an evidence readback that cannot prove nothing was signed (absent) is held, never published twice": 7.2,
    "an evidence readback that cannot prove nothing was signed (unbranded) is held, never published twice": 8,
    "enabling publication after a delivery-ready order changes nothing: a replay of the stored answer publishes no evidence": 7.1,
    "a delivery-ready session retained without its own evidence copy is replayed from its stored answer and publishes nothing": 7.9,
    "a delivery evidence verifier that throws leaves a held delivery-ready native refresh": 7.6,
    "an indeterminate delivery evidence verdict is reported as unavailable, not as differing evidence": 7.4,
    "a delivery evidence capability that rejects without an Error leaves a held native refresh": 6.8,
    "a delivery evidence retained read that never answers is a held readback, and the next claim delivers": 7.5,
    "a delivery evidence receipt verification that never answers is a held readback, and the next claim delivers": 8.3,
    "a paid order is delivered with the candidate retained at permit consumption, whatever the producer answers after the restart (schema true)": 8.4,
    "a paid order is delivered with the candidate retained at permit consumption, whatever the producer answers after the restart (schema false)": 7.9,
    "a completed delivery whose delivery-ready checkpoint is gone is withheld, never rebuilt by a replay, and sends nothing again": 6.4,
    "deterministic fixture job IDs stay distinct across independent worlds": 4.4,
    "the fixture node signs storage CREATEs with the fee and execution edits the pinned SDK writes": 0.1,
    "deterministic fixture transfers advance the payer nonce": 0.1,
    "a rejected signing answer with no retained CREATE recovers from the owning journal after restart": 7,
    "an unreadable signing journal holds only until its original owner recovers": 6.4,
    "rejected signing and SQLITE_BUSY projection read recover through the same owner, consumer reader=false": 6.7,
    "rejected signing and SQLITE_IOERR projection read recover through the same owner, consumer reader=false": 7.2,
    "rejected signing and resolver-timeout projection read recover through the same owner, consumer reader=false": 7.9,
    "rejected signing and SQLITE_BUSY projection read recover through the same owner, consumer reader=true": 7.5,
    "rejected signing and SQLITE_IOERR projection read recover through the same owner, consumer reader=true": 7.2,
    "rejected signing and resolver-timeout projection read recover through the same owner, consumer reader=true": 6.8,
    "an unchanged owner recovers a retained unknown checkpoint without catch-time unsigned permission": 7.5,
    "a missing evidence artifact cannot sign while the original transfer is unverified": 7.5,
    "a missing evidence artifact cannot rebroadcast while the original transfer is unverified": 8.1,
    "a plain evidence signer failure preserves its bounded stage before any wallet effect": 3.1,
    "completed native delivery authenticates fresh artifact before answering a repeated claim": 9.1,
    "completed native delivery authenticates fresh missing-artifact before answering a repeated claim": 9.8,
    "completed native delivery authenticates fresh projection before answering a repeated claim": 9.2,
    "completed native delivery authenticates fresh receipt before answering a repeated claim": 9,
    "a 16385-byte Listing above the CREATE cap is refused before an Agreement or payment": 1.2,
    "a 131072-byte Listing above the CREATE cap is refused before an Agreement or payment": 1.2,
    "a corrected schema-invalid producer report keeps the same paid order retryable": 8,
    "a corrected schema-invalid producer report keeps the same paid order retryable after restart": 9.3,
    "native integration claims use the filesystem-flow deadline and preserve its classified timeout cause": 2.9,
    "a malformed schema answer leaves the paid report correctable": 7.4,
    "a malformed-valid schema answer leaves the paid report correctable": 7.7,
    "a throw schema answer leaves the paid report correctable": 7.9,
    "one exact prepared candidate uses one successful schema verdict within the delivery run": 6.8,
    "cached delivered claims reauthenticate unavailable delivery evidence across restart": 9.9,
    "cached delivered claims reauthenticate changed delivery evidence across restart": 10.1,
    "delivery evidence returns its first authenticated receipt across later observations and restart": 9.2,
    "disabling evidence publication preserves authenticated delivered facts with none readback after restart": 10,
    "disabling evidence publication preserves authenticated delivered facts with unavailable readback after restart": 10.5,
    "disabling evidence publication preserves authenticated delivered facts with changed readback after restart": 9.5,
    "disabling publication recovers an already landed evidence CREATE with a lost answer by readback": 7.2,
    "disabling publication holds absent prior work without a new CREATE and enabling resumes it once": 9.3,
    "a native delivery read whose signed projection conflicts with its receipt is held": 7.8,
    "a report nested past the storage CREATE depth is held before the permit is spent and recovers with corrected bytes": 8.5,
    "payment recovery refuses delegation expiry during agent entry": 8.9,
    "payment recovery refuses request expiry during agent entry": 8.9,
    "payment recovery refuses delegation expiry during agent restore": 8.9,
    "payment recovery refuses request expiry during agent restore": 8.8,
    "payment recovery refuses delegation expiry during agent publish": 8.8,
    "payment recovery refuses request expiry during agent publish": 8.7,
    "payment recovery refuses delegation expiry during agent approval": 9.3,
    "payment recovery refuses request expiry during agent approval": 9.2,
    "wire-payment-retained-work-before-finish": 26.3,
    "a default host frees the units of a purchase whose proposal the seller refused an hour after its admission, retaining no Agreement, and keeps them before": 1.4,
    "a default host frees the units of a purchase that stopped after its proposal once the Agreement deadline has passed": 3.1,
    "a default host keeps the units of a committed, unpaid purchase long past its Agreement deadline, and a payment made before the deadline is still accepted when claimed late": 8,
    "a default host keeps the units of a purchase whose payment claim was cut short, long after its Agreement deadline, and the buyer's retry is delivered": 8.9,
    "a default host gives back the units of a purchase whose commitment was refused with no effect once its Agreement deadline has passed, with no restart, and admits the next buyer": 5.3,
    "a commitment made after the Agreement deadline but within an hour of admission is refused with 409, leaves no pending attempt, and its units are given back after the hour": 5.3,
    "a commitment refused with no effect is made once the buyer anchors the Agreement, and its units stay long after the deadline": 3.1,
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

export const sellerDir = join(repoRoot, "packages/dacs-seller/test");
export const clientDir = join(repoRoot, "packages/dacs-client");

export async function clientFiles() {
  const { discoverTests } = await import(pathToFileURL(join(repoRoot, "packages/dacs-client/scripts/test.mjs")).href);
  return discoverTests(join(repoRoot, "packages/dacs-client"));
}

/**
 * Failures (empty when every key is current): a WEIGHTS key of suite that is not one of files, or is a split file (its
 * tests have the weights), and a TEST_WEIGHTS key of a split file of suite that is not one of its listed tests. A file or
 * test with no key is not a failure: it gets the default weight.
 */
export function staleKeys(suite, files, split, weights = WEIGHTS[suite], testWeights = TEST_WEIGHTS) {
  const failures = [];
  for (const key of Object.keys(weights ?? {})) {
    if (!files.includes(key)) failures.push(`${suite} weight ${JSON.stringify(key)}: not a test file`);
    else if (Object.hasOwn(split, key)) failures.push(`${suite} weight ${JSON.stringify(key)}: a split file has no whole-file weight`);
  }
  for (const [file, names] of Object.entries(split)) {
    for (const key of Object.keys(testWeights[file] ?? {})) {
      if (!names.includes(key)) failures.push(`${suite} ${file} test weight ${JSON.stringify(key)}: not a test of the file`);
    }
  }
  return failures;
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
    for (const [suite, files, baseDir] of [["seller", sellerFiles(), sellerDir], ["client", await clientFiles(), clientDir]]) {
      let split;
      try {
        split = splitTests(suite, files, baseDir);
      } catch (error) {
        console.error(`[ci-shards] FAIL ${error.message}`);
        failed = true;
        continue;
      }
      const { shards, failures: partition } = checkPartition(suite, files, split);
      const failures = [...partition, ...staleKeys(suite, files, split)];
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
