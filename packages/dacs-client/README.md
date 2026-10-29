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

Portal entries require a nonempty primitive operation id (at most 256 characters) and handoff token (at most 1024). They authenticate the stored purchase capability before the host lookup or private reads: exact token bytes hashed as SHA-256 of `dacs-handoff-hash:` followed by the token, constant-time comparison with its lowercase hex hash, matching id/kind/owner, and a canonical `Date.toISOString()` lifetime later than both the business clock and internal wall clock. Both clocks must be valid nonnegative integer epoch milliseconds; the host may further refuse access.

Before constructing the service, migrate older databases with `ALTER TABLE operations ADD COLUMN handoff_expires_at TEXT` and provision explicit finite lifetimes. Missing columns produce `schema_migration_required`; null, malformed or past lifetimes grant no access, including links returned by status. Capability expiry is independent of approval `expires_at`.

Migrate evidence callers from `portalEvidence(operation)` to `portalEvidence(operationId, token)`. Evidence and status project approval expiry without writes. Retained source `portalOperation` keeps the action-side transition; the public service projects it. The protocol readback exception authenticates the same capability first. Purchase actions remain held.

## Factory integration

```js
import {
  PURCHASE_STATE_SCHEMA,
  createCoordinateStore,
  createSqlitePurchaseStore,
  createPurchaseService,
  createProtocolPurchases,
  createDeliveryDeadlineWatch,
} from '@kynesyslabs/dacs-client';

// On a new node:sqlite DatabaseSync connection, initialize the buyer tables.
// Existing databases need a host-owned migration preserving these constraints.
db.exec(PURCHASE_STATE_SCHEMA);
// Construct the store first: it tracks only statements prepared after it exists.
const store = createSqlitePurchaseStore();
const coordinates = createCoordinateStore({ db });
const purposes = { APPROVE_PURCHASE: 'purchase-approval' };
const protocol = createProtocolPurchases({
  db, ops, coordinates, dacsProtocol, store,
  buyerAccess: resolvedBuyerAccess, // optional; null denies paths that require it
});
const purchases = createPurchaseService({
  db, config, ops, coordinates, accounts, verifier, chain, challenges,
  protocol, store, purposes,
});
const watch = createDeliveryDeadlineWatch({ db, ops, coordinates, store, enabled: true });
```

The package supplies the concrete SQLite transaction function. A package-private active write statement prevents callbacks from committing or ending the transaction, including through previously prepared control statements. Only the package finishes this statement before its own commit or savepoint control; no host callback runs during those intervals. Factories refuse arbitrary host wrappers, including `(db, fn) => fn()`, queued callbacks and wrappers returning promises. Transactions use `BEGIN IMMEDIATE`; nested synchronous calls on the same connection use savepoints. A caught synchronous inner error rolls back that call; successful nested writes commit with the outer transaction. If a body returns a thenable at either depth, the adapter rolls back the entire transaction and closes and permanently fences the handle before throwing `OperationError` with code `purchase_store_async_result`. This prevents its deferred continuation from writing through retained statements. Open a fresh `DatabaseSync` handle to retry.

Connection-local TEMP triggers protect every existing ordinary table, including attached and TEMP tables. Virtual and shadow tables are excluded. Guards are reused across transactions and refreshed after schema changes; a missing TEMP marker is rebuilt. A pre-existing host transaction is refused before installing any TEMP objects, and its connection remains usable after the host rolls back. They are armed only during a package call: automatic rollback removes the transactional marker, so subsequent DML aborts even through previously prepared statements. The adapter checks the marker before releasing a savepoint or committing and disarms the guards before commit. Host DML outside package calls remains available. At outer depth an already completed automatic rollback leaves the handle usable; failed savepoint recovery closes and permanently fences it. Uncaught statement errors propagate unchanged. Bodies should rethrow statement errors; a swallowed automatic-rollback error is reported as `OperationError` with code `purchase_store_transaction_ended` when the adapter checks the lost transaction.

SQLite is loaded when the concrete adapter is constructed. The `db` handle must be a `node:sqlite` `DatabaseSync`; its type is checked at the first transaction. A compatible-looking handle from another library is refused before its callback runs. Concrete refusals use `purchase_store_invalid_handle`, `purchase_store_retired_handle`, `purchase_store_invalid_callback` and `purchase_store_async_callback` to identify those conditions. Open a fresh connection after a retired-handle error. Use synchronous bodies and the same connection for every operation and coordinate write. Bodies may write existing ordinary tables; perform schema changes, virtual-table work, database configuration and transaction-control statements outside this boundary. `PURCHASE_STATE_SCHEMA` supplies the required buyer tables and indexes. The application owns schema initialization, migrations, durable database configuration and backups. For file-backed production state, configure WAL, `synchronous=FULL`, foreign keys and a bounded busy timeout. Tests cover pointer races, rollback, second-connection locking and SIGKILL/reopen immediately before and after settlement and delivery-overdue commits, including repeated requests after restart. Retained native agreement-payment tests also cover resolution-marker and pending-event commits.

`store.isUniqueViolation(error)` must return exactly a synchronous boolean and identify only unique-constraint errors. An application may specialize this classifier while retaining the package's transaction function; its receiver and original errors are preserved. Async/generator classifiers refuse store qualification with `NotWiredError`. A promise result throws `OperationError` with code `purchase_store_async_classifier_result`; other non-boolean results use `purchase_store_invalid_classifier_result`.

The purchase factory requires a nonempty `purposes.APPROVE_PURCHASE`. The store and purpose are validated at construction. Challenge service methods are used only after action admission. A resolved buyer capability supplies synchronous `assertWallet(address)`, returning exactly `undefined` on success; its refusals propagate unchanged. To permit readback of an already reported hash after wallet access closes, throw an error with `code: 'buyer_access_closed'`; a plain `Error` propagates and does not select that readback-only path. The public service checks this capability before `verifyDeal` readback and permits the closed-access exception only for the recorded hash. Pass it to `createProtocolPurchases` at the top level; the old `dacsProtocol.buyerAccess` location throws a migration error.

Preparation, approval challenges, approvals, agreement actions, completion signatures and payment handoffs refuse with `profile_not_admitted`, including legacy and previously approved operations. Refusal precedes Listing/chain resolution and state writes. The public Listing verifier also refuses before Directory or chain resolution/comparison. CORE §11.1.2 requires trusted session and participant profile admission, which this candidate does not implement. Host seams and caller-supplied profile objects cannot lift the hold; `actionsAdmitted` remains false. Public readback of existing operations returns fresh diagnostic observations with `outcome: 'readback_only'` and `authority: 'unqualified_host'`. It never settles, changes a payment verdict, consumes a nonce, saves a hash or drives seller delivery. Cancellation, wallet-result reporting and protocol recheck also remain held. Stored operation statuses are historical records, not a fresh payment attestation. No caller option or reader metadata can enable settlement. No current-profile Listing verification or archival verification is offered by the public verifier.

`PURCHASE_STATE_SCHEMA` defines the complete columns and constraints for these host integration tables:

| Tables | Consumer |
| --- | --- |
| `accounts`, `challenges` | Host account/challenge services; referenced by buyer state |
| `operations`, `operation_events` | Host operation store and delivery deadline watch |
| `approvals` | Purchase service; one approval per operation and per challenge |
| `write_coordinates`, `wallet_nonce_consumptions` | Coordinate store; one verified owner per transaction hash |

Apply the exported DDL to a new database before constructing factories. It does not qualify or migrate an existing host schema. Retain the approval UNIQUE constraints and the partial UNIQUE index on verified transaction hashes in any host migration. Unverified hash pointers may be shared. Host-specific authentication tables are outside this DDL.

Passing a non-null `deliveryDeadlineWatch` option to `createProtocolPurchases` throws because automatic watch integration is unavailable. A host using `createDeliveryDeadlineWatch` must enable it with `enabled: true` and invoke its `observe` method itself; `checkDelivery` remains held. The watch accepts nonnegative safe-integer `checkedAt` values within JavaScript’s Date range (through 8640000000000000 ms) that are no later than its valid `now()` reading; malformed historical observation times render as unavailable. The watch's `observe` and the protocol service's `holdChainReadback` are explicit host bookkeeping writers whose records carry `source: 'host-supplied'`: they can save local observations or an operator hold, but cannot establish settlement, delivery or a refund. The public purchase service's diagnostic read methods never invoke them.

### Injected chain reader

Pass a `chain` object to `createPurchaseService`. Host readers must enforce a deadline, bound response bytes before decoding and bound decoded collection sizes, including reads delegated to third-party libraries. Public diagnostics additionally enforce one service-level deadline across network identity and transfer readback (default 8000 ms; factory option `chainReadTimeoutMs`, integer 1–60000), pass `{ signal }` to both reader methods, and retain only bounded primitive observation fields. Oversized contract fields are malformed; extension objects and collections are omitted. A service timeout has `observation.kind: 'timeout'`. Readers must honor the signal to stop their underlying I/O. Readback uses the following contract; all returned observations must be JSON serializable:

- Metadata: `network` (network name), `pinnedIdentity` (configured chain hash), `rpcOrigin` (RPC origin), `evidenceMode` (observation mode), and optional `observer` (the host reader's name/version). Stored observations copy `observer`; an omitted name is labelled as an undeclared host reader, never attributed to core.
- `networkIdentity()` returns `{ identity, mode }`, where `identity` is the observed chain hash and `mode` matches the operation's bound domain (`public-chain-read` for retained testnet operations).
- `observeTransfer(txHash)` returns `{ status: 'included', txHash, payer, payee, amountOs, blockNumber, includedAt? }` for a readable transfer. `payer` and `payee` are Demos address strings, `txHash` identifies the requested hash, `amountOs` is canonical nonnegative decimal integer **text** in OS units (1 DEM = 10^9 OS; use the exported `OS_INTEGER` bound), and `blockNumber` is a nonnegative safe integer Number. Optional `includedAt` is nonnegative safe-integer epoch milliseconds within JavaScript's Date range. A Number or bigint amount is malformed input, not evidence of a different payment. Optional `observePurchaseTransfer(txHash)` has the same contract and is used for retained native agreement-payment operations. When `sourceDisposition` is present on an included observation, it must also be `included` to establish a consumed slot.
- `observePassiveTransfer(txHash, { signal })` has the same observation contract without recovery, journal writes or claim release. Public diagnostics prefer it for every retained purchase; native agreement-payment diagnostics require it and report unavailable when it is absent. Only legacy diagnostics without a passive reader use `observeTransfer`.
- Other observation statuses are `pending`, `not-found`, `failed`, `invalid`, and `unavailable`, with an optional string `reason`. Malformed diagnostic results carry `observation.status: 'malformed'` without being saved. In the retained source integration they return non-final `invalid_observation`; correcting the reader allows the same hash to be checked again. Core’s `createPayDemSellerObserver` is the reference observer; its valid `invalid` result keeps its reason and permits canonical-body nonce reconciliation in the retained integration.
- `getTransaction(txHash)` returns the fresh canonical body `{ hash, status, blockNumber?, content: { from, from_ed25519_address?, nonce } }`. The retained source integration requires `status: 'confirmed'`, the requested hash, a matching observed block when projected, and the saved buyer nonce. `nonce` accepts a nonnegative safe integer Number or canonical decimal text of that integer. Address projections must be readable Demos addresses; the existing alternate signing-key path is supported.
- `getAddressNonce(wallet)` returns the wallet's current safe integer nonce when a retained handoff has no reported hash.

These are host observation shapes, not a new DACS evidence format. Readback remains a single RPC view with tuple-only attribution and no established finality. Public diagnostics never run native journal reconciliation. In the retained source integration, an absent private native source capability reports `nativeReadback: 'unavailable'` and directs the operator to the original qualified host, without asking for an endless `verify_deal` retry.

Public `verifyDeal` reads only the saved transaction hash; an optional `txHash` must identify that same hash. It never attaches a new pointer. `verification.termsMatch` is true or false for a readable included observation's payer/payee/amount tuple only when `sourceDisposition` is absent or `included`, and null otherwise; it establishes no nonce, settlement or delivery verdict. These diagnostics read a native payment transfer rather than a DACS signed artifact; they do not resolve, verify or compare a Listing, Agreement or other DACS artifact. They are outside the archival artifact-verification path in CORE §11.1.2(4). Public status helpers describe the hold, omit approval links and mark stored settlement states historical. Every public diagnostic is one bounded projection of saved state: operation state keeps only its listed fields, so planned signing requests, buyer bundles, identities and session delegations are never returned, and keys that carry signing or replay material (payloads, messages, signatures) are not copied at any depth. Strings over 1024 characters, lists or records over 32 entries, nesting beyond 6 levels and output beyond 65536 characters become an explicit omitted marker, and `status` keeps its newest 32 history events. Coordinate diagnostics retain hashes and nonces while omitting unsigned payment payloads. Wallet serializer vectors were checked with `@kynesyslabs/demosdk` 4.0.16 from this revision's lockfile.

The chain-reader factory is outside the public surface until a clean immutable node build is qualified for its readback shapes. The internal historical reader and its fixtures do not establish support for a moving or dirty node build. A fixture records a historical wire shape, not a promise that its hash remains available on testnet. Held bridge constructors and private transport-brand predicates are also outside the public surface. `DEVNET_NATIVE_RPC_PATH` and `DEVNET_NATIVE_BINDING_PATH` identify experimental host portal routes, rather than general SDK endpoints.

## Validation

After `npm ci` and `npm run build` at the SDK root, run `npm test --workspace @kynesyslabs/dacs-client`. Each executable test runs once, one file at a time. The paired packed-consumer acceptance test uses a fresh private npm cache, stages the already installed runtime dependencies as local tarballs and installs them with `npm ci --offline`; it needs no registry access or populated cache. Source-repository acceptance cases explicitly skip when their source inputs are unavailable. CI runs the client suite, including the packed-consumer test that imports both entry points, only in the current Node 22 matrix entry. No job runs the declared minimum Node 22.13.0, and the Node 20 matrix entry establishes no Node 20 client support.

The reciprocal integrity record pins the complete package tree, exact bytes and Git modes. Package changes require a reviewed re-pin and an enumerated source delta. The raw JSON default remains 1 MiB; bounded opt-in RPC and Directory limits and exact signed-content comparisons are unchanged.

### Operations store contract

`ops` is a trusted, synchronous application service using the same SQLite connection and transaction as the coordinate store. All methods must throw their original errors. Required methods are listed below. A hydrated operation has these fields:

| Field | Contract |
| --- | --- |
| `id`, `accountId` | Nonempty operation id and authenticated owner id; both must match the lookup. |
| `kind` | `purchase` for buyer operations. |
| `status` | Stored purchase status from the operation state machine; diagnostic status is historical. |
| `terms`, `termsHash` | Parsed bound purchase terms and their canonical hash. Terms include buyer, seller, price, Listing and network/domain data; `terms.protocol` identifies protocol operations. |
| `state` | Parsed state object, including any saved `protocol` state. |
| `expiresAt` | ISO timestamp for the approval window. |
| `createdAt`, `updatedAt` | ISO record timestamps retained by the host operation store. |

Return fresh objects so projections cannot alter stored state. The host must derive each service call's `accountId` from its authenticated session, outside caller-controlled tool or request arguments. Public `status(accountId, operationId, token)` and `verifyDeal({ accountId, operationId, token, txHash? })` require the operation's unexpired handoff token as well as the owner id. Account and operation ids alone grant no access. Account lookups are checked against both the requested account and operation id before secondary reads. `portalOperation(operationId, token)` and `portalEvidence(operationId, token)` each authenticate through `ops.getByHandoff` on every call, before reading private coordinates. Both arguments must be nonempty strings (operation id at most 256 characters, token at most 1024); the returned operation must be a purchase with the requested id. Before consulting the host lookup, the package verifies the supplied token against the stored `operations.handoff_token_hash` with a constant-time SHA-256 comparison and checks the independent `handoff_expires_at` timestamp on every call. The hash is lowercase hex SHA-256 of `dacs-handoff-hash:` followed by the exact token (application wire contract pinned to `9d820e0:packages/dacs-client/test/helpers/purchase-integrity-operations.mjs:43` and the permanent capability vector). Store `handoff_expires_at` as canonical UTC ISO-8601 text produced by `Date.toISOString()` (for example, `2030-01-02T03:04:05.000Z`). SQLite `datetime()` text, epoch text, timezone offsets and local timestamps are refused. A missing, malformed or expired handoff lifetime refuses access. The optional `now()` clock must return a nonnegative safe integer in the JavaScript Date range, in epoch milliseconds; an invalid reading refuses access. Expiry uses the later of that reading and the internal wall clock, so a stale host clock cannot extend a capability. This expiry is separate from `expires_at`, which limits approval and may elapse while a diagnostic link remains valid. `portalEvidence` saves nothing: it reports an elapsed approval window as `expired` without saving the transition. In the retained source service, `portalOperation` is also the entry for the portal's approval and payment actions, and saves that transition; the public diagnostic service only reports it. The returned owner must match the stored owner; the host lookup may further deny access. The retained protocol readback shortcut uses the same capability checks before its closed-wallet-access exception. Existing hosts must migrate `operations` to add the nullable `handoff_expires_at TEXT` column and provision explicit finite lifetimes before enabling portal reads; a null lifetime grants no access. Construction with the earlier schema throws `OperationError` with code `schema_migration_required` and identifies the missing column. Pass the id and token to evidence reads even when an earlier lookup returned an operation.

Host `ops` methods must never issue `BEGIN`, `COMMIT`, `ROLLBACK` or savepoint control inside a package transaction. SQLite refuses a callback COMMIT or END while the package-private write statement is active, so failed callbacks cannot leave a partially committed state. Keep transaction control in the supplied store. Construct `createSqlitePurchaseStore()` before preparing host write statements so their connection ownership is tracked. Guarded SQL cannot execute application-defined SQL functions/aggregates or register SQL callbacks. An application function with the name and arity of a bundled FTS, RTREE or GEOPOLY function cannot be told from it, so calls to those bundled functions by name are refused under a guard as well.

- `get(accountId, id)`: return a fresh hydrated operation owned by that account, or null; never cross account boundaries.
- `getByHandoff(id, token)`: apply any additional host access policy before returning an operation, or return null. The package independently checks the stored capability hash, owner and handoff lifetime first.
- `handoffTokenFor(id)`: return the stable authenticated handoff token for an owned operation.
- `history(id)`: return the append-only events, ordered by sequence, for an already authorized operation.
- `record(id, type, data)`: atomically append a uniquely sequenced event, participating in the caller's transaction.
- `appendEvent(id, type, data)`: append an event inside an existing transaction; used when a protocol check cannot save over a newer revision.
- `transition(id, fromStatus, toStatus, { state, event, data })`: atomically compare the saved status with `fromStatus`, merge any state patch, apply `sellerSessionTransitionState(current, toStatus, mergedState, nowMs)`, update the operation, and append the event. Return the fresh operation. If the status differs or the SQL compare-and-swap affects anything other than one row, throw the exported `OperationError('invalid_state', ...)` without writing. Never overwrite a newer status after an asynchronous read. Event and state changes must roll back together.

The retained preparation path additionally uses `createIdempotent({ accountId, kind, idempotencyKey, request, status, subjectId, terms, termsHash, expiresAt, state })`, returning `{ operation, created, handoffToken }`, and `findByKey(accountId, kind, idempotencyKey)`. Creation must enforce owner-scoped idempotency: the same key and canonical request returns the same operation; a different request throws `idempotency_conflict`. Reusing a transaction must preserve the package's savepoint semantics. Public preparation remains held before these calls.

The local deadline and operator-hold bookkeeping records are host observations outside the artifact verification path. Under CORE §11.1.2(3–4), neither these records nor historical success authenticates a corrective-profile session or authorizes an action. Their presence cannot enable purchase, agreement, refund, completion or delivery actions; the admission hold still precedes protocol work.
`openDurableWalletJournal({ path, mode, expectedJournalId?, lockTimeoutMs?, pollMs?, busyTimeoutMs?, maxRecords?, maxKeyBytes?, maxValueBytes?, maxTotalBytes? })` at `@kynesyslabs/dacs-client/wallet/durable-journal` requires an absolute caller-owned path and explicit `mode: 'create'` (absent file) or `'open'` (existing intact journal). It synchronously returns `{ journalId, instance, path, get, put, entries, withWalletLock, inspectLocks, releaseAbandonedLock, close }`; get/put/entries/withWalletLock are async. Records must be exact JSON; writes and lane locks persist in SQLite, and close refuses active lane work.
The factory and operations throw/reject `DurableWalletJournalError` with a `code`: `journal-invalid` for invalid arguments/records, `journal-exists`/`journal-absent` for mode/path mismatch, `journal-integrity` for damaged or unexpected journal identity, `journal-capacity` for limits, `journal-busy` for contention/active work, and `journal-closed` for use after close. Lock operations can also report `journal-reentrant`, `journal-fenced`, `journal-lock-live`, or `journal-lock-mismatch`; other SQLite failures use `journal-error` and preserve their cause. Reopen with `expectedJournalId` to bind the retained journal; never recreate an absent journal to resume a lane.
