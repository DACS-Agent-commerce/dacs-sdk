// Standalone durable wallet journal evidence: real node:sqlite file, actual
// independent Node child processes, and the unchanged wallet session / SR-2
// bridge as consumers against a test-owned loopback SDK-wire fixture. Process
// kill is not power loss; no hardware durability is established here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { createDemosSr2WalletBridge, SR2_WALLET_KIND } from '../src/dacs/demos-sr2-wallet-bridge.mjs';
import * as shipped from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { startHarness } from './helpers/harness.mjs';
import { installLoopbackOnlyGuard } from './helpers/embedded-wallet-flow-fixtures.mjs';
import { startAnchorFixture, anchorRequest, FIXTURE_IDENTITY } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { observedFixture } from './helpers/durable-wallet-journal-sr2-fixture.mjs';
import { durableBrokerSetup, storage } from './helpers/durable-wallet-journal-broker.mjs';
import { durableBrowserSetup, durableReachCreate } from './helpers/durable-wallet-journal-browser.mjs';
import { UI, assertNoSecrets } from './helpers/embedded-wallet-fixtures.mjs';

installLoopbackOnlyGuard();
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { Demos, Identities, validateMnemonic } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');
const child = new URL('./helpers/durable-wallet-journal-child.mjs', import.meta.url);
const exact = (v) => JSON.stringify(v);

async function dir(t) {
  const d = await mkdtemp(join(tmpdir(), 'dacs-durable-journal-'));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}
async function created(t, options = {}) {
  const path = join(await dir(t), 'wallet-journal.sqlite');
  const journal = openDurableWalletJournal({ path, mode: 'create', ...options });
  t.after(() => { try { journal.close(); } catch { /* closed by the test */ } });
  return { path, journal };
}
const rejects = (promise, code) => assert.rejects(promise, (e) => { assert.equal(e.code, code, e.message); return true; });
const throws = (fn, code) => assert.throws(fn, (e) => { assert.equal(e.code, code, e.message); return true; });

// Owned child: bounded SIGKILL cleanup on test end.
async function spawn(t, path, lockMs = 2000) {
  const proc = fork(child, [], { execArgv: ['--disable-warning=ExperimentalWarning'], env: { DACS_DURABLE_JOURNAL_PATH: path, DACS_DURABLE_JOURNAL_LOCK_MS: String(lockMs) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c; });
  const events = [];
  const waiters = [];
  // A dead child answers nothing: pending calls end at once, never after the test.
  const exited = new Promise((resolve) => proc.once('exit', (code, signal) => { for (const w of waiters.splice(0)) w.reject(new Error(`child exited ${signal ?? code}`)); resolve({ code, signal }); }));
  t.after(async () => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]); });
  proc.on('message', (m) => { events.push(m); for (const w of [...waiters]) if (w.match(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  const next = (match, ms = 5000) => {
    const found = events.find(match);
    if (found) { events.splice(events.indexOf(found), 1); return Promise.resolve(found); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child timeout; stderr: ${stderr}`)), ms);
      waiters.push({ match, resolve: (m) => { clearTimeout(timer); events.splice(events.indexOf(m), 1); resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    });
  };
  let id = 0;
  const call = (op, args = {}) => { id += 1; const mine = id; proc.send({ id: mine, op, ...args }); return next((m) => m.id === mine, 15000); };
  const ready = await next((m) => m.event === 'ready');
  return { proc, call, next, exited, ready, stderr: () => stderr };
}

const signedIntent = (lane, n = 1) => ({ lane, stage: 'broadcast-started', nonce: n, hash: 'ab'.repeat(32),
  signedTransaction: { content: { type: 'storageProgram', nonce: n, z: 1, a: [1, 'two', { y: null, b: true }] }, signature: { type: 'ed25519', data: '0x' + 'cd'.repeat(64) }, hash: 'ab'.repeat(32), status: '', blockNumber: null },
  approved: { storageFeeOs: '1000000000', logicalAddress: 'dacs3:agreement:x', contentHash: 'ef'.repeat(32) } });

test('accepting persistence: exact key order and signed intent survive close/reopen; explicit modes fail closed', async (t) => {
  t.diagnostic(`runtime ${process.execPath} ${process.version}; started ${new Date().toISOString()}`);
  const { path, journal } = await created(t);
  const lane = JSON.stringify(['fixture-net', FIXTURE_IDENTITY, '0x' + '11'.repeat(32)]);
  const intent = signedIntent(lane);
  await journal.put(lane, intent);
  await journal.put('other', { z: 2, a: 1 });
  await journal.put(lane, { ...intent, stage: 'broadcast-accepted' });
  assert.equal(exact(await journal.get(lane)), exact({ ...intent, stage: 'broadcast-accepted' }));
  assert.equal(await journal.get('absent'), undefined);
  const id = journal.journalId;
  journal.close();
  const reopened = openDurableWalletJournal({ path, mode: 'open', expectedJournalId: id });
  t.after(() => reopened.close());
  assert.equal(reopened.journalId, id);
  assert.deepEqual((await reopened.entries()).map(([k]) => k), [lane, 'other'], 'insertion order is retained like the in-memory Map');
  assert.equal(exact(await reopened.get(lane)), exact({ ...intent, stage: 'broadcast-accepted' }));
  assert.equal(exact(await reopened.get('other')), '{"z":2,"a":1}');
  throws(() => openDurableWalletJournal({ path, mode: 'create' }), 'journal-exists');
  throws(() => openDurableWalletJournal({ path: path + '.absent', mode: 'open' }), 'journal-absent');
  throws(() => openDurableWalletJournal({ path, mode: 'open', expectedJournalId: 'f'.repeat(32) }), 'journal-integrity');
  throws(() => openDurableWalletJournal({ path, mode: undefined }), 'journal-invalid');
  throws(() => openDurableWalletJournal({ path: 'relative.sqlite', mode: 'open' }), 'journal-invalid');
});

test('changed, moved, removed, corrupt and absent durable records fail closed', async (t) => {
  const setup = async (s) => { const w = await created(s); await w.journal.put('lane-a', signedIntent('lane-a')); await w.journal.put('lane-b', signedIntent('lane-b', 2)); return w; };
  const raw = (path, sql, ...args) => { const db = new DatabaseSync(path); try { db.prepare(sql).run(...args); } finally { db.close(); } };
  await t.test('changed record value', async (s) => {
    const { path, journal } = await setup(s);
    raw(path, "UPDATE records SET value = replace(value, 'broadcast-started', 'broadcast-accepted') WHERE key = 'lane-a'");
    await rejects(journal.get('lane-a'), 'journal-integrity');
    await rejects(journal.entries(), 'journal-integrity');
    await rejects(journal.withWalletLock('lane-a', async () => {}), 'journal-integrity');
    assert.equal((await journal.get('lane-b')).nonce, 2, 'an unrelated intact row remains readable');
  });
  await t.test('record moved to another key', async (s) => {
    const { path, journal } = await setup(s);
    raw(path, "UPDATE records SET key = 'lane-c' WHERE key = 'lane-a'");
    await rejects(journal.get('lane-c'), 'journal-integrity');
  });
  await t.test('record removed', async (s) => {
    const { path, journal } = await setup(s);
    raw(path, "DELETE FROM records WHERE key = 'lane-a'");
    await rejects(journal.get('lane-a'), 'journal-integrity', 'a removed fence is not read as absent');
    await rejects(journal.put('lane-z', { x: 1 }), 'journal-integrity');
  });
  await t.test('journal identity replaced', async (s) => {
    const { path, journal } = await setup(s);
    raw(path, "UPDATE meta SET value = ? WHERE key = 'journal_id'", 'e'.repeat(32));
    await rejects(journal.get('lane-b'), 'journal-integrity');
  });
  await t.test('file corrupted or absent', async (s) => {
    const { path, journal } = await setup(s);
    journal.close();
    await writeFile(path, Buffer.alloc(8192, 0x5a));
    for (const side of ['-wal', '-shm']) await unlink(path + side).catch(() => {});
    throws(() => openDurableWalletJournal({ path, mode: 'open' }), 'journal-integrity');
    await unlink(path);
    throws(() => openDurableWalletJournal({ path, mode: 'open' }), 'journal-absent');
  });
});

test('capacity and non-JSON values fail closed without writing', async (t) => {
  const { journal } = await created(t, { maxRecords: 2, maxValueBytes: 1024 });
  await journal.put('a', { n: 1 });
  await rejects(journal.put('big', { blob: 'x'.repeat(2048) }), 'journal-capacity');
  for (const bad of [{ n: 1n }, { u: undefined }, { d: new Date(0) }, { x: Number.NaN }, { z: -0 }, [1, , 3]]) await rejects(journal.put('bad', bad), 'journal-invalid');
  await journal.put('b', { n: 2 });
  await rejects(journal.put('c', { n: 3 }), 'journal-capacity');
  await journal.put('a', { n: 4 });
  assert.deepEqual(await journal.entries(), [['a', { n: 4 }], ['b', { n: 2 }]]);
  await rejects(journal.get(''), 'journal-invalid');
});

test('in-process lock semantics: distinct nesting, reentrant refusal, fenced foreign writes, bounded busy, release after settle', async (t) => {
  const { journal } = await created(t, { lockTimeoutMs: 150 });
  assert.equal(await journal.withWalletLock('plugin/agreement/op-1', () => journal.withWalletLock('sr2/wallet/lane', async () => { await journal.put('sr2/wallet/lane', { stage: 'broadcast-started' }); return 'nested'; })), 'nested');
  await rejects(journal.withWalletLock('lane', () => journal.withWalletLock('lane', async () => {})), 'journal-reentrant');
  let release;
  const holding = journal.withWalletLock('lane', () => new Promise((r) => { release = r; }));
  await new Promise((r) => setImmediate(r));
  await rejects(journal.put('lane', { stage: 'other' }), 'journal-fenced');
  const started = Date.now();
  await rejects(journal.withWalletLock('lane', async () => {}), 'journal-busy');
  const waited = Date.now() - started;
  assert.ok(waited >= 140 && waited < 1500, `bounded busy wait ${waited}ms`);
  assert.equal(await journal.withWalletLock('other-lane', async () => 'isolated'), 'isolated');
  release();
  await holding;
  await rejects(journal.withWalletLock('lane', async () => { throw Object.assign(new Error('work failed'), { code: 'work-failed' }); }), 'work-failed');
  assert.deepEqual(journal.inspectLocks(), [], 'locks released after both clean and failed completion');
  assert.equal(await journal.withWalletLock('lane', async () => 'again'), 'again');
});

test('independent processes: shared lane serializes increments; non-target wallet lane stays available', async (t) => {
  const { path, journal } = await created(t);
  const [a, b] = await Promise.all([spawn(t, path), spawn(t, path)]);
  assert.notEqual(a.ready.pid, b.ready.pid);
  const outcomes = await Promise.all([a.call('increment', { key: 'lane-1', counterKey: 'counter', times: 25 }), b.call('increment', { key: 'lane-1', counterKey: 'counter', times: 25 })]);
  assert.deepEqual(outcomes.map((o) => o.ok), [true, true], JSON.stringify(outcomes));
  assert.equal((await journal.get('counter')).count, 50, 'no lost update across processes');
  const holder = await spawn(t, path, 200);
  const holding = holder.call('hold', { key: 'wallet-A' });
  await holder.next((m) => m.event === 'locked');
  const busy = await b.call('tryLock', { key: 'wallet-A' });
  assert.equal(busy.result.acquired, false);
  assert.equal(busy.result.code, 'journal-busy');
  const other = await b.call('tryLock', { key: 'wallet-B' });
  assert.equal(other.result.acquired, true, 'non-target wallet lane is not blocked');
  await rejects(journal.put('wallet-A', { stage: 'intruder' }), 'journal-fenced');
  await holder.call('release', { key: 'wallet-A' });
  assert.equal((await holding).ok, true);
  assert.equal((await b.call('tryLock', { key: 'wallet-A' })).result.acquired, true, 'released after known clean completion');
});

test('crash after record: dead holder never ages out; retained intent keeps fencing after explicit lock removal', async (t) => {
  const { path, journal } = await created(t, { lockTimeoutMs: 300 });
  const lane = JSON.stringify(['fixture-net', FIXTURE_IDENTITY, '0x' + '22'.repeat(32)]);
  const crash = await spawn(t, path);
  const answered = crash.call('crashAfterRecord', { key: lane, record: signedIntent(lane) }).then(() => 'answered', () => 'no answer');
  await crash.next((m) => m.event === 'recorded');
  assert.equal((await crash.exited).signal, 'SIGKILL');
  assert.equal(await answered, 'no answer', 'the holder died inside its lock work');
  assert.equal(exact(await journal.get(lane)), exact(signedIntent(lane)));
  const [lock] = journal.inspectLocks();
  assert.equal(lock.key, lane);
  assert.equal(lock.pid, crash.ready.pid);
  await new Promise((r) => setTimeout(r, 400));
  await rejects(journal.withWalletLock(lane, async () => {}), 'journal-busy');
  await rejects(journal.put(lane, { ...signedIntent(lane), stage: 'broadcast-accepted' }), 'journal-fenced');
  throws(() => journal.releaseAbandonedLock({ key: lane, instance: lock.instance, fence: lock.fence + 1 }), 'journal-lock-mismatch');
  assert.deepEqual(journal.releaseAbandonedLock({ key: lane, instance: lock.instance, fence: lock.fence }), { released: true, recordsChanged: 0 });
  assert.equal((await journal.get(lane)).stage, 'broadcast-started', 'lock removal never rewrites the unknown stage');
});

// Actual consumer: the unchanged wallet session with the durable journal.
async function wallet(t, journal, fixture = {}) {
  const chain = await startAnchorFixture(fixture);
  const h = await startHarness({ chain, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  t.after(() => h.close());
  const network = h.config.chain.network;
  const transport = { profile: 'simulated-loopback', network, rpcUrl: `${h.origin}/portal/api/wallet-rpc` };
  const approvals = [];
  const session = shipped.createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic, anchorJournal: journal, transactionTransport: transport, approve: async (r) => { approvals.push(r); return true; } });
  const account = await session.create();
  t.after(() => session.lock());
  const lane = JSON.stringify([network, shipped.DACS_STORAGE_ANCHOR_CHAIN_IDENTITY, account.address]);
  return { chain, h, network, transport, approvals, session, account, lane, send: (r, s = session) => s.request({ method: 'sendTransaction', params: [r] }), request: (args) => anchorRequest(account.address, network, args) };
}

test('wallet consumer: accepted anchor persists exactly, lane releases after clean completion, next nonce proceeds', async (t) => {
  const { path, journal } = await created(t);
  const w = await wallet(t, journal);
  const first = await w.send(w.request());
  assert.equal(first.success, true, JSON.stringify(first));
  const retained = await journal.get(w.lane);
  assert.equal(retained.stage, 'broadcast-accepted');
  assert.equal(retained.hash, first.data.hash);
  const reopened = openDurableWalletJournal({ path, mode: 'open', expectedJournalId: journal.journalId });
  t.after(() => reopened.close());
  assert.equal(exact(await reopened.get(w.lane)), exact(retained));
  assert.deepEqual(journal.inspectLocks(), []);
  const second = await w.send(w.request({ nonce: 2, logicalAddress: 'dacs3:agreement:second' }));
  assert.equal(second.success, true, JSON.stringify(second));
  assert.equal(w.chain.record.broadcastAttempts.length, 2);
});

test('wallet consumer: unknown outcome holds across journal reopen and a restored session; no prompt, no resend', async (t) => {
  const { path, journal } = await created(t);
  const w = await wallet(t, journal);
  w.chain.faults.dropAfterApply = true;
  const r = w.request();
  const out = await w.send(r);
  assert.equal(out.error?.code, 'outcome_unknown', JSON.stringify(out));
  assert.equal((await journal.get(w.lane)).stage, 'broadcast-started');
  const mnemonic = w.session.exportMnemonicForUser();
  w.session.lock();
  journal.close();
  const reopened = openDurableWalletJournal({ path, mode: 'open' });
  t.after(() => reopened.close());
  const restored = shipped.createSdkWalletSession({ DemosCtor: Demos, validateMnemonic, transactionTransport: w.transport, anchorJournal: reopened, approve: async () => { throw new Error('must not prompt'); } });
  await restored.importMnemonic(mnemonic);
  t.after(() => restored.lock());
  for (const request of [r, w.request({ nonce: 2, logicalAddress: 'dacs3:agreement:another' })]) assert.equal((await w.send(request, restored)).error?.code, 'outcome_unknown');
  assert.equal(w.approvals.length, 1);
  assert.equal(w.chain.record.broadcastAttempts.length, 1);
});

test('wallet consumer: another process crashed after recording on this lane; wallet never prompts or broadcasts', async (t) => {
  const { path, journal } = await created(t, { lockTimeoutMs: 200 });
  const w = await wallet(t, journal);
  const crash = await spawn(t, path);
  const answered = crash.call('crashAfterRecord', { key: w.lane, record: signedIntent(w.lane) }).then(() => 'answered', () => 'no answer');
  await crash.next((m) => m.event === 'recorded');
  assert.equal((await crash.exited).signal, 'SIGKILL');
  assert.equal(await answered, 'no answer');
  const blocked = await w.send(w.request());
  assert.equal(blocked.success, false, JSON.stringify(blocked));
  t.diagnostic(`dead-holder wallet outcome: ${blocked.error?.code}`);
  assert.equal(w.approvals.length, 0, 'busy lane is refused before approval');
  const [lock] = journal.inspectLocks();
  journal.releaseAbandonedLock({ key: w.lane, instance: lock.instance, fence: lock.fence });
  const fenced = await w.send(w.request());
  assert.equal(fenced.error?.code, 'outcome_unknown', JSON.stringify(fenced));
  assert.equal(w.approvals.length, 0);
  assert.equal(w.chain.record.broadcastAttempts.length, 0);
});

// Actual bridge.anchor -> packaged wallet -> relay -> native readback flow.
async function sr2(t, journal) {
  const chain = await observedFixture();
  const h = await startHarness({ chain, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  t.after(() => h.close());
  const network = h.config.chain.network;
  const approvals = [];
  const factory = ({ anchorJournal }) => shipped.createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic, anchorJournal,
    transactionTransport: { profile: 'simulated-loopback', network, rpcUrl: `${h.origin}/portal/api/wallet-rpc` }, approve: async (r) => { approvals.push(r); return true; } });
  let tick = 1791144000000;
  const bridge = createDemosSr2WalletBridge({ rpcUrl: chain.url, network, journal, walletFactory: factory, now: () => tick++ });
  const account = await bridge.wallet.create();
  t.after(() => bridge.wallet.lock());
  const input = { logicalAddress: 'dacs3:agreement:offline-sr2-job', writer: `did:demos:agent:${account.address.slice(2)}`,
    artifact: { artifactType: 'Agreement', jobId: 'offline-sr2-job', signatures: [{ opaque: 'scope-carrier' }], terms: { amount: '2.5', currency: 'DEM' } } };
  return { chain, network, approvals, bridge, account, input, laneKey: `sr2/wallet/${JSON.stringify([network, FIXTURE_IDENTITY, account.address])}` };
}

test('bridge consumer: accepted anchor reaches simulated readback; durable lane and adapter records reopen exactly', async (t) => {
  const { path, journal } = await created(t);
  const w = await sr2(t, journal);
  const out = await w.bridge.anchor(w.input);
  assert.equal(out.status, 'simulated-read-visible', JSON.stringify(out));
  assert.equal((await journal.get(w.laneKey)).stage, 'broadcast-accepted');
  const reopened = openDurableWalletJournal({ path, mode: 'open', expectedJournalId: journal.journalId });
  t.after(() => reopened.close());
  assert.equal(exact(await reopened.entries()), exact(await journal.entries()));
  assert.ok((await reopened.entries()).some(([k, v]) => k.startsWith('sr2/adapter/') && v.stage === 'verified'));
  assert.deepEqual(journal.inspectLocks(), []);
  assert.equal(w.approvals.length, 1);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
});

test('bridge consumer: unknown apply outcome survives a separately opened durable journal; replay only observes', async (t) => {
  const { path, journal } = await created(t);
  const w = await sr2(t, journal);
  w.chain.wire.faults.dropAfterApply = true;
  const first = await w.bridge.anchor(w.input);
  assert.equal(first.status, 'indeterminate');
  assert.equal(first.code, 'outcome_unknown');
  assert.equal((await journal.get(w.laneKey)).stage, 'broadcast-started');
  w.chain.faults.unavailable = true;
  const second = openDurableWalletJournal({ path, mode: 'open', expectedJournalId: journal.journalId });
  t.after(() => second.close());
  const reopened = createDemosSr2WalletBridge({ rpcUrl: w.chain.url, network: w.network, journal: second, walletFactory: () => w.bridge.wallet });
  assert.equal((await reopened.resume(w.input)).status, 'indeterminate');
  assert.equal((await reopened.anchor(w.input)).status, 'indeterminate');
  const blocked = await w.bridge.wallet.request({ method: 'sendTransaction', params: [{ to: w.account.address, amount: '1' }] });
  assert.equal(blocked.error.code, 'outcome_unknown', 'shared durable lane also fences other wallet writes');
  w.chain.faults.unavailable = false;
  assert.equal((await reopened.resume(w.input)).status, 'simulated-read-visible');
  assert.equal((await journal.get(w.laneKey)).stage, 'broadcast-accepted', 'first instance observes the second instance commit');
  assert.equal(w.approvals.length, 1);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
});

// Actual opt-in harness browserAgreement broker (HTTP/MCP + broker journal
// routes) with protocol-purchases' plugin/agreement lock nesting the bridge
// lane lock and the broker record lock, all on the durable journal.
const runtime = { Demos, Identities, validateMnemonic };
const laneStages = async (j) => (await j.entries()).filter(([k]) => k.startsWith('sr2/wallet/')).map(([, v]) => v.stage);

test('broker consumer: authenticated HTTP/MCP CREATE through nested protocol locks; durable records reopen; no replay', async (t) => {
  const { path, journal } = await created(t);
  const w = await durableBrokerSetup(t, { journal, runtime });
  await w.authenticate();
  const queued = await w.submit();
  assert.equal(queued.evidence?.protocol?.stage, 'agreement-signing', JSON.stringify(queued));
  assert.equal((await journal.get(`browser-agreement/create/${w.id}`)).stage, 'queued');
  assert.deepEqual(journal.inspectLocks(), [], 'plugin/agreement, lane and record locks all released after nested completion');
  const done = await w.client.approveOne(w.wallet);
  assert.equal(done.state, 'completed', JSON.stringify(w.calls.filter((c) => c.error)));
  assert.equal((await Promise.all([w.verify(), w.verify()])).every((o) => o.protocol.stage === 'agreement-anchored'), true, 'concurrent same-key plugin/agreement callers serialize');
  assert.deepEqual(await laneStages(journal), ['broadcast-accepted']);
  assert.equal((await journal.get(`browser-agreement/create/${w.id}`)).stage, 'completed');
  const reopened = openDurableWalletJournal({ path, mode: 'open', expectedJournalId: journal.journalId });
  t.after(() => reopened.close());
  assert.equal(exact(await reopened.entries()), exact(await journal.entries()));
  await assert.rejects(w.client.approveOne(w.wallet), /completed.*no replay/);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  assert.equal(w.approvals.filter(storage).length, 1);
  assert.deepEqual(journal.inspectLocks(), []);
});

test('broker consumer: explicit denial is a known rejection; no wallet lane record or broadcast', async (t) => {
  const { journal } = await created(t);
  const w = await durableBrokerSetup(t, { journal, runtime, allow: false });
  await w.authenticate(); await w.submit();
  assert.equal((await w.client.approveOne(w.wallet)).state, 'denied');
  assert.equal((await w.verify()).protocol.stage, 'agreement-rejected');
  assert.deepEqual(await laneStages(journal), []);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
});

test('broker consumer: unknown applied CREATE stays fenced in a reopened journal; readback only, never a second claim/broadcast', async (t) => {
  const { path, journal } = await created(t);
  const w = await durableBrokerSetup(t, { journal, runtime });
  await w.authenticate(); await w.submit();
  w.chain.wire.faults.dropAfterApply = true;
  assert.equal((await w.client.approveOne(w.wallet)).state, 'uncertain');
  const reopened = openDurableWalletJournal({ path, mode: 'open', expectedJournalId: journal.journalId });
  t.after(() => reopened.close());
  assert.deepEqual(await laneStages(reopened), ['broadcast-started']);
  assert.equal((await reopened.get(`browser-agreement/create/${w.id}`)).stage, 'uncertain');
  w.chain.faults.unavailable = true;
  assert.equal((await w.verify()).protocol.lastAttempt.outcome, 'indeterminate');
  w.chain.faults.unavailable = false; w.chain.wire.faults.dropAfterApply = false;
  assert.equal((await w.verify()).protocol.stage, 'agreement-anchored');
  assert.deepEqual(await laneStages(reopened), ['broadcast-accepted'], 'the second instance observes the broker commit');
  await assert.rejects(w.client.approveOne(w.wallet), /uncertain.*no replay/);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
});

test('protocol consumer: another process holding plugin/agreement/<id> gives a bounded refusal with no fence; release lets the same entry point proceed', async (t) => {
  const { path, journal } = await created(t);
  const w = await durableBrokerSetup(t, { journal, runtime });
  await w.authenticate();
  const holder = await spawn(t, path);
  const holding = holder.call('hold', { key: `plugin/agreement/${w.id}` });
  await holder.next((m) => m.event === 'locked');
  const started = Date.now();
  const refused = await w.submit();
  const waited = Date.now() - started;
  t.diagnostic(`held plugin/agreement submit: ${JSON.stringify(refused.error ?? refused.evidence?.protocol?.stage)} after ${waited}ms`);
  assert.notEqual(refused.evidence?.protocol?.stage, 'agreement-signing', JSON.stringify(refused));
  assert.ok(waited >= 1900 && waited < 6000, `bounded wait ${waited}ms`);
  assert.equal(w.walletAnchor(), undefined, 'busy refusal created no wallet anchor fence');
  assert.equal(await journal.get(`browser-agreement/create/${w.id}`), undefined);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
  await holder.call('release', { key: `plugin/agreement/${w.id}` });
  assert.equal((await holding).ok, true);
  assert.equal((await w.submit()).evidence?.protocol?.stage, 'agreement-signing');
  assert.equal((await w.client.approveOne(w.wallet)).state, 'completed');
  assert.equal((await w.verify()).protocol.stage, 'agreement-anchored');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
});

// The role instructions name the known Chrome; launchTestChrome never falls back.
process.env.DACS_TEST_CHROME ??= '/usr/bin/chromium-browser';
test('browser consumer: real portal + Chrome trusted approval anchors one CREATE via the durable broker journal; synthetic click cannot', { timeout: 120000 }, async (t) => {
  const { path, journal } = await created(t);
  const w = await durableBrowserSetup(t, journal);
  const { dialog, shown } = await durableReachCreate(w);
  const accept = dialog.getByRole('button', { name: UI.approve });
  await accept.evaluate((b) => b.click());
  assert.equal(await dialog.isVisible(), true);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0, 'guard witness: synthetic approval must not sign/broadcast');
  await accept.click();
  await w.page.locator('#flow').getByText(/Awaiting authenticated seller commitment and context/).waitFor({ timeout: 25000 });
  const verified = await w.verify();
  assert.equal(verified.protocol.stage, 'agreement-anchored', JSON.stringify(verified));
  assert.equal(verified.protocol.agreement.hash, shown.contentHash);
  assert.equal(verified.protocol.limits.payment, 'held');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  const reopened = openDurableWalletJournal({ path, mode: 'open', expectedJournalId: journal.journalId });
  t.after(() => reopened.close());
  assert.deepEqual(await laneStages(reopened), ['broadcast-accepted']);
  assert.equal((await reopened.get(`browser-agreement/create/${w.p.operationId}`)).stage, 'completed');
  assert.deepEqual(journal.inspectLocks(), []);
  assertNoSecrets(w.requests, [w.password], 'browser HTTP requests');
  assert.ok(w.requests.every((r) => new URL(r.url).origin === w.h.origin));
  assert.deepEqual(w.consoleErrors, []);
});

test('bridge consumer: unchanged SR-2 bridge accepts the journal; wallet lane is prefixed and acceptance stays readback-pending', async (t) => {
  const { path, journal } = await created(t);
  let anchorJournal;
  const address = '0x' + '33'.repeat(32);
  const bridge = createDemosSr2WalletBridge({ rpcUrl: 'http://127.0.0.1:9/', network: 'fixture-net', journal, walletFactory: (o) => { anchorJournal = o.anchorJournal; return {
    request: async () => { throw new Error('not exercised'); }, getPublicAccount: () => ({ address }), getWriteProfile: () => ({ profile: 'simulated-loopback', network: 'fixture-net', transactionKinds: [SR2_WALLET_KIND] }) }; } });
  assert.equal(bridge.evidenceMode, 'simulated-fixture');
  const lane = JSON.stringify(['fixture-net', FIXTURE_IDENTITY, address]);
  await anchorJournal.withWalletLock(lane, async () => {
    await anchorJournal.put(lane, signedIntent(lane));
    await anchorJournal.put(lane, { ...signedIntent(lane), stage: 'broadcast-accepted' });
  });
  const reopened = openDurableWalletJournal({ path, mode: 'open' });
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.entries()).map(([k, v]) => [k, v.stage]), [[`sr2/wallet/${lane}`, 'sr2-readback-pending']]);
  assert.equal(exact(await anchorJournal.get(lane)), exact({ ...signedIntent(lane), stage: 'sr2-readback-pending' }));
  await assert.rejects(anchorJournal.withWalletLock(lane, () => anchorJournal.withWalletLock(lane, async () => {})), (e) => e.code === 'journal-reentrant');
});
