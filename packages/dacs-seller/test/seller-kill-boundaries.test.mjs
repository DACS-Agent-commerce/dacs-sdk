// The KILL file at every seller boundary: the composed host's routes, the challenge ledger, the effect boundary, the wallet's
// signature-to-broadcast span and a read-time CREATE recovery. Each stop is a real `<dataDirectory>/KILL` entry read by the kit's
// check; a step is reached with the barrier hooks the effect-boundary tests use (a parked read, a node read, a signer callback).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseSync from 'better-sqlite3';
import { canonicalize, generateCanonicalJobId, identityBundleHash, sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_DISCOVERY_PATH, DACS_SELLER_HTTP_HEADER } from '@kynesyslabs/dacs/wire';
// First of the local modules: it installs the purchase-admission double, so every source module below is imported after it.
import { agreementRequest } from '../../dacs-client/test/helpers/tp1-node-fixture.mjs';

const { commitmentFixture } = await import('./helpers/commitment-fixture.mjs');
const { ORCHESTRATOR_MODE } = await import('./helpers/proposal-admission-fixture.mjs');
const { NOW, buyer, seller } = await import('./helpers/protocol-fixture.mjs');
const { enrollment, scriptedNode, testWalletSession } = await import('./helpers/kit-wallet-session.mjs');
const { FIXTURE_ENDPOINT, wireBuyer } = await import('./helpers/wire-buyer.mjs');
const { LISTING_AUTHORITY, proxyListener } = await import('./helpers/listener-host.mjs');
const { integrityRoleOf, readOnlyRoleOf } = await import('./helpers/agent-signing.mjs');
const { hostBuyer } = await import('./helpers/host-context-client.mjs');
const { SIGNED_BYTES, ebWorld, flush, gate } = await import('./helpers/effect-boundary-fixture.mjs');
const { anchorFixture, passThroughRunCreate, signSdkCreate } = await import('./helpers/anchor-isolated-fixture.mjs');
const { spyTransactionSignatures } = await import('./helpers/seller-node-wallet-world.mjs');
const { anchorOptions, importSpiedWalletSession } = await import('./helpers/artifact-anchor-spy.mjs');
const { challengeWorld, watchSql } = await import('./helpers/challenge-route-fixture.mjs');
const { contextWireWorld } = await import('./helpers/context-wire-world.mjs');
const { walletSessionWorld } = await import('./helpers/seller-wallet-session-world.mjs');
const { createStopCheck, killState } = await import('../src/kill-switch.mjs');
const { startSellerHost } = await import('../src/host.mjs');
const { createSellerChallengeLedger } = await import('../src/dacs/seller-challenge-ledger.mjs');
const { WRITE_FEE_CEILING_OS } = await import('../src/dacs/effect-boundary.mjs');
const { SELLER_PROFILE } = await import('../src/dacs/session-admission.mjs');
const { createSellerCreatePass } = await import('../src/devnet-demo/create-pass.mjs');
const { requestStop } = await import('../src/devnet-demo/stop-request.mjs');

const PROPOSALS = '/dacs/v1/agreements/proposals';
const STATE = '/dacs/v1/agreements/state';
const BUYER = { claim: buyer.claim, sign: buyer.signBytes };
const SELLER = { claim: seller.claim, sign: seller.signBytes };
const RUNNING_AS_ROOT = process.getuid?.() === 0;
const digest = (label) => createHash('sha256').update(String(label)).digest('hex');
const jobFor = (label) => generateCanonicalJobId({ timestamp: NOW, entropy: createHash('sha256').update(String(label)).digest().subarray(0, 10) });
const settled = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

// A private data directory with the KILL controls over it.
function killDirectory(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-kill-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const kill = join(directory, 'KILL');
  return { directory, isStopped: createStopCheck(directory), createKill: () => writeFileSync(kill, ''), removeKill: () => rmSync(kill, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------- the composed host

// The seller key's three roles, each counted on its own: effect signatures, read-only answers and integrity records.
function countedRoles(counts) {
  const role = (name) => ({ claim: seller.claim, sign: (bytes) => { counts[name] += 1; return seller.signBytes(bytes); } });
  const roles = role('effect');
  roles.integritySigner = integrityRoleOf(role('integrity'));
  roles.readOnlyAnswerSigner = readOnlyRoleOf(role('readOnly'));
  return roles;
}

// A started host over the commitment fixture. `node.intercept` sees each authority read the host makes through its wallet session.
async function killHost(t) {
  const f = await commitmentFixture(t, { vetMode: ORCHESTRATOR_MODE, publicEndpoint: FIXTURE_ENDPOINT });
  const dataDirectory = realpathSync(await mkdtemp(join(tmpdir(), 'TEST-kill-host-')));
  // The host builds its own ledger and directory, fixes its Vet mode and has no early commit.
  const { nativeArtifactAnchor, ...config } = f.config;
  for (const name of ['challengeLedger', 'durableDirectory', 'commitOnSignature', 'vetMode']) delete config[name];
  const counts = { effect: 0, integrity: 0, readOnly: 0 };
  const node = scriptedNode();
  const hosts = [];
  const options = { ...config, signer: countedRoles(counts), artifactAnchor: nativeArtifactAnchor, dataDirectory, walletSession: testWalletSession({ node }).walletSession,
    participantImplementations: enrollment(), listener: proxyListener(), now: () => NOW };
  t.after(async () => { for (const host of hosts) await host.close().catch(() => {}); await rm(dataDirectory, { recursive: true, force: true }); });
  const kill = join(dataDirectory, 'KILL');
  const storeRead = (sql, ...args) => {
    const db = new DatabaseSync(join(dataDirectory, 'transport', 'transport.sqlite'), { readonly: true });
    try { return db.prepare(sql).all(...args); } finally { db.close(); }
  };
  return { f, counts, node, dataDirectory, storeRead,
    start: async () => { const host = await startSellerHost(options); hosts.push(host); return host; },
    createKill: () => writeFileSync(kill, ''),
    removeKill: () => rmSync(kill, { recursive: true, force: true }),
    reservation: (jobId, route = PROPOSALS) => storeRead('SELECT state FROM kit_reservations WHERE jobId = ? AND route = ?', jobId, route)[0] ?? null,
    challenges: (jobId) => storeRead('SELECT state FROM kit_challenges WHERE jobId = ?', jobId),
    effects: () => counts.effect };
}

const post = (host, path, { method = 'POST', headers = {}, text } = {}) => new Promise((resolve, reject) => {
  const sent = httpRequest(`${host.url}${path}`, { method, headers: { host: LISTING_AUTHORITY, ...headers } }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, header: res.headers[DACS_SELLER_HTTP_HEADER], bytes: Buffer.concat(chunks) }));
  });
  sent.on('error', reject);
  sent.end(text);
});
const postSigned = async (host, signed) => ({ ...await post(host, signed.payload.path, { headers: { 'content-type': 'application/json', [DACS_SELLER_HTTP_HEADER]: signed.header }, text: signed.text }), payload: signed.payload });

// A job whose context is admitted over the host's wire; `propose()` signs a fresh proposal request, `state()` a state read.
async function admittedJob(w, host, label) {
  const jobId = jobFor(label);
  const body = await w.f.proposal(host, jobId);
  const { agreementHash } = body.transportIdentity;
  const buyerWire = await wireBuyer({ buyer: BUYER, seller: SELLER, listingPin: host.listingPin, clock: () => NOW });
  const verify = (answer) => buyerWire.authentication(() => null).verifyResponse(answer.payload, { header: answer.header, status: answer.status, responseBytes: answer.bytes });
  return { jobId, verify,
    propose: () => buyerWire.signRequest(PROPOSALS, body, { jobId, agreementHash }),
    state: (stateJob = jobId) => buyerWire.signRequest(STATE, { transportIdentity: { jobId: stateJob, buyer: buyer.claim, seller: seller.claim, agreementHash } }, { jobId: stateJob, agreementHash }),
    // The read of the job's whole Agreement identity: once the proposal is answered, it carries the seller's co-signature.
    cosignedState: () => buyerWire.signRequest(STATE, { transportIdentity: body.transportIdentity }, { jobId, agreementHash }) };
}
const refusalOf = (answer) => JSON.parse(answer.bytes).error;

test('KILL before approval: zero signatures and transmissions, and the route answers a signed seller_stopped 503', async (t) => {
  const w = await killHost(t), host = await w.start();
  const job = await admittedJob(w, host, 'before-approval');
  w.createKill();
  const effects = w.effects(), readOnly = w.counts.readOnly;
  const answer = await postSigned(host, await job.propose());
  assert.deepEqual([answer.status, refusalOf(answer)], [503, 'seller_stopped']);
  await job.verify(answer);
  assert.equal(w.counts.readOnly, readOnly + 1, 'the refusal is signed by the read-only role');
  assert.equal(w.effects(), effects, 'no effect signature');
  assert.equal(w.reservation(job.jobId), null, 'nothing was reserved');
  assert.deepEqual(w.node.calls.filter((message) => message !== 'getBlockByNumber'), [], 'nothing was sent to the node');
});

test('KILL after approval and before signing: zero signatures', async (t) => {
  const w = await killHost(t), host = await w.start();
  const job = await admittedJob(w, host, 'after-approval');
  const effects = w.effects();
  // The first authority read once the route has reserved the request: the effect pass's own read, before its signature.
  w.node.intercept = () => { if (w.reservation(job.jobId) !== null) { w.node.intercept = null; w.createKill(); } return null; };
  const answer = await postSigned(host, await job.propose());
  assert.equal(answer.status, 503, answer.bytes.toString());
  assert.notEqual(w.reservation(job.jobId), null, 'the route admitted the request before KILL appeared');
  assert.equal(w.effects(), effects, 'the pass made no effect signature after KILL appeared');
});

test('KILL after signing and before broadcast: signed-held, zero transmissions', async (t) => {
  const world = await walletSessionWorld(t);
  const kill = join(world.directory, 'KILL');
  const isStopped = createStopCheck(world.directory);
  const signatures = await spyTransactionSignatures(t.mock, () => writeFileSync(kill, ''));
  const { effectBoundary, session } = await world.finalize(isStopped);
  const { runCreate } = createSellerCreatePass({ effectBoundary, session, stopped: isStopped, feeCeilingOs: WRITE_FEE_CEILING_OS.toString(), clock: world.options.clock });
  const wallet = session.walletFactory({ anchorJournal: session.artifactJournal });
  const request = await agreementRequest({ session: { wallet }, node: world.node });
  const sends = () => world.node.reads.filter((read) => read === 'confirmTx' || read === 'broadcastTx');
  const op = { operationId: 'demo/artifact/TEST-kill-after-signing', lane: 'seller-wallet', operationClass: 'job-create', currentAuthorization: () => true };
  const outcome = await settled(runCreate(op, () => wallet.request(request)));
  assert.ok(outcome.error !== undefined || outcome.value?.success === false, 'the CREATE was not sent');
  assert.equal(signatures.length, 1, 'the CREATE was signed once');
  assert.deepEqual(sends(), [], 'nothing was confirmed or broadcast');
  // The signed CREATE stays held: removing KILL resends nothing on its own.
  rmSync(kill);
  await flush();
  assert.deepEqual(sends(), [], 'removing KILL resends nothing');
  assert.equal(signatures.length, 1, 'and signs nothing again');

  // The effect boundary's own signature (the Listing, Vet and identity signatures and the payment-evidence CREATE): KILL created as the
  // signer returns leaves the signed record and a signed-held record with the stop as its cause, and sends nothing.
  const e = await ebWorld(t), stop = killDirectory(t);
  e.control.stopHook = () => stop.isStopped();
  const first = e.build();
  const signThenKill = () => { const bytes = e.sign()(); stop.createKill(); return bytes; };
  await assert.rejects(first.boundary.pass(e.op(), signThenKill, e.send()), { code: 'seller_stopped' });
  assert.deepEqual([e.counts.signer, e.counts.transport], [1, 0], 'signed once, nothing sent');
  const held = await first.history.read('lane-1');
  assert.deepEqual(held.map((record) => record.state), ['signed', 'signed-held'], 'the signature was recorded, then held');
  assert.equal(held[1].cause.code, 'seller_stopped', 'it was held for the stop');
  assert.equal(held[1].artifactHash, held[0].artifactHash, 'the held record names the signed bytes');
  assert.deepEqual(Buffer.from(held[0].bytes, 'base64'), Buffer.from(SIGNED_BYTES), 'the signed bytes are kept for readback');
  // The later readback, after a restart with KILL still present: the same two records, a retry refused, nothing signed or sent.
  const restarted = e.build();
  assert.deepEqual(await restarted.history.read('lane-1'), held, 'the readback finds the held record unchanged');
  await assert.rejects(restarted.boundary.pass(e.op(), e.sign(), e.send()), { code: 'seller_stopped' });
  assert.deepEqual([e.counts.signer, e.counts.transport], [1, 0], 'a retry under KILL signs and sends nothing');
  // Once KILL is removed the explicit retry uses the kept bytes and signs nothing new.
  stop.removeKill();
  await restarted.boundary.pass(e.op(), e.sign(), e.send());
  assert.equal(e.counts.signer, 1, 'the retry signed nothing new');
  assert.deepEqual(e.sent, [Uint8Array.from(SIGNED_BYTES)], 'the kept bytes were sent once');
});

// A retained CREATE the source reports pending, so its one read-time resend is open (as devnet-storage-write-recovery.test.mjs builds it).
const JOB = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
async function pendingCreate(t, stopped) {
  const counts = { recoveries: 0, runCreates: 0 }, resends = [];
  const w = await anchorFixture({ signRpc: async () => 'rpc-auth' });
  w.controls.stopped = stopped;
  w.source.binding = async () => ({ disposition: 'pending' });
  w.source.recoverStorageWrite = async ({ signedTransaction }) => { counts.recoveries++; resends.push(structuredClone(signedTransaction)); return {}; };
  w.controls.request = async (request) => {
    const signedTransaction = await signSdkCreate(request.transaction);
    await w.sourceJournal.put(`source/${request.jobId}`, { stage: 'signed', hash: signedTransaction.hash, signedTransaction });
    return { success: false, error: { code: 'internal_error' } };
  };
  await w.publish(w.open(), JOB);
  const [key, row] = [...w.journal.rows].find(([name]) => name.startsWith('demo/artifact/'));
  const signed = await w.sourceJournal.get(`source/${JOB}`);
  await w.journal.put(key, { ...await w.journal.get(key), stage: 'issued', hash: signed.hash });
  w.controls.runCreate = (op, work) => { counts.runCreates++; return passThroughRunCreate(op, work); };
  const recoveryRow = () => w.journal.rows.get(`demo/recovery/${signed.hash}`) ?? null;
  const read = (authorizeResend = async () => true) => w.open().readRetained({ logicalAddress: row.input.logicalAddress, artifactKind: row.input.artifactKind }, { resend: true, authorizeResend });
  return { w, counts, resends, recoveryRow, read };
}

test('KILL during recovery: readback only', async (t) => {
  // A restarted host with KILL present answers signed readback and refuses effects.
  const w = await killHost(t);
  const first = await w.start();
  const job = await admittedJob(w, first, 'recovery');
  assert.equal((await postSigned(first, await job.propose())).status, 200);
  await first.close();
  w.createKill();
  const restarted = await w.start();
  const effects = w.effects();
  const state = await postSigned(restarted, await job.state());
  assert.equal(state.status, 200, state.bytes.toString());
  await job.verify(state);
  assert.equal(refusalOf(await postSigned(restarted, await job.propose())), 'seller_stopped');
  assert.equal(w.effects(), effects, 'the restarted host made no effect signature');

  // A read of a retained CREATE whose resend conditions hold makes no send and records no recovery intent while KILL is present.
  const stop = killDirectory(t);
  const p = await pendingCreate(t, stop.isStopped);
  stop.createKill();
  let asked = 0;
  const out = await p.read(async () => { asked++; return true; });
  assert.equal(typeof out.status, 'string', 'the read answers its readback');
  assert.deepEqual([asked, p.counts.runCreates, p.counts.recoveries, p.recoveryRow()], [0, 0, 0, null]);
  stop.removeKill();
  await p.read();
  assert.equal(p.resends.length, 1, 'with KILL removed the read resends once');
});

test('the wallet session gives its composed anchor the host\'s stop check: a retained CREATE eligible for resend is read back with no resend asked, no intent written and nothing sent while KILL is present, and resends once without it', async (t) => {
  const { createSellerWalletSession: spiedPort } = await importSpiedWalletSession();
  const world = await walletSessionWorld(t, { createPort: spiedPort });
  const composed = anchorOptions.length;
  await world.finalize(createStopCheck(world.directory));
  const p = await pendingCreate(t, anchorOptions[composed].stopped);
  const kill = join(world.directory, 'KILL');
  writeFileSync(kill, '');
  let asked = 0;
  const out = await p.read(async () => { asked++; return true; });
  assert.equal(typeof out.status, 'string', 'the read answers its readback');
  assert.deepEqual([asked, p.counts.runCreates, p.counts.recoveries, p.recoveryRow()], [0, 0, 0, null], 'nothing was asked, recorded or sent');
  rmSync(kill);
  await p.read();
  assert.equal(p.resends.length, 1, 'with KILL removed the read resends once');
});

test('a restart with KILL present leaves every unfinished context row, hold, slot and reservation as it was and closes only the lost validation, with no effect signature and no wallet request; the same restart without KILL ends a running row', async (t) => {
  const tables = ['kit_context_admissions', 'kit_job_holds', 'kit_slot_retirements', 'kit_reservations'];
  const snapshot = (w) => JSON.stringify(tables.map((name) => w.storeRead(`SELECT * FROM ${name} ORDER BY 1`)));
  const stateOf = (w, jobId) => w.storeRead('SELECT state FROM kit_context_admissions WHERE jobId = ?', jobId)[0]?.state;
  const executes = (w) => w.node.calls.filter((message) => message === 'confirmTx' || message === 'broadcastTx').length;
  for (const withKill of [true, false]) {
    const w = await killHost(t), first = await w.start();
    const job = await admittedJob(w, first, `restart-sweep-${withKill}`);
    // A challenge attempt the earlier process committed and never closed.
    const attemptedJob = jobFor(`restart-attempt-${withKill}`);
    assert.equal((await (await hostBuyer(first, w.f.listing, {})).challenge(attemptedJob)).status, 200);
    await first.close();
    // The earlier process stopped with the job's context step running.
    const db = new DatabaseSync(join(w.dataDirectory, 'transport', 'transport.sqlite'));
    try {
      db.prepare("UPDATE kit_context_admissions SET state = 'running', record = json_remove(json_set(record, '$.state', 'running'), '$.contextOutcome') WHERE jobId = ?").run(job.jobId);
      db.prepare("UPDATE kit_challenges SET state = 'attempted', owner = ?, presentationHash = ?, attemptedAt = ? WHERE jobId = ?").run(JSON.stringify({ generation: 'TEST-earlier-process' }), digest('attempt'), NOW, attemptedJob);
    } finally { db.close(); }
    if (withKill) w.createKill();
    const [effects, before, executed] = [w.effects(), snapshot(w), executes(w)];
    await w.start();
    if (withKill) {
      assert.equal(stateOf(w, job.jobId), 'running', 'the stopped startup sweep left the running row');
      assert.equal(snapshot(w), before, 'and every row, hold, slot and reservation as it was');
    } else assert.notEqual(stateOf(w, job.jobId), 'running', 'the unstopped startup sweep ended the leftover row');
    const lost = w.storeRead("SELECT state, json_extract(failure, '$.code') AS code FROM kit_challenges WHERE jobId = ?", attemptedJob);
    assert.deepEqual(lost, [{ state: 'failed', code: 'validator_lost' }], 'the lost validation closes in both runs: that write grants no effect');
    assert.equal(w.effects(), effects, 'the restart made no effect signature');
    assert.equal(executes(w), executed, 'and no wallet request');
  }
});

test('KILL with a committed job in drain blocks its effects; the same drain without KILL continues it', async (t) => {
  for (const withKill of [true, false]) {
    const w = await killHost(t), host = await w.start();
    const job = await admittedJob(w, host, `drain-${withKill}`);
    const effects = w.effects();
    let closing = null;
    w.node.intercept = () => {
      if (w.reservation(job.jobId) === null) return null;
      w.node.intercept = null;
      closing = host.close();
      if (withKill) w.createKill();
      return null;
    };
    const answer = await postSigned(host, await job.propose());
    await closing;
    if (withKill) {
      assert.equal(answer.status, 503, answer.bytes.toString());
      assert.equal(w.effects(), effects, 'KILL blocked the drained job\'s effect signature');
    } else {
      assert.equal(answer.status, 200, answer.bytes.toString());
      assert.ok(w.effects() > effects, 'the drain ran the job to its outcome');
    }
  }
  // A request already served but not yet reserved when close() starts answers a signed seller_stopped 503 and reserves nothing.
  const w = await killHost(t), host = await w.start();
  const job = await admittedJob(w, host, 'served-before-close');
  const parked = gate();
  w.node.intercept = async () => { w.node.intercept = null; await parked.arrive(); return null; };
  const answering = postSigned(host, await job.propose());
  await parked.reached;
  const closing = host.close();
  parked.release();
  const answer = await answering;
  await closing;
  assert.deepEqual([answer.status, refusalOf(answer)], [503, 'seller_stopped']);
  await job.verify(answer);
  assert.equal(w.reservation(job.jobId), null);
});

// ---------------------------------------------------------------- the challenge ledger

const PIN = { listingId: 'listing', version: 1, contentHash: digest('listing') };
const PROFILE = { standardRevision: SELLER_PROFILE.standardRevision, documentVersions: SELLER_PROFILE.documentVersions };
const LEDGER_BUYER = `did:demos:agent:${digest('TEST ledger buyer')}`;
const LEDGER_SELLER = `did:demos:agent:${digest('TEST ledger seller')}`;
const SCOPE = digest('TEST scope');
const LIVE = { assertStillLive() {} };

// The ledger over one SQLite file; `open(generation)` is a process (a second generation is a restart).
function ledgerWorld(t, stopped) {
  const directory = mkdtempSync(join(tmpdir(), 'TEST-kill-ledger-'));
  const db = new DatabaseSync(join(directory, 'ledger.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const transaction = (run) => { db.exec('BEGIN IMMEDIATE'); try { const result = run(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const open = (generation = 'TEST-generation-1') => createSellerChallengeLedger({ db, transaction, now: () => NOW, generation, sessionState: () => null,
    admissionCounts: () => ({ contextRecords: 0, starts: 0, buyerStarts: () => 0 }), ready: () => true, stopped });
  const bundleOf = (nonce) => ({ presentedBy: LEDGER_BUYER, sessionNonce: nonce, presentation: { kind: 'fixture' } });
  const inputOf = (jobId, nonce) => ({ nonce, jobId, buyer: LEDGER_BUYER, challengeScopeHash: SCOPE, presentationHash: sha256Hex(canonicalize(bundleOf(nonce))), path: 'context' });
  const recordOf = (ledger, jobId, nonce) => {
    const bundle = bundleOf(nonce), bundleHash = identityBundleHash(bundle);
    return { buyerBundleText: canonicalize(bundle), buyerBundleHash: bundleHash, admittedAt: NOW,
      admission: { disposition: 'admitted', jobId, buyer: LEDGER_BUYER, buyerBundleHash: bundleHash, listingPin: PIN,
        participants: [{ role: 'buyer', claim: LEDGER_BUYER, ...PROFILE }, { role: 'seller', claim: LEDGER_SELLER, ...PROFILE }] },
      firstAdmission: { challengeExpiresAt: ledger.retained(nonce).expiresAt, generatedAt: NOW, checkedAt: NOW } };
  };
  const rows = () => db.prepare('SELECT jobId, state, failure, presentationHash FROM kit_challenges ORDER BY jobId').all();
  const bindings = () => db.prepare('SELECT jobId FROM kit_job_bindings').all().map((row) => row.jobId);
  return { open, inputOf, recordOf, rows, bindings };
}

test('KILL refuses challenge issuance and attempts before any ledger write', async (t) => {
  const stop = killDirectory(t);
  const l = ledgerWorld(t, stop.isStopped), ledger = l.open();
  stop.createKill();
  assert.throws(() => ledger.issue({ jobId: jobFor('issue'), buyer: LEDGER_BUYER }, SCOPE, LIVE), { code: 'seller_stopped', status: 503 });
  assert.deepEqual(l.rows(), [], 'a stopped issuance writes no row');
  stop.removeKill();
  const { sessionNonce: open } = ledger.issue({ jobId: jobFor('attempt'), buyer: LEDGER_BUYER }, SCOPE, LIVE);
  const { sessionNonce: replayed } = ledger.issue({ jobId: jobFor('replay'), buyer: LEDGER_BUYER }, SCOPE, LIVE);
  assert.equal(ledger.attempt(l.inputOf(jobFor('replay'), replayed)).kind, 'validate');
  const before = l.rows();
  stop.createKill();
  assert.deepEqual(ledger.attempt(l.inputOf(jobFor('attempt'), open)), { kind: 'refused', code: 'seller_stopped', status: 503 });
  const replay = ledger.attempt(l.inputOf(jobFor('replay'), replayed));
  assert.notEqual(replay.code, 'seller_stopped', 'an attempted row still answers its stored state');
  assert.deepEqual(l.rows(), before, 'a stopped attempt writes nothing');

  // Through the composed host: KILL created after the challenge route's early stop check is refused by the ledger's own check.
  const w = await killHost(t), host = await w.start();
  const client = await hostBuyer(host, w.f.listing, {});
  const reads = [], control = jobFor('host-control');
  w.node.intercept = () => { reads.push(w.challenges(control).length > 0); return null; };
  assert.equal((await client.challenge(control)).status, 200);
  const lastReadBeforeRow = reads.lastIndexOf(false) + 1;
  const cut = jobFor('host-cut');
  let count = 0;
  w.node.intercept = () => { if (++count === lastReadBeforeRow) w.createKill(); return null; };
  const answer = await client.challenge(cut);
  assert.equal(answer.status, 503, answer.text);
  assert.equal(JSON.parse(answer.text).error, 'seller_stopped');
  assert.deepEqual(w.challenges(cut), [], 'the stopped issuance wrote no challenge');
});

test('KILL created after the early stop check and before the ledger transaction: issuance and the first attempt commit nothing and answer seller_stopped', (t) => {
  const stop = killDirectory(t);
  // The ledger's stop check, which creates KILL just before it reads when armed: the step between the route's check and the ledger's.
  let armed = false;
  const ledgerStop = () => { if (armed) { armed = false; stop.createKill(); } return stop.isStopped(); };
  const l = ledgerWorld(t, ledgerStop), ledger = l.open();
  assert.equal(stop.isStopped(), false, 'the route\'s early check is open');
  armed = true;
  assert.throws(() => ledger.issue({ jobId: jobFor('cut-issue'), buyer: LEDGER_BUYER }, SCOPE, LIVE), { code: 'seller_stopped', status: 503 });
  assert.deepEqual(l.rows(), []);
  stop.removeKill();
  const { sessionNonce } = ledger.issue({ jobId: jobFor('cut-attempt'), buyer: LEDGER_BUYER }, SCOPE, LIVE);
  const issued = l.rows();
  assert.equal(stop.isStopped(), false, 'the route\'s early check is open');
  armed = true;
  assert.deepEqual(ledger.attempt(l.inputOf(jobFor('cut-attempt'), sessionNonce)), { kind: 'refused', code: 'seller_stopped', status: 503 });
  assert.deepEqual(l.rows(), issued, 'the row is still issued, with no presentation recorded');
  stop.removeKill();
  assert.equal(ledger.attempt(l.inputOf(jobFor('cut-attempt'), sessionNonce)).kind, 'validate', 'the unused challenge can still be attempted');
});

// The stop check that answers open the first time it is read and creates KILL right after: the route's own early check, then the ledger's.
function openOnceThenKill(stop) {
  const hook = { reads: 0, check: null };
  hook.check = () => { const answer = stop.isStopped(); hook.reads++; if (hook.reads === 1) stop.createKill(); return answer; };
  return hook;
}

test('KILL created between the challenge route\'s early stop check and the ledger transaction: the route answers a signed seller_stopped 503 and the issuance commits nothing', async (t) => {
  const stop = killDirectory(t), w = await challengeWorld(t), hook = openOnceThenKill(stop);
  w.state.stop = hook.check;
  const signed = await w.sign(), sql = watchSql(t);
  const answer = await w.post(signed);
  assert.deepEqual([answer.status, answer.body.error], [503, 'seller_stopped']);
  await signed.verify(answer);
  assert.ok(hook.reads >= 2, 'the ledger asked again after the route\'s early check');
  assert.deepEqual([w.rows().length, sql.writes()], [0, 0], 'no ledger row and no write statement');
  stop.removeKill();
  assert.equal((await w.post(await w.sign())).status, 200, 'without KILL the same route issues the challenge');
});

test('KILL created between the context route\'s early stop check and the ledger\'s first attempt: the route answers seller_stopped 503, the challenge stays issued and nothing starts', async (t) => {
  const stop = killDirectory(t), w = await contextWireWorld(t), request = await w.startContext();
  const hook = openOnceThenKill(stop);
  w.state.stop = hook.check;
  const answer = await w.post(request);
  assert.deepEqual([answer.status, answer.body.error], [503, 'seller_stopped']);
  assert.ok(hook.reads >= 2, 'the ledger asked again after the route\'s early check');
  assert.equal(w.challengeOf(request.nonce).state, 'issued', 'the attempt committed nothing');
  assert.deepEqual([w.counts.holds.length, w.internals.admissionCounts().starts, w.counts.vetWrites, w.rowOf()], [0, 0, 0, null], 'no hold, start, Vet write or admission row');
  stop.removeKill();
  assert.equal((await w.post(request)).status, 200, 'without KILL the same request is admitted');
});

test('under KILL the named closing writes still record and none signs or sends: an attempt admitted before KILL is accepted or failed, and a restart with KILL closes lost validations while phase-head admission recovery waits for an eligible unstopped sweep or restart', (t) => {
  const stop = killDirectory(t);
  const l = ledgerWorld(t, stop.isStopped), ledger = l.open();
  const admitted = (label) => {
    const jobId = jobFor(label), { sessionNonce } = ledger.issue({ jobId, buyer: LEDGER_BUYER }, SCOPE, LIVE);
    const { owner } = ledger.attempt(l.inputOf(jobId, sessionNonce));
    return { jobId, nonce: sessionNonce, owner };
  };
  const accepted = admitted('closing-accepted'), failed = admitted('closing-failed'), lost = admitted('closing-lost');
  stop.createKill();
  assert.equal(ledger.accept(accepted.owner, accepted.nonce, l.recordOf(ledger, accepted.jobId, accepted.nonce)), true);
  assert.equal(ledger.recordFailed(failed.owner, failed.nonce, 'peer_vet_failed', 409), true);
  const stateOf = (jobId) => l.rows().find((row) => row.jobId === jobId);
  assert.equal(stateOf(accepted.jobId).state, 'accepted');
  assert.deepEqual(l.bindings(), [accepted.jobId], 'the acceptance bound its job');
  assert.deepEqual([stateOf(failed.jobId).state, JSON.parse(stateOf(failed.jobId).failure).code], ['failed', 'peer_vet_failed']);

  // A restart while KILL remains: the earlier generation's validation closes as lost; nothing new is admitted.
  const restarted = l.open('TEST-generation-2');
  assert.equal(restarted.closeLostValidations(), 1);
  assert.deepEqual([stateOf(lost.jobId).state, JSON.parse(stateOf(lost.jobId).failure).code], ['failed', 'validator_lost']);
  assert.throws(() => restarted.issue({ jobId: jobFor('closing-new'), buyer: LEDGER_BUYER }, SCOPE, LIVE), { code: 'seller_stopped' });
});

// ---------------------------------------------------------------- reads, entry types and the shutdown flag

test('under KILL, read routes, refusals and readback stay signed under the binding', async (t) => {
  const w = await killHost(t), host = await w.start();
  const job = await admittedJob(w, host, 'reads');
  assert.equal((await postSigned(host, await job.propose())).status, 200);
  w.createKill();
  const effects = w.effects();
  const state = await postSigned(host, await job.state());
  assert.equal(state.status, 200, state.bytes.toString());
  await job.verify(state);
  const unknown = await postSigned(host, await job.state(jobFor('reads-unknown')));
  assert.equal(unknown.status, 404, unknown.bytes.toString());
  await job.verify(unknown);
  const refusal = await postSigned(host, await job.propose());
  assert.deepEqual([refusal.status, refusalOf(refusal)], [503, 'seller_stopped']);
  await job.verify(refusal);
  const discovery = await post(host, DACS_SELLER_DISCOVERY_PATH, { method: 'GET' });
  assert.equal(discovery.status, 200, discovery.bytes.toString());
  assert.equal(w.effects(), effects, 'no read, readback or refusal used the effect role');
});

test('a state read that carries the Agreement co-signature answers a signed seller_stopped under KILL and sends none', async (t) => {
  const w = await killHost(t), host = await w.start();
  const job = await admittedJob(w, host, 'cosignature');
  const proposal = await postSigned(host, await job.propose());
  assert.equal(proposal.status, 200, proposal.bytes.toString());
  const carries = (answer) => typeof JSON.parse(answer.bytes)?.contribution?.signature?.value === 'string';
  const open = await postSigned(host, await job.cosignedState());
  assert.equal(open.status, 200, open.bytes.toString());
  assert.equal(carries(open), true, 'without KILL the read carries the co-signature');
  w.createKill();
  const effects = w.effects(), readOnly = w.counts.readOnly;
  const stopped = await postSigned(host, await job.cosignedState());
  assert.deepEqual([stopped.status, refusalOf(stopped)], [503, 'seller_stopped']);
  await job.verify(stopped);
  assert.equal(carries(stopped), false, 'no co-signature was transmitted');
  assert.ok(w.counts.readOnly > readOnly, 'the refusal is signed by the read-only role');
  assert.equal(w.effects(), effects, 'no effect signature');
});

test('a symlink, a directory, a broken symlink or a stat failure at KILL behaves as present at every boundary', async (t) => {
  const w = await killHost(t), host = await w.start();
  const job = await admittedJob(w, host, 'entry-types');
  const client = await hostBuyer(host, w.f.listing, {});
  const kill = join(w.dataDirectory, 'KILL');
  const entries = {
    'a symlink': () => { writeFileSync(join(w.dataDirectory, 'TEST-target'), ''); symlinkSync(join(w.dataDirectory, 'TEST-target'), kill); },
    'a directory': () => mkdirSync(kill),
    'a broken symlink': () => symlinkSync(join(w.dataDirectory, 'TEST-missing'), kill),
  };
  for (const [name, make] of Object.entries(entries)) {
    make();
    const effects = w.effects();
    const proposal = await postSigned(host, await job.propose());
    assert.deepEqual([proposal.status, refusalOf(proposal)], [503, 'seller_stopped'], `${name}: the effect route`);
    const challenge = await client.challenge(jobFor(`entry-${name}`));
    assert.deepEqual([challenge.status, JSON.parse(challenge.text).error], [503, 'seller_stopped'], `${name}: the challenge route`);
    assert.equal(w.effects(), effects, `${name}: no effect signature`);
    w.removeKill();
  }
  // A stat failure: a KILL path past the length limit and, when not root, a data directory without search permission.
  const root = mkdtempSync(join(tmpdir(), 'TEST-kill-stat-'));
  const closed = join(root, 'closed');
  // A directory without permissions cannot be removed with its parent: the mode is restored first.
  t.after(() => { try { chmodSync(closed, 0o700); } catch { /* it was not made */ } rmSync(root, { recursive: true, force: true }); });
  let long = root;
  while (4094 - long.length > 201) long = join(long, 'd'.repeat(200));
  long = join(long, 'd'.repeat(4094 - long.length - 1));
  mkdirSync(long, { recursive: true });
  const failures = [long];
  if (RUNNING_AS_ROOT) t.diagnostic('running as root: the EACCES case is replaced by the ENAMETOOLONG case');
  else { mkdirSync(closed, { mode: 0o000 }); failures.push(closed); }
  for (const directory of failures) {
    assert.equal(killState(directory).present, true);
    const e = await ebWorld(t);
    const isStopped = createStopCheck(directory);
    e.control.stopHook = () => isStopped();
    await assert.rejects(e.build().boundary.signPass(e.op(), e.sign()), { code: 'seller_stopped' });
    assert.equal(e.counts.signer, 0, 'the effect boundary signed nothing');
  }
});

test('a symlink, a directory or a broken symlink at KILL stops the read-time resend of a retained CREATE', async (t) => {
  const entries = {
    'a symlink': (directory) => { writeFileSync(join(directory, 'TEST-target'), ''); symlinkSync(join(directory, 'TEST-target'), join(directory, 'KILL')); },
    'a directory': (directory) => mkdirSync(join(directory, 'KILL')),
    'a broken symlink': (directory) => symlinkSync(join(directory, 'TEST-missing'), join(directory, 'KILL')),
  };
  for (const [name, make] of Object.entries(entries)) {
    const stop = killDirectory(t);
    const p = await pendingCreate(t, stop.isStopped);
    make(stop.directory);
    let asked = 0;
    const out = await p.read(async () => { asked++; return true; });
    assert.equal(typeof out.status, 'string', `${name}: the read answers its readback`);
    assert.deepEqual([asked, p.counts.runCreates, p.counts.recoveries, p.recoveryRow()], [0, 0, 0, null], `${name}: nothing was asked, recorded or sent`);
  }
});

test('concurrent requests while KILL appears: none signs after the check that observes it', async (t) => {
  const e = await ebWorld(t);
  const stop = killDirectory(t);
  e.control.stopHook = () => { const answer = stop.isStopped(); e.trace.push(`stop=${answer}`); return answer; };
  const { boundary } = e.build();
  // The first pass to sign creates KILL as its signature is made; the others are queued behind its fence.
  const signThenKill = () => { const bytes = e.sign()(); stop.createKill(); return bytes; };
  const passes = ['lane-1', 'lane-2', 'lane-3'].map((lane, index) => settled(boundary.signPass(e.op({ operationId: `op-${index}`, lane }), index === 0 ? signThenKill : e.sign())));
  const outcomes = await Promise.all(passes);
  assert.equal(e.counts.signer, 1, 'only the pass whose checks all ran before KILL signed');
  assert.deepEqual(outcomes.slice(1).map((outcome) => outcome.error?.code), ['seller_stopped', 'seller_stopped']);
  const firstStop = e.trace.indexOf('stop=true');
  assert.ok(firstStop > 0);
  assert.equal(e.trace.slice(firstStop).includes('sign'), false, 'no signature follows a check that saw KILL');
});

test('repeat the pause-and-resume, closure, rollback and restart controls with the actual KILL stop seam: zero effect-signer calls after the check that observes KILL, and the unchanged control signs', async (t) => {
  const e = await ebWorld(t);
  const stop = killDirectory(t);
  e.control.stopHook = () => stop.isStopped();
  const { boundary, history } = e.build();
  // Pause: a pass parked at its final authority read sees KILL created there and signs nothing.
  const parked = gate();
  e.control.readHook = async (n, scope, base) => { if (n === 2) await parked.arrive(); return base(scope); };
  const paused = settled(boundary.signPass(e.op(), e.sign()));
  await parked.reached;
  stop.createKill();
  parked.release();
  assert.equal((await paused).error?.code, 'seller_stopped');
  e.control.readHook = null;
  assert.equal(e.counts.signer, 0);
  assert.equal((await history.read('lane-1')).some((record) => record.state === 'signed'), false, 'no signature was recorded');
  // Restart while KILL remains: a new boundary over the same history refuses too.
  const restarted = e.build().boundary;
  assert.equal((await settled(restarted.signPass(e.op({ operationId: 'op-restart', lane: 'lane-2' }), e.sign()))).error?.code, 'seller_stopped');
  assert.equal(e.counts.signer, 0, 'nothing signed while KILL is present');
  // Resume is a new pass once KILL is removed; the control signs once.
  stop.removeKill();
  await restarted.signPass(e.op({ operationId: 'op-resume', lane: 'lane-3' }), e.sign());
  assert.equal(e.counts.signer, 1);
});

// The wallet session's own runCreate, finalized over `stopped`: the effect boundary and pass a composed anchor runs its resend in.
async function composedRunCreate(t, stopped) {
  const world = await walletSessionWorld(t);
  await world.finalize(stopped);
  return world.port.runCreate;
}

test('KILL during a read-time CREATE recovery: at each of three cuts the current read resolves with its readback and never rejects; before the intent nothing is recorded or sent, after the intent nothing is sent, the row is not unsent and the resend is never repeated; a non-stop failure of runCreate still rejects the read', async (t) => {
  // Cut 1: KILL appears while the caller's resend check runs; the anchor's check right after it sees KILL.
  {
    const stop = killDirectory(t);
    const p = await pendingCreate(t, stop.isStopped);
    const out = await p.read(async () => { stop.createKill(); return true; });
    assert.equal(typeof out.status, 'string');
    assert.deepEqual([p.counts.runCreates, p.counts.recoveries, p.recoveryRow()], [0, 0, null], 'cut 1: runCreate never ran');
  }
  // Cut 2: KILL appears right after the anchor's check answered open; the composed pass's own first check refuses before any work.
  {
    const stop = killDirectory(t);
    const runCreate = await composedRunCreate(t, stop.isStopped);
    let armed = false;
    const stopped = () => { const answer = stop.isStopped(); if (armed) { armed = false; stop.createKill(); } return answer; };
    const p = await pendingCreate(t, stopped);
    p.w.controls.runCreate = (op, work) => { p.counts.runCreates++; return runCreate(op, work); };
    const out = await p.read(async () => { armed = true; return true; });
    assert.equal(typeof out.status, 'string');
    assert.deepEqual([p.counts.runCreates, p.counts.recoveries, p.recoveryRow()], [1, 0, null], 'cut 2: the composed pass refused before the intent');
    stop.removeKill();
    await p.read();
    assert.equal(p.resends.length, 1, 'cut 2 used nothing: the next read resends once');
  }
  // Cut 3: KILL appears after the intent is written, as the resend asks to sign; the composed pass\'s guarded signer refuses the send.
  {
    const stop = killDirectory(t);
    const runCreate = await composedRunCreate(t, stop.isStopped);
    const p = await pendingCreate(t, stop.isStopped);
    p.w.controls.runCreate = (op, work) => { p.counts.runCreates++; return runCreate(op, work); };
    const send = p.w.source.recoverStorageWrite;
    p.w.source.recoverStorageWrite = async (input) => { stop.createKill(); await input.signRpc(); return send(input); };
    const out = await p.read();
    assert.equal(typeof out.status, 'string');
    assert.equal(p.counts.recoveries, 0, 'cut 3: nothing was sent');
    assert.equal(p.recoveryRow()?.stage, 'intent', 'the intent stays recorded');
    stop.removeKill();
    p.w.source.recoverStorageWrite = send;
    await p.read();
    assert.equal(p.resends.length, 0, 'the resend is never repeated');
  }
  // A non-stop failure of runCreate still rejects the read and records nothing.
  for (const code of ['effect_pass_invalid', 'journal_unavailable']) {
    const stop = killDirectory(t);
    const p = await pendingCreate(t, stop.isStopped);
    p.w.controls.runCreate = () => Promise.reject(Object.assign(new Error('TEST failure'), { code }));
    await assert.rejects(p.read(), { code });
    assert.equal(p.recoveryRow(), null, `${code}: the row is as it was`);
  }
});

// Last in the file: the process stop flag cannot be cleared, and this file runs in its own process.
test('the shutdown stop flag still stops the host, and KILL is checked in addition', async (t) => {
  const w = await killHost(t), host = await w.start();
  const job = await admittedJob(w, host, 'shutdown');
  w.createKill();
  assert.equal(refusalOf(await postSigned(host, await job.propose())), 'seller_stopped', 'KILL alone stops the host');
  w.removeKill();
  assert.equal((await postSigned(host, await job.propose())).status, 200, 'without KILL or a stop the host serves');
  requestStop();
  const effects = w.effects();
  const stopped = await postSigned(host, await job.propose());
  assert.deepEqual([stopped.status, refusalOf(stopped)], [503, 'seller_stopped'], 'the shutdown flag alone stops the host');
  await job.verify(stopped);
  assert.equal(w.effects(), effects);
  assert.equal(createStopCheck(w.dataDirectory)(), true, 'the stop check reads the shutdown flag with no KILL present');
});
