import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';

export const T0 = 1793102400000;
const { network, chainIdentity, pinVersion } = TP1_APPROVED_IDENTITY_RECORD;
export const pins = { network, chainIdentity, pinVersion };
const ED25519_PKCS8_PREFIX = '302e020100300506032b657004220420';
const seed = createPrivateKey({ key: Buffer.concat([Buffer.from(ED25519_PKCS8_PREFIX, 'hex'), Buffer.alloc(32, 2)]), format: 'der', type: 'pkcs8' });
export const signer = '0x' + Buffer.from(createPublicKey(seed).export({ format: 'jwk' }).x, 'base64url').toString('hex');
export const otherSigner = '0x' + '4'.repeat(64);
export const digest = text => createHash('sha256').update(text).digest('hex');
export const ownershipKey = `devnet/signer-reservation/${JSON.stringify([pins.network, pins.chainIdentity, signer])}`;
export const dispatchKey = id => `devnet/signer-reservation-dispatch/${id}`;
export const transactionKey = hash => `devnet/signer-reservation-tx/${hash}`;
export const args = (operationKey = 'TEST-evidence-a', attemptId = 'TEST-attempt-a') => ({ signer, operation: 'payment-evidence', operationKey, attemptId, readChainNonce: async () => 0 });
export const options = (journal, overrides = {}) => ({ journal, pins, clock: { now: () => T0 }, ...overrides });
/** Recording settlement double: idempotent by ledger id, refuses a conflicting outcome, and can fail its first call at a barrier. */
export function recordingSettlements({ failFirst = false } = {}) {
  const calls = [], effects = new Map();
  let failed = false;
  async function settleApproval(ledgerId, outcome, reason) {
    calls.push({ ledgerId, outcome, reason });
    if (failFirst && !failed) { failed = true; throw new Error('TEST-settlement-barrier'); }
    if (effects.has(ledgerId) && effects.get(ledgerId) !== outcome) throw new Error('TEST-conflicting-outcome');
    effects.set(ledgerId, outcome);
  }
  return { settleApproval, calls, effects };
}
/** Ownership-proof double: the test controls held(). */
export const ownership = (directory, held = true) => ({ directory, held: () => held });
/** An authenticated execution observation of the bound bytes, as the owning lane's reader reports it. */
export const executed = (transaction = signed()) => ({ status: 'executed', authenticated: true, txHash: transaction.txHash, projectionText: transaction.projectionText });
export const open = (path, mode = 'open', limits = {}) => openDurableWalletJournal({ path, mode, lockTimeoutMs: 0, ...limits });
/** A signed projection whose hash, signer, nonce and signature shape satisfy the reservation's own validation. */
export function signed(nonce = 1) {
  const content = { type: 'storageProgram', from: signer, nonce, timestamp: T0, data: ['CREATE', { program: 'TEST-public-evidence' }] };
  const hash = digest(JSON.stringify(content));
  return { txHash: hash, inputDigest: digest('TEST-public-input'), projectionText: JSON.stringify({ content, hash, signature: { type: 'ed25519', data: sign(null, Buffer.from(hash), seed).toString('hex') } }) };
}
