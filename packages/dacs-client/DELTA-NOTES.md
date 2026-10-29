# client package deltas

Scope: PLAN §8 and §0.3, D10, D9, D1 and D15 only. Package exports remain empty.
Commit subjects below are exact, unique Git commit selectors; this avoids embedding a commit's own hash in its tree. The report resolves selectors to full commit IDs; the checker requires each selector to resolve exactly once. PROVENANCE.json remains the immutable original copy inventory.

## D10 — Strip unused modes

Plan row: “The engine's fixture and simulated-devnet profiles exist only for the in-process demo. Delete them instead of moving them.”

- `src/dacs/protocol-purchases.mjs:1`: remove dacs-pay-dem admission, fixture anchor client, complete devnet configuration/terms/stage ledger, fixture Agreement continuation, fixture claim/payment-evidence and delivery reads, and DACS-5 countersigning/copy exchange. Those paths were selected only by the removed fixture profile. Native completion stays held, as before. Native Agreement admission now requires its opaque source capability and native commitment.
- `src/purchases.mjs:1`: remove fixture protocol selector and simulated success/domain presentation. Simulated network observations are refused.
- `src/dacs/demos-sr2-adapter.mjs:1`: require source capability; delete loopback simulation HTTP reads and marker, fixture genesis authentication and simulated block-validation alternative. The engine can only reach the native reader.
- `src/dacs/demos-sr2-wallet-bridge.mjs:1`: delete simulated profile/kind/status/finality/lane alternatives; require native capability.
- `src/dacs/native-agreement-payment-consumer.mjs:1`: delete the enabled:true fixture admission and fixture reader/lane alternatives; require native capability.
- Deleted `src/dacs/devnet-purchase-consumer.mjs`: exclusively configures/labels the complete simulated profile.
- Deleted `test/devnet-purchase.test.mjs`, `test/devnet-purchase.browser.test.mjs`, `test/helpers/devnet-purchase-harness.mjs`: exclusively exercise/configure that removed profile.
- Deleted `test/dacs-loopback-fixture.test.mjs`: exclusively exercises the removed engine fixture profile. Thirty retained test/helper files directly import that removed fixture harness; they are explicitly labelled as D10 deleted-mode dependencies. Mixed/source tests stay blocked, without a reconstructed harness or pass-seeking rewrite.

Read: original engine branch conditions and native capability consumers. Shared seller closure modules remain for the later store/seller split; they are also reached by the native seller and are not exclusive to the deleted engine profiles. No live wiring.

## D9 — Chain readback only

Plan row: “The buyer cannot read a remote seller's disk (K2). the source change's chain readback becomes the only mode; the journal-read mode is deleted.”

- `src/dacs/protocol-purchases.mjs:1`: remove buyerChainReadback switch, seller-journal commitment fallback and mode-dependent progress/retention branches. Native readback uses the buyer's source reader unconditionally.
- `src/dacs/dem-delivery-consumer.mjs:1`: remove fixture and seller-journal delivery/evidence readers; require chain reader.
- `src/dacs/native-payment-evidence-consumer.mjs:1`: remove readSignedProjection and answerProjectionOnly switches; consume only the original signed CREATE supplied to this buyer.
- `src/devnet-demo/commitment-consumer.mjs:1`: delete readDevnetNativeCommitment, including its anchor.readRetained and verifier path. Retain capability branding/configuration used by native seller configuration.
- `src/devnet-demo/native-delivery.mjs:1`: delete purchased/evidence reader maps, exported buyer readers and their readRetained closures; retain seller submit/reconcile/read/receipt capability.
- Tests still passing the old option cannot enable the deleted journal mode. The environment toggle is in the plugin composition outside the copied set.

Read: DESIGN-SELLER-KIT K2; the source change reader and the three buyer call sites. Seller write-recovery journals and the buyer's own public CREATE retention remain necessary for one-send recovery; they are not seller-disk verification modes.

## D1 — Cut plugin imports (client package side)

Plan row: “The packages must not import http-mcp/src/wallet/*, public/portal/*, buyer-access.mjs or operations.mjs ... expose the existing pure demosTransactionContentMatches helper from core src/index.ts.”

Public API addition for boundary review: `src/index.ts:312` re-exports the existing pure `demosTransactionContentMatches`; no implementation change. Both `src/dacs/demos-sr2-adapter.mjs:1` and `src/wallet/devnet-native-transport.mjs:1` import it from `@kynesyslabs/dacs`.

- `src/signatures.mjs:1`: preserve the source's address/claim/signature normalization, backed by the existing public core Ed25519 functions. No wallet access.
- `src/client-errors.mjs:1`: local OperationError/requestHashOf and typed NotWiredError (code client_not_wired).
- `src/dacs/artifact-reference.mjs:1`: pure logical/transaction references extracted from the former fixture dependency; canonicalSignature is in signatures.mjs.
- `src/dacs/seller-session-limits.mjs:1`: relocate the copied pure bounds module out of the portal directory. The original path is deleted by D1; no implementation change.
- `src/purchase-limits.mjs:1`: extract the existing immutable limits so importing purchases does not execute the plugin's switch-file startup configuration.
- `src/seams/purchase-store-not-wired.mjs:1`: the private synchronous SQLite purchase transaction adapter (`createSqlitePurchaseStore`) and its qualifier (`purchaseStore`) for D11. The exported transaction/isUniqueViolation remain NotWiredError stubs; no registration mechanism. (D11 PR 04 removed those two stubs; the buyer factories take the store as a parameter.)
- `src/seams/wallet-actions-not-wired.mjs:1`: wallet challenge and portal payload/check stubs for D11. (D11 PR 04 replaced them with `walletPurposes`, which admits only the host's APPROVE_PURCHASE purpose.)
- `src/seams/buyer-access-not-wired.mjs:1`: the in-process operator capability is unavailable pending D11. (D11 PR 04: buyer purchases take a top-level `buyerAccess` option; seller-agent.mjs still uses this seam.)
- `src/seams/seller-integration-not-wired.mjs:1`: legacy fixture anchor operations in the shared seller closure throw; no plugin fixture module is pulled in. D11/seller split must dispose of that closure.
- Three test files lose private core dist references only; tests requiring the plugin harness remain unmodified otherwise and are accounted for in the test results.

Every source import cut (source coordinates before D1):

- `src/dacs/agreement-context-consumer.mjs:19 ../wallet/demos-signature.mjs`
- `src/dacs/buyer-chain-readback.mjs:33 ../wallet/demos-signature.mjs`
- `src/dacs/chain.mjs:11 ../wallet/demos-signature.mjs`
- `src/dacs/commit-on-signature.mjs:2 ../wallet/demos-signature.mjs`
- `src/dacs/completion-readiness.mjs:6 ../wallet/demos-signature.mjs`
- `src/dacs/delivery-deadline-watch.mjs:1 ../store/database.mjs`
- `src/dacs/delivery-evidence.mjs:2 ../wallet/demos-signature.mjs`
- `src/dacs/dem-delivery-context-consumer.mjs:10 ../wallet/demos-signature.mjs`
- `src/dacs/demos-sr2-adapter.mjs:21 ../wallet/demos-signature.mjs`
- `src/dacs/demos-sr2-adapter.mjs:22 ./fixture-anchors.mjs`
- `src/dacs/demos-sr2-adapter.mjs:28 ../../node_modules/@kynesyslabs/dacs/dist/substrate/demosWriteEvidence.js`
- `src/dacs/demos-sr2-wallet-bridge.mjs:18 ../wallet/demos-signature.mjs`
- `src/dacs/listing.mjs:28 ../wallet/demos-signature.mjs`
- `src/dacs/native-agreement-payment-consumer.mjs:11 ../wallet/demos-signature.mjs`
- `src/dacs/native-agreement-payment-consumer.mjs:12 ../operations.mjs`
- `src/dacs/protocol-purchases.mjs:4 ../store/database.mjs`
- `src/dacs/protocol-purchases.mjs:23 ../operations.mjs`
- `src/dacs/protocol-purchases.mjs:24 ../wallet/demos-signature.mjs`
- `src/dacs/protocol-purchases.mjs:51 ../devnet-demo/buyer-access.mjs`
- `src/dacs/purchase-protocol.mjs:53 ../wallet/demos-signature.mjs`
- `src/dacs/purchase-protocol.mjs:54 ./fixture-anchors.mjs`
- `src/dacs/seller-agent.mjs:1 ../devnet-demo/buyer-access.mjs`
- `src/dacs/seller-agent.mjs:2 ../wallet/demos-signature.mjs`
- `src/dacs/seller-agent.mjs:49 ./fixture-anchors.mjs`
- `src/dacs/seller-durable-state.mjs:12 ./fixture-anchors.mjs`
- `src/dacs/seller-session-lifecycle.mjs:3 ../wallet/demos-signature.mjs`
- `src/dacs/seller-transport-auth.mjs:10 ../wallet/demos-signature.mjs`
- `src/dacs/seller-transport-auth.mjs:11 ../../public/portal/seller-session-limits.mjs`
- `src/dacs/verification.mjs:6 ../wallet/demos-signature.mjs`
- `src/public/portal/seller-session-delegation.mjs:7 ./seller-session-limits.mjs`
- `src/purchases.mjs:33 ./wallet/challenges.mjs`
- `src/purchases.mjs:34 ./operations.mjs`
- `src/purchases.mjs:36 ./store/database.mjs`
- `src/purchases.mjs:39 ./wallet/demos-signature.mjs`
- `src/wallet/devnet-native-transport.mjs:8 ../../public/portal/embedded-wallet/sdk-provider.mjs`
- `src/wallet/devnet-native-transport.mjs:12 ./demos-signature.mjs`
- `src/wallet/devnet-native-transport.mjs:14 ../../node_modules/@kynesyslabs/dacs/dist/substrate/demosWriteEvidence.js`

## D15 — Purchase-integrity corrections (pointer-retention, source change)

Plan row: “A delayed observation can attach to a replaced pointer ... Carry pointer-retention's fence and the source change's correction once into the moved code ... unavailable or unauthenticated observations stay indeterminate; only authenticated contradictions reject.”

- `src/purchases.mjs:839`: after all asynchronous reads, BEGIN IMMEDIATE re-reads the retained pointer. A different pointer returns stale_readback and writes nothing. Nonce consumption, observations, settlement and competing-lane changes share that transaction. External native-journal followups run only after its committed decision. Review correction below preserves terminal decisions from late same-hash reads and checks native supersession persistence.
- `src/dacs/wallet-transactions.mjs:114`: coordinate observation SQL compares the expected pointer as well as verified_at. Cross-purchase supersession supplies that other lane's pointer from the same transaction; it cannot use the current purchase's hash as the other lane's expected pointer.
- `src/dacs/demos-sr2-adapter.mjs:1`, `src/dacs/demos-sr2-wallet-bridge.mjs:1`, `src/dacs/buyer-chain-readback.mjs:1`, `src/dacs/native-payment-evidence-consumer.mjs:1`, `src/dacs/dem-delivery-consumer.mjs:1`, `src/dacs/protocol-purchases.mjs:1`: carry the source change's inspected correction with native-only D10/D9 paths retained; chain-resume classification is a destination adaptation beyond that source diff. The adapter marks only an authenticated contradiction; node data, missing/unconfirmed reads and unmarked invalid remain indeterminate. Retained verified delivery is not downgraded on such an observation.
- `src/devnet-demo/commitment-consumer.mjs:1`: port the source change's pure commitmentContradicted/commitmentRecordContradicts classifiers, used by the chain reader's SDK resume. Do not resurrect the deleted seller-journal reader. A generic permanent SDK fault before authentication is indeterminate.
- `test/purchase-integrity.test.mjs:1`: 12 regressions cover all four HOLD IDs, both completion orders, included/pending stale reads, B settling first, direct observation CAS and reopening persisted state. Reopening uses a new SQLite connection/service while the prior in-flight caller retains its old connection; after reopening, the delayed caller must obey the persisted pointer.
- `test/buyer-chain-indeterminate.test.mjs:1`: four isolated the source change cases; no network, source capability methods are never invoked.
- `test/commitment-contradiction-classifier.test.mjs:1`: 17 the source change cases for the retained pure classifiers. Deleted journal-reader cases are excluded.
- `test/helpers/purchase-integrity-{database,operations}.mjs:1`: historical frontend test-only harness. A test-local module hook supplies its SQLite transaction function to the inert store stub; production imports no test code and receives no adapter registration API. (D11 PR 04: the database harness now re-exports the concrete package adapter instead.)
- `D15-SOURCES.json:1`: exact inspected the source change source and test inventory. Other applicable changed/new the source change tests are carried with their harness prerequisites and run/omission results reported separately. Tests for deleted switch behavior are not restored.
- `evidence/:1`: failing-first and passing TAP lines for all 33 isolated cases (12 + 4 + 17). Before: 0/33 pass; after: 33/33 pass. Original full output remains in workspace logs.

Read: destination diff against the inspected source change head, pointer-retention write sites and transaction helper; run: all 33 isolated tests and pre-D15 scratch comparisons. No wallet or chain was connected. The hold is lifted only by the subsequent D15 record commit after package/provenance checks.

Final tooling: pin the full step-1 destination commit, enumerate every commit and touched file from Git (including tooling and controls), and check that inventory as well as the original-file table. Status-tampering negatives toggle to the opposite status so they remain meaningful after the D15 lift. No gate enforcement check changes.

Historical lift records at 6e22a6e and fdc0b39 were superseded after review; c55c2d9 restored the hold. The current hold record carries the final reviewed correction selector, passing regressions and the D11 prerequisite.

D10 final reachability cleanup (found after D15 validation, carried as its own D10 followup): delete `src/dacs/delivery-readback.mjs`, whose only engine caller was the deleted fixture delivery branch; delete the unused buyer `readCommitment` and fixture anchor fallback in `purchase-protocol.mjs`; remove fixture anchor-message planning (native plans need no detached fixture authorization); delete the unused fixture seller-commitment config/marker/limits and its loopback reader constructor fallback; remove the now-unused SR-2 fixture identity and native evidence simulation fallback. Shared seller verification/bundle helpers remain because the copied native seller still references them. Each deleted branch was exclusive to the removed fixture profiles; no replacement implementation or new integration is added. The subsequent final D15 record reconfirms the same passing regressions.


D10 review cleanup: remove the dangling exported reference to the deleted fixture-only `advance` continuation (it prevented constructing the retained coordinator). Native continuation uses `recheck`. Retained native stage help describes source-pinned, single-node observations; mixed-fixture status branches are removed. `test/native-stage-help.test.mjs` covers five stages with and without the explicit binding descriptor.

The shared seller helpers in `purchase-protocol.mjs` still call the typed fixture seam through `seller-agent.mjs`; they are retained closure dependencies of the copied native seller, not an admitted buyer fixture mode. They remain inert until the later seller/store split removes or replaces that seam. No fixture verifier implementation is restored.

D15 review correction:

- Inside the retained-pointer transaction, a recorded verification or a terminal state other than cancellation returns the saved outcome and changes nothing. This preserves the original cancellation late-landing path.
- Native supersession rechecks the current purchase, its retained pointer, the supersession owner and that owner's settled nonce tuple after the asynchronous source call. The marker write uses this purchase's own retained pointer. Every observation update is checked; a missed compare-and-set cannot record success.
- Pre-authentication seller-pointer checks and unmarked reader errors remain indeterminate. A separate seller-answer diagnostic is recorded with the commitment attempt. Agreement read/recheck authentication marks cross the payment gate; only marked contradictions may lower verified delivery. Payment and delivery evidence preserve the same rule.
- D11 is a binding prerequisite before wiring: transactions must be synchronous, re-entrant and serializing (`BEGIN IMMEDIATE` or equivalent); nested calls join the outer transaction. Run `test/purchase-integrity.test.mjs`, `test/purchase-review-races.test.mjs` and `test/readback-review-decisions.test.mjs` against the real PurchaseStore adapter, including both completion orders, late same-hash reads, supersession and restart. The current tests use the source-bound test-only helpers recorded by source and destination blob in D15-SOURCES.json; they do not validate a production store seam. (D11 PR 04: they now run against the package's concrete SQLite adapter; a host's deployed store still has to pass them.)
- The review files cover 10 race/persistence cases and 63 reader/coordinator cases; `test/native-stage-help.test.mjs` covers 13 native descriptions and limits. Transport and handshake fakes supply data at explicit test boundaries. No missing source is reconstructed.

The full delta series is rebased onto the converged the reviewed baseline gate. The redundant freeze-runner deletion is dropped; the earlier freeze tooling commit now retains only its delta tooling and re-pins. The later D10 reachability cleanup remains a named D10 followup rather than being folded into the initial deletion commit. Inventory and source/test tables are regenerated for the replayed history.

Final correction selector: `delta(client): D15 keep fresh transfer observations indeterminate and lift the purchase hold; update freeze pins`. The hold pair records 119/119 isolated destination cases, the real-store prerequisite and DEC-16 admission carry. The gate prints package frozen and the pinned purchase status separately. Step 1 supplies all HEAD/index/working-state enforcement; the delta changes control constants and success wording only.


an earlier review rebase: the entire delta series is replayed from ecb2cd7 onto the reviewed baseline (1109293). The requested fdc0b39 cutoff omitted the original delta series, so it was corrected after inspecting ancestry. The converged step-1 gate retains its exact HEAD/index/working-state checks; v2 reciprocal pins and provenance inventory are reconciled. The already-supplied freeze-runner deletion commit is removed from the replay. The purchase hold was restored in the metadata reconciliation commit and lifted only after the fresh-transfer regressions passed.

DEC-16 carry: the approved immutable testnet identity input is absent from this snapshot. D2/D4 admission and instrumented zero-signature/zero-broadcast qualification remain required before live wiring. Fixture constants and isolated test capabilities do not supply that input. No live adapter is wired here.

D10 an earlier review wording: completed-stage and native payment/substrate limits now describe the retained source transport. Native evidence history emits verified-source-native-read. Agreement reader headers describe a single-node observation. Historical input strings in blocked portal/operations tests remain historical data; no moved test is rewritten to obtain a passing result.

D15 an earlier review transfer correction: a fresh one-node tuple/time/commitment mismatch remains indeterminate with payment-tuple-unconfirmed diagnostics. It cannot authenticate a contradiction or lower retained delivery. Authenticated receipt/evidence contradictions still reject. This is a destination adaptation beyond the inspected source change diff. Six tuple fields are exercised at consumer, first-read and delivered-recheck levels, with matching and authenticated-contradiction controls.


D10 an earlier review retained paths and history handoff:

- `src/dacs/protocol-purchases.mjs:66`: the reachable native Agreement wallet limit now describes the source-bound browser broker. The packaged wallet and shared journal description remains; the removed engine fixture profile is not an available buyer mode.
- `src/config.mjs:182-228`: retain the legacy `simulated-fixture-only` identity-write setting and `simulated-loopback` embedded-wallet setting. They configure the plugin identity and portal wallet layers, not the removed purchase-engine profiles. No retained package source imports this config module; it also contains the shared held/native configuration grammar. The later composition/config split must decide these plugin settings without restoring an engine profile.
- `src/public/portal-intent/intent.mjs:31-42,171-179,459`: retain the pure fixture profile constant, signature prefix and intent/authorization grammar alongside the source-native intent grammar for D17/WF-2 extraction. No retained package source imports this browser module. These helpers describe legacy signed portal data; they do not construct the deleted engine. The browser extraction must remove or explicitly scope that legacy grammar before exposing its supported profiles.
- Native evidence history changed from `verified-fixture-native-read` to `verified-source-native-read` at `src/dacs/protocol-purchases.mjs:1093`. Consumers reattached later must update their exact-match lists: source `http-mcp/src/mcp/showcase-progress.mjs:21` (`PAYMENT_PASSED`), `http-mcp/src/mcp/seller-content.mjs:121` (`OUTCOMES`) and `http-mcp/src/ops/health.mjs:75`. Historical events may still carry the earlier label; consumers that read retained history must recognize both. These consumers were never copied into this package.


D15 an earlier review record clarification: the import-cut generator restores the reviewed the reviewed baseline Gate paragraph and renders every planned re-pin field. That round restored the generator text only; the Rule field was still reverted until an earlier review. Its source-backed regression compared the Gate paragraph with immutable step-1 commit 1109293 and the whole generated map. The planned re-pin data now explicitly says the package freeze remains after the purchase hold is lifted; the earlier expectation that D15 would replace it is superseded. The current lift summary records 119 destination cases (12 + 4 + 17 + 10 + 63 + 13); earlier review counts remain labelled as historical baselines. The an earlier review package suite added one map-rendering regression, for a historical total of 192. No gate enforcement function or callable surface changes.

D15 an earlier review reviewed-text restoration: HOLD.json now retains the exact the reviewed baseline Rule text followed by the binding D11 sentence. All six step-1-reviewed files changed by the delta series were diffed against the reviewed baseline; after accounting for the named delta changes, the retained step-1 text comparison is empty. The outside policy and literal-name tripwire remain unchanged, and only the D1 core export differs in the outside inventory. The regression now checks the retained record fields and both generator paragraphs using SDK history alone; only the rendering comparison needs DACS_FRONTEND_REPO. The package suite now registers 193 cases, including 22 provenance cases. Both maps are regenerated and the record/control pair is re-pinned together.

Publication cleanup approved 2026-10-18: current source comments, test labels, fixture defaults and test/helper filenames are redacted for publication. This is a text and path update; protocol decisions and validation rules are unchanged. The D15 ledger enumerates each changed, renamed or deleted source/test file. Historical source coordinates remain exact JSON values (escaped where a name collides with publication scanning); the generated maps use neutral display aliases for those historical filenames. Original source hashes remain immutable, and the current bytes and freeze controls are re-pinned together. Public dependency identifiers retain their registry spelling through JSON escapes; package-manager funding notices are omitted.

Fixture publication cleanup: synthetic participant names use buyer/account roles, example account handles use fixture roles, residual numbered work labels describe their test behavior, and address-only fixture inputs use documentation address ranges. Assertions and authorization decisions are retained.

Policy publication cleanup: historical finding/workstream citations use behavior and package labels. The policy regression applies exactly those documented citation substitutions to the immutable reviewed record before comparing; the remaining policy text, source references, regression requirements and gate paragraphs remain exact. A fixture administrator username is replaced with an operator role.


Launch review correction: the hold and reciprocal controls now freeze only this private package. Unrelated SDK additions, edits, removals and merges do not need client re-pins. The provenance checker retains the published commit inventory and audits later client changes, while excluding unrelated later SDK commits and merge commits. Generated outside-file coordinates no longer depend on the evolving SDK tree.

Every executable package test is discovered and run once with its registered count checked. Historical application tests requiring missing or removed components, and the source-only historical probe, are retained as exact text evidence under `evidence/source-tests/`, with a snapshot-bound index. Historical pass counts establish no current coverage. The package remains private, exports remain empty, purchase actions remain held, and the D11, DEC-16 and independent review prerequisites are still open.

The explicit JSON maximum and transaction-comparison export are required by retained RPC/Directory and native authentication callers. Their bounded opt-in behavior is unchanged. Unrelated lockfile funding/deprecation metadata is restored to the merge-base values; the remaining lockfile diff registers the private workspace only.

Launch review coverage: the broadcast-once, no-resend and executed-only paths now have executable tests; no source file changes. `test/native-broadcast-once.test.mjs` runs the retained native transport, embedded wallet and durable journal in one process against a scripted TEST node, with a TEST stand-in for the injected SDK class that signs with a real Ed25519 key. One broadcast is sent per signed transfer. An accepted, lost or refused answer keeps the lane readback-only, also after a restart, and the source refuses a fresh lease or a replayed broadcast. Readback reports a transfer included only when the transaction is confirmed, sits in its confirmed block and executed the original signed content. `test/purchase-executed-only.test.mjs` settles a purchase only on a confirmed canonical body with the requested hash and observed block that agrees with any source readback. A failed, pending, unconfirmed or mismatched body, or an observation that is not yet included, settles nothing, records no consumed nonce and keeps the hash for readback. A settlement remains a single-node observation, not finality.

Launch review settlement and delivery corrections:

- `src/dacs/chain.mjs`: `nodeProjectedNonce` is the one decoder for a transaction body's `content.nonce`. It accepts a safe non-negative JSON integer or its canonical decimal text, which is how the node serves it (node2 `getTxByHash` for native send `cbabec31…`, block 563635: `"nonce":"198"`). No whitespace, sign, fraction, exponent, leading zero or unsafe value is coerced. Buyer settlement and the native transport's transfer terms both use it.
- `src/purchases.mjs`: every purchase path, not only the native Agreement payment, reads the nonce through that decoder, so a correct confirmed payment settles on the real node shape. A canonical body whose nonce or payer cannot be read is node data, not a contradiction: verification is `transaction_unconfirmed`, and the hash, status and nonce slot stay as they were. Only a readable, different payer or nonce rejects the pointer, as before.
- `src/dacs/listing.mjs`, `src/dacs/purchase-protocol.mjs`, `src/dacs/dem-delivery-consumer.mjs`: DACS-4 §9.6.1 DV-2. An absent `offering.deliverable.accessModel` is public; any other value, including an unknown one, is non-public. This client writes and reads only public storage programs. So `protocolSupport` (buyer prepare and seller agent) and `purchaseSupport` refuse a non-public Listing, and the buyer delivery readback of a declared non-public Deliverable returns `indeterminate` with `flag: 'confidentiality-downgrade'`, never `delivery-ready` or `delivered`. An authenticated byte contradiction still rejects. `purchaseSupport` also compares the accepted rail's `railVersion` (DACS-1 LRR-3).
- Tests: `test/purchase-executed-only.test.mjs` adds a canonical body copied field for field from node2's projection, with TEST addresses, for both the default and the native terms; unreadable nonce and payer forms; readable mismatches; and the decoder's accepted and refused forms. `test/native-broadcast-once.test.mjs` reads back node2's projection of the original executed content (decimal-text nonce and timestamp, numeric OS amount and fees, hash-bearing GCR edits) and refuses other changes. `test/delivery-access-model.test.mjs` covers DV-2 for absent, public, buyer-only, encrypt-to-buyer, unknown, non-string and null access models, plus LRR-3 rail versions.

Launch review payment bound, delivery-evidence gate and non-observation corrections:

- `src/dacs/chain.mjs`, `src/dacs/listing.mjs`, `src/dacs/purchase-protocol.mjs`: a listing price is admitted only up to `OS_VERIFIABLE_MAX`, 9007199254740991 OS. A Demos node projects a transaction's `content.amount` as a JSON number, and CF-5 admission of every RPC answer refuses a number above 2^53 - 1, so a larger price could be paid but its payment never verified. `normalizeDemAmount` refuses it, so `buildListingDraft`, `purchaseSupport` (buyer) and `protocolSupport` (buyer prepare and seller agent) all carry the same reason through `demPriceProblem`.
- `src/dacs/listing.mjs`: DACS-1 LRR-3 / LRR-6. A present `railVersion` must be exactly 1; an absent one means the latest version, which in the client's in-code PA-1 resolution is that same version, so it is admitted.
- `src/dacs/chain.mjs`: CORE §5.1. A storage-program 404 or a malformed success body carries no authenticated absence proof, so `readStorageProgram` reports it as `indeterminate`, never `absent`. Both callers already admitted only `found`.
- Tests: `test/delivery-evidence-gate.test.mjs` drives the delivery-evidence gate with seller evidence signed by a runtime Ed25519 key and checked by the SDK `verifySettlementEvidence`. The control reaches `delivered`; a different `deliverableContentHash`, receipt writer, `jobId`, evidence hash, outcome, phase or signing key each keeps `delivery-ready` with the evidence rejected, and the first four are refused only by the client's own clauses. `test/price-bound.test.mjs` pins the bound at 9007199254740991 and 9007199254740992 OS on every admission path and against a node-shaped transaction body. `test/storage-read-nonobservation.test.mjs` pins the non-observation results. `test/delivery-access-model.test.mjs` now admits an absent `railVersion` and refuses a null one.

D11 SQLite callback history:

This delta records two historical statement-guard commits and their reciprocal hold pins. The write-lease change in the preceding SQLite core superseded their implementation and refusal tests:

- `fix(client): D11 refuse SQL callbacks under the statement guard`: superseded by `fix(client): D11 enforce the write lease in SQLite instead of patching statements`.
- `fix(client): D11 refuse overrides that share a bundled SQLite function name under a guard`: superseded by `fix(client): D11 enforce the write lease in SQLite instead of patching statements`.

These records add no runtime behavior. SQL callbacks remain allowed inside a leased transaction; SQLite's write lock prevents a rival worker from claiming the lease while that transaction is active. The module and its 28 lease tests come from the preceding core change. The historical callback-refusal blobs in the commit register describe those named commits, rather than a callback-refusal feature in the current tree.

D11 transaction adapter dependency split:

The database owner/epoch lease in `src/util/guarded-sqlite.mjs` remains separate from the connection-local liveness boundary in `src/util/sqlite-statement-boundary.mjs`. The purchase transaction adapter requires the latter for SQL after an automatic rollback and for synchronous result inspection. The rebuilt boundary normalizes its metadata locally, requires writable entry and undefined callback results, and restores constant query-only policies; its superseded records remain archived for historical verification. The boundary is internal and does not enable purchase actions or package exports.

D11 SQLite transaction split:

PR 03 title: `feat(client): extract the SQLite transaction-liveness lease`.

PR 03 plan row: | 3 | feat(client): extract the SQLite transaction-liveness lease | Supply the internal connection-local transaction-liveness lease only. | `src/util/sqlite-write-lease.mjs` and its isolated lease tests | No transaction orchestration or public export |.

PR 03 acceptance: `test/sqlite-write-lease.test.mjs` covers the marker, ordinary-table rollback refusal, schema refresh, commit barrier and permanent retirement; `scripts/delta-provenance.test.mjs` and `scripts/check-hold.test.mjs` check the split records and package controls. The adapter's atomicity, nested-call, diagnostic and crash/reopen acceptance belongs to PR 03c (#503), after PR 03b's statement boundary (#502).

PR 03 supplies only the connection-local transaction-liveness lease: its temporary marker, schema-trigger refresh, private commit barrier and permanent handle retirement. It adds no transaction orchestration or public export; the purchase-store seam remains unwired at this point.

Only main/temp ordinary tables are supported; attached schemas are refused because their names and versions cannot establish binding identity after replacement. Schema refresh installs ordinary-table triggers under its own BEGIN IMMEDIATE and commits before publishing their schema fingerprint. Acquisition refuses enclosing caller transactions without changing their work. After arming and BEGIN IMMEDIATE, start refuses a different locked schema fingerprint before marking the lease live; the caller must roll back, disarm and reacquire before retrying. Accepted guards survive body rollback because installation was committed separately; failed installation rolls back, or retires the handle if recovery fails.

PR 03b supplies the statement boundary; PR 03c supplies the concrete transaction adapter and the atomicity, nested-call, host-boundary, diagnostic and crash/reopen tests. Historical adapter and store-test blobs record earlier commits, not the net tree of PR 03. Their exact subjects and before/after hashes remain in the register so that the published history stays auditable.

The provenance removal test selects the last record with changed file bytes, so historical bookkeeping records cannot prevent it from testing omission of a real change.

PR 03b2 supplies read-only connection and callback admission before PR 03c: native/live handles, synchronous callback kinds, supported schemas and rollback/crash-safe main journals. Persistent main databases require DELETE, TRUNCATE, PERSIST or WAL; volatile main databases may use MEMORY. OFF is refused on every main database. Admission preserves caller configuration. PR 03c consumes these checks during transaction orchestration. The branches retain the published history through new extraction and restoration commits.

Persistent admission also reads main.synchronous on every attempt: WAL requires FULL or EXTRA, and rollback journals require EXTRA for power-loss durability. Weaker settings are refused before transactions or callbacks, without changing the connection configuration or host work. Volatile main databases have no persistent synchronization requirement.

Purchase admission normalizes its internal PRAGMA statements to object rows and numeric metadata. Native connections may retain array-row and BigInt defaults for all caller statements; admission and refusal preserve those defaults and host work.

## D11 — Closed host transfer observation record (part 05)

Settlement and non-native closed-wallet readback decide and retain a fresh frozen projection of nine own data fields. Host getters and toJSON are never called; unknown fields are ignored. Known fields require primitive types and bounded amount/address/hash formats; reason is capped at 240 characters. Malformed results stay retryable without reading the body or consuming a nonce. Confirmed body proof cannot override a raw failed source disposition. Missing includedAt remains optional. Reader attribution and native-readback availability name the actual host capability. Closed-wallet readback writes nothing.

Published part-05 iteration records are archived with the existing ledger archive mechanism; prerequisite records and all historical blob checks are retained. This rebuild is recorded against its actual published parent. Unrelated crash/deadline fixtures return to the prerequisite tree. Exports remain empty and actions remain held.
