import { createHash, timingSafeEqual } from 'node:crypto';
import { OperationError } from './client-errors.mjs';

const MAX_OPERATION_ID_LENGTH = 256;
const MAX_HANDOFF_TOKEN_LENGTH = 1024;
const MAX_EPOCH_MILLISECONDS = 8640000000000000;
const validClock = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_EPOCH_MILLISECONDS;
const refuse = () => { throw new OperationError('not_found', 'unknown or invalid approval link'); };

// Private authentication for portal entries. Host refusals retain their identity.
export function createPortalCapability({ db, ops, now }) {
  const stored = db.prepare('SELECT account_id, kind, handoff_token_hash, handoff_expires_at FROM operations WHERE id = ?');
  return (operationId, token) => {
    if (typeof operationId !== 'string' || !operationId || operationId.length > MAX_OPERATION_ID_LENGTH
      || typeof token !== 'string' || !token || token.length > MAX_HANDOFF_TOKEN_LENGTH) refuse();
    const capability = stored.get(operationId);
    if (!capability || capability.kind !== 'purchase') refuse();
    let businessClock, wallClock;
    try { businessClock = now(); wallClock = Date.now(); }
    catch { refuse(); }
    if (!validClock(businessClock) || !validClock(wallClock)) refuse();
    const expiry = typeof capability.handoff_expires_at === 'string' ? Date.parse(capability.handoff_expires_at) : NaN;
    if (!validClock(expiry) || new Date(expiry).toISOString() !== capability.handoff_expires_at
      || expiry <= businessClock || expiry <= wallClock) refuse();
    const hash = capability.handoff_token_hash;
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) refuse();
    const supplied = createHash('sha256').update(`dacs-handoff-hash:${token}`).digest();
    if (!timingSafeEqual(supplied, Buffer.from(hash, 'hex'))) refuse();
    const found = ops.getByHandoff(operationId, token);
    if (!found || found.kind !== 'purchase' || found.id !== operationId || found.accountId !== capability.account_id) refuse();
    if (!found.terms || typeof found.terms !== 'object' || Array.isArray(found.terms)
      || !found.terms.buyer || typeof found.terms.buyer !== 'object' || Array.isArray(found.terms.buyer)
      || typeof found.terms.buyer.wallet !== 'string' || !found.terms.buyer.wallet) refuse();
    return found;
  };
}
