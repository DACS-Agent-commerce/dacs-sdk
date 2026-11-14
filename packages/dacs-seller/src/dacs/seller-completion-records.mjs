// What an ordinary route's completed attempt leaves in the transport store: one completion record, and the purchase capacity its
// receipt holds, returned in the same transaction. Nothing here signs, sends or touches the wire journal.
import { wireOperationId } from '@kynesyslabs/dacs/wire';
import { SellerTransportError, sellerStoreInternals } from './seller-transport-auth.mjs';

const COMPLETION_TABLE = 'kit_ordinary_completions';
const SCHEMA = `CREATE TABLE IF NOT EXISTS ${COMPLETION_TABLE} (operationId TEXT NOT NULL, attempt INTEGER NOT NULL, requestHash TEXT NOT NULL,
  route TEXT NOT NULL, status INTEGER NOT NULL, cleanup TEXT NOT NULL CHECK (cleanup IN ('route', 'purchase-final')), PRIMARY KEY (operationId, attempt))`;

// The allocation belongs to the receipt's request when its buyer and its own seller derive the receipt's operation.
const sameParties = (allocation, held) => allocation.buyer === held.buyer
  && wireOperationId({ seller: allocation.seller, jobId: held.jobId, path: held.route }) === held.operationId;

/**
 * Creates the completion records on `store`'s SQLite owner and its `capacity` (built on that store). Returns two functions.
 * `reservationRow(key)` reads the accounting row committed for a request's nonce key, or undefined.
 * `complete(held, { status, cleanup })` runs in one transaction: it records the completion once per operation and attempt, returns the
 * route's slot for a purchase-stage receipt, and for `cleanup: 'purchase-final'` then releases what is left of the matching allocation.
 * `held` is the receipt's retained identity: operationId, attempt, requestHash, jobId, buyer, route and capacityClass.
 * A missing, released or already returned allocation changes nothing. `complete` throws SellerTransportError wire_input_invalid (500)
 * when a purchase-stage receipt's allocation is another one or belongs to other parties; the transaction then rolls back whole.
 */
export function createCompletionRecords({ store, capacity }) {
  const { db, transaction } = sellerStoreInternals(store);
  db.exec(SCHEMA);
  const readRow = db.prepare('SELECT buyer, jobId, route, operationId, allocationId, class, requestHash, state FROM kit_reservations WHERE key = ?');
  const record = db.prepare(`INSERT OR IGNORE INTO ${COMPLETION_TABLE} (operationId, attempt, requestHash, route, status, cleanup) VALUES (?, ?, ?, ?, ?, ?)`);

  function returnRouteSlotWithin(held) {
    const allocation = capacity.allocationWithin(held.jobId);
    if (allocation === null) return;
    if (allocation.allocationId !== held.capacityClass.allocationId || !sameParties(allocation, held)) throw new SellerTransportError('wire_input_invalid', 500);
    if (allocation.state === 'live') capacity.returnRouteSlotWithin({ allocationId: allocation.allocationId, route: held.route, allocationRev: allocation.rev });
  }
  // Read again after the route's return: that return advanced the allocation's one revision.
  function releaseRemainingWithin(held) {
    const allocation = capacity.allocationWithin(held.jobId);
    if (allocation?.state === 'live' && sameParties(allocation, held)) capacity.releaseAllWithin({ allocationId: allocation.allocationId, allocationRev: allocation.rev });
  }

  return {
    reservationRow: (key) => readRow.get(key),
    complete: (held, { status, cleanup }) => transaction(() => {
      record.run(held.operationId, held.attempt, held.requestHash, held.route, status, cleanup);
      if (held.capacityClass.class === 'purchase-stage') returnRouteSlotWithin(held);
      if (cleanup === 'purchase-final') releaseRemainingWithin(held);
    }),
  };
}
