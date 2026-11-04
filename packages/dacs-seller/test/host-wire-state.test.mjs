// P10: the seller host binds the SDK's approved testnet record before it opens
// anything, opens the wire request journal with a 300 s lease, refuses a data
// directory from an older kit format, and the transport store keeps each
// purchase's TP-1 tuple inside the transaction that admits its job.
//
// Journal-opening cases need a runner where `/` is root-owned (K5-J0).
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import DatabaseSync from 'better-sqlite3';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { TP1_APPROVED_IDENTITY_RECORD, TP1_BASE_REVISION, TP1_PROFILE_ID, TP1_PROFILE_REVISION, assertTp1Binding } from '@kynesyslabs/dacs/wire';
import { journalStore, reserveEffect } from '../../../dist/wire/journal.js';
import { commitmentFixture } from './helpers/commitment-fixture.mjs';
import { JOBS, T, exchange, presentContext, world } from './helpers/d5-http-fixture.mjs';
import { privateModule } from './helpers/private-module.mjs';
import { NOW } from './helpers/protocol-fixture.mjs';
import { TEST_CONNECTION, authorityReader, testNetwork } from './helpers/wire-authority-fixture.mjs';
import { DURABLE_SYNC, syncDirectory } from '../src/devnet-demo/durable-file.mjs';
import { KIT_DATA_FORMAT } from '../src/dacs/kit-data-format.mjs';
import { boundedCall } from '../src/dacs/bounded-call.mjs';
import { createSellerTransportClientAuth, createSellerTransportStore } from '../src/dacs/seller-transport-auth.mjs';

const HOST_URL = new URL('../src/host.mjs', import.meta.url);
const PACKAGE_DIRECTORY = fileURLToPath(new URL('../', import.meta.url));
const GUARD_FIXTURE = 'kit-guard-fixture.mjs';
const MARKER_FILE = 'kit-format.json';
const STATE_ENTRIES = ['seller', 'transport', 'wire-journal'];
const JOURNAL_DIRECTORY = 'wire-journal';
const LOCK_FILE_PREFIX = 'seller-state.lock';
const STORE_FILE = join('transport', 'transport.sqlite');
const LEASE_MS = 300000;
const AUTHORITY_DEADLINE_MS = 10000;
const SYNC_FAILURE = 'TEST durable sync failure';
const FORMAT_REFUSED = 'kit_store_format_unsupported';
const ACCOUNTING_MISMATCH = 'kit_journal_accounting_mismatch';
const PROPOSALS = '/dacs/v1/agreements/proposals';
const MISMATCH = { code: 'tp1_purchase_profile_mismatch', status: 500 };
const MARKER_TEXT = `${JSON.stringify({ format: KIT_DATA_FORMAT })}\n`;

const flush = () => new Promise((resolve) => setImmediate(resolve));
const derive = (label) => createHash('sha256').update(String(label)).digest('hex');
const claim = (label) => `did:demos:agent:${derive(label)}`;
const jobId = (label) => `0${derive(`job-${label}`).slice(0, 25).toUpperCase()}`;
const namesIn = (directory) => readdirSync(directory).sort();
const ownLockFile = (name) => name.startsWith(LOCK_FILE_PREFIX) || name.startsWith('holders');
const sub = (source, from, to) => {
  assert.ok(from instanceof RegExp ? from.test(source) : source.includes(from), `host source contains ${from}`);
  return source.replace(from, to);
};

// ---------------------------------------------------------------- the host

// The host with two test seams that add no runtime API: the durable-sync steps
// it takes, and the frozen wire context it keeps for the signed routes.
async function hostFixture(t) {
  const f = await commitmentFixture(t);
  const dataDirectory = await mkdtemp(join(tmpdir(), 'TEST-host-wire-state-'));
  const { nativeArtifactAnchor, ...config } = f.config;
  delete config.challengeLedger; // the host builds its own ledger
  delete config.durableDirectory;
  delete config.commitOnSignature;
  const api = await privateModule(HOST_URL, ['setTestSync', 'setTestWire'], (source) => {
    let text = sub(source, "import { DURABLE_SYNC } from './devnet-demo/durable-file.mjs';",
      "import { DURABLE_SYNC as REAL_DURABLE_SYNC } from './devnet-demo/durable-file.mjs';\nlet DURABLE_SYNC = REAL_DURABLE_SYNC; function setTestSync(value) { DURABLE_SYNC = value; }");
    text = sub(text, 'const REQUIRED =', 'let testWire = () => {}; function setTestWire(value) { testWire = value; }\nconst REQUIRED =');
    return sub(text, /(\n\s*)const authentication = createSellerTransportServerAuth\(/, '$1testWire(wire);$1const authentication = createSellerTransportServerAuth(');
  });
  // The private module is one cached instance for every fixture: each fixture starts from the real sync steps.
  api.setTestSync(DURABLE_SYNC);
  const wires = [];
  api.setTestWire((wire) => wires.push(wire));
  const hosts = [];
  const options = { ...config, artifactAnchor: nativeArtifactAnchor, dataDirectory, tp1Network: testNetwork(), now: () => NOW };
  const start = async (changes = {}) => {
    const host = await api.startSellerHost({ ...options, ...changes });
    hosts.push(host);
    return host;
  };
  t.after(async () => {
    chmodSync(dataDirectory, 0o700);
    for (const host of hosts) await host.close().catch(() => {});
    await rm(dataDirectory, { recursive: true, force: true });
  });
  return { start, options, dataDirectory, wires, useSync: api.setTestSync, path: (...names) => join(dataDirectory, ...names) };
}

const lockReleased = (f) => assert.deepEqual(namesIn(f.dataDirectory).filter((name) => name.startsWith(LOCK_FILE_PREFIX)), [], 'the state lock is released');
const writeMarker = (f) => writeFileSync(f.path(MARKER_FILE), MARKER_TEXT, { mode: 0o600 });
const makePrivateDirectory = (path) => { mkdirSync(path, { mode: 0o700 }); chmodSync(path, 0o700); return path; };
const rejection = async (promise) => { try { await promise; } catch (error) { return error; } return assert.fail('expected a rejection'); };

// Records each durable-sync step with the directory listing at that moment.
// `throwAt` (1-based) fails that step, before it syncs or, with `after`, once it has.
function recordingSync(f, log, { throwAt = 0, after = false } = {}) {
  let calls = 0;
  const step = async (kind, path, sync) => {
    log.push({ kind, path, entries: namesIn(f.dataDirectory) });
    const failing = ++calls === throwAt;
    if (failing && !after) throw new Error(SYNC_FAILURE);
    await sync();
    if (failing) throw new Error(SYNC_FAILURE);
  };
  return Object.freeze({
    file: (handle, path) => step('file', path, () => handle.sync()),
    directory: (path) => step('directory', path, () => syncDirectory(path)),
  });
}

// Puts a 'listen' event in the log, so syncs can be ordered against opening the listener.
function recordListen(log) {
  const original = Server.prototype.listen;
  return mock.method(Server.prototype, 'listen', function listen(...args) { log.push({ kind: 'listen' }); return original.apply(this, args); });
}

// SA-6 / P10-T07: marker file, then its parent, then each state directory's parent, all before listen.
function assertDurableOrder(log, dataDirectory) {
  const markerFile = log.findIndex((event) => event.kind === 'file' && dirname(event.path) === dataDirectory);
  assert.ok(markerFile >= 0, 'the marker file is synced');
  const markerParent = log.findIndex((event, index) => index > markerFile && event.kind === 'directory' && event.path === dataDirectory && event.entries.includes(MARKER_FILE));
  assert.ok(markerParent > markerFile, 'the marker file is synced before its parent directory');
  assert.deepEqual(log[markerParent].entries.filter((name) => STATE_ENTRIES.includes(name)), [], 'the marker is durable before any state directory is created');
  const listening = log.findIndex((event) => event.kind === 'listen');
  assert.ok(listening > markerParent, 'the listener opens last');
  for (const entry of STATE_ENTRIES) {
    const synced = log.findIndex((event, index) => index > markerParent && event.kind === 'directory' && event.path === dataDirectory && event.entries.includes(entry));
    assert.ok(synced > markerParent && synced < listening, `${entry}/ is named durably in dataDirectory before listening`);
  }
}

// ---------------------------------------------------------------- the store

const PROFILE = Object.freeze({ id: TP1_PROFILE_ID, revision: TP1_PROFILE_REVISION, base: TP1_BASE_REVISION,
  chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, pinVersion: TP1_APPROVED_IDENTITY_RECORD.pinVersion });
const OTHER_PROFILE = Object.freeze({ ...PROFILE, pinVersion: 'dacs-demos-testnet-identity/other-pin' });

function storeFixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'TEST-host-wire-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'transport.sqlite');
  let time = T;
  const buyer = claim('buyer');
  const seller = claim('seller');
  let store;
  const reopen = () => { store?.close(); store = createSellerTransportStore({ path, now: () => time, ...options }); return store; };
  reopen();
  t.after(() => store.close());
  const query = (sql) => { const db = new DatabaseSync(path, { readonly: true }); try { return db.prepare(sql).get().n; } finally { db.close(); } };
  const request = (id, overrides = {}) => ({ version: '1', kind: 'request', method: 'POST', path: PROPOSALS, bodyHash: derive('body'), jobId: id, buyer, seller,
    listingPin: { listingId: 'wire-state', version: 1, contentHash: derive('pin') }, agreementHash: derive('agreement'), nonce: randomBytes(16).toString('base64url'),
    expiresAt: time + 30000, ...overrides });
  return { path, request, reopen, buyer, seller, query, get store() { return store; }, advance: (ms) => { time += ms; },
    tuples: () => query('SELECT COUNT(*) AS n FROM kit_purchase_profiles'), jobs: () => query('SELECT COUNT(*) AS n FROM peer_jobs'),
    nonces: () => query('SELECT COUNT(*) AS n FROM peer_nonces') };
}

// ================================================================ host tests

test('P10-T01 start creates a private, owned, real-path journal directory, opens it with the 300 s lease and leaves no probe files', async (t) => {
  const f = await hostFixture(t);
  const host = await f.start();
  const journal = f.path(JOURNAL_DIRECTORY);
  const stat = lstatSync(journal);
  assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true);
  assert.equal(stat.mode & 0o777, 0o700);
  assert.equal(stat.uid, process.getuid());
  assert.equal(realpathSync(journal), journal);
  assert.deepEqual(namesIn(journal), [], 'the open leaves no probe file');
  const [{ journal: opened }] = f.wires;
  assert.equal(opened.directory, journal);
  const reservation = { key: derive('key-1'), seller: claim('seller'), jobId: jobId(1), path: PROPOSALS, binding: derive('binding'), requestHash: derive('request') };
  const first = reserveEffect(journalStore(opened), reservation);
  assert.deepEqual({ state: first.state, leaseUntil: first.leaseUntil }, { state: 'new', leaseUntil: NOW + LEASE_MS }, 'the lease is 300 s on the host clock');
  await host.close();
});

test('P10-T02 a journal path that is a symlink, a file or group-writable refuses start with its detail and releases the lock', async (t) => {
  const cases = [
    ['a symlink', (f) => symlinkSync(makePrivateDirectory(f.path('elsewhere')), f.path(JOURNAL_DIRECTORY)), 'DIRECTORY-MISSING'],
    ['a file', (f) => writeFileSync(f.path(JOURNAL_DIRECTORY), 'TEST'), 'DIRECTORY-MISSING'],
    ['group-writable', (f) => { makePrivateDirectory(f.path(JOURNAL_DIRECTORY)); chmodSync(f.path(JOURNAL_DIRECTORY), 0o770); }, 'DIRECTORY-UNSAFE'],
  ];
  for (const [label, plant, detail] of cases) {
    await t.test(label, async (subtest) => {
      const f = await hostFixture(subtest);
      writeMarker(f);
      plant(f);
      const error = await rejection(f.start());
      assert.equal(error.code, 'seller_replay_guard_invalid');
      assert.equal(error.detail, detail);
      lockReleased(f);
    });
  }
});

test('P10-T03 a restart reopens the same journal; a second run is refused on the state lock before the journal opens', async (t) => {
  const f = await hostFixture(t);
  const log = [];
  const first = await f.start();
  const reservation = { key: derive('key-1'), seller: claim('seller'), jobId: jobId(1), path: PROPOSALS, binding: derive('binding'), requestHash: derive('request') };
  assert.equal(reserveEffect(journalStore(f.wires[0].journal), reservation).state, 'new');
  const filesBefore = namesIn(f.path(JOURNAL_DIRECTORY));
  f.useSync(recordingSync(f, log));
  assert.equal((await rejection(f.start())).code, 'seller_state_locked');
  assert.deepEqual(log, [], 'the refused run synced and created nothing');
  assert.deepEqual(namesIn(f.path(JOURNAL_DIRECTORY)), filesBefore, 'the journal was not touched');
  await first.close();
  const inode = statSync(f.path(JOURNAL_DIRECTORY)).ino;
  await f.start();
  assert.equal(statSync(f.path(JOURNAL_DIRECTORY)).ino, inode, 'the restart reopens the same directory');
  const another = { ...reservation, key: derive('key-2') };
  assert.equal((await rejection(Promise.resolve().then(() => reserveEffect(journalStore(f.wires[1].journal), another)))).code, 'seller_effect_pending', 'the reopened journal still holds the first attempt');
});

test('P10-T04 a journal open failure closes the agent and store and reports the original cause', async (t) => {
  const f = await hostFixture(t);
  writeMarker(f);
  makePrivateDirectory(f.path(JOURNAL_DIRECTORY));
  chmodSync(f.path(JOURNAL_DIRECTORY), 0o770);
  const original = DatabaseSync.prototype.close;
  const closed = [];
  mock.method(DatabaseSync.prototype, 'close', function close() { closed.push(this.name); return original.call(this); });
  const error = await rejection(f.start());
  mock.restoreAll();
  assert.equal(error.code, 'seller_replay_guard_invalid');
  assert.equal(error.detail, 'DIRECTORY-UNSAFE');
  assert.ok(closed.includes(f.path(STORE_FILE)), 'the transport store was closed');
  assert.ok(closed.some((path) => path.startsWith(f.path('seller'))), 'the agent state was closed');
  lockReleased(f);
});

test('P10-T05 a data directory from the previous kit format is refused with no application-state mutation; the lock\'s own files are allowed', async (t) => {
  const f = await hostFixture(t);
  for (const name of ['seller', 'transport']) { makePrivateDirectory(f.path(name)); writeFileSync(f.path(name, 'previous-format.db'), `TEST ${name}`); }
  const snapshot = () => readdirSync(f.dataDirectory, { recursive: true }).filter((name) => !ownLockFile(name)).sort()
    .map((name) => [name, lstatSync(f.path(name)).isFile() ? readFileSync(f.path(name), 'utf8') : null, lstatSync(f.path(name)).mtimeMs]);
  const before = snapshot();
  const error = await rejection(f.start());
  assert.equal(error.code, FORMAT_REFUSED);
  assert.equal(error.reason, 'missing-marker');
  assert.deepEqual(snapshot(), before, 'nothing but the lock\'s own files changed');
  assert.equal(existsSync(f.path(MARKER_FILE)), false, 'no marker was written over old state');
  lockReleased(f);
});

test('P10-T06 an unknown, unreadable or directory-shaped format marker is refused with its cause', async (t) => {
  const cases = [
    ['another format value', (f) => writeFileSync(f.path(MARKER_FILE), '{"format":"dacs-kit-data/tp1-0"}\n'), 'unknown-format'],
    ['an extra field', (f) => writeFileSync(f.path(MARKER_FILE), `{"format":"${KIT_DATA_FORMAT}","extra":1}\n`), 'unknown-format'],
    ['malformed JSON', (f) => writeFileSync(f.path(MARKER_FILE), '{"format"'), 'unknown-format'],
    ['an empty file', (f) => writeFileSync(f.path(MARKER_FILE), ''), 'unknown-format'],
    ['an oversized file', (f) => writeFileSync(f.path(MARKER_FILE), 'x'.repeat(1 << 20)), 'unknown-format'],
    ['a directory', (f) => mkdirSync(f.path(MARKER_FILE)), 'unknown-format'],
    ['a symlink to a valid marker', (f) => { writeFileSync(f.path('elsewhere.json'), MARKER_TEXT); symlinkSync(f.path('elsewhere.json'), f.path(MARKER_FILE)); }, 'unknown-format'],
    ['an unreadable file', (f) => { writeMarker(f); chmodSync(f.path(MARKER_FILE), 0o000); }, 'unreadable'],
  ];
  for (const [label, plant, reason] of cases) {
    await t.test(label, { skip: label === 'an unreadable file' && process.getuid() === 0 }, async (subtest) => {
      const f = await hostFixture(subtest);
      plant(f);
      const error = await rejection(f.start());
      assert.equal(error.code, FORMAT_REFUSED);
      assert.equal(error.reason, reason);
      if (reason === 'unreadable') assert.equal(error.cause.code, 'EACCES', 'the read error is the cause');
      assert.deepEqual(namesIn(f.dataDirectory).filter((name) => STATE_ENTRIES.includes(name)), [], 'no state was created');
      lockReleased(f);
    });
  }
});

test('P10-T07 table: newly created state entry (marker, seller/, transport/, wire-journal/) × normal start, omitted sync, sync failure, crash after each sync, restart. Through the injected sync seam, record marker-file sync then marker-parent sync; for each state-directory creation require dataDirectory sync after creation and before listener open. Omission fails the order assertion; a sync error prevents serving and releases resources. Each crash cut restarts safely, existing entries are not recreated, and the marker is never rewritten; directory creation order may follow P09a2b\'s store-before-agent reorder while preserving each create→parent-sync edge', async (t) => {
  const normal = async (subtest) => {
    const f = await hostFixture(subtest);
    const log = [];
    const listen = recordListen(log);
    f.useSync(recordingSync(f, log));
    const host = await f.start();
    listen.mock.restore();
    return { f, log, host };
  };
  // The log index of the first sync that makes each newly created entry durable.
  const directoryEvent = (log, f, entry) => log.findIndex((event) => event.kind === 'directory' && event.path === f.dataDirectory && (entry === undefined || event.entries.includes(entry)));
  const COVERING = {
    'the marker file': (log) => log.findIndex((event) => event.kind === 'file'),
    'the marker parent': (log, f) => directoryEvent(log, f),
    ...Object.fromEntries(STATE_ENTRIES.map((entry) => [`${entry}/`, (log, f) => directoryEvent(log, f, entry)])),
  };
  await t.test('a normal start orders every sync', async (subtest) => {
    const { f, log } = await normal(subtest);
    assertDurableOrder(log, f.dataDirectory);
  });
  for (const [entry, covering] of Object.entries(COVERING)) {
    await t.test(`omitting the sync that covers ${entry} fails the order assertion`, async (subtest) => {
      const { f, log } = await normal(subtest);
      const omitted = covering(log, f);
      assert.ok(omitted >= 0, `a sync covers ${entry}`);
      assert.throws(() => assertDurableOrder(log.filter((_event, index) => index !== omitted), f.dataDirectory));
    });
    await t.test(`a failed sync covering ${entry} prevents serving and releases resources`, async (subtest) => {
      const { f: recorded, log } = await normal(subtest);
      const f = await hostFixture(subtest);
      const failing = [];
      const listen = recordListen(failing);
      f.useSync(recordingSync(f, failing, { throwAt: covering(log, recorded) + 1 }));
      const error = await rejection(f.start());
      listen.mock.restore();
      assert.equal(error.message, SYNC_FAILURE);
      assert.equal(failing.some((event) => event.kind === 'listen'), false, 'nothing was served');
      lockReleased(f);
    });
  }
  await t.test('a crash after each sync restarts safely without recreating entries or rewriting the marker', async (subtest) => {
    const { f, log, host } = await normal(subtest);
    await host.close();
    const syncs = log.filter((event) => event.kind !== 'listen').length;
    for (let crashAfter = 1; crashAfter <= syncs; crashAfter++) {
      rmSync(f.dataDirectory, { recursive: true });
      mkdirSync(f.dataDirectory, { mode: 0o700 });
      f.useSync(recordingSync(f, [], { throwAt: crashAfter, after: true }));
      assert.equal((await rejection(f.start())).message, SYNC_FAILURE);
      const inodes = Object.fromEntries(namesIn(f.dataDirectory).filter((name) => name === MARKER_FILE || STATE_ENTRIES.includes(name)).map((name) => [name, statSync(f.path(name)).ino]));
      const restartLog = [];
      f.useSync(recordingSync(f, restartLog));
      const restarted = await f.start();
      for (const [name, inode] of Object.entries(inodes)) assert.equal(statSync(f.path(name)).ino, inode, `${name} was not recreated after crash ${crashAfter}`);
      if (MARKER_FILE in inodes) assert.equal(restartLog.some((event) => event.kind === 'file'), false, 'the marker is never rewritten');
      assert.equal(readFileSync(f.path(MARKER_FILE), 'utf8'), MARKER_TEXT);
      await restarted.close();
    }
  });
  await t.test('a restart of a complete directory neither recreates entries nor rewrites the marker', async (subtest) => {
    const { f, host } = await normal(subtest);
    await host.close();
    const inodes = [MARKER_FILE, ...STATE_ENTRIES].map((name) => statSync(f.path(name)).ino);
    const log = [];
    f.useSync(recordingSync(f, log));
    await (await f.start()).close();
    assert.deepEqual([MARKER_FILE, ...STATE_ENTRIES].map((name) => statSync(f.path(name)).ino), inodes);
    assert.equal(log.some((event) => event.kind === 'file'), false);
  });
});

test('P10-T08 the host wire context refuses a changed connection and a copied binding, and accepts its own', async (t) => {
  let connectionId = TEST_CONNECTION.connectionId;
  const f = await hostFixture(t);
  await f.start({ tp1Network: testNetwork({ connection: () => ({ ...TEST_CONNECTION, connectionId }) }) });
  const [wire] = f.wires;
  assert.equal(Object.isFrozen(wire), true);
  assert.deepEqual(Object.keys(wire).sort(), ['assertCurrentBinding', 'binding', 'connection', 'journal']);
  await wire.assertCurrentBinding();
  await assertTp1Binding(wire.binding, wire.connection());
  await assert.rejects(assertTp1Binding({ ...wire.binding }, wire.connection()), { code: 'tp1_binding_required' });
  connectionId = 'vector-conn-2';
  await assert.rejects(wire.assertCurrentBinding(), { code: 'tp1_local_binding_changed' });
});

test('P10-T08 a connection that changes while the host starts refuses before it listens and releases the lock', async (t) => {
  const f = await hostFixture(t);
  let reads = 0;
  const connection = () => ({ ...TEST_CONNECTION, connectionId: ++reads === 1 ? TEST_CONNECTION.connectionId : 'vector-conn-2' });
  const error = await rejection(f.start({ tp1Network: testNetwork({ connection }) }));
  assert.equal(error.code, 'tp1_local_binding_changed');
  lockReleased(f);
});

test('P10-T08 the re-check before listening reads the reader within 10,000 ms, keeps its cause, and releases the lock', async (t) => {
  await t.test('a reader that answers the startup read and then stalls times out at 10,000 ms', async (subtest) => {
    const f = await hostFixture(subtest);
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const answer = authorityReader();
    let reads = 0;
    let answerLate;
    let secondRead;
    const secondReadStarted = new Promise((resolve) => { secondRead = resolve; });
    const readAuthority = (scope) => {
      if (++reads === 1) return answer(scope);
      secondRead();
      return new Promise((resolve) => { answerLate = () => resolve(answer(scope)); });
    };
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let outcome = 'pending';
      const starting = f.start({ tp1Network: testNetwork({ readAuthority }) }).then(() => { outcome = 'started'; }, (error) => { outcome = error; });
      await secondReadStarted;
      mock.timers.tick(AUTHORITY_DEADLINE_MS - 1);
      await flush();
      assert.equal(outcome, 'pending', 'still waiting at 9,999 ms');
      mock.timers.tick(1);
      await starting;
      assert.equal(outcome.code, 'tp1_authority_timeout');
      assert.equal(outcome.cause.name, 'TimeoutError', 'the timeout is the cause');
      answerLate();
      await flush();
      assert.equal(f.wires.length, 0, 'nothing was served');
      assert.deepEqual(unhandled, []);
      lockReleased(f);
    } finally {
      mock.timers.reset();
      process.off('unhandledRejection', onUnhandled);
    }
  });
  await t.test('a reader that fails its second read keeps its cause', async (subtest) => {
    const f = await hostFixture(subtest);
    const cause = new Error('TEST authority went away');
    const answer = authorityReader();
    let reads = 0;
    const error = await rejection(f.start({ tp1Network: testNetwork({ readAuthority: (scope) => (++reads === 1 ? answer(scope) : Promise.reject(cause)) }) }));
    assert.equal(error, cause);
    lockReleased(f);
  });
});

test('P10-T09 a plain-HTTP endpoint or a revision-1 chain refuses before the lock and before any file', async (t) => {
  const cases = [
    ['a plain-HTTP endpoint', { connection: () => ({ ...TEST_CONNECTION, endpoint: 'http://rpc.example.invalid/' }) }, 'tp1_local_binding_invalid'],
    ['a reader naming another chain', { readAuthority: authorityReader({ chainIdentity: derive('revision-1-chain') }) }, 'tp1_connection_unverified'],
  ];
  for (const [label, network, code] of cases) {
    await t.test(label, async (subtest) => {
      const f = await hostFixture(subtest);
      assert.equal((await rejection(f.start({ tp1Network: testNetwork(network) }))).code, code);
      assert.deepEqual(namesIn(f.dataDirectory), [], 'no lock, marker or state file exists');
    });
  }
});

test('P10-T10 a rejecting reader keeps its cause, a stalled one times out at 10,000 ms, and a late answer is ignored', async (t) => {
  await t.test('a rejecting reader keeps its cause', async (subtest) => {
    const f = await hostFixture(subtest);
    const cause = new Error('TEST authority unavailable');
    const error = await rejection(f.start({ tp1Network: testNetwork({ readAuthority: () => Promise.reject(cause) }) }));
    assert.equal(error, cause);
    assert.deepEqual(namesIn(f.dataDirectory), []);
  });
  await t.test('a stalled reader times out at 10,000 ms and its late answer grants nothing', async (subtest) => {
    const f = await hostFixture(subtest);
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    let answerLate;
    const reader = authorityReader();
    const readAuthority = (scope) => new Promise((resolve) => { answerLate = () => resolve(reader(scope)); });
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let outcome = 'pending';
      const starting = f.start({ tp1Network: testNetwork({ readAuthority }) }).then(() => { outcome = 'started'; }, (error) => { outcome = error; });
      mock.timers.tick(AUTHORITY_DEADLINE_MS - 1);
      await flush();
      assert.equal(outcome, 'pending', 'still waiting at 9,999 ms');
      mock.timers.tick(1);
      await starting;
      assert.equal(outcome.code, 'tp1_authority_timeout');
      assert.equal(outcome.cause.name, 'TimeoutError', 'the timeout is the cause');
      answerLate();
      await flush();
      assert.deepEqual(namesIn(f.dataDirectory), [], 'the late answer opened nothing');
      assert.equal(f.wires.length, 0);
      assert.deepEqual(unhandled, []);
    } finally {
      mock.timers.reset();
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

test('P10-T11 the host binds only the SDK\'s approved record; no option or environment variable names one', async (t) => {
  const f = await hostFixture(t);
  const forged = { ...TP1_APPROVED_IDENTITY_RECORD, chainIdentity: derive('forged-chain'), provenance: { ...TP1_APPROVED_IDENTITY_RECORD.provenance } };
  for (const options of [{ record: forged }, { identityRecord: forged }, { tp1Network: { ...testNetwork(), record: forged } }]) {
    const error = await rejection(f.start(options));
    assert.equal(error.name, 'TypeError');
    assert.match(error.message, /unknown (seller host|tp1Network) option/);
  }
  assert.equal((await rejection(f.start({ tp1Network: undefined }))).message, 'the seller host requires tp1Network');
  assert.match((await rejection(f.start({ tp1Network: { connection: () => ({}) } }))).message, /tp1Network/);
  assert.deepEqual(namesIn(f.dataDirectory), [], 'every refusal came before any file');
  const names = ['DACS_TP1_RECORD', 'DACS_TP1_IDENTITY_RECORD', 'TP1_RECORD'];
  for (const name of names) process.env[name] = JSON.stringify(forged);
  try { await f.start(); } finally { for (const name of names) delete process.env[name]; }
  const [{ binding }] = f.wires;
  assert.equal(binding.recordDigest, sha256Hex(canonicalize(TP1_APPROVED_IDENTITY_RECORD)));
  assert.deepEqual(binding.profile, PROFILE);
});

test('P10-T14 with the shipped guard off, start refuses before the binding read, the marker, the lock and the journal', async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-host-wire-guard-')));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = `
    const { startSellerHost } = await import(${JSON.stringify(HOST_URL.href)});
    let reads = 0;
    const tp1Network = { connection: () => { reads++; return {}; }, readAuthority: () => { reads++; } };
    try { await startSellerHost({ dataDirectory: process.env.DATA_DIRECTORY, tp1Network }); }
    catch (error) { process.stdout.write(JSON.stringify({ code: error.code, reads }) + '\\n'); }`;
  const kept = (process.env.NODE_OPTIONS ?? '').split(' ').filter((option) => option !== '' && !option.includes(GUARD_FIXTURE)).join(' ');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: PACKAGE_DIRECTORY, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: kept, DATA_DIRECTORY: directory } });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim().split('\n').at(-1)), { code: 'kit_operation_guard_off', reads: 0 });
  assert.deepEqual(namesIn(directory), []);
});

test('P10-T16 boundedCall resolves, and rejects with the original cause; it times out at exactly 10,000 ms and not at 9,999; a late result reaches only settled; no rejection is left unhandled', async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => { process.off('unhandledRejection', onUnhandled); mock.timers.reset(); });
  const deferred = () => { const parts = {}; parts.promise = new Promise((resolve, reject) => Object.assign(parts, { resolve, reject })); return parts; };
  const race = async (outcome) => { const seen = []; outcome.then((value) => seen.push(['resolved', value]), (error) => seen.push(['rejected', error])); await flush(); return seen; };
  await t.test('resolves with the work\'s value', async () => {
    const call = boundedCall(async () => 'value', { timeoutMs: AUTHORITY_DEADLINE_MS });
    assert.equal(await call.result, 'value');
    assert.deepEqual(await call.settled, { status: 'fulfilled', value: 'value' });
  });
  await t.test('rejects with the original cause, also when the work throws synchronously', async () => {
    const cause = new Error('TEST original cause');
    await assert.rejects(boundedCall(() => Promise.reject(cause), { timeoutMs: AUTHORITY_DEADLINE_MS }).result, (error) => error === cause);
    await assert.rejects(boundedCall(() => { throw cause; }, { timeoutMs: AUTHORITY_DEADLINE_MS }).result, (error) => error === cause);
  });
  await t.test('starts the work once and refuses a deadline that is not a positive safe integer without starting it', () => {
    let calls = 0;
    boundedCall(() => { calls++; return Promise.resolve(); }, { timeoutMs: AUTHORITY_DEADLINE_MS });
    assert.equal(calls, 1);
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '10000', undefined]) {
      assert.throws(() => boundedCall(() => { calls++; }, { timeoutMs }), TypeError);
    }
    assert.equal(calls, 1);
  });
  await t.test('times out at exactly 10,000 ms and not at 9,999', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const call = boundedCall(() => new Promise(() => {}), { timeoutMs: AUTHORITY_DEADLINE_MS });
    mock.timers.tick(AUTHORITY_DEADLINE_MS - 1);
    assert.deepEqual(await race(call.result), []);
    mock.timers.tick(1);
    const [[state, error]] = await race(call.result);
    assert.equal(state, 'rejected');
    assert.equal(error.name, 'TimeoutError');
    mock.timers.reset();
  });
  await t.test('a late result reaches only settled', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const work = deferred();
    const call = boundedCall(() => work.promise, { timeoutMs: AUTHORITY_DEADLINE_MS });
    mock.timers.tick(AUTHORITY_DEADLINE_MS);
    assert.equal((await race(call.result))[0][1].name, 'TimeoutError');
    work.resolve('late value');
    assert.deepEqual(await call.settled, { status: 'fulfilled', value: 'late value' });
    assert.equal((await race(call.result)).length, 1, 'the result stays rejected');
    mock.timers.reset();
  });
  await t.test('a late rejection reaches only settled and is never unhandled', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const work = deferred();
    const call = boundedCall(() => work.promise, { timeoutMs: AUTHORITY_DEADLINE_MS });
    mock.timers.tick(AUTHORITY_DEADLINE_MS);
    await race(call.result);
    const cause = new Error('TEST late failure');
    work.reject(cause);
    assert.deepEqual(await call.settled, { status: 'rejected', reason: cause });
    mock.timers.reset();
  });
  await flush();
  assert.deepEqual(unhandled, []);
});

test('P10-T19 with a valid current format marker, a fresh kit store over a journal containing a k- file or an operation file refuses kit_journal_accounting_mismatch before store creation or journal mutation, releases the lock, and still refuses after restart; an unreadable enumeration refuses with its cause. Controls: an empty journal permits a fresh store, an absent/unsupported marker keeps SA-6\'s earlier format refusal, and an existing store is left for P11d3\'s complete reconciliation; no journal file is deleted', async (t) => {
  const prepare = async (subtest, file) => {
    const f = await hostFixture(subtest);
    writeMarker(f);
    makePrivateDirectory(f.path(JOURNAL_DIRECTORY));
    if (file !== undefined) writeFileSync(f.path(JOURNAL_DIRECTORY, file), 'TEST journal record');
    return f;
  };
  for (const file of [`k-${derive('key')}`, `o-${derive('operation')}-0`]) {
    await t.test(`refuses over ${file.slice(0, 2)} file and again after restart`, async (subtest) => {
      const f = await prepare(subtest, file);
      for (const attempt of ['first run', 'restart']) {
        const error = await rejection(f.start());
        assert.equal(error.code, ACCOUNTING_MISMATCH, attempt);
        assert.deepEqual(namesIn(f.dataDirectory).filter((name) => ['seller', 'transport'].includes(name)), [], `${attempt}: no store was created`);
        assert.deepEqual(namesIn(f.path(JOURNAL_DIRECTORY)), [file], `${attempt}: the journal is untouched`);
        assert.equal(readFileSync(f.path(JOURNAL_DIRECTORY, file), 'utf8'), 'TEST journal record');
        lockReleased(f);
      }
    });
  }
  await t.test('an unreadable enumeration refuses with its cause', { skip: process.getuid() === 0 }, async (subtest) => {
    const f = await prepare(subtest);
    chmodSync(f.path(JOURNAL_DIRECTORY), 0o000);
    const error = await rejection(f.start());
    chmodSync(f.path(JOURNAL_DIRECTORY), 0o700);
    assert.equal(error.code, ACCOUNTING_MISMATCH);
    assert.equal(error.cause.code, 'EACCES');
    lockReleased(f);
  });
  await t.test('control: an empty journal permits a fresh store', async (subtest) => {
    const f = await prepare(subtest);
    await (await f.start()).close();
    assert.equal(existsSync(f.path(STORE_FILE)), true);
  });
  await t.test('control: an absent marker keeps the earlier format refusal', async (subtest) => {
    const f = await prepare(subtest, `k-${derive('key')}`);
    rmSync(f.path(MARKER_FILE));
    const error = await rejection(f.start());
    assert.equal(error.code, FORMAT_REFUSED);
    assert.equal(error.reason, 'missing-marker');
  });
  await t.test('control: an unsupported marker keeps the earlier format refusal', async (subtest) => {
    const f = await prepare(subtest, `k-${derive('key')}`);
    writeFileSync(f.path(MARKER_FILE), '{"format":"dacs-kit-data/tp1-0"}\n');
    assert.equal((await rejection(f.start())).code, FORMAT_REFUSED);
  });
  await t.test('control: an existing store is left for startup reconciliation, and no journal file is deleted', async (subtest) => {
    const f = await prepare(subtest);
    await (await f.start()).close();
    const file = `k-${derive('later-key')}`;
    writeFileSync(f.path(JOURNAL_DIRECTORY, file), 'TEST journal record');
    await (await f.start()).close();
    assert.deepEqual(namesIn(f.path(JOURNAL_DIRECTORY)), [file]);
  });
});

// ================================================================ store tests

test('P10-T12 a tuple kept by an admitted reservation is durable when reserve returns, kept once, and a different tuple for the job is refused with the reservation rolled back', async (t) => {
  const w = storeFixture(t);
  const job = jobId('t12');
  assert.equal(w.store.reserve(w.request(job), {}, { keepProfile: PROFILE }).disposition, 'perform');
  assert.deepEqual(w.store.purchaseProfile(job), PROFILE);
  assert.equal(w.tuples(), 1, 'a second connection already sees the committed tuple');
  assert.equal(w.store.reserve(w.request(job), {}, { keepProfile: PROFILE }).disposition, 'uncertain', 'a repeat for the same job and tuple');
  assert.equal(w.tuples(), 1, 'kept once');
  const noncesBefore = w.nonces();
  assert.throws(() => w.store.reserve(w.request(job), {}, { keepProfile: OTHER_PROFILE }), MISMATCH);
  assert.equal(w.nonces(), noncesBefore, 'the refused reservation left no nonce row');
  assert.deepEqual(w.store.purchaseProfile(job), PROFILE, 'the kept tuple is unchanged');
  assert.throws(() => w.store.keepPurchaseProfileWithin(job, OTHER_PROFILE), MISMATCH);
  assert.throws(() => w.store.keepPurchaseProfileWithin('not-a-job', PROFILE), { code: 'peer_job_invalid', status: 409 });
  assert.throws(() => w.store.reserve(w.request(jobId('t12-shape')), {}, { keepProfile: { ...PROFILE, extra: 1 } }), MISMATCH);
  assert.throws(() => w.store.reserve(w.request(jobId('t12-null')), {}, { keepProfile: null }), MISMATCH);
  assert.equal(w.tuples(), 1);
  assert.equal(w.store.purchaseProfile(jobId('t12-unseen')), null);
});

test('P10-T13 a tuple kept before a crash is present after restart; one not kept is absent', async (t) => {
  const w = storeFixture(t);
  const kept = jobId('t13-kept');
  const legacy = jobId('t13-legacy');
  const refused = jobId('t13-refused');
  w.store.reserve(w.request(kept), {}, { keepProfile: PROFILE });
  w.store.reserve(w.request(legacy), {}, {});
  assert.throws(() => w.store.reserve(w.request(refused), {}, { keepProfile: { ...PROFILE, extra: 1 } }), MISMATCH);
  const reopened = w.reopen();
  assert.deepEqual(reopened.purchaseProfile(kept), PROFILE);
  assert.equal(reopened.purchaseProfile(legacy), null, 'a legacy reservation keeps no tuple');
  assert.equal(reopened.purchaseProfile(refused), null, 'a refused reservation kept none');
  assert.equal(w.tuples(), 1);
});

test('a job removed after a no-effect answer takes its kept tuple with it, so the job can be proposed again under another tuple', async (t) => {
  const w = storeFixture(t);
  const removed = jobId('removed');
  w.store.finish(w.store.reserve(w.request(removed), {}, { keepProfile: PROFILE }), 409, '{}', { noEffect: true });
  assert.equal(w.jobs(), 0, 'the provisional job is gone');
  assert.equal(w.tuples(), 0, 'and so is its tuple');
  w.reopen();
  assert.equal(w.store.reserve(w.request(removed), {}, { keepProfile: OTHER_PROFILE }).disposition, 'perform');
  assert.deepEqual(w.store.purchaseProfile(removed), OTHER_PROFILE);
});

test('P10-T17 with maxJobs 3 full and spare reservation capacity, 20 fresh-job reservations carrying a tuple are each refused peer_job_capacity with the tuple count unchanged, also after restart; the same for the buyer rate, store capacity and a crash inside the reservation transaction; an admitted new job keeps exactly one tuple', async (t) => {
  const refuseTwenty = (w, expected) => {
    for (let i = 0; i < 20; i++) assert.throws(() => w.store.reserve(w.request(jobId(`fresh-${i}`)), {}, { keepProfile: PROFILE }), expected);
  };
  await t.test('job capacity', (subtest) => {
    const w = storeFixture(subtest, { maxJobs: 3 });
    for (let i = 0; i < 3; i++) { const reservation = w.store.reserve(w.request(jobId(`full-${i}`)), {}, { keepProfile: PROFILE }); w.store.finish(reservation, 200, '{}'); w.advance(61000); }
    assert.equal(w.tuples(), 3, 'each admitted new job keeps exactly one tuple');
    refuseTwenty(w, { code: 'peer_job_capacity' });
    assert.equal(w.tuples(), 3);
    w.reopen();
    refuseTwenty(w, { code: 'peer_job_capacity' });
    assert.equal(w.tuples(), 3, 'also after restart');
  });
  const scenarios = [
    ['buyer rate', { maxNoncesPerBuyerPerWindow: 1 }, { code: 'peer_buyer_nonce_limit' }],
    ['store capacity', { maxRecords: 1 }, { code: 'peer_store_capacity' }],
  ];
  for (const [label, options, expected] of scenarios) {
    await t.test(label, (subtest) => {
      const w = storeFixture(subtest, options);
      assert.equal(w.store.reserve(w.request(jobId('admitted')), {}, { keepProfile: PROFILE }).disposition, 'perform');
      refuseTwenty(w, expected);
      assert.equal(w.tuples(), 1, 'only the admitted job has a tuple');
      w.reopen();
      refuseTwenty(w, expected);
      assert.equal(w.tuples(), 1, 'also after restart');
    });
  }
  await t.test('a crash inside the reservation transaction', (subtest) => {
    const w = storeFixture(subtest);
    const planted = new DatabaseSync(w.path);
    subtest.after(() => planted.close());
    planted.exec("CREATE TRIGGER crash_in_reservation BEFORE INSERT ON peer_effects BEGIN SELECT RAISE(ABORT, 'TEST crash in reservation'); END");
    assert.throws(() => w.store.reserve(w.request(jobId('crash')), {}, { keepProfile: PROFILE }), /TEST crash in reservation/);
    assert.deepEqual([w.tuples(), w.jobs(), w.nonces()], [0, 0, 0], 'the whole reservation, tuple included, rolled back');
    w.reopen();
    assert.equal(w.tuples(), 0, 'also after restart');
    planted.exec('DROP TRIGGER crash_in_reservation');
    assert.equal(w.store.reserve(w.request(jobId('crash')), {}, { keepProfile: PROFILE }).disposition, 'perform');
    assert.equal(w.tuples(), 1);
  });
});

test('P10-T18 through the real guarded store\'s classify, its dry-run reserve and the real old-auth context route, never a replacement classifier: fresh context work classifies start and known work known with no tuple, as today; after a proposal reservation has kept the job\'s tuple, the context route\'s retry with a fresh request nonce still classifies known and replays its answer; classify given the matching tuple answers as reserve would, a different tuple or an existing job with no kept tuple refuses tp1_purchase_profile_mismatch, and a dry run on a new job with a tuple leaves the tuple count unchanged; the guarded wrappers forward the tuple; the same after restart', async (t) => {
  const w = await world(t, { recover: presentContext });
  const [job] = JOBS;
  const contextRequest = async () => { const input = await w.wire({ jobId: job }); return { input, request: w.auth.readRequest(input.header), body: JSON.parse(input.text) }; };
  const client = createSellerTransportClientAuth({ buyerSigner: w.buyer, seller: w.seller.claim, resolveJob: () => ({ listingPin: w.pin, agreementHash: derive('agreement') }), now: w.now });
  const proposal = async (id) => { const { header } = await client.request(PROPOSALS, { jobId: id }, '{}'); return w.auth.readRequest(header); };
  const tuples = () => { const db = new DatabaseSync(w.path, { readonly: true }); try { return db.prepare('SELECT COUNT(*) AS n FROM kit_purchase_profiles').get().n; } finally { db.close(); } };
  const guarded = w.auth.store;

  const fresh = await contextRequest();
  assert.equal(guarded.classify(fresh.request, fresh.body), 'start', 'fresh context work classifies start with no tuple');
  const first = await exchange(w.handler, fresh.input);
  assert.equal(first.status, 200);
  const retry = await contextRequest();
  assert.equal(guarded.classify(retry.request, retry.body), 'known', 'known context work classifies known with no tuple');

  const other = jobId('t18-other');
  const reservation = guarded.reserve(await proposal(job), {}, { keepProfile: PROFILE });
  assert.equal(reservation.disposition, 'perform', 'the guarded wrapper forwards the tuple to a new job');
  assert.equal(tuples(), 1);
  assert.deepEqual(w.store.purchaseProfile(job), PROFILE);

  const again = await contextRequest();
  assert.equal(guarded.classify(again.request, again.body), 'known', 'the context retry still classifies known once the job has a tuple');
  const replay = await exchange(w.handler, again.input);
  assert.equal(replay.text, first.text, 'and replays its answer');
  assert.equal(w.effects().writes, 1, 'without new work');

  w.store.reserve(await proposal(other), {}, {});
  const dryRuns = async (store, label) => {
    const [matching, different, untupled, legacy, brandNew] = await Promise.all([proposal(job), proposal(job), proposal(other), proposal(other), proposal(jobId('t18-new'))]);
    assert.equal(store.classify(matching, {}, { keepProfile: PROFILE }), 'known', `${label}: the matching tuple answers as reserve would`);
    assert.throws(() => store.classify(different, {}, { keepProfile: OTHER_PROFILE }), MISMATCH, `${label}: a different tuple is refused`);
    assert.throws(() => store.classify(untupled, {}, { keepProfile: PROFILE }), MISMATCH, `${label}: an existing job with no kept tuple is refused`);
    assert.equal(store.classify(legacy, {}), 'known', `${label}: an absent tuple is the legacy path`);
    assert.equal(store.classify(brandNew, {}, { keepProfile: PROFILE }), 'start', `${label}: a new job classifies start`);
    assert.equal(tuples(), 1, `${label}: a dry run keeps no tuple`);
  };
  await dryRuns(guarded, 'guarded store');

  const reopened = createSellerTransportStore({ path: w.path, now: w.now });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.purchaseProfile(job), PROFILE, 'the tuple survives a restart');
  const afterRestart = await contextRequest();
  assert.equal(reopened.classify(afterRestart.request, afterRestart.body), 'known', 'the context retry classifies known after restart');
  await dryRuns(reopened, 'restarted store');
});
