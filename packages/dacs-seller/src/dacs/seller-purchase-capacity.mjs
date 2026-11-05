// K5's purchase capacity on the transport store's one SQLite owner. An admitted purchase holds one allocation with a slot of 17
// reservation units per route; a charged request spends one unit of its slot, or one general unit, as the accounting row it commits.
// `used` is every accounting row (it never decreases), `allotted` the unspent units of the open slots of live allocations, and
// `free` is what is left of `maxRecords`. Nothing here signs, sends or deletes a journal file.
import { randomUUID } from 'node:crypto';
import { canonicalize, isCanonicalJobId } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_PATHS as PATHS, wireOperationId } from '@kynesyslabs/dacs/wire';
import { SellerTransportError, TERMINAL_CONTEXT_STATES, pinValid, sellerStoreInternals } from './seller-transport-auth.mjs';

const SLOT_UNITS = 17;
const DEFAULT_MAX_RECORDS = 10000;
const STORE_CAPACITY_CODE = 'peer_store_capacity';
const BASE_ROUTES = Object.freeze([PATHS.context, PATHS.proposals, PATHS.commitments, PATHS.payments]);
const OPERATION_STATES = Object.freeze(['none', 'pending', 'ended', 'completed']);
const GENERAL = Object.freeze({ class: 'general' });
const HASH = /^[0-9a-f]{64}$/;
const SCHEMA = `CREATE TABLE IF NOT EXISTS kit_allocations (jobId TEXT PRIMARY KEY, allocationId TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('live', 'released')), rev INTEGER NOT NULL, record TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kit_capacity_exhaustion (allocationId TEXT NOT NULL, route TEXT NOT NULL, operationId TEXT NOT NULL,
    jobId TEXT NOT NULL, cause TEXT NOT NULL, refusals INTEGER NOT NULL, PRIMARY KEY (allocationId, route));
  CREATE INDEX IF NOT EXISTS kit_reservations_allocation ON kit_reservations(allocationId)`;
// A capacity belongs to the one store it was built on; admission asks before it serves.
const owners = new WeakMap();

const isUint = (value) => Number.isSafeInteger(value) && value >= 0;
const fail = (code, status) => { throw new SellerTransportError(code, status); };
const sameParties = (allocation, purchase) => allocation.buyer === purchase.buyer && allocation.seller === purchase.seller
  && canonicalize(allocation.listingPin) === canonicalize(purchase.listingPin);
const unspent = (slot) => (slot.state === 'open' ? Math.max(0, SLOT_UNITS - slot.spent) : 0);
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
function requirePurchase(purchase) {
  if (!isCanonicalJobId(purchase?.jobId) || typeof purchase.buyer !== 'string' || typeof purchase.seller !== 'string' || !pinValid(purchase.listingPin)) {
    throw new TypeError('a purchase is a canonical job, exact buyer and seller strings and a valid Listing pin');
  }
  return purchase;
}

/** Whether `capacity` is the capacity `createPurchaseCapacity` built on `store`. */
export function ownsPurchaseCapacity(store, capacity) {
  return typeof capacity === 'object' && capacity !== null && owners.get(capacity) === store;
}

/**
 * Creates the purchase capacity on `store`'s SQLite owner (one per store and `maxRecords`); `sessionState({ jobId })` is the host's
 * synchronous DACS-5 state reader and `now` its clock. Throws TypeError for an option it cannot use. The `Within` methods run in the
 * store's open transaction and throw TypeError outside it; every snapshot is detached and frozen. A return is a compare-and-swap on the
 * allocation's one revision: it answers the units it freed, and 0 for a stale, repeated or unknown one. Refusals are SellerTransportErrors.
 */
export function createPurchaseCapacity({ store, now, maxRecords = DEFAULT_MAX_RECORDS, commitOnSignature = false, sessionState }) {
  const { db, transaction } = sellerStoreInternals(store);
  if (!isUint(maxRecords) || maxRecords === 0 || typeof commitOnSignature !== 'boolean' || typeof now !== 'function' || typeof sessionState !== 'function') {
    throw new TypeError('purchase capacity needs a positive maxRecords, a boolean commitOnSignature, a clock and a session-state reader');
  }
  const routes = commitOnSignature ? [...BASE_ROUTES, PATHS.commitmentSignature] : BASE_ROUTES;
  db.exec(SCHEMA);

  // The spend of a slot is the purchase-class accounting rows naming it, so a unit is spent in the same commit as its row.
  function snapshot(found) {
    const spent = new Map(db.prepare("SELECT route, COUNT(*) AS n FROM kit_reservations WHERE allocationId = ? AND class = 'purchase' GROUP BY route").all(found.allocationId).map((row) => [row.route, row.n]));
    const stored = JSON.parse(found.record);
    return deepFreeze({ ...stored, state: found.state, rev: found.rev,
      slots: Object.fromEntries(Object.entries(stored.slots).map(([route, state]) => [route, { spent: spent.get(route) ?? 0, state }])) });
  }
  const byJob = (jobId) => { const found = db.prepare('SELECT * FROM kit_allocations WHERE jobId = ?').get(jobId); return found ? snapshot(found) : null; };
  const byId = (allocationId) => { const found = db.prepare('SELECT * FROM kit_allocations WHERE allocationId = ?').get(allocationId); return found ? snapshot(found) : null; };
  const liveAllocations = () => db.prepare("SELECT * FROM kit_allocations WHERE state = 'live'").all().map(snapshot);
  function totals() {
    const used = db.prepare('SELECT COUNT(*) AS n FROM kit_reservations').get().n;
    const allotted = liveAllocations().reduce((sum, row) => sum + Object.values(row.slots).reduce((units, slot) => units + unspent(slot), 0), 0);
    return { used, allotted, free: maxRecords - used - allotted };
  }
  const allotment = () => SLOT_UNITS * routes.length;
  const fitsNewPurchase = () => totals().free >= allotment();
  function requireWithin() {
    if (!db.inTransaction) throw new TypeError('purchase capacity changes run in the store transaction');
  }

  function allocateWithin(purchase) {
    requireWithin();
    requirePurchase(purchase);
    const held = byJob(purchase.jobId);
    if (held !== null) {
      if (!sameParties(held, purchase)) fail('peer_operation_mismatch', 409);
      return held;
    }
    if (!fitsNewPurchase()) fail('seller_not_ready', 503);
    const { jobId, buyer, seller, listingPin } = purchase, allocationId = randomUUID();
    const record = { allocationId, jobId, buyer, seller, listingPin, slots: Object.fromEntries(routes.map((route) => [route, 'open'])) };
    db.prepare("INSERT INTO kit_allocations (jobId, allocationId, state, rev, record) VALUES (?, ?, 'live', 1, ?)").run(jobId, allocationId, JSON.stringify(record));
    return byJob(jobId);
  }
  function allocationWithin(jobId) {
    requireWithin();
    if (!isCanonicalJobId(jobId)) throw new TypeError('an allocation is read by canonical job');
    return byJob(jobId);
  }

  // The route's slot is spendable by an authorized exact-match first execution or by a recovery of an ended or expired attempt.
  function purchaseStage(input, allocation, exactBinding) {
    const slot = allocation?.state === 'live' && sameParties(allocation, input) ? allocation.slots[input.route] : undefined;
    if (!input.retainedWork || slot?.state !== 'open' || slot.spent >= SLOT_UNITS) return false;
    const { inspection } = input;
    if (inspection.state === 'none') return true;
    if (inspection.state === 'ended') return exactBinding;
    return inspection.state === 'pending' && exactBinding && isUint(inspection.leaseUntil) && inspection.leaseUntil <= now();
  }
  function classify(input) {
    const { jobId, route, binding, inspection, retainedWork } = input ?? {};
    requirePurchase(input);
    if (typeof route !== 'string' || !HASH.test(binding) || typeof retainedWork !== 'boolean' || !OPERATION_STATES.includes(inspection?.state)) {
      throw new TypeError('classification needs a route, the binding, an operation view and the retained-work flag');
    }
    const exactBinding = inspection.state !== 'none' && inspection.binding === binding, { free } = totals();
    if (inspection.state === 'completed' && exactBinding && free <= 0) return deepFreeze({ class: 'completed-at-capacity', outcome: structuredClone(inspection.outcome) });
    const allocation = byJob(jobId);
    if (purchaseStage(input, allocation, exactBinding)) return Object.freeze({ class: 'purchase-stage', allocationId: allocation.allocationId, allocationRev: allocation.rev, route });
    if (free < 1) fail(STORE_CAPACITY_CODE, 503);
    return GENERAL;
  }

  // An exhaustion annotation is kept only for a genuine retained operation of a live allocation, at most one per allocation and route.
  function recordExhaustion({ operationId, jobId, route, cause } = {}) {
    if (db.inTransaction) throw new TypeError('an exhaustion record is written after the refused work rolled back');
    if (cause !== STORE_CAPACITY_CODE || !HASH.test(operationId) || !isCanonicalJobId(jobId) || !routes.includes(route)) throw new TypeError('an exhaustion record names a capacity refusal of an enabled route');
    transaction(() => {
      const allocation = byJob(jobId);
      if (allocation?.state !== 'live' || allocation.slots[route].state !== 'open' || operationId !== wireOperationId({ seller: allocation.seller, jobId, path: route }) || totals().free >= 1) return;
      if (!db.prepare('SELECT 1 FROM kit_reservations WHERE jobId = ? AND route = ? AND operationId = ? AND buyer = ? LIMIT 1').get(jobId, route, operationId, allocation.buyer)) return;
      db.prepare(`INSERT INTO kit_capacity_exhaustion (allocationId, route, operationId, jobId, cause, refusals) VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT (allocationId, route) DO UPDATE SET refusals = refusals + 1`).run(allocation.allocationId, route, operationId, jobId, cause);
    });
  }

  // The one compare-and-swap behind both returns: `route` closes that slot, no route closes every open slot and releases the allocation.
  function returnWithin({ allocationId, allocationRev }, route) {
    requireWithin();
    if (typeof allocationId !== 'string' || !isUint(allocationRev)) throw new TypeError('a return names the allocation id and its revision');
    const held = byId(allocationId);
    if (held?.state !== 'live' || held.rev !== allocationRev || (route !== undefined && held.slots[route]?.state !== 'open')) return 0;
    const closing = Object.entries(held.slots).filter(([name, slot]) => slot.state === 'open' && (route === undefined || name === route));
    const closed = new Set(closing.map(([name]) => name));
    const record = { allocationId, jobId: held.jobId, buyer: held.buyer, seller: held.seller, listingPin: held.listingPin,
      slots: Object.fromEntries(Object.entries(held.slots).map(([name, slot]) => [name, closed.has(name) ? 'returned' : slot.state])) };
    const changed = db.prepare('UPDATE kit_allocations SET state = ?, rev = ?, record = ? WHERE allocationId = ? AND rev = ?')
      .run(route === undefined ? 'released' : 'live', allocationRev + 1, JSON.stringify(record), allocationId, allocationRev).changes;
    return changed === 1 ? closing.reduce((units, [, slot]) => units + unspent(slot), 0) : 0;
  }
  function returnRouteSlotWithin(input) {
    if (!routes.includes(input?.route)) throw new TypeError('a slot return names an enabled purchase route');
    return returnWithin(input, input.route);
  }
  const releaseAllWithin = (input) => returnWithin(input);

  // Only a synchronous string is an answer; a throw, a promise or a thenable is unknown (a late rejection is observed, never trusted).
  function sessionName(jobId) {
    try {
      const answer = sessionState({ jobId });
      if (typeof answer?.then === 'function') { void Promise.resolve(answer).then(undefined, () => {}); return null; }
      return typeof answer === 'string' ? answer : null;
    } catch { return null; }
  }
  function releaseTerminalAllocations() {
    if (db.inTransaction) throw new TypeError('terminal cleanup opens its own transaction');
    for (const { jobId } of db.prepare("SELECT jobId FROM kit_allocations WHERE state = 'live'").all()) {
      if (!TERMINAL_CONTEXT_STATES.has(sessionName(jobId))) continue;
      transaction(() => {
        const live = byJob(jobId);
        if (live?.state === 'live') releaseAllWithin({ allocationId: live.allocationId, allocationRev: live.rev });
      });
    }
  }

  function retainedAllocated(input) {
    requirePurchase(input);
    if (typeof input.stageAuthorized !== 'boolean') throw new TypeError('the retained-stage flag needs the host\'s stageAuthorized boolean');
    const allocation = input.stageAuthorized && routes.includes(input.route) ? byJob(input.jobId) : null;
    return allocation?.state === 'live' && sameParties(allocation, input);
  }
  function capacityReport() {
    const { used, allotted, free } = totals();
    const exhausted = db.prepare(`SELECT e.operationId, e.jobId, e.route, e.cause FROM kit_capacity_exhaustion e
      JOIN kit_allocations a ON a.allocationId = e.allocationId WHERE a.state = 'live' ORDER BY a.rowid, e.route`).all().map((row) => ({ ...row }));
    return deepFreeze({ maxRecords, used, allotted, free, allotment: allotment(), ready: free >= allotment(),
      allocations: db.prepare('SELECT * FROM kit_allocations ORDER BY rowid').all().map(snapshot), exhausted });
  }

  const capacity = Object.freeze({ allotment, fitsNewPurchase, allocateWithin, allocationWithin, classify, recordExhaustion,
    returnRouteSlotWithin, releaseAllWithin, releaseTerminalAllocations, retainedAllocated, capacityReport });
  owners.set(capacity, store);
  return capacity;
}
