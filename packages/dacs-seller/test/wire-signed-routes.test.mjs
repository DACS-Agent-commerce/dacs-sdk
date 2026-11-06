// P11a1a: the signed read, proposal and commitment routes on `./wire`. Every request is opened and every answer signed by
// the wire; the old transport store stays the only journal. The handler runs over a real transport store, a bound TP1
// profile and a counting stub agent; the buyer signs with `signWireRequest` (helpers/wire-buyer.mjs).
//
// Journal-opening cases need a runner where `/` is root-owned (K5-J0).
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import DatabaseSync from 'better-sqlite3';
import { canonicalize, compositeVerificationAddress, sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_PATHS, TP1_CAPABILITIES, openWireRequestJournal } from '@kynesyslabs/dacs/wire';
import { fixtureIdentityBundle, fixtureListing } from './fixtures/listings.mjs';
import { exchange } from './helpers/d5-http-fixture.mjs';
import { proposalForInput } from './helpers/proposal-admission-fixture.mjs';
import { NOW, buyer, seller, testWallet } from './helpers/protocol-fixture.mjs';
import { TEST_CONNECTION, authorityReader } from './helpers/wire-authority-fixture.mjs';
import { wireBuyer } from './helpers/wire-buyer.mjs';
import { agreementInput, listingPin } from '../src/dacs/purchase-protocol.mjs';
import { SellerAgentError } from '../src/dacs/seller-agent.mjs';
import { createSellerAgentClient, createSellerHttpHandler } from '../src/dacs/seller-http.mjs';
import { WIRE_ROUTE_PATHS, createWireContext, wireAuthenticator } from '../src/dacs/seller-wire-requests.mjs';
import { SELLER_TRANSPORT_HEADER, createSellerTransportClientAuth, createSellerTransportServerAuth, createSellerTransportStore } from '../src/dacs/seller-transport-auth.mjs';

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
    readCommitment: async ({ jobId }) => ({ status: 'committed', jobId }),
    agreementState: (identity) => { agent.calls.states++; return { proposal: null, contribution: null, jobId: identity.jobId }; },
    submitPayment: async () => { agent.calls.payments++; return { status: 'payment-evidenced' }; },
    reconcileTransport: async ({ request, transport }) => {
      agent.calls.reconciled++;
      transport.claim();
      transport.settle({ status: 200, value: request.path === PATHS.proposals ? { disposition: 'complete', contribution: { signed: true } } : { status: 'committed', jobId: request.jobId }, settle: true });
    },
  };
  return agent;
}

/** One seller: a transport store, a bound profile, the wire journal and the handler, with a buyer that signs for it. */
async function world(t, { maxJobs, maxRecords, readAuthority = authorityReader(), commitOnSignature = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'TEST-wire-routes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'transport'), { mode: 0o700 });
  const storePath = join(directory, 'transport', 'transport.sqlite');
  const state = { time: NOW, ready: true, connection: { ...TEST_CONNECTION }, authorityReads: 0, withdrawAtRead: null, lapseAtRead: null, elapsedMs: 0, journals: [] };
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
    if (state.withdrawAtRead === state.authorityReads) throw new Error('TEST authority withdrawn');
    if (state.lapseAtRead === state.authorityReads) state.elapsedMs += MAX_SIGNED_LIFETIME_MS + 1;
    return readAuthority(scope);
  };
  const buyerWire = await wireBuyer({ buyer: BUYER, seller: SELLER, listingPin: PIN, clock, connection, readAuthority: reader });
  const agent = stubAgent();
  const handle = { store: null, handler: null, finishFails: false };
  const mount = () => {
    const store = createSellerTransportStore({ path: storePath, maxJobs, maxRecords, now: clock });
    const finish = store.finish.bind(store);
    store.finish = (...args) => { if (handle.finishFails) throw new Error('TEST process died before the answer was stored'); return finish(...args); };
    const journalDirectory = join(directory, `wire-journal-${state.journals.length}`);
    mkdirSync(journalDirectory, { mode: 0o700 });
    state.journals.push(journalDirectory);
    const journal = openWireRequestJournal(journalDirectory, { leaseMs: JOURNAL_LEASE_MS, clock });
    const authentication = createSellerTransportServerAuth({ sellerSigner: { claim: seller.claim, sign: seller.signBytes }, listingPin: PIN, store, now: clock });
    const wire = createWireContext({ binding: buyerWire.binding, tp1Network: { connection, readAuthority: reader }, signer: sellerSigner, journal, store, ready: () => state.ready, now: clock, agent, requireDelegation: false });
    Object.assign(handle, { store, authentication, wire, handler: createSellerHttpHandler(agent, { authentication, wire, commitOnSignature }) });
  };
  mount();
  t.after(() => handle.store.close());
  const reopen = () => { handle.store.close(); handle.finishFails = false; mount(); };
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
    jobId, buyer: buyerClaim, seller: seller.claim, listingPin: PIN, agreementHash, nonce: nextNonce(), expiresAt, profile: buyerWire.binding.profile, ...rest });
  const headerFor = (payload, { signer = BUYER, domain = DACS_SELLER_HTTP_DOMAINS.request, delegation } = {}) => Buffer.from(canonicalize({ payload,
    signature: signer.sign(Buffer.from(domain + canonicalize(payload))).toString('base64url'), ...(delegation ? { delegation } : {}) })).toString('base64url');
  const delegationFor = ({ jobId, expiresAt, domain = DACS_SELLER_HTTP_DOMAINS.delegation, ...rest }) => {
    const payload = { version: '1', kind: 'seller-session-delegation', buyer: buyer.claim, seller: seller.claim, sessionPublicKey: publicKeyHex(session), listingPin: PIN, jobId,
      notBefore: NOW - SKEW_MS, expiresAt, profile: buyerWire.binding.profile, ...rest };
    return { payload, signature: BUYER.sign(Buffer.from(domain + canonicalize(payload))).toString('base64url') };
  };
  return { directory, state, agent, signing, buyerWire, handle, mount, reopen, post, send, verified, rows, journalFiles, effects, payloadFor, headerFor, delegationFor, storePath, clock };
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
  assert.equal(w.rows().peer_effects, refusedAnswers.length);
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

test('P11a1-T19: no request creates a wire journal file in this PR. Non-pre-Agreement effect routes reserve only in the old store. Round 4: both signed read routes reserve and complete nowhere, while returning their authenticated answers. This covers a known job, SA-10\'s unknown job, a live delegation, an expired delegation\'s readback, an old store at `peer_store_capacity`, and a restart. The old store sees zero statements and zero row changes, with no `reserve`, `classify`, `finish`, `reconcile` or `resume` call. The accounting, allocation and completion-hook counters do not exist yet; H-2\'s rerun asserts them as zero', async (t) => {
  const w = await world(t, { maxRecords: 2 });
  const job = await proposeJob(w, 't19');
  assert.equal((await job.post()).status, 200);
  assert.equal(w.rows().peer_effects, 1, 'the proposal reserved in the old store');
  const old = createSellerTransportClientAuth({ buyerSigner: BUYER, seller: seller.claim, resolveJob: () => ({ listingPin: PIN, agreementHash: job.agreementHash }), now: w.clock });
  const paymentBody = { jobId: job.jobId, payerPayingKey: buyer.claim, txHash: derive('payment').slice(0, 64) };
  const { header } = await old.request(PATHS.payments, paymentBody, JSON.stringify(paymentBody));
  const payment = await exchange(w.handle.handler, { url: PATHS.payments, text: JSON.stringify(paymentBody), header });
  assert.equal(payment.status, 200, 'payments are still on the old auth');
  assert.equal(w.rows().peer_effects, 2, 'and reserve in the old store');
  const refusedAtCapacity = await (await proposeJob(w, 't19-full')).post();
  assert.equal(refusedAtCapacity.body.error, 'peer_store_capacity', 'the old store is now at capacity for effects');

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
  assert.deepEqual(w.journalFiles(), [], 'no wire journal file exists');
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
  assert.deepEqual(routes.map(([path]) => path), [...WIRE_ROUTE_PATHS], 'every wire route is covered');
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
  const replay = await w.send(PATHS.commitmentSignature, signed);
  assert.equal(replay.status, 200);
  await w.verified(replay);
  assert.equal(w.agent.calls.signatureCommits, calls, 'the replay ran no second commitment');
  const unknown = jobFor('signature-unknown');
  const missing = await w.post(PATHS.commitmentSignature, { jobId: unknown }, { jobId: unknown, agreementHash: derive('signature-unknown') });
  assert.deepEqual({ status: missing.status, error: missing.body.error, signed: missing.signed }, { status: 404, error: 'peer_unknown_job', signed: true });
  await w.verified(missing);
  const unmounted = await world(t);
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
  const retried = await job.post();
  assert.equal(retried.status, 200);
  assert.deepEqual({ proposals: w.agent.calls.proposals, reconciled: w.agent.calls.reconciled }, { proposals, reconciled: 1 }, 'the retry reconciled the uncertain effect');
});

test('the wire context is checked where it is made and where the handler takes it: a member of the wrong kind, an unbranded copy, another delegation rule and another seller are each refused', async (t) => {
  const w = await world(t);
  const { binding, signer, journal, store } = w.handle.wire;
  const valid = { binding, tp1Network: { connection: () => ({ ...TEST_CONNECTION }) }, signer, journal, store, ready: () => true, now: w.clock, agent: w.agent, requireDelegation: false };
  const wrongKinds = { connection: { tp1Network: { connection: 1 } }, ready: { ready: 'yes' }, now: { now: NOW }, signer: { signer: { claim: seller.claim } }, store: { store: {} },
    agent: { agent: {} }, requireDelegation: { requireDelegation: 'no' }, binding: { binding: null }, journal: { journal: undefined } };
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
  const { binding, signer, journal, store } = w.handle.wire;
  const valid = { binding, tp1Network: { connection: () => ({ ...TEST_CONNECTION }) }, signer, journal, store, ready: () => true, now: w.clock, agent: w.agent, requireDelegation: false };
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
      assert.deepEqual(w.rows(), rowsBefore, `${route}: no tuple, nonce or effect was left (reopened: ${reopened})`);
      assert.deepEqual(w.agent.calls, callsBefore, `${route}: no agent work`);
    }
  }
});

test('wire-proposal-commitment-effect-before-finish', async (t) => {
  const w = await world(t);
  for (const route of ['proposals', 'commitments']) {
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
  try { assert.deepEqual(db.prepare('SELECT state, status, response FROM peer_effects').all(), [{ state: 'complete', status: 200, response: original }], 'the admitted text is stored unchanged'); } finally { db.close(); }
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
  assert.equal(w.rows().peer_effects, 1, 'the operation is retained across the restart');
  w.agent.credit = () => {};
  const restored = await job.post();
  assert.equal(restored.status, 200);
  assert.equal(restored.text, JSON.stringify({ disposition: 'complete', contribution: { signed: true } }));
  assert.equal(w.agent.calls.proposals, 1, 'the withheld answer did not become permission to repeat the effect');
});

test('bundles/buyer-copy stays on the old server auth: its committed-route evidence arrives with the continuation inputs, so a wire-signed request is refused', async (t) => {
  const w = await world(t);
  const job = await proposeJob(w, 'buyer-copy');
  const rowsBefore = w.rows(), callsBefore = { ...w.agent.calls };
  const text = JSON.stringify(identityBody(job.jobId, job.agreementHash));
  const header = w.headerFor(w.payloadFor(PATHS.bundleBuyerCopy, text, { jobId: job.jobId, agreementHash: job.agreementHash }));
  const refused = await w.send(PATHS.bundleBuyerCopy, { text, header });
  assert.ok(refused.status >= 400 && refused.status < 500, `refused by the old auth (${refused.status})`);
  assert.deepEqual(w.rows(), rowsBefore);
  assert.deepEqual(w.agent.calls, callsBefore);
});
