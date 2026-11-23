import { canonicalize } from '@kynesyslabs/dacs';

const WALLET_PREFIX = 'sr2/wallet/';

class WalletLaneError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Returns the wallet's JSON storage-anchor lane, preserving the given chain identity. */
export function walletLane({ network, chainIdentity, address }) {
  return JSON.stringify([network, chainIdentity, address]);
}

/** Returns the lane's journal key; throws TypeError('wallet_lane_invalid') for an empty or non-string lane. */
export function walletLaneKey(lane) {
  if (typeof lane !== 'string' || !lane) throw new TypeError('wallet_lane_invalid');
  return WALLET_PREFIX + lane;
}

/**
 * Returns get, put and withWalletLock over the caller's journal.
 * Throws TypeError('wallet_lane_journal_required') without those journal methods.
 * Operations preserve journal errors; put rejects with journal-error if readback differs.
 */
export function createWalletLaneView({ journal } = {}) {
  if (!journal || ['get', 'put', 'withWalletLock'].some(key => typeof journal[key] !== 'function')) {
    throw new TypeError('wallet_lane_journal_required');
  }
  return {
    get: async lane => structuredClone(await journal.get(walletLaneKey(lane))),
    put: async (lane, record) => {
      const key = walletLaneKey(lane);
      // Node acceptance keeps the lane occupied until the client's receipt readback.
      const stored = record.stage === 'broadcast-accepted' ? { ...record, stage: 'sr2-readback-pending' } : record;
      await journal.put(key, structuredClone(stored));
      const retained = await journal.get(key);
      if (!retained || canonicalize(retained) !== canonicalize(stored)) {
        throw new WalletLaneError('journal-error', 'the exact issued stage was not retained');
      }
    },
    withWalletLock: (lane, work) => journal.withWalletLock(walletLaneKey(lane), work),
  };
}
