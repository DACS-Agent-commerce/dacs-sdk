Current behavior and executable coverage are specified by PROFILE.json and
ADMISSION.md. The dispositions below record the frozen source port and are
historical; they do not authorize exceptions or describe current protocol
qualification. Bilateral session presentations and independent buyer Vet
authority are now required by the standalone context adapter. Native writes
require independently verified deployment qualification.

# D5 review dispositions

Inputs: the reviews of the two frozen source heads.
The frozen inputs are #58 `786aa1d` and #59 `ffef873`. Earlier records are
reconciled against the later fix report, rather than treated as new findings.
There is no completed code sweep at either frozen head. Publication was approved on 2026-10-18. Deployment and full-profile acceptance remain unverified.

| Finding still relevant at the frozen heads | D5 disposition | Evidence / remaining owner |
| --- | --- | --- |
| #58 exact-expiry app-source vector | Not applicable: the app resolver and app held-job query do not exist in the kit | A1 rejects app configuration; S1 tests the seller window at expiry and one millisecond before |
| #58 incomplete browser-handoff health record; earlier native-payment health rejection | Not applicable: no ops health classifier is ported | Excluded tests are listed in DELTA-MAP.md; original source pins are retained alongside publication redactions |
| #58 / #59 deployed node has unrecorded changes or no reproducible build pin | Not a result that offline D5 can verify or fix | No node contacted; D2/D12 and qualification must establish the actual deployment identity. Not claimed resolved |
| #58 older F2 hosting preflight setting inventory | Not applicable: no hosting preflight is ported | Hosting tests excluded |
| #58 older F3 held manual approval cut at shutdown | The reservation remains held and counted; no automatic release is introduced | D12 owns host shutdown and operator release. A8 tests restart retention of unresolved issuance; the full shutdown combination remains unrun |
| #58 older F4 TTY descriptors | Frozen fix ported | operator-approval-closing.test.mjs includes stderr TTY; execution awaits D1's stop-request module |
| #58 older F5 journal-busy close and state lock after CLI shutdown | Host integration remains unrun; no CLI is ported | D12 must close all writers before releasing the process-lifetime state lock; S3 tests refusal beside a live holder |
| #59 verifier-issued presentation nonce / bilateral challenges | Buyer context binding fixed; bilateral qualification remains blocked S-15/G2 | B22–B25/B27–B28/B30 execute seller-issued scope/job-bound challenges, lifetime, consumption on attempt, retention, and issuance limits. D11/S-15 must integrate buyer preparation; no bilateral qualification is claimed |
| #59 evaluated seller signs its own Vet | Fixed in the standalone provider | The buyer signs the seller CVR; strict signer, decision and independent receipt checks run before context publication and during recovery. Host qualification remains unsupported. |
| #59 seller evaluated against Listing buyer requirement | Explicit empty seller requirement in PROFILE.json; no normative exceptions or proposed G10 dependency | VPC2 test uses a non-empty Listing buyer requirement and independent empty seller requirement through production, retention and recovery; B7 rejects a request-supplied seller requirement |
| #59 valid CVR with non-pass overall decision | Fixed | VPC4 tests every non-pass decision for both parties, initially and on recovery, with a pass control; B21/B31 execute definite HTTP/client refusal and retained admission accounting |
| #59 demosdk range described as a pin | Not applicable to the copied context module's dependency declaration; no new demosdk pin is claimed | The cited chain.mjs is not moved here. D2 supplies the Node signer and exact dependency evidence |
| #59 whole-module mutation bar / missing final code sweeps | Not completed | Six focused mutants are killed, with one selected test per process. This is not a whole-module sweep or an independent code review |

The bilateral challenge and Vet-authority qualification rows, buyer integration, G10 declaration and deployment evidence remain open. PLAN §0.2
records their qualification requirements. They are not silently
waived by this document. The blanket instruction to fix or dismiss every open
source-review finding is therefore **not fully satisfied** within D5's scope.

Remaining P3 items in the #59 code sweep at `6fd91b2`, after its fix report:

| Item | D5 disposition |
| --- | --- |
| 1 stale ops-health citations | Not applicable: ops health is not ported |
| 2 only presenter signature checked in a multi-claim bundle | Fixed by the single-claim profile guard; B7 uses a valid presenter signature, matching hashes, and a second claim with an invalid signature. Removing the guard fails B7 |
| 3 self-Vet and directional requirement | Self-Vet stays open above; directional requirement is restricted in TP-1 as above |
| 4 malformed but signed inputs / exact boundaries | B7 re-signs negative schema/scope vectors and tests fractional time plus the inclusive ten-minute boundary; B3 tests the exact one-hour boundary |
| 5 reconcile releases all unused job holds | Ported from the frozen fix; documented in ADMISSION.md. The original reconcile-present test remains blocked by D1/D12 |
| 6 hold effect is not compared | Explicitly informational as in the frozen fix; holdId and jobId select release/conversion |
| 7 ledger line shape and release binding | L3, L4 and L8 test keys, duplicates, write/amount ranges, refusal shape and wrong-job release |
| 8 preparation budget, hold filter, release CLI, throwing context lookup | L7 tests durable preparation budget; L4 tests the exact hold filter. No release CLI is ported. The original proposal lookup test remains blocked by D1/D12 |
| 9 three-request serialization, release failure, resume-conflict hold | B5, B15 and B16 test those paths. B14 tests fencing of an uncertain effect; B20 and R2 execute successful resume, unknown-intent fencing and exact admission retention. The original host shutdown test remains blocked by D1/D12 |
| 10 plugin protocol event vocabulary | Not applicable: no MCP event vocabulary is ported |
| 11 duplicated buyer timeout | Buyer coordinator timeout configuration belongs to WS-4/D11; no second seller timeout value is introduced |
| 12 switch-off provenance note | Not applicable: no switch-off mode or switch-off test is ported |
| 13 unresolved design citation | Already removed at the frozen fix; no such claim is added |
| 14 buyer lost-attempt / local client dispatch marks | Buyer coordinator and ops-health integration belong to WS-4/D11; this seller port changes neither |
| 15 live node dependency not verified | Still unverified, as in the deployment row above; no live service is contacted |

Earlier P1/P2 test gaps (per-write access/job recheck, proposal freshness,
retained-context recovery, saved buyer request, conversion and expired delegation)
were addressed by the frozen `ffef873` fix. Their tests are ported intact where
they belong to the seller; their D1/D12 load failures are recorded per file in
the per-file test inventory. A successful source read is not a passing integration test.
The plugin-only shutdown and saved-purchase wiring still need their destination
host/client tests. No mutation or historical pass count is promoted to this head.


Authority boundary evidence: DACS-2 §7.7.2 at the profile's pinned Standard
`d45c0a2` requires the counterparty verifier to sign. The provider obtains the
buyer's signed seller CVR, verifies its decision and receipt independently, and
retains it with the per-job seller presentation. The native publisher keeps
writer and verifier identities separate. Runnable bilateral tests cover these
gates. Historical PLAN/G10 proposals are not normative authority; PROFILE.json
and ADMISSION.md retain unsupported deployment/host qualification explicitly.


## Copied tests whose expectations D5 replaced

The following frozen copies are **replaced by D5: rewrite to the D5 rule when rehosting; do not revert D5**. Their bytes stay pinned. A missing import is only the first blocker; supplying D1/D12 cannot make the superseded expectations correct. D12 must split host/oracle vectors from kit vectors and keep both PRs' applicable assertions. No pass is claimed for these copies.

| Copied file / fixture | Superseded expectation and required rehosting change | Executed D5 replacement |
| --- | --- | --- |
| `test/helpers/seller-context-fixture.mjs:13`, `:57` | `offBuyerBundle` chooses its nonce and the fixture never obtains the seller's challenge; `logRefusal` and `w.refusals` are removed API expectations. Fetch the authenticated challenge before signing and remove refusal logging. | B22–B28, B30, B32–B34; d5-limits-before-effects B22–B28, B30, B32–B34; d5-challenge-retention T23 |
| `test/helpers/seller-context-off-scenario.mjs:81` | `offBuyerBundle` derives a nonce from a buyer seed. Retain this only as an in-process comparison oracle; route inputs need a newly issued, exact-job/scope challenge and a new presentation. It supplies the fixture above. | B22–B25, B27; R2 uses the current route |
| `test/seller-context-route-unit.test.mjs:88`, `:121`, `:200`, `:723`, `:743`, `:754` | Positive reuse of the same presentation under another job, growth to three nonce rows on retries, and refusal decision-log assertions no longer apply. Each new presentation needs its own challenge; cached retries add zero rows; refused ingress adds no log lines. All eight `w.refusals` assertions need rehosting review. | B1–B8, B13, B17–B19, B21–B28, B31–B35 |
| `test/seller-context-route.test.mjs:130–137`, `:511` | The policy-budget vector automatically approves two pre-payment Vet writes; D5 supersedes that expectation with two exact seller approvals, while retaining bounded admission. Plugin buyer preparation predates challenges; the TLS/retry vector assumes each received retry adds a nonce row. Obtain/save the challenge before signing and assert zero retry growth. Keep in-process/route comparisons as host oracles; kit requests use the authenticated route. | A2, A6; B4, B17, B22–B25; R2; D11/S-15 still owns buyer preparation |
| `test/devnet-buyer-access-prefixed.test.mjs:45–47`, `:127`, `:136–142` | The variable approval mode defaults to implicit app policy. Its open-access policy case expects two approved CompositeVerificationRecord CREATEs with zero exact approvals; D5 supersedes that expectation with two exact seller approvals for the held pre-payment Vet writes, using seller-owned state. The direct-provider vector at :127 and invocation counts at :141 remain host oracles; kit vectors use the authenticated route with an issued challenge. Preserve closed-access zero-effect assertions when rehosting. | A1, A2, A6; B22–B30; D12 host rehosting remains blocked |
| `test/seller-context-route-shutdown-resume.test.mjs:10` | Its plugin host uses the former buyer preparation and context switch. Rehost with the authenticated challenge flow and the kit's only context mode; retain the shutdown/resume assertions. The first missing input is still `test/helpers/shutdown-clock.mjs`. | B14, B16, B20; R2 (full host remains D12) |
| `test/seller-policy-delivery-evidence.test.mjs:45`, `:59`, `:109–114`, `:672–674`, `:978` | App-shaped purchase records and automatic pre-payment FinalityCommitmentRecord approval no longer apply; only-Listing manual approval is obsolete. Use seller-owned records and hold every pre-payment commitment/Vet for exact approval. The removed `admission.refused(...)` call must not be restored; refused traffic cannot grow the policy log. | A1, A3, A6; B1–B3, B13, B28 |
| `test/seller-policy-purchase-source.test.mjs:11`, `:173`, `:337`, `:341`, `:352` | `appPurchaseResolver` and `appHeldEvidenceJobs` were removed; default purchase source is seller, app configuration is refused, and switch-off cannot remove pre-payment holds. Split app/seller comparison vectors; use seller records and exact approval for pre-payment writes. | A1, A3; S1–S3 |
| `test/seller-policy-purchase-source-node2.test.mjs:12`, `:101` | The copied helper calls removed `appHeldEvidenceJobs(h.application.db)` and compares app and seller results. Keep the seller-owned session assertions; leave buyer-app database queries in the host harness. | A1, A3; S1 |
| `test/fee-approval-recovery-offline.test.mjs:34`, `:109` | The #59 copy selects in-process context and mocks removed `SELLER_CONTEXT_MODES`, throwing if the route is built. Rehost with the only supported authenticated route and issued challenges; preserve applicable fee/recovery assertions. The separately named #58 copy stays pinned. | B1–B3, B22–B30; R2 |
| `test/seller-policy-commit-on-signature.test.mjs:28–43`, `:61–86` | The implicit app-source policy approval of an early FinalityCommitmentRecord is superseded: seller-owned state is the only source and every pre-payment commitment needs exact approval. D5's per-write hold replaces #58's operator startup refusal for policy/seller plus commitment-on-signature; D12 must rehost the startup vector as reaching a held commitment with zero signing before approval. Retain manual completion and issued-write recovery assertions after exact approval. The missing operator host still blocks that integration check. | A1, A3, A6; R2 for focused unsigned-cut recovery; D12 host integration remains blocked |
| `test/helpers/seller-context-off-operator.mjs:1–8`, `:116` | This helper supplies the superseded switch-off/in-process comparison in seller-context-route.test.mjs. Keep it only as a host oracle; kit vectors need the only authenticated route and a seller-issued challenge. It is not an app-state-only fixture. | B22–B30; R2 |

Additional policy rehosting checks: `test/closed-access-paid-recovery.test.mjs:42`, `:83`, `:92` uses #58's implicit app-source operator policy. Preserve the held-then-manual recovery outcome, replace the source with seller-owned records, and recheck the asserted `policyReason === 'purchase'` against those records and the closed-access rule. That exact reason is not verified by D5's focused tests. `test/seller-policy-journal-freshness.test.mjs:30–31` and `test/seller-policy-reservation-restart.test.mjs:93–94` put source selection in the separate policy object and explicitly select seller; preserve their journal/reservation assertions during D12 rehosting. No source-policy change is inferred from their settings object alone. `test/closed-access-boundaries.test.mjs:45–47` also defaults a variable mode to implicit app policy, but its policy assertions are refusal-only and agree with D5; replace the source wiring with seller records and preserve those zero-effect checks.

Non-pass Vet handling is also replaced: a strictly authenticated CVR whose overall decision is not pass returns a definite `party_vet_non_pass` answer with `errorClass` and keeps admission counted. Rehosting must preserve this rule, including recovery; treating authenticated non-pass as context success or no-effect release is obsolete. No copied test currently provides a valid substitute for VPC4/B21/B31/B35. The fault class is `counterparty` for fail, `permanent` for exhausted error/indeterminate. The shared SDK mapper covers the solely counterparty-malformed-presentation exception. This profile admits a parsed single Demos claim before Vet, runs no credential parser (`attempts: []`), and therefore cannot infer that exception from a signed CVR or its text. General parser-cause provenance remains outside this profile; no broader qualification is claimed.

The mechanical scan in `scripts/superseded-tests.mjs` compares frozen exports with current exports and scans every copied test/helper for removed names, `DACS_SELLER_CONTEXT`, app source selection, `application.db`, simple sellerApproval objects without a local explicit seller source (including variable-valued modes), and approval assertions in files naming FinalityCommitmentRecord, PartyVet or CompositeVerificationRecord. Artifact names and assertions may be on separate lines; these are review candidates requiring semantic reading. Every candidate has a reviewed disposition; an unclassified new candidate fails the check. Database references used only by the buyer/host harness are flagged separately for D12; they are not seller policy inputs. The generated scan supplements this semantic table, including the pre-payment expectations that require source reading.

Executable evidence is wired through test/seller/standalone.test.ts and npm run seller:test, including party-vet-store.test.mjs (seven tests). T1–T23 cover retention, canonical direct-store admission, capacity, indexed cleanup and issuance exhaustion; B38–B41 cover signed malformed job IDs, presentedAt independence, direct route/client admission and canonical cross-job nonce consumption. The current native selection also exercises bilateral Vet authority, exact CREATE policy content guards, native deployment/nonce recovery, public delivery and settlement/lifecycle gates. The remaining copied entrypoints require missing host imports and are not counted as executed coverage. Sessionless retention, zero-start hourly issuance and host policy-ledger coordination remain open as described in ADMISSION.md.

<!-- BEGIN COPIED-TEST SCAN: scripts/superseded-tests.mjs -->
Removed exports: `SELLER_CONTEXT_MODES`, `appHeldEvidenceJobs`, `appPurchaseResolver`.

| Copied file | Mechanically located signals | Reviewed disposition |
| --- | --- | --- |
| `test/closed-access-boundaries.test.mjs` | app harness state at 111, 206; seller approval without local seller source at 47 | D12: replace variable-mode implicit app policy wiring with seller records; preserve the refusal-only policy assertions and zero-effect closed-access checks. No automatic pre-payment approval is asserted here. |
| `test/closed-access-paid-recovery.test.mjs` | app harness state at 22; seller approval without local seller source at 42, 92 | D12: keep held-then-manual recovery; replace implicit app policy wiring with seller records and recheck the purchase policyReason at line 83. See the semantic note above. |
| `test/devnet-buyer-access-prefixed.test.mjs` | app harness state at 101; seller approval without local seller source at 47; pre-payment policy approval assertion at 140 | Superseded expectations: see the semantic table above; rehost against D5. |
| `test/devnet-operator-seller-tls.test.mjs` | app harness state at 179 | D12 host/comparison fixture: recheck buyer harness state and policy assertions when rehosting. |
| `test/fee-approval-recovery-offline.test.mjs` | removed export at 109; context switch at 33, 34, 108 | Superseded expectations: see the semantic table above; rehost against D5. |
| `test/helpers/seller-context-fixture.mjs` | context switch at 1 | Superseded expectations: see the semantic table above; rehost against D5. |
| `test/helpers/seller-context-off-operator.mjs` | context switch at 2 | Superseded expectations: see the semantic table above; rehost against D5. |
| `test/helpers/seller-context-off-scenario.mjs` | context switch at 1 | Superseded expectations: see the semantic table above; rehost against D5. |
| `test/ops-health.test.mjs` | seller approval without local seller source at 107, 113, 114, 115, 129, 560, 563, 567, 689 | Excluded plugin-only operations/hosting test; no kit behavior is claimed. |
| `test/seller-context-route-shutdown-resume.test.mjs` | context switch at 10, 42; app harness state at 74, 98, 99, 105 | Superseded expectations: see the semantic table above; rehost against D5. |
| `test/seller-context-route-unit.test.mjs` | context switch at 1; seller approval without local seller source at 786, 856, 1041 | Superseded expectations: see the semantic table above; rehost against D5. |
| `test/seller-context-route.test.mjs` | context switch at 1, 33, 34, 35; app harness state at 247, 327, 415, 521; seller approval without local seller source at 131, 264, 268, 271; pre-payment policy approval assertion at 137 | Superseded expectations: see the semantic table above; rehost against D5. |
| `test/seller-policy-commit-on-signature.test.mjs` | app harness state at 91, 93; seller approval without local seller source at 30, 73; pre-payment policy approval assertion at 82 | Superseded expectations: see the semantic table above; rehost against D5. |
| `test/seller-policy-delivery-evidence.test.mjs` | context switch at 679, 924; app harness state at 204, 690, 727; seller approval without local seller source at 47, 253, 443, 672, 732; pre-payment policy approval assertion at 568 | Superseded expectations: see the semantic table above; rehost against D5. |
| `test/seller-policy-journal-freshness.test.mjs` | seller approval without local seller source at 30 | D12: policy.purchaseSource explicitly selects seller at line 31; preserve journal freshness assertions when rehosting. The settings object alone does not select app state. |
| `test/seller-policy-purchase-source-node2.test.mjs` | removed export at 12, 101; app harness state at 101, 110, 165, 415; seller approval without local seller source at 184, 201, 438, 449 | Superseded expectations: see the semantic table above; rehost against D5. |
| `test/seller-policy-purchase-source.test.mjs` | removed export at 11, 112, 328, 330; app source at 341, 574; seller approval without local seller source at 114, 344, 759 | Superseded expectations: see the semantic table above; rehost against D5. |
| `test/seller-policy-reservation-restart.test.mjs` | seller approval without local seller source at 93 | D12: policy.purchaseSource explicitly selects seller at line 94; preserve reservation/restart assertions when rehosting. The settings object alone does not select app state. |
| `test/server-hosting.test.mjs` | seller approval without local seller source at 21, 137 | Excluded plugin-only operations/hosting test; no kit behavior is claimed. |
<!-- END COPIED-TEST SCAN -->
