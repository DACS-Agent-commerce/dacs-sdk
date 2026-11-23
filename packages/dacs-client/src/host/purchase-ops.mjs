// The purchase service's operations store over PURCHASE_STATE_SCHEMA: durable,
// account-scoped operations with idempotency keys, compare-and-swap status
// transitions and an append-only event log. `get` and `findByKey` take the
// account id; `getByHandoff`, the portal's read, needs the operation's token.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { OperationError, requestHashOf } from '../client-errors.mjs';
import { sellerSessionTransitionState } from '../dacs/seller-session-lifecycle.mjs';
import { purchaseStore } from '../seams/purchase-store-not-wired.mjs';
import { newId, sha256Hex } from '../util/ids.mjs';

const MIN_HANDOFF_SECRET_LENGTH = 32;
// A token shorter than this is refused before any comparison.
const MIN_HANDOFF_TOKEN_LENGTH = 16;

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    status: row.status,
    subjectId: row.subject_id,
    terms: JSON.parse(row.terms),
    termsHash: row.terms_hash,
    state: JSON.parse(row.state),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function checkOptions(handoffSecret, handoffTtlMs) {
  if (typeof handoffSecret !== 'string' || handoffSecret.length < MIN_HANDOFF_SECRET_LENGTH) throw new TypeError('handoff_secret_required');
  if (!Number.isSafeInteger(handoffTtlMs) || handoffTtlMs < 1) throw new TypeError('handoff_ttl_invalid');
}

/** Create the purchase operations store the purchase service and the protocol factory take as `ops`.
 * Every write runs in `store.transaction`; a portal handoff token is HMAC(handoffSecret, id), never stored,
 * and a purchase's handoff lifetime is `handoffTtlMs` from creation, never extended.
 * @throws {TypeError} handoff_secret_required, handoff_ttl_invalid; createIdempotent throws operation_kind_unsupported.
 * @throws {NotWiredError} when `store` is not the package's SQLite store.
 */
export function createPurchaseOperations({ db, store, handoffSecret, handoffTtlMs, now = () => Date.now() }) {
  checkOptions(handoffSecret, handoffTtlMs);
  const { transaction, isUniqueViolation } = purchaseStore(store);
  const handoffTokenFor = (id) => createHmac('sha256', handoffSecret).update(`dacs-handoff:${id}`).digest('base64url');
  const hashHandoffToken = (token) => sha256Hex(`dacs-handoff-hash:${token}`);
  const iso = () => new Date(now()).toISOString();
  const insert = db.prepare(`INSERT INTO operations (id, account_id, kind, idempotency_key, request_hash, status, subject_id, terms, terms_hash, state, handoff_token_hash, expires_at, created_at, updated_at, handoff_expires_at, job_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const byKey = db.prepare('SELECT * FROM operations WHERE account_id = ? AND kind = ? AND idempotency_key = ?');
  const byIdForAccount = db.prepare('SELECT * FROM operations WHERE id = ? AND account_id = ?');
  const byId = db.prepare('SELECT * FROM operations WHERE id = ?');
  const byHandoff = db.prepare('SELECT * FROM operations WHERE id = ? AND handoff_token_hash = ?');
  const cas = db.prepare('UPDATE operations SET status = ?, state = ?, updated_at = ? WHERE id = ? AND status = ?');
  const nextSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM operation_events WHERE operation_id = ?');
  const insertEvent = db.prepare('INSERT INTO operation_events (operation_id, seq, at, type, data) VALUES (?, ?, ?, ?, ?)');
  const events = db.prepare('SELECT seq, at, type, data FROM operation_events WHERE operation_id = ? ORDER BY seq');

  // A bare insert for a transaction the caller already holds.
  function appendEvent(operationId, type, data = {}) {
    const { seq } = nextSeq.get(operationId);
    insertEvent.run(operationId, seq, iso(), type, JSON.stringify(data));
  }

  // Same (account, kind, key) and request: the existing operation.
  // Same key with another request: a conflict, never an overwrite.
  function createIdempotent({ accountId, kind, idempotencyKey, request, status, subjectId = null, terms, termsHash, expiresAt, state = {}, jobId = null }) {
    if (kind !== 'purchase') throw new TypeError('operation_kind_unsupported');
    const requestHash = requestHashOf(request);
    return transaction(db, () => {
      const existing = byKey.get(accountId, kind, idempotencyKey);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new OperationError('idempotency_conflict', 'this idempotency key was already used for a different request');
        }
        return { operation: hydrate(existing), created: false, handoffToken: handoffTokenFor(existing.id) };
      }
      const id = newId('pur');
      const handoffToken = handoffTokenFor(id);
      try {
        insert.run(id, accountId, kind, idempotencyKey, requestHash, status, subjectId, JSON.stringify(terms), termsHash, JSON.stringify(state),
          hashHandoffToken(handoffToken), expiresAt, iso(), iso(), new Date(now() + handoffTtlMs).toISOString(), jobId);
      } catch (error) {
        if (isUniqueViolation(error) && /operations\.job_id/.test(error.message)) throw new OperationError('job_id_collision', 'the job id is already used by a retained operation');
        if (isUniqueViolation(error)) throw new OperationError('idempotency_conflict', 'concurrent request with the same idempotency key');
        throw error;
      }
      appendEvent(id, 'created', { status });
      return { operation: hydrate(byId.get(id)), created: true, handoffToken };
    });
  }

  function getByHandoff(id, token) {
    if (typeof token !== 'string' || token.length < MIN_HANDOFF_TOKEN_LENGTH) return null;
    const expected = Buffer.from(handoffTokenFor(id));
    const given = Buffer.from(token);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return hydrate(byHandoff.get(id, hashHandoffToken(token)));
  }

  // Listeners run after the transition's transaction settled, so a listener
  // re-reads the stored operation before acting; they never change one.
  const transitionListeners = new Set();
  function onTransition(listener) {
    if (typeof listener !== 'function') throw new TypeError('transition listener required');
    transitionListeners.add(listener);
    return () => transitionListeners.delete(listener);
  }
  const notifyTransition = (operation) => {
    if (!transitionListeners.size) return;
    queueMicrotask(() => { for (const listener of transitionListeners) { try { listener(operation); } catch { /* listeners never change an operation */ } } });
  };

  function transition(id, fromStatus, toStatus, { state, event, data } = {}) {
    return transaction(db, () => {
      const current = hydrate(byId.get(id));
      if (!current) throw new OperationError('not_found', 'operation not found');
      if (current.status !== fromStatus) {
        throw new OperationError('invalid_state', `operation is ${current.status}, expected ${fromStatus}`, { status: current.status });
      }
      const nextState = sellerSessionTransitionState(current, toStatus, state ? { ...current.state, ...state } : current.state, now());
      const result = cas.run(toStatus, JSON.stringify(nextState), iso(), id, fromStatus);
      if (result.changes !== 1) throw new OperationError('invalid_state', 'operation changed concurrently');
      appendEvent(id, event ?? toStatus, data ?? {});
      const operation = hydrate(byId.get(id));
      if (toStatus !== fromStatus) notifyTransition(operation);
      return operation;
    });
  }

  return Object.freeze({
    createIdempotent,
    findByKey: (accountId, kind, idempotencyKey) => hydrate(byKey.get(accountId, kind, idempotencyKey)),
    get: (accountId, id) => hydrate(byIdForAccount.get(id, accountId)),
    getByHandoff,
    handoffTokenFor,
    transition,
    onTransition,
    record: (id, type, data) => { transaction(db, () => appendEvent(id, type, data)); },
    appendEvent,
    history: (id) => events.all(id).map((e) => ({ seq: e.seq, at: e.at, type: e.type, data: JSON.parse(e.data) })),
  });
}
