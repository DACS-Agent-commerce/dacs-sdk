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
import { Dir, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import DatabaseSync from 'better-sqlite3';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { TP1_APPROVED_IDENTITY_RECORD, TP1_BASE_REVISION, TP1_PROFILE_ID, TP1_PROFILE_REVISION } from '@kynesyslabs/dacs/wire';
import { journalStore, reserveEffect } from '../../../dist/wire/journal.js';
import { commitmentFixture } from './helpers/commitment-fixture.mjs';
import { ORCHESTRATOR_MODE } from './helpers/proposal-admission-fixture.mjs';
import { JOBS, T, exchange, presentContext, world } from './helpers/d5-http-fixture.mjs';
import { privateModule } from './helpers/private-module.mjs';
import { NOW } from './helpers/protocol-fixture.mjs';
import { TEST_CONNECTION, authorityReader, testNetwork } from './helpers/wire-authority-fixture.mjs';
import { syncDirectory } from '../src/devnet-demo/durable-file.mjs';
import { KIT_DATA_FORMAT, assertKitDataFormat } from '../src/dacs/kit-data-format.mjs';
import { boundedCall, isBoundedCallTimeout } from '../src/dacs/bounded-call.mjs';
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

// The host with one test seam that adds no runtime API: it records the binding
// and the journal handle the host obtains, through the real SDK functions.
async function hostFixture(t) {
  const f = await commitmentFixture(t, { vetMode: ORCHESTRATOR_MODE });
  const dataDirectory = realpathSync(await mkdtemp(join(tmpdir(), 'TEST-host-wire-state-')));
  const { nativeArtifactAnchor, ...config } = f.config;
  delete config.durableDirectory;
  delete config.commitOnSignature;
  // The host fixes its Vet mode and takes no such option.
  delete config.vetMode;
  const api = await privateModule(HOST_URL, ['setTestRecorder'], (source) => {
    const text = sub(source, 'bindTp1Profile, openWireRequestJournal } from', 'bindTp1Profile as REAL_BIND, openWireRequestJournal as REAL_OPEN_JOURNAL } from');
    return sub(text, 'const REQUIRED =', `let testRecorder = { bindings: [], journals: [] }; function setTestRecorder(value) { testRecorder = value; }
const bindTp1Profile = async (options) => { const binding = await REAL_BIND(options); testRecorder.bindings.push(binding); return binding; };
const openWireRequestJournal = (...args) => { const journal = REAL_OPEN_JOURNAL(...args); testRecorder.journals.push(journal); return journal; };
const REQUIRED =`);
  });
  // The private module is one cached instance for every fixture: each fixture records into its own lists.
  const recorded = { bindings: [], journals: [] };
  api.setTestRecorder(recorded);
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
  return { start, options, dataDirectory, ...recorded, path: (...names) => join(dataDirectory, ...names) };
}

const lockReleased = (f) => assert.deepEqual(namesIn(f.dataDirectory).filter((name) => name.startsWith(LOCK_FILE_PREFIX)), [], 'the state lock is released');
const writeMarker = (f) => writeFileSync(f.path(MARKER_FILE), MARKER_TEXT, { mode: 0o600 });
const makePrivateDirectory = (path) => { mkdirSync(path, { mode: 0o700 }); chmodSync(path, 0o700); return path; };
const rejection = async (promise) => { try { await promise; } catch (error) { return error; } return assert.fail('expected a rejection'); };

// A durable-sync step with the data directory's listing at that moment. `fail(event)`
// fails the first step it is true for, before it syncs or, with `after`, once it has.
function syncStep(f, log, { fail = () => false, after = false }) {
  let failed = false;
  return async (event, sync) => {
    log.push({ ...event, entries: existsSync(f.dataDirectory) ? namesIn(f.dataDirectory) : [] });
    const failing = !failed && fail(log.at(-1));
    failed ||= failing;
    if (failing && !after) throw new Error(SYNC_FAILURE);
    await sync();
    if (failing) throw new Error(SYNC_FAILURE);
  };
}

// The sync steps assertKitDataFormat takes through its `sync` parameter.
function recordingSync(f, log, options = {}) {
  const step = syncStep(f, log, options);
  return Object.freeze({
    file: (handle, path) => step({ kind: 'file', path }, () => handle.sync()),
    directory: (path) => step({ kind: 'directory', path }, () => syncDirectory(path)),
  });
}

// Runs `work` while every FileHandle sync (the only kind the marker and the host's directory
// syncs use) and the opening of a listener are logged, so syncs can be ordered against listen.
async function withHostSyncs(f, log, work, options = {}) {
  const probe = await open(f.dataDirectory, 'r');
  const handles = Object.getPrototypeOf(probe);
  await probe.close();
  const step = syncStep(f, log, options);
  const sync = handles.sync;
  const listen = Server.prototype.listen;
  handles.sync = function recordedSync() {
    const path = realpathSync(`/proc/self/fd/${this.fd}`);
    return step({ kind: statSync(path).isDirectory() ? 'directory' : 'file', path }, () => sync.call(this));
  };
  Server.prototype.listen = function recordedListen(...args) { log.push({ kind: 'listen' }); return listen.apply(this, args); };
  try { return await work(); } finally { handles.sync = sync; Server.prototype.listen = listen; }
}

const isMarkerFileSync = (event) => event.kind === 'file' && basename(event.path).startsWith(`${MARKER_FILE}.`);
const namesInDataDirectory = (f, event, name) => event.kind === 'directory' && event.path === f.dataDirectory && event.entries.includes(name);

// SA-6 / P10-T07: marker file, then its parent, then each state directory's parent, all before listen.
function assertDurableOrder(log, dataDirectory) {
  const markerFile = log.findIndex(isMarkerFileSync);
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
  const [opened] = f.journals;
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
  assert.equal(reserveEffect(journalStore(f.journals[0]), reservation).state, 'new');
  const filesBefore = namesIn(f.path(JOURNAL_DIRECTORY));
  assert.equal((await withHostSyncs(f, log, () => rejection(f.start()))).code, 'seller_state_locked');
  assert.deepEqual(log, [], 'the refused run synced and created nothing');
  assert.equal(f.journals.length, 1, 'the refused run opened no journal');
  assert.deepEqual(namesIn(f.path(JOURNAL_DIRECTORY)), filesBefore, 'the journal was not touched');
  await first.close();
  const inode = statSync(f.path(JOURNAL_DIRECTORY)).ino;
  await f.start();
  assert.equal(statSync(f.path(JOURNAL_DIRECTORY)).ino, inode, 'the restart reopens the same directory');
  const another = { ...reservation, key: derive('key-2') };
  assert.equal((await rejection(Promise.resolve().then(() => reserveEffect(journalStore(f.journals[1]), another)))).code, 'seller_effect_pending', 'the reopened journal still holds the first attempt');
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
    const host = await withHostSyncs(f, log, () => f.start());
    return { f, log, host };
  };
  // Which sync makes each newly created entry durable.
  const COVERING = {
    'the marker file': () => isMarkerFileSync,
    'the marker parent': (f) => (event) => namesInDataDirectory(f, event, MARKER_FILE),
    ...Object.fromEntries(STATE_ENTRIES.map((entry) => [`${entry}/`, (f) => (event) => namesInDataDirectory(f, event, entry)])),
  };
  const createdEntries = (f) => Object.fromEntries(namesIn(f.dataDirectory).filter((name) => name === MARKER_FILE || STATE_ENTRIES.includes(name)).map((name) => [name, statSync(f.path(name)).ino]));
  // A restart after a cut keeps every entry the cut left and never rewrites the marker.
  const assertSafeRestart = async (f, label) => {
    const inodes = createdEntries(f);
    const restartLog = [];
    const restarted = await withHostSyncs(f, restartLog, () => f.start());
    for (const [name, inode] of Object.entries(inodes)) assert.equal(statSync(f.path(name)).ino, inode, `${name} was not recreated after ${label}`);
    if (MARKER_FILE in inodes) assert.equal(restartLog.some(isMarkerFileSync), false, `the marker is never rewritten after ${label}`);
    assert.equal(readFileSync(f.path(MARKER_FILE), 'utf8'), MARKER_TEXT);
    const listening = restartLog.findIndex((event) => event.kind === 'listen');
    for (const entry of STATE_ENTRIES) {
      const synced = restartLog.findIndex((event) => namesInDataDirectory(f, event, entry));
      assert.ok(synced >= 0 && synced < listening, `${entry}/ is named durably before the restart listens after ${label}`);
    }
    await restarted.close();
  };
  await t.test('a normal start orders every sync', async (subtest) => {
    const { f, log } = await normal(subtest);
    assertDurableOrder(log, f.dataDirectory);
  });
  for (const [entry, covering] of Object.entries(COVERING)) {
    await t.test(`omitting every sync that covers ${entry} fails the order assertion`, async (subtest) => {
      const { f, log } = await normal(subtest);
      const covers = covering(f);
      assert.ok(log.some(covers), `a sync covers ${entry}`);
      assert.throws(() => assertDurableOrder(log.filter((event) => !covers(event)), f.dataDirectory));
    });
    await t.test(`a failed sync covering ${entry} prevents serving and releases resources`, async (subtest) => {
      const f = await hostFixture(subtest);
      const log = [];
      const error = await withHostSyncs(f, log, () => rejection(f.start()), { fail: covering(f) });
      assert.equal(error.message, SYNC_FAILURE);
      assert.equal(log.some((event) => event.kind === 'listen'), false, 'nothing was served');
      lockReleased(f);
    });
    await t.test(`a crash just after the sync covering ${entry} restarts safely`, async (subtest) => {
      const f = await hostFixture(subtest);
      assert.equal((await withHostSyncs(f, [], () => rejection(f.start()), { fail: covering(f), after: true })).message, SYNC_FAILURE);
      await assertSafeRestart(f, `a crash after ${entry}`);
    });
  }
  await t.test('through its sync parameter, the marker is cut after its file sync or its directory sync, and either cut is completed once without a rewrite', async (subtest) => {
    for (const [cut, kind] of [['file sync', 'file'], ['directory sync', 'directory']]) {
      const directory = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-host-wire-marker-')));
      subtest.after(() => rmSync(directory, { recursive: true, force: true }));
      const f = { dataDirectory: directory, path: (...names) => join(directory, ...names) };
      const log = [];
      await assert.rejects(assertKitDataFormat(directory, recordingSync(f, log, { fail: (event) => event.kind === kind, after: true })), { message: SYNC_FAILURE });
      assert.deepEqual(log.map((event) => event.kind), kind === 'file' ? ['file'] : ['file', 'directory'], `${cut}: the file is synced before its directory`);
      assert.equal(existsSync(f.path(MARKER_FILE)), kind === 'directory', `${cut}: the marker is linked only after its file sync`);
      assert.deepEqual(namesIn(directory).filter((name) => name !== MARKER_FILE), [], `${cut}: no temporary file is left`);
      const restartLog = [];
      await assertKitDataFormat(directory, recordingSync(f, restartLog));
      assert.deepEqual(restartLog.map((event) => event.kind), kind === 'file' ? ['file', 'directory'] : [], `${cut}: the restart writes the marker only if it was not linked`);
      assert.equal(readFileSync(f.path(MARKER_FILE), 'utf8'), MARKER_TEXT);
    }
  });
  await t.test('a restart of a complete directory neither recreates entries nor rewrites the marker', async (subtest) => {
    const { f, host } = await normal(subtest);
    await host.close();
    await assertSafeRestart(f, 'a complete start');
  });
});

test('a started host has read its connection and the authority exactly once, calling connection() on tp1Network, and keeps no re-check before it listens', async (t) => {
  const f = await hostFixture(t);
  const reads = { connection: [], authority: 0 };
  const reader = authorityReader();
  const tp1Network = {
    connection() { reads.connection.push(this); return { ...TEST_CONNECTION, connectionId: reads.connection.length === 1 ? TEST_CONNECTION.connectionId : 'vector-conn-2' }; },
    readAuthority: (scope) => { reads.authority++; return reader(scope); },
  };
  await (await f.start({ tp1Network })).close();
  assert.deepEqual(reads, { connection: [tp1Network], authority: 1 }, 'one read of each; a later connection is never compared');
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
  await t.test('a TimeoutError the reader raises itself is its own error, not the host\'s deadline', async (subtest) => {
    const f = await hostFixture(subtest);
    const cause = new DOMException('TEST the reader\'s own request timed out', 'TimeoutError');
    const error = await rejection(f.start({ tp1Network: testNetwork({ readAuthority: () => Promise.reject(cause) }) }));
    assert.equal(error, cause);
    assert.equal(isBoundedCallTimeout(error), false);
    assert.deepEqual(namesIn(f.dataDirectory), []);
  });
  for (const late of ['answer', 'failure']) {
    await t.test(`a stalled reader times out at 10,000 ms, and its late ${late} opens nothing and is never unhandled`, async (subtest) => {
      const f = await hostFixture(subtest);
      const unhandled = [];
      const onUnhandled = (reason) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      let settleLate;
      let reads = 0;
      const reader = authorityReader();
      const readAuthority = (scope) => { reads++; return new Promise((resolve, reject) => { settleLate = () => (late === 'answer' ? resolve(reader(scope)) : reject(new Error('TEST late failure'))); }); };
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
        assert.equal(isBoundedCallTimeout(outcome.cause), true, 'the host\'s own timeout is the cause');
        settleLate();
        await flush();
        await flush();
        assert.deepEqual(namesIn(f.dataDirectory), [], 'no lock, marker or state was opened, before or after the late outcome');
        assert.equal(f.journals.length, 0);
        assert.equal(reads, 1, 'the reader was called once');
        assert.deepEqual(unhandled, []);
      } finally {
        mock.timers.reset();
        process.off('unhandledRejection', onUnhandled);
      }
    });
  }
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
  const [binding] = f.bindings;
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

test('P10-T16 boundedCall resolves, and rejects with the original cause; it times out at exactly 10,000 ms and not at 9,999 with its own timeout error; a late result is consumed; no rejection is left unhandled', async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => { process.off('unhandledRejection', onUnhandled); mock.timers.reset(); });
  const deferred = () => { const parts = {}; parts.promise = new Promise((resolve, reject) => Object.assign(parts, { resolve, reject })); return parts; };
  const race = async (outcome) => { const seen = []; outcome.then((value) => seen.push(['resolved', value]), (error) => seen.push(['rejected', error])); await flush(); return seen; };
  await t.test('resolves with the work\'s value', async () => {
    assert.equal(await boundedCall(async () => 'value', { timeoutMs: AUTHORITY_DEADLINE_MS }), 'value');
  });
  await t.test('rejects with the original cause, also when the work throws synchronously or raises its own TimeoutError', async () => {
    const cause = new Error('TEST original cause');
    await assert.rejects(boundedCall(() => Promise.reject(cause), { timeoutMs: AUTHORITY_DEADLINE_MS }), (error) => error === cause);
    await assert.rejects(boundedCall(() => { throw cause; }, { timeoutMs: AUTHORITY_DEADLINE_MS }), (error) => error === cause);
    const own = new DOMException('TEST the work\'s own timeout', 'TimeoutError');
    await assert.rejects(boundedCall(() => Promise.reject(own), { timeoutMs: AUTHORITY_DEADLINE_MS }), (error) => error === own && !isBoundedCallTimeout(error));
  });
  await t.test('starts the work once and refuses a deadline that is not an integer from 1 to 2^31 - 1 without starting it', () => {
    let calls = 0;
    boundedCall(() => { calls++; return Promise.resolve(); }, { timeoutMs: AUTHORITY_DEADLINE_MS });
    boundedCall(() => Promise.resolve(), { timeoutMs: 2 ** 31 - 1 });
    assert.equal(calls, 1);
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, 2 ** 31, Number.MAX_SAFE_INTEGER + 1, '10000', undefined]) {
      assert.throws(() => boundedCall(() => { calls++; }, { timeoutMs }), TypeError);
    }
    assert.equal(calls, 1);
  });
  await t.test('times out at exactly 10,000 ms and not at 9,999, with its own timeout error', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const call = boundedCall(() => new Promise(() => {}), { timeoutMs: AUTHORITY_DEADLINE_MS });
    mock.timers.tick(AUTHORITY_DEADLINE_MS - 1);
    assert.deepEqual(await race(call), []);
    mock.timers.tick(1);
    const [[state, error]] = await race(call);
    assert.equal(state, 'rejected');
    assert.equal(error.name, 'TimeoutError');
    assert.equal(isBoundedCallTimeout(error), true);
    mock.timers.reset();
  });
  for (const late of ['result', 'rejection']) {
    await t.test(`a late ${late} is consumed: the call stays timed out and nothing is unhandled`, async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      const work = deferred();
      const call = boundedCall(() => work.promise, { timeoutMs: AUTHORITY_DEADLINE_MS });
      mock.timers.tick(AUTHORITY_DEADLINE_MS);
      assert.equal(isBoundedCallTimeout((await race(call))[0][1]), true);
      if (late === 'result') work.resolve('late value'); else work.reject(new Error('TEST late failure'));
      const seen = await race(call);
      assert.equal(seen.length, 1);
      assert.equal(isBoundedCallTimeout(seen[0][1]), true, 'the call stays timed out');
      mock.timers.reset();
    });
  }
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
  for (const step of ['readSync', 'closeSync']) {
    await t.test(`a journal listing whose ${step} fails refuses with that error as its cause`, async (subtest) => {
      const f = await prepare(subtest, 'unrelated-entry');
      const cause = Object.assign(new Error(`TEST ${step} failed`), { code: 'EIO' });
      const original = Dir.prototype[step];
      mock.method(Dir.prototype, step, function failing(...args) {
        if (this.path !== f.path(JOURNAL_DIRECTORY)) return original.apply(this, args);
        if (step === 'closeSync') original.apply(this, args);
        throw cause;
      });
      const error = await rejection(f.start());
      mock.restoreAll();
      assert.equal(error.code, ACCOUNTING_MISMATCH);
      assert.equal(error.cause, cause);
      assert.equal(existsSync(f.path(STORE_FILE)), false, 'no store was created');
      lockReleased(f);
    });
  }
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
  assert.throws(() => w.store.purchaseProfile('not-a-job'), { code: 'peer_job_invalid', status: 409 });
  assert.throws(() => w.store.reserve(w.request(jobId('t12-shape')), {}, { keepProfile: { ...PROFILE, extra: 1 } }), MISMATCH);
  assert.throws(() => w.store.reserve(w.request(jobId('t12-null')), {}, { keepProfile: null }), MISMATCH);
  assert.equal(w.tuples(), 1);
  assert.equal(w.store.purchaseProfile(jobId('t12-unseen')), null);
});

test('P10-T12 replay matrix: for a pending, completed, retry, uncertain, no-effect and legacy job, the same or a fresh nonce with the kept, another or no tuple, through reserve and classify and after restart; a nonce conflict wins over a tuple mismatch; nothing changes a row', async (t) => {
  const w = storeFixture(t);
  const JOB_STATES = {
    pending: () => {},
    completed: (store, reservation) => store.finish(reservation, 200, '{"done":true}'),
    retry: (store, reservation) => store.finish(reservation, 409, '{"again":true}', { retry: true }),
    uncertain: (store, reservation) => store.finish(reservation, 503, '{"unknown":true}'),
    'no-effect': (store, reservation) => store.finish(reservation, 409, '{"none":true}', { noEffect: true }),
    legacy: () => {},
  };
  const rows = [];
  for (const [state, settle] of Object.entries(JOB_STATES)) {
    const first = w.request(jobId(`matrix-${state}`));
    const kept = state === 'legacy' ? undefined : PROFILE;
    settle(w.store, w.store.reserve(first, {}, { keepProfile: kept }));
    rows.push({ state, first, kept, jobGone: state === 'no-effect' });
  }
  const tables = () => ['peer_jobs', 'peer_nonces', 'peer_nonce_retention', 'peer_effects', 'kit_purchase_profiles'].map((table) => w.query(`SELECT COUNT(*) AS n FROM ${table}`));
  const check = (store, label) => {
    for (const { state, first, kept, jobGone } of rows) {
      const fresh = { ...first, nonce: randomBytes(16).toString('base64url') };
      for (const [nonce, request] of [['same nonce', first], ['fresh nonce', fresh]]) {
        const at = `${label}, ${state}, ${nonce}`;
        const before = tables();
        // A same-nonce reserve answers from the store; a fresh nonce is classified, so the matrix itself writes nothing.
        const answer = (options) => (request === first ? store.reserve(request, {}, options) : store.classify(request, {}, options));
        const untupled = answer({});
        if (kept) assert.deepEqual(answer({ keepProfile: kept }), untupled, `${at}: the kept tuple answers as the legacy path does`);
        for (const supplied of [PROFILE, OTHER_PROFILE].filter((profile) => profile !== kept)) {
          if (jobGone) { assert.deepEqual(answer({ keepProfile: supplied }), untupled, `${at}: a removed job has no tuple to compare`); continue; }
          assert.throws(() => store.reserve(request, {}, { keepProfile: supplied }), MISMATCH, `${at}: reserve refuses ${kept ? 'another' : 'any'} tuple`);
          assert.throws(() => store.classify(request, {}, { keepProfile: supplied }), MISMATCH, `${at}: classify refuses ${kept ? 'another' : 'any'} tuple`);
        }
        assert.deepEqual(tables(), before, `${at}: no row changed`);
      }
    }
    const conflicting = { ...rows[1].first, bodyHash: derive('another body') };
    assert.throws(() => store.reserve(conflicting, {}, { keepProfile: OTHER_PROFILE }), { code: 'peer_nonce_conflict', status: 409 }, `${label}: a nonce conflict comes before the tuple`);
  };
  check(w.store, 'live');
  check(w.reopen(), 'after restart');
  assert.equal(w.tuples(), 4, 'every profiled job that still exists keeps its one tuple');
});

test('a context step carrying a tuple is refused with nothing kept; after a context step without one, the first proposal keeps its tuple and a proposal under another tuple is refused', async (t) => {
  const w = await world(t, { recover: presentContext });
  const [job] = JOBS;
  const input = await w.wire({ jobId: job });
  const request = w.auth.readRequest(input.header);
  const body = JSON.parse(input.text);
  const client = createSellerTransportClientAuth({ buyerSigner: w.buyer, seller: w.seller.claim, resolveJob: () => ({ listingPin: w.pin, agreementHash: derive('agreement') }), now: w.now });
  const proposal = async (id) => { const { header } = await client.request(PROPOSALS, { jobId: id }, '{}'); return w.auth.readRequest(header); };
  const tables = () => { const db = new DatabaseSync(w.path, { readonly: true }); try { return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(({ name }) => [name, db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]); } finally { db.close(); } };
  const before = tables();
  for (const store of [w.auth.store, w.store]) {
    assert.throws(() => store.reserve(request, body, { keepProfile: PROFILE, admit: () => w.now() }), MISMATCH);
    assert.throws(() => store.classify(request, body, { keepProfile: PROFILE }), MISMATCH);
  }
  assert.deepEqual(tables(), before, 'the refused context step changed no row');
  assert.equal((await exchange(w.handler, input)).status, 200, 'the same step without a tuple is admitted');
  assert.equal(w.store.purchaseProfile(job), null, 'the context step keeps no tuple');
  assert.equal(w.store.reserve(await proposal(job), {}, { keepProfile: PROFILE }).disposition, 'perform');
  const other = await proposal(job);
  assert.throws(() => w.store.reserve(other, {}, { keepProfile: OTHER_PROFILE }), MISMATCH);
  assert.deepEqual(w.store.purchaseProfile(job), PROFILE);
});

test('the store exports no tuple writer, and a tuple row for a job with no peer_jobs row is refused by its foreign key', (t) => {
  const w = storeFixture(t);
  assert.deepEqual(Object.keys(w.store).filter((name) => /keep|profile/i.test(name)), ['purchaseProfile']);
  const db = new DatabaseSync(w.path);
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  assert.throws(() => db.prepare('INSERT INTO kit_purchase_profiles VALUES (?, ?, ?)').run(jobId('orphan'), canonicalize(PROFILE), T), { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
  assert.equal(w.tuples(), 0);
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

test('a job removed after a no-effect answer takes its kept tuple with it, also when the answer comes after a restart, so the job can be proposed again under another tuple', async (t) => {
  const w = storeFixture(t);
  const removed = jobId('removed');
  const reservation = w.store.reserve(w.request(removed), {}, { keepProfile: PROFILE });
  w.reopen();
  assert.equal(w.tuples(), 1);
  w.store.finish(reservation, 409, '{}', { noEffect: true });
  assert.equal(w.jobs(), 0, 'the provisional job is gone');
  assert.equal(w.tuples(), 0, 'and so is its tuple');
  w.reopen();
  assert.equal(w.store.reserve(w.request(removed), {}, { keepProfile: OTHER_PROFILE }).disposition, 'perform');
  assert.deepEqual(w.store.purchaseProfile(removed), OTHER_PROFILE);
});

test('a job retired for capacity after a restart takes its kept tuple with it', async (t) => {
  const w = storeFixture(t, { maxJobs: 1 });
  const retired = jobId('retired');
  w.store.finish(w.store.reserve(w.request(retired), {}, { keepProfile: PROFILE }), 200, '{}');
  // The job's effect, slot and binding rows are gone, so it is reclaimable for capacity without terminal evidence.
  const db = new DatabaseSync(w.path);
  t.after(() => db.close());
  db.exec("DELETE FROM peer_effects; DELETE FROM peer_effect_jobs; DELETE FROM peer_slots;");
  w.reopen();
  const admitted = jobId('admitted');
  assert.equal(w.store.reserve(w.request(admitted), {}, { keepProfile: OTHER_PROFILE }).disposition, 'perform');
  assert.equal(w.store.purchaseProfile(retired), null, 'the retired job\'s tuple is gone');
  assert.deepEqual(w.store.purchaseProfile(admitted), OTHER_PROFILE);
  assert.deepEqual([w.jobs(), w.tuples()], [1, 1]);
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
