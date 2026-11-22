// Seller session keys, held in process memory only.
//
// A key is created by an explicit `start`, lives in this registry's private map and dies with the process or with `stop`.
// Nothing here reads or derives from the wallet's recovery phrase, and no key is ever written to a file, a database,
// a journal, an event or a log. After a restart the registry is empty: a purchase whose delegation names a key from
// before the restart answers `session_gone_reapprove`, and the buyer approves a new session key (`sessionRenewal`).
import { createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import { OperationError } from '../client-errors.mjs';

const CLAIM_PREFIX = 'did:demos:agent:';
const SEED_BYTES = 32;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const PUBLIC_KEY_BYTES = 32;

const privateKeyOf = (seed) => createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
const claimOf = (seed) => `${CLAIM_PREFIX}${createPublicKey(privateKeyOf(seed)).export({ format: 'der', type: 'spki' }).subarray(-PUBLIC_KEY_BYTES).toString('hex')}`;
const gone = () => new OperationError('session_gone_reapprove', 'the seller session key is no longer held by this process; the buyer must approve a new session key');

/**
 * Returns `{start(operationId), stop(operationId), stopAll(), state(operation), signerFor(operation)}` over a registry of random ed25519 session keys held
 * in memory only. `start` makes one key for a purchase and returns `{claim}`, the same claim when one is already live. `stop` drops the key, zero-fills its seed
 * and returns whether one was live; `stopAll` does that for every key and returns how many. `state` returns `live`, `gone` or `not_started` from the registry
 * and the operation's retained delegation alone. `signerFor` is the `sessionSignerFor` resolver of `createSourceDemoSellerTransport`: it returns `{claim, sign}`
 * for a live key, and throws `OperationError(session_gone_reapprove)` when the operation retains a delegation whose key is not live, or
 * `OperationError(session_not_started)` when it retains none. `sign` rejects `session_gone_reapprove` once its key was stopped. `start` throws
 * `TypeError(session_operation_invalid)` for an id that is not a non-empty string. No key, seed or handle is returned, serialized, logged or written.
 */
export function createSellerSessionKeys() {
  const seeds = new Map();
  const live = (operationId) => seeds.get(operationId);
  const retainedKeys = (operation) => {
    const protocol = operation?.state?.protocol;
    return [protocol?.sessionDelegation, protocol?.pendingSessionDelegation].filter(Boolean).map((delegation) => `${CLAIM_PREFIX}${delegation.payload?.sessionPublicKey}`);
  };
  const stop = (operationId) => {
    const seed = seeds.get(operationId);
    if (!seed) return false;
    seed.fill(0);
    return seeds.delete(operationId);
  };
  return Object.freeze({
    start(operationId) {
      if (typeof operationId !== 'string' || operationId === '') throw new TypeError('session_operation_invalid');
      if (!seeds.has(operationId)) seeds.set(operationId, randomBytes(SEED_BYTES));
      return { claim: claimOf(seeds.get(operationId)) };
    },
    stop,
    stopAll() {
      const count = seeds.size;
      for (const operationId of [...seeds.keys()]) stop(operationId);
      return count;
    },
    state(operation) {
      const retained = retainedKeys(operation), seed = live(operation?.id);
      if (seed && retained.every((claim) => claim === claimOf(seed))) return 'live';
      return retained.length > 0 ? 'gone' : 'not_started';
    },
    signerFor(operation) {
      const operationId = operation.id, seed = live(operationId);
      if (!seed) {
        if (operation.state?.protocol?.sessionDelegation) throw gone();
        throw new OperationError('session_not_started', 'no seller session key was started for this purchase');
      }
      return { claim: claimOf(seed), async sign(bytes) {
        const current = live(operationId);
        if (!current) throw gone();
        return sign(null, bytes, privateKeyOf(current));
      } };
    },
  });
}
