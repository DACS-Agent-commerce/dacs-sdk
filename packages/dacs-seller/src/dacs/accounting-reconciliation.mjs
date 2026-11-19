// Startup reconciliation of the accounting store with the wire journal. The seller state lock is held, so the nonce-key files, the
// operation files and the store do not change under it. A charge is committed before its nonce key is published (the key is never
// ahead of its row), so every key must name a row; a row that is still `reserving` keeps its charge and is told what the journal
// holds for it; a completed operation whose slot is still open returns that slot once. One transaction makes every change, and
// any evidence that cannot be read, or does not match, changes nothing and leaves the host not ready.
import { DACS_SELLER_HTTP_PATHS as PATHS, listWireNonceKeys, wireOperationId } from '@kynesyslabs/dacs/wire';
import { ownsPurchaseCapacity } from './seller-purchase-capacity.mjs';
import { storedCause } from './seller-admission-transaction.mjs';
import { sellerStoreInternals } from './seller-transport-auth.mjs';

const MISMATCH_CODE = 'kit_journal_accounting_mismatch';
// A plan is built again when a row or allocation moved after it was read; the store has one writer, so a repeat is rare.
const MAX_PLAN_ATTEMPTS = 3;
const MAX_CAUSE_MESSAGE_CHARS = 512;
const SCHEMA = `CREATE TABLE IF NOT EXISTS kit_reservation_results (key TEXT PRIMARY KEY, result TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kit_accounting_reconciliation (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL CHECK (state IN ('consistent', 'mismatch')), cause TEXT)`;

const mismatch = (detail, cause) => Object.assign(new Error(`${MISMATCH_CODE}: ${detail}`, cause === undefined ? undefined : { cause }), { code: MISMATCH_CODE, status: 503 });
const conflict = () => Object.assign(new Error('the accounting rows moved while reconciliation was planned'), { code: 'peer_reconciliation_conflict', status: 503 });
// A failure of the journal or an inspection keeps its own cause; the mismatch's own error is already the cause.
const boundedCause = (error) => { const cause = storedCause(error); return { ...cause, message: cause.message.slice(0, MAX_CAUSE_MESSAGE_CHARS) }; };

// What the journal holds for a row that is still `reserving`: `nonce` is its published nonce key, if any, and `view` its operation's view.
function resultOf(row, nonce, view) {
  if (nonce === undefined) return { kind: 'not-published' };
  if (!['none', 'pending', 'ended', 'completed'].includes(view?.state)) throw mismatch(`operation ${row.operationId} has no readable state`);
  if (view.state === 'none') return { kind: 'published', attempt: null, effectState: 'no-attempt' };
  if (view.binding !== nonce.binding) throw mismatch(`operation ${row.operationId} is bound to another request binding`);
  if (['pending', 'ended'].includes(view.state) && view.requestHash === row.requestHash) return { kind: 'published', attempt: view.attempt, effectState: view.attempt === 0 ? 'new' : 'recover' };
  return { kind: 'published', attempt: null, effectState: 'attempt-unresolved' };
}

/**
 * Creates the startup reconciler over the transport `store`, the purchase `capacity` built on it, the wire request `journal` and
 * `inspectOperation(target)`, the wire's read-only operation view of `{ seller, jobId, path }`. Throws a TypeError for anything else.
 * `reconcileStartup()` resolves `{ ready, code, cause }`: `ready` true (code and cause null) once the journal and the store agree and every
 * change is committed, `ready` false with code `kit_journal_accounting_mismatch` and the stored cause when evidence is unreadable, a nonce
 * key names no row or another request, or an operation is bound to another binding. A mismatch changes no row and no slot. It rejects
 * when the store cannot commit. No journal file is published, ended or deleted.
 */
export function createAccountingReconciler({ store, capacity, journal, inspectOperation }) {
  if (!ownsPurchaseCapacity(store, capacity) || typeof inspectOperation !== 'function' || journal === null || typeof journal !== 'object') {
    throw new TypeError('reconciliation needs the store, its purchase capacity, the wire journal and an operation inspection');
  }
  const { db, transaction } = sellerStoreInternals(store);
  db.exec(SCHEMA);
  const sellerOf = (jobId) => db.prepare('SELECT seller FROM kit_job_holds WHERE jobId = ?').get(jobId)?.seller;

  // Reads everything and changes nothing: the nonce keys against all N rows, each unclassified `reserving` row, each open slot's operation.
  function plan() {
    const rows = db.prepare('SELECT * FROM kit_reservations ORDER BY rowid').all();
    const nonces = new Map(listWireNonceKeys(journal, rows.length).map((nonce) => [nonce.key, nonce]));
    const keys = new Map(rows.map((row) => [row.key, row]));
    for (const nonce of nonces.values()) {
      const row = keys.get(nonce.key);
      if (row === undefined) throw mismatch(`nonce key ${nonce.key} names no accounting row`);
      if (row.operationId !== nonce.operationId || row.requestHash !== nonce.requestHash) throw mismatch(`nonce key ${nonce.key} differs from its accounting row`);
    }
    const classified = new Set(db.prepare('SELECT key FROM kit_reservation_results').all().map(({ key }) => key));
    const results = rows.filter((row) => row.state === 'reserving' && !classified.has(row.key)).map((row) => {
      const view = nonces.has(row.key) ? inspectOperation({ seller: sellerOf(row.jobId), jobId: row.jobId, path: row.route }) : null;
      return { key: row.key, rev: row.rev, result: resultOf(row, nonces.get(row.key), view) };
    });
    const boundOperations = new Map([...nonces.values()].map((nonce) => [nonce.operationId, nonce.binding]));
    const returns = [];
    for (const allocation of capacity.capacityReport().allocations.filter((held) => held.state === 'live')) {
      for (const [route, slot] of Object.entries(allocation.slots)) {
        if (slot.state !== 'open' || route === PATHS.context) continue;
        const view = inspectOperation({ seller: allocation.seller, jobId: allocation.jobId, path: route });
        if (view.state !== 'completed') continue;
        const bound = boundOperations.get(wireOperationId({ seller: allocation.seller, jobId: allocation.jobId, path: route }));
        if (bound !== undefined && bound !== view.binding) throw mismatch(`the completed operation of job ${allocation.jobId} on ${route} is bound to another request binding`);
        returns.push({ jobId: allocation.jobId, route, rev: allocation.rev });
      }
    }
    return { results, returns };
  }

  // One transaction: every expected revision is verified before the first write, then each change is a compare-and-swap on it.
  function commit({ results, returns }) {
    transaction(() => {
      for (const { key, rev } of results) if (db.prepare("SELECT 1 FROM kit_reservations WHERE key = ? AND state = 'reserving' AND rev = ?").get(key, rev) === undefined) throw conflict();
      for (const { jobId, rev } of returns) if (capacity.allocationWithin(jobId)?.rev !== rev) throw conflict();
      for (const { key, rev, result } of results) {
        db.prepare('UPDATE kit_reservations SET rev = rev + 1 WHERE key = ? AND rev = ?').run(key, rev);
        db.prepare('INSERT INTO kit_reservation_results (key, result) VALUES (?, ?)').run(key, JSON.stringify(result));
      }
      for (const { jobId, route } of returns) {
        const held = capacity.allocationWithin(jobId);
        capacity.returnRouteSlotWithin({ allocationId: held.allocationId, allocationRev: held.rev, route });
        const after = capacity.allocationWithin(jobId);
        if (route === PATHS.payments && after.state === 'live') capacity.releaseAllWithin({ allocationId: after.allocationId, allocationRev: after.rev });
      }
      db.prepare("INSERT INTO kit_accounting_reconciliation (id, state, cause) VALUES (1, 'consistent', NULL) ON CONFLICT (id) DO UPDATE SET state = 'consistent', cause = NULL").run();
    });
  }

  function recordMismatch(error) {
    const cause = boundedCause(error);
    transaction(() => db.prepare("INSERT INTO kit_accounting_reconciliation (id, state, cause) VALUES (1, 'mismatch', ?) ON CONFLICT (id) DO UPDATE SET state = 'mismatch', cause = excluded.cause").run(JSON.stringify(cause)));
    return Object.freeze({ ready: false, code: MISMATCH_CODE, cause });
  }

  return Object.freeze({
    async reconcileStartup() {
      for (let attempt = 1; ; attempt++) {
        let planned;
        try { planned = plan(); } catch (error) { return recordMismatch(error); }
        try { commit(planned); } catch (error) {
          if (error?.code === 'peer_reconciliation_conflict' && attempt < MAX_PLAN_ATTEMPTS) continue;
          throw error;
        }
        return Object.freeze({ ready: true, code: null, cause: null });
      }
    },
  });
}
