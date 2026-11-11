import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseSync from 'better-sqlite3';
import { sha256Hex } from '@kynesyslabs/dacs';
import { wireOperationBinding, wireOperationId } from '@kynesyslabs/dacs/wire';
import { SellerTransportError } from '../src/dacs/seller-transport-auth.mjs';
import { createSellerTransportStore } from './helpers/bound-transport-store.mjs';
import { T0, JOB, BUYER, SELLER, PIN, CONTEXT, PROPOSALS } from './helpers/reservation-accounting-fixture.mjs';
import { FIXTURE_PROFILE } from './helpers/wire-authority-fixture.mjs';
import { holdReleaseProbes } from './helpers/hold-release-probes.mjs';

// Exercise the actual SQLite owner and accounting port independently of the journal's filesystem capability probe.
// The real-journal suite runs the same probes; these views stand in for the trusted host reader only.
async function accountingFixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'TEST-hold-release-store-'));
  const path = join(dir, 'transport.sqlite'), journal = new Map();
  let time = T0, sequence = 0;
  const now = () => time;
  const readers = { wireOperationView: target => journal.get(wireOperationId(target)) ?? { state: 'none' }, retainsUnfinishedWork: () => false };
  let store = createSellerTransportStore({ path, now, ...readers, ...options });
  const db = new DatabaseSync(path);
  t.after(() => { db.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const payload = (change = {}) => ({ version: '1', kind: 'request', method: 'POST', path: PROPOSALS,
    buyer: BUYER.claim, seller: SELLER.claim, listingPin: PIN, jobId: JOB, agreementHash: sha256Hex('agreement'),
    nonce: Buffer.from(String(++sequence).padStart(24, '0')).toString('base64url'), profile: FIXTURE_PROFILE,
    bodyHash: sha256Hex('{}'), expiresAt: time + 30000, ...change });
  const args = (p = payload(), change = {}) => ({ checked: { reserve: async () => ({ state: 'new' }), body: {} },
    payload: p, route: p.path, operationId: wireOperationId(p), keepProfile: FIXTURE_PROFILE, ...change });
  const admit = async (p = payload()) => args(p, { checked: { body: {}, reserve: async () => {
    const operationId = wireOperationId(p), view = journal.get(operationId);
    if (view && view.binding !== wireOperationBinding(p)) throw new SellerTransportError('peer_operation_mismatch', 409);
    if (view?.state === 'completed') return { state: 'completed', outcome: view.outcome };
    journal.set(operationId, { state: 'pending', binding: wireOperationBinding(p) });
    return { state: 'new', operationId };
  } } });
  const rows = table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return { path, db, journal, now, payload, admit, args,
    admitContext: (p = payload({ path: CONTEXT, agreementHash: sha256Hex('context scope') })) => admit(p),
    reserve: input => store.reservationAccounting.reserveAccounted(input), store: () => store,
    rows: () => rows('kit_reservations'), holds: () => rows('kit_job_holds'), jobRows: () => rows('peer_jobs'),
    files: () => [...journal].map(([id, view]) => JSON.stringify([id, view])).sort(),
    setTime: value => { time = value; },
    reopen: () => { store.close(); store = createSellerTransportStore({ path, now, ...readers, ...options }); },
  };
}

holdReleaseProbes({ accountingFixture, completeWireEffect: (journal, effect, outcome) => {
  journal.set(effect.operationId, { ...journal.get(effect.operationId), state: outcome === null ? 'ended' : 'completed', outcome });
} });
