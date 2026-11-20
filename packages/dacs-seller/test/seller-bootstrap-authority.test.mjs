// The seller host's production authority reader, its request-local bootstrap scope and its staged composition, driven over
// loopback HTTP by a buyer that signs with the wire's functions over the client's production reader. Every actor is enrolled
// through its composition's `participantImplementations`; no admission is seeded and no fixture reader is installed in the host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { canonicalize, generateCanonicalJobId, sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_DISCOVERY_PATH, DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_PATHS, TP1_APPROVED_IDENTITY_RECORD, assertTp1Authority } from '@kynesyslabs/dacs/wire';
import { createAuthorityReader } from '../../dacs-client/src/wallet/authority-reader.mjs';
import { createNodeAuthorityCapability, createNodeTransportOwner } from '../../dacs-client/src/wallet/node-wallet-session.mjs';
import { createBootstrapScopes } from '../src/dacs/bootstrap-scope.mjs';
import { openSellerStages } from '../src/dacs/host-stages.mjs';
import { provenUnsignedAbsence } from '../src/dacs/native-dem-delivery-consumer.mjs';
import { requestStop } from '../src/devnet-demo/stop-request.mjs';
import { contextCapability, contextHostFixture, hostBuyer, presentContextAnswer } from './helpers/host-context-client.mjs';
import { TP1_PROFILE, enrolled, enrollment, purchaseRow, scriptedNode, testWalletSession } from './helpers/kit-wallet-session.mjs';
import { NOW, buyer, seller, testWallet } from './helpers/protocol-fixture.mjs';
import { FIXTURE_ENDPOINT } from './helpers/wire-buyer.mjs';

const MISMATCH = 'tp1_participant_profile_mismatch';
// A step that never comes fails its test instead of holding the run.
const TEST_TIMEOUT_MS = 300000;
const job = (tag) => generateCanonicalJobId({ timestamp: NOW, entropy: Buffer.alloc(10, tag) });
const RECORD_DIGEST = sha256Hex(canonicalize(TP1_APPROVED_IDENTITY_RECORD));
const LOCK_FILE = 'seller-state.lock';
// The wire's delegation signing bytes for the client's delegation vector: their length and SHA-256.
const PINNED_DELEGATION_LENGTH = 821;
const PINNED_DELEGATION_SHA256 = '5d43ce506fd18689880b65a345eadd9b1f0767d0103460e54e358e464bccf922';
const VECTOR_TIME = 1793102400000;

// An Ed25519 party from a one-byte seed, as the client's delegation vector makes its buyer, seller and session key.
function party(seed) {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]), format: 'der', type: 'pkcs8' });
  const raw = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  return { claim: `did:demos:agent:${raw}`, raw, signBytes: (bytes) => sign(null, bytes, key) };
}

const admissionState = (directory, jobId) => {
  const db = new Database(join(directory, 'transport', 'transport.sqlite'), { readonly: true });
  try { return db.prepare('SELECT state FROM kit_context_admissions WHERE jobId = ?').get(jobId)?.state ?? null; } finally { db.close(); }
};
const decode = (header) => JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
const encode = (envelope) => Buffer.from(canonicalize(envelope)).toString('base64url');
// The signed request with its delegation, or its own envelope signature, replaced by `forger`'s signature over the same bytes.
function forged(signed, forger) {
  const envelope = decode(signed.header);
  if (envelope.delegation) envelope.delegation.signature = forger.signBytes(Buffer.from(DACS_SELLER_HTTP_DOMAINS.delegation + canonicalize(envelope.delegation.payload))).toString('base64url');
  else envelope.signature = forger.signBytes(Buffer.from(DACS_SELLER_HTTP_DOMAINS.request + canonicalize(envelope.payload))).toString('base64url');
  return { ...signed, header: encode(envelope) };
}

// The buyer's own composition: the client's production reader over its own transport owner, with the seller's Listing registered,
// the seller enrolled, and a saved purchase row for each job the buyer starts (`purchase(jobId)`).
function clientBuyerAuthority(buyerKey) {
  const node = scriptedNode();
  const owner = createNodeTransportOwner({ endpoint: 'https://rpc.example.invalid/', transportAuthority: 'TEST-buyer-authority', fetchImpl: node.fetch });
  const authority = createNodeAuthorityCapability({ owner, claim: () => buyerKey.claim });
  const rows = new Map();
  const readAuthority = createAuthorityReader({ authority, identityRecord: TP1_APPROVED_IDENTITY_RECORD, claim: authority.claim,
    listings: { isRegistered: (claim) => claim === seller.claim }, purchases: { findByJobId: (jobId) => rows.get(jobId) ?? null },
    participantImplementations: enrollment([seller.claim]) });
  const { endpoint, transportAuthority, connectionId } = owner.currentLocal();
  return { readAuthority, connection: () => ({ endpoint, transportAuthority, connectionId }), purchase: (jobId) => rows.set(jobId, purchaseRow(jobId, buyerKey.claim, seller.claim)) };
}

// A seller host world: the kit composition with a counting signer and connection reader, the protocol buyer enrolled in
// `kitEnrollment`, and buyers that sign over the client's reader. `start(changes)` starts a host on one data directory.
async function sellerWorld(t, { capability = contextCapability(), publicEndpoint = null } = {}) {
  const f = await contextHostFixture(t, { publicEndpoint });
  const counts = { signs: 0, authority: 0 };
  const signer = { claim: seller.claim, sign: (bytes) => { counts.signs++; return seller.signBytes(bytes); } };
  const kitEnrollment = enrollment();
  const port = () => {
    const { walletSession } = testWalletSession();
    return { ...walletSession, connectionAuthority: (scope) => { counts.authority++; return walletSession.connectionAuthority(scope); } };
  };
  const start = (changes = {}) => f.start({ walletSession: port(), participantImplementations: kitEnrollment, signer, demDeliveryContext: capability, ...changes });
  const buyerFor = async (host, key = buyer) => {
    const side = clientBuyerAuthority(key);
    return { ...await hostBuyer(host, f.config.listing, { buyer: key, connection: side.connection, readAuthority: side.readAuthority }), purchase: side.purchase };
  };
  // What a refused request left: its answer, and whether the seller signed or read authority for it.
  const refusedWith = async (send) => {
    const before = { ...counts };
    const answer = await send();
    return { status: answer.status, error: answer.body.error, signed: answer.signed, signs: counts.signs - before.signs, authority: counts.authority - before.authority };
  };
  return { f, counts, kitEnrollment, start, buyerFor, refusedWith };
}
const refusal = (status, error, authorityRead = true) => ({ status, error, signed: false, signs: 0, ...(authorityRead ? {} : { authority: 0 }) });
// A refusal's record without its count of authority reads, for refusals that reach the wire's participant check.
const withoutAuthority = (result) => Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'authority'));

test('with the buyer\'s valid signature, Listing and job scope kept: its enrollment removed, revoked, duplicated, or with one profile or module member changed each refuses tp1_participant_profile_mismatch with zero effect signatures; a signed buyer declaration alone never enrolls; a failed bootstrap signature refuses peer_delegation_signature_invalid or peer_signature_invalid with zero authority calls', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const w = await sellerWorld(t);
  const host = await w.start();
  const b = await w.buyerFor(host);
  const entry = enrolled(buyer.claim);
  const variants = {
    removed: [], revoked: [{ ...entry, revoked: true }], duplicated: [entry, { ...entry }], 'without evidence': [{ ...entry, evidence: '' }],
    ...Object.fromEntries(Object.keys(TP1_PROFILE).map((member) => [`profile.${member}`, [{ ...entry, profile: { ...entry.profile, [member]: `${entry.profile[member]}-changed` } }]])),
    ...Object.fromEntries(Object.keys(entry.modules).map((member) => [`modules.${member}`, [{ ...entry, modules: { ...entry.modules, [member]: '9.9' } }]])),
  };
  let tag = 1;
  for (const [label, entries] of Object.entries(variants)) {
    const jobId = job(tag++);
    b.purchase(jobId);
    w.kitEnrollment.entries.set(buyer.claim, entries);
    const reads = w.kitEnrollment.reads;
    assert.deepEqual(withoutAuthority(await w.refusedWith(() => b.challenge(jobId))), refusal(500, MISMATCH), label);
    assert.ok(w.kitEnrollment.reads > reads, `${label}: the enrollment was read for this request`);
  }
  // A buyer that signs correctly and declares the TP-1 profile, but that no one enrolled.
  const declared = testWallet(41), d = await w.buyerFor(host, declared), declaredJob = job(60);
  d.purchase(declaredJob);
  assert.deepEqual(withoutAuthority(await w.refusedWith(() => d.challenge(declaredJob))), refusal(500, MISMATCH), 'a signed declaration does not enroll');

  // The same buyer enrolled again; only the signature changes.
  w.kitEnrollment.entries.set(buyer.claim, [entry]);
  const forger = testWallet(42), signedJob = job(61);
  b.purchase(signedJob);
  for (const [delegated, code] of [[true, 'peer_delegation_signature_invalid'], [false, 'peer_signature_invalid']]) {
    const reads = w.kitEnrollment.reads;
    const signed = await b.signChallenge(signedJob, { delegated });
    assert.deepEqual(await w.refusedWith(() => b.post(DACS_SELLER_HTTP_PATHS.contextChallenge, forged(signed, forger))), refusal(401, code, false), code);
    assert.equal(w.kitEnrollment.reads, reads, `${code}: no enrollment was read`);
  }
  const issued = await b.challenge(signedJob);
  assert.deepEqual([issued.status, issued.signed], [200, true], 'the buyer\'s own signature is still served');
});

test('a bootstrap scope ends with its request: an exception, a cancelled request and a killed process leave no scope; two overlapping requests for one job each need their own signature; a restart needs a new signature and current enrollment', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  // A context step of a job in `waiting` reports that it started (`entered`) and waits for `release`.
  const waiting = new Map();
  const failing = job(70), held = job(71);
  const hold = (jobId) => {
    const step = {};
    step.entered = new Promise((resolve) => { step.enter = resolve; });
    step.released = new Promise((resolve) => { step.release = resolve; });
    waiting.set(jobId, step);
    return step;
  };
  const capability = contextCapability({ resolveBuyer: async (input, options) => {
    if (input.scope.jobId === failing) { options.writable(); throw new Error('TEST the Vet readback failed'); }
    const step = waiting.get(input.scope.jobId);
    if (step) { step.enter(); await step.released; }
    return presentContextAnswer(input);
  } });
  const w = await sellerWorld(t, { capability });
  let host = await w.start();
  const b = await w.buyerFor(host);
  const settled = async (jobId) => {
    for (let turn = 0; turn < 1000 && admissionState(w.f.dataDirectory, jobId) !== 'settled'; turn++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(admissionState(w.f.dataDirectory, jobId), 'settled');
  };
  // More failed and more cancelled requests than the live scope bound (eight), each after its scope was entered, so a scope any of
  // them kept would fill the bound and the request after them would get none.
  // Each iteration has its own enrolled buyer: the host issues one buyer only a few challenges an hour.
  for (let n = 0; n < 9; n++) {
    const jobId = job(80 + n), key = testWallet(150 + n);
    w.kitEnrollment.entries.set(key.claim, [enrolled(key.claim)]);
    const c = await w.buyerFor(host, key);
    c.purchase(jobId);
    // An exception inside the request: its body is not the one it signed, which the wire refuses once the scope is entered.
    const signed = await c.signChallenge(jobId);
    const answer = await c.post(DACS_SELLER_HTTP_PATHS.contextChallenge, { ...signed, text: `${signed.text} ` });
    assert.equal(answer.status >= 400, true, answer.text);
    // A context request its client abandons while the host runs its context step.
    const step = hold(jobId), controller = new AbortController();
    const issued = await c.challenge(jobId);
    assert.equal(issued.status, 200, issued.text);
    const abandoned = c.context(jobId, issued.body.sessionNonce, { signal: controller.signal }).catch((error) => error.name);
    await step.entered;
    controller.abort();
    assert.equal(await abandoned, 'AbortError');
    step.release();
    await settled(jobId);
  }
  b.purchase(failing);
  const failed = await b.requestContext(failing);
  assert.equal(failed.status >= 500, true, failed.text);
  // Two overlapping requests for one job: while the first is inside its context step, the second is authenticated on its own.
  // The first is served, so the requests before it left the scope bound free. The seller issues at most twelve challenges an hour.
  b.purchase(held);
  const step = hold(held);
  const issued = await b.challenge(held);
  const first = b.context(held, issued.body.sessionNonce);
  await step.entered;
  const forger = testWallet(43);
  for (const delegated of [true, false]) {
    const signed = await b.signChallenge(held, { delegated });
    assert.deepEqual(await w.refusedWith(() => b.post(DACS_SELLER_HTTP_PATHS.contextChallenge, forged(signed, forger))),
      refusal(401, delegated ? 'peer_delegation_signature_invalid' : 'peer_signature_invalid', false), 'the live scope of the same job authenticates nothing else');
  }
  const other = await w.buyerFor(host, testWallet(44));
  other.purchase(held);
  assert.deepEqual(withoutAuthority(await w.refusedWith(() => other.challenge(held))), refusal(500, MISMATCH), 'another buyer correctly signed for the same job is not related to it');
  step.release();
  assert.equal((await first).status, 200);

  // A restart (the old process and its memory are gone): a buyer needs its own signature and its current enrollment.
  await host.close();
  host = await w.start();
  const restartedKey = testWallet(170);
  w.kitEnrollment.entries.set(restartedKey.claim, [enrolled(restartedKey.claim)]);
  const again = await w.buyerFor(host, restartedKey), next = job(91);
  again.purchase(next);
  const signed = await again.signChallenge(next);
  assert.deepEqual(await w.refusedWith(() => again.post(DACS_SELLER_HTTP_PATHS.contextChallenge, forged(signed, forger))), refusal(401, 'peer_delegation_signature_invalid', false));
  w.kitEnrollment.entries.delete(restartedKey.claim);
  assert.deepEqual(withoutAuthority(await w.refusedWith(() => again.post(DACS_SELLER_HTTP_PATHS.contextChallenge, signed))), refusal(500, MISMATCH), 'a withdrawn enrollment refuses after the restart');
  w.kitEnrollment.entries.set(restartedKey.claim, [enrolled(restartedKey.claim)]);
  const served = await again.challenge(next);
  assert.equal(served.status, 200, served.text);
});

test('from an unopened transport and no binding, the host builds in five stages with the production reader and the kit boundary: the connection read precedes the binding, effect capabilities exist only after finalization; a failure at stage one, the reader, the binding, the boundary or finalization closes what it acquired and exposes no effect capability', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const w = await sellerWorld(t);
  const timeline = [];
  const node = scriptedNode();
  const seen = node.fetch;
  node.fetch = (url, init) => { timeline.push('node-read'); return seen(url, init); };
  let finalized = null;
  const p = testWalletSession({ node, finalize: async (input) => {
    timeline.push('finalize');
    finalized = { input, lockHeld: existsSync(join(w.f.dataDirectory, LOCK_FILE)), effects: existsSync(join(w.f.dataDirectory, 'effects')) };
    return { close: async () => { p.events.push('session-close'); } };
  } });
  const host = await w.start({ walletSession: p.walletSession });
  timeline.push('listening');
  assert.equal(timeline[0], 'node-read', 'the first act is the reader\'s connection read');
  assert.deepEqual(timeline.filter((event) => event !== 'node-read'), ['finalize', 'listening'], 'finalization is the last stage before the host listens');
  assert.equal(finalized.input.binding.recordDigest, RECORD_DIGEST, 'the binding is the approved record\'s, made by the production reader');
  assert.deepEqual(['withFence', 'signPass', 'dispatchPass', 'pass', 'signerFor', 'recordObserved'].filter((name) => typeof finalized.input.effectBoundary[name] !== 'function'), [], 'finalization receives the kit boundary');
  assert.deepEqual([finalized.lockHeld, finalized.effects], [true, true], 'stages four and five run under the lock, over effects/');
  assert.deepEqual(Object.keys(host).sort(), ['close', 'listingPin', 'seller', 'timeouts', 'url'], 'the host hands out no effect capability');
  await host.close();
  assert.deepEqual(p.events.slice(-2), ['session-close', 'close'], 'on shutdown the finalized session closes, then the port');

  const failures = {
    'stage one': () => { const s = testWalletSession(); s.owner.close(); return [{ walletSession: s.walletSession }, s, (error) => error.code === 'transport_closed']; },
    reader: () => { const s = testWalletSession(); return [{ walletSession: s.walletSession, participantImplementations: {} }, s, (error) => error instanceof TypeError && /participantImplementations/.test(error.message)]; },
    binding: () => { const s = testWalletSession(); return [{ walletSession: { ...s.walletSession, connectionAuthority: async () => undefined } }, s, (error) => error.code === 'tp1_connection_unverified']; },
    boundary: () => { const s = testWalletSession(); writeFileSync(join(w.f.dataDirectory, 'effects'), 'TEST not a directory'); return [{ walletSession: s.walletSession }, s, (error) => error.code === 'EEXIST']; },
    finalization: () => { const s = testWalletSession({ finalize: async () => { throw new Error('TEST finalization failed'); } }); return [{ walletSession: s.walletSession }, s, (error) => error.message === 'TEST finalization failed']; },
  };
  for (const [stage, make] of Object.entries(failures)) {
    const [changes, s, expected] = make();
    await assert.rejects(w.start(changes), expected, stage);
    assert.equal(s.events.at(-1), 'close', `${stage}: the port is closed`);
    assert.equal(s.events.filter((event) => event.finalize).length, stage === 'finalization' ? 1 : 0, `${stage}: the boundary reaches no session before the last stage`);
    assert.equal(existsSync(join(w.f.dataDirectory, LOCK_FILE)), false, `${stage}: the state lock is released`);
    rmSync(join(w.f.dataDirectory, 'effects'), { force: true, recursive: true });
  }
});

test('the effects directory and its parent are synced before finalization; a failed sync refuses startup, a retry syncs again, and the acknowledged directories survive the power-loss model', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const w = await sellerWorld(t);
  const effects = join(w.f.dataDirectory, 'effects');
  const require = createRequire(import.meta.url), promises = require('node:fs/promises');
  const real = { open: promises.open, mkdir: promises.mkdir };
  const timeline = [];
  let failSync = null;
  promises.mkdir = async (path, ...rest) => { const made = await real.mkdir(path, ...rest); timeline.push(`mkdir ${path}`); return made; };
  promises.open = async (path, ...rest) => {
    const handle = await real.open(path, ...rest), syncHandle = handle.sync.bind(handle);
    handle.sync = async () => {
      if (failSync === String(path)) { failSync = null; throw Object.assign(new Error('TEST directory sync failed'), { code: 'EIO' }); }
      await syncHandle();
      timeline.push(`sync ${path}`);
    };
    return handle;
  };
  syncBuiltinESMExports();
  t.after(() => { Object.assign(promises, real); syncBuiltinESMExports(); });
  const port = () => testWalletSession({ finalize: async () => { timeline.push('finalize'); return { close: async () => {} }; } });

  failSync = effects;
  const refused = port();
  await assert.rejects(w.start({ walletSession: refused.walletSession }), (error) => error.code === 'EIO' && error.cause?.message === 'TEST directory sync failed');
  assert.equal(timeline.includes('finalize'), false, 'a failed sync finalizes nothing');
  assert.equal(refused.events.at(-1), 'close');
  assert.ok(timeline.includes(`mkdir ${effects}`), 'the failed start had created effects/');
  const retried = timeline.length;
  const host = await w.start({ walletSession: port().walletSession });
  const at = (event) => timeline.indexOf(event, retried), finalize = timeline.indexOf('finalize');
  assert.ok(at(`sync ${effects}`) !== -1 && at(`sync ${effects}`) < finalize, 'the retry syncs effects/ again before finalization');
  assert.ok(timeline.lastIndexOf(`sync ${w.f.dataDirectory}`, finalize) > at(`sync ${effects}`), 'and then its parent, before finalization');
  // The power-loss model at the moment of finalization: a directory created (in either start) and not covered by a later
  // completed sync of its parent is lost.
  const created = timeline.slice(0, finalize).filter((event) => event.startsWith('mkdir ')).map((event) => event.slice('mkdir '.length));
  const lost = created.filter((path) => !timeline.slice(timeline.indexOf(`mkdir ${path}`), finalize).includes(`sync ${join(path, '..')}`));
  assert.deepEqual(lost, [], 'every directory created before finalization survives');
  assert.ok(readdirSync(w.f.dataDirectory).includes('effects'));
  await host.close();
});

test('from empty job and admission stores, with the buyer enrolled in the kit composition and the seller enrolled in the buyer\'s, the production reader admits discovery, the first challenge and the context request; a second job and a restart work; a compensating or aborted context admission row, work after its request\'s bootstrap scope ended, and a correctly signed request that only declares the TP-1 tuple refuse tp1_participant_profile_mismatch with zero seller signatures; a host composed without participantImplementations throws TypeError; the host\'s delegation bytes equal the wire\'s pinned delegation vector; with the stop flag set the discovery scope still answers', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const failing = job(100);
  const capability = contextCapability({ resolveBuyer: async (input, options) => {
    if (input.scope.jobId === failing) { options.writable(); throw new Error('TEST the Vet readback failed'); }
    return presentContextAnswer(input);
  } });
  const w = await sellerWorld(t, { capability, publicEndpoint: FIXTURE_ENDPOINT });
  let host = await w.start();
  const b = await w.buyerFor(host);
  const discovery = async () => {
    const response = await fetch(host.url + DACS_SELLER_DISCOVERY_PATH);
    assert.equal(response.status, 200);
    return b.verifyDiscovery(Buffer.from(await response.arrayBuffer()));
  };
  await discovery();
  for (const jobId of [job(101), job(102)]) {
    b.purchase(jobId);
    await b.admit(jobId);
    assert.equal(admissionState(w.f.dataDirectory, jobId), 'settled');
  }
  const declared = await w.buyerFor(host, testWallet(45)), declaredJob = job(103);
  declared.purchase(declaredJob);
  assert.deepEqual(withoutAuthority(await w.refusedWith(() => declared.challenge(declaredJob))), refusal(500, MISMATCH), 'an unenrolled buyer\'s declaration');
  b.purchase(failing);
  assert.equal((await b.requestContext(failing)).status >= 500, true);
  assert.equal(admissionState(w.f.dataDirectory, failing), 'compensating');
  assert.deepEqual(withoutAuthority(await w.refusedWith(() => b.challenge(failing))), refusal(500, MISMATCH), 'a compensating row');
  await assert.rejects(w.start({ participantImplementations: undefined }), { name: 'TypeError', message: 'the seller host requires participantImplementations' });

  // A restart whose anchor proves no CREATE was kept: the startup sweep ends the compensating row, and the job stays refused.
  await host.close();
  const anchor = w.f.native;
  host = await w.start({ artifactAnchor: { ...anchor, readRetained: async (query, options) => {
    const read = await anchor.readRetained(query, options);
    return query.proofOfNoIntent === true && read.status === 'absent' ? provenUnsignedAbsence('TEST no CREATE intent') : read;
  } } });
  assert.equal(admissionState(w.f.dataDirectory, failing), 'aborted');
  const after = await w.buyerFor(host);
  after.purchase(failing);
  assert.deepEqual(withoutAuthority(await w.refusedWith(() => after.challenge(failing))), refusal(500, MISMATCH), 'an aborted row');
  const third = job(104);
  after.purchase(third);
  await after.admit(third);

  // The kit composition's own stages: a scope answers inside its request and nothing after it ends.
  const stages = await openSellerStages({ walletSession: testWalletSession().walletSession, participantImplementations: enrollment(), sellerClaim: seller.claim,
    listingPin: host.listingPin, retainedJob: () => null, maxConcurrent: 1 });
  t.after(() => stages.close());
  const scoped = job(105);
  after.purchase(scoped);
  const header = (await after.signChallenge(scoped)).header;
  const ask = () => assertTp1Authority(stages.binding, stages.local(), [buyer.claim, seller.claim], scoped);
  const later = await (async () => {
    const scope = stages.bootstrap.enter(header);
    try { await ask(); return () => ask(); } finally { scope.end(); }
  })();
  await assert.rejects(later(), { code: MISMATCH }, 'work that outlives its request reads no scope');

  // The host checks a delegation over exactly the wire's bytes.
  const [vectorBuyer, vectorSeller, vectorSession] = [party(1), party(2), party(3)];
  const vectorPin = { listingId: 'tp1-vector-listing', version: 1, contentHash: sha256Hex('contracts-vector-listing') };
  const payload = { version: '1', kind: 'seller-session-delegation', buyer: vectorBuyer.claim, sessionPublicKey: vectorSession.raw, seller: vectorSeller.claim, listingPin: vectorPin,
    jobId: generateCanonicalJobId({ timestamp: VECTOR_TIME, entropy: Buffer.alloc(10, 0x11) }), notBefore: VECTOR_TIME - 30000, expiresAt: VECTOR_TIME + 3600000, profile: TP1_PROFILE };
  const bytes = Buffer.from(DACS_SELLER_HTTP_DOMAINS.delegation + canonicalize(payload));
  assert.deepEqual([bytes.length, sha256Hex(bytes)], [PINNED_DELEGATION_LENGTH, PINNED_DELEGATION_SHA256]);
  const vectorScopes = createBootstrapScopes({ sellerClaim: vectorSeller.claim, listingPin: vectorPin, retainedJob: () => null, maxConcurrent: 1 });
  const delegatedHeader = (signed) => encode({ payload: {}, signature: 'A'.repeat(86), delegation: { payload, signature: vectorBuyer.signBytes(signed).toString('base64url') } });
  const handle = vectorScopes.enter(delegatedHeader(bytes));
  assert.equal(handle.scope?.jobId, payload.jobId, 'a delegation signed over the pinned bytes opens its scope');
  handle.end();
  assert.throws(() => vectorScopes.enter(delegatedHeader(Buffer.from(`dacs-chatgpt-plugin:seller-session-delegation:v1:${canonicalize(payload)}`))), { code: 'peer_delegation_signature_invalid', status: 401 });

  // The process stop flag is set last: it cannot be cleared in this process.
  requestStop();
  await discovery();
});
