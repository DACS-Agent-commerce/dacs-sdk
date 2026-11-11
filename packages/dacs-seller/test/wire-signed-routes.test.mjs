// P11a1a: the signed read, proposal and commitment routes on `./wire`. Every request is opened and every answer signed by
// the wire; reservation accounting commits before the wire journal publishes each effect. The handler runs over a real transport store, a bound TP1
// profile and a counting stub agent; the buyer signs with `signWireRequest` (helpers/wire-buyer.mjs).
//
// Journal-opening cases need a runner where `/` is root-owned (K5-J0).
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { mkdirSync, readdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import DatabaseSync from 'better-sqlite3';
import { canonicalize, compositeVerificationAddress, sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_PATHS, TP1_CAPABILITIES, WireError, admitWireArtifact, inspectWireOperation, openWireRequestJournal, wireOperationId } from '@kynesyslabs/dacs/wire';
import { fixtureIdentityBundle, fixtureListing } from './fixtures/listings.mjs';
import { exchange } from './helpers/d5-http-fixture.mjs';
import { proposalForInput } from './helpers/proposal-admission-fixture.mjs';
import { NOW, buyer, seller, testWallet } from './helpers/protocol-fixture.mjs';
import { TEST_CONNECTION, authorityReader } from './helpers/wire-authority-fixture.mjs';
import { wireBuyer } from './helpers/wire-buyer.mjs';
import { agreementInput, listingPin } from '../src/dacs/purchase-protocol.mjs';
import { SellerAgentError } from '../src/dacs/seller-agent.mjs';
import { createSellerAgentClient, createSellerHttpHandler } from '../src/dacs/seller-http.mjs';
import { wireContinuationFixture, receiptReader } from './helpers/wire-continuation-fixture.mjs';
import { WIRE_ROUTE_PATHS, createWireContext, wireAuthenticator } from '../src/dacs/seller-wire-requests.mjs';
import { SELLER_TRANSPORT_HEADER, createSellerTransportClientAuth, createSellerTransportServerAuth } from '../src/dacs/seller-transport-auth.mjs';
import { createSellerTransportStore } from './helpers/bound-transport-store.mjs';

const PATHS = DACS_SELLER_HTTP_PATHS;
const BUYER = { claim: buyer.claim, sign: buyer.signBytes };
const SELLER = { claim: seller.claim, sign: seller.signBytes };
const session = testWallet(3);
const SESSION = { claim: session.claim, sign: session.signBytes };
const LISTING = fixtureListing(seller, { now: NOW });
const PIN = listingPin(LISTING);
const CLAIM_PREFIX = 'did:demos:agent:';
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_HEADER_CHARS = 4096;
const MAX_REQUEST_LIFETIME_MS = 60_000;
const MAX_SIGNED_LIFETIME_MS = 30_000;
const SKEW_MS = 30_000;
const DAY_MS = 86_400_000;
const REQUEST_NONCE_BYTE = 0x6e;
const JOURNAL_LEASE_MS = 300_000;
const OLD_PIN_VERSION = 'dacs-demos-testnet-identity/2026-10-15';

const derive = (label) => sha256Hex(`wire-signed-routes:${label}`);
const jobFor = (label) => `0${derive(`job-${label}`).slice(0, 25).toUpperCase()}`;
const publicKeyHex = (wallet) => wallet.claim.slice(CLAIM_PREFIX.length);
let nonceCounter = 0;
const nextNonce = () => Buffer.alloc(24, (REQUEST_NONCE_BYTE + ++nonceCounter) % 256).toString('base64url');
const vetRef = (jobId, party) => ({ anchor: { kind: 'storage-program', locator: compositeVerificationAddress(jobId, party.claim) }, contentHash: derive(`vet:${jobId}:${party.claim}`), signer: seller.claim });
const MUTATING = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|BEGIN)/i;

/** A valid proposals body for `jobId`, with the Agreement hash and deadline its draft names. */
async function proposalFor(jobId) {
  const base = agreementInput({ jobId, listing: LISTING, buyerBundle: fixtureIdentityBundle(buyer, NOW), generatedAt: NOW });
  const input = { ...base, buyer: { ...base.buyer, vetRecordRef: vetRef(jobId, buyer) }, seller: { ...base.seller, vetRecordRef: vetRef(jobId, seller) } };
  const body = await proposalForInput(input);
  return { body, agreementHash: body.transportIdentity.agreementHash, deadline: body.proposal.plan.draft.terms.deadline };
}
const identityBody = (jobId, agreementHash) => ({ transportIdentity: { jobId, buyer: buyer.claim, seller: seller.claim, agreementHash } });

/** The statements the store's database ran while `work` ran. */
async function statementsDuring(work) {
  const { prepare, exec } = DatabaseSync.prototype;
  const seen = [];
  DatabaseSync.prototype.prepare = function recordPrepare(sql) { seen.push(sql); return prepare.call(this, sql); };
  DatabaseSync.prototype.exec = function recordExec(sql) { seen.push(sql); return exec.call(this, sql); };
  try { await work(); } finally { Object.assign(DatabaseSync.prototype, { prepare, exec }); }
  return seen;
}

/** A counting stand-in for the seller agent: it retains each proposal's draft, as the real agent's session does. */
function stubAgent() {
  const drafts = new Map();
  const agent = {
    claim: seller.claim, listingPin: PIN, retains: false, credit: () => {}, onWork: () => {}, answer: undefined, fenced: undefined,
    calls: { proposals: 0, commits: 0, signatureCommits: 0, states: 0, reconciled: 0, payments: 0 },
    transportAgreementOf: (jobId) => structuredClone(drafts.get(jobId) ?? null),
    retainsProposalWork: (jobId) => agent.retains && drafts.has(jobId),
    assertSettlementCredit: (jobId) => agent.credit(jobId),
    receiveProposal: async (body, { transport } = {}) => {
      agent.calls.proposals++;
      agent.onWork('proposal', body);
      transport?.check();
      drafts.set(body.transportIdentity.jobId, body.proposal.plan.draft);
      // As the real agent does, an answer may be settled inside the job fence (`fenced`) before the route returns.
      if (agent.fenced !== undefined) transport.settle({ status: 200, value: agent.fenced });
      return agent.answer ? agent.answer() : { disposition: 'complete', contribution: { signed: true } };
    },
    commit: async (body) => { agent.calls.commits++; agent.onWork('commit', body); return agent.answer ? agent.answer() : { status: 'committed', jobId: body.jobId }; },
    commitOnSignature: async (body) => { agent.calls.signatureCommits++; return { status: 'committed', jobId: body.jobId }; },
    readCommitment: async ({ jobId }) => { agent.onWork('commit-read'); return { status: 'committed', jobId }; },
    continuationEvidenceOf: () => null,
    agreementState: (identity) => { agent.calls.states++; return { proposal: null, contribution: null, jobId: identity.jobId }; },
    submitPayment: async () => { agent.calls.payments++; agent.onWork('payment'); return { status: 'payment-evidenced', delivery: { status: 'delivered' } }; },
    reconcileTransport: async ({ request, transport }) => {
      agent.calls.reconciled++;
      transport.claim();
      transport.settle({ status: 200, value: request.path === PATHS.proposals ? { disposition: 'complete', contribution: { signed: true } } : { status: 'committed', jobId: request.jobId }, settle: true });
    },
  };
  return agent;
}

/** One seller: a transport store, a bound profile, the wire journal and the handler, with a buyer that signs for it. */
async function world(t, { maxJobs, maxRecords, readAuthority = authorityReader(), fixture = null, commitOnSignature = true } = {}) {
  const pin = fixture ? listingPin(fixture.listing) : PIN;
  const directory = await mkdtemp(join(tmpdir(), 'TEST-wire-routes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'transport'), { mode: 0o700 });
  const storePath = join(directory, 'transport', 'transport.sqlite');
  const state = { time: NOW, ready: true, connection: { ...TEST_CONNECTION }, authorityReads: 0, withdrawAtRead: null, lapseAtRead: null, lapseMs: MAX_SIGNED_LIFETIME_MS + 1, elapsedMs: 0, readsAtReserve: 0, journals: [], session: null };
  // The wire measures the time an admission takes with `performance.now`: the test moves it forward by `elapsedMs`.
  const monotonicNow = performance.now.bind(performance);
  mock.method(performance, 'now', () => monotonicNow() + state.elapsedMs);
  t.after(() => mock.restoreAll());
  const clock = () => state.time;
  const connection = () => ({ ...state.connection });
  const signing = { calls: 0, failures: 0 };
  const sellerSigner = { claim: seller.claim, sign: (bytes) => {
    signing.calls++;
    if (signing.failures > 0) { signing.failures--; throw new Error('TEST signer failure'); }
    return seller.signBytes(bytes);
  } };
  const reader = (scope) => {
    state.authorityReads++;
    if (state.withdrawAtRead === state.authorityReads) throw new WireError('tp1_participant_refused', 503, undefined, new Error('TEST authority withdrawn'));
    if (state.lapseAtRead === state.authorityReads) state.elapsedMs += state.lapseMs;
    return readAuthority(scope);
  };
  const buyerWire = await wireBuyer({ buyer: BUYER, seller: SELLER, listingPin: pin, clock, connection, readAuthority: reader,
    readCommitmentReceipt: receiptReader(), publicEndpoint: fixture?.listing.seller.publicEndpoint,
    evidenceFor: async (path, id) => fixture && [...CONTINUING, PATHS.bundleBuyerCopy].includes(path) ? {
      commitment: Buffer.from(fixture.agent().continuationEvidenceOf(id).commitmentText),
      agreement: Buffer.from(fixture.agent().continuationEvidenceOf(id).agreementText), signedListing: Buffer.from(JSON.stringify(fixture.listing)),
    } : {} });
  const agent = stubAgent();
  agent.listingPin = pin;
  agent.bundleRequest = async () => { agent.calls.bundles++; agent.onWork('bundle'); return { status: 'held' }; };
  agent.countersign = agent.bundleRequest;
  agent.confirmBuyerCopy = async () => ({ status: 'held' });
  agent.commitOnSignature = agent.commit;
  agent.calls.bundles = 0;
  if (fixture) {
    // The durable agent already committed this job; the host holds it from the proposal its wire route admitted, which is when the store keeps the tuple.
    const proposed = agent.transportAgreementOf;
    agent.transportAgreementOf = (jobId) => proposed(jobId) === null ? null : fixture.agent().transportAgreementOf(jobId);
    agent.continuationEvidenceOf = (jobId) => fixture.agent().continuationEvidenceOf(jobId);
  }
  const handle = { store: null, handler: null, finishFails: false, wireOverrides: {} };
  const link = fs.linkSync;
  mock.method(fs, 'linkSync', (source, destination) => {
    if (handle.finishFails && destination.endsWith('.end')) throw new Error('TEST process died before outcome publication');
    return link(source, destination);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
  const mount = () => {
    if (fixture) fixture.admittedListing = admitWireArtifact(Buffer.from(JSON.stringify(fixture.listing)));
    const store = createSellerTransportStore({ path: storePath, maxJobs, maxRecords, now: clock, contextSessionState: () => state.session, wireOperationView: target => inspectWireOperation(handle.wire.journal, target) });
    const accounted = store.reservationAccounting.reserveAccounted.bind(store.reservationAccounting);
    store.reservationAccounting.reserveAccounted = input => accounted({ ...input, checked: { ...input.checked, reserve: async () => {
      try { return await input.checked.reserve(); } finally { state.readsAtReserve = state.authorityReads; }
    } } });
    const journalDirectory = join(directory, 'wire-journal');
    if (state.journals.length === 0) { mkdirSync(journalDirectory, { mode: 0o700 }); state.journals.push(journalDirectory); }
    const journal = openWireRequestJournal(journalDirectory, { leaseMs: JOURNAL_LEASE_MS, clock });
    const authentication = createSellerTransportServerAuth({ sellerSigner: { claim: seller.claim, sign: seller.signBytes }, listingPin: pin, store, now: clock });
    const wire = createWireContext({ binding: buyerWire.binding, tp1Network: { connection, readAuthority: reader }, signer: sellerSigner, journal, store, ready: () => state.ready, now: clock, agent, requireDelegation: false,
      signedListing: fixture?.admittedListing, readCommitmentReceipt: fixture?.readCommitmentReceipt ?? receiptReader(), ...handle.wireOverrides });
    Object.assign(handle, { store, authentication, wire, handler: createSellerHttpHandler(agent, { authentication, wire, commitOnSignature }) });
  };
  mount();
  t.after(() => handle.store.close());
  const reopen = () => { handle.store.close(); handle.finishFails = false; mount(); };
  /** Runs `work` on a restarted seller whose wire context takes `overrides` (the context is frozen), then restarts it again without them. */
  const withWire = async (overrides, work) => {
    handle.wireOverrides = overrides; reopen();
    try { return await work(); } finally { handle.wireOverrides = {}; reopen(); }
  };
  const answerOf = (res, payload) => ({ status: res.status, text: res.text, body: JSON.parse(res.text), header: res.headers?.[SELLER_TRANSPORT_HEADER], signed: res.headers?.[SELLER_TRANSPORT_HEADER] !== undefined, payload });
  const send = async (path, { text, header, payload = null }) => answerOf(await exchange(handle.handler, { url: path, text, header }), payload);
  /** A request the buyer's `signWireRequest` signs, sent through the handler. */
  const post = async (path, body, { jobId, agreementHash, ...options } = {}) => {
    const signed = await buyerWire.signRequest(path, body, { jobId, agreementHash, ...options });
    return send(path, signed);
  };
  const verified = (answer) => buyerWire.authentication(() => null).verifyResponse(answer.payload, { header: answer.header, status: answer.status, responseBytes: Buffer.from(answer.text) });
  const rows = () => {
    const db = new DatabaseSync(storePath, { readonly: true });
    try { return Object.fromEntries(['peer_effects', 'peer_nonces', 'peer_jobs', 'peer_slots', 'kit_purchase_profiles'].map((name) => [name, db.prepare(`SELECT count(*) AS n FROM ${name}`).get().n])); } finally { db.close(); }
  };
  const journalFiles = () => state.journals.flatMap((directoryPath) => readdirSync(directoryPath));
  const effects = (counter = agent.calls) => Object.values(counter).reduce((sum, n) => sum + n, 0);
  /** A hand-built request header, signed as `signer` under `domain`: payloads the wire's own signer refuses to make. */
  const payloadFor = (path, text, { jobId, agreementHash, expiresAt = NOW + MAX_SIGNED_LIFETIME_MS, buyerClaim = buyer.claim, ...rest }) => ({ version: '1', kind: 'request', method: 'POST', path, bodyHash: sha256Hex(text),
    jobId, buyer: buyerClaim, seller: seller.claim, listingPin: pin, agreementHash, nonce: nextNonce(), expiresAt, profile: buyerWire.binding.profile, ...rest });
  const headerFor = (payload, { signer = BUYER, domain = DACS_SELLER_HTTP_DOMAINS.request, delegation } = {}) => Buffer.from(canonicalize({ payload,
    signature: signer.sign(Buffer.from(domain + canonicalize(payload))).toString('base64url'), ...(delegation ? { delegation } : {}) })).toString('base64url');
  const delegationFor = ({ jobId, expiresAt, domain = DACS_SELLER_HTTP_DOMAINS.delegation, ...rest }) => {
    const payload = { version: '1', kind: 'seller-session-delegation', buyer: buyer.claim, seller: seller.claim, sessionPublicKey: publicKeyHex(session), listingPin: pin, jobId,
      notBefore: NOW - SKEW_MS, expiresAt, profile: buyerWire.binding.profile, ...rest };
    return { payload, signature: BUYER.sign(Buffer.from(domain + canonicalize(payload))).toString('base64url') };
  };
  return { directory, state, agent, signing, buyerWire, handle, mount, reopen, withWire, post, send, verified, rows, journalFiles, effects, payloadFor, headerFor, delegationFor, storePath, clock };
}

const proposeJob = async (w, label) => {
  const jobId = jobFor(label), proposal = await proposalFor(jobId);
  return { jobId, ...proposal, post: (options) => w.post(PATHS.proposals, proposal.body, { jobId, agreementHash: proposal.agreementHash, ...options }) };
};

test('P11a1-T03: a missing revision, an unknown revision or an old pin version is refused before any store access; the own profile is accepted', async (t) => {
  const w = await world(t);
  const job = await proposeJob(w, 't03');
  const signed = await w.buyerWire.signRequest(PATHS.proposals, job.body, { jobId: job.jobId, agreementHash: job.agreementHash });
  const altered = (change) => { const envelope = JSON.parse(Buffer.from(signed.header, 'base64url')); change(envelope.payload.profile); return { text: signed.text, header: Buffer.from(canonicalize(envelope)).toString('base64url') }; };
  const cases = [
    ['tp1_profile_revision_missing', altered((profile) => { delete profile.revision; })],
    ['tp1_profile_revision_unknown', altered((profile) => { profile.revision = 'unknown-revision'; })],
    ['tp1_profile_mismatch', altered((profile) => { profile.pinVersion = OLD_PIN_VERSION; })],
  ];
  for (const [code, request] of cases) {
    let answer;
    const statements = await statementsDuring(async () => { answer = await w.send(PATHS.proposals, request); });
    assert.deepEqual({ status: answer.status, error: answer.body.error, signed: answer.signed }, { status: 409, error: code, signed: false }, code);
    assert.deepEqual(statements, [], `${code}: no statement reached the store`);
  }
  assert.equal(w.effects(), 0);
  const own = await job.post();
  assert.equal(own.status, 200);
  await w.verified(own);
});

test('P11a1-T04: a new purchase keeps its tuple inside the reservation transaction, before the agent runs, and a later request under a different kept tuple is refused', async (t) => {
  const w = await world(t);
  const job = await proposeJob(w, 't04');
  let keptWhenAgentRan = null;
  w.agent.onWork = (kind, body) => { keptWhenAgentRan = w.handle.store.purchaseProfile(body.transportIdentity.jobId); };
  assert.equal(w.handle.store.purchaseProfile(job.jobId), null, 'nothing is kept before the request');
  assert.equal((await job.post()).status, 200);
  assert.deepEqual(keptWhenAgentRan, w.buyerWire.binding.profile, 'the tuple was durable when the agent started');
  w.reopen();
  assert.deepEqual(w.handle.store.purchaseProfile(job.jobId), w.buyerWire.binding.profile, 'and it survives a restart');
  const other = await proposeJob(w, 't04-other');
  const earlier = (await w.buyerWire.signRequest(PATHS.proposals, other.body, { jobId: other.jobId, agreementHash: other.agreementHash })).payload;
  w.handle.store.reserve(earlier, other.body, { keepProfile: { ...w.buyerWire.binding.profile, pinVersion: OLD_PIN_VERSION } });
  const before = { calls: w.agent.calls.proposals, rows: w.rows() };
  const refused = await other.post();
  assert.deepEqual({ status: refused.status, error: refused.body.error }, { status: 500, error: 'tp1_purchase_profile_mismatch' });
  assert.deepEqual({ calls: w.agent.calls.proposals, rows: w.rows() }, before, 'no agent call and no row');
});

test('P11a1-T05: answers of null, an array, a number, a boolean, a string, malformed Unicode, malformed JSON, duplicate members and 512 KiB + 1 byte are each refused outgoing_body_rejected with no stored terminal answer; an object of exactly 512 KiB and an ordinary object are stored as given, and sign and verify unchanged on replay', async (t) => {
  const w = await world(t);
  const refusedAnswers = [null, [], 7, true, 'text', { pad: 'x'.repeat(MAX_RESPONSE_BYTES) }];
  for (const [index, answer] of refusedAnswers.entries()) {
    const job = await proposeJob(w, `t05-refused-${index}`);
    w.agent.answer = () => answer;
    const refused = await job.post();
    assert.deepEqual({ status: refused.status, error: refused.body.error, signed: refused.signed }, { status: 500, error: 'outgoing_body_rejected', signed: true }, `answer ${index}`);
    await w.verified(refused);
  }
  assert.equal(accountingRows(w).length, refusedAnswers.length);
  assert.equal(w.journalFiles().some(name => name.endsWith('.done')), false);
  const db = new DatabaseSync(w.storePath, { readonly: true });
  try { assert.deepEqual(db.prepare("SELECT state FROM peer_effects WHERE state = 'complete'").all(), [], 'no refused answer became a terminal entry'); } finally { db.close(); }
  const { encode } = wireAuthenticator(w.handle.wire, w.agent, w.handle.authentication);
  for (const text of ['\ud800', '{"a":', '{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '[1]', 'null']) {
    assert.throws(() => encode(text), { code: 'outgoing_body_rejected', status: 500 }, JSON.stringify(text));
  }
  const exact = { pad: '' };
  exact.pad = 'x'.repeat(MAX_RESPONSE_BYTES - Buffer.byteLength(JSON.stringify(exact)));
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), MAX_RESPONSE_BYTES);
  for (const [label, answer] of [['exactly 512 KiB', exact], ['ordinary', { disposition: 'complete', contribution: { signed: true } }]]) {
    const job = await proposeJob(w, `t05-stored-${label}`);
    w.agent.answer = () => answer;
    const first = await job.post(), replay = await job.post();
    assert.equal(first.status, 200, label);
    assert.equal(first.text, JSON.stringify(answer), `${label}: stored as given`);
    assert.equal(replay.text, first.text, `${label}: the replay is the stored text`);
    assert.equal((await w.verified(first)).body.disposition ?? 'object', answer.disposition ?? 'object');
    await w.verified(replay);
  }
});

test('P11a1-T06: duplicate members, lossy numbers and oversized bodies are refused before any hash, store or agent call', async (t) => {
  const w = await world(t);
  const job = await proposeJob(w, 't06');
  const signed = await w.buyerWire.signRequest(PATHS.proposals, job.body, { jobId: job.jobId, agreementHash: job.agreementHash });
  const bodies = [['{"x":0,"x":1}', 400, 'bad_json'], ['{"n":9007199254740991.1}', 400, 'bad_json'], ['x'.repeat(MAX_BODY_BYTES + 1), 413, 'body_too_large']];
  const statements = await statementsDuring(async () => {
    for (const [text, status, error] of bodies) {
      const answer = await w.send(PATHS.proposals, { text, header: signed.header });
      assert.deepEqual({ status: answer.status, error: answer.body.error, signed: answer.signed }, { status, error, signed: false }, error);
    }
  });
  assert.deepEqual(statements, []);
  assert.equal(w.effects() + w.signing.calls, 0);
});

test('P11a1-T07: a header of 4,097 characters is refused unsigned', async (t) => {
  const w = await world(t);
  const job = await proposeJob(w, 't07');
  const statements = await statementsDuring(async () => {
    const answer = await w.send(PATHS.proposals, { text: JSON.stringify(job.body), header: 'A'.repeat(MAX_HEADER_CHARS + 1) });
    assert.deepEqual({ status: answer.status, error: answer.body.error, signed: answer.signed }, { status: 401, error: 'peer_envelope_invalid', signed: false });
  });
  assert.deepEqual(statements, []);
  assert.equal(w.effects(), 0);
});

test('P11a1-T08: delegated proposals: a live delegation is admitted; bad lifetime, scope, deadline, domain or missing artifacts are refused with their own codes', async (t) => {
  const w = await world(t);
  const delegatedWith = async (label, fields, { domain, stateRoute = false } = {}) => {
    const job = await proposeJob(w, `t08-${label}`);
    const delegation = w.delegationFor({ jobId: job.jobId, expiresAt: job.deadline, ...(typeof fields === 'function' ? fields(job) : fields), ...(domain ? { domain } : {}) });
    const path = stateRoute ? PATHS.state : PATHS.proposals;
    const body = stateRoute ? identityBody(job.jobId, job.agreementHash) : job.body;
    const text = JSON.stringify(body);
    const payload = w.payloadFor(path, text, { jobId: job.jobId, agreementHash: job.agreementHash, expiresAt: NOW + MAX_SIGNED_LIFETIME_MS });
    return w.send(path, { text, header: w.headerFor(payload, { signer: SESSION, delegation }), payload });
  };
  const live = await delegatedWith('live', {});
  assert.equal(live.status, 200, 'a live delegation within the draft deadline is admitted');
  const refusals = {
    lifetime: [{ expiresAt: NOW + DAY_MS + SKEW_MS }, undefined, 'peer_delegation_invalid'],
    scope: [{ jobId: jobFor('t08-another-job') }, undefined, 'peer_delegation_mismatch'],
    deadline: [(job) => ({ expiresAt: job.deadline + 1 }), undefined, 'peer_delegation_deadline'],
    domain: [{}, DACS_SELLER_HTTP_DOMAINS.request, 'peer_delegation_signature_invalid'],
  };
  const callsBefore = w.effects();
  for (const [label, [fields, domain, error]] of Object.entries(refusals)) {
    const answer = await delegatedWith(label, fields, { domain });
    assert.equal(answer.body.error, error, label);
    assert.ok(answer.status >= 400 && answer.status < 500, `${label}: ${answer.status}`);
  }
  const missing = await delegatedWith('artifacts', {}, { stateRoute: true });
  assert.deepEqual({ status: missing.status, error: missing.body.error }, { status: 409, error: 'peer_delegation_agreement_required' });
  assert.equal(w.effects(), callsBefore, 'no refusal reached the agent');
});


test('P11a1-T10: a small-order identity key never authenticates a request or a delegation', async (t) => {
  const w = await world(t);
  const job = await proposeJob(w, 't10');
  // The identity point with R = the identity and S = 0 verifies for every message.
  const identityKey = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]).toString('hex');
  const constantSignature = Buffer.concat([Buffer.from([1]), Buffer.alloc(63)]).toString('base64url');
  const text = JSON.stringify(job.body);
  const forger = `${CLAIM_PREFIX}${identityKey}`;
  const forgedRequest = Buffer.from(canonicalize({ payload: w.payloadFor(PATHS.proposals, text, { jobId: job.jobId, agreementHash: job.agreementHash, buyerClaim: forger }), signature: constantSignature })).toString('base64url');
  const request = await w.send(PATHS.proposals, { text, header: forgedRequest });
  assert.deepEqual({ status: request.status, error: request.body.error, signed: request.signed }, { status: 401, error: 'peer_signature_invalid', signed: false });
  const forgedDelegation = { ...w.delegationFor({ jobId: job.jobId, expiresAt: job.deadline, buyer: forger }), signature: constantSignature };
  const payload = w.payloadFor(PATHS.proposals, text, { jobId: job.jobId, agreementHash: job.agreementHash, buyerClaim: forger });
  const delegated = await w.send(PATHS.proposals, { text, header: w.headerFor(payload, { signer: SESSION, delegation: forgedDelegation }) });
  assert.deepEqual({ status: delegated.status, error: delegated.body.error, signed: delegated.signed }, { status: 401, error: 'peer_delegation_signature_invalid', signed: false });
  const forgedSession = w.delegationFor({ jobId: job.jobId, expiresAt: job.deadline, sessionPublicKey: identityKey });
  const sessionPayload = w.payloadFor(PATHS.proposals, text, { jobId: job.jobId, agreementHash: job.agreementHash });
  const bySession = await w.send(PATHS.proposals, { text, header: Buffer.from(canonicalize({ payload: sessionPayload, signature: constantSignature, delegation: forgedSession })).toString('base64url') });
  assert.deepEqual({ status: bySession.status, error: bySession.body.error, signed: bySession.signed }, { status: 401, error: 'peer_signature_invalid', signed: false });
  assert.equal(w.effects(), 0);
});

test('P11a1-T11: request lifetimes up to 60,000 ms and peer clocks within 30 s pass; one millisecond beyond is peer_expired; responses live at most 30 s', async (t) => {
  const w = await world(t);
  const lifetimes = [[MAX_REQUEST_LIFETIME_MS, 200], [MAX_REQUEST_LIFETIME_MS + 1, 408]];
  for (const [lifetime, status] of lifetimes) {
    const job = await proposeJob(w, `t11-${lifetime}`);
    const text = JSON.stringify(job.body);
    const payload = w.payloadFor(PATHS.proposals, text, { jobId: job.jobId, agreementHash: job.agreementHash, expiresAt: NOW + lifetime });
    const answer = await w.send(PATHS.proposals, { text, header: w.headerFor(payload), payload });
    assert.equal(answer.status, status, `lifetime ${lifetime}`);
    if (status === 408) assert.equal(answer.body.error, 'peer_expired');
    if (status === 200) {
      const { payload: signedPayload } = JSON.parse(Buffer.from(answer.header, 'base64url'));
      assert.equal(signedPayload.expiresAt - NOW, MAX_SIGNED_LIFETIME_MS, 'the response lives at most 30 s');
    }
  }
  const ahead = await proposeJob(w, 't11-ahead');
  w.state.time = NOW + SKEW_MS;
  const signedAhead = await w.buyerWire.signRequest(PATHS.proposals, ahead.body, { jobId: ahead.jobId, agreementHash: ahead.agreementHash });
  w.state.time = NOW;
  assert.equal((await w.send(PATHS.proposals, signedAhead)).status, 200, 'a peer 30 s ahead passes');
  const behind = await proposeJob(w, 't11-behind');
  w.state.time = NOW - SKEW_MS;
  const signedBehind = await w.buyerWire.signRequest(PATHS.proposals, behind.body, { jobId: behind.jobId, agreementHash: behind.agreementHash, lifetimeMs: MAX_SIGNED_LIFETIME_MS });
  w.state.time = NOW;
  assert.equal((await w.send(PATHS.proposals, signedBehind)).body.error, 'peer_expired', 'a peer 30 s behind has no time left');
});

test('P11a1-T12: labels outside the signing domains and the report envelope in the capabilities are unchanged', () => {
  assert.deepEqual({ ...DACS_SELLER_HTTP_DOMAINS }, { request: 'dacs-seller-http:v1:request:', response: 'dacs-seller-http:v1:response:', delegation: 'dacs-seller-http:v1:delegation:', discovery: 'dacs-seller-http:v1:discovery:', explicitCreateResume: 'dacs-seller-http:v1:explicit-create-resume:' });
  assert.equal(TP1_CAPABILITIES.output.envelope, 'dacs-chatgpt-plugin/devnet-purchased-report');
  assert.equal(TP1_CAPABILITIES.output.reportVersion, '1');
});

test('P11a1-T13: a valid request for a job the seller holds nothing for gets a signed 404 `peer_unknown_job` with no reservation. On the state route and an effect route, each of these keeps its own code instead: an expired request, another method, path or body hash, another seller, another Listing, a delegation of another scope, and an expired delegation on the effect route. An expired delegation on the state route still gets the 404. Storage and effect counters stay unchanged; an initial proposal never takes this branch', async (t) => {
  const w = await world(t);
  const routes = [[PATHS.state, (jobId, hash) => identityBody(jobId, hash)], [PATHS.commitments, (jobId) => ({ jobId })]];
  for (const [path, bodyFor] of routes) {
    const unknown = { jobId: jobFor(`t13-${path}`), agreementHash: derive(`t13-hash-${path}`) };
    const body = bodyFor(unknown.jobId, unknown.agreementHash), text = JSON.stringify(body);
    const known = await w.post(path, body, unknown);
    assert.deepEqual({ status: known.status, error: known.body.error, signed: known.signed }, { status: 404, error: 'peer_unknown_job', signed: true }, path);
    await w.verified(known);
    const attempt = (change, options) => {
      const payload = { ...w.payloadFor(path, text, unknown), ...change };
      return w.send(path, { text: options?.text ?? text, header: w.headerFor(payload), payload });
    };
    const refusals = [
      ['peer_expired', 408, true, attempt({ expiresAt: NOW })],
      ['peer_request_mismatch', 401, true, attempt({ path: path === PATHS.state ? PATHS.commitments : PATHS.state })],
      ['peer_request_mismatch', 401, true, attempt({}, { text: JSON.stringify({ ...body, extra: 1 }) })],
      ['peer_envelope_invalid', 401, false, attempt({ method: 'GET' })],
      ['peer_audience_wrong', 401, false, attempt({ seller: `${CLAIM_PREFIX}${derive('another-seller')}` })],
      ['peer_listing_mismatch', 409, true, attempt({ listingPin: { ...PIN, version: PIN.version + 1 } })],
    ];
    for (const [error, status, signed, pending] of refusals) {
      const answer = await pending;
      assert.deepEqual({ status: answer.status, error: answer.body.error, signed: answer.signed }, { status, error, signed }, `${path} ${error}`);
    }
  }
  assert.equal(w.effects(), 0, 'no refusal reached the agent');
  assert.deepEqual(w.rows(), { peer_effects: 0, peer_nonces: 0, peer_jobs: 0, peer_slots: 0, kit_purchase_profiles: 0 }, 'nothing was reserved or kept');
  const initial = await proposeJob(w, 't13-initial');
  assert.equal((await initial.post()).status, 200, 'an initial proposal is not an unknown job');
});

// The base's no-write exchange check (`authorizeWireRequest`) scopes a delegation to a retained Agreement, which an
// unknown job has none of: the delegated variants of T13 cannot be exchange-checked and are refused, never answered.
test('P11a1-T13 (delegated variants): a delegated request for a job the seller holds nothing for is refused peer_delegation_agreement_required, never answered or reserved', async (t) => {
  const w = await world(t);
  for (const path of [PATHS.state, PATHS.commitments]) {
    const unknown = { jobId: jobFor(`t13-delegated-${path}`), agreementHash: derive(`t13-delegated-hash-${path}`) };
    const text = JSON.stringify(path === PATHS.state ? identityBody(unknown.jobId, unknown.agreementHash) : { jobId: unknown.jobId });
    for (const expiresAt of [NOW + 3_600_000, NOW - 1]) {
      const delegation = w.delegationFor({ jobId: unknown.jobId, expiresAt });
      const delegated = await w.send(path, { text, header: w.headerFor(w.payloadFor(path, text, unknown), { signer: SESSION, delegation }) });
      assert.deepEqual({ status: delegated.status, error: delegated.body.error }, { status: 409, error: 'peer_delegation_agreement_required' }, `${path} (delegation expiring at ${expiresAt})`);
    }
  }
  assert.equal(w.effects(), 0);
  assert.deepEqual(w.rows(), { peer_effects: 0, peer_nonces: 0, peer_jobs: 0, peer_slots: 0, kit_purchase_profiles: 0 });
});

test('P11a1-T17: a connection changed after binding makes response signing refuse with zero signer calls', async (t) => {
  const w = await world(t);
  const job = await proposeJob(w, 't17');
  w.agent.onWork = () => { w.state.connection = { ...TEST_CONNECTION, connectionId: 'another-connection' }; };
  const answered = await job.post();
  assert.deepEqual({ status: answered.status, error: answered.body.error, signed: answered.signed }, { status: 503, error: 'operation_uncertain', signed: false });
  assert.equal(w.signing.calls, 0, 'the signer was never asked');
  w.state.connection = { ...TEST_CONNECTION };
  const retried = await job.post();
  assert.equal(retried.status, 200, 'the stored answer is signed once the connection is the bound one');
  assert.equal(w.agent.calls.proposals, 1, 'the effect was not run again');
});

test('P11a1-T18: a wire refusal keeps its code and status; a request naming another seller is answered unsigned', async (t) => {
  const w = await world(t);
  const job = await proposeJob(w, 't18');
  w.state.ready = false;
  const notReady = await job.post();
  assert.deepEqual({ status: notReady.status, error: notReady.body.error, signed: notReady.signed }, { status: 503, error: 'seller_not_ready', signed: true });
  await w.verified(notReady);
  w.state.ready = true;
  const text = JSON.stringify(job.body);
  const wrongListing = w.payloadFor(PATHS.proposals, text, { jobId: job.jobId, agreementHash: job.agreementHash, listingPin: { ...PIN, version: PIN.version + 1 } });
  const refused = await w.send(PATHS.proposals, { text, header: w.headerFor(wrongListing), payload: wrongListing });
  assert.deepEqual({ status: refused.status, error: refused.body.error, signed: refused.signed }, { status: 409, error: 'peer_listing_mismatch', signed: true });
  const mismatched = w.payloadFor(PATHS.proposals, text, { jobId: job.jobId, agreementHash: derive('another-agreement') });
  const agreement = await w.send(PATHS.proposals, { text, header: w.headerFor(mismatched), payload: mismatched });
  assert.equal(agreement.status, 409);
  assert.notEqual(agreement.body.error, 'operation_uncertain');
  const another = w.payloadFor(PATHS.proposals, text, { jobId: job.jobId, agreementHash: job.agreementHash, seller: `${CLAIM_PREFIX}${derive('seller-two')}` });
  const unsigned = await w.send(PATHS.proposals, { text, header: w.headerFor(another) });
  assert.deepEqual({ status: unsigned.status, error: unsigned.body.error, signed: unsigned.signed }, { status: 401, error: 'peer_audience_wrong', signed: false });
  assert.equal(w.signing.calls, 3, 'the three signed refusals each asked the signer once; the unsigned one never did');
  assert.equal(w.effects(), 0);
  // An initial proposal whose draft cannot be derived is refused by the seller's own check, after the exchange checks that come first.
  const plan = job.body.proposal.plan;
  const undrivable = { ...job.body, proposal: { ...job.body.proposal, plan: { ...plan, draft: {} } } }, undrivableText = JSON.stringify(undrivable);
  const invalid = await w.post(PATHS.proposals, undrivable, { jobId: job.jobId, agreementHash: job.agreementHash });
  assert.deepEqual({ status: invalid.status, error: invalid.body.error, signed: invalid.signed }, { status: 422, error: 'peer_proposal_invalid', signed: true });
  const expiredPayload = w.payloadFor(PATHS.proposals, undrivableText, { jobId: job.jobId, agreementHash: job.agreementHash, expiresAt: NOW });
  const expired = await w.send(PATHS.proposals, { text: undrivableText, header: w.headerFor(expiredPayload), payload: expiredPayload });
  assert.deepEqual({ status: expired.status, error: expired.body.error }, { status: 408, error: 'peer_expired' }, 'the prefix refusal keeps its own code');
  assert.equal(w.effects(), 0);
});

test('P11a1-T19: signed reads never account or complete, including at old store capacity and after restart', async (t) => {
  // The shared record count includes accounted rows: the accounted proposal takes one slot, two old-store reserves the others.
  const w = await world(t, { maxRecords: 3 });
  const job = await proposeJob(w, 't19');
  assert.equal((await job.post()).status, 200);
  assert.equal(accountingRows(w).length, 1);
  for (const path of [PATHS.commitments, PATHS.commitmentSignature]) {
    const payload = w.payloadFor(path, '{}', { jobId: job.jobId, agreementHash: job.agreementHash });
    w.handle.store.reserve(payload, {}, { keepProfile: payload.profile });
  }
  const full = w.payloadFor(PATHS.payments, '{}', { jobId: job.jobId, agreementHash: job.agreementHash });
  assert.throws(() => w.handle.store.reserve(full, {}, { keepProfile: full.profile }), { code: 'peer_store_capacity' });
  const filesBefore = w.journalFiles(), accountedBefore = accountingRows(w);
  const storeCalls = { reserve: 0, classify: 0, finish: 0, reconcile: 0, resume: 0 };
  const watchStore = () => { for (const name of Object.keys(storeCalls)) { const method = w.handle.store[name].bind(w.handle.store); w.handle.store[name] = (...args) => { storeCalls[name]++; return method(...args); }; } };
  watchStore();
  const state = (jobId, agreementHash, options) => w.post(PATHS.state, identityBody(jobId, agreementHash), { jobId, agreementHash, ...options });
  const unknownJob = jobFor('t19-unknown');
  const scenarios = [
    ['a known job', () => state(job.jobId, job.agreementHash), 200],
    ['an unknown job', () => state(unknownJob, derive('t19')), 404],
    ['a live delegation', () => state(job.jobId, job.agreementHash, { delegation: w.delegationFor({ jobId: job.jobId, expiresAt: job.deadline }), signer: SESSION }), 200],
    ['an expired delegation read back', () => state(job.jobId, job.agreementHash, { delegation: w.delegationFor({ jobId: job.jobId, expiresAt: NOW - 1 }), signer: SESSION }), 200],
    ['a restart', () => state(job.jobId, job.agreementHash), 200, () => { w.reopen(); watchStore(); }],
  ];
  for (const [label, run, status, beforeRequest] of scenarios) {
    beforeRequest?.();
    const rowsBefore = w.rows(), callsBefore = { ...storeCalls };
    let answer;
    const statements = (await statementsDuring(async () => { answer = await run(); })).filter((sql) => MUTATING.test(sql));
    assert.equal(answer.status, status, label);
    assert.deepEqual(statements, [], `${label}: the old store saw no writing statement`);
    assert.deepEqual(w.rows(), rowsBefore, `${label}: no row changed`);
    assert.deepEqual(storeCalls, callsBefore, `${label}: no reserve, classify, finish, reconcile or resume call`);
    await w.verified(answer);
  }
  assert.deepEqual(w.journalFiles(), filesBefore, 'reads publish nothing');
  assert.deepEqual(accountingRows(w), accountedBefore, 'reads account nothing');
});

test('one tuple gate on every wire route: a job the agent holds with no kept tuple, with no store row or a row from before tuples were kept, is refused tp1_purchase_profile_mismatch, signed, with no agent call and nothing written, also after restart and under a delegation; a fresh proposal keeps exactly one tuple and a job with its tuple is answered', async (t) => {
  const w = await world(t, { commitOnSignature: true });
  const kept = await proposeJob(w, 'gate-kept');
  assert.equal((await kept.post()).status, 200);
  assert.equal(w.rows().kit_purchase_profiles, 1, 'the fresh proposal kept exactly one tuple');
  const rowless = await proposeJob(w, 'gate-rowless'), legacy = await proposeJob(w, 'gate-legacy');
  // The agent holds both jobs while the store keeps no tuple for them: one has no store row, one was reserved before tuples were kept.
  const legacyRequest = (await w.buyerWire.signRequest(PATHS.proposals, legacy.body, { jobId: legacy.jobId, agreementHash: legacy.agreementHash })).payload;
  w.handle.store.finish(w.handle.store.reserve(legacyRequest, legacy.body), 200, '{}', {});
  for (const job of [rowless, legacy]) await w.agent.receiveProposal(job.body);
  const routes = [[PATHS.proposals, (job) => job.body], [PATHS.state, (job) => identityBody(job.jobId, job.agreementHash)], [PATHS.commitments, (job) => ({ jobId: job.jobId })], [PATHS.commitmentSignature, (job) => ({ jobId: job.jobId })]];
  // The continuing routes hold a job through the real agent's commitment: P11a1-T27 covers their gate.
  assert.deepEqual([...routes.map(([path]) => path), ...CONTINUING, PATHS.bundleBuyerCopy], [...WIRE_ROUTE_PATHS], 'every wire route is covered');
  const delegated = (job) => ({ delegation: w.delegationFor({ jobId: job.jobId, expiresAt: job.deadline }), signer: SESSION });
  for (const reopen of [false, true]) {
    if (reopen) w.reopen();
    for (const job of [rowless, legacy]) for (const [path, bodyOf] of routes) for (const options of [{}, delegated(job)]) {
      const label = `${path}, ${job === rowless ? 'no store row' : 'a row with no tuple'}${options.delegation ? ', delegated' : ''}${reopen ? ', after restart' : ''}`;
      const rowsBefore = w.rows(), effectsBefore = w.effects();
      const refused = await w.post(path, bodyOf(job), { jobId: job.jobId, agreementHash: job.agreementHash, ...options });
      assert.deepEqual({ status: refused.status, error: refused.body.error, signed: refused.signed }, { status: 500, error: 'tp1_purchase_profile_mismatch', signed: true }, label);
      await w.verified(refused);
      assert.equal(w.effects(), effectsBefore, `${label}: no agent call`);
      assert.deepEqual(w.rows(), rowsBefore, `${label}: nothing written`);
    }
    assert.equal((await w.post(PATHS.state, identityBody(kept.jobId, kept.agreementHash), { jobId: kept.jobId, agreementHash: kept.agreementHash })).status, 200, 'a job with its kept tuple is answered');
  }
  assert.deepEqual([rowless, legacy].map((job) => w.handle.store.purchaseProfile(job.jobId)), [null, null], 'no refused request kept a tuple');
});

test('with commitOnSignature, commitments/signature is a wire route: a signed request is answered signed, a job the seller holds nothing for gets the signed 404, and a replay is answered from the cache', async (t) => {
  const w = await world(t, { commitOnSignature: true });
  const job = await proposeJob(w, 'signature-route');
  assert.equal((await job.post()).status, 200);
  const signed = await w.buyerWire.signRequest(PATHS.commitmentSignature, { jobId: job.jobId }, { jobId: job.jobId, agreementHash: job.agreementHash });
  const first = await w.send(PATHS.commitmentSignature, signed);
  assert.deepEqual({ status: first.status, body: first.body }, { status: 200, body: { status: 'committed', jobId: job.jobId } });
  await w.verified(first);
  const calls = w.agent.calls.signatureCommits;
  assert.equal((await w.send(PATHS.commitmentSignature, signed)).body.error, 'peer_request_replayed');
  const replay = await w.post(PATHS.commitmentSignature, { jobId: job.jobId }, { jobId: job.jobId, agreementHash: job.agreementHash });
  assert.equal(replay.status, 200);
  await w.verified(replay);
  assert.equal(w.agent.calls.signatureCommits, calls, 'the replay ran no second commitment');
  const unknown = jobFor('signature-unknown');
  const missing = await w.post(PATHS.commitmentSignature, { jobId: unknown }, { jobId: unknown, agreementHash: derive('signature-unknown') });
  assert.deepEqual({ status: missing.status, error: missing.body.error, signed: missing.signed }, { status: 404, error: 'peer_unknown_job', signed: true });
  await w.verified(missing);
  const unmounted = await world(t, { commitOnSignature: false });
  const off = await unmounted.post(PATHS.commitmentSignature, { jobId: unknown }, { jobId: unknown, agreementHash: derive('signature-unknown') });
  assert.deepEqual({ status: off.status, error: off.body.error, signed: off.signed }, { status: 404, error: 'not_found', signed: false }, 'without commitOnSignature the route is not mounted');
});

test('a fenced settlement whose answer the wire cannot sign is refused outgoing_body_rejected, signed, and its effect stays uncertain: a retry reconciles instead of running again', async (t) => {
  const w = await world(t);
  const job = await proposeJob(w, 'fenced-unsignable');
  w.agent.fenced = null;
  const refused = await job.post();
  assert.deepEqual({ status: refused.status, error: refused.body.error, signed: refused.signed }, { status: 500, error: 'outgoing_body_rejected', signed: true });
  await w.verified(refused);
  const db = new DatabaseSync(w.storePath, { readonly: true });
  try { assert.deepEqual(db.prepare("SELECT state FROM peer_effects WHERE state = 'complete'").all(), [], 'the unsignable answer is no terminal entry'); } finally { db.close(); }
  w.agent.fenced = undefined;
  const proposals = w.agent.calls.proposals;
  w.state.time += JOURNAL_LEASE_MS;
  const retried = await job.post();
  assert.equal(retried.status, 200);
  assert.deepEqual({ proposals: w.agent.calls.proposals, reconciled: w.agent.calls.reconciled }, { proposals, reconciled: 1 }, 'the retry reconciled the uncertain effect');
});

test('the wire context is checked where it is made and where the handler takes it: a member of the wrong kind, an unbranded copy, another delegation rule and another seller are each refused', async (t) => {
  const w = await world(t);
  const { binding, signer, journal, store, readCommitmentReceipt } = w.handle.wire;
  const valid = { binding, tp1Network: { connection: () => ({ ...TEST_CONNECTION }) }, signer, journal, store, ready: () => true, now: w.clock, agent: w.agent, requireDelegation: false, readCommitmentReceipt };
  const wrongKinds = { connection: { tp1Network: { connection: 1 } }, ready: { ready: 'yes' }, now: { now: NOW }, signer: { signer: { claim: seller.claim } }, store: { store: {} },
    agent: { agent: {} }, continuationEvidence: { agent: { transportAgreementOf: () => null } }, readCommitmentReceipt: { readCommitmentReceipt: 'reader' },
    requireDelegation: { requireDelegation: 'no' }, binding: { binding: null }, journal: { journal: undefined } };
  for (const [label, change] of Object.entries(wrongKinds)) assert.throws(() => createWireContext({ ...valid, ...change }), TypeError, label);
  const handlerWith = (wire, authentication = w.handle.authentication) => createSellerHttpHandler(w.agent, { authentication, wire });
  assert.throws(() => handlerWith({ ...w.handle.wire }), /createWireContext/, 'an unbranded copy');
  const delegated = createSellerTransportServerAuth({ sellerSigner: SELLER, listingPin: PIN, store, now: w.clock, requireDelegation: true });
  assert.throws(() => handlerWith(w.handle.wire, delegated), /same seller and delegation rule/, 'another delegation rule');
  assert.throws(() => handlerWith(createWireContext({ ...valid, signer: BUYER })), /same seller and delegation rule/, 'another seller');
  assert.throws(() => createSellerHttpHandler(w.agent, { wire: w.handle.wire }), /old authentication/, 'no old authentication');
  assert.doesNotThrow(() => handlerWith(createWireContext(valid)));
});

test('the handler takes a wire context only for its own agent and for the transport store its old authentication journals in', async (t) => {
  const w = await world(t);
  const { binding, signer, journal, store, readCommitmentReceipt } = w.handle.wire;
  const valid = { binding, tp1Network: { connection: () => ({ ...TEST_CONNECTION }) }, signer, journal, store, ready: () => true, now: w.clock, agent: w.agent, requireDelegation: false, readCommitmentReceipt };
  const handlerWith = (wire, { agent = w.agent, authentication = w.handle.authentication } = {}) => createSellerHttpHandler(agent, { authentication, wire });
  const MADE_FOR = /handler's agent and the old authentication's transport store/;
  const otherStore = async (seller_ = seller.claim) => {
    const directory = await mkdtemp(join(tmpdir(), 'TEST-wire-other-store-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    mkdirSync(join(directory, 'transport'), { mode: 0o700 });
    const other = createSellerTransportStore({ path: join(directory, 'transport', 'transport.sqlite'), now: w.clock });
    t.after(() => other.close());
    if (seller_ !== null) other.bind({ seller: seller_, listingPin: PIN });
    return other;
  };
  assert.throws(() => handlerWith(createWireContext({ ...valid, agent: stubAgent() })), MADE_FOR, 'a context made for another agent');
  assert.throws(() => handlerWith(w.handle.wire, { agent: stubAgent() }), MADE_FOR, 'a handler for another agent');
  const [elsewhere, foreign, unbound] = [await otherStore(), await otherStore(buyer.claim), await otherStore(null)];
  assert.throws(() => handlerWith(createWireContext({ ...valid, store: elsewhere })), MADE_FOR, 'another transport store');
  assert.throws(() => handlerWith(createWireContext({ ...valid, store: foreign })), MADE_FOR, 'a store bound to another seller');
  assert.throws(() => handlerWith(createWireContext({ ...valid, store: unbound })), MADE_FOR, 'a store bound to no seller');
  assert.throws(() => handlerWith(w.handle.wire, { authentication: { ...w.handle.authentication } }), MADE_FOR, 'a copy of the old authentication');
  const own = await otherStore();
  const ownAuthentication = createSellerTransportServerAuth({ sellerSigner: SELLER, listingPin: PIN, store: own, now: w.clock });
  assert.throws(() => handlerWith(w.handle.wire, { authentication: ownAuthentication }), MADE_FOR, 'an old authentication over another store');
  assert.doesNotThrow(() => handlerWith(createWireContext({ ...valid, store: own }), { authentication: ownAuthentication }), 'a context and an authentication over the same other store');
  const context = createWireContext(valid);
  assert.doesNotThrow(() => { handlerWith(context); handlerWith(context); }, 'two handlers of one agent on one context');
});

test('a context made for one agent never authorizes a request another agent serves: the handler is refused before the other agent is called', async (t) => {
  const w = await world(t);
  const job = await proposeJob(w, 'mismatched-agent');
  assert.equal((await job.post()).status, 200);
  const other = stubAgent();
  assert.throws(() => createSellerHttpHandler(other, { authentication: w.handle.authentication, wire: w.handle.wire }), /handler's agent/);
  assert.equal(w.effects(other.calls), 0, 'the other agent was never called');
  assert.equal(other.transportAgreementOf(job.jobId), null, 'the other agent holds nothing for the job');
  const state = await w.post(PATHS.state, identityBody(job.jobId, job.agreementHash), { jobId: job.jobId, agreementHash: job.agreementHash });
  assert.equal(state.status, 200, 'the agent the context was made for still serves it');
  assert.equal(w.agent.calls.states, 1);
});

test('P11a1-T20: the harness\'s old-domain proposal is refused; only the wire domain is accepted', async (t) => {
  const w = await world(t);
  const job = await proposeJob(w, 't20');
  const old = createSellerTransportClientAuth({ buyerSigner: BUYER, seller: seller.claim, resolveJob: () => ({ listingPin: PIN, agreementHash: job.agreementHash }), now: w.clock });
  const text = JSON.stringify(job.body);
  const { header } = await old.request(PATHS.proposals, job.body, text);
  const refused = await w.send(PATHS.proposals, { text, header });
  assert.deepEqual({ status: refused.status, signed: refused.signed }, { status: 409, signed: false });
  assert.equal(refused.body.error, 'tp1_profile_missing');
  assert.equal(w.effects(), 0);
  assert.equal((await job.post()).status, 200, 'the same body under the wire domain is accepted');
});

test('P11a1-T21: with the shipped guard off, the host refuses and the handler\'s effect entries refuse as P51 defines', () => {
  const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
  const script = `const { createSellerHttpHandler } = await import('./src/dacs/seller-http.mjs');
    const { startSellerHost } = await import('./src/host.mjs');
    const refusal = async (work) => { try { await work(); return null; } catch (error) { return error.code; } };
    console.log(JSON.stringify([await refusal(() => createSellerHttpHandler({}, { wire: {} })), await refusal(() => startSellerHost({}))]));`;
  const withoutFixture = (process.env.NODE_OPTIONS ?? '').split(' ').filter((option) => option !== '' && !option.includes('kit-guard-fixture.mjs')).join(' ');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: packageDirectory, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: withoutFixture } });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim().split('\n').at(-1)), ['kit_operation_guard_off', 'kit_operation_guard_off']);
});

test('P11a1-T23: through the exported kit client, with response verification paused, no answer or downstream action is available; released, a valid response succeeds; a bad signature, another profile, a mismatched body or status and a refusing authority reader each fail as response authentication; verification past the client timeout fails timeout, and its late result releases nothing', async (t) => {
  const w = await world(t);
  const job = await proposeJob(w, 't23');
  const stateBody = identityBody(job.jobId, job.agreementHash);
  assert.equal((await job.post()).status, 200);
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  /** A fetch that answers through the handler, then lets `alter` change what the client receives. */
  const fetchThrough = (alter = (answer) => answer) => async (url, { headers, body }) => {
    const answer = alter(await w.send(new URL(url).pathname, { text: body, header: headers[SELLER_TRANSPORT_HEADER] }));
    return new Response(answer.text, { status: answer.status, headers: { 'content-type': 'application/json', [SELLER_TRANSPORT_HEADER]: answer.header ?? '' } });
  };
  const authentication = (verify) => ({ ...w.buyerWire.authentication(() => job.agreementHash), ...(verify ? { verifyResponse: verify } : {}) });
  const clientWith = ({ alter, verify, timeoutMs } = {}) => createSellerAgentClient({ url: 'http://127.0.0.1:1', fetchImpl: fetchThrough(alter), authentication: authentication(verify), ...(timeoutMs ? { timeoutMs } : {}) });
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  let release;
  const paused = clientWith({ verify: () => new Promise((resolve) => { release = resolve; }) });
  let settled = false;
  const pending = paused.agreementState(stateBody.transportIdentity).finally(() => { settled = true; });
  await flush(); await flush();
  assert.equal(settled, false, 'nothing is available while verification is paused');
  release({ principal: seller.claim });
  assert.equal((await pending).jobId, job.jobId, 'released, the valid answer is returned');
  assert.equal((await clientWith().agreementState(stateBody.transportIdentity)).jobId, job.jobId);

  const flipped = (header) => `${header.slice(0, -4)}${header.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;
  const hostile = {
    'a bad signature': (answer) => ({ ...answer, header: flipped(answer.header) }),
    'another profile': (answer) => { const envelope = JSON.parse(Buffer.from(answer.header, 'base64url')); envelope.payload.profile.pinVersion = OLD_PIN_VERSION; return { ...answer, header: Buffer.from(canonicalize(envelope)).toString('base64url') }; },
    'a mismatched body': (answer) => ({ ...answer, text: JSON.stringify({ ...answer.body, jobId: 'another' }) }),
    'a mismatched status': (answer) => ({ ...answer, status: 201 }),
  };
  for (const [label, alter] of Object.entries(hostile)) {
    await assert.rejects(clientWith({ alter }).agreementState(stateBody.transportIdentity), { code: 'seller_unavailable', causeCode: 'response-auth' }, label);
  }
  // The seller has answered when `alter` runs, so the next authority read is the client's own verification.
  const refusing = clientWith({ alter: (answer) => { w.state.withdrawAtRead = w.state.authorityReads + 1; return answer; } });
  await assert.rejects(refusing.agreementState(stateBody.transportIdentity), { code: 'seller_unavailable', causeCode: 'response-auth' }, 'a refusing authority reader');
  w.state.withdrawAtRead = null;

  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());
  const clientTimeoutMs = 5_000;
  let late;
  const slow = clientWith({ timeoutMs: clientTimeoutMs, verify: () => new Promise((resolve) => { late = resolve; }) });
  const timing = assert.rejects(slow.agreementState(stateBody.transportIdentity), { code: 'seller_unavailable', causeCode: 'timeout' });
  await flush();
  mock.timers.tick(clientTimeoutMs + 1);
  await timing;
  late({ principal: seller.claim });
  await flush();
  assert.deepEqual(unhandled, [], 'no rejection is left unhandled');
});

test('P11a1-T25: with maxJobs 3 full, ready true and spare reservation capacity, many valid fresh-job proposals are each refused with the tuple count unchanged, also after restart; an admitted proposal keeps exactly one tuple before the agent runs', async (t) => {
  const w = await world(t, { maxJobs: 3 });
  const kept = [];
  w.agent.onWork = (kind, body) => kept.push(w.handle.store.purchaseProfile(body.transportIdentity.jobId));
  for (const label of ['a', 'b', 'c']) assert.equal((await (await proposeJob(w, `t25-${label}`)).post()).status, 200);
  assert.deepEqual(kept.map((profile) => profile !== null), [true, true, true], 'each admitted proposal had its tuple before the agent ran');
  assert.equal(w.rows().kit_purchase_profiles, 3);
  for (const restart of [false, true]) {
    if (restart) w.reopen();
    for (let index = 0; index < 5; index++) {
      const refused = await (await proposeJob(w, `t25-fresh-${restart}-${index}`)).post();
      assert.deepEqual({ status: refused.status, error: refused.body.error }, { status: 503, error: 'peer_job_capacity' });
    }
    assert.equal(w.rows().kit_purchase_profiles, 3, `the tuple count is unchanged (restart: ${restart})`);
  }
  assert.equal(w.agent.calls.proposals, 3);
});


/** The authority reads a request makes before its agent runs: its last one is the final recheck before the reservation. */
async function readsBeforeAgent(w, run) {
  const start = w.state.authorityReads;
  let atAgent = null;
  w.agent.onWork = () => { atAgent = w.state.authorityReads; };
  await run();
  w.agent.onWork = () => {};
  return atAgent - start;
}

test('wire-proposal-commitment-final-authorization-barrier', async (t) => {
  const w = await world(t, { readAuthority: authorityReader() });
  const committed = async (label) => { const job = await proposeJob(w, label); assert.equal((await job.post()).status, 200); return job; };
  const routes = {
    proposals: async (label) => { const job = await proposeJob(w, label); return () => job.post(); },
    commitments: async (label) => { const job = await committed(label); return () => w.post(PATHS.commitments, { jobId: job.jobId }, { jobId: job.jobId, agreementHash: job.agreementHash }); },
  };
  for (const [route, prepare] of Object.entries(routes)) {
    const probe = await prepare(`barrier-${route}-probe`);
    const readsToAgent = await readsBeforeAgent(w, async () => assert.equal((await probe()).status, 200));
    const withdrawn = await prepare(`barrier-${route}-withdrawn`), expired = await prepare(`barrier-${route}-expired`);
    const rowsBefore = w.rows(), callsBefore = { ...w.agent.calls };
    // The request makes the same reads as the probe up to the agent; its last one is the recheck's, after body checks and just before the reservation.
    w.state.withdrawAtRead = w.state.authorityReads + readsToAgent;
    const authority = await withdrawn();
    w.state.withdrawAtRead = null;
    assert.ok(authority.status >= 400, `${route}: authority withdrawn before the reservation is refused (${authority.status})`);
    // The time the admission has spent (the wire counts it from its start) passes the request's expiry at its last authority read.
    w.state.lapseAtRead = w.state.authorityReads + readsToAgent;
    const lapsed = await expired();
    w.state.lapseAtRead = null;
    assert.deepEqual({ status: lapsed.status, error: lapsed.body.error }, { status: 408, error: 'peer_expired' }, `${route}: expiry between admission and reservation`);
    for (const reopened of [false, true]) {
      if (reopened) w.reopen();
      assert.equal(w.rows().peer_effects, rowsBefore.peer_effects, `${route}: no old effect (reopened: ${reopened})`);
      assert.ok(accountingRows(w).filter(row => row.state === 'refused').length >= 2, 'late refusals retain their charges');
      assert.deepEqual(w.agent.calls, callsBefore, `${route}: no agent work`);
    }
  }
});

test('wire-proposal-commitment-effect-before-finish', async (t) => {
  const w = await world(t);
  for (const route of ['proposals', 'commitments']) {
    w.state.time = NOW;
    const job = await proposeJob(w, `before-finish-${route}`);
    const first = route === 'proposals' ? () => job.post() : () => w.post(PATHS.commitments, { jobId: job.jobId }, { jobId: job.jobId, agreementHash: job.agreementHash });
    if (route === 'commitments') assert.equal((await job.post()).status, 200);
    const counter = route === 'proposals' ? 'proposals' : 'commits';
    const worked = w.agent.calls[counter], reconciledBefore = w.agent.calls.reconciled;
    w.agent.retains = route === 'proposals';
    w.handle.finishFails = true;
    const cut = await first();
    assert.ok(cut.status >= 500, `${route}: the cut request is not answered as done`);
    assert.equal(w.agent.calls[counter], worked + 1, `${route}: the agent retained its work`);
    w.reopen();
    w.state.time += JOURNAL_LEASE_MS;
    const resumed = await first();
    assert.equal(resumed.status, 200, `${route}: the retried request is answered`);
    assert.equal(w.agent.calls.reconciled, reconciledBefore + 1, `${route}: the retained work was reconciled`);
    assert.equal(w.agent.calls[counter], worked + 1, `${route}: no second signature or CREATE`);
    await w.verified(resumed);
  }
});

test('wire-stored-answer-lost-response', async (t) => {
  const w = await world(t);
  const original = JSON.stringify({ disposition: 'complete', contribution: { signed: true } });
  const job = await proposeJob(w, 'lost-response');
  w.signing.failures = 2;
  const lost = await job.post();
  assert.deepEqual({ status: lost.status, error: lost.body.error, signed: lost.signed }, { status: 503, error: 'operation_uncertain', signed: false });
  const db = new DatabaseSync(w.storePath, { readonly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peer_effects').get().n, 0); } finally { db.close(); }
  assert.equal(inspectWireOperation(w.handle.wire.journal, { seller: seller.claim, jobId: job.jobId, path: PATHS.proposals }).outcome.text, original, 'exact admitted text');
  w.reopen();
  const retried = await job.post();
  assert.deepEqual({ status: retried.status, text: retried.text }, { status: 200, text: original });
  assert.equal((await w.verified(retried)).body.disposition, 'complete');
  assert.equal(w.agent.calls.proposals, 1, 'the completed effect was not run again');
});

test('wire-response-signing-credit-withdrawal', async (t) => {
  const w = await world(t);
  const job = await proposeJob(w, 'credit');
  const withdrawn = new SellerAgentError('settlement_credit_unavailable', 'the settlement credit was withdrawn', 503);
  w.agent.credit = () => { throw withdrawn; };
  const first = await job.post();
  assert.notEqual(first.status, 200, 'success is withheld after signing');
  assert.equal((await job.post()).status, 503, 'a replay is withheld too');
  w.reopen();
  assert.equal(accountingRows(w).filter(row => row.state === 'new').length, 1, 'the operation is retained across restart');
  w.agent.credit = () => {};
  const restored = await job.post();
  assert.equal(restored.status, 200);
  assert.equal(restored.text, JSON.stringify({ disposition: 'complete', contribution: { signed: true } }));
  assert.equal(w.agent.calls.proposals, 1, 'the withheld answer did not become permission to repeat the effect');
});


// P11a1b: real durable continuation artifacts, counting effects and injected clocks.
const CONTINUING = [PATHS.payments, PATHS.bundleRequest, PATHS.bundleCountersignature];
const EFFECTS = [PATHS.proposals, PATHS.commitments, PATHS.commitmentSignature, ...CONTINUING];
async function continuingWorld(t) {
  const fixture = await wireContinuationFixture(t), w = await world(t, { fixture });
  const jobId = fixture.agreement.jobId, agreementHash = fixture.request.transportIdentity.agreementHash;
  const bodyFor = (path) => path === PATHS.proposals ? fixture.request : path === PATHS.state ? identityBody(jobId, agreementHash)
    : path === PATHS.payments ? { jobId, txHash: derive('continuing-payment'), payerPayingKey: buyer.claim }
      : path === PATHS.commitmentSignature ? { jobId, agreement: fixture.agreement, signedProjection: {} } : { jobId };
  const post = (path, options = {}) => w.post(path, bodyFor(path), { jobId, agreementHash, ...options });
  const first = await post(PATHS.proposals);
  assert.equal(first.status, 200, first.text);
  return { ...w, fixture, jobId, agreementHash, bodyFor, request: post };
}
const assertRefusedWithoutWork = async (w, path, work, code) => {
  const before = w.rows(), calls = { ...w.agent.calls };
  const answer = await work();
  assert.equal(answer.body.error, code, `${path}: ${JSON.stringify(answer.body)}`);
  assert.deepEqual(w.rows(), before, 'no journal or tuple changes');
  assert.deepEqual(w.agent.calls, calls, 'no agent effects');
  return answer;
};

const BARRIER_REQUEST_MS = 10;
/**
 * The final recheck in the deferred wire reservation, after accounting commits. `send` makes one request that expires
 * BARRIER_REQUEST_MS after the check starts; time passes at that request's last authority read before the reservation. One
 * millisecond short of the expiry it is answered, at the expiry it is refused `peer_expired`, and a withdrawn authority there
 * keeps its own code; both stay charged without publishing or reaching the agent.
 */
async function assertFinalBarrier(w, path, send) {
  const start = w.state.authorityReads;
  assert.equal((await send()).status, 200, `${path}: the unpaused request is answered`);
  const readsToReservation = w.state.readsAtReserve - start;
  w.state.lapseMs = BARRIER_REQUEST_MS - 1;
  w.state.lapseAtRead = w.state.authorityReads + readsToReservation;
  assert.equal((await send()).status, 200, `${path}: 1 ms before the expiry`);
  w.state.lapseMs = BARRIER_REQUEST_MS;
  w.state.lapseAtRead = w.state.authorityReads + readsToReservation;
  await assertRefusedWithoutWork(w, path, send, 'peer_expired');
  w.state.lapseAtRead = null;
  w.state.withdrawAtRead = w.state.authorityReads + readsToReservation;
  await assertRefusedWithoutWork(w, path, send, 'tp1_participant_refused');
  w.state.withdrawAtRead = null;
}

test('P11a1-T01: every non-pre-Agreement route answers with a wire response envelope carrying the bound profile, which the buyer verifies', async (t) => {
  const w = await continuingWorld(t);
  for (const path of [PATHS.proposals, PATHS.state, PATHS.commitments, PATHS.commitmentSignature, ...CONTINUING, PATHS.bundleBuyerCopy]) {
    const answer = await w.request(path);
    assert.equal(answer.status, 200, path);
    await w.verified(answer);
    assert.deepEqual(JSON.parse(Buffer.from(answer.header, 'base64url')).payload.profile, w.buyerWire.binding.profile);
  }
  assert.equal(w.journalFiles().filter(name => name.startsWith('k-')).length, EFFECTS.length + 1);
});

test('P11a1-T02: an old-domain request on any wire route is refused unsigned with zero agent calls; a wire request on the old-auth context route is refused, never downgraded', async (t) => {
  const w = await continuingWorld(t);
  const old = createSellerTransportClientAuth({ buyerSigner: BUYER, seller: seller.claim, now: w.clock,
    resolveJob: () => ({ listingPin: w.agent.listingPin, agreementHash: w.agreementHash }) });
  for (const path of [PATHS.proposals, PATHS.state, PATHS.commitments, PATHS.commitmentSignature, ...CONTINUING, PATHS.bundleBuyerCopy]) {
    const text = JSON.stringify(w.bodyFor(path)), signed = await old.request(path, w.bodyFor(path), text);
    const calls = { ...w.agent.calls };
    const answer = await w.send(path, { text, ...signed });
    assert.equal(answer.signed, false, path);
    assert.ok(answer.status >= 400, path);
    assert.deepEqual(w.agent.calls, calls);
  }
  const { world: legacyWorld, JOBS } = await import('./helpers/d5-http-fixture.mjs');
  const legacy = await legacyWorld(t), request = await legacy.wire({ jobId: JOBS[0] });
  const signed = await w.buyerWire.signRequest(PATHS.context, JSON.parse(request.text), { jobId: w.jobId, agreementHash: w.agreementHash });
  const reply = await exchange(legacy.handler, { url: PATHS.context, text: signed.text, header: signed.header });
  assert.ok(reply.status >= 400);
  assert.equal(reply.headers?.[SELLER_TRANSPORT_HEADER], undefined);
});

test('P11a1-T09: an expired delegation is answered as readback on the state route and refused on every effect route with zero store rows', async (t) => {
  const w = await continuingWorld(t), delegation = w.delegationFor({ jobId: w.jobId, expiresAt: w.fixture.agreement.terms.deadline });
  w.state.time = delegation.payload.expiresAt;
  for (const path of EFFECTS) {
    const text = JSON.stringify(w.bodyFor(path)), payload = w.payloadFor(path, text, { jobId: w.jobId, agreementHash: w.agreementHash, expiresAt: w.clock() + 1000 });
    await assertRefusedWithoutWork(w, path, () => w.send(path, { text, payload, header: w.headerFor(payload, { signer: SESSION, delegation }) }), 'peer_delegation_expired');
  }
  const readText = JSON.stringify(w.bodyFor(PATHS.state)), payload = w.payloadFor(PATHS.state, readText, { jobId: w.jobId, agreementHash: w.agreementHash, expiresAt: w.clock() + 1000 });
  const read = await w.send(PATHS.state, { text: readText, payload, header: w.headerFor(payload, { signer: SESSION, delegation }) });
  assert.equal(read.status, 200);
  await w.verified(read);
});

test("P11a1-T14: proposal-plan, payment-key and transport-identity substitutions are still refused by the seller's body checks", async (t) => {
  const w = await continuingWorld(t);
  const proposal = structuredClone(w.fixture.request);
  proposal.transportIdentity.planHash = derive('substituted-plan');
  const cases = [[PATHS.proposals, proposal, 'peer_proposal_mismatch'],
    [PATHS.payments, { ...w.bodyFor(PATHS.payments), payerPayingKey: session.claim }, 'peer_payment_mismatch'],
    [PATHS.state, { transportIdentity: { ...w.bodyFor(PATHS.state).transportIdentity, buyer: session.claim } }, 'peer_agreement_mismatch']];
  for (const [path, body, code] of cases) await assertRefusedWithoutWork(w, path, () => w.post(path, body, { jobId: w.jobId, agreementHash: w.agreementHash }), code);
});

test("P11a1-T15: a continuing route without a commitment, with another job's commitment, or with a failing receipt reader is refused with zero agent calls and its cause", async (t) => {
  const w = await continuingWorld(t), evidence = w.agent.continuationEvidenceOf;
  for (const path of CONTINUING) {
    w.agent.continuationEvidenceOf = () => null;
    await assertRefusedWithoutWork(w, path, () => w.request(path), 'peer_agreement_uncommitted');
    w.agent.continuationEvidenceOf = (id) => {
      const texts = evidence(id), commitment = JSON.parse(texts.commitmentText);
      commitment.record.jobId = jobFor('another-job');
      return { ...texts, commitmentText: JSON.stringify(commitment) };
    };
    await assertRefusedWithoutWork(w, path, () => w.request(path), 'continuation_commitment_invalid');
    w.agent.continuationEvidenceOf = evidence;
    const cause = new Error('TEST receipt source timeout');
    const signed = await w.buyerWire.signRequest(path, w.bodyFor(path), { jobId: w.jobId, agreementHash: w.agreementHash });
    w.fixture.controls.verdict = cause;
    const { open } = wireAuthenticator(w.handle.wire, w.agent, w.handle.authentication);
    await assert.rejects(open({ ...signed, method: 'POST', path, rawBody: Buffer.from(signed.text), body: w.bodyFor(path), onOpened() {} }), error => error.code === 'commitment_unverified' && error.cause === cause);
    await assertRefusedWithoutWork(w, path, () => w.request(path), 'commitment_unverified');
    w.fixture.controls.verdict = 'valid';
  }
  const unknownJob = jobFor('t15-unknown');
  const unknownText = JSON.stringify({ jobId: unknownJob, txHash: derive('t15-unknown-payment'), payerPayingKey: buyer.claim });
  const unknownPayload = w.payloadFor(PATHS.payments, unknownText, { jobId: unknownJob, agreementHash: derive('t15-unknown-hash') });
  await assertRefusedWithoutWork(w, PATHS.payments, () => w.send(PATHS.payments, { text: unknownText, payload: unknownPayload, header: w.headerFor(unknownPayload) }), 'peer_agreement_uncommitted');
  const reader = w.handle.wire.readCommitmentReceipt;
  const getter = Object.defineProperty(() => 'valid', 'chainIdentity', { get() { throw new Error('TEST metadata getter must not run'); } });
  for (const [invalid, code] of [[new Proxy(reader, {}), 'commitment_reader_required'], [getter, 'commitment_reader_chain_mismatch']]) {
    await w.withWire({ readCommitmentReceipt: invalid }, () => assertRefusedWithoutWork(w, PATHS.payments, () => w.request(PATHS.payments), code));
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let rejectLate;
  w.fixture.controls.verdict = new Promise((_resolve, reject) => { rejectLate = reject; });
  const calls = w.fixture.controls.calls;
  const pending = assertRefusedWithoutWork(w, PATHS.payments, () => w.request(PATHS.payments), 'commitment_unverified');
  for (let turn = 0; turn < 20 && w.fixture.controls.calls === calls; turn++) await new Promise(setImmediate);
  assert.ok(w.fixture.controls.calls > calls);
  t.mock.timers.tick(10000);
  assert.equal((await pending).status, 503);
  rejectLate(new Error('TEST late receipt failure'));
  await new Promise(setImmediate);
});

test('P11a1-T16: when not ready, new-purchase routes are refused signed while state and payments continue', async (t) => {
  const w = await continuingWorld(t);
  w.state.ready = false;
  const freshWorld = await world(t); freshWorld.state.ready = false;
  const fresh = await proposeJob(freshWorld, 'not-ready-fresh');
  await assertRefusedWithoutWork(freshWorld, PATHS.proposals, () => fresh.post(), 'seller_not_ready');
  assert.equal((await w.request(PATHS.proposals)).status, 200, 'a retained completed proposal remains readable');
  for (const path of [PATHS.commitments, PATHS.commitmentSignature]) {
    const answer = await assertRefusedWithoutWork(w, path, () => w.request(path), 'seller_not_ready');
    assert.equal(answer.signed, true);
  }
  for (const path of [PATHS.state, ...CONTINUING]) {
    const answer = await w.request(path);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    await w.verified(answer);
  }
});

test("P11a1-T24: request and delegation expiry and current authority are rechecked before wire publication, with late refusals charged and no agent effect", async (t) => {
  mock.method(performance, 'now', () => 0);
  const w = await continuingWorld(t);
  for (const path of [PATHS.proposals, PATHS.commitments, PATHS.commitmentSignature, PATHS.payments]) {
    for (const shape of ['direct', 'request-first', 'equal']) {
      const delegation = shape === 'direct' ? undefined : w.delegationFor({ jobId: w.jobId, expiresAt: NOW + (shape === 'equal' ? BARRIER_REQUEST_MS : MAX_SIGNED_LIFETIME_MS) });
      await assertFinalBarrier(w, path, () => {
        const text = JSON.stringify(w.bodyFor(path)), payload = w.payloadFor(path, text, { jobId: w.jobId, agreementHash: w.agreementHash, expiresAt: NOW + BARRIER_REQUEST_MS });
        return w.send(path, { text, payload, header: w.headerFor(payload, { signer: delegation ? SESSION : BUYER, delegation }) });
      });
    }
    for (const time of [NOW, NOW + MAX_SIGNED_LIFETIME_MS / 2]) {
      const delegation = w.delegationFor({ jobId: w.jobId, expiresAt: NOW + MAX_SIGNED_LIFETIME_MS / 3 });
      const text = JSON.stringify(w.bodyFor(path)), payload = w.payloadFor(path, text, { jobId: w.jobId, agreementHash: w.agreementHash, expiresAt: NOW + MAX_SIGNED_LIFETIME_MS });
      w.state.time = time;
      await assertRefusedWithoutWork(w, path, () => w.send(path, { text, payload, header: w.headerFor(payload, { signer: SESSION, delegation }) }), 'peer_delegation_expired');
    }
    w.state.time = NOW;
  }
});

test('wire-bundle-final-authorization-barrier', async (t) => {
  mock.method(performance, 'now', () => 0);
  const w = await continuingWorld(t);
  for (const path of [PATHS.bundleRequest, PATHS.bundleCountersignature]) {
    await assertFinalBarrier(w, path, () => w.request(path, { lifetimeMs: BARRIER_REQUEST_MS }));
  }
});

test("P11a1-T26: payments and the two bundle routes run on the real agent's durable commitment, Agreement and signed Listing, before and after restart. Omitting or corrupting each artifact in turn, or a stale or unavailable receipt, refuses with zero agent effects; a structured-clone control is refused ARTIFACT-NOT-ADMITTED", async (t) => {
  const w = await continuingWorld(t);
  const texts = w.agent.continuationEvidenceOf(w.jobId);
  assert.ok(texts.commitmentText && texts.agreementText);
  assert.equal(w.agent.continuationEvidenceOf(jobFor('missing')), null);
  for (const restarted of [false, true]) {
    if (restarted) { const previousListing = w.fixture.admittedListing; await w.fixture.reopen(); w.reopen(); assert.notEqual(w.fixture.admittedListing, previousListing); }
    assert.deepEqual(w.agent.continuationEvidenceOf(w.jobId), texts);
    for (const path of CONTINUING) {
      const before = w.fixture.controls.calls;
      const answer = await w.request(path);
      assert.equal(answer.status, 200);
      assert.ok(w.fixture.controls.calls > before, 'receipt rechecked each request');
      await w.verified(answer);
      const evidence = w.agent.continuationEvidenceOf;
      for (const key of ['commitmentText', 'agreementText']) {
        for (const value of [undefined, '{', '{}']) {
          w.agent.continuationEvidenceOf = () => ({ ...texts, [key]: value });
          const rows = w.rows(), effects = { ...w.agent.calls };
          const denied = await w.request(path);
          assert.ok(denied.status >= 400, `${path} ${key} ${value}`);
          assert.deepEqual(w.rows(), rows); assert.deepEqual(w.agent.calls, effects);
        }
      }
      w.agent.continuationEvidenceOf = evidence;
      for (const verdict of ['invalid', 'indeterminate', 'error']) {
        w.fixture.controls.verdict = verdict;
        const rows = w.rows(), effects = { ...w.agent.calls };
        assert.ok((await w.request(path)).status >= 400);
        assert.deepEqual(w.rows(), rows); assert.deepEqual(w.agent.calls, effects);
      }
      w.fixture.controls.verdict = 'valid';
      for (const signedListing of [undefined, {}, structuredClone(w.fixture.admittedListing)]) {
        await w.withWire({ signedListing }, async () => {
          const rows = w.rows(), effects = { ...w.agent.calls };
          assert.ok((await w.request(path)).status >= 400, 'bad seller Listing refuses at the handler');
          assert.deepEqual(w.rows(), rows); assert.deepEqual(w.agent.calls, effects);
        });
      }
    }
  }
  const wire = { ...await import('@kynesyslabs/dacs/wire'), ...await import('../../../dist/wire/commitment.js') };
  const admitted = wire.admitWireArtifact(Buffer.from(texts.commitmentText));
  const agreement = wire.admitWireArtifact(Buffer.from(texts.agreementText));
  const listing = wire.admitWireArtifact(Buffer.from(JSON.stringify(w.fixture.listing)));
  const scope = { binding: w.buyerWire.binding, seller: seller.claim, listingPin: w.agent.listingPin, now: NOW,
    request: { jobId: w.jobId, agreementHash: w.agreementHash, buyer: buyer.claim } };
  assert.equal(await wire.commitmentReceiptTime(admitted, agreement, listing, w.fixture.readCommitmentReceipt, scope), NOW);
  await assert.rejects(wire.commitmentReceiptTime(structuredClone(admitted), agreement, listing, w.fixture.readCommitmentReceipt, scope), { code: 'continuation_commitment_invalid', detail: 'ARTIFACT-NOT-ADMITTED' });
  for (const badListing of [undefined, wire.admitWireArtifact(Buffer.from('{}')), structuredClone(listing)]) {
    await assert.rejects(wire.commitmentReceiptTime(admitted, agreement, badListing, w.fixture.readCommitmentReceipt, scope));
  }
});

test("P11a1-T27: a job the agent holds with no kept tuple is refused tp1_purchase_profile_mismatch, signed, on every wire route with no row and no agent call, and a wire request whose kept tuple differs is refused, also after restart; after a wire proposal has created and profiled the job, the real old-auth context route's retry with a fresh request nonce still classifies known and replays", async (t) => {
  const w = await continuingWorld(t);
  assert.deepEqual([...EFFECTS, PATHS.state, PATHS.bundleBuyerCopy].sort(), [...WIRE_ROUTE_PATHS].sort(), 'every wire route is covered');
  const tupleRow = () => { const db = new DatabaseSync(w.storePath, { readonly: true }); try { return db.prepare('SELECT * FROM kit_purchase_profiles WHERE job=?').get(w.jobId); } finally { db.close(); } };
  const writeTuple = (sql, ...values) => { const db = new DatabaseSync(w.storePath); try { db.prepare(sql).run(...values); } finally { db.close(); } };
  for (const restarted of [false, true]) {
    if (restarted) w.reopen();
    const kept = tupleRow();
    assert.ok(kept, 'the wire proposal kept the tuple');
    writeTuple('DELETE FROM kit_purchase_profiles WHERE job=?', w.jobId);
    for (const path of WIRE_ROUTE_PATHS) {
      const refused = await assertRefusedWithoutWork(w, path, () => w.request(path), 'tp1_purchase_profile_mismatch');
      assert.deepEqual({ status: refused.status, signed: refused.signed }, { status: 500, signed: true }, path);
      await w.verified(refused);
    }
    writeTuple('INSERT INTO kit_purchase_profiles VALUES (?, ?, ?)', kept.job, kept.profile, kept.kept_at);
    writeTuple('UPDATE kit_purchase_profiles SET profile=? WHERE job=?', JSON.stringify({ ...w.buyerWire.binding.profile, pinVersion: 'TEST-other-pin' }), w.jobId);
    for (const path of WIRE_ROUTE_PATHS) await assertRefusedWithoutWork(w, path, () => w.request(path), 'tp1_purchase_profile_mismatch');
    writeTuple('UPDATE kit_purchase_profiles SET profile=? WHERE job=?', canonicalize(w.buyerWire.binding.profile), w.jobId);
    assert.equal((await w.request(PATHS.state)).status, 200, 'the restored tuple is answered');
  }
  // The real legacy context handler still classifies and replays a profiled purchase.
  const { world: legacyWorld, JOBS } = await import('./helpers/d5-http-fixture.mjs');
  const legacy = await legacyWorld(t, { recover: async (body) => ({ disposition: 'present', value: { scope: body.scope, input: { jobId: body.scope.jobId } } }) }), request = await legacy.wire({ jobId: JOBS[0] });
  const core = await import('@kynesyslabs/dacs');
  const contextBody = JSON.parse(request.text);
  const plan = core.createFixedPriceAgreementSigningPlan(core.deriveFixedPriceAgreement(agreementInput({ jobId: JOBS[0], listing: legacy.listing, buyerBundle: contextBody.buyerIdentityBundle, generatedAt: legacy.now() })));
  const buyerContribution = await core.createFixedPriceAgreementSignatureContribution(plan, 'buyer', { party: legacy.buyer.claim, algorithm: 'ed25519', sign: legacy.buyer.sign });
  const material = { proposalVersion: '1', plan, buyerContribution }, proposal = { ...material, proposalHash: sha256Hex(canonicalize(material)) };
  const transportIdentity = { jobId: JOBS[0], buyer: legacy.buyer.claim, seller: legacy.seller.claim, agreementHash: plan.agreementHash, planHash: plan.planHash, proposalHash: proposal.proposalHash };
  const agent = { claim: legacy.seller.claim, listingPin: legacy.pin, transportAgreementOf: () => null, continuationEvidenceOf: () => null, receiveProposal: async () => ({ disposition: 'complete' }) };
  const { binding, readCommitmentReceipt } = w.handle.wire;
  const journalDirectory = join(w.directory, 'legacy-wire'); mkdirSync(journalDirectory, { mode: 0o700 });
  const journal = openWireRequestJournal(journalDirectory, { leaseMs: JOURNAL_LEASE_MS, clock: legacy.now });
  const wire = createWireContext({ binding, tp1Network: { connection: w.buyerWire.connection }, signer: legacy.seller, store: legacy.store, journal, ready: () => true, now: legacy.now, agent, requireDelegation: false, readCommitmentReceipt });
  const handler = createSellerHttpHandler(agent, { authentication: legacy.auth, wire });
  const buyerWire = await wireBuyer({ buyer: legacy.buyer, seller: legacy.seller, listingPin: legacy.pin, clock: legacy.now });
  const signed = await buyerWire.signRequest(PATHS.proposals, { proposal, transportIdentity, buyerIdentityBundle: contextBody.buyerIdentityBundle }, transportIdentity);
  assert.equal((await exchange(handler, { url: PATHS.proposals, ...signed })).status, 200);
  assert.deepEqual(legacy.store.purchaseProfile(JOBS[0]), buyerWire.binding.profile);
  const first = await exchange(legacy.handler, { url: PATHS.context, ...request });
  assert.equal(first.status, 200, first.text);
  const replay = await exchange(legacy.handler, { url: PATHS.context, ...await legacy.wire({ jobId: JOBS[0] }) });
  assert.equal(replay.status, 200);
  assert.equal(replay.text, first.text);
  const classified = await legacy.wire({ jobId: JOBS[0] });
  assert.equal(legacy.store.classify(legacy.auth.readRequest(classified.header), JSON.parse(classified.text), { journaledOnly: true }), 'known');
  const afterRestart = await legacy.wire({ jobId: JOBS[0] });
  legacy.store.close();
  const reopened = createSellerTransportStore({ path: legacy.path, now: legacy.now });
  t.after(() => reopened.close());
  const auth = createSellerTransportServerAuth({ sellerSigner: legacy.seller, listingPin: legacy.pin, store: reopened, now: legacy.now });
  const contextHandler = createSellerHttpHandler({ claim: legacy.seller.claim, listingPin: legacy.pin }, { authentication: auth, context: legacy.route });
  assert.equal(reopened.classify(auth.readRequest(afterRestart.header), JSON.parse(afterRestart.text), { journaledOnly: true }), 'known');
  const restored = await exchange(contextHandler, { url: PATHS.context, ...afterRestart });
  assert.equal(restored.status, 200); assert.equal(restored.text, first.text);
});

test('wire-payment-requires-assembled-settlement: a wire payment is refused while the agent has no assembled settlement profile, with no row and no payment call, and the other routes go on', async (t) => {
  const w = await continuingWorld(t);
  w.agent.assertAuthenticatedPayment = () => { throw new SellerAgentError('settlement_profile_unavailable', 'TEST the settlement profile is not assembled', 503); };
  const refused = await assertRefusedWithoutWork(w, PATHS.payments, () => w.request(PATHS.payments), 'settlement_profile_unavailable');
  assert.equal(refused.status, 503);
  assert.equal((await w.request(PATHS.bundleRequest)).status, 200);
});

test("P11a1-T28: table: route (payments with a cached completed answer, commitments, commitments/signature) × delegation (live, expired) × replay (the same body under a fresh request nonce) × live/restarted store, with counting agent, signer and publication doubles. A live delegation answers from the cache as today. An expired delegation's replay answers only its journaled answer (or a held refusal): zero agent, signer and publication calls and no new effect, with checked.readbackOnly read from the wire check, never from the absent old authentication; every counter equals its pre-replay value", async (t) => {
  const w = await continuingWorld(t);
  // Commit refresh and payment refresh count real downstream work separately from HTTP response signing.
  let refresh = 0, publications = 0, effectSignatures = 0;
  w.agent.submitPayment = async () => { w.agent.calls.payments++; publications++; return { status: 'payment-evidenced', delivery: { status: 'delivered' } }; };
  w.agent.readCommitment = async () => { refresh++; effectSignatures++; return { status: 'committed', jobId: w.jobId }; };
  for (const path of [PATHS.payments, PATHS.commitments, PATHS.commitmentSignature]) {
    w.signing.failures = 2;
    assert.ok((await w.request(path)).status >= 500, 'response signing is lost after the completed answer is stored');
    w.signing.failures = 0;
    for (const restarted of [false, true]) {
      if (restarted) w.reopen();
      for (const expired of [false, true]) {
        const delegation = w.delegationFor({ jobId: w.jobId, expiresAt: w.fixture.agreement.terms.deadline });
        w.state.time = expired ? delegation.payload.expiresAt : NOW;
        const calls = { ...w.agent.calls }, refreshed = refresh, published = publications, signed = effectSignatures, rows = w.rows();
        const text = JSON.stringify(w.bodyFor(path)), payload = w.payloadFor(path, text, { jobId: w.jobId, agreementHash: w.agreementHash, expiresAt: w.clock() + 1000 });
        const answer = await w.send(path, { text, payload, header: w.headerFor(payload, { signer: SESSION, delegation }) });
        if (expired) {
          assert.equal(answer.body.error, 'peer_delegation_expired');
          assert.deepEqual(w.agent.calls, calls); assert.equal(refresh, refreshed); assert.equal(publications, published); assert.equal(effectSignatures, signed); assert.deepEqual(w.rows(), rows);
        } else { assert.equal(answer.status, 200); await w.verified(answer); }
      }
      w.state.time = NOW;
    }
  }
});

/** The stub agent's recovery of a retained effect, with the clock moved to `at(request)` before it claims: records what each claim granted. */
function claimAt(w, at, outcome = {}) {
  const claims = [];
  w.agent.reconcileTransport = async ({ request, transport }) => {
    w.agent.calls.reconciled++;
    w.state.time = at(request);
    claims.push(transport.claim().live);
    transport.settle({ status: 200, value: request.path === PATHS.proposals ? { disposition: 'complete', contribution: { signed: true } } : { status: 'committed', jobId: request.jobId }, ...outcome });
  };
  return claims;
}

/** A proposal whose effect an unsignable answer left uncertain. */
async function uncertainProposal(w, label) {
  const job = await proposeJob(w, label);
  w.agent.fenced = null;
  assert.equal((await job.post()).body.error, 'outgoing_body_rejected');
  w.agent.fenced = undefined;
  w.state.time += JOURNAL_LEASE_MS;
  return job;
}

/** A commitment (or signature commitment) effect a process death before `finish` left uncertain, after a restart. */
async function uncertainCommitment(w, path, label) {
  const job = await proposeJob(w, label);
  assert.equal((await job.post()).status, 200);
  w.handle.finishFails = true;
  const body = { jobId: job.jobId }, ids = { jobId: job.jobId, agreementHash: job.agreementHash };
  assert.ok((await w.post(path, body, ids)).status >= 500);
  w.reopen();
  w.state.time += JOURNAL_LEASE_MS;
  return { job, sign: () => w.buyerWire.signRequest(path, body, ids) };
}

const CLOCKS = [['one millisecond before expiry', -1, true], ['at expiry', 0, false], ['one millisecond after expiry', 1, false]];

test('a retained proposal effect is claimed read-only once its request has expired at the claim, though it was live at admission', async (t) => {
  const w = await world(t);
  for (const [label, delta, live] of CLOCKS) {
    const job = await uncertainProposal(w, `late-claim-proposals-${label}`);
    const signed = await w.buyerWire.signRequest(PATHS.proposals, job.body, { jobId: job.jobId, agreementHash: job.agreementHash });
    const claims = claimAt(w, () => signed.payload.expiresAt + delta);
    const answer = await w.send(PATHS.proposals, signed);
    w.state.time = NOW;
    assert.deepEqual({ status: answer.status, claims }, { status: 200, claims: [live] }, label);
  }
});

test('a retained commitment effect, after a restart, is claimed read-only once its request has expired at the claim, on commitments and on commitments/signature', async (t) => {
  for (const [route, path, options] of [['commitments', PATHS.commitments, {}], ['commitments/signature', PATHS.commitmentSignature, { commitOnSignature: true }]]) {
    const w = await world(t, options);
    for (const [label, delta, live] of CLOCKS) {
      const { sign } = await uncertainCommitment(w, path, `late-claim-${route}-${label}`);
      const signed = await sign();
      const claims = claimAt(w, () => signed.payload.expiresAt + delta);
      const answer = await w.send(path, signed);
      w.state.time = NOW;
      assert.deepEqual({ status: answer.status, claims }, { status: 200, claims: [live] }, `${route}: ${label}`);
    }
  }
});

test('a retained proposal effect claimed read-only is never settled for retry or removal: the refusal is 408 peer_expired, the effect stays uncertain, and a live request then reconciles it', async (t) => {
  for (const outcome of [{ retry: true }, { noEffect: true }]) {
    const w = await world(t);
    const job = await uncertainProposal(w, `late-settle-${Object.keys(outcome)[0]}`);
    const signed = await w.buyerWire.signRequest(PATHS.proposals, job.body, { jobId: job.jobId, agreementHash: job.agreementHash });
    claimAt(w, () => signed.payload.expiresAt, outcome);
    const refused = await w.send(PATHS.proposals, signed);
    w.state.time = NOW;
    assert.deepEqual({ status: refused.status, error: refused.body.error }, { status: 408, error: 'peer_expired' }, Object.keys(outcome)[0]);
    const db = new DatabaseSync(w.storePath, { readonly: true });
    try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peer_effects').get().n, 0); } finally { db.close(); }
    assert.equal(inspectWireOperation(w.handle.wire.journal, { seller: seller.claim, jobId: job.jobId, path: PATHS.proposals }).state, 'pending', 'the effect is neither completed nor ended null');
    w.state.time += 2 * JOURNAL_LEASE_MS;
    const claims = claimAt(w, () => w.state.time);
    const text = JSON.stringify(job.body), payload = w.payloadFor(PATHS.proposals, text, { jobId: job.jobId, agreementHash: job.agreementHash, expiresAt: w.state.time + MAX_SIGNED_LIFETIME_MS });
    assert.equal((await w.send(PATHS.proposals, { text, payload, header: w.headerFor(payload) })).status, 200);
    assert.deepEqual(claims, [true], 'a live request claims it live');
  }
});

test('a retained proposal effect under a delegation is claimed read-only once the delegation has expired at the claim', async (t) => {
  const w = await world(t);
  for (const [label, delta, live] of [['one millisecond before the delegation expires', -1, true], ['when it expires', 0, false]]) {
    const job = await uncertainProposal(w, `late-claim-delegated-${label}`);
    const expiresAt = w.state.time + 20_000, text = JSON.stringify(job.body);
    const delegation = w.delegationFor({ jobId: job.jobId, expiresAt });
    const payload = w.payloadFor(PATHS.proposals, text, { jobId: job.jobId, agreementHash: job.agreementHash, expiresAt });
    const claims = claimAt(w, () => expiresAt + delta);
    const answer = await w.send(PATHS.proposals, { text, header: w.headerFor(payload, { signer: SESSION, delegation }), payload });
    w.state.time = NOW;
    assert.deepEqual({ status: answer.status, claims }, { status: 200, claims: [live] }, label);
  }
});

test('the wire authenticator charges late expiry, reads the clock in readbackOnly(), and refuses unadmitted requests', async (t) => {
  const w = await world(t);
  const auth = wireAuthenticator(w.handle.wire, w.agent, w.handle.authentication);
  const admit = async (label) => {
    const job = await proposeJob(w, label);
    const signed = await w.buyerWire.signRequest(PATHS.proposals, job.body, { jobId: job.jobId, agreementHash: job.agreementHash });
    let request = null;
    const opened = await auth.open({ header: signed.header, method: 'POST', path: PATHS.proposals, rawBody: Buffer.from(signed.text), body: JSON.parse(signed.text), onOpened: (admitted) => { request = admitted; } });
    return { request, opened, signed };
  };
  const live = await admit('reserve-live');
  assert.equal(live.opened.readbackOnly(), false);
  assert.equal((await auth.store.reserve(live.request, live.opened.body, live.opened.reserveOptions)).disposition, 'perform', 'a live request reserves');
  const lapsing = await admit('reserve-lapsing'), unadmitted = await admit('reserve-unadmitted');
  const rowsBefore = w.rows();
  w.state.time = lapsing.signed.payload.expiresAt - 1;
  assert.equal(lapsing.opened.readbackOnly(), false, 'one millisecond before expiry');
  w.state.time = lapsing.signed.payload.expiresAt;
  assert.equal(lapsing.opened.readbackOnly(), true, 'at expiry');
  await assert.rejects(auth.store.reserve(lapsing.request, lapsing.opened.body, lapsing.opened.reserveOptions), { code: 'peer_expired', status: 408 }, 'an expired request starts no effect');
  w.state.time = NOW;
  await assert.rejects(auth.store.reserve({ ...unadmitted.request }, unadmitted.opened.body, unadmitted.opened.reserveOptions), { code: 'peer_expired', status: 408 }, 'a request this authenticator did not admit starts no effect');
  assert.equal(w.rows().peer_effects, rowsBefore.peer_effects, 'no old effect');
  assert.deepEqual(accountingRows(w).map(row => row.state), ['new', 'refused']);
});

test('a request the wire authenticator has seen expired stays expired when the clock later reads earlier', async (t) => {
  const w = await world(t);
  const auth = wireAuthenticator(w.handle.wire, w.agent, w.handle.authentication);
  const job = await proposeJob(w, 'clock-regression');
  const signed = await w.buyerWire.signRequest(PATHS.proposals, job.body, { jobId: job.jobId, agreementHash: job.agreementHash });
  let request = null;
  const opened = await auth.open({ header: signed.header, method: 'POST', path: PATHS.proposals, rawBody: Buffer.from(signed.text), body: JSON.parse(signed.text), onOpened: (admitted) => { request = admitted; } });
  const rowsBefore = w.rows();
  assert.equal(opened.readbackOnly(), false, 'live at admission');
  w.state.time = signed.payload.expiresAt;
  assert.equal(opened.readbackOnly(), true, 'at expiry');
  w.state.time = NOW;
  assert.equal(opened.readbackOnly(), true, 'a clock corrected to an earlier time does not revive it');
  await assert.rejects(auth.store.reserve(request, opened.body, opened.reserveOptions), { code: 'peer_expired', status: 408 }, 'and it still starts no effect');
  assert.equal(w.rows().peer_effects, rowsBefore.peer_effects, 'no effect was published');
  assert.equal(accountingRows(w)[0].code, 'peer_expired', 'the late refusal stays charged');
});

test('a cached payment refresh that finds its request expired at the job fence stays refused when the clock later reads earlier', async (t) => {
  const w = await continuingWorld(t);
  const checks = [];
  let refreshing = false;
  w.agent.submitPayment = async (body, options = {}) => {
    w.agent.calls.payments++;
    const check = () => { try { options.transport.check(); return 'live'; } catch (error) { return error.code; } };
    if (refreshing) {
      checks.push(check());
      w.state.time = NOW + 1000;
      checks.push(check());
      w.state.time = NOW;
      checks.push(check());
    }
    return { status: 'payment-evidenced', delivery: { status: 'delivered' } };
  };
  assert.equal((await w.request(PATHS.payments)).status, 200, 'the first payment completes');
  refreshing = true;
  const text = JSON.stringify(w.bodyFor(PATHS.payments)), payload = w.payloadFor(PATHS.payments, text, { jobId: w.jobId, agreementHash: w.agreementHash, expiresAt: NOW + 1000 });
  assert.equal((await w.send(PATHS.payments, { text, payload, header: w.headerFor(payload) })).status, 200, 'the replay refreshes the cached answer');
  assert.deepEqual(checks, ['live', 'peer_expired', 'peer_expired'], 'the expiry the fence saw is kept');
});

// P11b1L3: production HTTP dispatch over the real SQL store and wire journal.
function accountingRows(w) {
  const db = new DatabaseSync(w.storePath, { readonly: true });
  try { return db.prepare('SELECT * FROM kit_reservations ORDER BY rowid').all(); } finally { db.close(); }
}
function accountingCut(w, change) {
  const accounting = w.handle.store.reservationAccounting, reserve = accounting.reserveAccounted.bind(accounting);
  accounting.reserveAccounted = input => reserve(change(input));
}
function failSql(t, match) {
  const prepare = DatabaseSync.prototype.prepare;
  return t.mock.method(DatabaseSync.prototype, 'prepare', function(sql) {
    if (match(sql)) throw new Error('TEST accounting write interrupted');
    return prepare.call(this, sql);
  });
}

test('host wire effects account before publishing and invoking the agent', async (t) => {
  const w = await continuingWorld(t);
  w.agent.onWork = kind => {
    if (kind === 'commit-read') return;
    const row = accountingRows(w).at(-1);
    assert.equal(row?.state, 'new', 'accounting committed before agent work');
    assert.equal(inspectWireOperation(w.handle.wire.journal, { seller: seller.claim, jobId: row.jobId, path: row.route }).state, 'pending');
  };
  for (const path of EFFECTS.slice(1)) assert.equal((await w.request(path)).status, 200, path);
  assert.deepEqual(accountingRows(w).map(row => row.route), EFFECTS);
  assert.equal(w.rows().peer_effects, 0);
  assert.equal(w.journalFiles().filter(name => name.startsWith('k-')).length, EFFECTS.length);
});

test('host wire reads leave accounting and journal unchanged', async (t) => {
  const w = await continuingWorld(t), before = accountingRows(w), files = w.journalFiles();
  for (const path of [PATHS.state, PATHS.bundleBuyerCopy]) assert.equal((await w.request(path)).status, 200);
  assert.equal(before.length, 1);
  assert.deepEqual(accountingRows(w), before); assert.deepEqual(w.journalFiles(), files);
});

test('host wire failed accounting commit publishes nothing', async (t) => {
  const w = await world(t), job = await proposeJob(w, 'accounting-rollback');
  const exec = DatabaseSync.prototype.exec;
  const failure = t.mock.method(DatabaseSync.prototype, 'exec', function(sql) {
    if (sql === 'COMMIT') throw new Error('TEST accounting commit interrupted');
    return exec.call(this, sql);
  });
  assert.equal((await job.post()).status, 503); failure.mock.restore();
  assert.deepEqual(accountingRows(w), []); assert.deepEqual(w.journalFiles(), []);
  assert.equal(w.rows().kit_purchase_profiles, 0); assert.equal(w.agent.calls.proposals, 0);
  w.reopen(); assert.equal((await job.post()).status, 200); assert.equal(accountingRows(w).length, 1);
});

test('host wire restart after accounting commit retains the charge without publication', async (t) => {
  const w = await world(t), job = await proposeJob(w, 'accounting-before-reserve');
  accountingCut(w, input => ({ ...input, checked: { ...input.checked, reserve: async () => { throw new Error('TEST cut before reserve'); } } }));
  assert.equal((await job.post()).status, 503);
  assert.deepEqual(accountingRows(w).map(row => row.state), ['reserving']);
  assert.deepEqual(w.journalFiles(), []); assert.equal(w.agent.calls.proposals, 0);
  w.reopen(); assert.equal((await job.post()).status, 200);
  assert.deepEqual(accountingRows(w).map(row => row.state), ['reserving', 'new']); assert.equal(w.agent.calls.proposals, 1);
});

test('host wire nonce-only publication never authorizes recovery', async (t) => {
  const w = await world(t), job = await proposeJob(w, 'accounting-nonce'), link = fs.linkSync;
  const cut = t.mock.method(fs, 'linkSync', (source, destination) => {
    if (/o-.*-0$/.test(destination)) throw new Error('TEST cut before attempt');
    return link(source, destination);
  });
  syncBuiltinESMExports(); assert.equal((await job.post()).status, 503);
  cut.mock.restore(); syncBuiltinESMExports();
  assert.deepEqual(accountingRows(w).map(row => row.state), ['reserving']); assert.equal(w.journalFiles().length, 1);
  w.reopen(); assert.equal((await job.post()).status, 200);
  assert.equal(w.agent.calls.reconciled, 0); assert.equal(w.agent.calls.proposals, 1); assert.equal(accountingRows(w).length, 2);
});

test('host wire restart after publication retains the reserving row and attempt', async (t) => {
  const w = await world(t), job = await proposeJob(w, 'accounting-after-reserve');
  const failure = failSql(t, sql => sql.includes('UPDATE kit_reservations SET state'));
  assert.equal((await job.post()).status, 503); failure.mock.restore();
  assert.deepEqual(accountingRows(w).map(row => row.state), ['reserving']);
  assert.equal(w.journalFiles().filter(name => /^o-.*-0$/.test(name)).length, 1); assert.equal(w.agent.calls.proposals, 0);
  w.reopen(); assert.equal((await job.post()).body.error, 'seller_effect_pending'); w.state.time += JOURNAL_LEASE_MS;
  assert.equal((await job.post()).status, 200);
  assert.deepEqual(accountingRows(w).map(row => row.state), ['reserving', 'refused', 'recover'], 'the expired pending refusal remains durable');
  assert.equal(w.agent.calls.proposals, 0); assert.equal(w.agent.calls.reconciled, 1);
});

test('host wire late refusal retains its accounting charge and original code', async (t) => {
  for (const failedSave of [false, true]) {
    const w = await world(t), job = await proposeJob(w, 'accounting-refusal-' + failedSave);
    accountingCut(w, input => ({ ...input, checked: { ...input.checked, reserve: async () => { throw new WireError('peer_expired', 408); } } }));
    const failure = failedSave ? failSql(t, sql => sql.includes('UPDATE kit_reservations SET state')) : null;
    const answer = await job.post(); failure?.mock.restore();
    assert.deepEqual([answer.status, answer.body.error], [408, 'peer_expired']);
    assert.equal(accountingRows(w)[0].state, failedSave ? 'reserving' : 'refused');
    assert.equal(accountingRows(w)[0].code, failedSave ? null : 'peer_expired');
    assert.deepEqual(w.journalFiles(), []); assert.equal(w.agent.calls.proposals, 0);
    w.reopen(); assert.equal(accountingRows(w).length, 1);
  }
});

test('host wire restart reconciles an issued recovery attempt without repeating the effect', async (t) => {
  const w = await world(t), job = await proposeJob(w, 'accounting-outcome-cut'); w.handle.finishFails = true;
  assert.equal((await job.post()).status, 503); assert.equal(w.agent.calls.proposals, 1);
  assert.deepEqual(accountingRows(w).map(row => row.state), ['new']);
  w.reopen(); assert.equal((await job.post()).body.error, 'seller_effect_pending'); w.state.time += JOURNAL_LEASE_MS;
  assert.equal((await job.post()).status, 200); assert.equal(w.agent.calls.proposals, 1); assert.equal(w.agent.calls.reconciled, 1);
});

test('host wire lost response reuses the completed outcome after restart', async (t) => {
  const w = await world(t), job = await proposeJob(w, 'accounting-lost-response'); w.signing.failures = 2;
  assert.equal((await job.post()).status, 503); assert.deepEqual(accountingRows(w).map(row => row.state), ['new']);
  assert.equal(w.journalFiles().filter(name => name.endsWith('.done')).length, 1);
  w.reopen(); const answer = await job.post(); assert.equal(answer.status, 200);
  assert.equal((await w.verified(answer)).body.disposition, 'complete');
  assert.deepEqual(accountingRows(w).map(row => row.state), ['new', 'completed']); assert.equal(w.agent.calls.proposals, 1);
});

test('host wire retained progress ends its attempt with no outcome and the next request reconciles', async (t) => {
  const w = await world(t), job = await proposeJob(w, 'accounting-progress');
  w.agent.retains = true; w.agent.answer = () => ({ disposition: 'waiting' });
  assert.equal((await job.post()).body.disposition, 'waiting');
  assert.equal(w.agent.calls.proposals, 1); assert.deepEqual(accountingRows(w).map(row => row.state), ['new']);
  assert.equal(w.journalFiles().some(name => name.endsWith('.done')), false);
  assert.equal(w.journalFiles().filter(name => name.endsWith('.end')).length, 1, 'a clean end, not a lease to wait out');
  w.reopen(); assert.equal((await job.post()).status, 200); assert.equal(w.agent.calls.reconciled, 1);
  assert.deepEqual(accountingRows(w).map(row => row.state), ['new', 'recover']);
});

test('host wire proven no-effect answer ends null without losing the charge', async (t) => {
  const w = await world(t), job = await proposeJob(w, 'accounting-null'); w.agent.answer = () => ({ disposition: 'rejected' });
  assert.equal((await job.post()).body.disposition, 'rejected'); assert.equal(w.journalFiles().filter(name => name.endsWith('.end')).length, 1);
  assert.equal(w.journalFiles().some(name => name.endsWith('.done')), false);
  w.reopen(); assert.equal((await job.post()).status, 200); assert.equal(w.agent.calls.proposals, 1); assert.equal(w.agent.calls.reconciled, 1);
  assert.deepEqual(accountingRows(w).map(row => row.state), ['new', 'recover']);
});

test('host wire binding mismatches and pending polls are accounted', async (t) => {
  const w = await world(t), job = await proposeJob(w, 'accounting-polls');
  w.handle.finishFails = true; assert.equal((await job.post()).status, 503);
  assert.equal((await job.post()).body.error, 'seller_effect_pending');
  w.reopen(); // clears the cut: the link hook is shared by every world
  const other = await world(t), mismatch = await proposeJob(other, 'accounting-mismatch');
  const { reserveEffect, journalStore } = await import('../../../dist/wire/journal.js');
  reserveEffect(journalStore(other.handle.wire.journal), { seller: seller.claim, jobId: mismatch.jobId, path: PATHS.proposals,
    key: derive('other-nonce-key'), requestHash: derive('other-request'), binding: derive('other-binding') });
  assert.equal((await mismatch.post()).body.error, 'peer_operation_mismatch');
  assert.deepEqual(accountingRows(w).map(row => [row.class, row.state, row.code]), [
    ['general', 'new', null], ['general', 'refused', 'seller_effect_pending'],
  ]);
  assert.deepEqual(accountingRows(other).map(row => [row.class, row.state, row.code]), [['general', 'refused', 'peer_operation_mismatch']]);
  assert.equal(w.agent.calls.proposals, 1); assert.equal(other.agent.calls.proposals, 0);
});

test('host wire payments retain only the admitted transaction claim', async (t) => {
  const w = await continuingWorld(t); assert.equal((await w.request(PATHS.payments)).status, 200);
  const db = new DatabaseSync(w.storePath, { readonly: true });
  try { assert.deepEqual(db.prepare('SELECT * FROM kit_payment_transactions').all(), [{ tx: w.bodyFor(PATHS.payments).txHash, jobId: w.jobId,
    operationId: wireOperationId({ seller: seller.claim, jobId: w.jobId, path: PATHS.payments }) }]); } finally { db.close(); }
  assert.equal(w.agent.calls.payments, 1);
});

test('host wire recovery claim preserves expiry and rejects repeated claims', async (t) => {
  const w = await world(t), job = await proposeJob(w, 'accounting-expired-claim'); w.handle.finishFails = true;
  assert.equal((await job.post()).status, 503);
  assert.deepEqual(accountingRows(w).map(row => row.state), ['new']);
  w.reopen(); w.state.time += JOURNAL_LEASE_MS;
  w.agent.reconcileTransport = async ({ request, transport }) => {
    w.state.time = request.expiresAt; assert.equal(transport.claim().live, false);
    assert.throws(() => transport.claim(), { code: 'peer_reconciliation_conflict' }); w.state.time--;
    assert.throws(() => transport.settle({ status: 200, value: {}, noEffect: true }), { code: 'peer_expired' });
    transport.settle({ status: 200, value: { disposition: 'complete' } });
  };
  assert.equal((await job.post()).status, 200); assert.equal(w.agent.calls.proposals, 1);
});

test('host wire superseded worker cannot complete a newer attempt', async (t) => {
  const w = await world(t), job = await proposeJob(w, 'accounting-superseded'); let unblock, entered;
  const paused = new Promise(resolve => { entered = resolve; }), barrier = new Promise(resolve => { unblock = resolve; });
  const receive = w.agent.receiveProposal;
  w.agent.receiveProposal = async (...args) => { const result = await receive(...args); entered(); await barrier; return result; };
  const first = job.post(); await paused; w.state.time += JOURNAL_LEASE_MS;
  assert.equal((await job.post()).status, 200); unblock(); assert.equal((await first).status, 503);
  assert.equal(w.agent.calls.proposals, 1); assert.equal(w.agent.calls.reconciled, 1);
  assert.deepEqual(accountingRows(w).map(row => row.state), ['new', 'recover']);
});

test('host wire crash after recovery claim retains the attempt until its lease ends', async (t) => {
  const w = await world(t), job = await proposeJob(w, 'accounting-claim-cut');
  w.handle.finishFails = true;
  assert.equal((await job.post()).status, 503);
  assert.deepEqual(accountingRows(w).map(row => row.state), ['new']);
  w.reopen(); w.state.time += JOURNAL_LEASE_MS;
  const recover = w.agent.reconcileTransport;
  w.agent.reconcileTransport = async ({ transport }) => { transport.claim(); throw new Error('TEST cut after claim'); };
  assert.equal((await job.post()).status, 503);
  assert.deepEqual(accountingRows(w).map(row => row.state), ['new', 'recover']);
  w.reopen();
  assert.equal((await job.post()).body.error, 'seller_effect_pending');
  w.state.time += JOURNAL_LEASE_MS; w.agent.reconcileTransport = recover;
  const text = JSON.stringify(job.body), payload = w.payloadFor(PATHS.proposals, text,
    { jobId: job.jobId, agreementHash: job.agreementHash, expiresAt: w.state.time + MAX_SIGNED_LIFETIME_MS });
  assert.equal((await w.send(PATHS.proposals, { payload, text, header: w.headerFor(payload) })).status, 200);
  assert.equal(w.agent.calls.proposals, 1); assert.equal(w.agent.calls.reconciled, 1);
});

test('host wire crash after reservation result requires recovery before agent work', async (t) => {
  const w = await world(t), job = await proposeJob(w, 'accounting-after-result');
  const accounting = w.handle.store.reservationAccounting, reserve = accounting.reserveAccounted.bind(accounting);
  accounting.reserveAccounted = async input => { await reserve(input); throw new Error('TEST cut after result CAS'); };
  assert.equal((await job.post()).status, 503);
  assert.deepEqual(accountingRows(w).map(row => row.state), ['new']); assert.equal(w.agent.calls.proposals, 0);
  w.reopen(); assert.equal((await job.post()).body.error, 'seller_effect_pending');
  w.state.time += JOURNAL_LEASE_MS;
  assert.equal((await job.post()).status, 200); assert.equal(w.agent.calls.proposals, 0); assert.equal(w.agent.calls.reconciled, 1);
});

test('host wire outcome end record survives a cut before outcome publication', async (t) => {
  const w = await world(t), job = await proposeJob(w, 'accounting-end-outcome-cut'), link = fs.linkSync;
  const cut = t.mock.method(fs, 'linkSync', (source, destination) => {
    if (destination.endsWith('.done')) throw new Error('TEST cut before outcome publication');
    return link(source, destination);
  });
  syncBuiltinESMExports(); assert.equal((await job.post()).status, 503);
  cut.mock.restore(); syncBuiltinESMExports();
  assert.equal(w.journalFiles().filter(name => name.endsWith('.end')).length, 1);
  assert.equal(w.journalFiles().some(name => name.endsWith('.done')), false);
  w.reopen(); assert.equal((await job.post()).status, 200); assert.equal(w.agent.calls.proposals, 1);
  assert.deepEqual(accountingRows(w).map(row => row.state), ['new', 'completed']);
});

// The terminal-context fence of the old store, on the wire's job-fence checks.
const TERMINAL_SESSIONS = ['finalised', 'vet-failed', 'negotiate-failed', 'commit-failed', 'settle-failed', 'aborted-by-self', 'aborted-by-other', 'failed-substrate'];
const codeOf = (work) => { try { work(); return null; } catch (error) { return `${error.code} ${error.status}`; } };

test('wire proposal fence: a context session that ends after accounting refuses the work before it signs, in every terminal state, and a live session is admitted', async (t) => {
  const w = await world(t);
  for (const terminal of [null, ...TERMINAL_SESSIONS]) {
    w.state.session = null;
    const job = await proposeJob(w, `terminal-fence-${terminal}`);
    // The real agent reads the session after its Vet and context waits, just before it signs: it is admitted live and ends here.
    w.agent.onWork = () => { w.state.session = terminal; };
    const answer = await job.post();
    w.agent.onWork = () => {};
    assert.equal(w.agent.transportAgreementOf(job.jobId) !== null, terminal === null, `${terminal}: the contribution is retained only for a live session`);
    assert.deepEqual({ status: answer.status, error: answer.body.error }, terminal === null ? { status: 200, error: undefined } : { status: 503, error: 'operation_uncertain' }, String(terminal));
  }
});

test('wire proposal fence: a retained proposal is not claimed live in a terminal session, a claim made before it ends is refused at its next check, and read-only recovery goes on', async (t) => {
  const w = await world(t);
  const observed = [];
  const recover = (afterClaim) => async ({ transport }) => {
    w.agent.calls.reconciled++;
    let claim;
    try { claim = transport.claim(); } catch (error) { observed.push({ refused: codeOf(() => { throw error; }) }); return; }
    w.state.session = afterClaim;
    observed.push({ live: claim.live, check: codeOf(() => claim.check()) });
    transport.settle({ status: 200, value: { disposition: 'complete', contribution: { signed: true } } });
  };
  const retried = async (label, session, { expire = false } = {}) => {
    w.state.time = NOW; w.state.session = null;
    const job = await uncertainProposal(w, `terminal-recovery-${label}`);
    const signed = await w.buyerWire.signRequest(PATHS.proposals, job.body, { jobId: job.jobId, agreementHash: job.agreementHash });
    w.state.session = session;
    if (expire) w.agent.reconcileTransport = async (input) => { w.state.time = signed.payload.expiresAt; return recover(session)(input); };
    return w.send(PATHS.proposals, signed);
  };
  w.agent.reconcileTransport = recover(null);
  assert.equal((await retried('live-session', null)).status, 200);
  w.agent.reconcileTransport = recover(null);
  assert.equal((await retried('terminal-at-claim', 'aborted-by-other')).status, 503);
  w.agent.reconcileTransport = recover('vet-failed');
  assert.equal((await retried('terminal-after-claim', null)).status, 200);
  w.agent.reconcileTransport = recover('aborted-by-other');
  const readOnly = await retried('read-only', 'aborted-by-other', { expire: true });
  w.state.time = NOW;
  assert.equal(readOnly.status, 200);
  assert.deepEqual(observed, [
    { live: true, check: null },
    { refused: 'seller_unavailable 503' },
    { live: true, check: 'context_session_terminal 409' },
    { live: false, check: null },
  ]);
});

// A session source that cannot be read: the accessor answers each read with a fresh fault, and an assignment ends the fault.
const SESSION_FAULTS = {
  throws: () => { throw new Error('the session reader is down'); },
  thenable: () => ({ then() {} }),
  rejecting: () => Promise.reject(new Error('the session reader failed late')),
  'resolved terminal': () => Promise.resolve('aborted-by-other'),
  number: () => 7,
  object: () => ({ state: 'aborted-by-other' }),
  undefined: () => undefined,
};
const failSession = (w, read) => Object.defineProperty(w.state, 'session', { configurable: true, enumerable: true, get: read,
  set(value) { Object.defineProperty(w.state, 'session', { configurable: true, enumerable: true, writable: true, value }); } });

test('wire proposal fence: an unreadable session source is never read as not terminal at the live claim, its next check or the pending assertion', async (t) => {
  const w = await world(t);
  const observed = [], original = w.agent.reconcileTransport;
  const probe = async ({ transport }) => {
    w.agent.calls.reconciled++;
    let claim;
    // The store's admission-time start check reads the source too, so the fault starts at the agent's own claim.
    if (w.failBeforeClaim) failSession(w, w.fault);
    try { claim = transport.claim(); } catch (error) { observed.push({ label: w.label, claim: codeOf(() => { throw error; }), cause: error.cause instanceof Error }); return; }
    failSession(w, w.fault);
    observed.push({ label: w.label, live: claim.live, check: codeOf(() => claim.check()) });
    w.state.session = null;
    transport.settle({ status: 200, value: { disposition: 'complete', contribution: { signed: true } } });
  };
  assert.equal(w.handle.store.sessionTerminal(jobFor('no-session')), false, 'an explicit null is no session');
  for (const [label, fault] of Object.entries(SESSION_FAULTS)) {
    w.fault = fault; w.label = label;
    failSession(w, fault);
    assert.throws(() => w.handle.store.sessionTerminal(jobFor(`direct-${label}`)), { code: 'session_admission_unavailable', status: 503 }, `${label}: the reader refuses`);
    // Before the pending assertion: the agent reads the session after its waits, just before it signs.
    w.state.session = null;
    const job = await proposeJob(w, `unreadable-pending-${label}`);
    w.agent.onWork = () => failSession(w, fault);
    const answer = await job.post();
    w.agent.onWork = () => {};
    w.state.session = null;
    assert.equal(w.agent.transportAgreementOf(job.jobId), null, `${label}: nothing is signed or retained`);
    assert.deepEqual({ status: answer.status, error: answer.body.error }, { status: 503, error: 'operation_uncertain' }, `${label}: pending assertion`);
    // At the live claim, and at the check of a claim made before the source failed.
    w.agent.reconcileTransport = probe;
    for (const stage of ['claim', 'check']) {
      w.state.time = NOW; w.state.session = null;
      const retained = await uncertainProposal(w, `unreadable-${stage}-${label}`);
      const signed = await w.buyerWire.signRequest(PATHS.proposals, retained.body, { jobId: retained.jobId, agreementHash: retained.agreementHash });
      w.failBeforeClaim = stage === 'claim';
      await w.send(PATHS.proposals, signed);
      w.state.session = null;
    }
    w.agent.reconcileTransport = original;
  }
  w.state.time = NOW;
  assert.deepEqual(observed.filter((entry) => 'claim' in entry), Object.keys(SESSION_FAULTS).map((label) => ({ label, claim: 'session_admission_unavailable 503', cause: true })));
  assert.deepEqual(observed.filter((entry) => 'check' in entry), Object.keys(SESSION_FAULTS).map((label) => ({ label, live: true, check: 'session_admission_unavailable 503' })));
});

test('wire proposal fence: a terminal session fences proposal work only, not the commitment of a held job', async (t) => {
  const w = await world(t), job = await proposeJob(w, 'terminal-fence-commitments');
  assert.equal((await job.post()).status, 200);
  w.state.session = 'aborted-by-other';
  assert.equal((await w.post(PATHS.commitments, { jobId: job.jobId }, { jobId: job.jobId, agreementHash: job.agreementHash })).status, 200);
});
