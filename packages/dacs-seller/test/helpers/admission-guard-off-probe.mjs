// Child process for context-admission-transaction.test.mjs (P09b-T30): with the shipped guard off, `begin` and `compensate` refuse
// before any store write or port call. Prints one line of JSON. The parent starts it without the unshipped guard fixture.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContextAdmissionTransaction } from '../../src/dacs/seller-admission-transaction.mjs';
import { createPurchaseCapacity } from '../../src/dacs/seller-purchase-capacity.mjs';
import { createSellerTransportStore, sellerStoreInternals } from '../../src/dacs/seller-transport-auth.mjs';
import assert from 'node:assert/strict';

let portCalls = 0;
const port = () => { portCalls++; throw new Error('a port was called while the guard is off'); };
const refusalCode = async (run) => { try { await run(); return null; } catch (error) { return error.code; } };

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-admission-guard-off-')));
const store = createSellerTransportStore({ path: join(directory, 'transport.sqlite') });
const { db } = sellerStoreInternals(store);
const capacity = createPurchaseCapacity({ store, now: port, sessionState: sellerStoreInternals(store).sessionState });
const admission = createContextAdmissionTransaction({ store, capacity, policy: { reserve: port, release: port }, effectEvidence: port, inspectContextOutcome: port,
  completeWire: port, now: port, ready: port, deadlines: { policyMs: 10000 } });
const changes = () => db.prepare('SELECT total_changes() AS n').get().n;
const before = changes();
const begin = await refusalCode(() => admission.begin({}));
assert.throws(() => admission.addAcceptanceHook(() => {}), TypeError, 'the first guard check seals hooks even when begin is refused');
const compensate = await refusalCode(() => admission.compensate('01ARZ3NDEKTSV4RRFFQ69G5FAW', 'd'));
console.log(JSON.stringify({ begin, compensate, written: changes() - before, portCalls }));
store.close();
