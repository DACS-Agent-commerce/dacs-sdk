// The node-facing authority reader: the read-only connection pair createNodeAuthorityReader builds over the production port's owner,
// and the staged seller reader openSellerStages wraps around them, which reads the host's enrollment for each job through
// readParticipantEvidence. The node is the client's scripted TP-1 node; the enrollment source and the retained job rows are the test's.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { TESTNET_PROFILE_TP1, TP1_APPROVED_IDENTITY_RECORD, assertTp1Authority, assertTp1Binding, bindTp1Profile } from '@kynesyslabs/dacs/wire';
import { jsonResponse, keyRecordBytes, ok, privateDataDirectory, replayNode, spyTransactionSignatures } from './helpers/seller-node-wallet-world.mjs';

const { createSellerWalletSession, LISTING_PIN, portOptions } = await import('./helpers/seller-wallet-session-world.mjs');
const { enrolled, enrollment } = await import('./helpers/kit-wallet-session.mjs');
const { buyer, testWallet } = await import('./helpers/protocol-fixture.mjs');
const { createNodeAuthorityReader } = await import('../src/devnet-demo/seller-wallet-session.mjs');
const { openDoctorNode } = await import('../src/devnet-demo/doctor-node.mjs');
const { createSellerAuthorityReader } = await import('../src/dacs/authority-reader.mjs');
const { openSellerStages } = await import('../src/dacs/host-stages.mjs');
const { isBoundedCallTimeout } = await import('../src/dacs/bounded-call.mjs');

const MISMATCH = 'tp1_participant_profile_mismatch';
const DEADLINE_MS = 10_000;
const REPLY_CAP = 4 * 1024 * 1024;
const JOB_A = '01M5YKPJG0248H248H248H248A', JOB_B = '01M5YKPJG0248H248H248H248B';
const BLOCK_READ = { method: 'nodeCall', params: [{ message: 'getBlockByNumber', data: { blockNumber: 0 } }] };
const flush = async () => { for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve)); };
const codesOf = (error) => { const codes = []; for (let link = error; link instanceof Error; link = link.cause) codes.push(link.code); return codes; };
const refusalOf = (promise) => promise.then(() => assert.fail('expected a refusal'), (error) => error);
const blockReads = (respond) => (row) => (row.body?.params[0].message === 'getBlockByNumber' ? respond(row) : undefined);

// The production port over `node` and the host's real stages over it, with `source` as the host's enrollment and `retained` as the
// job rows. `grant(jobId, buyerClaim, patch)` retains an admitted row for this seller and Listing; `jobRead(jobId, buyerClaim)` is
// the wire's check of a job scope, which calls the staged reader. The stages close after the test.
async function stagedPort(t, { node = replayNode(), source = enrollment(), directory = privateDataDirectory(t) } = {}) {
  const retained = new Map();
  const world = { node, source, keyLoads: 0, directory };
  const options = await portOptions(node, async () => { world.keyLoads += 1; return keyRecordBytes(); });
  world.seller = options.signer.claim;
  world.port = createSellerWalletSession(options);
  world.stages = await openSellerStages({ walletSession: world.port, participantImplementations: source, sellerClaim: world.seller, listingPin: LISTING_PIN,
    retainedJob: (jobId) => retained.get(jobId) ?? null, maxConcurrent: 1 });
  t.after(() => world.stages.close());
  world.grant = (jobId, buyerClaim = buyer.claim, patch = {}) => retained.set(jobId, { state: 'admitted', buyer: buyerClaim, seller: world.seller, listingPin: LISTING_PIN, ...patch });
  world.jobRead = (jobId, buyerClaim = buyer.claim) => assertTp1Authority(world.stages.binding, world.stages.local(), [buyerClaim, world.seller], jobId);
  // The staged reader's own build, over the same port and inputs, for direct calls of its evidence method.
  world.reader = () => createSellerAuthorityReader({ connectionAuthority: world.port.connectionAuthority, identityRecord: TP1_APPROVED_IDENTITY_RECORD, claim: world.seller,
    listingPin: LISTING_PIN, bootstrap: { current: () => null }, retainedJob: (jobId) => retained.get(jobId) ?? null, participantImplementations: source });
  return world;
}

// An enrollment source that records the options of each read and, while `gate` is set, waits for it before answering.
function recordingEnrollment(claims) {
  const source = enrollment(claims), answer = source.entriesFor;
  source.seen = [];
  source.entriesFor = async (claim, options) => {
    source.seen.push({ claim, options, abortedAtRead: options?.signal?.aborted });
    await source.gate;
    return answer(claim);
  };
  return source;
}

// Holds the client's read clocks still so only mocked setTimeout timers move time; restored after the test.
function mockedDeadlines(t) {
  const frozenNow = performance.now();
  const heldClock = t.mock.method(performance, 'now', () => frozenNow);
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => { mock.timers.reset(); heldClock.mock.restore(); });
}

test('createNodeAuthorityReader returns exactly the frozen five members, accepts exactly owner, claim, chain, participantImplementations and sessionOf, and refuses any other input', async (t) => {
  const node = replayNode();
  const owner = (await import('@kynesyslabs/dacs-client/node-wallet')).createNodeTransportOwner({ endpoint: 'https://rpc.example.invalid/', transportAuthority: 'vector-authority', fetchImpl: node.fetch });
  t.after(() => owner.close());
  const inputs = { owner, claim: () => 'TEST-claim', chain: () => assert.fail('building reads no chain'), participantImplementations: { entriesFor: () => assert.fail('building reads no enrollment') },
    sessionOf: () => assert.fail('building reads no session') };
  for (const given of [{ owner, claim: inputs.claim }, inputs]) {
    const pair = createNodeAuthorityReader(given);
    assert.deepEqual(Object.keys(pair).sort(), ['authority', 'connectionAuthority', 'observePayment', 'readCommitmentReceipt', 'sessionAdmission']);
    assert.ok(Object.isFrozen(pair) && typeof pair.connectionAuthority === 'function' && typeof pair.authority.authorityRpc === 'function');
  }
  for (const extra of [{ trustedFinality: {} }, { clock: { now: () => 0 } }]) {
    assert.throws(() => createNodeAuthorityReader({ ...inputs, ...extra }), (error) => error instanceof TypeError && error.message.includes(Object.keys(extra)[0]));
  }
  const pair = createNodeAuthorityReader({ owner, claim: () => 'TEST-claim' });
  const decision = await pair.connectionAuthority({ local: owner.currentLocal(), sessionId: JOB_A, participants: [buyer.claim, 'TEST-other'] });
  assert.deepEqual(decision.participants, [], 'the pair answers the connection scope only');

  const world = await stagedPort(t);
  world.grant(JOB_A);
  assert.equal(world.stages.binding.profile.chainIdentity, TP1_APPROVED_IDENTITY_RECORD.chainIdentity, 'the composition is admitted');
  await world.jobRead(JOB_A);
  assert.equal(world.source.reads, 1, 'a job scope reads the host enrollment through the staged seller reader');
  assert.deepEqual({ keyLoads: world.keyLoads, files: readdirSync(world.directory) }, { keyLoads: 0, files: [] });
});

test('an authority reply declared over 4 MiB or streamed past 4 MiB makes authorityRpc refuse authority_reply_too_large before JSON decode, with the original byte-cap error as cause; doctor readAuthority and the port connection reader refuse NetworkBindingError(unavailable) with authority_reply_too_large as cause and the byte-cap OutboundError below it; malformed JSON remains invalid, and a decoded list over 1,024 entries refuses authority_list_too_large directly at authorityRpc and through the same reader cause layer', async (t) => {
  const headers = { 'content-type': 'application/json' };
  const replies = {
    declared: () => new Response('{}', { headers: { ...headers, 'content-length': String(REPLY_CAP + 1) } }),
    streamed: () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024).fill(32)); } }), { headers }),
  };
  for (const [name, reply] of Object.entries(replies)) {
    const node = replayNode();
    node.reply = blockReads(reply);
    const port = createSellerWalletSession(await portOptions(node, async () => keyRecordBytes()));
    const doctor = openDoctorNode({ rpcUrl: 'https://rpc.example.invalid/', sellerClaim: 'TEST-claim', fetchImpl: node.fetch });
    t.after(async () => { doctor.close(); await port.close(); });
    const direct = await refusalOf(port.authority.authorityRpc(BLOCK_READ));
    assert.deepEqual(codesOf(direct), ['authority_reply_too_large', 'response_byte_limit'], name);
    for (const [reader, local] of [[port.connectionAuthority, port.authority.context()], [doctor.readAuthority, doctor.owner.currentLocal()]]) {
      const error = await refusalOf(reader({ local, sessionId: null, participants: [] }));
      assert.deepEqual([error.name, ...codesOf(error)], ['NetworkBindingError', 'unavailable', 'authority_reply_too_large', 'response_byte_limit'], name);
    }
  }
  const malformed = replayNode();
  malformed.reply = blockReads(() => new Response('{"result":', { headers }));
  const port = createSellerWalletSession(await portOptions(malformed, async () => keyRecordBytes()));
  t.after(() => port.close());
  const invalid = await refusalOf(port.authority.authorityRpc(BLOCK_READ));
  assert.equal(invalid.kind, 'invalid');
  assert.ok(!codesOf(invalid).includes('authority_reply_too_large'), 'malformed JSON is not an oversized reply');

  const listed = replayNode();
  listed.reply = blockReads(() => jsonResponse(ok({ number: 0, status: 'confirmed', hash: 'a'.repeat(64), content: { entries: Array(1025).fill(0) } })));
  const listedPort = createSellerWalletSession(await portOptions(listed, async () => keyRecordBytes()));
  t.after(() => listedPort.close());
  assert.deepEqual(codesOf(await refusalOf(listedPort.authority.authorityRpc(BLOCK_READ))), ['authority_list_too_large']);
  const throughReader = await refusalOf(listedPort.connectionAuthority({ local: listedPort.authority.context(), sessionId: null, participants: [] }));
  assert.deepEqual(codesOf(throughReader), ['unavailable', 'authority_list_too_large']);
});

test('a stalled read is refused at 10,000 ms monotonic and a late answer authorizes nothing', async (t) => {
  const world = await stagedPort(t);
  let release;
  world.node.reply = blockReads(() => new Promise((resolve) => { release = resolve; }));
  mockedDeadlines(t);
  let outcome = 'pending';
  const calls = world.node.calls.length;
  const checking = assertTp1Binding(world.stages.binding, world.stages.local()).then(() => { outcome = 'admitted'; }, (error) => { outcome = error; });
  for (let turn = 0; world.node.calls.length === calls && turn < 1000; turn++) await flush();
  mock.timers.tick(DEADLINE_MS - 1);
  await flush();
  assert.equal(outcome, 'pending', 'still waiting at 9,999 ms');
  mock.timers.tick(1);
  await checking;
  assert.deepEqual({ code: outcome.code, deadline: isBoundedCallTimeout(outcome.cause) }, { code: 'tp1_authority_timeout', deadline: true });
  release(undefined);
  await flush();
  assert.equal(outcome.code, 'tp1_authority_timeout', 'the late answer changed nothing');
});

test('a complete EB pass with the production reader under a non-reentrant queued owner finishes with zero reader fence acquisitions and no signature in the reader', async (t) => {
  const signatures = await spyTransactionSignatures(t.mock);
  const node = replayNode();
  const { createNodeTransportOwner } = await import('@kynesyslabs/dacs-client/node-wallet');
  const inner = createNodeTransportOwner({ endpoint: 'https://rpc.example.invalid/', transportAuthority: 'vector-authority', fetchImpl: node.fetch });
  const owner = { ...inner, acquisitions: 0, acquireConnectionFence: (...args) => { owner.acquisitions += 1; return inner.acquireConnectionFence(...args); } };
  t.after(() => inner.close());
  const seller = testWallet(17).claim, source = enrollment();
  const { connectionAuthority } = createNodeAuthorityReader({ owner, claim: () => seller });
  const reader = createSellerAuthorityReader({ connectionAuthority, identityRecord: TP1_APPROVED_IDENTITY_RECORD, claim: seller, listingPin: LISTING_PIN,
    bootstrap: { current: () => null }, retainedJob: () => ({ state: 'running', buyer: buyer.claim, seller, listingPin: LISTING_PIN }), participantImplementations: source });
  const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: inner.currentLocal(), readAuthority: reader });
  // The pass holds the owner's one fence for its whole run; a second acquisition would queue behind it and never be granted.
  const lease = await owner.acquireConnectionFence();
  try {
    await assertTp1Authority(binding, inner.currentLocal(), [buyer.claim, seller], JOB_A);
    await assertTp1Binding(binding, inner.currentLocal());
  } finally { lease.release(); }
  assert.deepEqual({ acquisitions: owner.acquisitions, signatures: signatures.length, enrollmentReads: source.reads }, { acquisitions: 1, signatures: 0, enrollmentReads: 1 });
});

test('another chain identity from the node is tp1_connection_unverified', async (t) => {
  const node = replayNode();
  node.reply = blockReads((row) => jsonResponse(ok({ number: row.body.params[0].data.blockNumber, status: 'confirmed', hash: 'd'.repeat(64), content: { previousHash: 'd'.repeat(64) } })));
  await assert.rejects(stagedPort(t, { node }), { code: 'tp1_connection_unverified' });
});

test('the staged seller reader admits a known participant with current host enrollment for the bound profile and tuple in its job', async (t) => {
  const world = await stagedPort(t);
  world.grant(JOB_A);
  await world.jobRead(JOB_A);
  assert.equal(world.source.reads, 1);
});

test('on the plain production `openSellerStages` job path, `createSellerAuthorityReader` exposes frozen `readParticipantEvidence({ claim, sessionId, signal })`; the staged wire read calls that method with the signed job\'s buyer, exact session ID and a live AbortSignal, and the host `entriesFor` sees that session ID and signal; removing the method or calling around it fails the test', async (t) => {
  const world = await stagedPort(t, { source: recordingEnrollment() });
  const reader = world.reader();
  assert.ok(Object.isFrozen(reader) && Object.isFrozen(reader.readParticipantEvidence) && typeof reader.readParticipantEvidence === 'function');
  world.grant(JOB_A);
  await world.jobRead(JOB_A);
  const [read] = world.source.seen;
  assert.equal(world.source.seen.length, 1);
  assert.deepEqual({ claim: read.claim, sessionId: read.options?.sessionId, signal: read.options?.signal instanceof AbortSignal, abortedAtRead: read.abortedAtRead },
    { claim: buyer.claim, sessionId: JOB_A, signal: true, abortedAtRead: false });
  assert.equal(read.options.signal.aborted, true, 'the stage aborts the signal once the read ends');
});

test('a direct evidence read for an unrelated buyer or job, a changed Listing pin, a revoked or ambiguous enrollment returns null without an admission; an aborted signal cancels before `entriesFor`, a source error propagates, and a stalled production job read aborts its signal at the 10,000 ms deadline with `tp1_authority_timeout`; a late answer authorizes nothing', async (t) => {
  const source = recordingEnrollment();
  const world = await stagedPort(t, { source });
  const { readParticipantEvidence } = world.reader();
  world.grant(JOB_A);
  world.grant(JOB_B, buyer.claim, { listingPin: { ...LISTING_PIN, version: 2 } });
  const unread = [[testWallet(41).claim, JOB_A], [buyer.claim, '01M5YKPJG0248H248H248H248C'], [buyer.claim, 'not-a-job'], [buyer.claim, JOB_B]];
  for (const [claim, sessionId] of unread) assert.equal(await readParticipantEvidence({ claim, sessionId }), null, `${claim} ${sessionId}`);
  assert.equal(source.seen.length, 0, 'an unrelated read reads no enrollment');
  const entry = enrolled(buyer.claim);
  for (const entries of [[{ ...entry, revoked: true }], [entry, { ...entry }], []]) {
    source.entries.set(buyer.claim, entries);
    assert.equal(await readParticipantEvidence({ claim: buyer.claim, sessionId: JOB_A }), null, JSON.stringify(entries));
  }
  source.entries.set(buyer.claim, [entry]);
  assert.deepEqual(await readParticipantEvidence({ claim: buyer.claim, sessionId: JOB_A }), { claim: buyer.claim, profile: entry.profile, modules: entry.modules });
  const reads = source.seen.length;
  const stopped = new AbortController();
  stopped.abort(new Error('TEST-stopped'));
  await assert.rejects(readParticipantEvidence({ claim: buyer.claim, sessionId: JOB_A, signal: stopped.signal }), /TEST-stopped/);
  assert.equal(source.seen.length, reads, 'an aborted read does not reach entriesFor');
  const sourceError = new Error('TEST-enrollment-unavailable');
  source.entriesFor = async () => { throw sourceError; };
  await assert.rejects(readParticipantEvidence({ claim: buyer.claim, sessionId: JOB_A }), (error) => error === sourceError);

  let late;
  source.entriesFor = (claim, options) => { source.seen.push({ claim, options }); return new Promise((resolve) => { late = () => resolve([entry]); }); };
  mockedDeadlines(t);
  let outcome = 'pending';
  const reading = world.jobRead(JOB_A).then(() => { outcome = 'admitted'; }, (error) => { outcome = error; });
  await flush();
  const { signal } = source.seen.at(-1).options;
  mock.timers.tick(DEADLINE_MS - 1);
  await flush();
  assert.deepEqual({ outcome, aborted: signal.aborted }, { outcome: 'pending', aborted: false });
  mock.timers.tick(1);
  await reading;
  assert.deepEqual({ code: outcome.code, aborted: signal.aborted }, { code: 'tp1_authority_timeout', aborted: true });
  late();
  await flush();
  assert.equal(outcome.code, 'tp1_authority_timeout', 'the late answer admitted nothing');
});

test('the staged seller reader refuses an unknown participant claim with tp1_participant_profile_mismatch; no decision is made up from scope.participants', async (t) => {
  const world = await stagedPort(t);
  const stranger = testWallet(42).claim;
  world.grant(JOB_A, stranger);
  await assert.rejects(world.jobRead(JOB_A, stranger), { code: MISMATCH });
  await assert.rejects(world.jobRead(JOB_B), { code: MISMATCH }, 'a job no scope relates answers no participants');
});

test('the staged seller reader re-reads entriesFor and refuses a participant revoked between calls on the second call', async (t) => {
  const world = await stagedPort(t);
  world.grant(JOB_A);
  await world.jobRead(JOB_A);
  world.source.entries.set(buyer.claim, [enrolled(buyer.claim, { revoked: true })]);
  await assert.rejects(world.jobRead(JOB_A), { code: MISMATCH });
  assert.equal(world.source.reads, 2);
});

test('the staged seller reader refuses host enrollment naming another profile or tuple with tp1_participant_profile_mismatch', async (t) => {
  const world = await stagedPort(t);
  world.grant(JOB_A);
  const entry = enrolled(buyer.claim);
  for (const changed of [{ profile: { ...entry.profile, pinVersion: 'TEST-other-pin' } }, { profile: { ...entry.profile, revision: 'TEST-other' } },
    { modules: { ...TESTNET_PROFILE_TP1.tuple, [Object.keys(TESTNET_PROFILE_TP1.tuple)[0]]: '9.9' } }]) {
    world.source.entries.set(buyer.claim, [enrolled(buyer.claim, changed)]);
    await assert.rejects(world.jobRead(JOB_A), { code: MISMATCH }, JSON.stringify(changed));
  }
});

test('an unavailable or stalled host entriesFor read refuses with its original error inside the staged reader\'s aggregate deadline', async (t) => {
  const world = await stagedPort(t);
  world.grant(JOB_A);
  const unavailable = new Error('TEST-enrollment-unavailable');
  world.source.entriesFor = () => Promise.reject(unavailable);
  await assert.rejects(world.jobRead(JOB_A), (error) => error === unavailable);
  world.source.entriesFor = () => new Promise(() => {});
  mockedDeadlines(t);
  let outcome = 'pending';
  const reading = world.jobRead(JOB_A).then(() => { outcome = 'admitted'; }, (error) => { outcome = error; });
  await flush();
  mock.timers.tick(DEADLINE_MS);
  await reading;
  assert.equal(outcome.code, 'tp1_authority_timeout');
});

test('replace connection during participant read and rebootstrap after restart', async (t) => {
  const source = recordingEnrollment();
  const first = await stagedPort(t, { source });
  first.grant(JOB_A);
  const firstConnection = first.stages.local().connectionId;
  let open;
  source.gate = new Promise((resolve) => { open = resolve; });
  const reading = refusalOf(first.jobRead(JOB_A));
  await flush();
  assert.equal(source.seen.length, 1, 'the participant read started');
  await first.stages.close();
  open();
  assert.equal((await reading).code, 'transport_closed', 'the connection closed during the participant read voids the decision');

  source.gate = undefined;
  const restarted = await stagedPort(t, { source });
  restarted.grant(JOB_A);
  assert.notEqual(restarted.stages.local().connectionId, firstConnection);
  await assert.rejects(assertTp1Authority(first.stages.binding, restarted.stages.local(), [buyer.claim, restarted.seller], JOB_A), { code: 'tp1_local_binding_changed' });
  await restarted.jobRead(JOB_A);
  assert.equal(source.seen.length, 2, 'the restarted binding read the enrollment again');
  assert.equal(restarted.keyLoads, 0, 'no custody opened before the new binding');
});
