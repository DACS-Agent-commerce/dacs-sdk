import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Server } from 'node:net';
import Database from 'better-sqlite3';
import { canonicalize, DacsError, generateCanonicalJobId, identityBundleHash, sha256Hex } from '@kynesyslabs/dacs';
import { createSellerTransportStore } from './helpers/bound-transport-store.mjs';
import { sellerContextScopeHash, sellerContextChallengeScope, SELLER_CONTEXT_PATH, SELLER_CONTEXT_CHALLENGE_PATH,
  SellerTransportError, sellerStoreInternals } from '../src/dacs/seller-transport-auth.mjs';
import { TP1_APPROVED_IDENTITY_RECORD, TP1_PROFILE_ID, TP1_PROFILE_REVISION, TP1_BASE_REVISION } from '@kynesyslabs/dacs/wire';
import { createSellerChallengeLedger } from '../src/dacs/seller-challenge-ledger.mjs';
import { KIT_TP1_VET_MODE } from '../src/host.mjs';
import { fixtureListing } from './fixtures/listings.mjs';
import { NOW, testWallet, buyer as agentBuyer, seller as agentSeller } from './helpers/protocol-fixture.mjs';
import { proposalAdmissionFixture } from './helpers/proposal-admission-fixture.mjs';
import { createSellerDurableState } from '../src/dacs/seller-durable-state.mjs';
import { createSellerAgent } from '../src/dacs/seller-agent.mjs';
import { listingPin } from '../src/dacs/purchase-protocol.mjs';
import { purchaseSupport } from '../src/dacs/listing.mjs';
import { AGREEMENT_CONTEXT_SOURCE } from '../src/dacs/agreement-context-consumer.mjs';
import { admittedSession } from './helpers/challenge-api.mjs';
import { commitmentFixture } from './helpers/commitment-fixture.mjs';
import { privateModule } from './helpers/private-module.mjs';
import { testNetwork, withFixtureProfile } from './helpers/wire-authority-fixture.mjs';

const T0 = Date.UTC(2026, 9, 27, 12), HOUR = 3600000;
const buyer = testWallet(1), seller = testWallet(2);
const JOB = generateCanonicalJobId({ timestamp: T0, entropy: new Uint8Array(10).fill(0x11) });
const JOB2 = generateCanonicalJobId({ timestamp: T0, entropy: new Uint8Array(10).fill(0x22) });
const defaultParties = { buyer, seller };
const signer = wallet => ({ claim: wallet.claim, sign: wallet.signBytes });
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const barrier = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const errorOf = async promise => { try { await promise; } catch (error) { return error; } assert.fail('expected refusal'); };
const titles = {
  "T06": "a body-check refusal after the attempt records `failed`; no current-generation row is left `attempted`",
  "T12": "host start closes earlier-generation attempts before the listener opens",
  "T20": "with `maxRecords` 1 and the clock advanced past the nonce window each time, three signed context requests naming an unknown, a consumed and a mismatched challenge each refuse with their K1 code while `peer_nonces` and `peer_nonce_retention` never exceed one row each (expired rows are reclaimed before any refusal is recorded; a dry-run `classify` writes nothing), also after reopening, and the ledger gains no row for the unknown nonce",
  "T15": "the existing route- and store-level challenge tests pass unchanged in name on the one ledger",
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

// `options.parties`, `options.listing` and `options.time` let the composed agent tests share the fixture's store and clock.
async function fixture(t, options = {}) {
  const { buyer, seller } = options.parties ?? defaultParties;
  const directory = await mkdtemp(join(tmpdir(), 'TEST-one-nonce-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'transport.sqlite'), listing = options.listing ?? fixtureListing(seller, { now: T0 }), pin = listingPin(listing), support = purchaseSupport(listing);
  let time = options.time ?? T0, store, generation = 0;
  const policy = { admission: options.policy?.admission ?? (({ jobId, bundle }) => admittedSession({ jobId, bundle, bundleHash: identityBundleHash(bundle), seller: seller.claim, listingPin: pin })) };
  const open = () => store = withFixtureProfile(createSellerTransportStore({ path, now: () => time, generation: `TEST-generation-${++generation}`, ...options.store }));
  open(); t.after(() => store.close());
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
  const issue = async (jobId = JOB) => { const body = challengeBody(jobId); return store.challenges.issue(request(body, SELLER_CONTEXT_CHALLENGE_PATH), sellerContextScopeHash(body.scope)); };
  const input = async (jobId = JOB, amend = () => {}) => {
    const { sessionNonce } = await issue(jobId);
    const bundle = { bundleVersion: '1', presentedBy: buyer.claim, presentedAt: time, sessionNonce, claims: [{ ref: buyer.claim }] };
    amend(bundle);
    bundle.presentation = { kind: 'per-claim', signatures: [{ ref: buyer.claim, signature: buyer.signBytes(Buffer.from('dacs-bundle-presentation:v1:' + identityBundleHash(bundle))).toString('base64url') }] };
    const body = { scope: { ...scope(jobId), buyerBundleHash: identityBundleHash(bundle) }, buyerIdentityBundle: bundle };
    return { body, request: request(body), nonce: sessionNonce };
  };
  // The first context admission as the ledger and the journal see it: the nonce attempt, the session admission of the presentation, the
  // journal reservation and the acceptance of the nonce. A failed admission records the attempt as failed. Resolves with the reservation.
  const accept = async ({ body, request }) => {
    const nonce = body.buyerIdentityBundle.sessionNonce, owned = store.challenges.attempt({ request, path: 'context', nonce, jobId: request.jobId, buyer: request.buyer,
      challengeScopeHash: sellerContextScopeHash(sellerContextChallengeScope(body.scope)), presentationHash: sha256Hex(canonicalize(body.buyerIdentityBundle)) });
    if (owned.kind === 'refused') throw new SellerTransportError(owned.code, owned.status, { cause: owned.cause });
    let admission;
    try { admission = await policy.admission({ jobId: request.jobId, bundle: structuredClone(body.buyerIdentityBundle), nonce }); }
    catch (error) { store.challenges.recordFailed(owned.owner, nonce, error.code ?? 'operation_uncertain'); throw error; }
    const reservation = store.reserve(request, body, { admit: () => time, challengeNonce: nonce });
    store.challenges.accept(owned.owner, nonce, { buyerBundleText: canonicalize(body.buyerIdentityBundle), buyerBundleHash: identityBundleHash(body.buyerIdentityBundle), admission,
      admittedAt: store.contextAdmission(request.jobId)?.admittedAt, firstAdmission: { challengeExpiresAt: store.challenges.retained(nonce).expiresAt, generatedAt: body.scope.generatedAt, checkedAt: time } });
    return reservation;
  };
  return { policy, rows, scope, challengeBody, request, issue, input, accept, path, listing, pin,
    get store() { return store; }, advance: ms => { time += ms; }, now: () => time,
    reopen() { store.close(); open(); }, closeLost() { store.challenges.closeLostValidations(); store.recoverLostContextReservations(); } };
}


async function hostFixture(t, edit = source => source) {
  const f = await commitmentFixture(t, { vetMode: KIT_TP1_VET_MODE }), dataDirectory = await mkdtemp(join(tmpdir(), 'TEST-one-nonce-host-'));
  const { nativeArtifactAnchor, ...config } = f.config;
  // The host builds its own durable directory, ledger and signing mode, and fixes the Vet mode (`vetMode` is an agent option, not a host option).
  for (const name of ['durableDirectory', 'commitOnSignature', 'challengeLedger', 'vetMode']) delete config[name];
  let current;
  // These nonce tests leave the wire journal unused, but its handle must still satisfy the context's construction check.
  const api = await privateModule(new URL('../src/host.mjs', import.meta.url), ['testStore', 'setStartupFailure'], source => edit(
    source.replace("const generation = randomBytes(16).toString('hex');", "if (failStartup) throw new Error('TEST generation source failed'); const generation = randomBytes(16).toString('hex');").replace('const journal = openWireRequestJournal(journalDirectory, { leaseMs: KIT_JOURNAL_LEASE_MS, clock: now });', 'const journal = Object.freeze({});').replace('const REQUIRED =', 'let testStore; let failStartup = false; function setStartupFailure(value) { failStartup = value; }\nconst REQUIRED =').replace('opened.push(() => store.close());', 'testStore = store; opened.push(() => store.close());')));
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

test(card('T15'), () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  // The default reporter differs between Node lines, so the child prints TAP explicitly.
  const result = spawnSync(process.execPath, ['--import', new URL('./helpers/kit-guard-fixture.mjs', import.meta.url).pathname, '--test', '--test-reporter=tap', '--test-name-pattern=^T[1-6] ',
    'packages/dacs-seller/test/d5-challenge-retention.test.mjs'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // At least one selected test passed. The `# pass` count is no proof: Node may count a file in which no test matched as a passing test.
  assert.match(result.stdout, /^\s*ok \d+ - T[1-6] /m);
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

// The fixture's store and the agent share one ledger and one clock.
async function composed(t, storeOptions = {}) {
  let agent, f, lose = false, acceptRefusal = null;
  const ledger = () => {
    const shared = f.store.challenges;
    return { ...shared,
      issueForOperator: request => {
        const answer = shared.issueForOperator(request);
        if (lose) { lose = false; throw new Error('TEST answer lost after commit'); }
        return answer;
      },
      accept: (owner, nonce, record) => {
        if (acceptRefusal !== null) throw acceptRefusal;
        return shared.accept(owner, nonce, record);
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
    refuseAccept: error => { acceptRefusal = error; },
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
  assert.equal((await c.f.accept(input)).disposition, 'perform');
  assert.equal(c.f.rows().length, 1); assert.equal(c.admitReads(), 1); assert.equal(c.f.store.challenges.retained(input.nonce).state, 'accepted');
  const watch = watchWrites(t);
  await refusalOf(c.proposal(input.body.buyerIdentityBundle), 'proposal_not_assembled', 503);
  watch.stop();
  assert.deepEqual(watch.writes, []); assert.equal(c.admitReads(), 1); assert.equal(c.f.rows().length, 1);
});

test(card('T02'), async t => {
  const c = await composed(t), operator = await c.agent.issueSessionChallenge({ jobId: JOB, buyer: agentBuyer.claim });
  const input = await c.f.input(), other = c.present(operator.sessionNonce);
  await c.f.accept(input);
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
      await c.f.accept(input);
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
  const validating = c.f.accept(input);
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
  await c.f.accept(input);
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
  assert.equal((await errorOf(c.f.accept(input))).code, 'context_challenge_mismatch');
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

test('an uncoded DacsError on the proposal path closes the challenge as operation_uncertain', async t => {
  const c = await composed(t), { sessionNonce } = await c.agent.issueSessionChallenge({ jobId: JOB, buyer: agentBuyer.claim });
  c.refuseAccept(new DacsError('TEST acceptance refused'));
  const error = await errorOf(c.proposal(c.present(sessionNonce)));
  assert.ok(error instanceof DacsError && !('code' in error), 'the proposal path rethrew the uncoded DacsError');
  const row = c.f.store.challenges.retained(sessionNonce);
  assert.equal(row.state, 'failed'); assert.equal(row.failure.code, 'operation_uncertain');
});

test('host refuses issuance when the session reader fails', async t => {
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
  assert.ok(error instanceof SellerTransportError, error.stack); assert.equal(error.code, 'session_admission_unavailable'); assert.equal(error.status, 503);
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
test('standalone ledger uses the shared adapter to refuse unavailable state', async t => {
  for (const name of ['throws', 'thenable', 'non-state']) await t.test(name, async t => {
    const source = unreadableSource(name), directory = await mkdtemp(join(tmpdir(), 'TEST-observer-'));
    const store = createSellerTransportStore({ path: join(directory, 'transport.sqlite'), now: () => T0, contextSessionState: source.read });
    t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
    const db = new Database(':memory:'); t.after(() => db.close());
    const ledger = createSellerChallengeLedger({ db, transaction: fn => db.transaction(fn)(), now: () => T0, generation: 'TEST generation',
      sessionState: sellerStoreInternals(store).sessionState, admissionCounts: () => ({ contextRecords: 0, starts: 0, buyerStarts: () => 0 }), ready: () => true, stopped: () => false });
    assert.throws(() => ledger.issue({ jobId: JOB, buyer: buyer.claim }, sha256Hex('TEST scope'), { assertStillLive() {} }), error => unavailable(error, source));
    assert.equal(db.prepare('SELECT count(*) n FROM kit_challenges').get().n, 0);
  });
});

test('mapped session error preserves its identity', async t => {
  const error = new SellerTransportError('session_admission_unavailable', 503, { cause: new Error('TEST original cause') });
  const f = await fixture(t, { store: { contextSessionState: () => { throw error; } } });
  assert.throws(() => f.store.challenges.issue({ jobId: JOB, buyer: buyer.claim }, sha256Hex('TEST scope')), actual => actual === error);
  assert.equal(f.rows().length, 0);
});

test('transport gates refuse unreadable authority', async t => {
  for (const gate of ['proposal', 'context start', 'resume', 'claim', 'claim check', 'assertPending']) for (const name of ['throws', 'thenable', 'non-state']) await t.test(`${gate}: ${name}`, async t => {
    const source = unreadableSource(name); let broken = false;
    const f = await fixture(t, { store: { contextSessionState: () => broken ? source.read() : null } });
    let invoke;
    if (gate === 'context start') {
      const input = await f.input(); invoke = () => f.store.reserve(input.request, input.body, { admit: f.now });
    } else if (gate === 'resume') {
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
  });
});

test('R19 unreadable reclamation keeps the old holder', async t => {
  for (const name of ['throws', 'thenable', 'non-state']) await t.test(name, async t => {
    const source = unreadableSource(name); let broken = false, terminal = false;
    const f = await fixture(t, { store: { maxJobs: 1, contextSessionState: ({ jobId }) => jobId === JOB ? terminal ? 'finalised' : broken ? source.read() : null : null } });
    const { request, body } = proposalInput(f);
    const profile = { id: TP1_PROFILE_ID, revision: TP1_PROFILE_REVISION, base: TP1_BASE_REVISION,
      chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, pinVersion: TP1_APPROVED_IDENTITY_RECORD.pinVersion };
    const first = f.store.reserve(request, body, { keepProfile: profile }); f.store.finish(first, 200, '{}');
    f.advance(HOUR + 1); const before = recoverySnapshot(f), nonces = [f.rows('peer_nonces'), f.rows('peer_nonce_retention')]; broken = true;
    const next = proposalInput(f, JOB2);
    assert.throws(() => f.store.reserve(next.request, next.body), error => { assert.ok(['peer_job_capacity', 'session_admission_unavailable'].includes(error.code)); assert.equal(error.status, 503); return true; });
    assert.deepEqual(recoverySnapshot(f), before); assert.deepEqual([f.rows('peer_nonces'), f.rows('peer_nonce_retention')], nonces);
    terminal = true; assert.equal(f.store.reserve(next.request, next.body).disposition, 'perform');
    assert.ok(!f.rows('peer_jobs').some(row => row.job === JOB));
  });
});

test('R19 explicit unknown and terminal controls', async t => {
  for (const state of [null, 'negotiating', 'finalised']) await t.test(String(state), async t => {
    const f = await fixture(t, { store: { contextSessionState: () => state } }), { request, body } = proposalInput(f);
    if (state === 'finalised') assert.throws(() => f.store.reserve(request, body), { code: 'context_session_terminal', status: 409 });
    else assert.equal(f.store.reserve(request, body).disposition, 'perform');
  });
});

test('R21 direct store refuses pending context reconciliation', async t => {
  const f = await fixture(t), input = await f.input(), first = f.store.reserve(input.request, input.body, { admit: f.now });
  const retained = f.store.reserve(input.request, input.body), before = recoverySnapshot(f);
  assert.equal(first.disposition, 'perform'); assert.equal(retained.disposition, 'uncertain');
  assert.throws(() => f.store.reconcile(retained, input.request, 200, '{}'), { code: 'peer_reconciliation_conflict', status: 503 });
  assert.deepEqual(recoverySnapshot(f), before);
});


test('a wrongly tagged source error keeps its cause under unavailable 503', async t => {
  const cause = new SellerTransportError('session_admission_unavailable', 409);
  const f = await fixture(t, { store: { contextSessionState: () => { throw cause; } } });
  assert.throws(() => f.store.challenges.issue({ jobId: JOB, buyer: buyer.claim }, sha256Hex('TEST scope')), error => {
    assert.equal(error.code, 'session_admission_unavailable'); assert.equal(error.status, 503); assert.equal(error.cause, cause); return true;
  });
  assert.equal(f.rows().length, 0);
});
