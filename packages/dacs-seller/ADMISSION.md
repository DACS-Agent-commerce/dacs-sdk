The governing input is [PROFILE.json](PROFILE.json), pinned to DACS-Standard
`d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20`. Historical planning notes,
proposed register entries and workstream names below are port history only.
They grant no exception to the Standard. This experimental package has no
qualified live deployment; unsupported qualification stays blocked.

# D5 admission

The kit has one purchase source: the seller agent's durable sessions. It has
one Vet/context mode: the authenticated context route. There is no app database
resolver or context switch. The standalone host (README.md) does not mount the
context route; a host that mounts it must wire these modules as described here,
including the open items below.

A signed context request proves who asked and binds the job, Listing, bundle,
terms and request bytes. It does not prove that a buyer has not cancelled its
purchase elsewhere. D5 therefore retains #58's exact seller approval for every
pre-payment write. #59's admission reserves capacity; it is not signing authority.

| Request kind / condition | Decision and authority | Why | Test |
| --- | --- | --- | --- |
| App purchase-source configuration | Refused | The kit has only seller-owned state | d5-admission.test.mjs A1 |
| Fresh authenticated context, seller-issued challenge, exact scope, access and limits satisfied | Admit the context and reserve at most two Vet writes; each write stays held for exact seller approval | A transport signature authorizes this bounded request, while seller records cannot establish buyer-side cancellation | d5-admission.test.mjs A2; d5-limits-before-effects.test.mjs B1–B5 |
| Authenticated context challenge request | May write one bounded challenge record; never a Vet or sign-authorization record | Seller-generated challenge binds job, buyer, seller, Listing and exact scope before the bundle is presented | d5-limits-before-effects.test.mjs B22–B25, B27–B28, B30 |
| Pre-payment commitment with an open seller record | Held for exact seller approval | The authenticated proposal does not establish cancellation state | d5-admission.test.mjs A3 |
| Paid-job evidence or Deliverable, exact bytes, bindings and policy budgets satisfied | May authorize one bounded automatic write; sync its sign-authorization record before returning approval | Seller-owned payment intake established the paid fact | d5-admission.test.mjs A4, A8 |
| Malformed CREATE, wrong local binding, closed pre-payment job, excessive pre-payment debit | Refused; no manual fallback | These fail validation independently of cancellation uncertainty | d5-admission.test.mjs A5 |
| Listing, or any write in manual mode | Held for exact seller approval | Publication and manual mode confer no automatic authority | d5-admission.test.mjs A6 (Listing, Vet and Deliverable in manual mode) |
| Paid-job policy refusal | Held for exact seller approval, with exact confirmation | Retain paid state and allow the seller to complete it | d5-admission.test.mjs A7 |
| Known request/effect, including uncertain work | Cached answer or readback only; a shutdown cut may resume only with proven unsigned absence and a new bounded hold | Retries confer no new start authority; unknown issuance stays counted | d5-limits-before-effects.test.mjs B4; d5-admission.test.mjs A4, A8; d5-limits-before-effects.test.mjs B14; d5-limits-before-effects.test.mjs B20; d5-recovery.test.mjs R2 (real provider/SDK, separate processes; host harness pending D12) |
| Fresh context at the buyer, global or journal capacity limit | Refused after required nonce consumption, before a hold, decision-log line, new effect or provider call | Bound unpaid traffic before effects | d5-limits-before-effects.test.mjs B1–B3, B5–B6, B17–B19, B26, B36; d5-challenge-retention.test.mjs T10–T13, T17–T18 |
| Fresh context or challenge for a terminal seller session, including a different buyer after cleanup | Refused with context_session_terminal before mutation or a provider call | Terminal state is authoritative by job and survives transport cleanup | d5-challenge-retention.test.mjs T11, T19 |
| Fresh Agreement job at the retained job limit | Refused with peer_job_capacity before mutation unless enough unused bindings can be reclaimed | Real effects keep their bindings; definite no-effect completion frees unused bindings | d5-challenge-retention.test.mjs T7–T9, T15–T17, T20 |
| A valid but non-pass Vet record | Definite refusal with decision, evaluated role and VPC-4 errorClass, initially and on recovery; admission stays counted | Authenticity does not establish a passing Vet decision | d5-vet-decisions.test.mjs VPC4 (nine decision/control cases plus the shared mapper case); d5-limits-before-effects.test.mjs B21, B31, B35 |
| Seller-side requirement | Only the profile's explicit empty requirement is supported; request-supplied seller requirements are refused | The Listing's buyer requirements must never be substituted for the independent seller requirement | d5-vet-decisions.test.mjs VPC2; d5-limits-before-effects.test.mjs B7 |
| Invalid identity/scope/time/authentication, including multiple claims | Refused before an effect or provider call; an issued challenge is consumed on an attempted presentation | This profile admits one authenticated Demos claim | d5-limits-before-effects.test.mjs B7–B8 |
| Authenticated or unauthenticated traffic over byte, rate, concurrency or body-time limits | Refused before authentication, journaling or provider work | Bound resource use even when no peer identity is available | d5-limits-before-effects.test.mjs B9–B13 |

The default ingress limits remain 64 KiB per body, 4 KiB per authentication
header, 120 requests per minute, eight concurrent requests and a five-second
body read. Authenticated responses are capped at 512 KiB. Context starts are
limited to five per buyer and twelve globally per rolling hour; only accepted
starts count, durably, including after restart. A start exactly one hour old is
outside that window. New work needs generatedAt within ten minutes inclusive.
The transport journal holds at most 10,000 live nonce records and, independently, 10,000 Agreement job rows (nonce records use maxRecords; Agreement job rows use maxJobs, supplied independently by the host); new jobs at that total cap are refused before mutation. A definite no-effect completion releases its job binding only when no effect, slot, transaction or context admission still refers to it. Effect-to-job records also protect pending read effects; completed or uncertain effects keep their bindings. Existing empty bindings are reclaimed on a successful new reservation at capacity. T7–T9 and T15–T16 cover another buyer, restart, retained refusals and concurrent references. The cap remains a backstop for real retained work: at capacity new jobs return peer_job_capacity (503). D12 must reconcile that work and provide a verified terminal archive/rotation procedure under the seller-state lock; deleting the journal to restore capacity is not a supported recovery procedure. Nonce rate-retention rows cover the full minute, with at most 120 new rows per buyer per minute. Cached-effect retries and unknown-job state reads insert no rows. Expired completed/no-effect nonce rows are reclaimed before admitting new work; the effect answer remains durable. Legacy rows retain a conservative one-minute grace on upgrade. Pending or uncertain effects remain fenced and require reconciliation, rather than expiry into repeat authority. Policy defaults remain
six writes per job, 24 writes and 96 DEM per hour, and 4 DEM per write. Unresolved
writes count beyond the hour until completed. Configuration may lower or raise
the PR-defined configurable limits; it cannot disable their validation.

Direct context-store reservations and classifications require a canonical body scope job matching the authenticated envelope before hashing, journal access or admission. Retained-effect retries obey the same check. T24–T25 cover malformed, missing and mismatched body jobs, valid controls and restart.

Admission checks start counts after required nonce consumption and before any policy hold or new effect, then
rechecks them in the transport's reserve transaction. One route serializes all
new starts across jobs. The seller's process-lifetime state lock is required
when D12 opens these journals. Refused fresh traffic leaves no decision-log
line; otherwise a flood could grow the log despite a start-count refusal.
Accepted holds and exact write decisions remain durable. Reconciliation of a
present context releases all unused context holds for that job. The hold's
effect field is informational; holdId and jobId select release/conversion.

The pre-payment hold remains an explicit product limitation, including for
closed-access custody buyers. Authentication alone never removes it. The
in-process comparison in the frozen tests is a test oracle, not a kit mode.

This experimental API supports an explicit empty seller requirement only.
It does not claim an accepted TP-1 or G10 profile. No unpublished register
entry is needed to interpret this local restriction, and no protocol exception
is authorized by it. A buyer-owned verifier must issue the session challenge
and sign the seller CVR; without that capability, context creation is refused.
Buyer-side seller requirements are not a capability of this route: an extra
request scope field is refused. The seller is evaluated against that empty
requirement, independently of the Listing's buyer requirement, during initial
production, durable retention and recovery. Distinct non-empty Listing buyer
requirements are tested against this separate empty seller requirement.


Challenge protocol: POST the context scope without `buyerBundleHash` to
`/dacs/v1/agreements/context/challenge`, using the authenticated transport and
its scope hash. The signed response contains `sessionNonce` (256 random bits
in lowercase hex) and `expiresAt` (one minute). Copy that nonce into the buyer
bundle before producing its presentation, then hash the bundle and send the
normal context scope. Issuance is limited to five per buyer and twelve globally
per rolling hour by default, and is also subject to unpaid-start limits. An
identical outstanding issuance request reads the same challenge. Consumption commits on every authenticated presentation attempt carrying
an issued nonce, before access, job, capacity, scope, expiry or proof checks.
A different presenter consumes the recognized nonce and is refused. Only a
read of an exact retained effect bypasses consumption. Non-string or
non-canonical nonce values are refused before lookup. The anti-replay UPDATE
is required even when admission refuses; holds, provider calls and new effects
remain absent on refusal. Buyer-owned seller challenges use a separate durable
ledger and the exact accepted seller presentation is retained per job.

There is a remaining policy-ledger race: another route can consume journal
capacity between the dry admission check and the real reservation. A final
refusal then leaves one hold and one release line, with no provider call or
transport effect. B29 executes that conflict. Cross-ledger atomicity is not
established; the SDK maintainer must resolve it with D12's host composition and decision-log
contract. This P3 remains open.


Challenge retention has an independent total capacity, `maxChallenges`, defaulting to `maxRecords` (10,000). A new issuance at capacity returns `context_challenge_capacity` (503) before any mutation, policy hold or provider call; identical outstanding requests still read the retained challenge. Reclamation is part of successful issuance, after all limits and unpaid-start checks. It deletes only expired rows outside the full one-hour issuance window whose bound session is in an exact DACS-5 terminal state: finalised, vet-failed, negotiate-failed, commit-failed, settle-failed, aborted-by-self, aborted-by-other or failed-substrate. Consumption or expiry alone is insufficient. This retains CORE §B.8 SN-4 state through session termination and preserves hourly counters. Cleanup inspects terminal states only when space is needed and stops once enough rows are reclaimable. T1–T6 and T14 test limits, terminal/non-terminal states, restart, replay, zero-mutation refusals and early scan termination.

D12 must supply `contextSessionState({jobId})` to the transport store as a synchronous read of trusted seller-owned durable session state, retaining that source through cleanup and refusing new work for terminal sessions regardless of the requesting buyer. The callback is job-scoped: a terminal job must return its terminal state for every requester; buyer-filtered lookup is not this contract. T19 verifies a different buyer is refused after cleanup and restart. Unknown state cannot authorize cleanup. It must not use a buyer assertion, an unpaid-start timestamp, a missing record or a delivery stage as terminal proof. Without that callback, unknown state conservatively retains every challenge and capacity eventually refuses new issuance. No terminal state is inferred from timeout. Even with a wired reader, sessionless challenges are a lifetime allocation: expiry without a seller session never establishes terminal proof. Once their total reaches maxChallenges, new issuance stops. the SDK maintainer must decide whether expired, unpresented challenges for jobs with no session may end SN-4 retention, and D12 must supply a reviewed recovery procedure. The scan is bounded by the retained table and stops when enough terminal rows free capacity. D12 host lifecycle wiring remains unchecked here.

VPC-4 answers carry `errorClass`: fail maps to counterparty; exhausted error or indeterminate maps to permanent. The SDK mapper supplies the solely counterparty-malformed-presentation exception; this parsed single-claim profile has no credential parser and does not infer that cause from CVR text. The client treats missing/unknown classes as indeterminate. VPC4 and B21/B31/B35 cover initial, retained, recovered and consumed answers, plus pass and unknown-decision controls.

The default twelve challenges can exhaust the global hourly allowance with zero accepted starts. No policy hold is recorded for such issuance. A fourth buyer after a 5/5/2 issuance pattern waits until the hourly window moves, even though the challenges expire after one minute. T23 in d5-challenge-retention.test.mjs pins this behavior. A separate issuance allowance or outstanding-challenge policy requires D12 host qualification; this profile uses the five/twelve defaults.

Retained context starts have an independent total cap, `maxContextRecords`, defaulting to `maxRecords` (10,000). Each admitted start owns one context effect, effect-to-job row and slot; all four collections stay within that cap for context traffic. `peer_context_capacity` (503) refuses fresh starts before any policy hold or new journal effect; a recognized presentation nonce is consumed on attempt. New challenge issuance refuses before SQL mutation; retained retries still read their answers. Successful new context reservation may reclaim an old admission, its completed effect, slot, effect-to-job row and expired nonce/rate rows only after the full hourly start window, the nonce rate window, expiry of every associated transport request and trusted terminal seller-session evidence. Pending/uncertain effects and unknown/non-terminal sessions stay fenced. A fresh context effect for a terminal session is refused, including after cleanup and restart. T10–T13 and B36 test these rules, counts, restart, replay and zero-mutation refusals. D12 must retain authoritative terminal state after transport cleanup; missing state eventually fills the cap and remains a stated block, rather than permission to repeat work.

Capacity lookup work is bounded by retained rows with indexed effect/job references. Opening an existing store creates indexes on peer_effect_jobs(job), peer_transactions(job) and peer_nonces(effect). Job reclamation checks legacy unmapped effects once, then selects only the needed unused jobs through indexed anti-joins, including an indexed slot-prefix check. Context reclamation runs only when capacity needs space and stops after enough trusted terminal contexts; below capacity it reads no old sessions. At a full context cap with no terminal sessions it may inspect every retained context once; D12 must supply a bounded synchronous job-state lookup. T17–T18 verify 10,000-row query plans, constant SQL statement counts, early stopping and zero-mutation refusal; T20 keeps legacy reference fences. These focused bounds do not qualify the missing public host.

Standalone validation is available through `npm run seller:test` and the stock
SDK `npm test` command. The entry point runs the isolated D5 files, bilateral
Vet authority and receipt checks, exact-byte HTTP admission, native nonce and
deployment qualification checks, durable settlement collisions.

Native publication requires `pins.deployment` at the supported node source commit
`61b8e75aa8db5e408c49e1c3a89db4d673f45578` (the fee, nonce, broadcast and
confirmation profile in deployment-qualification.mjs), a clean build marker,
an artifact SHA-256, and qualification of fee, nonce, broadcast and confirmation
operations. The trusted source capability must independently
verify that exact pin through `verifyDeployment`. No live artifact is currently
supplied by this package; absent or dirty deployment evidence refuses before
intent creation or a wallet request.

Native CREATE preparation requires the source capability's
`withWalletNonceLock({owner, network, chainIdentity}, work)`. The source must hold
one durable atomic lane across nonce reads, reservations and wallet outcomes for
**every** writer of that wallet, including writers with separate journals. A
source without this capability refuses new CREATEs with `nonce_lane_unavailable`.
This package supplies no wallet nonce lane and no deployment qualification
for this contract; the operator's wallet must. Retained recovery rechecks deployment
qualification and permits at most one unchanged resend per original transaction;
an uncertain resend remains held for authenticated readback.
Definitively rejected CREATEs remain rejected during retained reads and retries,
including after restart, and are never resent. Their nonce may be used by a
different artifact. Retained observations share the publication lock so they
preserve the latest wallet outcome.

Automatic pay-DEM evidence approval requires `policy.paymentPhaseIndex()` to
return `protocolSupport(listing).phases.payment` from the host's verified
Listing. The policy uses that index in the evidence address and refuses
automatic approval when the callback or its canonical nonnegative integer
result is missing. A9 tests a non-default phase and malformed/missing indices.
The seller currently serves public Deliverables only; createSellerAgent refuses
other access models locally before any publication.

Canonical job IDs are checked at the transport envelope, direct challenge and
journal entries, context route/client, and party-Vet provider before hashing or
protocol callbacks. T21–T22 and B38/B40 cover malformed aliases, case, length,
range and types; B41 preserves consumption for a canonical cross-job attempt.
B39 verifies that old or future bundle presentedAt values do not gate admission.
B42–B43 cover malformed job IDs in signed request bodies and definite client
refusal attribution. Native boundary vectors also cover report production,
delivery reads and address-only retained reads before hashing or callbacks.
