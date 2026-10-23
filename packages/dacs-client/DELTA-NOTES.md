# client package deltas

Scope: PLAN §8 and §0.3, D10, D9, D1, D11, D15 and the recorded D16 corrections. The public API is the explicit root and durable-journal map; protocol actions remain held.
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
- `src/seams/purchase-store-not-wired.mjs:1`: transaction/isUniqueViolation stubs for D11. No store implementation or registration mechanism.
- `src/seams/wallet-actions-not-wired.mjs:1`: wallet challenge and portal payload/check stubs for D11.
- `src/seams/buyer-access-not-wired.mjs:1`: the in-process operator capability is unavailable pending D11.
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
- `test/helpers/purchase-integrity-{database,operations}.mjs:1`: historical frontend test-only harness. A test-local module hook supplies its SQLite transaction function to the inert store stub; production imports no test code and receives no adapter registration API.
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
- D11 is a binding prerequisite before wiring: transactions must be synchronous, re-entrant and serializing (`BEGIN IMMEDIATE` or equivalent); nested calls join the outer transaction. Run `test/purchase-integrity.test.mjs`, `test/purchase-review-races.test.mjs` and `test/readback-review-decisions.test.mjs` against the real PurchaseStore adapter, including both completion orders, late same-hash reads, supersession and restart. The current tests use the source-bound test-only helpers recorded by source and destination blob in D15-SOURCES.json; they do not validate a production store seam.
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


## D11: explicit host seams and public buyer boundary

- `src/purchases.mjs`, `src/dacs/protocol-purchases.mjs` and `src/dacs/delivery-deadline-watch.mjs` validate an injected PurchaseStore before using state. Store methods preserve their receiver. The purchase service also requires the host approval purpose; protocol purchases take an already-resolved optional buyer access capability.
- `src/wallet/devnet-native-transport.mjs` imports the package pure wallet digest and confirmation helpers. The original exact-byte, broadcast-once and indeterminate-read rules stay in force.
- `src/index.mjs` lists the reviewed root names; the only additional subpath is `wallet/durable-journal`. The package uses the workspace version and an exact matching core dependency. Runtime source, README and license ship; source evidence and control scripts do not ship.
- `src/dacs/seller-agent-error.mjs` shares the existing error identity without pulling seller storage into buyer imports. SQLite loads only when the private seller authentication journal is constructed or the separate wallet journal is imported.
- Factory tests refuse absent/malformed seams before dependency access and retain missing-capability/profile refusals. Public action tests prove refusal before challenge issuance/consumption or coordinate writes, including persisted approval states. Existing D15 races and executed-payment tests pass their SQLite adapter explicitly, without loader substitutions.
- Package integrity still checks the complete file set, reciprocal pins and HEAD/index/working bytes and modes. The manifest policy now requires exactly the reviewed public export map; all unreviewed additions remain refused.
- Historical sections above describe their respective checkpoints. This D11 change supersedes their empty-export status; the private publication guard remains. The protocol action hold, production store qualification and immutable identity prerequisites remain binding. Browser exports await the signing-domain/profile change; no old-domain public browser entry is added.


## D11 review fixes: action admission, host contracts and package contents

- Public purchase approval challenges, approvals and handoffs now call the same unconditional action-admission hold as protocol purchases. Legacy operations, including previously approved operations and handoff reissues, cannot reach native payload construction, challenge calls or coordinate writes. Readback now validates host observation shapes, preserves core invalid results and attributes observations to their injected reader. The public factory returns diagnostic readback only; the retained source settlement integration remains private.
- The old nested buyer-access option throws a migration error. A successful synchronous buyer assertion must return exactly undefined; predicates, generators and promises cannot grant authority. Store construction requires the package-owned concrete SQLite transaction. Its synchronous callback result is validated before commit; errors and thenables roll back. Classifiers must return exact synchronous booleans.
- Root exports include the client, seller-client, wallet-format, bridge and readback error classes so host guards retain defining identity.
- Pure wallet payload helpers and a local `EmbeddedWalletError` class are isolated from the provider; its code and message contract is retained, while constructor identity is separate. The tarball contains exactly the two entry-point import closures, README, license and manifest; an npm dry-run test rejects surplus source and internal records. The provider retains its helper re-exports; helper algorithms are unchanged.
- Repository metadata is supplied and core is an exact-version peer, consistent with the host package. The private client remains outside the three-package release set pending an owner decision and matching artifact/lifecycle/SBOM integration; supported installation uses paired local tarballs or the workspace.
- Packed root imports run in CI on Node 22, with an additional Node 20.19.0 import-only probe outside client engines; both entry points are checked at the declared client engine floors, 22.13.0 and 23.4.0. Portal route constants are documented as experimental and provenance describes registry installs accurately. Both entry points support JavaScript consumers only. TypeScript, browser and full agreement-capability transport integrations are outside this candidate. A fixed digest vector covers prepared/signed payload identity at the pure-helper boundary.
- Regression tests were added before implementation. Previous host-approval success tests are replaced by public admission-refusal checks; nested transaction rollback, readback, pointer races and executed-only settlement regressions remain.


## D11 candidate: concrete SQLite state and explicit public scope

- `createSqlitePurchaseStore` provides the package-owned `BEGIN IMMEDIATE` transaction used by all state-changing factories; arbitrary transaction wrappers are refused at construction. Real SQLite vectors cover nested rollback, thenable rollback, second-connection exclusion/retry and process death before/after commit. Existing pointer, restart and executed-only settlement cases use this same implementation.
- Preparation and the agreement/native/completion entry points refuse before state access or current protocol resolution. The public Listing verifier follows the same CORE §11.1.2(3) admission boundary. Existing operation readback remains available.
- The public JavaScript candidate excludes the unqualified node-reader factory, held bridge constructor and private transport-brand predicates. The private publication guard remains set. Paired local artifacts are the supported distribution path; both public entry points require Node ^22.13.0 or >=23.4.0.
- Settlement classifier tests cover exact true/false, thenable/non-boolean results and original thrown causes. Public imports trap both SQLite import and require, and a demosdk 4.0.16 post-fork serializer vector pins the prepared amount-encoding precondition.


## D11 domain recovery validation

- File-backed SQLite tests kill a worker with SIGKILL immediately before and after the actual outer settlement and delivery-overdue COMMIT. Reopening checks the complete payment pointer/status/nonce-consumption decision and replacement supersession, or the overdue state/event pair. A retry and a second restart preserve exactly one committed decision. The worker intercepts the connection COMMIT only; domain entry points and the package transaction implementation run unchanged.
- A compatible-looking handle from another SQLite library is refused before any transaction callback. The README states that DatabaseSync validation occurs at the first transaction. The unqualified transaction test explicitly checks zero invocations.
- The surrounding SDK's Node 20 root-import probe is labelled outside client engines; both public entry points require Node ^22.13.0 or >=23.4.0.


## D11 retained readback runtime and recovery validation

- The retained-readback test uses `module.register` with an isolated test loader at Node 22.13.0 and 23.4.0. The minimum-runtime CI job runs those decisions together with public API, atomicity and domain crash tests using explicit TAP output.
- Native agreement-payment crash vectors kill before and after settlement, native supersession/nonce-resolution markers and both pending-event commits. Reopen preserves each committed decision; repeated source failures preserve the original reason without duplicate events, and a later successful retry completes both markers once. Production source and admission rules are unchanged.

## D11 buyer state and readback contracts

- Export the required buyer-state DDL, use it in the offline state harness, and construct all buyer factories from paired packed artifacts. The consumer checks shared unverified hash pointers, unique verified hashes, and one approval per operation/challenge.
- Nested SQLite transactions use savepoints. A caught synchronous inner error rolls back its own writes; successful nested work remains part of the outer commit. A returned promise retires the connection and rolls back the whole transaction before its continuation can run.
- Host transfer observations have a documented JSON contract. Malformed data stays retryable without a terminal terms mismatch, and the recorded observer identifies the injected reader. Alternate signing-key projections remain supported.
- Native source reconciliation reports unavailable when the host has no native capability. Wallet-access readback codes and the separate deadline-watch invocation are documented.
- Wallet journal lock callbacks preserve every rejection value, including falsy values, and release their lane before propagating it. The statically served wallet provider retains its local payload helpers, with equivalence and independent-loading tests.


## D11 diagnostic host boundary

- The public purchase factory reports fresh host observations without persisting payment decisions or driving protocol effects. Retained source settlement and crash recovery use the private factory. Public cancellation, wallet-result reporting and protocol recheck remain under admission.
- Core `invalid` transfer observations retain their reason and canonical-body nonce reconciliation in the retained integration. Malformed host shapes use a distinct diagnostic status, including wallet-access-closed readback.
- The host operations contract specifies owner-scoped reads, atomic status compare-and-swap, append-only events and seller-session state transitions. Directory summaries remain discovery hints.

## D11 host diagnostic contracts

- Public account reads validate the requested owner and operation id, and handoff reads preserve the requested operation id. Hosts supply authenticated account context and authenticate handoff tokens.
- Public diagnostics honor the resolved buyer capability, read only the recorded hash, and report a non-authorizing payer/payee/amount match. The closed-access exception remains available for an already reported hash.
- Public purchase and protocol guidance describes held actions and historical state. Expired portal reads do not persist transitions. Optional inclusion timestamps are validated before use; reader failures preserve their cause.
- The enabled deadline watch is explicit host bookkeeping; passing an unwired automatic-watch option is refused. Retained signing-key projections and purchase admission are unchanged.

## D11 SQLite recovery and diagnostic consistency

- SQLite recovery closes and retires a connection when rollback cannot complete. File-backed transaction tests cover automatic rollback, prepared statements, fresh-handle retry and persistence after reopen alongside recoverable nested failures.
- Public portal and status reads share a read-only expiry projection. Diagnostic tuple matching accounts for the reader's source disposition, and retained reader errors use bounded text conversion.
- Packed-consumer installation prefers cached locked tarballs and can download missing tarballs. The README describes connection recovery, diagnostic results and validation prerequisites.

## D11 guarded writes and host projections

- Connection-local SQLite triggers guard existing ordinary tables with a transactional marker, including statements prepared before entry. Automatic rollback prevents subsequent DML writes; marker checks precede savepoint release and outer commit. File-backed tests cover both callback depths, conflict/trigger rollback, all statement result methods, sibling/TEMP/attached tables, fresh-handle retry and recoverable constraint errors.
- Public diagnostic reads share the expiry projection, including the recorded-hash exception for closed buyer access. Retained domain-reader failures keep bounded, null-safe causes.
- Directory revocation discovery projects the bounded seven-field binding and copies its native anchor. Local deadline and operator-hold records identify host-supplied input. The serializer test verifies the resolved demosdk version, and the README states historical testnet availability and the synchronous DML boundary.

## D11 passive diagnostics and connection lifecycle

- Public diagnostics retain historical identifiers, hashes and nonces while omitting payment payloads and planned, identity and bundle signing messages and unsigned session-delegation payloads. The existing CORE §11.1.2 action hold remains in effect.
- SQLite guards stay installed per connection, refresh for schema changes and cover ordinary host tables while excluding virtual and shadow tables. Arming and transactional marker updates distinguish package calls from host writes. All successful-call guard work precedes commit. Returned thenables retire the connection at either depth; an already completed outer automatic rollback permits the host to reuse its handle.
- Deadline observations accept the full JavaScript Date range and render malformed historical times as unavailable. Directory summaries omit rail identifiers longer than 256 characters without changing shorter identifiers or artifact validation.
- The README specifies hydrated operation fields, synchronous host contracts and connection recovery. Tests exercise active SELECT iterators, FTS5/R*Tree databases, prepared statements, deferred host callbacks, schema refresh, a 400-table host, timestamp boundaries and all public diagnostic projections.

## D11 authenticated portal diagnostics and discovery hints

- Portal operation and evidence reads each resolve an operation id and handoff token through the host's authenticated lookup. Evidence projections use the fresh stored record. Scalar lookup arguments, purchase kind and requested id are checked before private coordinate reads; original lookup and buyer-access refusals propagate.
- Summary hints accept both the Standard's `revocation` and Community's `revocationBinding` through the same bounded projection. Equal aliases remain available; conflicting hints remain unavailable. This supplies no revocation or artifact-verification authority.
- Host regressions cover invalid and cross-operation tokens, caller-supplied operation objects, repeated fresh authenticated reads, held actions after local overdue/operator-hold bookkeeping, and paired packed-consumer portal reads. Documentation specifies raw Directory detail data and the prohibition on host transaction control inside store calls.


## D11 host boundary and diagnostic contracts

The SQLite adapter holds a package-private write statement across callbacks, so SQLite refuses callback COMMIT/END, including pre-prepared statements. Package savepoint control temporarily finishes and recreates that statement without running host code. Pre-existing host transactions are refused before guard installation; missing markers are rebuilt, and nested entry recovers only a savepoint it actually opened. Host DML outside package calls remains available.

Portal reads authenticate the stored capability hash, independent handoff expiry and owner before the host lookup or secondary reads. `operations.handoff_expires_at` is a new nullable TEXT column; hosts must migrate and provision an explicit lifetime, separate from approval expiry. A null lifetime denies portal access. Valid diagnostic links remain usable after their approval window.

Public transfer diagnostics have a service-level deadline, an abort signal and a bounded primitive projection. Discovery summaries explicitly carry `verified: false`; exact lookup uses the pinned Community seller route to retain revoked records. Revocation hints obey RB-3 and match their summary tuple without imposing a substrate-specific marker anchor. Journal reads recheck the format version, and deadline guidance describes payment-only public readback. Purchase and artifact-verification actions remain held.

The retained protocol readback shortcut shares the stored portal capability check before its closed-wallet-access exception. Id/kind mismatch tests supply a valid capability so they continue to exercise the returned-operation checks.

D11 diagnostic integration contracts:

- Public account reads require the existing operation-scoped handoff token on every call. The stored hash, owner and canonical UTC expiry are checked before account data is read.
- Active Directory records carrying either revocation binding alias are refused under DACS-1 RB-3/RB-6. Valid active records and unverified revoked discovery remain supported.
- Host delivery observations cannot be dated later than the watch clock. The adapter retains current or past eligible observations through its existing transaction.
