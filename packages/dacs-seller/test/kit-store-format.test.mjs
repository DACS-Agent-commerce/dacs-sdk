// The transport store's removed tables: a store never creates them, and one that still has them opens only when they are empty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { completeWireEffect, inspectWireOperation } from '@kynesyslabs/dacs/wire';
import { OBSOLETE_TRANSPORT_TABLES } from '../src/dacs/seller-obsolete-store-tables.mjs';
import { createSellerTransportStore } from './helpers/bound-transport-store.mjs';
import { accountingFixture, JOB, JOB2, PIN, SELLER } from './helpers/reservation-accounting-fixture.mjs';

const REMOVED = ['peer_slots', 'peer_transactions', 'peer_nonces', 'peer_nonce_retention', 'kit_context_reservations'];
const REMOVED_INDEXES = ['peer_transactions_job', 'peer_nonces_effect'];
const REMOVED_METHODS = ['reserve', 'finish', 'reconcile', 'resume', 'classify', 'contextAdmission', 'contextAnswer', 'claim', 'assertPending',
  'recoverLostContextReservations'];
const KILL_CHILD = fileURLToPath(new URL('./helpers/obsolete-tables-kill-child.mjs', import.meta.url));
const SOURCE_DIRECTORY = fileURLToPath(new URL('../src/', import.meta.url));
const CLEANUP_MODULE = 'dacs/seller-obsolete-store-tables.mjs';
const ANSWER = { status: 200, text: '{"proposal":"kept"}' };
const refused = (code) => ({ code });

// The tables and indexes an earlier store created at every open, as that store's schema text had them.
const REMOVED_SCHEMA = `
  CREATE TABLE peer_slots (slot TEXT PRIMARY KEY, effect TEXT NOT NULL);
  CREATE TABLE peer_transactions (tx TEXT PRIMARY KEY, job TEXT NOT NULL, effect TEXT NOT NULL);
  CREATE TABLE peer_nonces (nonce TEXT PRIMARY KEY, request_hash TEXT NOT NULL, effect TEXT NOT NULL, status INTEGER, response TEXT);
  CREATE TABLE peer_nonce_retention (nonce TEXT PRIMARY KEY, buyer TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE kit_context_reservations (effect TEXT PRIMARY KEY, nonce TEXT NOT NULL UNIQUE, accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)));
  CREATE INDEX peer_transactions_job ON peer_transactions(job);
  CREATE INDEX peer_nonces_effect ON peer_nonces(effect);`;

const schemaOf = (db) => db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
const namesOf = (db) => schemaOf(db).map((row) => row.name);
const fileHash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const journalBytes = (f) => Object.fromEntries(f.files().map((name) => [name, readFileSync(join(f.journalDir, name), 'utf8')]));

/** Every row of every table except the removed ones, so a test can show the kept state did not change. */
function keptRows(db) {
  const tables = schemaOf(db).filter((row) => row.type === 'table' && !REMOVED.includes(row.name)).map((row) => row.name);
  return Object.fromEntries(tables.map((name) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
}

/** A fixture whose store holds an accounted proposal with a completed answer, plus the removed tables left empty by an earlier store. */
async function earlierStoreFixture(t, options) {
  const f = await accountingFixture(t, options);
  f.store().bind({ seller: SELLER.claim, listingPin: PIN });
  const input = await f.admit();
  completeWireEffect(f.journal, await f.reserve(input), ANSWER);
  f.db.exec(REMOVED_SCHEMA);
  return { f, input };
}

test('the kit store has none of the removed tables and exposes no journal method', async (t) => {
  const f = await accountingFixture(t);
  const names = namesOf(f.db);
  for (const name of [...REMOVED, ...REMOVED_INDEXES]) assert.equal(names.includes(name), false, `${name} is not created`);
  for (const method of REMOVED_METHODS) assert.equal(method in f.store(), false, `the store has no ${method}`);
});

test('job and buyer-window capacity and payment claims hold with the removed tables gone', async (t) => {
  const jobs = await accountingFixture(t, { maxJobs: 1 });
  await jobs.reserve(jobs.args());
  await assert.rejects(jobs.reserve(jobs.args(jobs.payload({ jobId: JOB2 }))), refused('peer_job_capacity'));
  const window = await accountingFixture(t, { maxNoncesPerBuyerPerWindow: 1 });
  await window.reserve(window.args());
  await assert.rejects(window.reserve(window.args()), refused('peer_buyer_nonce_limit'));
  const claims = await accountingFixture(t);
  await claims.reserve(await claims.payment(JOB));
  assert.equal(claims.payments().length, 1);
  for (const f of [jobs, window, claims]) assert.deepEqual(namesOf(f.db).filter((name) => REMOVED.includes(name)), []);
});

test('the cleanup list names exactly the removed tables', () => {
  assert.deepEqual([...OBSOLETE_TRANSPORT_TABLES].sort(), [...REMOVED].sort());
});

test('no old transport-store journal method, definition or caller remains, and removed table names appear only in the cleanup module', async (t) => {
  const f = await accountingFixture(t);
  const kept = ['peer_meta', 'peer_jobs', 'peer_effects', 'peer_effect_jobs'];
  const tables = schemaOf(f.db).filter((row) => row.type === 'table').map((row) => row.name);
  assert.deepEqual(tables.filter((name) => name.startsWith('peer_')).sort(), [...kept.filter((name) => name.startsWith('peer_'))].sort());
  for (const method of [...REMOVED_METHODS, 'journaledOnlyReserve']) assert.equal(Object.hasOwn(f.store(), method), false, `the store has no ${method}`);
  const sources = readdirSync(SOURCE_DIRECTORY, { recursive: true }).filter((name) => name.endsWith('.mjs'));
  const mentioning = sources.filter((name) => REMOVED.some((table) => readFileSync(join(SOURCE_DIRECTORY, name), 'utf8').includes(table)));
  assert.deepEqual(mentioning, [CLEANUP_MODULE]);
  const cleanup = readFileSync(join(SOURCE_DIRECTORY, CLEANUP_MODULE), 'utf8');
  assert.equal(/CREATE\s+(TABLE|INDEX)/i.test(cleanup), false, 'the cleanup creates nothing');
});

test('opening, closing and reopening a store in this format twice creates no table and keeps its binding', async (t) => {
  const f = await accountingFixture(t);
  f.store().bind({ seller: SELLER.claim, listingPin: PIN });
  const schema = schemaOf(f.db), meta = f.db.prepare('SELECT * FROM peer_meta').all();
  assert.equal(meta.length, 1);
  for (let reopen = 0; reopen < 2; reopen++) {
    f.reopen();
    assert.deepEqual(schemaOf(f.db), schema);
    assert.deepEqual(f.db.prepare('SELECT * FROM peer_meta').all(), meta);
  }
  f.store().bind({ seller: SELLER.claim, listingPin: PIN });
});

test('a store in an earlier format is refused at bind and its removed tables and rows are left untouched', async (t) => {
  for (const config of [JSON.stringify({ storeVersion: '0', seller: SELLER.claim, listingPin: PIN }), 'not json']) {
    const { f } = await earlierStoreFixture(t);
    f.db.prepare("UPDATE peer_meta SET value = ? WHERE key = 'config'").run(config);
    f.store().close();
    const schema = schemaOf(f.db), rows = keptRows(f.db), hash = fileHash(f.path);
    f.reopen();
    assert.throws(() => f.store().bind({ seller: SELLER.claim, listingPin: PIN }), /belongs to another seller, Listing or schema/);
    assert.deepEqual(schemaOf(f.db), schema, 'the removed tables stay');
    assert.deepEqual(keptRows(f.db), rows);
    f.store().close();
    assert.equal(fileHash(f.path), hash, 'the store file is byte-identical');
  }
});

test('a store created before the removal, with accounted purchases and a completed wire outcome, opens with the empty removed tables dropped; two more reopens change nothing', async (t) => {
  const { f, input } = await earlierStoreFixture(t);
  assert.equal(f.jobRows().length, 1, 'the accounted proposal kept its job row');
  assert.deepEqual(REMOVED.filter((name) => !namesOf(f.db).includes(name)), []);
  const rows = keptRows(f.db), files = journalBytes(f), meta = f.db.prepare('SELECT * FROM peer_meta').all();
  f.reopen();
  const names = namesOf(f.db);
  for (const name of [...REMOVED, ...REMOVED_INDEXES]) assert.equal(names.includes(name), false, `${name} is dropped`);
  const schema = schemaOf(f.db);
  for (let reopen = 0; reopen < 3; reopen++) {
    if (reopen > 0) f.reopen();
    assert.deepEqual(schemaOf(f.db), schema);
    assert.deepEqual(keptRows(f.db), rows);
    assert.deepEqual(f.db.prepare('SELECT * FROM peer_meta').all(), meta);
    assert.deepEqual(journalBytes(f), files);
    assert.equal(inspectWireOperation(f.journal, input.payload).state, 'completed');
  }
});

test('a row in a removed table refuses startup and leaves the store untouched', async (t) => {
  for (const table of REMOVED) {
    const { f } = await earlierStoreFixture(t);
    const row = { peer_slots: "('j:p', 'e')", peer_transactions: "('t', 'j', 'e')", peer_nonces: "('n', 'h', 'e', NULL, NULL)", peer_nonce_retention: "('n', 'b', 1, 2)",
      kit_context_reservations: "('e', 'n', 1)" }[table];
    f.db.exec(`INSERT INTO ${table} VALUES ${row}`);
    f.store().close();
    const schema = schemaOf(f.db), rows = keptRows(f.db), files = journalBytes(f), hash = fileHash(f.path);
    assert.throws(() => createSellerTransportStore({ path: f.path, now: f.now }), (error) => error.code === 'kit_store_format_unsupported' && error.message.includes(table));
    assert.deepEqual(schemaOf(f.db), schema);
    assert.deepEqual(keptRows(f.db), rows);
    assert.deepEqual(journalBytes(f), files);
    assert.equal(fileHash(f.path), hash, 'the store file is byte-identical');
  }
});

test('a refused startup names every removed table that has rows', async (t) => {
  const { f } = await earlierStoreFixture(t);
  f.db.exec("INSERT INTO peer_slots VALUES ('j:p', 'e'); INSERT INTO peer_nonce_retention VALUES ('n', 'b', 1, 2)");
  f.store().close();
  assert.throws(() => createSellerTransportStore({ path: f.path, now: f.now }), (error) => error.code === 'kit_store_format_unsupported' && /peer_slots/.test(error.message) && /peer_nonce_retention/.test(error.message) && !/peer_nonces\b/.test(error.message));
});

test('a kill between dropping the removed tables and committing leaves all of them, and the next open completes the removal', async (t) => {
  const { f, input } = await earlierStoreFixture(t);
  const rows = keptRows(f.db), files = journalBytes(f);
  f.store().close();
  const child = spawnSync(process.execPath, [KILL_CHILD, f.path, 'before-commit', '1'], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.deepEqual(REMOVED.filter((name) => !namesOf(f.db).includes(name)), [], 'every removed table is still there');
  assert.deepEqual(REMOVED_INDEXES.filter((name) => !namesOf(f.db).includes(name)), []);
  assert.deepEqual(keptRows(f.db), rows);
  f.reopen();
  assert.deepEqual(namesOf(f.db).filter((name) => REMOVED.includes(name)), []);
  assert.deepEqual(keptRows(f.db), rows);
  assert.deepEqual(journalBytes(f), files);
  assert.equal(inspectWireOperation(f.journal, input.payload).state, 'completed');
});

test('a kill right after the removal commits leaves the tables gone, and later opens create none and keep the binding and the answer', async (t) => {
  const { f, input } = await earlierStoreFixture(t);
  const rows = keptRows(f.db), files = journalBytes(f), meta = f.db.prepare('SELECT * FROM peer_meta').all();
  f.store().close();
  const child = spawnSync(process.execPath, [KILL_CHILD, f.path, 'after-commit', '1'], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.deepEqual(namesOf(f.db).filter((name) => [...REMOVED, ...REMOVED_INDEXES].includes(name)), []);
  const schema = schemaOf(f.db);
  for (let reopen = 0; reopen < 2; reopen++) {
    f.reopen();
    assert.deepEqual(schemaOf(f.db), schema);
    assert.deepEqual(keptRows(f.db), rows);
    assert.deepEqual(f.db.prepare('SELECT * FROM peer_meta').all(), meta);
    assert.deepEqual(journalBytes(f), files);
  }
  f.store().bind({ seller: SELLER.claim, listingPin: PIN });
  assert.equal(inspectWireOperation(f.journal, input.payload).state, 'completed');
});
