// The public, read-only Demos chain reader for testnet. It wraps the client's
// own reader (src/dacs/chain.mjs) and offers only its nine reads and five
// metadata fields: it holds no key and has no way to sign or send.
//
// Every read first needs the chain identity pinned for testnet. The first
// read observes the configured RPC's identity afresh and refuses a simulated
// or different chain before making its own request. Once a check succeeds,
// later reads rely on it, but none returns a result once an answer has been
// marked simulated. A check that fails is never shared: a read that was
// waiting on it makes its own. networkIdentity always observes afresh, and a
// mismatch it sees makes the next read check again.
import { createDemosChainReader } from '../dacs/chain.mjs';
import { OperationError } from '../client-errors.mjs';

const TESTNET = 'testnet';
const PUBLIC_MODE = 'public-chain-read';
const NO_SOURCE_REASON = 'native source evidence unavailable from public reader';

/**
 * Creates the testnet-pinned, read-only Demos chain reader. The returned
 * frozen object is the `chain` the purchase service and the Listing verifier
 * take when no native Agreement transport is composed.
 *
 * Its reads are readStorageProgram, getAddressBalance, getTransactionFees,
 * networkIdentity, getAddressNonce, observePurchaseTransfer, observeTransfer,
 * getTransaction and findTransferAtNonce. Each returns and throws what the
 * client's reader does, except that a read on a chain other than the pinned
 * one, or one whose answer is marked simulated, throws OperationError
 * `network_identity_mismatch`, and
 * observePurchaseTransfer reports an included transfer as unavailable: this
 * reader keeps no signed native source, so it cannot settle a native purchase.
 *
 * Throws OperationError `invalid_configuration` when `network` is not
 * `testnet` or `pinnedIdentity` is not a 64-hex chain identity.
 */
export function createDemosPublicChainReader({ rpcUrl, network, pinnedIdentity, timeoutMs, fetchImpl }) {
  if (network !== TESTNET) {
    throw new OperationError('invalid_configuration', 'the public Demos chain reader reads testnet only', { network });
  }
  const reader = createDemosChainReader({ rpcUrl, network, pinnedIdentity, timeoutMs, fetchImpl });
  if (reader.pinnedIdentity === null) {
    throw new OperationError('invalid_configuration', 'the public Demos chain reader needs the 64-hex chain identity pinned for testnet', { network });
  }

  let pinChecked = false;
  let pendingCheck = null;

  async function observePinnedIdentity(signal) {
    const observed = await reader.networkIdentity({ signal });
    if (observed.mode !== PUBLIC_MODE || reader.evidenceMode !== PUBLIC_MODE || observed.identity !== reader.pinnedIdentity) {
      pinChecked = false;
      throw new OperationError('network_identity_mismatch', 'the configured Demos RPC reports a simulated chain or a different chain than the one pinned for testnet; nothing was read',
        { network: TESTNET, pinned: reader.pinnedIdentity, observed: observed.identity, mode: observed.mode });
    }
    pinChecked = true;
    return observed;
  }

  async function requirePinnedIdentity(signal) {
    if (pinChecked) return;
    if (pendingCheck) {
      try {
        await pendingCheck;
        return;
      } catch {
        // A failed check is not shared: this read makes its own below.
      }
    }
    const check = observePinnedIdentity(signal);
    pendingCheck = check;
    try {
      await check;
    } finally {
      if (pendingCheck === check) pendingCheck = null;
    }
  }

  // A simulation marker on any answer turns the reader's mode for good, so a
  // result that arrives after it is not returned and the next read checks again.
  async function pinnedRead(signal, read) {
    await requirePinnedIdentity(signal);
    const result = await read();
    if (reader.evidenceMode !== PUBLIC_MODE) {
      pinChecked = false;
      throw new OperationError('network_identity_mismatch', 'the configured Demos RPC marked an answer as simulated after the chain was checked; the result was not returned',
        { network: TESTNET, pinned: reader.pinnedIdentity, mode: reader.evidenceMode });
    }
    return result;
  }

  return Object.freeze({
    network: reader.network,
    pinnedIdentity: reader.pinnedIdentity,
    rpcOrigin: reader.rpcOrigin,
    observer: reader.observer,
    get evidenceMode() {
      return reader.evidenceMode;
    },
    readStorageProgram: (locator) => pinnedRead(undefined, () => reader.readStorageProgram(locator)),
    getAddressBalance: (address, options) => pinnedRead(undefined, () => reader.getAddressBalance(address, options)),
    getTransactionFees: () => pinnedRead(undefined, () => reader.getTransactionFees()),
    networkIdentity: (options) => observePinnedIdentity(options?.signal),
    getAddressNonce: (address) => pinnedRead(undefined, () => reader.getAddressNonce(address)),
    observePurchaseTransfer: (hash, options) => pinnedRead(options?.signal, async () => {
      const observation = await reader.observeTransfer(hash, options);
      return observation.status === 'included' ? { status: 'unavailable', reason: NO_SOURCE_REASON } : observation;
    }),
    observeTransfer: (hash, options) => pinnedRead(options?.signal, () => reader.observeTransfer(hash, options)),
    getTransaction: (hash, options) => pinnedRead(options?.signal, () => reader.getTransaction(hash, options)),
    findTransferAtNonce: (address, nonce, options) => pinnedRead(options?.signal, () => reader.findTransferAtNonce(address, nonce, options)),
  });
}
