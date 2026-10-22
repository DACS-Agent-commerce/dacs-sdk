# @kynesyslabs/dacs-client

JavaScript ESM services for experimental host integrations and readback of existing DACS testnet operations. This private package candidate is outside the repository's three-package release set. It is not a registry installation or a purchase-capable release. TypeScript, browser, wallet-session, public remote-seller transport and full agreement-capability transport integrations are outside this candidate's supported surface.

Use the SDK workspace after `npm ci` and `npm run build`, or install paired local artifacts into a JavaScript ESM application:

```sh
mkdir -p /tmp/dacs-artifacts
npm pack --ignore-scripts --pack-destination /tmp/dacs-artifacts
npm pack --workspace @kynesyslabs/dacs-client --pack-destination /tmp/dacs-artifacts
npm install /tmp/dacs-artifacts/kynesyslabs-dacs-0.1.0-alpha.0.tgz /tmp/dacs-artifacts/kynesyslabs-dacs-client-0.1.0-alpha.0.tgz
```

Both artifacts must come from the same reviewed SDK revision. Release-set admission requires coordinated artifact, lifecycle, SBOM and publication checks; `private: true` prevents publication until that happens.

Both public entry points require Node ^22.13.0 or >=23.4.0. The root does not load SQLite during import. `@kynesyslabs/dacs-client/wallet/durable-journal` separately exports the durable wallet journal and its format/version constants. Source paths are private.

## Factory integration

```js
import {
  createSqlitePurchaseStore,
  createPurchaseService,
  createProtocolPurchases,
  createDeliveryDeadlineWatch,
} from '@kynesyslabs/dacs-client';

// db is a node:sqlite DatabaseSync connection with the application's schema.
const store = createSqlitePurchaseStore();
const purposes = { APPROVE_PURCHASE: 'purchase-approval' };
const protocol = createProtocolPurchases({
  db, ops, coordinates, dacsProtocol, store,
  buyerAccess: resolvedBuyerAccess, // optional; null denies paths that require it
});
const purchases = createPurchaseService({
  db, config, ops, coordinates, accounts, verifier, chain, challenges,
  protocol, store, purposes,
});
const watch = createDeliveryDeadlineWatch({ db, ops, coordinates, store });
```

The package supplies the concrete SQLite transaction function. Factories refuse arbitrary host wrappers, including `(db, fn) => fn()`, queued callbacks and wrappers returning promises. Transactions use `BEGIN IMMEDIATE`; nested calls on the same connection join the outer transaction, errors and thenable results roll back before returning, and original errors propagate. SQLite is loaded lazily when a transaction runs. Use synchronous bodies and the same connection for every operation and coordinate write. The application owns the schema, operations/coordinate stores, durable database configuration and backups. The adapter does not initialize or migrate that schema. For file-backed production state, configure WAL, `synchronous=FULL`, foreign keys and a bounded busy timeout. Tests exercise this adapter's pointer races, rollback, second-connection lock and restart before/after commit.

`store.isUniqueViolation(error)` must return exactly a synchronous boolean and identify only unique-constraint errors. An application may specialize this classifier while retaining the package's transaction function; its receiver and original errors are preserved. Async/generator classifiers and non-boolean results throw `NotWiredError`.

The purchase factory requires a nonempty `purposes.APPROVE_PURCHASE`. The store and purpose are validated at construction. Challenge service methods are used only after action admission. A resolved buyer capability supplies synchronous `assertWallet(address)`, returning exactly `undefined` on success; its refusals propagate unchanged. Pass it to `createProtocolPurchases` at the top level; the old `dacsProtocol.buyerAccess` location throws a migration error.

Preparation, approval challenges, approvals, agreement actions, completion signatures and payment handoffs refuse with `profile_not_admitted`, including legacy and previously approved operations. Refusal precedes Listing/chain resolution and state writes. The public Listing verifier also refuses before Directory or chain resolution/comparison. CORE §11.1.2 requires trusted session and participant profile admission, which this candidate does not implement. Host seams and caller-supplied profile objects cannot lift the hold; `actionsAdmitted` remains false. Readback of existing operations remains available and uses fresh chain observations. No current-profile Listing verification or archival verification is offered by the public verifier.

The chain-reader factory is outside the public surface until a clean immutable node build is qualified for its readback shapes. The internal historical reader and its fixtures do not establish support for a moving or dirty node build. Held bridge constructors and private transport-brand predicates are also outside the public surface. `DEVNET_NATIVE_RPC_PATH` and `DEVNET_NATIVE_BINDING_PATH` identify experimental host portal routes, rather than general SDK endpoints.

## Validation

After `npm ci` and `npm run build` at the SDK root, run `npm test --workspace @kynesyslabs/dacs-client`. Each executable test runs once, one file at a time. Source-repository acceptance cases explicitly skip when their source inputs are unavailable. CI imports both packed entry points at the declared minimum runtime; the root also retains an import smoke on Node 20 for the surrounding SDK's matrix.

The reciprocal integrity record pins the complete package tree, exact bytes and Git modes. Package changes require a reviewed re-pin and an enumerated source delta. The raw JSON default remains 1 MiB; bounded opt-in RPC and Directory limits and exact signed-content comparisons are unchanged.
