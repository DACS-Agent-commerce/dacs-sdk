The governing input is [PROFILE.json](PROFILE.json), pinned to DACS-Standard
`d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20`. Historical planning notes,
proposed register entries and workstream names below are port history only.
They grant no exception to the Standard. This experimental package has no
qualified live deployment; unsupported qualification stays blocked.

# Port sources: #58 and #59

`port-sources/` holds publication copies of the files that frontend #58 and #59 add or change, taken at their inspected heads and redacted for publication. Nothing imports them. D5 merges them into `src/` in the port, and every merged line is then listed in `DELTA-MAP.md`. `PROVENANCE.json` records each file with `role: port-source`, the PR head as `sourceCommit`, the head the plan names, and the file's SHA-256 at that head (`planNamedSha256`, or `null` where the file does not exist there).

| PR | Topic | Inspected head (ported) | Head the plan names | Directory |
|---|---|---|---|---|
| #58 | seller-sourced purchase lookup, manual hold of pre-payment writes (`purchaseSource: "seller"`) | `786aa1d9d6b6393190a6f388a4b92cb921af1fc6` | `5274f18541ac0e8c77e3e71463bb6c811f048922` | `port-sources/pr58-786aa1d/` |
| #59 | Vet and Agreement-context route, per-buyer and global unpaid-start limits (`DACS_SELLER_CONTEXT=route`) | `ffef873a58a1e71f3a91ae159d92a549992c3857` | `febba6cc2e732a59124eb39f33a50f017d4e3d4c` | `port-sources/pr59-ffef873/` |

Both inspected heads descend from the heads the plan names, and both merge main `82bf8c4`, the integration base of `src/` and `test/`. So `git diff 82bf8c4 786aa1d -- http-mcp` is exactly #58's change, and likewise for #59 (checked with `git merge-base --is-ancestor`; the original preparation tooling recorded that check). The source heads were frozen on 2026-10-14. Publication of these source copies in this repository was approved on 2026-10-18; that is not an npm release or a deployment.

**What is ported:** every file under `http-mcp/src` that the PR adds or changes and that is in the seller set or is new seller-side code, plus every test or test helper the PR adds or changes. "Same at the plan-named head" says whether the file already had these bytes at the head the plan names. "Absent there" means the file came in through the PR's merge of main.

## #58 (`786aa1d`): 18 files ported, 8 not ported

| Source path (`http-mcp/`) | Change | Lines | Same at the plan-named head | Why ported |
|---|---|---|---|---|
| `src/dacs/seller-agent.mjs` | modified | 1463 | no, changed after it | in the 82bf8c4 seller set |
| `src/devnet-demo/operator-approval.mjs` | modified | 853 | no, changed after it | in the 82bf8c4 seller set |
| `src/devnet-demo/seller-issuance.mjs` | added | 15 | yes | the seller issuance-journal binding for the approval ledger; at `786aa1d` only `operator.mjs` and `ops/health.mjs` import it. Flagged: new seller-side code outside the named list |
| `src/devnet-demo/seller-purchase-source.mjs` | added | 92 | yes | the seller-sourced purchase lookup |
| `src/devnet-demo/seller-state-lock.mjs` | added | 120 | yes | the process-lifetime seller state-directory lock |
| `test/fee-approval-recovery-offline.test.mjs` | modified | 196 | no, changed after it | test |
| `test/helpers/devnet-operator-purchase-node2.mjs` | modified | 125 | no, changed after it | test helper |
| `test/operator-approval-closing.test.mjs` | modified | 123 | absent there | test |
| `test/ops-health-seller-records-off.test.mjs` | added | 70 | yes | test (plugin ops health) |
| `test/ops-health.test.mjs` | modified | 1359 | no, changed after it | test (plugin ops health) |
| `test/seller-policy-commit-on-signature.test.mjs` | added | 98 | yes | test |
| `test/seller-policy-journal-freshness.test.mjs` | added | 123 | yes | test |
| `test/seller-policy-journal-identity.test.mjs` | added | 261 | yes | test |
| `test/seller-policy-purchase-source-node2.test.mjs` | added | 470 | no, changed after it | test |
| `test/seller-policy-purchase-source.test.mjs` | added | 961 | yes | test |
| `test/seller-policy-reservation-restart.test.mjs` | added | 711 | yes | test |
| `test/seller-policy-state-lock.test.mjs` | added | 153 | yes | test |
| `test/server-hosting.test.mjs` | modified | 679 | absent there | test (plugin hosting hosting) |

| Not ported (`http-mcp/`) | Change | Reason |
|---|---|---|
| `deploy/hosting/README.md` | modified | plugin hosting deployment doc (plugin-side; outside src/ and test/) |
| `deploy/hosting/dacs.env.example` | modified | plugin hosting environment template (plugin-side; outside src/ and test/) |
| `deploy/hosting/preflight.mjs` | modified | plugin hosting preflight (plugin-side; outside src/ and test/) |
| `docs/OPS-HEALTH.md` | modified | plugin ops-health doc (plugin-side) |
| `docs/SELLER-POLICY-AND-DELIVERY-EVIDENCE.md` | modified | seller policy doc; outside src/ and not a test. D5 and the README delta read it at `786aa1d` |
| `scripts/devnet-demo-seller-release.mjs` | added | operator script that releases a held seller attempt; outside src/. Input to D12's `approvals` command |
| `src/devnet-demo/operator.mjs` | modified | the in-process operator (plugin-side; the seller host replaces it). Its seller-mode wiring (journal binding, state lock, purchase resolver) is D5/D12 input |
| `src/ops/health.mjs` | modified | plugin ops health (plugin-side) |

## #59 (`ffef873`): 22 files ported, 14 not ported

| Source path (`http-mcp/`) | Change | Lines | Same at the plan-named head | Why ported |
|---|---|---|---|---|
| `src/dacs/seller-agent.mjs` | modified | 1474 | no, changed after it | in the 82bf8c4 seller set |
| `src/dacs/seller-context-route.mjs` | added | 324 | no, changed after it | the context route. It also holds the route client (`createSellerContextClient`), which the buyer side uses |
| `src/dacs/seller-http.mjs` | modified | 306 | no, changed after it | in the 82bf8c4 seller set |
| `src/dacs/seller-transport-auth.mjs` | modified | 486 | no, changed after it | in the 82bf8c4 seller set |
| `src/devnet-demo/agreement-context.mjs` | modified | 491 | no, changed after it | in the 82bf8c4 seller set |
| `src/devnet-demo/artifact-anchor.mjs` | modified | 340 | no, changed after it | in the 82bf8c4 seller set |
| `src/devnet-demo/operator-approval.mjs` | modified | 495 | no, changed after it | in the 82bf8c4 seller set |
| `src/switches/DACS_SELLER_CONTEXT.switch` | added | 11 | yes | the switch file for `DACS_SELLER_CONTEXT` (`in-process` or `route`) |
| `test/devnet-operator-plan-shutdown-owned.test.mjs` | modified | 135 | absent there | test |
| `test/fee-approval-recovery-offline.test.mjs` | modified | 194 | no, changed after it | test |
| `test/helpers/devnet-operator-purchase-node2.mjs` | modified | 129 | no, changed after it | test helper |
| `test/helpers/seller-context-fixture.mjs` | added | 126 | yes | test helper |
| `test/helpers/seller-context-off-operator.mjs` | added | 153 | yes | test helper |
| `test/helpers/seller-context-off-scenario.mjs` | added | 161 | yes | test helper |
| `test/ops-health-lost-attempt.test.mjs` | modified | 214 | yes | test (plugin ops health) |
| `test/ops-health.test.mjs` | modified | 1180 | yes | test (plugin ops health) |
| `test/seller-context-route-off.test.mjs` | added | 83 | yes | test |
| `test/seller-context-route-shutdown-resume.test.mjs` | added | 120 | absent there | test |
| `test/seller-context-route-unit.test.mjs` | added | 1082 | no, changed after it | test |
| `test/seller-context-route.test.mjs` | added | 615 | no, changed after it | test |
| `test/seller-policy-delivery-evidence.test.mjs` | modified | 983 | no, changed after it | test |
| `test/server-hosting.test.mjs` | modified | 683 | no, changed after it | test (plugin hosting hosting) |

| Not ported (`http-mcp/`) | Change | Reason |
|---|---|---|
| `deploy/hosting/README.md` | modified | plugin hosting deployment doc (plugin-side; outside src/ and test/) |
| `deploy/hosting/preflight.mjs` | modified | plugin hosting preflight (plugin-side; outside src/ and test/) |
| `docs/OPS-HEALTH.md` | modified | plugin ops-health doc (plugin-side) |
| `docs/SWITCHES.md` | modified | plugin switch registry doc (plugin-side) |
| `docs/seller-context-route.md` | added | context-route design doc; outside src/ and not a test. D5 reads it at `ffef873` |
| `scripts/print-seller-context-digests.mjs` | added | operator script; outside src/. Input to D12's `approvals` command |
| `scripts/release-seller-context-hold.mjs` | added | operator script that releases a held context step; outside src/. Input to D12's `approvals` command |
| `src/dacs/dem-delivery-context-consumer.mjs` | modified | client-side: an `@kynesyslabs/dacs-client` open item |
| `src/dacs/protocol-purchases.mjs` | modified | client-side: an `@kynesyslabs/dacs-client` open item |
| `src/devnet-demo/composition.mjs` | modified | the in-process operator's composition (plugin-side; the seller host replaces it) |
| `src/devnet-demo/operator-sessions.mjs` | modified | the in-process operator's buyer-side seller session keys (plugin-side) |
| `src/devnet-demo/operator.mjs` | modified | the in-process operator (plugin-side; the seller host replaces it) |
| `src/mcp/seller-content.mjs` | modified | the plugin's MCP untrusted-text envelope (plugin-side) |
| `src/ops/health.mjs` | modified | plugin ops health (plugin-side) |

What the ported files import at their PR heads is in `IMPORT-CUT-MAP.md` §6 G7. Two of those imports matter for D5: #59's route imports the plugin's `config.mjs` (`PURCHASE_LIMITS`, `seller-context-route.mjs:34`, which sets the per-buyer start limit) and `mcp/seller-content.mjs` (`sellerData`, `:35`, used by the route client).

## Blocked acceptance items

- **#58: code review record at the inspected head missing.** No code review completed at `786aa1d`. The newest completed code review is earlier review of the main merge `0aad9e3`. A full review exists at `786aa1d`.
- **#59: code review record at the inspected head missing.** No code review completed at `ffef873`. The newest completed code reviews are at `6fd91b2`, plus the fix report for `6fd91b2` → `ffef873`. A full review exists at `ffef873`.

The review record is frozen as of 2026-10-14. The port (D5) must not treat either head as code-reviewed.

## D5's question: where #58's manual hold and #59's authenticated context admission collide

This records the collision; D5 resolves it. Line numbers are in the ported files: `port-sources/pr58-786aa1d/http-mcp/src/devnet-demo/operator-approval.mjs` ("#58") and `port-sources/pr59-ffef873/http-mcp/src/devnet-demo/operator-approval.mjs` ("#59"). The `82bf8c4` version is `src/devnet-demo/operator-approval.mjs`.

1. **Which pre-payment writes may be approved automatically.**
   - #58, with `purchaseSource: "seller"`, holds every otherwise-approvable write before payment for exact manual approval. The hold reasons are `seller-record-missing` and `cancellation-unknown` (#58 :76-79). The writes before payment are the Vet (`CompositeVerificationRecord`) and the commitment (`FinalityCommitmentRecord`) (#58 :30).
   - When the seller has no record of the job yet, `policyRefusal` returns `seller-record-missing` after its record-free checks (#58 :138-147). A Vet write held with no binding is admitted to confirmation (`unbound`, #58 :152). Every pre-payment write that passes is still held as `cancellation-unknown`, because the seller is never told of a buyer-side cancellation (#58 :177).
   - #59 admits a context request that has passed transport authentication, scope binding to the seller's own Listing, buyer access, the known-job check, the write budget and the unpaid-start limits (`seller-context-route.mjs` :119-125, :144-161; limits :52). It then reserves both seller Vet writes up front for policy approval, so that "the second Vet write is never refused for a budget the first one used" (#59 :440-470). Manual mode reserves nothing (#59 :447, :459).
   - Taken together, the Vet writes that #59 reserved would each be held for manual approval by #58: the context step runs before the proposal, when the seller has no record of the job. The step then waits on the operator inside the route's 240-second bound (`SELLER_CONTEXT_TIMEOUT_MS`, `seller-context-route.mjs:46`).
   - D5 must state which requests can authorize bounded automatic writes (for example an authenticated, admitted context request under the combined limits, whose durable admission record `createSellerContextRecords` provides, `seller-context-route.mjs:29-31`) and which stay held (no seller record, unauthenticated, over a limit, cancellation unknown). It must test both PRs' cases.
2. **One evidence file, two ledger extensions.**
   - #58 adds held attempts (attempt lines, `attemptId`, `policyHold`, a ledger header), and `readPolicyLedger` returns `{rows, attempts, header}` (#58 :181-320, :335).
   - #59 adds context hold, release and refusal lines (`CONTEXT_FORMAT`, #59 :13, :160, :193-213) and `artifactKind` on each entry. Its `readPolicyLedger` still returns the row array (#59 :147-185), which `createSellerContextAdmission` and `releaseSellerContextHolds` rely on (#59 :461-462, :486-490).
   - The merged parser must accept both line families on one file and keep both PRs' restart and restore rules.
3. **Counting a write once.**
   - #58's `budgetRefusal` counts an attempt's hold line, manual line and reservation as one write for the job (#58 :351-369).
   - #59 adds each open context hold's unconverted Vet writes to the job and hourly counts, and a policy-approved Vet write converts one of them (`contextHoldRows`, `withContextHolds`, #59 :215-232, :256-268, :361).
   - A Vet write that #58 held and the operator then approved must convert at most one context slot and be counted once.
4. **Whose records answer "is this job known".**
   - #59's admission asks the composition's `knownJob` and `assertBuyerAccess` (`seller-context-route.mjs:148-149`, `:191-192`). In-process, these are the buyer application's records, and the route takes its per-buyer limit from the plugin's `config.mjs` (`:34`, `:47-52`).
   - #58's seller records exist to remove those application reads (K1, historical design note §1.2).
   - The merged admission has to answer from seller-owned records, so that a public seller holds no buyer database.

Tests that bear on the merge, from both PRs:
- #58: `seller-policy-purchase-source.test.mjs`, `seller-policy-purchase-source-node2.test.mjs`, `seller-policy-reservation-restart.test.mjs`, `seller-policy-commit-on-signature.test.mjs`, `seller-policy-state-lock.test.mjs`, `seller-policy-journal-{freshness,identity}.test.mjs`, `operator-approval-closing.test.mjs`.
- #59: `seller-context-route-unit.test.mjs`, `seller-context-route.test.mjs`, `seller-context-route-shutdown-resume.test.mjs`, `seller-context-route-off.test.mjs`, `seller-policy-delivery-evidence.test.mjs` (its context-admission cases).

## Publication redactions (2026-10-18)

The original SHA-256 values, source commits and source/target ranges remain
immutable in PROVENANCE.json. PUBLISHED-BASELINE.json records the 197 source
hashes and Git blobs from published commit
`d231c7d11170fe27dfa85f701c9893b10716708e`. The checker pins that file by its
SHA-256, so it also works in shallow clones and exported source checkouts.
MAINTENANCE.json records each later source change with its original and current
SHA-256. The original frontend identities remain available for independent
upstream comparison; current checks establish published-source integrity and
explicit maintenance changes. They do not claim to reconstruct unavailable
preparation history or independently verify private frontend ancestry.

Run `node packages/dacs-seller/scripts/check-provenance.mjs` and
`node packages/dacs-seller/scripts/publication-provenance.mjs --check`.
The historical `check-step1-provenance.mjs --root <original snapshot> --source
<frontend repository>` remains available for owners holding those source
objects. Current qualification does not depend on its preparation commits.
