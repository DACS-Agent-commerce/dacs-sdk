// With the shipped guard off, `reserveCoordinated` refuses before it
// inspects, classifies, runs a gate, checks the terminal session, reserves or writes; `terminalSession` refuses; and the observation
// adapter reads a terminal name but writes no closure. Prints one line of JSON. The parent starts it without the unshipped guard fixture.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DACS_SELLER_HTTP_PATHS as PATHS, wireOperationId } from '@kynesyslabs/dacs/wire';
import { createPurchaseCapacity } from '../../src/dacs/seller-purchase-capacity.mjs';
import { createReservationCoordinator } from '../../src/dacs/seller-reservation-accounting.mjs';
import { createSellerTransportStore, sellerStoreInternals } from '../../src/dacs/seller-transport-auth.mjs';

let portCalls = 0;
const port = () => { portCalls++; throw new Error('a port was called while the guard is off'); };
const codeOf = (run) => { try { run(); return null; } catch (error) { return error.code; } };

const JOB = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-coordinator-guard-off-')));
const store = createSellerTransportStore({ path: join(directory, 'transport.sqlite'), contextSessionState: () => 'finalised' });
const internals = sellerStoreInternals(store);
const { db } = internals;
const capacity = createPurchaseCapacity({ store, now: port, sessionState: internals.sessionState });
const coordinator = createReservationCoordinator({ accounting: store.reservationAccounting, capacity, inspectOperation: port });
coordinator.addPreAccountingGate(port);
const payload = { path: PATHS.proposals, seller: 'seller', jobId: JOB };
const request = { checked: { reserve: port }, payload, route: payload.path, operationId: wireOperationId(payload), newJob: true, contextStart: false,
  paymentTx: null, keepProfile: {}, retainedWork: false };
const changes = () => db.prepare('SELECT total_changes() AS n').get().n;
const before = changes();
let code = null;
try { await coordinator.reserveCoordinated(request); } catch (error) { code = error.code; }
const terminalSession = codeOf(() => internals.terminalSession(JOB));
const observed = internals.sessionState({ jobId: JOB });
const closures = db.prepare('SELECT COUNT(*) AS n FROM kit_terminal_closures').get().n;
console.log(JSON.stringify({ code, written: changes() - before, portCalls, terminalSession, observed, closures }));
store.close();
