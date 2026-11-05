// Test-only offline harness from frontend 82bf8c4; no application wiring.
// Durable, owner-scoped operations with idempotency keys, compare-and-swap
// status transitions and an append-only event log. Every read takes the
// authenticated account id; there is no lookup that crosses accounts except
// the portal's handoff-token resolution, which requires a high-entropy token.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { transaction, isUniqueViolation } from './purchase-integrity-database.mjs';
import { newId, sha256Hex } from '../../src/util/ids.mjs';
import { canonicalize } from '../../src/dacs/listing.mjs';
import { sellerSessionTransitionState } from '../../src/dacs/seller-session-lifecycle.mjs';

import { OperationError } from '../../src/client-errors.mjs';

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


export function requestHashOf(request) {
  return sha256Hex(canonicalize(request));
}

export function createOperationStore({ db, handoffSecret, now = () => Date.now(), timeline = null }) {
  if (!handoffSecret || handoffSecret.length < 32) throw new Error('handoff secret is required');
  // Portal links carry HMAC(secret, operation id): stable across status calls,
  // unguessable, and never stored in plaintext.
  const handoffTokenFor = (id) => createHmac('sha256', handoffSecret).update(`dacs-handoff:${id}`).digest('base64url');
  const hashHandoffToken = (token) => sha256Hex(`dacs-handoff-hash:${token}`);
  const iso = () => new Date(now()).toISOString();
  const insert = db.prepare(`INSERT INTO operations (id, account_id, kind, idempotency_key, request_hash, status, subject_id, terms, terms_hash, state, handoff_token_hash, expires_at, created_at, updated_at, handoff_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const byKey = db.prepare('SELECT * FROM operations WHERE account_id = ? AND kind = ? AND idempotency_key = ?');
  const byIdForAccount = db.prepare('SELECT * FROM operations WHERE id = ? AND account_id = ?');
  const byId = db.prepare('SELECT * FROM operations WHERE id = ?');
  const byHandoff = db.prepare('SELECT * FROM operations WHERE id = ? AND handoff_token_hash = ?');
  const listForAccount = db.prepare('SELECT * FROM operations WHERE account_id = ? ORDER BY created_at DESC LIMIT ?');
  const listBySubject = db.prepare('SELECT * FROM operations WHERE account_id = ? AND kind = ? AND subject_id = ? ORDER BY created_at DESC');
  const cas = db.prepare('UPDATE operations SET status = ?, state = ?, updated_at = ? WHERE id = ? AND status = ?');
  const nextSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM operation_events WHERE operation_id = ?');
  const insertEvent = db.prepare('INSERT INTO operation_events (operation_id, seq, at, type, data) VALUES (?, ?, ?, ?, ?)');
  const events = db.prepare('SELECT seq, at, type, data FROM operation_events WHERE operation_id = ? ORDER BY seq');

  function stageEvent(operation,previous=null) {
    if(operation.kind!=='purchase')return;
    const stage=operation.state?.protocol?.stage ?? operation.status,fromStage=previous?.state?.protocol?.stage ?? previous?.status ?? null;
    try { if(stage!==fromStage||operation.status!==previous?.status)timeline?.record({purchaseId:operation.id,jobId:operation.terms.protocol?.jobId ?? null,timestampMs:now(),step:'stage-change',phase:'complete',durationMs:0,stage,status:operation.status,fromStage,fromStatus:previous?.status ?? null}); } catch { /* logging never changes operation authority */ }
  }

  function appendEvent(operationId, type, data = {}) {
    const { seq } = nextSeq.get(operationId);
    insertEvent.run(operationId, seq, iso(), type, JSON.stringify(data));
  }

  // Same (account, kind, key) + same request -> the existing operation.
  // Same key with a different request -> conflict, never a silent overwrite.
  function createIdempotent({ accountId, kind, idempotencyKey, request, status, subjectId = null, terms, termsHash, expiresAt, state = {} }) {
    const requestHash = requestHashOf(request);
    return transaction(db, () => {
      const existing = byKey.get(accountId, kind, idempotencyKey);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new OperationError('idempotency_conflict', 'this idempotency key was already used for a different request');
        }
        return { operation: hydrate(existing), created: false, handoffToken: handoffTokenFor(existing.id) };
      }
      const id = newId(kind === 'purchase' ? 'pur' : kind === 'identity' ? 'idn' : 'pub');
      const handoffToken = handoffTokenFor(id);
      try {
        insert.run(id, accountId, kind, idempotencyKey, requestHash, status, subjectId, JSON.stringify(terms), termsHash, JSON.stringify(state), hashHandoffToken(handoffToken), expiresAt, iso(), iso(), new Date(now() + 24 * 60 * 60 * 1000).toISOString());
      } catch (error) {
        if (isUniqueViolation(error)) throw new OperationError('idempotency_conflict', 'concurrent request with the same idempotency key');
        throw error;
      }
      appendEvent(id, 'created', { status });
      const operation=hydrate(byId.get(id));stageEvent(operation);
      return { operation, created: true, handoffToken };
    });
  }

  function findByKey(accountId, kind, idempotencyKey) {
    return hydrate(byKey.get(accountId, kind, idempotencyKey));
  }

  function get(accountId, id) {
    return hydrate(byIdForAccount.get(id, accountId));
  }

  function getByHandoff(id, token) {
    if (typeof token !== 'string' || token.length < 16) return null;
    const expected = Buffer.from(handoffTokenFor(id));
    const given = Buffer.from(token);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return hydrate(byHandoff.get(id, hashHandoffToken(token)));
  }

  // Status listeners run after the transition's transaction settled (the
  // body is synchronous), so a listener re-reads the stored operation before
  // acting; they only drop caches and never change an operation.
  const transitionListeners = new Set();
  function onTransition(listener) {
    if (typeof listener !== 'function') throw new TypeError('transition listener required');
    transitionListeners.add(listener);
    return () => transitionListeners.delete(listener);
  }
  const notifyTransition = (operation) => {
    if (!transitionListeners.size) return;
    queueMicrotask(() => { for (const listener of transitionListeners) { try { listener(operation); } catch { /* listeners never change operation authority */ } } });
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
      const operation=hydrate(byId.get(id));stageEvent(operation,current);
      if (toStatus !== fromStatus) notifyTransition(operation);
      return operation;
    });
  }

  function record(id, type, data) {
    transaction(db, () => appendEvent(id, type, data));
  }

  function list(accountId, limit = 20) {
    return listForAccount.all(accountId, Math.min(limit, 100)).map(hydrate);
  }

  function listForSubject(accountId, kind, subjectId) {
    return listBySubject.all(accountId, kind, subjectId).map(hydrate);
  }

  function history(id) {
    return events.all(id).map((e) => ({ seq: e.seq, at: e.at, type: e.type, data: JSON.parse(e.data) }));
  }

  return { createIdempotent, findByKey, get, getByHandoff, handoffTokenFor, transition, onTransition, record, list, listForSubject, history, appendEvent };
}
