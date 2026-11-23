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
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import DatabaseSync from 'better-sqlite3';
import { canonicalize, generateCanonicalJobId, sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_HEADER, TP1_APPROVED_IDENTITY_RECORD, TP1_BASE_REVISION, TP1_PROFILE_ID, TP1_PROFILE_REVISION, assertTp1Authority, wireOperationId } from '@kynesyslabs/dacs/wire';
import { journalStore, reserveEffect } from '../../../dist/wire/journal.js';
import { commitmentFixture } from './helpers/commitment-fixture.mjs';
import { ORCHESTRATOR_MODE } from './helpers/proposal-admission-fixture.mjs';
import { T } from './helpers/d5-http-fixture.mjs';
import { privateModule } from './helpers/private-module.mjs';
import { NOW, buyer, seller } from './helpers/protocol-fixture.mjs';
import { hostAuthority, testWalletSession } from './helpers/kit-wallet-session.mjs';
import { FIXTURE_ENDPOINT, wireBuyer } from './helpers/wire-buyer.mjs';
import { LISTING_AUTHORITY, proxyListener } from './helpers/listener-host.mjs';
import { syncDirectory } from '../src/devnet-demo/durable-file.mjs';
import { spyOnFsync } from './helpers/fsync-spy.mjs';
import { KIT_DATA_FORMAT, assertKitDataFormat } from '../src/dacs/kit-data-format.mjs';
import { boundedCall, isBoundedCallTimeout } from '../src/dacs/bounded-call.mjs';
import { createPurchaseCapacity } from '../src/dacs/seller-purchase-capacity.mjs';
import { createSellerTransportStore as createUnboundTransportStore, sellerStoreInternals } from '../src/dacs/seller-transport-auth.mjs';
import { createSellerTransportStore } from './helpers/bound-transport-store.mjs';

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
const STATE = '/dacs/v1/agreements/state';
const COMMITMENTS = '/dacs/v1/commitments';
// The host's default `maxRecords`, and the units a purchase allocation needs free.
const DEFAULT_RESERVATION_BUDGET = 10000;
const PURCHASE_ALLOTMENT = 68;
const DAY_MS = 86400000;
// The fixture anchors no Agreement, so a commitment the host admits is refused by the agent with this answer.
const COMMITMENT_UNANCHORED = Object.freeze({ status: 422, error: 'agreement_not_anchored' });
// The host's handler serves at most this many requests at once.
const HANDLER_CONCURRENCY = 8;
// The challenge ledger issues one buyer at most this many challenges an hour (CHALLENGE_LIMIT_DEFAULTS.maxPerBuyerPerHour).
const PROPOSALS_PER_BUYER = 5;
const BUYER = { claim: buyer.claim, sign: buyer.signBytes };
const SELLER = { claim: seller.claim, sign: seller.signBytes };
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
  const f = await commitmentFixture(t, { vetMode: ORCHESTRATOR_MODE, publicEndpoint: FIXTURE_ENDPOINT });
  const dataDirectory = realpathSync(await mkdtemp(join(tmpdir(), 'TEST-host-wire-state-')));
  const { nativeArtifactAnchor, ...config } = f.config;
  delete config.challengeLedger; // the host builds its own ledger
  delete config.durableDirectory;
  delete config.commitOnSignature;
  // The host fixes its Vet mode and takes no such option.
  delete config.vetMode;
  const api = await privateModule(HOST_URL, ['setTestRecorder'], (source) => {
    const text = sub(sub(source, 'completeWireEffect, inspectWireOperation, openWireRequestJournal } from', 'completeWireEffect, inspectWireOperation, openWireRequestJournal as REAL_OPEN_JOURNAL } from'),
      'import { openSellerStages } from', 'import { openSellerStages as REAL_OPEN_STAGES } from');
    return sub(text, 'const REQUIRED =', `let testRecorder = { bindings: [], journals: [] }; function setTestRecorder(value) { testRecorder = value; }
const openSellerStages = async (options) => { const stages = await REAL_OPEN_STAGES(options); testRecorder.bindings.push(stages.binding); return stages; };
const openWireRequestJournal = (...args) => { const journal = REAL_OPEN_JOURNAL(...args); testRecorder.journals.push(journal); return journal; };
const REQUIRED =`);
  });
  // The private module is one cached instance for every fixture: each fixture records into its own lists.
  const recorded = { bindings: [], journals: [] };
  api.setTestRecorder(recorded);
  const hosts = [];
  const options = { ...config, artifactAnchor: nativeArtifactAnchor, dataDirectory, ...hostAuthority(), listener: proxyListener(), now: () => NOW };
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
  return { start, options, dataDirectory, proposal: f.proposal, ...recorded, path: (...names) => join(dataDirectory, ...names) };
}

/** One signed request posted to a running host over loopback HTTP: `{ status, header, bytes, payload }`. */
const postSigned = (host, { payload, header, text, path = payload.path }) => new Promise((resolve, reject) => {
  const sent = httpRequest(`${host.url}${path}`, { method: 'POST', headers: { host: LISTING_AUTHORITY, 'content-type': 'application/json', [DACS_SELLER_HTTP_HEADER]: header } }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, header: res.headers[DACS_SELLER_HTTP_HEADER], bytes: Buffer.concat(chunks), payload }));
  });
  sent.on('error', reject);
  sent.end(text);
});
/** A signed state read for a job the host holds nothing for: its answer is the signed 404 `peer_unknown_job`. */
const unknownStateRequest = (buyerWire, label) => {
  const unknown = jobId(`unknown-${label}`), agreementHash = derive(`agreement-${label}`);
  return buyerWire.signRequest(STATE, { transportIdentity: { jobId: unknown, buyer: buyer.claim, seller: seller.claim, agreementHash } }, { jobId: unknown, agreementHash });
};
const verifiedAnswer = (buyerWire, { payload, header, status, bytes }) => buyerWire.authentication(() => null).verifyResponse(payload, { header, status, responseBytes: bytes });

const lockReleased = (f) => assert.deepEqual(namesIn(f.dataDirectory).filter((name) => name.startsWith(LOCK_FILE_PREFIX)), [], 'the state lock is released');
const writeMarker = (f) => writeFileSync(f.path(MARKER_FILE), MARKER_TEXT, { mode: 0o600 });
const makePrivateDirectory = (path) => { mkdirSync(path, { mode: 0o700 }); chmodSync(path, 0o700); return path; };
// A directory sync reports its failure wrapped, with the injected error as cause; a file sync reports it as is.
const injectedFailure = (error) => error.cause ?? error;
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
  const step = syncStep(f, log, options);
  const listen = Server.prototype.listen;
  const spy = spyOnFsync({ aroundSync: (path, sync) => step({ kind: statSync(path).isDirectory() ? 'directory' : 'file', path }, sync) });
  Server.prototype.listen = function recordedListen(...args) { log.push({ kind: 'listen' }); return listen.apply(this, args); };
  try { return await work(); } finally { spy.restore(); Server.prototype.listen = listen; }
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
    tuples: () => query('SELECT COUNT(*) AS n FROM kit_purchase_profiles'), jobs: () => query('SELECT COUNT(*) AS n FROM peer_jobs') };
}

// ================================================================ host tests

test('host returns a completed proposal after its session ends', async (t) => {
  let terminal = false;
  const f = await hostFixture(t);
  const host = await f.start({ contextSessionState: () => terminal ? 'finalised' : null });
  const body = await f.proposal(host);
  const { jobId, agreementHash } = body.transportIdentity;
  const buyerWire = await wireBuyer({ buyer: BUYER, seller: SELLER, listingPin: host.listingPin, clock: () => NOW });
  const signed = await buyerWire.signRequest(PROPOSALS, body, { jobId, agreementHash });
  const first = await postSigned(host, signed);
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(first.bytes).disposition, 'complete');
  await verifiedAnswer(buyerWire, first);

  terminal = true;
  const fresh = await buyerWire.signRequest(PROPOSALS, body, { jobId, agreementHash });
  assert.notEqual(fresh.payload.nonce, signed.payload.nonce);
  const retry = await postSigned(host, fresh);
  assert.equal(retry.status, 200, retry.bytes.toString());
  assert.deepEqual(retry.bytes, first.bytes);
  await verifiedAnswer(buyerWire, retry);

  const replay = await postSigned(host, signed);
  assert.equal(replay.status, 409, replay.bytes.toString());
  assert.equal(JSON.parse(replay.bytes).error, 'peer_request_replayed');
});

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

test('host start releases the open slots of a finished session once, starts with a maxRecords below what is already allotted, and refuses a zero one', async (t) => {
  const f = await hostFixture(t);
  await (await f.start()).close();
  const finished = generateCanonicalJobId({ timestamp: NOW, entropy: Buffer.alloc(10, 1) }), live = generateCanonicalJobId({ timestamp: NOW, entropy: Buffer.alloc(10, 2) });
  const withCapacity = (work) => {
    const store = createUnboundTransportStore({ path: f.path(STORE_FILE) });
    const internals = sellerStoreInternals(store);
    try { return work(createPurchaseCapacity({ store, now: () => NOW, sessionState: internals.sessionState }), internals); } finally { store.close(); }
  };
  withCapacity((capacity, { transaction }) => {
    for (const id of [finished, live]) transaction(() => capacity.allocateWithin({ jobId: id, buyer: claim('buyer'), seller: claim('seller'), listingPin: { listingId: 'host-listing', version: 1, contentHash: derive('listing') } }));
  });
  const states = () => withCapacity((capacity) => Object.fromEntries(capacity.capacityReport().allocations.map((allocation) => [allocation.jobId, allocation.state])));
  assert.deepEqual(states(), { [finished]: 'live', [live]: 'live' });
  const contextSessionState = ({ jobId: id }) => (id === finished ? 'finalised' : null);
  await (await f.start({ contextSessionState })).close();
  assert.deepEqual(states(), { [finished]: 'released', [live]: 'live' });
  await (await f.start({ contextSessionState, maxRecords: 40 })).close();
  assert.deepEqual(states(), { [finished]: 'released', [live]: 'live' });
  assert.ok(await rejection(f.start({ maxRecords: 0 })));
  lockReleased(f);
});

// A host, started with `hostOptions` (the default limits when none are given), whose seller history holds `count` settled
// accounting rows of an earlier purchase, written in the accounting's own shape while the host is stopped (one clean restart).
// The rows are a day old; the purchase budget counts every row ever written.
async function hostWithAccountingHistory(t, count, hostOptions = {}) {
  const f = await hostFixture(t);
  const first = await f.start(), listingPin = first.listingPin;
  await first.close();
  const earlier = generateCanonicalJobId({ timestamp: NOW - DAY_MS, entropy: Buffer.alloc(10, 9) }), historyBuyer = claim('history-buyer');
  const operationId = wireOperationId({ seller: seller.claim, jobId: earlier, path: PROPOSALS });
  const db = new DatabaseSync(f.path(STORE_FILE));
  try {
    db.transaction(() => {
      db.prepare('INSERT INTO kit_job_holds VALUES (?, ?, ?, ?, 0)').run(earlier, historyBuyer, seller.claim, canonicalize(listingPin));
      const row = db.prepare(`INSERT INTO kit_reservations (key, buyer, jobId, operationId, route, allocationId, class, requestHash, at, state, rev)
        VALUES (?, ?, ?, ?, ?, NULL, 'general', ?, ?, 'completed', 2)`);
      for (let n = 0; n < count; n++) row.run(derive(`history-${n}`), historyBuyer, earlier, operationId, PROPOSALS, derive('history-request'), NOW - DAY_MS);
    })();
  } finally { db.close(); }
  const host = await f.start(hostOptions);
  const buyerWire = await wireBuyer({ buyer: BUYER, seller: SELLER, listingPin: host.listingPin, clock: () => NOW });
  const read = (sql, ...args) => { const view = new DatabaseSync(f.path(STORE_FILE), { readonly: true }); try { return view.prepare(sql).all(...args); } finally { view.close(); } };
  const accountingRows = () => read('SELECT COUNT(*) AS n FROM kit_reservations')[0].n;
  const rowStates = (id) => read('SELECT state FROM kit_reservations WHERE jobId = ? ORDER BY rowid', id).map((row) => row.state);
  const propose = async (id) => {
    const body = await f.proposal(host, id), { agreementHash } = body.transportIdentity;
    const sign = () => buyerWire.signRequest(PROPOSALS, body, { jobId: id, agreementHash });
    return { id, agreementHash, sign, answer: await postSigned(host, await sign()) };
  };
  const commit = async ({ id, agreementHash }) => {
    const { status, bytes } = await postSigned(host, await buyerWire.signRequest(COMMITMENTS, { jobId: id }, { jobId: id, agreementHash }));
    return { status, error: JSON.parse(bytes).error };
  };
  return { host, accountingRows, rowStates, propose, commit };
}

test('with the default budget and 9,930 earlier accounting rows, a purchase whose proposal was answered reaches the agent with its commitment after another purchase takes the free budget below one allotment', async (t) => {
  const { accountingRows, propose, commit } = await hostWithAccountingHistory(t, 9930);
  const a = await propose(generateCanonicalJobId({ timestamp: NOW, entropy: Buffer.alloc(10, 1) }));
  assert.equal(a.answer.status, 200, a.answer.bytes.toString());
  assert.equal(JSON.parse(a.answer.bytes).disposition, 'complete');
  const b = await propose(generateCanonicalJobId({ timestamp: NOW, entropy: Buffer.alloc(10, 2) }));
  assert.equal(b.answer.status, 200, b.answer.bytes.toString());
  assert.deepEqual(await commit(b), COMMITMENT_UNANCHORED);
  assert.ok(DEFAULT_RESERVATION_BUDGET - accountingRows() < PURCHASE_ALLOTMENT, 'the free budget is below one allotment');
  assert.deepEqual(await commit(a), COMMITMENT_UNANCHORED, 'the commitment passes the readiness gate');
});

test('with the default budget and 9,932 earlier accounting rows, a proposal is served and its retry answers the same; no request is charged and then refused', async (t) => {
  const { host, rowStates, propose } = await hostWithAccountingHistory(t, 9932);
  const a = await propose(generateCanonicalJobId({ timestamp: NOW, entropy: Buffer.alloc(10, 1) }));
  assert.equal(a.answer.status, 200, a.answer.bytes.toString());
  assert.equal(JSON.parse(a.answer.bytes).disposition, 'complete');
  const retry = await postSigned(host, await a.sign());
  assert.equal(retry.status, 200, retry.bytes.toString());
  assert.deepEqual(retry.bytes, a.answer.bytes);
  assert.deepEqual(rowStates(a.id).filter((state) => state === 'refused'), [], 'no row of the purchase is a charged refusal');
});

test('with the default budget and 9,933 earlier accounting rows, the host still issues a challenge and serves a new purchase', async (t) => {
  const { accountingRows, propose } = await hostWithAccountingHistory(t, 9933);
  assert.ok(DEFAULT_RESERVATION_BUDGET - accountingRows() < PURCHASE_ALLOTMENT, 'the free budget is below one allotment');
  const a = await propose(generateCanonicalJobId({ timestamp: NOW, entropy: Buffer.alloc(10, 1) }));
  assert.equal(a.answer.status, 200, a.answer.bytes.toString());
  assert.equal(JSON.parse(a.answer.bytes).disposition, 'complete');
});

const NEW_PURCHASE = generateCanonicalJobId({ timestamp: NOW, entropy: Buffer.alloc(10, 1) });

// A new purchase is admitted by its context request, which takes a whole allotment and one general row of its own before any proposal
// is sent. With one retained accounting row, that request is served while the reservation budget has room for the row, the allotment
// and one more unit; it is refused `peer_store_capacity` when the allotment fits and the unit does not, `seller_not_ready` when the
// allotment does not fit, and `peer_store_capacity` once the store's record limit is the retained row.
const refusalOf = async (propose) => { const { code, status } = await rejection(propose(NEW_PURCHASE)); return [status, code]; };

test('a host whose reservation budget is one above its retained rows and one allotment serves a request while maxRecords is at its default', async (t) => {
  const { propose } = await hostWithAccountingHistory(t, 1, { maxReservationUnits: 2 + PURCHASE_ALLOTMENT });
  const { answer } = await propose(NEW_PURCHASE);
  assert.equal(answer.status, 200, answer.bytes.toString());
});

test('a host whose reservation budget equals its retained rows and one allotment refuses a request while maxRecords is at its default', async (t) => {
  const { propose } = await hostWithAccountingHistory(t, 1, { maxReservationUnits: 1 + PURCHASE_ALLOTMENT });
  assert.deepEqual(await refusalOf(propose), [503, 'peer_store_capacity']);
});

test('a host whose reservation budget is one unit short of its retained rows and one allotment refuses a request as not ready', async (t) => {
  const { propose } = await hostWithAccountingHistory(t, 1, { maxReservationUnits: PURCHASE_ALLOTMENT });
  assert.deepEqual(await refusalOf(propose), [503, 'seller_not_ready']);
});

test('a host whose maxRecords equals its retained rows refuses a request while the reservation budget has room', async (t) => {
  const { propose } = await hostWithAccountingHistory(t, 1, { maxRecords: 1, maxReservationUnits: DEFAULT_RESERVATION_BUDGET });
  assert.deepEqual(await refusalOf(propose), [503, 'peer_store_capacity']);
});

test('a host refuses a zero or fractional reservation budget and names the option', async (t) => {
  const f = await hostFixture(t);
  await (await f.start({ maxReservationUnits: 1 })).close();
  for (const maxReservationUnits of [0, 1.5]) assert.match((await rejection(f.start({ maxReservationUnits }))).message, /maxReservationUnits must be a positive integer/);
});

test('a host refuses a bad maxRecords and names maxRecords, not the reservation budget', async (t) => {
  const f = await hostFixture(t);
  for (const maxRecords of [0, 1.5, '100']) {
    const { message } = await rejection(f.start({ maxRecords }));
    assert.match(message, /maxRecords must be a positive integer/);
    assert.doesNotMatch(message, /maxReservationUnits/);
  }
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
      assert.equal(injectedFailure(error).message, SYNC_FAILURE);
      assert.equal(log.some((event) => event.kind === 'listen'), false, 'nothing was served');
      lockReleased(f);
    });
    await t.test(`a crash just after the sync covering ${entry} restarts safely`, async (subtest) => {
      const f = await hostFixture(subtest);
      const error = await withHostSyncs(f, [], () => rejection(f.start()), { fail: covering(f), after: true });
      assert.equal(injectedFailure(error).message, SYNC_FAILURE);
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

// A fresh wallet-session port whose connection reader is `connectionAuthority(scope, real)`; `real` is the port's own reader.
const withConnection = (connectionAuthority) => {
  const { walletSession } = testWalletSession();
  return { ...walletSession, connectionAuthority: (scope) => connectionAuthority(scope, walletSession.connectionAuthority) };
};

test('a started host reads its connection once at startup and again for each signed request and answer, every time calling context() on the wallet session\'s authority', async (t) => {
  const f = await hostFixture(t);
  const receivers = [];
  const { walletSession } = testWalletSession();
  const authority = { ...walletSession.authority, context() { receivers.push(this); return walletSession.authority.context(); } };
  const host = await f.start({ walletSession: { ...walletSession, authority } });
  assert.deepEqual(receivers, [authority], 'startup binds over one read');
  const buyerWire = await wireBuyer({ buyer: BUYER, seller: SELLER, listingPin: host.listingPin, clock: () => NOW });
  const answer = await postSigned(host, await unknownStateRequest(buyerWire, 'receiver'));
  assert.equal(answer.status, 404);
  await verifiedAnswer(buyerWire, answer);
  assert.ok(receivers.length >= 3, `the request and its answer read the connection again (${receivers.length} reads)`);
  assert.ok(receivers.every((receiver) => receiver === authority), 'every read ran on the authority');
});

test('the reader each signed request calls is bounded: a stalled read is pending at 9,999 ms and ends tp1_authority_timeout at 10,000 ms with the deadline as its cause; the refusals (unsigned: the request was never authenticated) reserve nothing and free every request slot; a late answer is ignored and never unhandled', async (t) => {
  const f = await hostFixture(t);
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const stalled = [];
  let stall = false;
  const walletSession = withConnection((scope, real) => (stall ? new Promise((resolve) => { stalled.push(() => resolve(real(scope))); }) : real(scope)));
  try {
    const host = await f.start({ walletSession });
    const [binding] = f.bindings;
    const buyerWire = await wireBuyer({ buyer: BUYER, seller: SELLER, listingPin: host.listingPin, clock: () => NOW });
    // Signed proposals up to the buyer's challenge limit; the other stalled requests are signed state reads, which need no challenge.
    const proposals = await Promise.all(Array.from({ length: HANDLER_CONCURRENCY }, async (_, index) => {
      if (index >= PROPOSALS_PER_BUYER) return unknownStateRequest(buyerWire, `stalled-${index}`);
      const body = await f.proposal(host, jobId(`stalled-${index}`));
      return buyerWire.signRequest(PROPOSALS, body, { jobId: body.transportIdentity.jobId, agreementHash: body.transportIdentity.agreementHash });
    }));
    assert.equal(new Set(proposals.map(({ payload }) => payload.nonce)).size, HANDLER_CONCURRENCY);
    const [overflow, afterwards] = [await unknownStateRequest(buyerWire, 'overflow'), await unknownStateRequest(buyerWire, 'afterwards')];
    stall = true;
    mock.timers.enable({ apis: ['setTimeout'] });
    let direct = 'pending';
    const reading = assertTp1Authority(binding, binding.local, [], null).then(() => { direct = 'passed'; }, (error) => { direct = error; });
    const answers = proposals.map((signed) => postSigned(host, signed));
    for (let turn = 0; stalled.length < HANDLER_CONCURRENCY + 1 && turn < 1000; turn++) await flush();
    assert.equal(stalled.length, HANDLER_CONCURRENCY + 1, 'every proposal is waiting on the reader');
    assert.equal((await postSigned(host, overflow)).status, 429, 'the stalled requests hold every request slot');
    let answered = 0;
    for (const answer of answers) answer.then(() => { answered++; });
    mock.timers.tick(AUTHORITY_DEADLINE_MS - 1);
    await flush();
    assert.deepEqual({ direct, answered }, { direct: 'pending', answered: 0 }, 'still waiting at 9,999 ms');
    mock.timers.tick(1);
    await reading;
    const refusals = await Promise.all(answers);
    mock.timers.reset();
    assert.deepEqual({ code: direct.code, status: direct.status, deadline: isBoundedCallTimeout(direct.cause) }, { code: 'tp1_authority_timeout', status: 500, deadline: true });
    for (const refusal of refusals) assert.deepEqual({ status: refusal.status, error: JSON.parse(refusal.bytes).error, signed: refusal.header !== undefined }, { status: 500, error: 'tp1_authority_timeout', signed: false });
    for (const settleLate of stalled) settleLate();
    await flush();
    await flush();
    assert.deepEqual(unhandled, []);
    const db = new DatabaseSync(f.path(STORE_FILE), { readonly: true });
    try { assert.deepEqual(['peer_jobs', 'peer_effects', 'kit_purchase_profiles'].map((table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n), [0, 0, PROPOSALS_PER_BUYER], 'nothing was reserved or kept beyond the tuples the context admissions kept'); } finally { db.close(); }
    stall = false;
    assert.equal((await postSigned(host, afterwards)).status, 404, 'a later request is answered: the slots were released');
  } finally {
    mock.timers.reset();
    process.off('unhandledRejection', onUnhandled);
  }
});

test('P10-T09 a plain-HTTP endpoint or a revision-1 chain refuses before the lock and before any file', async (t) => {
  const plainHttp = () => {
    const { walletSession } = testWalletSession();
    return { ...walletSession, authority: { ...walletSession.authority, context: () => ({ ...walletSession.authority.context(), endpoint: 'http://rpc.example.invalid/' }) } };
  };
  const cases = [
    ['a plain-HTTP endpoint', plainHttp, 'tp1_local_binding_invalid'],
    ['a reader naming another chain', () => withConnection(async (scope, real) => ({ ...await real(scope), chainIdentity: derive('revision-1-chain') })), 'tp1_connection_unverified'],
  ];
  for (const [label, walletSession, code] of cases) {
    await t.test(label, async (subtest) => {
      const f = await hostFixture(subtest);
      assert.equal((await rejection(f.start({ walletSession: walletSession() }))).code, code);
      assert.deepEqual(namesIn(f.dataDirectory), [], 'no lock, marker or state file exists');
    });
  }
});

test('P10-T10 a rejecting reader keeps its cause, a stalled one times out at 10,000 ms, and a late answer is ignored', async (t) => {
  await t.test('a rejecting reader keeps its cause', async (subtest) => {
    const f = await hostFixture(subtest);
    const cause = new Error('TEST authority unavailable');
    const error = await rejection(f.start({ walletSession: withConnection(() => Promise.reject(cause)) }));
    assert.equal(error, cause);
    assert.deepEqual(namesIn(f.dataDirectory), []);
  });
  await t.test('a TimeoutError the reader raises itself is its own error, not the host\'s deadline', async (subtest) => {
    const f = await hostFixture(subtest);
    const cause = new DOMException('TEST the reader\'s own request timed out', 'TimeoutError');
    const error = await rejection(f.start({ walletSession: withConnection(() => Promise.reject(cause)) }));
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
      const walletSession = withConnection((scope, real) => { reads++; return new Promise((resolve, reject) => { settleLate = () => (late === 'answer' ? resolve(real(scope)) : reject(new Error('TEST late failure'))); }); });
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        let outcome = 'pending';
        const starting = f.start({ walletSession }).then(() => { outcome = 'started'; }, (error) => { outcome = error; });
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
  for (const options of [{ record: forged }, { identityRecord: forged }, { tp1Network: { record: forged } }]) {
    const error = await rejection(f.start(options));
    assert.equal(error.name, 'TypeError');
    assert.match(error.message, /unknown seller host option/);
  }
  assert.equal((await rejection(f.start({ walletSession: undefined }))).message, 'the seller host requires walletSession');
  assert.equal((await rejection(f.start({ participantImplementations: undefined }))).message, 'the seller host requires participantImplementations');
  assert.match((await rejection(f.start({ walletSession: { authority: {} } }))).message, /walletSession/);
  assert.deepEqual(namesIn(f.dataDirectory), [], 'every refusal came before any file');
  const names = ['DACS_TP1_RECORD', 'DACS_TP1_IDENTITY_RECORD', 'TP1_RECORD'];
  for (const name of names) process.env[name] = JSON.stringify(forged);
  // A record carried on the wallet-session port is never read either.
  try { await f.start({ walletSession: { ...testWalletSession().walletSession, record: forged } }); } finally { for (const name of names) delete process.env[name]; }
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
    const read = () => { reads++; };
    const walletSession = { authority: { authorityRpc: read, context: () => { reads++; return {}; }, connectionGeneration: read }, connectionAuthority: read, finalize: read };
    try { await startSellerHost({ dataDirectory: process.env.DATA_DIRECTORY, walletSession }); }
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

test('keepPurchaseProfileWithin validates synchronously and persists or rolls back detached tuples', (t) => {
  const w = storeFixture(t), job = jobId('detached');
  let port = sellerStoreInternals(w.store);
  assert.equal(Object.isFrozen(port), true);
  assert.equal(typeof port.keepPurchaseProfileWithin, 'function');
  assert.equal(w.store.keepPurchaseProfileWithin, undefined);
  assert.throws(() => sellerStoreInternals({ ...w.store }), TypeError);
  assert.throws(() => port.keepPurchaseProfileWithin(job, PROFILE), /transaction/);
  port.transaction(() => {
    assert.throws(() => port.keepPurchaseProfileWithin('bad-job', PROFILE), { code: 'peer_job_invalid' });
    for (const profile of [null, { ...PROFILE, extra: 1 }]) assert.throws(() => port.keepPurchaseProfileWithin(job, profile), MISMATCH);
    assert.throws(() => port.keepPurchaseProfileWithin(job, PROFILE, NaN), { code: 'peer_clock_invalid' });
    assert.equal(port.keepPurchaseProfileWithin(job, PROFILE), undefined);
  });
  assert.deepEqual([w.jobs(), w.tuples()], [0, 1]);
  assert.equal(port.db.prepare('SELECT kept_at FROM kit_purchase_profiles WHERE job = ?').get(job).kept_at, T);
  w.advance(123); port.transaction(() => port.keepPurchaseProfileWithin(job, PROFILE));
  assert.equal(port.db.prepare('SELECT kept_at FROM kit_purchase_profiles WHERE job = ?').get(job).kept_at, T);
  assert.throws(() => port.transaction(() => port.keepPurchaseProfileWithin(job, OTHER_PROFILE)), MISMATCH);
  assert.throws(() => port.transaction(() => { port.keepPurchaseProfileWithin(jobId('rolled-back'), PROFILE); throw new Error('tuple-cut'); }), /tuple-cut/);
  const exec = port.db.exec.bind(port.db);
  port.db.exec = sql => { if (sql === 'COMMIT') throw new Error('commit-cut'); return exec(sql); };
  assert.throws(() => port.transaction(() => port.keepPurchaseProfileWithin(jobId('commit-cut'), PROFILE)), /commit-cut/);
  port.db.exec = exec;
  w.reopen(); port = sellerStoreInternals(w.store);
  assert.deepEqual(w.store.purchaseProfile(job), PROFILE);
  assert.equal(w.store.purchaseProfile(jobId('rolled-back')), null);
  assert.equal(w.store.purchaseProfile(jobId('commit-cut')), null);
  assert.deepEqual(port.db.pragma('foreign_key_list(kit_purchase_profiles)'), []);
});

test('started host signed proposal creates accounting and wire operation records', async (t) => {
  const f = await hostFixture(t), host = await f.start();
  const body = await f.proposal(host), { jobId: id, agreementHash } = body.transportIdentity;
  // The job's context admission, made to open the session, wrote its own records first.
  const journalFiles = () => ({ requests: namesIn(f.path(JOURNAL_DIRECTORY)).filter(name => name.startsWith('k-')).length, operations: namesIn(f.path(JOURNAL_DIRECTORY)).filter(name => /^o-.*-0$/.test(name)).length });
  const before = journalFiles();
  const buyerWire = await wireBuyer({ buyer: BUYER, seller: SELLER, listingPin: host.listingPin, clock: () => NOW });
  const answer = await postSigned(host, await buyerWire.signRequest(PROPOSALS, body, { jobId: id, agreementHash }));
  const db = new DatabaseSync(f.path(STORE_FILE), { readonly: true });
  try {
    assert.deepEqual(db.prepare('SELECT jobId, route, state FROM kit_reservations WHERE route = ?').all(PROPOSALS), [{ jobId: id, route: PROPOSALS, state: 'new' }]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peer_effects').get().n, 0);
  } finally { db.close(); }
  assert.deepEqual(Object.fromEntries(Object.entries(journalFiles()).map(([name, count]) => [name, count - before[name]])), { requests: 1, operations: 1 });
  assert.ok(answer.header, 'the started host signs the result');
});
