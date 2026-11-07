import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Server } from 'node:net';
import Database from 'better-sqlite3';
import { canonicalize, generateCanonicalJobId, identityBundleHash, sha256Hex } from '@kynesyslabs/dacs';
import { createSellerTransportStore, createSellerTransportServerAuth, createSellerTransportClientAuth,
  sellerContextScopeHash, sellerContextChallengeScope, SELLER_CONTEXT_PATH, SELLER_CONTEXT_CHALLENGE_PATH,
  sellerSessionDelegationSigningBytes, SellerTransportError } from '../src/dacs/seller-transport-auth.mjs';
import { TP1_APPROVED_IDENTITY_RECORD, TP1_PROFILE_ID, TP1_PROFILE_REVISION, TP1_BASE_REVISION } from '@kynesyslabs/dacs/wire';
import { createSellerChallengeLedger } from '../src/dacs/seller-challenge-ledger.mjs';
import { createSellerContextRoute } from '../src/dacs/seller-context-route.mjs';
import { createSellerHttpHandler } from '../src/dacs/seller-http.mjs';
import { KIT_TP1_VET_MODE } from '../src/host.mjs';
import { createSellerContextAdmission, releaseSellerContextHolds, parsePolicyLedger } from '../src/devnet-demo/operator-approval.mjs';
import { fixtureListing } from './fixtures/listings.mjs';
import { NOW, testWallet, buyer as agentBuyer, seller as agentSeller } from './helpers/protocol-fixture.mjs';
import { proposalAdmissionFixture } from './helpers/proposal-admission-fixture.mjs';
import { createSellerDurableState } from '../src/dacs/seller-durable-state.mjs';
import { createSellerAgent } from '../src/dacs/seller-agent.mjs';
import { listingPin } from '../src/dacs/purchase-protocol.mjs';
import { purchaseSupport } from '../src/dacs/listing.mjs';
import { AGREEMENT_CONTEXT_SOURCE } from '../src/dacs/agreement-context-consumer.mjs';
import { exchange } from './helpers/d5-http-fixture.mjs';
import { admittedSession } from './helpers/challenge-api.mjs';
import { commitmentFixture } from './helpers/commitment-fixture.mjs';
import { privateModule } from './helpers/private-module.mjs';
import { testNetwork } from './helpers/wire-authority-fixture.mjs';

const T0 = Date.UTC(2026, 9, 27, 12), HOUR = 3600000, DEADLINE = 10000;
const buyer = testWallet(1), seller = testWallet(2);
const JOB = generateCanonicalJobId({ timestamp: T0, entropy: new Uint8Array(10).fill(0x11) });
const JOB2 = generateCanonicalJobId({ timestamp: T0, entropy: new Uint8Array(10).fill(0x22) });
const defaultParties = { buyer, seller };
const signer = wallet => ({ claim: wallet.claim, sign: wallet.signBytes });
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const barrier = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const errorOf = async promise => { try { await promise; } catch (error) { return error; } assert.fail('expected refusal'); };
const titles = {
  "T05": "every context-step refusal records `failed` with its code; an identical retry answers that cause without validating",
  "T06": "a body-check refusal after the attempt records `failed`; no current-generation row is left `attempted`",
  "T10": "an expired delegation cannot issue or attempt through the guarded store",
  "T11": "today's route answers every issue refusal with its code and zero ledger mutations",
  "T12": "host start closes earlier-generation attempts before the listener opens",
  "T14": "an in-process stop request refuses issuance with `seller_stopped` and zero rows",
  "T20": "with `maxRecords` 1 and the clock advanced past the nonce window each time, three signed context requests naming an unknown, a consumed and a mismatched challenge each refuse with their K1 code while `peer_nonces` and `peer_nonce_retention` never exceed one row each (expired rows are reclaimed before any refusal is recorded; a dry-run `classify` writes nothing), also after reopening, and the ledger gains no row for the unknown nonce",
  "T15": "the existing route- and store-level challenge tests pass unchanged in name on the one ledger",
  "T16": "the buyer-access callback rejecting, never settling, settling at 9,999 ms and at 10,000 ms, and refusing or succeeding after the deadline, each on issuance, first admission and resume: a timeout answers 503 `session_admission_unavailable` with its cause and `buyer_access_closed` keeps its code; issuance touches no ledger; the first admission's owner records `failed` by CAS; resume answers null; a late result runs no issuer, hold, reservation or effect; a later independent issuance completes",
  "T17": "the same cases for the known-job callback, with `context_job_unknown` keeping its code; resume's refusal leaves the accepted row and its ownership unchanged",
  "T18": "through the composed host, a `contextSessionState` answering a DACS-5 terminal state lets reclamation take eligible rows once; nonterminal, `null`, throwing, agent-stage and Promise-returning answers keep them. Round 3: a rejected Promise, a rejecting thenable, a thenable whose `then` throws and a Promise fulfilled with a terminal name each keep the rows; the host stays alive, an `unhandledRejection` listener sees nothing, and the late fulfilment reclaims nothing; a later synchronous terminal answer then reclaims the eligible rows once. The same after a restart and after a live change to terminal; a host without the option reclaims nothing"
};
Object.assign(titles, {
  "T01": "one nonce issued by the challenge route is accepted at the context step and continued by the proposal: one row, one admission read, zero writes at the proposal",
  "T02": "a restart between the context step and the proposal still continues from the durable row, and after the restart a second, different presentation for the same job refuses `job_taken`",
  "T03": "table: proposal entry × same buyer, other buyer, canonical-equivalent buyer argument with advisory parameters, other complete bundle and other job × live/restarted store. After real context acceptance the identical retained complete bundle continues for the same or equivalent buyer without a new admission read or write, including after expiry; another buyer/job/bundle refuses `session_not_admitted` with the SA-11 ledger cause and leaves the accepted row unchanged. Advisory equivalence never permits changing retained bundle bytes. Add a bundle dimension (plain, and carrying top-level `signature` and `signatures` extension members, re-presented over `identityBundleHash`) and make every completing cell read the retained session (`stageOf`) and reopen the agent: the retained-session reader accepts it, with no `seller_state_unverified` live or after reopening, while another buyer, job or bundle still refuses. Repeat through the operator proposal-first path while SA-3 exists; ledger-only issuance/attempt/retained cells are P09a1-T13",
  "T04": "an identical proposal during the context step's validation is `session_admission_unavailable` 503 with zero writes",
  "T07": "after a full flow there is no `peer_context_challenges` table, no `session-challenge:` row, and no limit helper in the packed files",
  "T08": "the client's self-derived nonce is still refused with today's code and message",
  "T09": "an operator-issued nonce is first-admitted by the proposal; the same nonce on the context route fails as a mismatch",
  "T13": "with the shipped guard off, both issuers refuse `kit_operation_guard_off` with zero rows",
  "T19": "`agent.issueSessionChallenge` and `host.issueSessionChallenge` with no configured session admission each refuse `session_admission_unavailable` 503 before ledger issuance, with zero rows and writes; reopening the store still finds no nonce. Controls: with session admission configured the existing operator path works, and guard/stop refusals keep their existing precedence",
});
const card = id => `P09a2-${id} ${titles[id]}`;

// `options.parties`, `options.listing` and `options.time` let the composed agent tests share the route's store and clock.
async function fixture(t, options = {}) {
  const { buyer, seller } = options.parties ?? defaultParties;
  const directory = await mkdtemp(join(tmpdir(), 'TEST-one-nonce-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'transport.sqlite'), listing = options.listing ?? fixtureListing(seller, { now: T0 }), pin = listingPin(listing), support = purchaseSupport(listing);
  let time = options.time ?? T0, store, generation = 0;
  const calls = { access: 0, known: 0, admission: 0, holds: 0, effects: 0, releases: 0 };
  const policy = { access: () => {}, known: () => true, hold: () => null, ...options.policy,
    admission: options.policy?.admission ?? (({ jobId, bundle }) => admittedSession({ jobId, bundle, bundleHash: identityBundleHash(bundle), seller: seller.claim, listingPin: pin })) };
  const open = () => store = createSellerTransportStore({ path, now: () => time, generation: `TEST-generation-${++generation}`, ...options.store });
  open(); t.after(() => store.close());
  const route = createSellerContextRoute({ listing, now: () => time, writable: () => true,
    assertBuyerAccess: async value => { calls.access++; return policy.access(value); },
    knownJob: async (...args) => { calls.known++; return policy.known(...args); },
    admitPresentation: async value => { calls.admission++; return policy.admission(value); },
    admitWrites: async value => { calls.holds++; return policy.hold(value); },
    releaseWrites: async value => { calls.releases++; return policy.release?.(value); },
    resolveBuyer: async body => { calls.effects++; return { disposition: 'present', value: { scope: body.scope } }; },
    recover: async body => policy.recover?.(body) ?? null, resumable: async body => policy.resumable?.(body) ?? null });
  const rows = (table = 'kit_challenges') => {
    const db = new Database(path, { readonly: true });
    try { return db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table) ? db.prepare(`SELECT * FROM ${table}`).all() : []; } finally { db.close(); }
  };
  const scope = (jobId = JOB) => ({ source: AGREEMENT_CONTEXT_SOURCE, wallet: buyer.address, jobId, buyer: buyer.claim,
    buyerBundleHash: sha256Hex('TEST placeholder'), seller: seller.claim, listingPin: pin,
    rail: { railId: 'demos-native:DEM', railVersion: 1 }, payee: support.payee, price: support.price, generatedAt: time });
  const challengeBody = (jobId = JOB) => ({ scope: sellerContextChallengeScope(scope(jobId)) });
  const request = (body, path = SELLER_CONTEXT_PATH) => ({ version: '1', kind: 'request', buyer: buyer.claim, seller: seller.claim,
    jobId: body.scope.jobId, listingPin: pin, agreementHash: sellerContextScopeHash(body.scope), method: 'POST', path,
    bodyHash: sha256Hex(JSON.stringify(body)), nonce: Buffer.from(`TEST-${time}-${generation}`).toString('base64url'), issuedAt: time, expiresAt: time + 60000 });
  const issue = async (jobId = JOB) => { const body = challengeBody(jobId); return route.challenge(request(body, SELLER_CONTEXT_CHALLENGE_PATH), body, store); };
  const input = async (jobId = JOB, amend = () => {}) => {
    const { sessionNonce } = await issue(jobId);
    const bundle = { bundleVersion: '1', presentedBy: buyer.claim, presentedAt: time, sessionNonce, claims: [{ ref: buyer.claim }] };
    amend(bundle);
    bundle.presentation = { kind: 'per-claim', signatures: [{ ref: buyer.claim, signature: buyer.signBytes(Buffer.from('dacs-bundle-presentation:v1:' + identityBundleHash(bundle))).toString('base64url') }] };
    const body = { scope: { ...scope(jobId), buyerBundleHash: identityBundleHash(bundle) }, buyerIdentityBundle: bundle };
    return { body, request: request(body), nonce: sessionNonce };
  };
  const http = async (body, routePath = SELLER_CONTEXT_PATH) => {
    const auth = createSellerTransportServerAuth({ sellerSigner: signer(seller), listingPin: pin, store, now: () => time });
    const client = createSellerTransportClientAuth({ buyerSigner: signer(buyer), seller: seller.claim,
      resolveJob: () => ({ listingPin: pin, agreementHash: sellerContextScopeHash(body.scope) }), now: () => time });
    const text = JSON.stringify(body), { header } = await client.request(routePath, body, text);
    return { handler: createSellerHttpHandler({ claim: seller.claim, listingPin: pin }, { authentication: auth, context: route }), text, header, url: routePath };
  };
  return { route, calls, policy, rows, scope, challengeBody, request, issue, input, http, path, listing, pin,
    get store() { return store; }, advance: ms => { time += ms; }, now: () => time,
    reopen() { store.close(); open(); }, closeLost() { store.challenges.closeLostValidations(); store.recoverLostContextReservations(); } };
}


test(card('T05'), async t => {
  for (const point of ['scope', 'access', 'known', 'admission', 'hold', 'untyped', 'malformedAdmission', 'malformedCode', 'acceptanceSave']) await t.test(point, async t => {
    const f = await fixture(t), input = await f.input();
    const code = { scope: 'context_scope_invalid', access: 'buyer_access_closed', known: 'context_job_unknown',
      admission: 'session_not_admitted', hold: 'seller_budget_refused', untyped: 'operation_uncertain', malformedAdmission: 'session_admission_unavailable', malformedCode: 'operation_uncertain', acceptanceSave: 'EIO' }[point];
    if (point === 'scope') input.body.scope.buyerBundleHash = sha256Hex('TEST wrong digest');
    if (point === 'access') f.policy.access = () => { throw new SellerTransportError(code, 409); };
    if (point === 'known') f.policy.known = () => false;
    if (point === 'admission') f.policy.admission = () => { throw new SellerTransportError(code, 409); };
    if (point === 'acceptanceSave') {
      const prepare=Database.prototype.prepare;
      t.mock.method(Database.prototype,'prepare',function(sql){
        const statement=prepare.call(this,sql);
        if(sql.startsWith('UPDATE kit_context_reservations SET accepted = 1'))statement.run=()=>{throw Object.assign(new Error('TEST acceptance marker save failed'),{code:'EIO'});};
        return statement;
      });
    }
    if (point === 'malformedCode') f.policy.admission = () => { throw Object.assign(new Error('TEST malformed refusal code'),{code:''}); };
    if (point === 'malformedAdmission') f.policy.admission = () => null;
    if (point === 'hold') f.policy.hold = () => 'TEST refused';
    if (point === 'untyped') f.policy.admission = () => { throw new Error('TEST admission interrupted'); };
    const error = await errorOf(f.route.reserve(input.request, input.body, f.store));
    assert.equal(typeof error.code==='string' && error.code ? error.code : 'operation_uncertain', code);
    const row = f.store.challenges.retained(input.nonce); assert.equal(row.state, 'failed'); assert.equal(row.failure.code, code);
    if(point==='acceptanceSave'){assert.equal(f.rows('kit_context_reservations').length,0);assert.equal(f.rows('peer_effects').length,0);assert.equal(f.calls.releases,1);}
    const counts = { ...f.calls };
    const retry = await errorOf(f.route.reserve({ ...input.request }, input.body, f.store));
    assert.equal(retry.code, 'context_challenge_failed'); assert.equal(retry.cause, code);
    assert.deepEqual(f.calls, counts); assert.equal(f.calls.effects, 0);
  });
});

test(card('T06'), async t => {
  const f = await fixture(t), input = await f.input();
  input.body.extra = true;
  const wire = await f.http(input.body), response = await exchange(wire.handler, wire);
  assert.equal(response.status, 409); assert.equal(JSON.parse(response.text).error, 'peer_context_mismatch');
  const retained = f.store.challenges.retained(input.nonce);
  assert.equal(retained.state, 'failed'); assert.equal(retained.failure.code, 'peer_context_mismatch');
  assert.equal(f.calls.admission, 0); assert.equal(f.calls.holds, 0); assert.equal(f.calls.effects, 0);
});

test(card('T10'), async t => {
  const f = await fixture(t), body = f.challengeBody(), session = testWallet(3);
  const payload = { version: '1', kind: 'seller-session-delegation', buyer: buyer.claim, sessionPublicKey: session.claim.slice('did:demos:agent:'.length),
    seller: seller.claim, listingPin: f.pin, jobId: JOB, notBefore: T0, expiresAt: T0 + 1000 };
  const delegation = { payload, signature: buyer.signBytes(sellerSessionDelegationSigningBytes(payload)).toString('base64url') };
  const auth = createSellerTransportServerAuth({ sellerSigner: signer(seller), listingPin: f.pin, store: f.store, now: f.now, requireDelegation: true });
  const client = createSellerTransportClientAuth({ sessionSigner: signer(session), delegation, seller: seller.claim, now: f.now, lifetimeMs: 100,
    resolveJob: () => ({ listingPin: f.pin, agreementHash: sellerContextScopeHash(body.scope) }) });
  const text = JSON.stringify(body), { header } = await client.request(SELLER_CONTEXT_CHALLENGE_PATH, body, text);
  const request = auth.readRequest(header); auth.validate(request, { method: 'POST', path: SELLER_CONTEXT_CHALLENGE_PATH, rawBody: Buffer.from(text), body });
  f.advance(1000);
  for (const action of [() => auth.store.challenges.issue(request, sellerContextScopeHash(body.scope)),
    () => auth.store.challenges.issueForOperator(request), () => auth.store.challenges.attempt({ request })]) assert.throws(action, { code: 'peer_delegation_expired' });
  assert.equal(f.rows().length, 0); assert.equal(f.calls.holds, 0); assert.equal(f.calls.effects, 0);
});

test(card('T11'), async t => {
  const changes = [null, ...['source', 'wallet', 'seller', 'listingPin', 'rail', 'payee', 'price'].map(field => field),
    -600001, -600000, 600001, 'unsafe', 'string', 'job', 'requestJob', 'access', 'known', 'clock'];
  for (const change of changes) await t.test(String(change), async t => {
    const f = await fixture(t), body = f.challengeBody(), request = f.request(body, SELLER_CONTEXT_CHALLENGE_PATH);
    let expected = 'context_scope_invalid';
    if (change === null || change === -600000) expected = null;
    if (['source', 'wallet', 'seller', 'payee'].includes(change)) body.scope[change] = 'TEST other';
    if (change === 'listingPin' || change === 'rail') body.scope[change] = { ...body.scope[change], [change === 'rail' ? 'railVersion' : 'version']: 2 };
    if (change === 'price') body.scope.price = { ...body.scope.price, amount: '99' };
    if (typeof change === 'number') { body.scope.generatedAt += change; if (expected) expected = 'context_generated_at'; }
    if (change === 'unsafe' || change === 'string') { body.scope.generatedAt = change === 'unsafe' ? 2 ** 53 : String(T0); expected = 'context_generated_at'; }
    if (change === 'job') { body.scope.jobId = JOB2; expected = 'peer_job_mismatch'; }
    if (change === 'requestJob') { request.jobId = JOB.toLowerCase(); expected = 'peer_job_invalid'; }
    if (change === 'access') { f.policy.access = () => { throw new SellerTransportError('buyer_access_closed', 409); }; expected = 'buyer_access_closed'; }
    if (change === 'known') { f.policy.known = () => false; expected = 'context_job_unknown'; }
    if (change === 'clock') { f.advance(600001); expected = 'context_generated_at'; }
    let mutations = 0;
    const prepare = Database.prototype.prepare;
    t.mock.method(Database.prototype, 'prepare', function (sql) { if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) mutations++; return prepare.call(this, sql); });
    if (expected) assert.equal((await errorOf(f.route.challenge(request, body, f.store))).code, expected);
    else assert.match((await f.route.challenge(request, body, f.store)).sessionNonce, /^[0-9a-f]{64}$/);
    assert.equal(mutations, expected ? 0 : 1); t.mock.restoreAll();
    assert.equal(f.rows().length, expected ? 0 : 1); assert.equal(f.calls.holds, 0); assert.equal(f.calls.effects, 0);
  });
});

async function hostFixture(t, edit = source => source) {
  const f = await commitmentFixture(t, { vetMode: KIT_TP1_VET_MODE }), dataDirectory = await mkdtemp(join(tmpdir(), 'TEST-one-nonce-host-'));
  const { nativeArtifactAnchor, ...config } = f.config;
  // The host builds its own durable directory, ledger and signing mode, and fixes the Vet mode (`vetMode` is an agent option, not a host option).
  for (const name of ['durableDirectory', 'commitOnSignature', 'challengeLedger', 'vetMode']) delete config[name];
  let current;
  const api = await privateModule(new URL('../src/host.mjs', import.meta.url), ['testStore', 'setStartupFailure'], source => edit(
    source.replace("const generation = randomBytes(16).toString('hex');", "if (failStartup) throw new Error('TEST generation source failed'); const generation = randomBytes(16).toString('hex');").replace('openWireRequestJournal(journalDirectory, { leaseMs: KIT_JOURNAL_LEASE_MS, clock: now });', 'void journalDirectory;').replace('const REQUIRED =', 'let testStore; let failStartup = false; function setStartupFailure(value) { failStartup = value; }\nconst REQUIRED =').replace('opened.push(() => store.close());', 'testStore = store; opened.push(() => store.close());')));
  const start = async changes => current = await api.startSellerHost({ ...config, artifactAnchor: nativeArtifactAnchor,
    dataDirectory, tp1Network: testNetwork(), now: () => NOW, ...changes });
  t.after(async () => { await current?.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  return { start, api, close: () => current.close(), path: join(dataDirectory, 'transport', 'transport.sqlite') };
}

test(card('T12'), async t => {
  const f = await hostFixture(t);
  f.api.setStartupFailure(true); await assert.rejects(f.start(), /TEST generation source failed/);
  f.api.setStartupFailure(false); const first = await f.start();
  const challenge = f.api.testStore.challenges.issue({ jobId: JOB, buyer: buyer.claim }, sha256Hex('TEST scope'));
  f.api.testStore.challenges.attempt({ path: 'context', jobId: JOB, buyer: buyer.claim, nonce: challenge.sessionNonce,
    challengeScopeHash: sha256Hex('TEST scope'), presentationHash: sha256Hex('TEST presentation') });
  const old = f.api.testStore.challenges.retained(challenge.sessionNonce); await first.close();
  let listens = 0; const listen = Server.prototype.listen;
  t.mock.method(Server.prototype, 'listen', function (...args) {
    listens++; const row = f.api.testStore.challenges.retained(challenge.sessionNonce);
    assert.equal(row.state, 'failed'); assert.equal(row.failure.code, 'validator_lost'); return listen.apply(this, args);
  });
  await f.start(); assert.equal(listens, 1);
  assert.equal(f.api.testStore.challenges.retained(challenge.sessionNonce).owner.generation, old.owner.generation);
});

test(card('T14'), async t => {
  const stop = await privateModule(new URL('../src/devnet-demo/stop-request.mjs', import.meta.url), []);
  const f = await fixture(t, { store: { stopped: stop.stopRequested } });
  stop.requestStop();
  assert.equal((await errorOf(f.issue())).code, 'seller_stopped'); assert.equal(f.rows().length, 0);
});

test(card('T20'), async t => {
  for (const reopen of [false, true]) for (const variant of ['unknown', 'consumed', 'mismatched']) await t.test(`${variant} reopened=${reopen}`, async t => {
    const f = await fixture(t, { store: { maxRecords: 1 } }), input = await f.input(), body = structuredClone(input.body);
    // Leave a completed, expired transport nonce at capacity before each signed refusal.
    const prior = f.request({scope:f.scope(JOB2)}, '/dacs/v1/agreements/proposals');
    const reservation = f.store.reserve(prior, {}); f.store.finish(reservation, 200, '{}');
    if (variant === 'unknown') body.buyerIdentityBundle.sessionNonce = sha256Hex('TEST unknown');
    if (variant === 'consumed') {
      const attempt = f.store.challenges.attempt({path:'context',nonce:input.nonce,jobId:JOB,buyer:buyer.claim,
        challengeScopeHash:sellerContextScopeHash(sellerContextChallengeScope(body.scope)),presentationHash:sha256Hex('TEST other presentation')});
      f.store.challenges.recordFailed(attempt.owner,input.nonce,'TEST refused');
    }
    if (variant === 'mismatched') body.scope.generatedAt++;
    f.advance(60001); if(reopen)f.reopen();
    const before = f.rows(), nonces = f.rows('peer_nonces');
    f.store.classify(f.request(body),body); assert.deepEqual(f.rows(),before); assert.deepEqual(f.rows('peer_nonces'),nonces);
    const wire = await f.http(body), response = await exchange(wire.handler,wire);
    assert.equal(response.status,409); assert.equal(JSON.parse(response.text).error,variant==='consumed'?'context_challenge_consumed':'context_challenge_mismatch');
    assert.equal(f.rows('peer_nonces').length,1); assert.equal(f.rows('peer_nonce_retention').length,1);
    assert.equal(f.rows().length,1); assert.equal(f.calls.holds,0); assert.equal(f.calls.effects,0);
    if(variant==='unknown')assert.deepEqual(f.rows(),before,'unknown nonces create no ledger row');
  });
});

test(card('T15'), () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--import', new URL('./helpers/kit-guard-fixture.mjs', import.meta.url).pathname, '--test', '--test-name-pattern=^(T[1-6] |B(2[3-9]|30) )',
    'packages/dacs-seller/test/d5-challenge-retention.test.mjs', 'packages/dacs-seller/test/d5-limits-before-effects.test.mjs'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass [1-9]/);
});

for (const [id, port, code] of [['T16', 'access', 'buyer_access_closed'], ['T17', 'known', 'context_job_unknown']]) test(card(id), async t => {
  for (const stage of ['issue', 'first', 'resume']) for (const outcome of ['reject', 'policy', 'never', '9999', '10000', 'late-refuse', 'late-success']) {
    await t.test(`${stage} ${outcome}`, async t => {
      const f = await fixture(t), input = stage === 'issue' ? null : await f.input();
      let reservation;
      if (stage === 'resume') {
        reservation = await f.route.reserve(input.request, input.body, f.store);
        f.store.finish(reservation, 503, '{}'); reservation = f.store.reserve(input.request, input.body);
      }
      const gate = barrier(), cause = new Error('TEST policy read interrupted');
      f.policy[port] = () => outcome === 'reject' ? Promise.reject(cause)
        : outcome === 'policy' ? Promise.reject(new SellerTransportError(code, 409)) : gate.promise;
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const beforeJournal = f.rows('peer_effects');
      const before = f.rows(), effects = f.calls.effects, holds = f.calls.holds;
      const work = stage === 'issue' ? f.issue() : stage === 'first' ? f.route.reserve(input.request, input.body, f.store)
        : f.route.resume(reservation, input.request, f.store, { writes: 1 });
      let settled = false; const observed = work.then(value => ({ value }), error => ({ error })).then(value => { settled = true; return value; });
      await flush();
      if (!['reject', 'policy'].includes(outcome)) {
        t.mock.timers.tick(DEADLINE-1); await flush(); assert.equal(settled, false);
        if (outcome === '9999') gate.resolve(true);
        else { t.mock.timers.tick(1); if(outcome==='10000')gate.resolve(true); }
      }
      await flush(); const result = await observed;
      if (outcome === '9999') assert.ok(stage === 'issue' ? result.value?.sessionNonce : result.value?.disposition === 'perform');
      else if (stage === 'resume') { assert.equal(result.value, null); assert.deepEqual(f.rows(), before); assert.deepEqual(f.rows('peer_effects'), beforeJournal); }
      else {
        assert.equal(result.error?.code, outcome === 'policy' ? code : 'session_admission_unavailable');
        if (outcome !== 'policy') { assert.equal(result.error.status, 503); if(outcome==='reject')assert.equal(result.error.cause,cause);else assert.equal(result.error.cause?.name,'TimeoutError'); }
        if (stage === 'issue') assert.equal(f.rows().length, 0);
        else { const row = f.store.challenges.retained(input.nonce); assert.equal(row.state, 'failed'); assert.equal(row.failure.code, result.error.code); }
      }
      if (outcome !== '9999') {
        const saved = f.rows();
        if (outcome === 'late-refuse') gate.reject(new SellerTransportError(code, 409)); else if(outcome!=='never')gate.resolve(true);
        await flush(); assert.deepEqual(f.rows(), saved); assert.equal(f.calls.holds, holds); assert.equal(f.calls.effects, effects);
        f.policy[port] = () => true; assert.ok((await f.issue(JOB2)).sessionNonce, 'independent issuance is not blocked');
      }
      t.mock.timers.reset();
    });
  }
});

test(card('T18'), async t => {
  const f = await hostFixture(t); let state = null;
  const unhandled = []; const listener = reason => unhandled.push(reason); process.on('unhandledRejection', listener); t.after(() => process.off('unhandledRejection', listener));
  await f.start({ contextSessionState: ({ jobId }) => jobId === JOB ? (typeof state === 'function' ? state() : state) : null });
  const seed = () => f.api.testStore.challenges.issue({ jobId: JOB, buyer: buyer.claim }, sha256Hex('TEST terminal scope'));
  const nonce = seed().sessionNonce;
  // The unused wire journal is substituted above: the sandbox denies ancestor-directory fsync.
  // Fill the host's actual capacity without exposing a production sizing option.
  const db = new Database(f.path);
  const row = db.prepare('SELECT * FROM kit_challenges WHERE nonce = ?').get(nonce);
  const columns = Object.keys(row), insert = db.prepare(`INSERT INTO kit_challenges (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  db.transaction(() => { for (let i = 1; i < 10000; i++) insert.run(...columns.map(key => key === 'nonce' ? sha256Hex(`TEST terminal ${i}`) : row[key])); })();
  db.prepare('UPDATE kit_challenges SET issuedAt = ?, expiresAt = ?').run(NOW - HOUR, NOW - 1); db.close();
  const attempt = () => f.api.testStore.challenges.issue({ jobId: JOB2, buyer: buyer.claim }, sha256Hex('TEST new scope'));
  const answers = [null, 7, {}, 'negotiating', 'delivered', () => { throw new Error('TEST state read'); }, () => Promise.reject(new Error('TEST rejection')),
    () => ({ then(_yes, no) { no(new Error('TEST thenable')); } }), () => ({ get then() { throw new Error('TEST then getter'); } }), () => Promise.resolve('finalised')];
  for (const answer of answers) { state = answer; assert.throws(attempt, { code: 'context_challenge_capacity' }); await flush(); }
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(unhandled, []);
  await f.close(); await f.start();
  assert.throws(attempt, { code: 'context_challenge_capacity' }, 'a host without the capability reclaims nothing');
  await f.close();
  await f.start({ contextSessionState: ({ jobId }) => jobId === JOB ? (typeof state === 'function' ? state() : state) : null });
  state = null; assert.throws(attempt, { code: 'context_challenge_capacity' });
  state = 'finalised'; assert.equal(attempt().expiresAt, NOW + 600000);
  const count = new Database(f.path, { readonly: true }); assert.equal(count.prepare('SELECT count(*) n FROM kit_challenges').get().n, 10000); count.close();
  // One old row was reclaimed and one new row inserted; repeated issuance reuses it.
  assert.equal(attempt().sessionNonce, attempt().sessionNonce);
});

test('context-challenge-route-lost-answer', async t => {
  const f = await fixture(t), wire = await f.http(f.challengeBody(), SELLER_CONTEXT_CHALLENGE_PATH);
  const first = await exchange(wire.handler, wire); f.reopen();
  const retry = await f.http(f.challengeBody(), SELLER_CONTEXT_CHALLENGE_PATH), second = await exchange(retry.handler, retry);
  assert.equal(first.status, 200); assert.equal(second.status, 200); assert.equal(second.text, first.text);
  assert.equal(f.rows().length, 1); assert.equal(f.calls.holds, 0); assert.equal(f.calls.effects, 0);
});

test('context-refusal-save-restart', async t => {
  for (const saveFails of [false,true]) await t.test(`saveFails=${saveFails}`, async t => {
    const f = await fixture(t), input = await f.input();
    f.policy.admission = () => { throw new SellerTransportError('session_not_admitted',409); };
    if(saveFails) {
      const prepare=Database.prototype.prepare;
      t.mock.method(Database.prototype,'prepare',function(sql){
        const statement=prepare.call(this,sql);
        if(sql.startsWith("UPDATE kit_challenges SET state = 'failed'"))statement.run=()=>{throw Object.assign(new Error('TEST refusal save interrupted'),{code:'EIO'});};
        return statement;
      });
    }
    assert.equal((await errorOf(f.route.reserve(input.request,input.body,f.store))).code,saveFails?'EIO':'session_not_admitted');
    t.mock.restoreAll();
    assert.equal(f.store.challenges.retained(input.nonce).state,saveFails?'attempted':'failed');
    f.reopen();f.closeLost();const before={...f.calls};
    const retry=await errorOf(f.route.reserve({...input.request},input.body,f.store));
    assert.equal(retry.code,'context_challenge_failed');assert.equal(retry.cause,saveFails?'validator_lost':'session_not_admitted');assert.deepEqual(f.calls,before);
    assert.equal(f.calls.holds,0);assert.equal(f.calls.effects,0);
  });
});

test('legacy-context-pending-owner-crash', async t => {
  for (const stage of ['unaccepted','accepted','refused']) await t.test(stage, async t => {
    const accepted=stage==='accepted';
    const f = await fixture(t), input = await f.input(), effectPath = join(dirname(f.path), 'policy.jsonl');
    const config = { evidencePath: effectPath, sellerApproval: { mode: 'policy', maxWriteTotalOs: '4', maxWritesPerHour: 2, maxTotalOsPerHour: '8' }, now: f.now };
    const policy = createSellerContextAdmission(config);
    f.policy.hold = value => policy.reserve(value);
    f.policy.release = ({ jobId, hold }) => releaseSellerContextHolds({ ...config, jobId, holdId: hold });
    let reservation;
    if (accepted) reservation = await f.route.reserve(input.request, input.body, f.store);
    else {
      f.route.onRejectedBody(input.request, input.body, f.store);
      reservation = f.store.reserve(input.request, input.body, { admit: f.now, challengeNonce: input.nonce });
      assert.equal(await policy.reserve({ jobId: JOB, effect: reservation.effectKey, writes: 2, hold: reservation.effectKey }), null);
    }
    if(stage==='refused')f.store.challenges.recordFailed(f.store.challenges.retained(input.nonce).owner,input.nonce,'seller_budget_refused');
    assert.equal(f.store.contextHoldState({ jobId: JOB, effect: reservation.effectKey }), 'pending');
    if (accepted) {
      const db = new Database(f.path);
      // An older failed challenge for this job must not erase its later accepted reservation.
      db.prepare("INSERT INTO kit_challenges (nonce,jobId,buyer,challengeScopeHash,origin,issuedAt,expiresAt,state,failure) SELECT ?,jobId,buyer,challengeScopeHash,origin,issuedAt,expiresAt,'failed',? FROM kit_challenges WHERE nonce = ?").run(sha256Hex('TEST earlier failed challenge'), JSON.stringify({code:'context_challenge_expired'}), input.nonce);
      db.close();
    }
    f.reopen(); f.store.challenges.closeLostValidations();
    const beforeNonces = f.rows('peer_nonces'), prepare = Database.prototype.prepare;
    t.mock.method(Database.prototype,'prepare',function(sql){
      const statement = prepare.call(this,sql);
      if(sql.startsWith(accepted ? "UPDATE peer_effects SET state = 'uncertain'" : 'DELETE FROM peer_effects')) {
        statement.run = () => { throw Object.assign(new Error('TEST recovery commit interrupted'),{code:'EIO'}); };
      }
      return statement;
    });
    assert.throws(()=>f.store.recoverLostContextReservations(),{code:'EIO'}); t.mock.restoreAll();
    assert.deepEqual(f.rows('peer_nonces'),beforeNonces); assert.equal(f.rows('peer_effects')[0].state,'pending');
    f.reopen(); f.closeLost(); const startup = createSellerContextAdmission({ ...config, transportStore: f.store }); await startup.ready;
    f.policy.hold = value => startup.reserve(value);
    const result = accepted ? await f.route.reserve(input.request, input.body, f.store) : await errorOf(f.route.reserve({ ...input.request }, input.body, f.store));
    if (!accepted) {
      assert.equal(result.code, 'context_challenge_failed'); assert.equal(result.cause, stage==='refused'?'seller_budget_refused':'validator_lost');
      assert.equal(JSON.parse(f.rows('peer_nonces')[0].response).cause,result.cause);
      assert.ok(parsePolicyLedger(await readFile(effectPath, 'utf8')).rows.every(row => row.released));
    } else {
      assert.equal(f.store.challenges.retained(input.nonce).accepted.buyerBundleText,canonicalize(input.body.buyerIdentityBundle));
      assert.equal(result.disposition, 'uncertain'); assert.equal(await f.route.reconcile({ body: input.body }), null);
      assert.equal(f.calls.effects, 0); f.policy.resumable = () => ({ writes: 1 });
      const proof = await f.route.reconcile({ body: input.body }); assert.equal(proof.disposition, 'resume');
      const resumed = await f.route.resume(result, input.request, f.store, proof); assert.equal(resumed.disposition, 'perform');
      assert.notEqual(resumed.owner, reservation.owner);
      assert.throws(() => f.store.finish(reservation, 200, '{}'), { code: 'peer_store_conflict' });
      f.store.finish(resumed, 200, '{}'); await f.route.settled(resumed.contextHold);
      const rows = parsePolicyLedger(await readFile(effectPath, 'utf8')).rows;
      assert.equal(rows.length, 2); assert.ok(rows.every(row => row.released));
    }
    assert.equal(f.calls.effects, 0);
  });
});

test('legacy-context-reclaimed-acceptance-keeps-uncertainty', async t => {
  let terminal=false;
  const f=await fixture(t,{store:{maxChallenges:2,contextSessionState:({jobId})=>terminal&&jobId===JOB?'finalised':null}}),input=await f.input();
  const evidencePath=join(dirname(f.path),'reclaimed-policy.jsonl');
  const config={evidencePath,sellerApproval:{mode:'policy',maxWriteTotalOs:'4',maxWritesPerHour:2,maxTotalOsPerHour:'8'},now:f.now};
  const policy=createSellerContextAdmission(config);f.policy.hold=value=>policy.reserve(value);
  const reservation=await f.route.reserve(input.request,input.body,f.store);
  const db=new Database(f.path);
  db.prepare("INSERT INTO kit_challenges (nonce,jobId,buyer,challengeScopeHash,origin,issuedAt,expiresAt,state,failure) SELECT ?,jobId,buyer,challengeScopeHash,origin,issuedAt+1,expiresAt+1,'failed',? FROM kit_challenges WHERE nonce=?").run(sha256Hex('TEST later failed challenge'),JSON.stringify({code:'context_challenge_expired'}),input.nonce);
  db.close();f.advance(HOUR);terminal=true;
  f.store.challenges.issue({jobId:JOB2,buyer:buyer.claim},sha256Hex('TEST reclamation scope'));
  assert.equal(f.store.challenges.retained(input.nonce),null,'terminal reclamation may remove the accepted challenge');
  f.reopen();f.closeLost();
  assert.equal(f.store.contextHoldState({jobId:JOB,effect:reservation.effectKey}),'uncertain','a remaining failed nonce cannot prove this effect was never accepted');
  const restarted=createSellerContextAdmission({...config,transportStore:f.store});await restarted.ready;
  assert.equal(parsePolicyLedger(await readFile(evidencePath,'utf8')).rows[0].released,false);
  assert.equal(f.rows('peer_nonces')[0].response,null);assert.equal(f.calls.effects,0);assert.equal(f.calls.holds,1);
});

// ---- the agent on the one ledger (P09a2b) ----
const LIFETIME = 600000, OTHER_BUYER = testWallet(5);
const watchWrites = t => {
  const writes = [], prepare = Database.prototype.prepare;
  const mock = t.mock.method(Database.prototype, 'prepare', function (sql) {
    if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql) && /kit_challenges|kit_job_bindings/.test(sql)) writes.push(sql);
    return prepare.call(this, sql);
  });
  return { writes, stop: () => mock.mock.restore() };
};
const refusalOf = async (promise, code, status) => {
  const error = await errorOf(promise);
  assert.equal(error.code, code, error.message); assert.equal(error.status, status);
  return error;
};

// The route's store and the agent share one ledger and one clock.
async function composed(t, storeOptions = {}) {
  let agent, f, lose = false;
  const ledger = () => {
    const shared = f.store.challenges;
    return { ...shared, issueForOperator: request => {
      const answer = shared.issueForOperator(request);
      if (lose) { lose = false; throw new Error('TEST answer lost after commit'); }
      return answer;
    } };
  };
  const pa = await proposalAdmissionFixture(t, { ledger });
  f = await fixture(t, { parties: { buyer: agentBuyer, seller: agentSeller }, listing: pa.listing, time: NOW,
    policy: { admission: value => agent.admitSessionPresentation(value) }, store: storeOptions });
  agent = await pa.open();
  const present = (nonce, { party = agentBuyer, amend = () => {} } = {}) => {
    const bundle = { bundleVersion: '1', presentedBy: party.claim, presentedAt: f.now(), sessionNonce: nonce, claims: [{ ref: party.claim }] };
    amend(bundle);
    bundle.presentation = { kind: 'per-claim', signatures: [{ ref: party.claim, signature: party.signBytes(Buffer.from('dacs-bundle-presentation:v1:' + identityBundleHash(bundle))).toString('base64url') }] };
    return bundle;
  };
  return { pa, f, present, get agent() { return agent; },
    loseNextOperatorAnswer: () => { lose = true; },
    admitReads: () => pa.admission.calls.filter(([name]) => name === 'admit').length,
    advance: ms => { f.advance(ms); pa.advance(ms); },
    async reopen() { agent.close(); f.reopen(); f.closeLost(); agent = await pa.open(); },
    // Keeps the proposal session the agent would have saved, then reopens the agent so its retained-session reader checks it.
    async retainProposedSession(bundle) {
      agent.close();
      const state = await createSellerDurableState({ dir: pa.dir, signer: signer(agentSeller), listingPin: listingPin(pa.listing) });
      try { await state.withJob(JOB, () => state.saveSession({ jobId: JOB, buyerBundle: structuredClone(bundle), buyerBundleHash: identityBundleHash(bundle), proposal: null, stage: 'proposed' })); }
      finally { state.close(); }
      agent = await pa.open();
    },
    proposal: (bundle, { jobId = JOB, buyerArgument = agentBuyer.claim } = {}) => agent.stagedProposal({ proposal: {},
      transportIdentity: { jobId, buyer: buyerArgument, seller: agentSeller.claim }, buyerIdentityBundle: structuredClone(bundle) }) };
}
const challengeRowsAt = path => {
  const db = new Database(path, { readonly: true });
  try { return db.prepare('SELECT * FROM kit_challenges').all(); } finally { db.close(); }
};
const sellerChallengeRows = c => {
  const db = new Database(join(c.pa.dir, 'seller-state.sqlite'), { readonly: true });
  try { return db.prepare("SELECT id FROM seller_effects WHERE id LIKE 'session-challenge:%' OR id LIKE 'session-job:%'").all(); } finally { db.close(); }
};

test(card('T01'), async t => {
  const c = await composed(t), input = await c.f.input();
  assert.equal((await c.f.route.reserve(input.request, input.body, c.f.store)).disposition, 'perform');
  assert.equal(c.f.rows().length, 1); assert.equal(c.admitReads(), 1); assert.equal(c.f.store.challenges.retained(input.nonce).state, 'accepted');
  const watch = watchWrites(t);
  await refusalOf(c.proposal(input.body.buyerIdentityBundle), 'proposal_not_assembled', 503);
  watch.stop();
  assert.deepEqual(watch.writes, []); assert.equal(c.admitReads(), 1); assert.equal(c.f.rows().length, 1);
});

test(card('T02'), async t => {
  const c = await composed(t), operator = await c.agent.issueSessionChallenge({ jobId: JOB, buyer: agentBuyer.claim });
  const input = await c.f.input(), other = c.present(operator.sessionNonce);
  await c.f.route.reserve(input.request, input.body, c.f.store);
  await c.reopen();
  const taken = await refusalOf(c.proposal(other), 'job_taken', 409);
  assert.match(taken.message, /bound to another buyer or bundle/);
  assert.equal(c.f.store.challenges.retained(operator.sessionNonce).failure.code, 'job_taken');
  assert.equal(c.admitReads(), 1);
  const watch = watchWrites(t);
  await refusalOf(c.proposal(input.body.buyerIdentityBundle), 'proposal_not_assembled', 503);
  watch.stop();
  assert.deepEqual(watch.writes, []); assert.equal(c.admitReads(), 1);
  assert.equal(c.f.store.challenges.jobBinding(JOB).nonce, input.nonce);
});

for (const bundleKind of ['plain', 'extension']) for (const path of ['context', 'operator']) for (const restarted of [false, true]) for (const expired of [false, true]) {
  test(`${card('T03')} [${bundleKind}, ${path}, ${restarted ? 'restarted' : 'live'}, ${expired ? 'expired' : 'fresh'}]`, async t => {
    const c = await composed(t), amend = bundleKind === 'extension' ? bundle => { bundle.signature = 'TEST-extension-member'; bundle.signatures = ['TEST-extension-members']; } : undefined;
    let bundle, nonce;
    if (path === 'context') {
      const input = await c.f.input(JOB, amend); nonce = input.nonce; bundle = input.body.buyerIdentityBundle;
      await c.f.route.reserve(input.request, input.body, c.f.store);
    } else {
      nonce = (await c.agent.issueSessionChallenge({ jobId: JOB, buyer: agentBuyer.claim })).sessionNonce; bundle = c.present(nonce, { amend });
      await refusalOf(c.proposal(bundle), 'proposal_not_assembled', 503);
    }
    if (bundleKind === 'extension') assert.deepEqual(Object.keys(bundle).filter(key => key.startsWith('signature')), ['signature', 'signatures']);
    if (restarted) await c.reopen();
    if (expired) c.advance(LIFETIME + 1);
    const accepted = c.f.store.challenges.retained(nonce), reads = c.admitReads();
    for (const buyerArgument of [agentBuyer.claim, agentBuyer.claim + '?jurisdiction=GB']) {
      const watch = watchWrites(t);
      await refusalOf(c.proposal(bundle, { buyerArgument }), 'proposal_not_assembled', 503);
      watch.stop();
      assert.deepEqual(watch.writes, []); assert.equal(c.admitReads(), reads);
    }
    assert.equal(accepted.accepted.buyerBundleText, canonicalize(bundle));
    assert.equal(c.agent.stageOf(JOB), 'proposed');
    await c.retainProposedSession(bundle);
    assert.equal(c.agent.stageOf(JOB), 'proposed', 'the retained-session reader accepts the exact retained bundle after reopening');
    for (const [label, attempt] of [
      ['other buyer', () => c.proposal(c.present(nonce, { party: OTHER_BUYER }), { buyerArgument: OTHER_BUYER.claim })],
      ['other complete bundle', () => c.proposal(c.present(nonce, { amend: other => { other.presentedAt += 1; amend?.(other); } }))],
      ['other job', () => c.proposal(bundle, { jobId: JOB2 })]]) {
      const watch = watchWrites(t), error = await errorOf(attempt());
      watch.stop();
      assert.equal(error.code, 'session_not_admitted', label); assert.equal(error.status, 409, label);
      assert.match(error.message, /context_challenge_consumed/, label);
      assert.deepEqual(watch.writes, [], label); assert.deepEqual(c.f.store.challenges.retained(nonce), accepted, label); assert.equal(c.admitReads(), reads, label);
    }
  });
}

test(card('T04'), async t => {
  const c = await composed(t), input = await c.f.input(), gate = barrier();
  c.f.policy.admission = async value => { await gate.promise; return c.agent.admitSessionPresentation(value); };
  const validating = c.f.route.reserve(input.request, input.body, c.f.store);
  assert.equal(c.f.store.challenges.retained(input.nonce).state, 'attempted');
  const watch = watchWrites(t);
  await refusalOf(c.proposal(input.body.buyerIdentityBundle), 'session_admission_unavailable', 503);
  watch.stop();
  assert.deepEqual(watch.writes, []); assert.equal(c.f.store.challenges.retained(input.nonce).state, 'attempted');
  gate.resolve(); assert.equal((await validating).disposition, 'perform');
  assert.equal(c.f.store.challenges.retained(input.nonce).state, 'accepted');
});

test(card('T07'), async t => {
  const c = await composed(t), input = await c.f.input();
  await c.f.route.reserve(input.request, input.body, c.f.store);
  const operator = await c.agent.issueSessionChallenge({ jobId: JOB2, buyer: agentBuyer.claim });
  await refusalOf(c.proposal(c.present(operator.sessionNonce), { jobId: JOB2 }), 'proposal_not_assembled', 503);
  assert.deepEqual(c.f.rows('sqlite_master').filter(row => row.name === 'peer_context_challenges'), []);
  assert.deepEqual(sellerChallengeRows(c), []);
  const source = new URL('../src/', import.meta.url), manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  await assert.rejects(readFile(new URL('dacs/session-challenge-limits.mjs', source)), { code: 'ENOENT' });
  assert.deepEqual(manifest.files.filter(entry => entry.includes('session-challenge-limits')), []);
});

test(card('T08'), async t => {
  const c = await composed(t), watch = watchWrites(t);
  const error = await refusalOf(c.proposal(c.present(sha256Hex('TEST self-derived nonce'))), 'session_not_admitted', 409);
  watch.stop();
  assert.equal(error.message, 'the presentation nonce is not a challenge this seller issued');
  assert.deepEqual(watch.writes, []); assert.equal(c.admitReads(), 0);
});

test(card('T09'), async t => {
  const c = await composed(t), operator = await c.agent.issueSessionChallenge({ jobId: JOB, buyer: agentBuyer.claim });
  assert.equal(c.f.store.challenges.retained(operator.sessionNonce).origin, 'operator');
  await refusalOf(c.proposal(c.present(operator.sessionNonce)), 'proposal_not_assembled', 503);
  assert.equal(c.f.store.challenges.retained(operator.sessionNonce).state, 'accepted'); assert.equal(c.admitReads(), 1);
  const second = await c.agent.issueSessionChallenge({ jobId: JOB2, buyer: agentBuyer.claim });
  const input = await c.f.input(JOB2, bundle => { bundle.sessionNonce = second.sessionNonce; });
  assert.equal((await errorOf(c.f.route.reserve(input.request, input.body, c.f.store))).code, 'context_challenge_mismatch');
  const row = c.f.store.challenges.retained(second.sessionNonce);
  assert.equal(row.state, 'failed'); assert.equal(row.failure.code, 'context_challenge_mismatch'); assert.equal(c.admitReads(), 1);
});

test(card('T13'), async t => {
  const guard = await import('../src/kit-operation-guard.mjs'), c = await composed(t), host = await hostFixture(t), started = await host.start();
  const off = async issue => {
    guard.setKitOperationGuardForTest('off');
    try { return await errorOf(Promise.resolve().then(issue)); } finally { guard.setKitOperationGuardForTest('testnet-tp1'); }
  };
  assert.equal((await off(() => c.agent.issueSessionChallenge({ jobId: JOB, buyer: agentBuyer.claim }))).code, 'kit_operation_guard_off');
  assert.equal((await off(() => started.issueSessionChallenge({ jobId: JOB, buyer: agentBuyer.claim }))).code, 'kit_operation_guard_off');
  assert.equal(c.f.rows().length, 0); assert.deepEqual(challengeRowsAt(host.path), []);
  assert.ok((await c.agent.issueSessionChallenge({ jobId: JOB, buyer: agentBuyer.claim })).sessionNonce);
});

test(card('T19'), async t => {
  const guard = await import('../src/kit-operation-guard.mjs');
  const unconfigured = await composed(t); unconfigured.agent.close();
  const missing = await createSellerAgent({ ...unconfigured.pa.config, sessionAdmission: null });
  t.after(() => missing.close());
  const watch = watchWrites(t);
  await refusalOf(missing.issueSessionChallenge({ jobId: JOB, buyer: agentBuyer.claim }), 'session_admission_unavailable', 503);
  watch.stop();
  assert.deepEqual(watch.writes, []); assert.equal(unconfigured.f.rows().length, 0);
  unconfigured.f.reopen(); assert.equal(unconfigured.f.rows().length, 0);
  const host = await hostFixture(t, source => source.replace('railAuthority, sessionAdmission, challengeLedger', 'railAuthority, sessionAdmission: null, challengeLedger'));
  const started = await host.start();
  await refusalOf(Promise.resolve().then(() => started.issueSessionChallenge({ jobId: JOB, buyer: agentBuyer.claim })), 'session_admission_unavailable', 503);
  assert.deepEqual(challengeRowsAt(host.path), []);
  // Controls: with admission configured the operator path works, and guard and stop keep their refusals.
  const configured = await composed(t);
  assert.ok((await configured.agent.issueSessionChallenge({ jobId: JOB, buyer: agentBuyer.claim })).sessionNonce);
  guard.setKitOperationGuardForTest('off');
  try { assert.equal((await errorOf(missing.issueSessionChallenge({ jobId: JOB, buyer: agentBuyer.claim }))).code, 'session_admission_unavailable'); } finally { guard.setKitOperationGuardForTest('testnet-tp1'); }
  const stop = { requested: false }, stoppable = await composed(t, { stopped: () => stop.requested });
  assert.ok((await stoppable.agent.issueSessionChallenge({ jobId: JOB, buyer: agentBuyer.claim })).sessionNonce);
  stop.requested = true;
  await refusalOf(stoppable.agent.issueSessionChallenge({ jobId: JOB2, buyer: agentBuyer.claim }), 'seller_stopped', 503);
});

test('operator-challenge-lost-answer-restart', async t => {
  const c = await composed(t);
  c.loseNextOperatorAnswer();
  await assert.rejects(c.agent.issueSessionChallenge({ jobId: JOB, buyer: agentBuyer.claim }), /TEST answer lost after commit/);
  assert.equal(c.f.rows().length, 1); const [row] = c.f.rows();
  await c.reopen();
  const again = await c.agent.issueSessionChallenge({ jobId: JOB, buyer: agentBuyer.claim });
  assert.equal(again.sessionNonce, row.nonce); assert.equal(c.f.rows().length, 1); assert.deepEqual(sellerChallengeRows(c), []);
  await refusalOf(c.proposal(c.present(again.sessionNonce)), 'proposal_not_assembled', 503);
  assert.equal(c.f.store.challenges.retained(again.sessionNonce).state, 'accepted');
});

test('operator-proposal-validator-owner-crash', async t => {
  await t.test('a concurrent retry neither revalidates nor accepts for another owner', async t => {
    const c = await composed(t), gate = barrier(), { sessionNonce } = await c.agent.issueSessionChallenge({ jobId: JOB, buyer: agentBuyer.claim }), bundle = c.present(sessionNonce);
    c.pa.admission.answerWith(async answer => { await gate.promise; return answer; });
    const first = c.proposal(bundle); await flush();
    const owner = c.f.store.challenges.retained(sessionNonce).owner; assert.equal(c.f.store.challenges.retained(sessionNonce).state, 'attempted'); assert.equal(c.admitReads(), 1);
    const watch = watchWrites(t);
    await refusalOf(c.proposal(bundle), 'session_admission_unavailable', 503);
    watch.stop();
    assert.deepEqual(watch.writes, []); assert.equal(c.admitReads(), 1);
    gate.resolve(); await refusalOf(first, 'proposal_not_assembled', 503);
    const row = c.f.store.challenges.retained(sessionNonce); assert.equal(row.state, 'accepted'); assert.deepEqual(row.owner, owner);
    await refusalOf(c.proposal(bundle), 'proposal_not_assembled', 503); assert.equal(c.admitReads(), 1);
  });
  await t.test('a killed validator is closed at startup and its identical retry is refused with the cause', async t => {
    const c = await composed(t), gate = barrier(), { sessionNonce } = await c.agent.issueSessionChallenge({ jobId: JOB, buyer: agentBuyer.claim }), bundle = c.present(sessionNonce);
    c.pa.admission.answerWith(async answer => { await gate.promise; return answer; });
    const killed = c.proposal(bundle).catch(error => error); await flush();
    assert.equal(c.f.store.challenges.retained(sessionNonce).state, 'attempted');
    await c.reopen();
    const row = c.f.store.challenges.retained(sessionNonce); assert.equal(row.state, 'failed'); assert.equal(row.failure.code, 'validator_lost');
    gate.resolve(); assert.ok(await killed instanceof Error);
    c.pa.admission.answerWith(null);
    const retry = await refusalOf(c.proposal(bundle), 'session_not_admitted', 409);
    assert.match(retry.message, /context_challenge_failed.*validator_lost|validator_lost/); assert.equal(c.f.store.challenges.retained(sessionNonce).state, 'failed'); assert.equal(c.admitReads(), 1);
  });
});

// ---- late fixes on the one ledger (P09bbL3) ----
const presentAnswer = scope => ({ disposition: 'present', value: { scope, input: {} } });

test('context-journal-answers-bytes-the-ledger-never-saw', async t => {
  for (const stage of ['completed', 'interrupted']) await t.test(stage, async t => {
    const f = await fixture(t), earlierNonce = sha256Hex('TEST nonce from before the ledger');
    const input = await f.input(JOB, bundle => { bundle.sessionNonce = earlierNonce; });
    const first = f.store.reserve(input.request, input.body, { admit: f.now });
    if (stage === 'completed') f.store.finish(first, 200, JSON.stringify(presentAnswer(input.body.scope)));
    f.policy.recover = () => presentAnswer(input.body.scope);
    f.reopen();
    const reservation = await f.route.reserve(f.request(input.body), input.body, f.store);
    assert.equal(reservation.disposition, stage === 'completed' ? 'cached' : 'uncertain');
    assert.equal(f.store.challenges.retained(earlierNonce), null); assert.equal(f.calls.admission, 0); assert.equal(f.calls.effects, 0);
  });
});

test('context-reserve-after-a-known-answer-starts-no-new-work', async t => {
  const f = await fixture(t), input = await f.input(JOB, bundle => { bundle.sessionNonce = sha256Hex('TEST nonce from before the ledger'); });
  const knownAnswerStore = { challenges: f.store.challenges, classify: () => 'known', reserve: (...args) => f.store.reserve(...args) };
  assert.equal((await errorOf(f.route.reserve(input.request, input.body, knownAnswerStore))).code, 'peer_context_unadmitted');
  assert.equal(f.rows('peer_effects').length, 0); assert.equal(f.calls.holds, 0); assert.equal(f.calls.effects, 0);
});

test('context-journal-readback-after-delegation-expiry', async t => {
  const f = await fixture(t), input = await f.input(), session = testWallet(3);
  f.policy.recover = () => presentAnswer(input.body.scope);
  const first = await f.route.reserve(input.request, input.body, f.store);
  f.store.finish(first, 200, JSON.stringify(presentAnswer(input.body.scope)));
  const payload = { version: '1', kind: 'seller-session-delegation', buyer: buyer.claim, sessionPublicKey: session.claim.slice('did:demos:agent:'.length),
    seller: seller.claim, listingPin: f.pin, jobId: JOB, notBefore: T0, expiresAt: T0 + 1000 };
  const delegation = { payload, signature: buyer.signBytes(sellerSessionDelegationSigningBytes(payload)).toString('base64url') };
  f.advance(1000);
  const auth = createSellerTransportServerAuth({ sellerSigner: signer(seller), listingPin: f.pin, store: f.store, now: f.now, requireDelegation: true });
  const client = createSellerTransportClientAuth({ sessionSigner: signer(session), delegation, seller: seller.claim, now: f.now, lifetimeMs: 100,
    resolveJob: () => ({ listingPin: f.pin, agreementHash: sellerContextScopeHash(input.body.scope) }) });
  const text = JSON.stringify(input.body), { header } = await client.request(SELLER_CONTEXT_PATH, input.body, text);
  const request = auth.readRequest(header); auth.validate(request, { method: 'POST', path: SELLER_CONTEXT_PATH, rawBody: Buffer.from(text), body: input.body });
  assert.equal(auth.readbackOnly(request), true);
  const reservation = await f.route.reserve(request, input.body, auth.store);
  assert.equal(reservation.disposition, 'cached'); assert.equal(reservation.status, 200); assert.equal(f.calls.effects, 0);
});

test('host-refuses-issuance-when-the-session-reader-fails', async t => {
  for (const name of ['throws', 'thenable', 'non-state']) await t.test(name, async t => {
    const source = unreadableSource(name), f = await hostFixture(t); let broken = false;
    await f.start({ contextSessionState: () => broken ? source.read() : null });
    const issue = () => f.api.testStore.challenges.issue({ jobId: JOB, buyer: buyer.claim }, sha256Hex('TEST scope'));
    assert.match(issue().sessionNonce, /^[0-9a-f]{64}$/);
    const before = challengeRowsAt(f.path); broken = true;
    assert.throws(issue, error => unavailable(error, source)); assert.deepEqual(challengeRowsAt(f.path), before);
  });
});

// Each source retains the exact offending value so error causes are checked by identity.
function unreadableSource(name) {
  const thrown = new Error('TEST session source failed');
  const answer = name === 'thenable' ? { then(_resolve, reject) { reject(thrown); } } : 7;
  return { name, thrown, answer, read() { if (name === 'throws') throw thrown; return answer; } };
}
function unavailable(error, source) {
  assert.ok(error instanceof SellerTransportError); assert.equal(error.code, 'session_admission_unavailable'); assert.equal(error.status, 503);
  if (source.name === 'throws') assert.equal(error.cause, source.thrown);
  else { assert.ok(error.cause instanceof TypeError); assert.equal(error.cause.cause, source.answer); }
  return true;
}
const recoveryTables = ['kit_challenges', 'peer_effects', 'peer_effect_jobs', 'peer_jobs', 'peer_context_admissions', 'kit_purchase_profiles', 'kit_context_reservations'];
const recoverySnapshot = f => recoveryTables.map(table => [table, f.rows(table)]);
const proposalInput = (f, jobId = JOB) => {
  const body = { jobId, proposal: {} }, request = f.request({ scope: f.scope(jobId) }, '/dacs/v1/agreements/proposals');
  return { body, request: { ...request, bodyHash: sha256Hex(JSON.stringify(body)) } };
};
async function legacyOperation(t, stage = 'completed') {
  const f = await fixture(t), input = await f.input(JOB, bundle => { bundle.sessionNonce = sha256Hex('TEST earlier session'); });
  const reservation = f.store.reserve(input.request, input.body, { admit: f.now });
  if (stage === 'completed') f.store.finish(reservation, 200, JSON.stringify(presentAnswer(input.body.scope).value));
  f.policy.recover = () => presentAnswer(input.body.scope);
  f.reopen(); f.closeLost();
  return { f, input, reservation };
}

test('R09 retained recovery respects ledger state and envelope nonce', async t => {
  for (const stage of ['completed', 'interrupted']) for (const fresh of [false, true]) await t.test(`${stage} ${fresh ? 'fresh' : 'same'} envelope`, async t => {
    const { f, input } = await legacyOperation(t, stage), before = recoverySnapshot(f);
    const request = fresh ? { ...input.request, nonce: Buffer.from('TEST fresh envelope').toString('base64url') } : input.request;
    const reservation = await f.route.reserve(request, input.body, f.store);
    assert.equal(reservation.disposition, stage === 'completed' ? 'cached' : 'uncertain');
    assert.deepEqual(recoverySnapshot(f), before);
    const key = `${buyer.claim}:${request.nonce}`;
    assert.ok(f.rows('peer_nonces').some(row => row.nonce === key));
    assert.ok(f.rows('peer_nonce_retention').some(row => row.nonce === key));
    assert.equal(f.rows('peer_nonces').length, fresh ? 2 : 1);
    assert.equal(f.calls.admission, 0); assert.equal(f.calls.holds, 0); assert.equal(f.calls.effects, 0);
    assert.equal(f.calls.releases, stage === 'completed' ? 1 : 0);
  });
});

test('R09 ledger refusal precedes retained recovery', async t => {
  for (const state of ['issued', 'attempted', 'failed']) await t.test(state, async t => {
    const f = await fixture(t), input = await f.input();
    f.store.reserve(input.request, input.body, { admit: f.now });
    if (state !== 'issued') {
      const attempt = f.store.challenges.attempt({ nonce: input.nonce, jobId: JOB, buyer: buyer.claim, path: 'context',
        challengeScopeHash: sellerContextScopeHash(sellerContextChallengeScope(input.body.scope)), presentationHash: sha256Hex(canonicalize(input.body.buyerIdentityBundle)) });
      assert.equal(attempt.kind, 'validate');
      if (state === 'failed') f.store.challenges.recordFailed(attempt.owner, input.nonce, 'TEST refused');
    }
    const before = recoverySnapshot(f); let classified = 0;
    const store = { ...f.store, classify() { classified++; throw new Error('TEST classifier must not run'); } };
    if (state === 'issued') {
      assert.equal((await f.route.reserve(input.request, input.body, store)).disposition, 'uncertain');
      assert.equal(f.calls.admission, 1);
    } else {
      const error = await errorOf(f.route.reserve(input.request, input.body, store));
      assert.equal(error.code, state === 'attempted' ? 'context_attempt_pending' : 'context_challenge_failed');
      assert.equal(error.status, state === 'attempted' ? 503 : 409);
      if (state === 'failed') assert.equal(error.cause, 'TEST refused');
      assert.deepEqual(recoverySnapshot(f), before);
    }
    assert.equal(classified, 0); assert.equal(f.calls.holds, 0); assert.equal(f.calls.effects, 0);
  });
});

test('R09 rejected retained body keeps challenges unchanged', async t => {
  const { f, input } = await legacyOperation(t), before = recoverySnapshot(f);
  const store = { ...f.store, classify: () => { throw new Error('TEST classification failed'); } };
  assert.throws(() => f.route.onRejectedBody(input.request, input.body, store), { code: 'context_challenge_mismatch' });
  assert.doesNotThrow(() => f.route.onRejectedBody(input.request, input.body, f.store));
  assert.deepEqual(recoverySnapshot(f), before); assert.equal(f.calls.effects, 0);
  // The hook still returns the original authenticated-body rejection and never serves a retained answer.
  const wire = await f.http(input.body), auth = createSellerTransportServerAuth({ sellerSigner: signer(seller), listingPin: f.pin, store: f.store, now: f.now });
  const request = auth.readRequest(wire.header);
  assert.throws(() => auth.validate(request, { method: 'POST', path: SELLER_CONTEXT_PATH, rawBody: Buffer.from(wire.text + ' '), body: input.body,
    onRejectedBody: () => f.route.onRejectedBody(request, input.body, f.store) }), { code: 'peer_body_mismatch' });
  assert.deepEqual(recoverySnapshot(f), before);
});

test('R09 unavailable retained proof keeps uncertainty', async t => {
  const { f, input } = await legacyOperation(t, 'interrupted');
  f.policy.recover = () => { throw new Error('TEST retained source unavailable'); };
  const before = recoverySnapshot(f), wire = await f.http(input.body), response = await exchange(wire.handler, wire);
  assert.equal(response.status, 503); assert.deepEqual(recoverySnapshot(f), before);
  assert.equal(f.calls.releases, 0); assert.equal(f.calls.effects, 0); assert.equal(f.calls.holds, 0);
});

test('R13 standalone ledger maps unreadable authority', async t => {
  for (const name of ['throws', 'thenable', 'non-state']) await t.test(name, t => {
    const source = unreadableSource(name), db = new Database(':memory:'); t.after(() => db.close());
    const ledger = createSellerChallengeLedger({ db, transaction: fn => db.transaction(fn)(), now: () => T0, generation: 'TEST generation',
      sessionState: source.read, admissionCounts: () => ({ contextRecords: 0, starts: 0, buyerStarts: () => 0 }), ready: () => true, stopped: () => false });
    assert.throws(() => ledger.issue({ jobId: JOB, buyer: buyer.claim }, sha256Hex('TEST scope')), error => unavailable(error, source));
    assert.equal(db.prepare('SELECT count(*) n FROM kit_challenges').get().n, 0);
  });
});

test('R13 mapped session error preserves its identity', async t => {
  const error = new SellerTransportError('session_admission_unavailable', 503, { cause: new Error('TEST original cause') });
  const f = await fixture(t, { store: { contextSessionState: () => { throw error; } } });
  assert.throws(() => f.store.challenges.issue({ jobId: JOB, buyer: buyer.claim }, sha256Hex('TEST scope')), actual => actual === error);
  assert.equal(f.rows().length, 0);
});

test('R19 transport gates refuse unreadable authority', async t => {
  for (const gate of ['proposal', 'resume', 'claim', 'claim check', 'assertPending']) for (const name of ['throws', 'thenable', 'non-state']) await t.test(`${gate}: ${name}`, async t => {
    const source = unreadableSource(name); let broken = false;
    const f = await fixture(t, { store: { contextSessionState: () => broken ? source.read() : null } });
    let invoke;
    if (gate === 'resume') {
      const input = await f.input(), first = f.store.reserve(input.request, input.body, { admit: f.now });
      f.store.finish(first, 503, '{}');
      const retained = f.store.reserve(input.request, input.body);
      invoke = () => f.store.resume(retained, input.request);
    } else {
      const { request, body } = proposalInput(f);
      if (gate === 'proposal') invoke = () => f.store.reserve(request, body);
      else {
        const first = f.store.reserve(request, body);
        if (gate === 'assertPending') invoke = () => f.store.assertPending(first);
        else {
          f.store.finish(first, 503, '{}');
          const retained = f.store.reserve(request, body);
          invoke = gate === 'claim' ? () => f.store.claim(retained, request) : f.store.claim(retained, request).check;
        }
      }
    }
    const before = recoverySnapshot(f); broken = true;
    assert.throws(invoke, error => unavailable(error, source)); assert.deepEqual(recoverySnapshot(f), before);
    assert.equal(f.calls.effects, 0); assert.equal(f.calls.holds, 0);
  });
});

test('R19 unreadable reclamation keeps the old holder', async t => {
  for (const name of ['throws', 'thenable', 'non-state']) await t.test(name, async t => {
    const source = unreadableSource(name); let broken = false;
    const f = await fixture(t, { store: { maxJobs: 1, contextSessionState: ({ jobId }) => jobId === JOB && broken ? source.read() : null } });
    const { request, body } = proposalInput(f);
    const profile = { id: TP1_PROFILE_ID, revision: TP1_PROFILE_REVISION, base: TP1_BASE_REVISION,
      chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, pinVersion: TP1_APPROVED_IDENTITY_RECORD.pinVersion };
    const first = f.store.reserve(request, body, { keepProfile: profile }); f.store.finish(first, 200, '{}');
    f.advance(HOUR + 1); const before = recoverySnapshot(f); broken = true;
    const next = proposalInput(f, JOB2);
    assert.throws(() => f.store.reserve(next.request, next.body), error => { assert.ok(['peer_job_capacity', 'session_admission_unavailable'].includes(error.code)); assert.equal(error.status, 503); return true; });
    assert.deepEqual(recoverySnapshot(f), before);
  });
});

test('R19 explicit unknown and terminal controls', async t => {
  for (const state of [null, 'negotiating', 'finalised']) await t.test(String(state), async t => {
    const f = await fixture(t, { store: { contextSessionState: () => state } }), { request, body } = proposalInput(f);
    if (state === 'finalised') assert.throws(() => f.store.reserve(request, body), { code: 'context_session_terminal', status: 409 });
    else assert.equal(f.store.reserve(request, body).disposition, 'perform');
  });
});

test('R21 duplicate cannot reconcile a live validator', async t => {
  const hold = barrier(), entered = barrier();
  const f = await fixture(t, { policy: { hold: () => { entered.resolve(); return hold.promise; } } }), input = await f.input();
  const original = f.route.reserve(input.request, input.body, f.store);
  await entered.promise;
  const before = recoverySnapshot(f), wire = await f.http(input.body);
  try {
    const response = await exchange(wire.handler, wire);
    assert.equal(response.status, 503); assert.equal(JSON.parse(response.text).error, 'context_attempt_pending');
    assert.deepEqual(recoverySnapshot(f), before); assert.equal(f.calls.releases, 0);
  } finally { hold.resolve(null); }
  assert.equal((await original).disposition, 'perform');
});

test('R21 pending context is fenced without a validator', async t => {
  for (const ledger of ['absent', 'accepted']) await t.test(ledger, async t => {
    const f = await fixture(t), input = await f.input(JOB, bundle => { if (ledger === 'absent') bundle.sessionNonce = sha256Hex('TEST old challenge'); });
    if (ledger === 'accepted') await f.route.reserve(input.request, input.body, f.store);
    else f.store.reserve(input.request, input.body, { admit: f.now });
    let proofs = 0; f.policy.recover = () => { proofs++; return presentAnswer(input.body.scope); };
    const before = recoverySnapshot(f), releases = f.calls.releases, wire = await f.http(input.body), response = await exchange(wire.handler, wire);
    assert.equal(response.status, 503); assert.equal(JSON.parse(response.text).error, 'operation_uncertain');
    assert.deepEqual(recoverySnapshot(f), before); assert.equal(proofs, 0); assert.equal(f.calls.releases, releases);
    assert.equal(f.calls.effects, 0);
  });
});

test('R21 direct store refuses pending context reconciliation', async t => {
  const f = await fixture(t), input = await f.input(), first = f.store.reserve(input.request, input.body, { admit: f.now });
  const retained = f.store.reserve(input.request, input.body), before = recoverySnapshot(f);
  assert.equal(first.disposition, 'perform'); assert.equal(retained.disposition, 'uncertain');
  assert.throws(() => f.store.reconcile(retained, input.request, 200, '{}'), { code: 'peer_reconciliation_conflict', status: 503 });
  assert.deepEqual(recoverySnapshot(f), before);
});


test('R10 expired HTTP readback never resumes a retained effect', async t => {
  for (const stage of ['completed', 'uncertain']) await t.test(stage, async t => {
    const { f, input } = await legacyOperation(t, stage === 'completed' ? stage : 'interrupted'), session = testWallet(3);
    f.policy.recover = () => stage === 'completed' ? presentAnswer(input.body.scope) : null;
    f.policy.resumable = () => ({ writes: 1 });
    const payload = { version: '1', kind: 'seller-session-delegation', buyer: buyer.claim, sessionPublicKey: session.claim.slice('did:demos:agent:'.length),
      seller: seller.claim, listingPin: f.pin, jobId: JOB, notBefore: T0, expiresAt: T0 + 1000 };
    const delegation = { payload, signature: buyer.signBytes(sellerSessionDelegationSigningBytes(payload)).toString('base64url') };
    f.advance(1000);
    const auth = createSellerTransportServerAuth({ sellerSigner: signer(seller), listingPin: f.pin, store: f.store, now: f.now, requireDelegation: true });
    const client = createSellerTransportClientAuth({ sessionSigner: signer(session), delegation, seller: seller.claim, now: f.now, lifetimeMs: 100,
      resolveJob: () => ({ listingPin: f.pin, agreementHash: sellerContextScopeHash(input.body.scope) }) });
    const text = JSON.stringify(input.body), { header } = await client.request(SELLER_CONTEXT_PATH, input.body, text);
    let resumes = 0;
    const context = { ...f.route, resume: (...args) => { resumes++; return f.route.resume(...args); } };
    const handler = createSellerHttpHandler({ claim: seller.claim, listingPin: f.pin, transportAgreementOf: () => null }, { authentication: auth, context });
    const before = recoverySnapshot(f), response = await exchange(handler, { text, header, url: SELLER_CONTEXT_PATH });
    assert.equal(response.status, stage === 'completed' ? 200 : 503); assert.deepEqual(recoverySnapshot(f), before);
    assert.equal(resumes, 0); assert.equal(f.calls.holds, 0); assert.equal(f.calls.effects, 0); assert.equal(f.calls.admission, 0);
    assert.equal(f.rows('peer_nonces').length, 2);
  });
});
