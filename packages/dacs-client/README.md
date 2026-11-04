# @kynesyslabs/dacs-client

JavaScript ESM services for experimental host integrations and read-only diagnostics of retained DACS testnet operations using their original chain/RPC. This private package candidate is outside the repository's three-package release set. It is not a registry installation or a purchase-capable release. TypeScript, browser, wallet-session, public remote-seller transport and full agreement-capability transport integrations are outside this candidate's supported surface.

Use the SDK workspace after `npm ci` and `npm run build`, or install paired local artifacts into a JavaScript ESM application:

```sh
npm ci
npm run build
mkdir -p /tmp/dacs-artifacts
npm pack --ignore-scripts --pack-destination /tmp/dacs-artifacts
npm pack --workspace @kynesyslabs/dacs-client --pack-destination /tmp/dacs-artifacts
npm install /tmp/dacs-artifacts/kynesyslabs-dacs-0.1.0-alpha.0.tgz /tmp/dacs-artifacts/kynesyslabs-dacs-client-0.1.0-alpha.0.tgz
```

Both artifacts must come from the same reviewed SDK revision. Release-set admission requires coordinated artifact, lifecycle, SBOM and publication checks; `private: true` prevents publication until that happens.

Both public entry points require Node ^22.13.0 or >=23.4.0. The root does not load SQLite during import. `@kynesyslabs/dacs-client/wallet/durable-journal` separately exports the durable wallet journal and its format/version constants. Source paths are private.

`createProtocolPurchases`, `createPurchaseService` and `createListingVerifier` require `admission: { binding, currentLocal }`: `binding` is the result of `bindTp1Profile` from `@kynesyslabs/dacs/wire` in the host composition, and `currentLocal` is a synchronous function returning the actor's current `{ endpoint, transportAuthority, connectionId }`. Construction throws `TypeError('admission_required')` without exactly those two members, `TypeError('admission_input_untrusted')` for a `profile`, `record`, `identityRecord` or `actionsAdmitted` option, and `OperationError('runtime_unsupported')` below Node 22.13 (23.0 to 23.3 included), all before any component is built. Every method except the passive readers returns a Promise. While the one hold constant is `held` it rejects `OperationError('profile_not_admitted')` before any binding read or effect; once admitted it rejects the same way, with the original error as `cause` (`tp1_authority_timeout` after 10,000 ms), unless the binding check passes and the hold and `currentLocal()` are unchanged, and only then runs the original once. The passive readers are the protocol's `assertBuyerAccess`, `supportsMode`, `readIssued`, `readIssuedPayment` and `observeReportedPayment`, and the service's `status`, `portalOperation`, `portalEvidence`, `verifyDeal` and `planRunning` (synchronous). While held, the service's readers return the diagnostic projection, chosen on each call. `actionsAdmitted` is a construction-time snapshot and never authorizes.

Portal entries require a nonempty primitive operation id (at most 256 characters) and handoff token (at most 1024). They authenticate the stored purchase capability before the host lookup or private reads: exact token bytes hashed as SHA-256 of `dacs-handoff-hash:` followed by the token, constant-time comparison with its lowercase hex hash, matching id/kind/owner, and a canonical `Date.toISOString()` lifetime later than both the business clock and internal wall clock. Both clocks must be valid nonnegative integer epoch milliseconds; the host may further refuse access.

Before constructing the service, migrate older databases with `ALTER TABLE operations ADD COLUMN handoff_expires_at TEXT` and provision explicit finite lifetimes. Missing columns produce `schema_migration_required`; null, malformed or past lifetimes grant no access, including links returned by status. Capability expiry is independent of approval `expires_at`.

Migrate evidence callers from `portalEvidence(operation)` to `portalEvidence(operationId, token)`. Evidence, status and public portal reads project approval expiry without writes. The protocol readback exception authenticates the same capability first. Purchase actions remain held.

Return fresh objects so projections cannot alter stored state. The host must derive each service call's `accountId` from its authenticated session, outside caller-controlled tool or request arguments. Public `status(accountId, operationId, token)` and `verifyDeal({ accountId, operationId, token, txHash? })` require the operation's unexpired handoff token as well as the owner id. Account and operation ids alone grant no access. Account lookups are checked against both the requested account and operation id before secondary reads. `portalOperation(operationId, token)` and `portalEvidence(operationId, token)` each authenticate through `ops.getByHandoff` on every call, before reading private coordinates. Both arguments must be nonempty strings (operation id at most 256 characters, token at most 1024); the returned operation must be a purchase with the requested id. Before consulting the host lookup, the package verifies the supplied token against the stored `operations.handoff_token_hash` with a constant-time SHA-256 comparison and checks the independent `handoff_expires_at` timestamp on every call. The hash is lowercase hex SHA-256 of `dacs-handoff-hash:` followed by the exact token (application wire contract pinned to `9d820e0:packages/dacs-client/test/helpers/purchase-integrity-operations.mjs:43` and the permanent capability vector). Store `handoff_expires_at` as canonical UTC ISO-8601 text produced by `Date.toISOString()` (for example, `2030-01-02T03:04:05.000Z`). SQLite `datetime()` text, epoch text, timezone offsets and local timestamps are refused. A missing, malformed or expired handoff lifetime refuses access. The optional `now()` clock must return a nonnegative safe integer in the JavaScript Date range, in epoch milliseconds; an invalid reading refuses access. Expiry uses the later of that reading and the internal wall clock, so a stale host clock cannot extend a capability. This expiry is separate from `expires_at`, which limits approval and may elapse while a diagnostic link remains valid. `portalEvidence` saves nothing: it reports an elapsed approval window as `expired` without saving the transition. In the retained source service, `portalOperation` is also the entry for the portal's approval and payment actions, and saves that transition; the public diagnostic service only reports it. The returned owner must match the stored owner; the host lookup may further deny access. The retained protocol readback shortcut uses the same capability checks before its closed-wallet-access exception. Existing hosts must migrate `operations` to add the nullable `handoff_expires_at TEXT` column and provision explicit finite lifetimes before enabling portal reads; a null lifetime grants no access. Construction with the earlier schema throws `OperationError` with code `schema_migration_required` and identifies the missing column. Pass the id and token to evidence reads even when an earlier lookup returned an operation.

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

## Seller transport composition

`createSourceDemoSellerTransport({authority, sessionSignerFor, sessionPolicyFor, endpointProofFor})` takes three functions of the purchase: the session signer `{claim, sign}`, the expiry policy `{expiresAt}` and the endpoint proof that the wire's `verifyEndpointProof` returned (verified with the buyer's own commitment receipt reader). The authority still needs a `TEST-` label.
Requests, delegation bytes and received response bytes go through `@kynesyslabs/dacs/wire` under the purchase's kept TP-1 profile. The client saves the delegation payload before it returns the wallet message, stores the wallet signature as canonical base64url, and refuses a purchase prepared under the old transport declaration with `seller_transport_changed`. The seller request timeout also bounds the wire's authority reads and the session signer: a seller call that has not finished signing by then sends nothing and fails with cause `timeout`, and a wallet message or delegation check that is still waiting for the authority fails with `seller_authority_timeout`.
Payment and bundle requests do not carry the finalized commitment yet, so the wire refuses them before signing.

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

| Kind | Name |
| --- | --- |
| table | `accounts` |
| table | `challenges` |
| table | `operations` |
| table | `operation_events` |
| table | `approvals` |
| table | `write_coordinates` |
| table | `wallet_nonce_consumptions` |
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
