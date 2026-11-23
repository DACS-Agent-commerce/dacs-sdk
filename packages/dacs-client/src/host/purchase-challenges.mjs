// One-use wallet challenges for purchase approval over PURCHASE_STATE_SCHEMA.
// The purpose and the signing origin are fixed when the adapter is built, so
// no caller of `issue` can choose what the wallet signs under.
import { randomBytes } from 'node:crypto';
import { OperationError } from '../client-errors.mjs';
import { purchaseStore } from '../seams/purchase-store-not-wired.mjs';
import { normalizeDemosAddress, verifyDemosSignature } from '../signatures.mjs';
import { newId } from '../util/ids.mjs';

const APPROVAL_STATEMENT = 'Approve exactly this DEM testnet purchase. Your wallet will ask separately before any transaction is sent.';
const NONCE_BYTES = 16;

const iso = (time) => new Date(time).toISOString();
const isSingleLine = (value) => typeof value === 'string' && !/[\r\n]/.test(value);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalidBinding = () => new OperationError('challenge_binding_invalid', 'every binding key and value must be a single line of text');

function bindingLines(binding) {
  if (!isPlainObject(binding)) throw invalidBinding();
  return Object.keys(binding).sort().map((key) => {
    if (!isSingleLine(key) || !isSingleLine(binding[key])) throw invalidBinding();
    return `${key}: ${binding[key]}`;
  });
}

/** purchaseApprovalChallengeText({origin,purpose,address,binding,nonce,issuedAt,expiresAt}) returns the exact text a wallet signs for a
 * purchase approval challenge: the origin's host, the approval statement, then one line per field with the binding's keys sorted.
 * It reads and writes nothing.
 * @throws {OperationError} challenge_binding_invalid when the binding is not an object or a key or value is not a single line of text.
 * @throws {TypeError} when origin is not a URL.
 */
export function purchaseApprovalChallengeText({ origin, purpose, address, binding, nonce, issuedAt, expiresAt }) {
  return [
    `${new URL(origin).host} requests a DACS wallet signature`, '', APPROVAL_STATEMENT, '',
    `origin: ${origin}`, `purpose: ${purpose}`, `address: ${address}`,
    ...bindingLines(binding),
    `nonce: ${nonce}`, `issued-at: ${issuedAt}`, `expires-at: ${expiresAt}`,
  ].join('\n');
}

function isOwnOrigin(origin) {
  if (typeof origin !== 'string') return false;
  try { return new URL(origin).origin === origin; } catch { return false; }
}
function checkOptions(origin, purpose, ttlMs) {
  if (!isOwnOrigin(origin)) throw new TypeError('challenge_origin_invalid');
  if (!isSingleLine(purpose) || !purpose) throw new TypeError('challenge_purpose_invalid');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError('challenge_ttl_invalid');
}
// Every expected member must be present in the stored binding with the same value.
function bindingMatches(stored, expected) {
  if (!isPlainObject(expected)) return false;
  const keys = Object.keys(expected);
  return keys.length > 0 && keys.every((key) => Object.hasOwn(stored, key) && stored[key] === expected[key]);
}

/** createPurchaseChallenges({db,store,origin,purpose,ttlMs,now}) returns a frozen {issue, verifyAndConsume} for the purchase service's
 * `challenges`, serving one purpose and signing under one origin, both fixed here. issue({purpose,address,accountId,binding}) stores one
 * challenge and returns {challengeId,message,address,nonce,issuedAt,expiresAt,binding}; verifyAndConsume({challengeId,purpose,
 * expectedBinding,signature,consumedBy}) consumes it once, in the caller's transaction when there is one, for a valid signature by its
 * address, and returns {challengeId,address,binding,message,accountId}.
 * @throws {TypeError} challenge_origin_invalid, challenge_purpose_invalid, challenge_ttl_invalid at construction.
 * @throws {NotWiredError} when `store` is not the package's SQLite store.
 * @throws {OperationError} issue: challenge_origin_not_accepted, invalid_purpose, challenge_account_required, challenge_binding_invalid;
 * verifyAndConsume: unknown_challenge, purpose_mismatch, challenge_replayed, challenge_expired, binding_mismatch, bad_signature.
 * A malformed address throws WalletFormatError. A refusal stores and consumes nothing.
 */
export function createPurchaseChallenges({ db, store, origin, purpose, ttlMs, now = () => Date.now() }) {
  checkOptions(origin, purpose, ttlMs);
  const { transaction } = purchaseStore(store);
  const insert = db.prepare('INSERT INTO challenges (id, nonce, purpose, account_id, binding, message, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const byId = db.prepare('SELECT * FROM challenges WHERE id = ?');
  const consume = db.prepare('UPDATE challenges SET consumed_at = ?, consumed_by = ? WHERE id = ? AND consumed_at IS NULL');

  function issue(request) {
    const { purpose: requested, address, accountId, binding } = request;
    if (Object.hasOwn(request, 'origin')) throw new OperationError('challenge_origin_not_accepted', 'the signing origin is fixed when the challenge adapter is built');
    if (requested !== purpose) throw new OperationError('invalid_purpose', 'this challenge adapter serves another purpose');
    if (typeof accountId !== 'string' || !accountId) throw new OperationError('challenge_account_required', 'a challenge needs the account it is issued for');
    if (!isSingleLine(accountId)) throw invalidBinding();
    const signer = normalizeDemosAddress(address);
    // The stored binding carries the signer's address; a binding of its own address would replace it.
    if (!isPlainObject(binding) || Object.hasOwn(binding, 'address')) throw invalidBinding();
    const signed = { ...binding, account: accountId };
    const time = now(), nonce = randomBytes(NONCE_BYTES).toString('base64url');
    const issuedAt = iso(time), expiresAt = iso(time + ttlMs);
    const message = purchaseApprovalChallengeText({ origin, purpose, address: signer, binding: signed, nonce, issuedAt, expiresAt });
    const challengeId = newId('chl');
    transaction(db, () => insert.run(challengeId, nonce, purpose, accountId, JSON.stringify({ address: signer, ...signed }), message, issuedAt, expiresAt));
    return { challengeId, message, address: signer, nonce, issuedAt, expiresAt, binding: signed };
  }

  // The read, the checks and the consumption run in one store transaction,
  // whose root holds SQLite's write lock, so two verifications consume once.
  function verifyAndConsume({ challengeId, purpose: requested, expectedBinding, signature, consumedBy }) {
    return transaction(db, () => {
      const row = typeof challengeId === 'string' ? byId.get(challengeId) : undefined;
      if (!row) throw new OperationError('unknown_challenge', 'unknown challenge');
      if (requested !== purpose || row.purpose !== purpose) throw new OperationError('purpose_mismatch', 'the challenge was issued for another purpose');
      if (row.consumed_at !== null) throw new OperationError('challenge_replayed', 'the challenge was already used');
      const time = now();
      if (!(time < Date.parse(row.expires_at))) throw new OperationError('challenge_expired', 'the challenge expired');
      const binding = JSON.parse(row.binding);
      if (!bindingMatches(binding, expectedBinding)) throw new OperationError('binding_mismatch', 'the challenge was issued for other terms');
      if (!verifyDemosSignature({ address: binding.address, message: row.message, signature })) throw new OperationError('bad_signature', 'the signature does not verify for the challenge wallet');
      if (consume.run(iso(time), consumedBy, challengeId).changes !== 1) throw new OperationError('challenge_replayed', 'the challenge was already used');
      return { challengeId, address: binding.address, binding, message: row.message, accountId: row.account_id };
    });
  }

  return Object.freeze({ issue, verifyAndConsume });
}
