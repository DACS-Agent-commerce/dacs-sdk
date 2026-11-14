# @kynesyslabs/dacs-client

JavaScript ESM services for experimental host integrations and read-only diagnostics of retained DACS testnet operations using their original chain/RPC. This private package candidate is outside the repository's three-package release set. It is not a registry installation or a purchase-capable release. TypeScript, browser, public remote-seller transport and full agreement-capability transport integrations are outside this candidate's supported surface.

Use the SDK workspace after `npm ci` and `npm run build`, or install paired local artifacts into a JavaScript ESM application:

```sh
npm ci
npm run build
mkdir -p /tmp/dacs-artifacts
npm pack --ignore-scripts --pack-destination /tmp/dacs-artifacts
npm pack --workspace @kynesyslabs/dacs-client --pack-destination /tmp/dacs-artifacts
npm pack --workspace @kynesyslabs/dacs-node --pack-destination /tmp/dacs-artifacts
npm install /tmp/dacs-artifacts/kynesyslabs-dacs-0.1.0-alpha.0.tgz /tmp/dacs-artifacts/kynesyslabs-dacs-client-0.1.0-alpha.0.tgz /tmp/dacs-artifacts/kynesyslabs-dacs-node-0.1.0-alpha.0.tgz
```

All three artifacts must come from the same reviewed SDK revision. Release-set admission requires coordinated artifact, lifecycle, SBOM and publication checks; `private: true` prevents publication until that happens.

Every public entry point requires Node ^22.22.2 or ^24.15.0. The root does not load SQLite during import. `@kynesyslabs/dacs-client/wallet/durable-journal` separately exports the durable wallet journal and its format/version constants. Source paths are private.

The client depends on `@kynesyslabs/dacs-node` (the exact same release), `@kynesyslabs/demosdk` (`^4.0.16`) and `@scure/bip39` (exact). The Node wallet session loads demosdk's websdk through an internal loading module that is not a package export and that the root import never reaches. It imports `@kynesyslabs/dacs-node/demos-loader`, which registers the SDK's package-scoped resolver for demosdk's one extensionless directory import, and then registers a reviewed load transform. The transform removes demosdk's own diagnostic output on the signing paths by replacing only these statements with an empty statement on the same line: GCRGeneration.js lines 173, 246, 249, 250 and demosclass.js lines 719, 1547 (demosdk 4.0.16), or GCRGeneration.js lines 178, 302, 305, 306 and demosclass.js lines 738, 1775, 1781 (demosdk 4.0.18). It first checks the source's SHA-256 against a reviewed table, then each listed line against its recorded text, then the output's SHA-256 against its recorded digest, and refuses any other source shape with `node_wallet_sdk_unreviewed`. Nothing assigns `console`, `process.stdout` or `process.stderr`. Host rule: build the composition before any other import of `@kynesyslabs/demosdk/websdk` in the process; a module imported earlier never passes through the transform, so loading refuses `node_wallet_sdk_preloaded`.

`createProtocolPurchases`, `createPurchaseService` and `createListingVerifier` require `admission: { binding, currentLocal }`: `binding` is the result of `bindTp1Profile` from `@kynesyslabs/dacs/wire` in the host composition, and `currentLocal` is a synchronous function returning the actor's current `{ endpoint, transportAuthority, connectionId }`. Construction throws `TypeError('admission_required')` without exactly those two members, `TypeError('admission_input_untrusted')` for a `profile`, `record`, `identityRecord` or `actionsAdmitted` option, and `OperationError('runtime_unsupported')` outside Node ^22.22.2 || ^24.15.0, all before any component is built. Every method except the passive readers returns a Promise. While the one hold constant is `held` it rejects `OperationError('profile_not_admitted')` before any binding read or effect; once admitted it rejects the same way, with the original error as `cause` (`tp1_authority_timeout` after 10,000 ms), unless the binding check passes and the hold and `currentLocal()` are unchanged, and only then runs the original once. The passive readers are the protocol's `assertBuyerAccess`, `supportsMode`, `readIssued`, `readIssuedPayment` and `observeReportedPayment`, and the service's `status`, `portalOperation`, `portalEvidence`, `verifyDeal` and `planRunning` (synchronous). While held, the service's readers return the diagnostic projection, chosen on each call. `actionsAdmitted` is a construction-time snapshot and never authorizes.

Portal entries require a nonempty primitive operation id (at most 256 characters) and handoff token (at most 1024). They authenticate the stored purchase capability before the host lookup or private reads: exact token bytes hashed as SHA-256 of `dacs-handoff-hash:` followed by the token, constant-time comparison with its lowercase hex hash, matching id/kind/owner, and a canonical `Date.toISOString()` lifetime later than both the business clock and internal wall clock. Both clocks must be valid nonnegative integer epoch milliseconds; the host may further refuse access.

Before constructing the service, migrate older databases with `ALTER TABLE operations ADD COLUMN handoff_expires_at TEXT` and provision explicit finite lifetimes. Missing columns produce `schema_migration_required`; null, malformed or past lifetimes grant no access, including links returned by status. Capability expiry is independent of approval `expires_at`.

Migrate evidence callers from `portalEvidence(operation)` to `portalEvidence(operationId, token)`. Evidence, status and public portal reads project approval expiry without writes. The protocol readback exception authenticates the same capability first. Purchase actions remain held.

Return fresh objects so projections cannot alter stored state. The host must derive each service call's `accountId` from its authenticated session, outside caller-controlled tool or request arguments. Public `status(accountId, operationId, token)` and `verifyDeal({ accountId, operationId, token, txHash? })` require the operation's unexpired handoff token as well as the owner id. Account and operation ids alone grant no access. Account lookups are checked against both the requested account and operation id before secondary reads. `portalOperation(operationId, token)` and `portalEvidence(operationId, token)` each authenticate through `ops.getByHandoff` on every call, before reading private coordinates. Both arguments must be nonempty strings (operation id at most 256 characters, token at most 1024); the returned operation must be a purchase with the requested id. Before consulting the host lookup, the package verifies the supplied token against the stored `operations.handoff_token_hash` with a constant-time SHA-256 comparison and checks the independent `handoff_expires_at` timestamp on every call. The hash is lowercase hex SHA-256 of `dacs-handoff-hash:` followed by the exact token (application wire contract pinned to `9d820e0:packages/dacs-client/test/helpers/purchase-integrity-operations.mjs:43` and the permanent capability vector). Store `handoff_expires_at` as canonical UTC ISO-8601 text produced by `Date.toISOString()` (for example, `2030-01-02T03:04:05.000Z`). SQLite `datetime()` text, epoch text, timezone offsets and local timestamps are refused. A missing, malformed or expired handoff lifetime refuses access. The optional `now()` clock must return a nonnegative safe integer in the JavaScript Date range, in epoch milliseconds; an invalid reading refuses access. Expiry uses the later of that reading and the internal wall clock, so a stale host clock cannot extend a capability. This expiry is separate from `expires_at`, which limits approval and may elapse while a diagnostic link remains valid. `portalEvidence` saves nothing: it reports an approval as `expired` once the `now()` clock or the wall clock has passed its expiry, without saving the transition. Approve and pay use `now()` alone, so with a stale `now()` they can still accept an approval that a read reports as `expired`. In the retained source service, `portalOperation` is also the entry for the portal's approval and payment actions, and saves that transition; the public diagnostic service only reports it. The returned owner must match the stored owner; the host lookup may further deny access. The retained protocol readback shortcut uses the same capability checks before its closed-wallet-access exception. Existing hosts must migrate `operations` to add the nullable `handoff_expires_at TEXT` column and provision explicit finite lifetimes before enabling portal reads; a null lifetime grants no access. Construction with the earlier schema throws `OperationError` with code `schema_migration_required` and identifies the missing column. Pass the id and token to evidence reads even when an earlier lookup returned an operation.

`openDurableWalletJournal({ path, mode, expectedJournalId?, lockTimeoutMs?, pollMs?, busyTimeoutMs?, maxRecords?, maxKeyBytes?, maxValueBytes?, maxTotalBytes? })` at `@kynesyslabs/dacs-client/wallet/durable-journal` requires an absolute caller-owned path and explicit `mode: 'create'` (absent file) or `'open'` (existing intact journal). It synchronously returns `{ journalId, instance, path, get, put, entries, withWalletLock, appendUnderLock, withOwnedOrAcquiredLane, inspectLocks, releaseAbandonedLock, close }`; get/put/entries/withWalletLock/appendUnderLock/withOwnedOrAcquiredLane are async. Records must be exact JSON; writes and lane locks persist in SQLite, and close refuses active lane work. `appendUnderLock(laneKey, key, value)` adds a record that does not exist yet while the caller holds the lane, in one transaction, and never overwrites or writes a key another holder has locked; `withOwnedOrAcquiredLane(laneKey, work)` reuses a lane the caller already holds, after checking that its lock row is still the caller's, or acquires it once.

A lane lock left by a process that crashed is taken over only when its holder is proven dead. Opening the journal takes this process's lease in a private `holders` directory beside the journal file, an exclusive SQLite lock the kernel frees when the process ends; each lock row records its holder's lease, PID namespace, boot and start. Each process that opens a journal leaves one empty lease file there, and that file is the proof its process exited, so nothing here removes it. A holder is `exited`, and its lock is replaced when the next process acquires the lane, only on the same boot and PID namespace with a free lease and the original process no longer running. Age, a timeout or a PID alone never prove death, so a live or stalled holder keeps the lane `journal-busy`, as does any lock nothing proves gone (written by an earlier version, from another boot, with no identity, or with an unreadable lease). `inspectLocks()` reports each lock's `holder` class, and `releaseAbandonedLock({ key, instance, fence })` stays the explicit repair for those, after you have established that the holder is gone. Taking over a lock changes no record, so an issued lane still refuses a second send. Where more than one lock is needed the order is: the connection fence, then the wallet lane, then the per-address claim and refusal keys.
The factory and operations throw/reject `DurableWalletJournalError` with a `code`: `journal-invalid` for invalid arguments/records, `journal-exists`/`journal-absent` for mode/path mismatch, `journal-integrity` for damaged or unexpected journal identity, `journal-capacity` for limits, `journal-busy` for contention/active work, and `journal-closed` for use after close. Lock operations can also report `journal-reentrant`, `journal-fenced`, `journal-lock-live`, or `journal-lock-mismatch`; `appendUnderLock` reports `journal-key-exists` for an existing key and `journal-fenced` when the lane is not held or the key is locked by another holder; `withOwnedOrAcquiredLane` reports `journal-fenced` when a retained lane context no longer owns its lock row; opening reports `journal-lease-unavailable` when the process lease cannot be taken; other SQLite failures use `journal-error` and preserve their cause. Reopen with `expectedJournalId` to bind the retained journal; never recreate an absent journal to resume a lane.

Delta records also check parent continuity against the newest ancestor records for each path, or the publication baseline when no earlier record exists. A later record cannot legitimize a stale merge, deletion or restoration. Divergent parallel records require an explicit record of the merge resolution; that choice then constrains descendant records.

## Public API

A plugin composes a purchase from the root names only. Each export's doc comment in `src/index.mjs` names what it returns and what it throws or rejects with; this section lists the factories' methods and the error contract.

The admission option: `admission: { binding, currentLocal }` is required by the three factories below.
- Construction throws `TypeError('admission_required')` without exactly those two members, `TypeError('admission_input_untrusted')` for a `profile`, `record`, `identityRecord` or `actionsAdmitted` option, and `OperationError('runtime_unsupported')` below the Node floor.
- An active method returns a Promise. It rejects `OperationError('profile_not_admitted')` while the hold constant is `held`, or when the binding check fails, with the original error as `cause` (`tp1_authority_timeout` after 10,000 ms). Otherwise it resolves to, or rejects with, the original action's own result or error.
- A passive method keeps its original signature and is never wrapped. `actionsAdmitted` is a construction-time snapshot and never authorizes.

### createProtocolPurchases

Active: `holdChainReadback`, `prepareTerms`, `assertSellerAdmission`, `identityRequest`, `planRequest`, `runningPlan`, `planRunning`, `planFlightsRunning`, `signRequest`, `submitAgreement`, `recheckCommitment`, `nativePaymentClaimed`, `nativePaymentTermsCancelled`, `nativePaymentRefused`, `cancelNativePayment`, `nativePaymentFailed`, `nativePaymentSuperseded`, `nativeIntentsSupersededBy`, `withNativePaymentLane`, `readNativePaymentLane`, `checkDelivery`, `recheck`, `countersignRequest`, `countersign`

`prepareTerms` does not return `terms.jobId`; the create path adds it.

Passive: `assertBuyerAccess`, `supportsMode`, `readIssued`, `readIssuedPayment`, `observeReportedPayment`

### createPurchaseService

Active: `prepare`, `issueApprovalChallenge`, `approve`, `prepareHandoff`, `nativePaymentLane`, `reportWalletResult`, `cancel`, `agreementIdentity`, `agreementPlan`, `agreementSubmit`, `completionRequest`, `completionCountersign`, `protocolRecheck`

Passive: `status`, `portalOperation`, `portalEvidence`, `verifyDeal`, `planRunning` (synchronous)

### createListingVerifier

Active: `verify`

Passive: none

### Other exports

- The capability constructors `createDemDeliveryContext`, `createNativeDemDeliveryCapability`, `createNativePaymentEvidenceConsumer`, `createSourceDemoSellerTransport` and `createDevnetNativeCommitmentCapability` return a frozen opaque capability and throw `TypeError` for a missing or malformed input. Their `TEST-` authority labels stay until the testnet authorities are wired.
- `purchaseNext`, `protocolView` and `PURCHASE_STATUS_HELP` read the hold constant on every call or read: historical held text while held, the full text once admitted.
- `OFFLINE_AGREEMENT_MODE` and `DEVNET_NATIVE_COMMITMENT_MARKER` are constants. `isOfflineWalletAgreement` returns a boolean; `deriveStorageAddress` returns text and throws `TypeError` for a non-text owner.
- Every other export states its own contract in its doc comment. Failures are the exported error classes (`OperationError`, `NotWiredError`, `OutboundError`, the seller and wallet errors), which keep their cause. No export hands out a fixture identity, a simulation header or an unqualified chain reader.

## Public Demos chain reader

`@kynesyslabs/dacs-client/substrate/demos` exports only `createDemosPublicChainReader({rpcUrl, network, pinnedIdentity, timeoutMs, fetchImpl})`. It accepts only `network: 'testnet'` with the 64-hex chain identity pinned for testnet, and otherwise throws `OperationError` `invalid_configuration`. It holds no key and cannot sign or send.

The returned frozen object has nine reads: `readStorageProgram`, `getAddressBalance`, `getTransactionFees`, `networkIdentity`, `getAddressNonce`, `observePurchaseTransfer`, `observeTransfer`, `getTransaction` and `findTransferAtNonce`. It also carries `network`, `pinnedIdentity`, `rpcOrigin`, `observer` and `evidenceMode`. Pass it unchanged as `chain` to `createPurchaseService` and `createListingVerifier` when no native Agreement transport is composed; with one, pass that transport's own `chainReader()` instead.

The first read checks the RPC's chain identity before its own request, and refuses a simulated or different chain with `OperationError` `network_identity_mismatch`. Later reads rely on a successful check, but a read whose answer is marked simulated throws the same error instead of returning it and the next read checks again; a failed check is not reused. Each read otherwise returns and throws what the client's internal reader does, and honours the caller's `signal` where it takes one. `observePurchaseTransfer` reports an included transfer as `{status: 'unavailable', reason: 'native source evidence unavailable from public reader'}`, because this reader keeps no signed native source; a native purchase read through it stays unresolved.

## Node wallet session

`@kynesyslabs/dacs-client/node-wallet` exports `createNodeTransportOwner`, `createRpcStampSource` and the asynchronous `createNodeWalletSession`. Construct the owner on a canonical HTTPS root and bind the SDK-approved TP-1 record to `owner.currentLocal()`. Pass `{admission: {binding, currentLocal: owner.currentLocal}, owner, journal, key, approve, clock}`; `key` is UTF-8 mnemonic bytes and is consumed and zero-filled on every outcome. Build the composition before any other import of demosdk.

The returned `wallet.request` is held until P35 (`profile_not_admitted`); purchase runtime is Node `^22.22.2 || ^24.15.0`. `getPublicAccount`, `getWriteProfile`, `isLocked` and `lock` remain passive. The synchronous `walletFactory({anchorJournal})` selects a journal for the same wallet identity; it exposes the same held request API. `close()` locks that wallet and closes its transport; the host closes its owner and journal. All SDK posts use the bounded native transport in process. Native broadcasts are never repeated after broadcast intent; restart reads back the original evidence. Durable pre-confirmation recovery and the final effect gate are prerequisites for lifting the hold.

Before the SDK's inner transaction signature, the session checks synchronously that the signed message is the transaction hash (or, once the node's `signatureDomain` fork is active, `demos-tx:v1:<decimal chain id>:` followed by it), that the hash is the SHA-256 of `JSON.stringify(content)`, and that the SDK's finalized content (amount, fees, edits, and the denomination the node reported at approval) is exactly what was approved, returned as two canonical OS amount strings; otherwise the request fails `payload_mismatch` and nothing is signed. The returned `internalCauseOf(envelope)` gives the host the error a failed request was closed over; its `cause` chain holds the original failure, which the public envelope never carries. `confirm_rejected` means only a validated `valid:false` answer; a malformed, non-200 or unavailable confirmation, or a `valid:true` answer this session cannot match to the approval, is `upstream_unavailable`, and nothing is broadcast after either.

## Seller transport composition

`createSourceDemoSellerTransport({authority, sessionSignerFor, sessionPolicyFor, endpointProofFor})` takes three functions of the purchase: the session signer `{claim, sign}`, the expiry policy `{expiresAt}` and the endpoint proof that the wire's `verifyEndpointProof` returned (verified with the buyer's own commitment receipt reader). The authority still needs a `TEST-` label.

`createSellerAgentClient({url, authentication, ...})` reaches a loopback endpoint, or, when it is given a wire authentication, a public HTTPS origin: `https://` and an authority, with no credentials, path prefix, query or fragment (the wire's `isPublicEndpoint`). Any other `url` throws before anything is signed or sent. Purchase actions are still refused while the release gate holds them.
Requests, delegation bytes and received response bytes go through `@kynesyslabs/dacs/wire` under the purchase's kept TP-1 profile. The client saves the delegation payload before it returns the wallet message, stores the wallet signature as canonical base64url, and refuses a purchase prepared under the old transport declaration with `seller_transport_changed`. The seller request timeout also bounds the wire's authority reads and the session signer: a seller call that has not finished signing by then sends nothing and fails with cause `timeout`, and a wallet message or delegation check that is still waiting for the authority fails with `seller_authority_timeout`.
Payment and bundle requests (the wire's continuing routes) and the two ordinary read routes (`agreements/state`, `bundles/buyer-copy`) of a committed purchase are signed with the job's finalized commitment, its two-party Agreement and the signed Listing, as canonical bytes rebuilt from the purchase row. The commitment's anchored tuple is kept with its SHA-256 when the commitment verifies. A verified row with no usable kept bytes keeps them once from a fresh authenticated readback that matches the stored summary, and otherwise nothing is signed (`commitment_unverified`). The proof's receipt reader authenticates the commitment at every signing, so these requests sign under a `ready: false` proof and after the Listing's window ends, with no continuation capability. Challenge, context, proposals and commitment requests carry no commitment evidence, and a read before commitment keeps the wire's live Listing checks. `bundles/buyer-copy` has no such read before commitment, so the wire refuses it without evidence.

### Seller answer classification

With an authentication adapter, each answer is verified on its exact received bytes, then classified by its HTTP status and `error` code, the route, and the request's provenance. The transport builds the record `{status, signed: true, body}` only after verification; an answer that fails verification is `unknown`. A `result` or `progress` answer is returned. Every other class throws: `definite` and `failed-bootstrap` as `SellerRefusedError` (`code` is the seller's code), the rest as `SellerUnavailableError` (`answerCode` is the seller's code). Both carry `answerClass`. Each seller route stores its exact request bytes under the purchase revision (`state.protocol.sellerRequests`) before the first send; the two read routes store nothing. An authenticated call with a stored attempt retries an unknown dispatch at most twice, 5 seconds apart, using the same bytes and fresh wire nonces. Legacy callers and unrecorded reads send once. One absolute deadline (15 seconds by default; context 240–300 seconds) includes storage, authority reads, signing and fetch; an exhausted budget signs and sends nothing further. Unknown outcomes remain unknown, and a later explicit call reuses stored bytes. Failures before dispatch clear only their own attempt; swallowed failures retain their bounded class and cause. Without an adapter (loopback fixtures only), answers are not classified: a 4xx other than 408 or 429 with an `error` code is `SellerRefusedError`, any other non-2xx answer is `SellerUnavailableError`, and a 2xx body is returned.

A verified `seller_stopped` answer (class `suspended`) and a re-hold seen while work is queued durably record `state.protocol.sellerSuspension: {id, cause, path, at}`. Retries and queued continuations stop, the outcome stays unknown and a dispatched payment is never marked failed. The record and the stored request bytes survive restart and every later save, and re-admission alone resumes nothing. `verifyDeal` keeps its readback and bookkeeping but does not continue a suspended purchase. The protocol view exposes the suspension. To resume, make a new explicit `protocolRecheck({operationId, token, resumeSuspensionId})` request with the suspension's `id`: it checks admission and buyer access again, then clears only the suspension it names, so an older request cannot clear a newer stop. Do not pay again.

| Answer | Class |
|---|---|
| signed 200 | `result`; on payments and proposals, `held`, `indeterminate`, `waiting`, or `payment-evidenced` with delivery pending, is `progress`, never final |
| 409 `peer_request_replayed`; 503 `seller_effect_pending`; 503 `context_attempt_pending`; 408 `peer_expired`; any other signed 408; a signed 429 on any route but context and challenge; any other signed 5xx; a signed 4xx with no `error` code; any other signed 2xx or 3xx; an answer that fails verification; a timeout | `unknown` |
| 503 `seller_stopped` | `suspended` |
| 503 `bundle_finalization_unavailable` and 422 `not_delivered` on the bundle routes | `held` |
| 503 `seller_not_ready` on a request the adapter's own records show to be new: the challenge or the context route, no capability, no accepted context, and no earlier attempt that may have been sent | `not-started` |
| 503 `seller_not_ready` on any other request | `unknown` |
| 409 `peer_operation_mismatch` | `definite` |
| 500 `seller_effect_unresolved` | `held`: needs the seller operator |
| 408 `peer_delegation_expired` | `readback-only` |
| 409 `context_challenge_failed`, `context_challenge_consumed`, `context_challenge_expired`, `context_challenge_mismatch`, `context_job_closed`, `context_admission_closed`; 429 on the context route | `failed-bootstrap` |
| 429 on the challenge route | `definite` |
| any other signed 4xx (not 408 or 429) with an `error` code | `definite` |
| a TLS failure before the request left | `not-sent` |

## Factory integration

Supply application inputs through host, including a synchronous operations-store factory. On a fresh database, apply the schema, construct the purchase store first, then prepare all statements (reads as well as writes). Existing databases need application-owned migrations preserving the schema constraints. Use the same connection for operation and coordinate writes.

```js
import { DatabaseSync } from 'node:sqlite';
import {
  PURCHASE_STATE_SCHEMA, createSqlitePurchaseStore, createCoordinateStore,
  createProtocolPurchases, createPurchaseService, createDeliveryDeadlineWatch,
} from '@kynesyslabs/dacs-client';

const db = new DatabaseSync(':memory:');
db.exec(PURCHASE_STATE_SCHEMA);
const store = createSqlitePurchaseStore();
const ops = host.createOperations(db);
const coordinates = createCoordinateStore({ db });
const protocol = createProtocolPurchases({
  db, ops, coordinates, store, dacsProtocol: host.dacsProtocol,
  buyerAccess: host.buyerAccess, admission: host.admission,
});
const purchases = createPurchaseService({
  db, ops, coordinates, store, protocol, config: host.config, admission: host.admission,
  accounts: host.accounts, verifier: host.verifier, chain: host.chain,
  challenges: host.challenges, purposes: { APPROVE_PURCHASE: 'purchase-approval' },
});
const watch = createDeliveryDeadlineWatch({ db, ops, coordinates, store, enabled: true });

store.transaction(db, () => {
  ops.transition(host.operation.id, host.operation.status, host.operation.status, {
    state: { hostNote: 'local bookkeeping' }, event: 'host_bookkeeping', data: {},
  });
  coordinates.save(host.coordinate);
});
const diagnostic = purchases.status(host.accountId, host.operation.id, host.token);
```

The synchronous `store.transaction` commits both writes or rolls both back on an error. Nested synchronous calls use savepoints. Keep transaction control, database configuration and schema changes outside callbacks; asynchronous callbacks and results refuse. Call diagnostics outside the transaction. This example records host bookkeeping and grants no purchase or settlement authority.

### Database admission

Use main and TEMP only; detach all other schemas before a package transaction. Admission is checked again on every transaction, before the callback. Persistent files require WAL with synchronous FULL or EXTRA, or a rollback journal with EXTRA. Configure foreign keys and a bounded busy timeout outside the transaction.

- `purchase_store_persistent_attachment`: a file-backed attachment is present.
- `purchase_store_unsupported_attachment`: another attachment, including an in-memory attachment, is present.
- `purchase_store_unsupported_journal_mode`: main has an unsupported journal mode, including OFF or a persistent MEMORY journal.
- `purchase_store_unsupported_synchronous`: a persistent main database lacks the required durability setting; SQLite defaults are insufficient.
- `purchase_store_unsupported_temp_journal_mode`: TEMP has an unsupported journal mode, including OFF.

### Schema

The required schema objects are supplied by `PURCHASE_STATE_SCHEMA`; the application owns initialization and migrations.

The `job_id` column of `operations` and its unique index `operations_job_id_unique` reserve each protocol purchase's job id when the host's `createIdempotent` writes it to `job_id`; keep both when extending the schema (purchases without a protocol job store NULL). `createPurchaseService` generates the id inside the create transaction and passes it to `createIdempotent` as jobId. Construction refuses with code schema_migration_required when `operations` has no `job_id` column or no unique index on `job_id` alone; a partial unique index does not count. The reservation also depends on the host's `createIdempotent` writing jobId to `job_id` in the same insert as the terms, which the package cannot check; it must throw an `OperationError` with code job_id_collision when the index refuses the id. The service then retries with a new id, at most 3 attempts, and otherwise fails with code job_id_unavailable having written nothing.

| Kind | Name |
| --- | --- |
| table | `accounts` |
| table | `challenges` |
| table | `operations` |
| table | `operation_events` |
| table | `approvals` |
| table | `write_coordinates` |
| table | `wallet_nonce_consumptions` |
| index | `operations_job_id_unique` |
| index | `operations_by_subject` |
| index | `operations_by_account` |
| index | `write_coordinates_by_sender` |
| index | `write_coordinates_verified_tx` |

### Chain reader

For legacy and native purchases alike, provide `network`, `pinnedIdentity`, `networkIdentity` and `observePassiveTransfer`. Network identity resolves the configured identity and mode. The passive reader observes the saved hash without journal reconciliation. Missing or noncallable passive readers produce unavailable readback. It returns one object with these primitive fields:

| Field | Presence | Contract |
| --- | --- | --- |
| `status` | always | `included`, `pending`, `not-found`, `failed`, `invalid` or `unavailable` |
| `reason` | optional | text of at most 240 characters |
| `txHash` | included | the requested hash: 64 hex characters, with an optional `0x` prefix |
| `payer` | included | readable Demos address of at most 66 characters |
| `payee` | included | readable Demos address of at most 66 characters |
| `amountOs` | included | text matching `OS_INTEGER`: canonical decimal integer in OS units, at most 78 digits |
| `blockNumber` | included | nonnegative safe integer; an observation without it is malformed |
| `includedAt` | optional | for included observations, integer epoch milliseconds from 0 to 8640000000000000 |
| `sourceDisposition` | optional | exactly `included` or `failed` |

The fields marked included are required when status is included; other statuses need no transfer fields. Omitted or undefined optional fields are absent. Unknown fields are ignored. Any other shape yields `status` `malformed` with a `reason`. `termsMatch` compares payer, payee and amount; it is null unless the observation is included with no `sourceDisposition` or with `included`. Repeated readback leaves operation and coordinate state unchanged and cannot establish settlement.

### Operations

`ops` is synchronous, returns fresh hydrated operations, preserves original errors and uses the same database connection. Diagnostics use only `get`, `getByHandoff` and `history`. The additional `transition` method is used only by `watch.observe`; it must compare the saved status and atomically update state and append its event, refusing a stale status.

### Diagnostics

The public diagnostics are `status`, `portalOperation`, `portalEvidence` and `verifyDeal`. They authenticate the operation's handoff capability on every call, project elapsed approval windows without saving a transition, and return historical state or non-authoritative observations. Readback uses only the saved transaction hash. It cannot authorize payment, settlement or delivery.

### Protocol

The protocol pass-through methods are exactly `assertBuyerAccess`, `supportsMode`, `readIssued`, `readIssuedPayment` and `observeReportedPayment`. Methods outside this list refuse with `profile_not_admitted` before host effects. No caller option lifts the action hold.

### Writers

The writer list is exactly `watch.observe`: host bookkeeping that cannot establish settlement. It can record a host's not-present delivery observation against an already verified payment; the saved status stays unchanged.

### Validation

Run `npm test --workspace @kynesyslabs/dacs-client` after building the SDK.
