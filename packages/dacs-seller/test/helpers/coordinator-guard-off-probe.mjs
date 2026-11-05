// Child process for purchase-capacity.test.mjs (P11b2-T19): with the shipped guard off, `reserveCoordinated` refuses before it
// inspects, classifies, reserves or writes. Prints one line of JSON. The parent starts it without the unshipped guard fixture.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DACS_SELLER_HTTP_PATHS as PATHS, wireOperationId } from '@kynesyslabs/dacs/wire';
import { createPurchaseCapacity } from '../../src/dacs/seller-purchase-capacity.mjs';
import { createReservationCoordinator } from '../../src/dacs/seller-reservation-accounting.mjs';
import { createSellerTransportStore, sellerStoreInternals } from '../../src/dacs/seller-transport-auth.mjs';

let portCalls = 0;
const port = () => { portCalls++; throw new Error('a port was called while the guard is off'); };

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-coordinator-guard-off-')));
const store = createSellerTransportStore({ path: join(directory, 'transport.sqlite') });
const { db } = sellerStoreInternals(store);
const capacity = createPurchaseCapacity({ store, now: port, sessionState: port });
const coordinator = createReservationCoordinator({ accounting: store.reservationAccounting, capacity, inspectOperation: port });
const payload = { path: PATHS.proposals, seller: 'seller', jobId: '01ARZ3NDEKTSV4RRFFQ69G5FAW' };
const request = { checked: { reserve: port }, payload, route: payload.path, operationId: wireOperationId(payload), newJob: true, contextStart: false,
  paymentTx: null, keepProfile: {}, retainedWork: false };
const changes = () => db.prepare('SELECT total_changes() AS n').get().n;
const before = changes();
let code = null;
try { await coordinator.reserveCoordinated(request); } catch (error) { code = error.code; }
console.log(JSON.stringify({ code, written: changes() - before, portCalls }));
store.close();
