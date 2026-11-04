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
import { createSellerContextRoute } from '../src/dacs/seller-context-route.mjs';
import { createSellerHttpHandler } from '../src/dacs/seller-http.mjs';
import { createSellerContextAdmission, releaseSellerContextHolds, parsePolicyLedger } from '../src/devnet-demo/operator-approval.mjs';
import { fixtureListing } from './fixtures/listings.mjs';
import { NOW, testWallet } from './helpers/protocol-fixture.mjs';
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
const card = id => `P09a2-${id} ${titles[id]}`;

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'TEST-one-nonce-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'transport.sqlite'), listing = fixtureListing(seller, { now: T0 }), pin = listingPin(listing), support = purchaseSupport(listing);
  let time = T0, store, generation = 0;
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
  const input = async (jobId = JOB) => {
    const { sessionNonce } = await issue(jobId);
    const bundle = { bundleVersion: '1', presentedBy: buyer.claim, presentedAt: time, sessionNonce, claims: [{ ref: buyer.claim }] };
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

async function hostFixture(t) {
  const f = await commitmentFixture(t), dataDirectory = await mkdtemp(join(tmpdir(), 'TEST-one-nonce-host-'));
  const { durableDirectory, commitOnSignature, nativeArtifactAnchor, ...config } = f.config;
  let current;
  const api = await privateModule(new URL('../src/host.mjs', import.meta.url), ['testStore', 'setStartupFailure'], source =>
    source.replace("const generation = randomBytes(16).toString('hex');", "if (failStartup) throw new Error('TEST generation source failed'); const generation = randomBytes(16).toString('hex');").replace('const journal = openWireRequestJournal(journalDirectory, { leaseMs: KIT_JOURNAL_LEASE_MS, clock: now });', 'const journal = Object.freeze({});').replace('const REQUIRED =', 'let testStore; let failStartup = false; function setStartupFailure(value) { failStartup = value; }\nconst REQUIRED =').replace('opened.push(() => store.close());', 'testStore = store; opened.push(() => store.close());'));
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
