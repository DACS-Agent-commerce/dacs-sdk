# @kynesyslabs/dacs-client

ESM buyer services and protocol readers for experimental DACS testnet integrations. Install this package with the matching `@kynesyslabs/dacs` version.

This is a package candidate, outside the repository's three-package release set. Public publish settings are intentionally absent. Adding the client to that set requires an owner decision and coordinated artifact, lifecycle, SBOM and publication checks.

The public root exports purchase and protocol factories, Listing and chain readers, verification and receipt helpers. `@kynesyslabs/dacs-client/wallet/durable-journal` separately exports the durable wallet journal and its format/version constants. The root supports Node ^20.19.0 or >=22.12.0 and does not load SQLite; the journal requires Node >=22.13.0. Source paths are private. Browser and wallet-session entry points await the coordinated signing-domain change.

## Factory integration

```js
import {
  createPurchaseService,
  createProtocolPurchases,
  createDeliveryDeadlineWatch,
} from '@kynesyslabs/dacs-client';

// Supply the application's existing state and wallet challenge services.
const store = { transaction, isUniqueViolation };
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

`store.transaction(db, fn)` must run synchronous bodies in a serializing transaction (`BEGIN IMMEDIATE` or equivalent); nested calls join the outer transaction, exceptions roll back, and original errors propagate. Async and generator transaction functions are refused at construction; synchronous wrappers returning thenables throw `NotWiredError`. `store.isUniqueViolation(error)` identifies only unique-constraint errors. Both methods keep their receiver. The application owns the DB schema and operations/coordinate stores and must run the destination race/restart tests against its actual adapter.

The purchase factory requires a nonempty `purposes.APPROVE_PURCHASE`. Missing or malformed seams throw the root-exported `NotWiredError` (an `OperationError`) with code `client_not_wired` before any state access. A resolved buyer capability supplies synchronous `assertWallet(address)`, returning exactly `undefined` on success; its refusals propagate unchanged. Pass it at the top level: the old `dacsProtocol.buyerAccess` location throws a migration error, including when both locations are supplied.

Approval challenges, approvals and payment handoffs all refuse with `profile_not_admitted`, including legacy purchases without `terms.protocol` and previously approved or handed-off operations. The refusal precedes challenge issuance/consumption and coordinate writes. Injected host seams and caller-supplied chain pins cannot lift it. Readback remains available. The trusted profile and participant admission, production-store qualification and approved immutable testnet identity prerequisites remain required. `actionsAdmitted` remains false. Public HTTPS transport, the Directory schema transition and browser signing-domain convergence require their own protocol changes before a remote-seller deployment.

`DEVNET_NATIVE_RPC_PATH` and `DEVNET_NATIVE_BINDING_PATH` are experimental host portal routes; they are not general SDK endpoint defaults. The runtime API currently ships JavaScript only; TypeScript declarations for both entry points remain a follow-up.

## Validation

After `npm ci` and `npm run build` at the SDK root, run `npm test --workspace @kynesyslabs/dacs-client`. Every executable test runs once, one file at a time. Tests cover explicit synchronous store injection, public action refusal, the exact tarball import closure, pointer races, restart, executed-only settlement and broadcast-once recovery. CI imports the packed root in an empty consumer on Node 20.19.0 and Node 22. Source-repository acceptance cases report explicit skips when the source inputs are unavailable.

The reciprocal integrity record and gate still pin the complete package tree, including exact bytes and Git modes. New entry points or other package changes require a reviewed re-pin and an enumerated source delta. The raw JSON default remains 1 MiB; bounded opt-in RPC and Directory limits and exact signed-content comparisons are unchanged.
