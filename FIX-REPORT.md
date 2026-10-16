FIXED sdknode-followup=ready for review

Base: `3904d704fb540e6e1d7dd502a0be29f20569c92d`, branch `work`.
The verdict covers this patch. The separately owned fixes in #350 and #352 remain open; this is not a claim that the whole live release is ready.

## Reconciled findings

Sources: `.stack/reviews/sweep/code.md`, `daybreak.md`, and `daybreak-g6.md` in the enclosing workspace. No P0 was reported. “Confirmed coverage gap” means the existing decision is correct, but lacked an effective test. Those items receive tests without changing correct production decisions. Open PRs are not described as already fixed on main.

| Finding and priority | Disposition on main and evidence | Action |
| --- | --- | --- |
| M-1, P1: buyer completion, seller finalization, and fresh settlement observations untested | Confirmed coverage gap. The original audit guards pass the new positive and negative tests. | Added tests for exact logical address/job/native address/hash/bytes, absent publications, invalid or indeterminate receipts, seller identity and binding outcomes, and fresh observations on both rails. `fixedPriceX402BuyerAudit.test.ts:928`, `:963`, `:1021`, `:1046`, `:1059`. |
| M-11, P1: durable payment-evidence replay/conflict and authority/effect guards untested | Confirmed coverage gap. New store tests pass against the existing store implementation. | Buyer and seller completion replay/conflict after restart, changed seller authentication, foreign actor authority, immutable caller data, hash-consistent forged history, stale buyer outbox claims, and pre-existing effect reservation conflicts. `sqlitePaymentEvidenceHandshake.test.ts:274`, `:321`, `:341`, `:365`, `:421`; `sqlite.test.ts:729`. |
| M-2 / g6 finding 1, P1 at the highest assigned grade: commerce accepts an absent finality echo, audit rejects it | Confirmed; owned by #350. Main audit rejects omission at `fixedPriceX402BuyerAudit.ts:598`. The pinned record declares `finalityBlocks?: number`; main commerce deliberately accepts omission. | Do not duplicate #350. Its fetched diff permits omission in audit, retains exact signed evidence, and adds acceptance tests. |
| First daybreak review: P1 claim that omission must instead be rejected everywhere | Not a separate SDK defect established by the cited evidence. The Standard's explicit optional record member conflicts with its stricter Python reference helper. Requiring the echo would contradict the chosen optional-echo contract and #350. | Record the Standard discrepancy for clarification. No competing enforcement change here. |
| g6 finding 2, P1: optional rail finality depth treated as mandatory | Confirmed; owned by #350. Main constructors throw on an absent `rail.parameters.finalityBlocks`; the phase card makes it optional. | #350 replaces the mandatory-depth helpers with the authenticated resolver/default policy and tests absent and explicit depths. No duplicate edits. |
| First daybreak review: P1 x402 settlement-response extensions rejected | Confirmed; owned by #350. Main `x402SellerEvm.ts:523` uses a closed-key set despite X402-1 preservation requirements. | #350 changes this callback and tests complete responses with unknown members/extensions. No duplicate edits. |
| M-3 / g6 finding 4, P2: external node and demosdk behavior not reproducibly pinned | Confirmed integration/reproducibility gap. Lockfile installs demosdk 4.0.16; package ranges permit newer 4.x. #350 documents source/deployment observations; #352 adds the allowed-version compatibility matrix. | Leave those changes to their owners. A verified clean node deployment remains a P2 follow-up below. |
| First daybreak review: P1 claim that the node contract lacks `getNetworkInfo` and `getTransactionStatus` | Not established for the deployment's reported revision. That review inspected the default branch, while node2 reports stabilization commit `61b8e75aa8db5e408c49e1c3a89db4d673f45578`. At that exact commit, `handlers/forkHandlers.ts:73` registers `getNetworkInfo`, and `transactionHandlers.ts:14` registers `getTransactionStatus`. | GET-only source verification and GET `/version` recorded under `.fix-tmp/upstream/`. Fault classification/read contracts are already owned by #350; execution/status handling is owned by #352. A reported commit alone does not establish a clean deployed build. |
| M-4, P2: SB-3 buyer-audit nonce check untested | Confirmed coverage gap. Existing initial and recovery guards independently reject a wrong nonce. | Added a wrong-nonce case for both initial audit and fresh recovery revalidation in `fixedPriceX402BuyerAudit.test.ts:1021`. |
| M-10, P2: migration-safety failure guards untested | Confirmed coverage gap. Existing shared backup and v1 migration guards reject the injected failures. | `sqlite.test.ts:1437` and `:1473` exercise a corrupted backup, concurrent source write, failed conversion to a self-contained backup, and invalid post-migration schema. Assert refusal, v1 source preservation/transaction rollback, unusable-backup cleanup, and successful subsequent admission. Version-specific v2–v7 expansion remains below. |
| M-12, P2: operator-action effects omitted from upgrade-safety coverage | Confirmed coverage gap. Existing projection correctly returns unsafe. | `sqlite.test.ts:700` checks the live projection, read-only inspection, and reopened store with exactly one operator-action effect and all other blockers zero. The additional projection-shape guard is defensive: genuine SQL SUM/COUNT over these predicates cannot yield negative or fractional counts. |
| First daybreak review: P2 restore ignores `sdkVersion` | Confirmed behavioral defect. Executing the original generated lifecycle accepted and restored an authenticated backup from another SDK release. | Compare SDK versions before safety backup or directory replacement at `lifecycleTemplate.ts:486`. New executable tests cover current, older, newer, malformed, and empty versions; the integration case checks actor files remain unchanged. |
| First daybreak review: P2 nonce readiness can pass failed/malformed RPC data | Confirmed behavioral defect. Installed demosdk's `getAddressNonce` partially parses strings and otherwise returns zero. The host returned that value and the generated probe counted any resolved call as healthy. | `demosRuntime.ts:520` now checks raw `nodeCall` data. Tests cover safe numeric/string responses including zero, error objects, unknown-method strings, partial parses, negative/fractional/unsafe values, and missing raw-read capability. |
| M-5, P3 but a Standard MUST: optional attestation signer ignored | Confirmed missing enforcement. DACS-2 §7.5.2 requires signer mismatch rejection. Existing orchestrator binding limits the impact but does not implement this field's contract. | Enforce canonical signer equality in `src/agent/verifySettlementEvidence.ts:906`. Real-signature tests at `test/agent/verifySettlementEvidence.test.ts:126` check mismatch rejection, canonical equivalence, and omission. |
| M-6, P3: restore current-version exception is dead/unpinned | Not a behavioral defect with today's `[1…8]` migration-source list. The exception is useful when that list later excludes the current schema. | New executable `lifecycleTemplate.test.ts:52` supplies that release boundary and proves current-schema acceptance, supported historical acceptance, and unsupported-schema refusal. No production change to the exception. |
| M-8, P3: x402 delivery signature rejection untested | Confirmed coverage gap. Existing production verifier rejects the forged signature. | Added real cryptographic delivery rejection in `fixedPriceX402BuyerCommerce.test.ts` using the seller identity with another party's signing key. |
| M-9, P3: local vector suites can skip without vendor data | Confirmed existing local harness behavior. CI already syncs the pinned vectors. | Synced the exact Standard revision before running the affected root suites; no harness-policy change in this patch. |
| First daybreak review: P3 living EIP/CAIP sources lack immutable pins | Confirmed documentation gap. Executable dependencies and the DACS Standard are pinned; #350 adds external-source documentation. | No overlapping metadata change here. |
| Withdrawn `LIMIT 9` concern | Not a defect: the existing extra-history-row test fails on an unsupported schema history. | No change. |
| Missing #253/#256 features, P1 in both daybreak reviews; code-review S-1/S-2 P1 and S-3/S-4/S-5 P2 | Outside the current-main scope, not defects introduced by this patch or by a claimed merge into main. The corresponding new modules are absent; these PRs merged into the still-separate #228 branch. The source reviews agree on this ancestry correction. | Do not merge the unrelated feature stack into this follow-up. Recheck its receipt classification, authorization witnesses, closed message table, negative vectors, and vector versioning when #228 is proposed for main. No claim that this patch supplies those features. |

## Changes and public contracts

Three production decisions changed: raw nonce readiness, backup SDK compatibility, and attestation signer comparison. The remaining changes add regression coverage around existing decisions.

`DacsDemosAdapterV1.raw` gains an optional `nodeCall` capability. `addressNonce()` requires it when called and fails with `demos-nonce-unavailable` if it is absent or returns invalid data. Custom adapters using only the convenience `getAddressNonce` must add the uncoerced read. The public return type remains `Promise<number>`. The README documents this behavior. Normal SDK adapters already expose the capability.

Backup restore now requires an exact SDK version match, consistent with SQLite's existing persisted SDK admission check. There is no migration promise between different SDK releases. A supplied attestation signer must now match the actual signer under canonical claim identity; omission remains supported.

## Validation and regression effectiveness

Installed dependencies with `TMPDIR="$PWD/.fix-tmp" npm ci`. Synced DACS-Standard at `d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20`. All scratch work for this run is in `.fix-tmp/`.

Final affected tests: **403 passed**, no failures or skips in these suites.

| Command scope | Files | Tests |
| --- | --- | --- |
| Host: `demosRuntime`, `fixedPriceX402BuyerAudit`, `fixedPriceX402BuyerCommerce`, `sqlite`, `sqlitePaymentEvidenceHandshake` | 5 | 182 |
| Core: `verifySettlementEvidence`, `sessionSettlement`, `fixedPriceX402AuditCompletion`, `paymentIntake` | 4 | 205 |
| Generator: complete generator test directory, including executable lifecycle tests | 2 | 16 |

Final runs used `vitest run --maxWorkers=1` with at most two Vitest invocations active. No force-exit option or mutation pass was used. Detailed outputs: `.fix-tmp/final-host-tests.log`, `final-core-tests.log`, `generator-tests.log`.

For each behavioral fix, restored only its production file to the exact original `3904d70` version, kept the new tests, ran the affected suite, and restored the fixed bytes in a `finally` block:

| Production file reverted | Result with original implementation | After restoring fix |
| --- | --- | --- |
| `lifecycleTemplate.ts` | Both new executable lifecycle tests fail: incompatible SDK accepted; restore resolves instead of rejecting. | Generator suite passes. |
| `demosRuntime.ts` | 24 new cases fail: convenience method used, malformed reads accepted, or wrong valid raw nonce returned. | All 35 runtime tests pass. |
| `verifySettlementEvidence.ts` | The signer-mismatch regression fails; 69 existing tests pass. | All 70 verifier tests pass. |

Logs: `.fix-tmp/restore-reverted.log`, `nonce-reverted.log`, `signer-reverted.log`. `.fix-tmp/verify-reverts.py` records the exact procedure. Test-only coverage fixes have no changed production implementation to revert: the new tests pass on the original correct guards. No artificial broken source variants were applied.

Passed: `npm run typecheck`, `npm run host:typecheck`, `npm run generator:typecheck`; core, host, and generator builds; `git diff 3904d70..HEAD --check`.

`npm run lint` was attempted and reports `Missing script: "lint"`; none of the three packages or CI defines a lint task. No lint tooling was invented for this patch.

Pinned Gitleaks 8.30.1, with the CI archive's SHA-256 verified, reports no leaks in the five implementation commits or all 809 reachable commits at that point. The coordinator's separately tracked HTLC signer-fixture issue is **outside this PR (#351)**. No allowlist change was made.

Read-only network evidence: the two open PR diffs and metadata, the exact Standard sources, installed exact-version demosdk implementation, node sources at `61b8e75…`, and GET node2 `/version`. No live RPC POST, authentication, transaction, or remote signing occurred. The node version response does not prove a clean deployment or all live response shapes.

## Follow-ups (P2, non-blocking)

1. **Clean node deployment and compatibility gate (M-3).** #350's `docs/demos-node-compatibility.md` and #352's `docs/pay-dem-execution.md` describe the source/build mismatch. Supply a clean node image digest tied to a commit, expose that build identity through a read-only health endpoint, record it in integration-profile metadata, and run the recorded adapter response-shape suite against that deployment. Local source pinning cannot establish a clean remote build. Keep demosdk range/version CI in #352 rather than creating a second pin policy here.
2. **Version-specific migration failures (remaining M-10 coverage).** `packages/dacs-node/src/sqlite.ts:7035`, `:7071`, `:7106`, `:7138`, `:7169`, `:7198` have separate v2–v7 `data_version` guards; their post-migration checks are at `:7061`, `:7096`, `:7128`, `:7159`, `:7188`, `:7217`. Extend authenticated historical fixtures for each version and reuse the concurrent-write and invalid-post-schema scenarios added here. Assert version rollback and raced-backup removal per version. This patch pins the common backup guards and complete v1 failure path; it does not claim every historical branch is newly covered.

## Commits and handoff

All commits are on `work`, authored as `randomblocker <130692587+randomblocker@users.noreply.github.com>`, with hooks disabled. Commits succeeded, so no fallback commit script is needed.

- `9c527fe` — validate raw nonce responses before reporting readiness.
- `08d6e6b` — reject backups from incompatible SDK releases.
- `bc2d4a0` — bind attestation signer to evidence signature.
- `a6e64b1` — pin buyer completion and settlement revalidation guards.
- `cb60466` — pin durable payment conflicts and migration safety.

Draft PR title: **Fix gaps in recently merged node-package code found by a full sweep**. Body: `.fix-tmp/PR.md`. Nothing was pushed or published. The coordinator must reconcile the shared audit/commerce test-file edits with #350 when combining branches. No incomplete production fix remains in the tree.
