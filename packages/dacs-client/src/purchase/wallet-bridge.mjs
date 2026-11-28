// The wallet bridge one purchase operation hands to `walletAgreement.bridgeFor(operation)`.
// It builds the SDK's storage-anchor wallet bridge from the host's configuration and exposes
// only the three members the purchase service calls. That inner bridge keeps the journal, the
// source reads, the wallet handoff, the readback and the receipt verifier; this module adds no
// key, signer, state or acceptance rule of its own.
import { createDemosSr2WalletBridge, DemosSr2BridgeError } from '../dacs/demos-sr2-wallet-bridge.mjs';

const refuse = (message) => { throw new DemosSr2BridgeError('wallet-required', message); };

/**
 * Builds the wallet bridge for one purchase operation. Build a new one, with its own
 * callback, for each operation; nothing is shared or cached between calls.
 *
 * `walletFactory()` is called once, here. It returns `{ rpcUrl, network, journal, sourceCapability, requestWallet }`:
 * the first four are the purchase service's own `walletAgreement` values (the journal and source
 * capability as the same objects, the journal being the buyer wallet's shared atomic journal),
 * and `requestWallet({ anchorJournal })` returns this operation's packaged wallet
 * `{ request, getPublicAccount, getWriteProfile }`. An optional `obtainPaidWritePermit(request,
 * { preparePaidWrite, authorizePaidWrite })` is passed to the inner bridge: before the handoff is
 * issued, `anchor` hands it the frozen request it will send and returns its refusal codes
 * (`paid-write-callback-required`, `paid-write-permit-required`, `paid-write-request-changed`).
 * Other members of the result are ignored.
 *
 * @returns {{ anchor(input: object): Promise<object>, resume(input: object): Promise<object>,
 *   verifyReceipt(input: object): Promise<'valid' | 'invalid' | 'indeterminate'> }} frozen; each member
 *   passes its argument to the inner bridge's member of the same name and returns its result unchanged.
 * @throws {DemosSr2BridgeError} code `wallet-required` when `walletFactory` is not a function, its result is
 *   not an object or has no `requestWallet` function, or `requestWallet` returns no packaged wallet. The inner
 *   bridge's other refusals (such as `profile-held` for the source capability, `journal-required`, or
 *   `invalid` for an `obtainPaidWritePermit` that is given and is not a function) keep their codes, and
 *   an error thrown by `walletFactory` escapes unchanged.
 */
export function createPurchaseWalletBridge({ walletFactory } = {}) {
  if (typeof walletFactory !== 'function') refuse('a purchase wallet configuration callback is required');
  const configuration = walletFactory();
  if (configuration === null || typeof configuration !== 'object' || typeof configuration.requestWallet !== 'function') {
    refuse('the purchase wallet configuration has no requestWallet function');
  }
  const { rpcUrl, network, journal, sourceCapability, requestWallet, obtainPaidWritePermit } = configuration;
  const inner = createDemosSr2WalletBridge({ rpcUrl, network, journal, sourceCapability, walletFactory: requestWallet, obtainPaidWritePermit });
  return Object.freeze({
    anchor: (input) => inner.anchor(input),
    resume: (input) => inner.resume(input),
    verifyReceipt: (input) => inner.verifyReceipt(input),
  });
}
