// Compensation proof over the signer and wallet journals, the dispatch history, the chain's execution and a sink's retirement,
// and its use by the admission transaction's C3: a proof of no effect aborts the row, a proof that an effect happened settles
// it with no context outcome, and anything else keeps it compensating. The sources are the module's normalized ports, fed by
// doubles; no physical journal, history or chain reader is involved. Reads run on a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, generateCanonicalJobId, identityBundleHash } from '@kynesyslabs/dacs';
import { TP1_APPROVED_IDENTITY_RECORD, TP1_BASE_REVISION, TP1_PROFILE_ID, TP1_PROFILE_REVISION } from '@kynesyslabs/dacs/wire';
import { classifyAddress, compensationProof, createContextEffectEvidence } from '../src/dacs/compensation-proof.mjs';
import { createContextAdmissionTransaction } from '../src/dacs/seller-admission-transaction.mjs';
import { createPurchaseCapacity } from '../src/dacs/seller-purchase-capacity.mjs';
import { SELLER_PROFILE } from '../src/dacs/session-admission.mjs';
import { createSellerTransportStore, sellerStoreInternals } from '../src/dacs/seller-transport-auth.mjs';

const T0 = Date.UTC(2026, 9, 27, 12), HOUR = 3600000, GRACE_MS = 30000;
const hash = text => createHash('sha256').update(String(text)).digest('hex');
const claim = seed => {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]), format: 'der', type: 'pkcs8' });
  return 'did:demos:agent:' + createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
};
const BUYER = claim(1), SELLER = claim(2);
const PIN = { listingId: 'tp1-vector-listing', version: 1, contentHash: hash('contracts-vector-listing') };
const PROFILE = Object.freeze({ id: TP1_PROFILE_ID, revision: TP1_PROFILE_REVISION, base: TP1_BASE_REVISION,
  chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, pinVersion: TP1_APPROVED_IDENTITY_RECORD.pinVersion });
const SCOPE = { agreement: 'context-scope-vector' };
const ARTIFACT = hash('seller vet create'), OTHER_ARTIFACT = hash('replacement vet create'), LANE = 'seller-vet';
const record = (seq, state, artifactHash = ARTIFACT, of) => ({ seq, lane: LANE, state, operationId: 'operation', pinVersion: '1', artifactHash, ...(of === undefined ? {} : { of }) });
// What the effect boundary writes when a pass is refused after its intent: `-started` first, then `-withheld` naming it.
const WITHHELD_PASS = ['signed', 'dispatch-started', { state: 'dispatch-withheld', of: 2 }];
const intent = (signed = true, artifactHash = ARTIFACT) => ({ lane: LANE, artifactHash, signed });
const executedAt = address => ({ address, finalized: true, verified: true });

// Normalized sources over plain tables. `anchor` and `wallet` map an address to its retained intents, `history` an artifact hash
// to its lane records, `executed` the addresses the chain executed, `retired` an address to the artifact hashes its sink retired.
// A table entry that is a function is called, so a test can throw or hang. `retirement` is left off the sources unless `retired` is set.
function sourcesOf({ anchor = {}, wallet = {}, history = {}, executed = [], retired } = {}) {
  const reads = { anchor: [], wallet: [], history: [], executed: [], retirement: [] };
  const executedAnswer = typeof executed === 'function' ? executed : async address => (executed.includes(address) ? executedAt(address) : null);
  const answer = (table, key) => (typeof table === 'function' ? table(key) : table[key]);
  const snapshot = (name, table) => async (address, bounds) => { reads[name].push({ address, bounds }); return answer(table, address) ?? { intents: [], complete: true }; };
  const sources = {
    anchor: snapshot('anchor', anchor), wallet: snapshot('wallet', wallet),
    history: async (lane, artifactHash, bounds) => { reads.history.push({ lane, artifactHash, bounds }); return answer(history, artifactHash) ?? { records: [], complete: true }; },
    executed: async (address, bounds) => { reads.executed.push({ address, bounds }); return executedAnswer(address); },
  };
  if (retired !== undefined) sources.retirement = async (address, bounds) => { reads.retirement.push({ address, bounds }); return retired[address] ? { address, retired: true, artifactHashes: retired[address] } : null; };
  return Object.assign(sources, { reads });
}
const held = (...intents) => ({ intents, complete: true });
// An address whose one signed CREATE has the given history, in both journals.
const createWith = (address, ...states) => ({ anchor: { [address]: held(intent()) }, wallet: { [address]: held(intent()) },
  history: { [ARTIFACT]: { records: states.map((state, index) => (typeof state === 'string' ? record(index + 1, state) : record(index + 1, state.state, ARTIFACT, state.of))), complete: true } } });

test('an address with no intent in either journal is no-intent, and one with an unsigned retained intent is proven-unsigned', async () => {
  const address = 'did:demos:agent:' + 'a'.repeat(64), sources = sourcesOf({ anchor: { [address]: held(intent(false)) }, wallet: { [address]: held(intent(false)) } });
  assert.equal((await classifyAddress(address, sourcesOf())).kind, 'no-intent');
  assert.equal((await classifyAddress(address, sources)).kind, 'proven-unsigned');
  assert.deepEqual(sources.reads.history, [], 'nothing signed, so no history is read');
});

test('a signed CREATE that appears in only one journal, with no retirement or complete never-dispatched proof, is undetermined and not no-intent', async () => {
  const address = 'did:demos:agent:' + 'b'.repeat(64), both = createWith(address, 'signed', 'dispatch-started');
  for (const [label, journals] of [['the anchor journal only', { anchor: both.anchor }], ['the wallet journal only', { wallet: both.wallet }], ['both journals', both]]) {
    const evidence = await classifyAddress(address, sourcesOf({ ...journals, history: both.history }));
    assert.equal(evidence.kind, 'undetermined', label);
  }
  const unrecorded = await classifyAddress(address, sourcesOf({ anchor: both.anchor }));
  assert.equal(unrecorded.kind, 'undetermined', 'a signed intent whose history holds no signed record proves nothing');
});

test('a journal or readback read that fails or times out classifies undetermined with its cause', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const address = 'did:demos:agent:' + 'c'.repeat(64), failure = Object.assign(new Error('TEST read failed'), { code: 'EIO' });
  const retained = createWith(address, ...WITHHELD_PASS);
  const throws = () => { throw failure; };
  const rows = [
    ['the anchor journal throws', { ...retained, anchor: throws }],
    ['the wallet journal throws', { ...retained, wallet: throws }],
    ['the history throws', { ...retained, history: throws }],
    ['the chain readback throws', { ...retained, executed: async () => { throw failure; } }],
  ];
  for (const [label, spec] of rows) {
    const evidence = await classifyAddress(address, sourcesOf(spec));
    assert.equal(evidence.kind, 'undetermined', label); assert.equal(evidence.cause.message, 'TEST read failed', label);
  }
  const hanging = sourcesOf({ ...retained, history: () => new Promise(() => {}) });
  const pending = classifyAddress(address, hanging);
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(10000);
  const timedOut = await pending;
  assert.equal(timedOut.kind, 'undetermined'); assert.equal(timedOut.cause.code, 'operation_uncertain');
  assert.equal(hanging.reads.history[0].bounds.timeoutMs, 10000); assert.equal(hanging.reads.history[0].bounds.maxBytes, 1048576); assert.equal(hanging.reads.history[0].bounds.maxItems, 256);
});

test('an incomplete, oversized or malformed read is undetermined, never no-intent', async () => {
  const address = 'did:demos:agent:' + 'd'.repeat(64), many = Array.from({ length: 257 }, (_, index) => intent(true, hash(`artifact ${index}`)));
  const incomplete = { intents: [], complete: false }, malformed = { intents: [{ lane: LANE }], complete: true };
  for (const [label, snapshot] of [['incomplete', incomplete], ['over the item bound', held(...many)], ['an intent without an artifact hash', malformed], ['no intents array', { complete: true }]]) {
    assert.equal((await classifyAddress(address, sourcesOf({ anchor: { [address]: snapshot } }))).kind, 'undetermined', label);
  }
  const retained = createWith(address, 'signed');
  assert.equal((await classifyAddress(address, sourcesOf({ ...retained, history: { [ARTIFACT]: { records: [record(1, 'signed')], complete: false } } }))).kind, 'undetermined', 'an incomplete history');
  assert.equal((await classifyAddress(address, sourcesOf({ ...retained, executed: async () => ({ address, finalized: true, verified: false }) }))).kind, 'undetermined', 'an unverified execution');
});

test('the never-dispatched proof follows the history the effect boundary writes: a started record is cleared only by its own stage\'s withheld record', async () => {
  const address = 'did:demos:agent:' + '9'.repeat(64);
  const kindOfStates = async (...states) => (await classifyAddress(address, sourcesOf(createWith(address, ...states)))).kind;
  assert.equal(await kindOfStates('signed'), 'never-dispatched', 'signed and never started');
  assert.equal(await kindOfStates(...WITHHELD_PASS), 'never-dispatched', 'started, then withheld after its checks refused');
  assert.equal(await kindOfStates('signed', 'dispatch-started'), 'undetermined', 'started and nothing after it');
  assert.equal(await kindOfStates('signed', 'dispatch-started', { state: 'dispatch-withheld', of: 2 }, 'dispatch-started'), 'undetermined', 'a later started record has no withheld record of its own');
  assert.equal(await kindOfStates('signed', 'dispatch-started', 'dispatch-started', { state: 'dispatch-withheld', of: 3 }), 'undetermined', 'an earlier started record is not erased by a later withheld one');
  assert.equal(await kindOfStates('signed', 'confirm-started', { state: 'dispatch-withheld', of: 2 }), 'undetermined', 'a withheld record of another stage names no started record of its own stage');
  assert.equal(await kindOfStates('signed', 'dispatch-started', { state: 'dispatch-withheld', of: 9 }), 'undetermined', 'a withheld record naming no started record');
  assert.equal(await kindOfStates('signed', { state: 'dispatch-withheld', of: 1 }), 'undetermined', 'a withheld record with no started record, a history the seller never writes');
  assert.equal(await kindOfStates('signed', 'dispatch-started', { state: 'dispatch-withheld', of: 2 }, { state: 'dispatch-acknowledged', of: 2 }), 'undetermined', 'an acknowledgement is never erased by a withheld record');
  assert.equal(await kindOfStates('signed', 'broadcast-started', { state: 'broadcast-withheld', of: 2 }), 'never-dispatched', 'every stage follows the same rule');
});

test('a malformed or unknown history record gives an indeterminate result, never never-dispatched', async () => {
  const address = 'did:demos:agent:' + '8'.repeat(64), valid = [record(1, 'signed'), record(2, 'dispatch-started'), record(3, 'dispatch-withheld', ARTIFACT, 2)];
  const kindOfRecords = async (...records) => classifyAddress(address, sourcesOf({ ...createWith(address, 'signed'), history: { [ARTIFACT]: { records, complete: true } } }));
  assert.equal((await kindOfRecords(...valid)).kind, 'never-dispatched', 'the control');
  const rows = [
    ['an unknown state', record(4, 'dispatch-resent')],
    ['a state of an unknown stage', record(4, 'refund-started')],
    ['a state that is not a string', { ...record(4, 'signed'), state: 7 }],
    ['a dispatch-started record whose state is misspelled', record(4, 'dispatch-startd')],
    ['a record that is not an object', null],
    ['a record without an artifact hash', { seq: 4, state: 'signed' }],
    ['a record without a sequence', { ...record(4, 'dispatch-started'), seq: undefined }],
    ['a record with a fractional sequence', record(4.5, 'dispatch-started')],
    ['a withheld record without its `of`', record(4, 'dispatch-withheld')],
  ];
  for (const [label, bad] of rows) {
    const evidence = await kindOfRecords(...valid, bad);
    assert.equal(evidence.kind, 'undetermined', label); assert.equal(evidence.cause.code, 'context_compensation_undetermined', label);
  }
  assert.equal((await kindOfRecords(...valid, record(4, 'dispatch-resent', OTHER_ARTIFACT))).kind, 'undetermined', 'an unknown state of another artifact is not read past');
  assert.equal((await classifyAddress(address, sourcesOf({ ...createWith(address, 'signed'), history: { [ARTIFACT]: { records: valid, complete: true, extra: 1 } } }))).kind, 'never-dispatched');
});

test('a returned reply over the one MiB limit is undetermined from every source, and one within it is read', async () => {
  const address = 'did:demos:agent:' + '7'.repeat(64), padding = 'x'.repeat(1048576), small = 'x'.repeat(1000);
  const retained = createWith(address, ...WITHHELD_PASS);
  assert.equal((await classifyAddress(address, sourcesOf())).kind, 'no-intent', 'the control');
  const oversize = [
    ['an anchor reply with no intents', { anchor: { [address]: { intents: [], complete: true, padding } } }],
    ['a wallet reply with no intents', { wallet: { [address]: { intents: [], complete: true, padding } } }],
    ['a history', { ...retained, history: { [ARTIFACT]: { records: [record(1, 'signed'), { ...record(2, 'dispatch-started'), padding }, record(3, 'dispatch-withheld', ARTIFACT, 2)], complete: true } } }],
    ['a chain readback', { ...retained, executed: async () => ({ ...executedAt(address), padding }) }],
  ];
  for (const [label, spec] of oversize) {
    const evidence = await classifyAddress(address, sourcesOf(spec));
    assert.equal(evidence.kind, 'undetermined', label); assert.equal(evidence.cause.code, 'context_compensation_undetermined', label);
    assert.match(evidence.cause.message, /bytes/, label);
  }
  const retirement = sourcesOf({ ...createWith(address, 'signed', 'dispatch-started'), retired: {} });
  retirement.retirement = async () => ({ address, retired: true, artifactHashes: [ARTIFACT], padding });
  assert.equal((await classifyAddress(address, retirement)).kind, 'undetermined', 'a retirement reply');
  assert.equal((await classifyAddress(address, sourcesOf({ anchor: { [address]: { intents: [], complete: true, padding: small } } }))).kind, 'no-intent', 'a reply within the limit');
});

test('both exact retained addresses are required, read as they are spelled, and an incomplete set is never a vacuous no-effect', async () => {
  const buyer = 'did:demos:agent:' + 'e'.repeat(64) + '?jurisdiction=GB', seller = 'did:demos:agent:' + 'f'.repeat(64);
  const sources = sourcesOf();
  const proof = await compensationProof([buyer, seller], sources);
  assert.equal(proof.kind, 'no-effect');
  assert.deepEqual(sources.reads.anchor.map(read => read.address).sort(), [buyer, seller].sort(), 'the advisory parameter is kept');
  for (const [label, addresses] of [['one address', [buyer]], ['three addresses', [buyer, seller, buyer + 'x']], ['a duplicate', [buyer, buyer]], ['a non-string', [buyer, 7]], ['not a list', 'ab']]) {
    const untouched = sourcesOf(), refused = await compensationProof(addresses, untouched);
    assert.equal(refused.kind, 'undetermined', label); assert.equal(untouched.reads.anchor.length, 0, label);
  }
  const effectEvidence = createContextEffectEvidence(sourcesOf());
  await assert.rejects(effectEvidence({ vetAddresses: { buyer } }), { code: 'context_compensation_undetermined' });
  await assert.rejects(effectEvidence({ vetAddresses: { buyer, seller: buyer } }), { code: 'context_compensation_undetermined' });
  await assert.rejects(effectEvidence({ vetAddresses: { buyer, seller: '' } }), { code: 'context_compensation_undetermined' });
  assert.deepEqual((await effectEvidence({ vetAddresses: { buyer, seller } })).map(entry => entry.kind), ['no-intent', 'no-intent']);
});

test('a proof is effects-definite only when an address executed and every other address is clear', async () => {
  const buyer = 'did:demos:agent:' + '1'.repeat(64), seller = 'did:demos:agent:' + '2'.repeat(64);
  const created = createWith(seller, 'signed', 'dispatch-started');
  const executed = await compensationProof([buyer, seller], sourcesOf({ ...created, executed: [seller] }));
  assert.equal(executed.kind, 'effects-definite'); assert.deepEqual(executed.evidence.map(entry => entry.kind), ['no-intent', 'executed']);
  const unresolved = await compensationProof([buyer, seller], sourcesOf({ ...created, executed: [] }));
  assert.equal(unresolved.kind, 'undetermined'); assert.equal(unresolved.cause.code, 'context_compensation_undetermined');
  const one = await compensationProof([buyer, seller], sourcesOf({ ...createWith(buyer, 'signed', 'dispatch-started'), ...created, executed: [seller], anchor: { ...createWith(buyer).anchor, ...created.anchor } }));
  assert.equal(one.kind, 'undetermined', 'an executed address does not clear another that may have been dispatched');
});

// A store, capacity and admission transaction on a fake clock, with the real compensation proof reading the doubles in `control.sources`.
function world(t) {
  const directory = mkdtempSync(join(tmpdir(), 'TEST-compensation-proof-')), path = join(directory, 'transport.sqlite'), holds = new Set();
  const calls = { release: 0, wire: 0, evidence: 0 }, control = { clock: T0, sources: sourcesOf() }, wire = { latest: -1 };
  const policy = { async reserve(request) { holds.add(request.hold); return null; }, async release({ hold }) { calls.release++; holds.delete(hold); } };
  let store, admission, internals, capacity;
  function reopen() {
    store?.close();
    store = createSellerTransportStore({ path, generation: 'test-generation', now: () => control.clock, ready: () => true, maxContextRecords: 20, contextStartLimits: { maxStartsPerHour: 12, maxStartsPerBuyerPerHour: 5 } });
    internals = sellerStoreInternals(store);
    capacity = createPurchaseCapacity({ store, now: () => control.clock, sessionState: internals.sessionState });
    admission = createContextAdmissionTransaction({ store, policy, capacity, effectEvidence: row => { calls.evidence++; return createContextEffectEvidence(control.sources)(row); },
      inspectContextOutcome: () => ({ state: 'none' }), completeWire: () => {}, now: () => control.clock, ready: () => true, deadlines: { policyMs: 10000 } });
  }
  reopen();
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  function prepare(index = 0x11) {
    const jobId = generateCanonicalJobId({ timestamp: T0, entropy: Buffer.alloc(10, index) }), challengeScopeHash = hash('challenge-scope');
    const { sessionNonce: nonce } = store.challenges.issue({ jobId, buyer: BUYER }, challengeScopeHash);
    const bundle = { presentedBy: BUYER, sessionNonce: nonce, presentation: { proof: 'TEST-fixture' } };
    const attempt = { nonce, jobId, buyer: BUYER, challengeScopeHash, presentationHash: hash(canonicalize(bundle)), path: 'context' };
    const { owner } = store.challenges.attempt(attempt), bundleHash = identityBundleHash(bundle);
    const accepted = { buyerBundleText: canonicalize(bundle), buyerBundleHash: bundleHash, admission: { disposition: 'admitted', jobId, buyer: BUYER, buyerBundleHash: bundleHash, listingPin: PIN,
      participants: [{ role: 'buyer', claim: BUYER, ...SELLER_PROFILE }, { role: 'seller', claim: SELLER, ...SELLER_PROFILE }] },
      firstAdmission: { challengeExpiresAt: control.clock + 600000, generatedAt: control.clock, checkedAt: control.clock } };
    return { jobId, input: { jobId, buyer: BUYER, seller: SELLER, listingPin: PIN, contextScopeHash: hash(canonicalize(SCOPE)), nonce, presentationHash: attempt.presentationHash,
      owner, accepted, sellerBundlePresentedBy: SELLER, delegationExpiresAt: control.clock + HOUR, purchaseProfile: PROFILE } };
  }
  const reserveWire = async () => { calls.wire++; const attempt = ++wire.latest; return Object.freeze({ state: attempt === 0 ? 'new' : 'recover', operationId: hash('wire-operation'), attempt, leaseUntil: control.clock + 300000 }); };
  const row = jobId => JSON.parse(internals.db.prepare('SELECT record FROM kit_context_admissions WHERE jobId = ?').get(jobId).record);
  async function running() {
    const p = prepare(); await admission.begin(p.input); await admission.reserveContext(p.jobId, reserveWire);
    const addresses = row(p.jobId).vetAddresses; return { jobId: p.jobId, buyer: addresses.buyer, seller: addresses.seller };
  }
  function cutBeforeAbort(jobId) {
    const db = internals.db, exec = db.exec.bind(db);
    db.exec = sql => { if (sql === 'COMMIT' && row(jobId).state === 'aborted') { db.exec = exec; db.exec('ROLLBACK'); throw new Error('cut before the abort commit'); } return exec(sql); };
  }
  return { holds, calls, control, running, row, reopen, cutBeforeAbort, get admission() { return admission; }, get store() { return store; } };
}
const sweepTwice = async (w, startup = false) => { await w.admission.sweep({ startup }); await w.admission.sweep({ startup: false }); };
const restart = async w => { w.reopen(); await sweepTwice(w, true); };

test('a dispatch-started seller Vet CREATE that the chain then executes, with the buyer address no-intent, proves effects-definite and settles with no context outcome', async t => {
  const w = world(t), job = await w.running();
  w.control.sources = sourcesOf({ ...createWith(job.seller, 'signed', 'dispatch-started'), executed: [job.seller] });
  await w.admission.compensate(job.jobId, 'd'); await restart(w);
  const settled = w.row(job.jobId);
  assert.equal(settled.state, 'settled'); assert.equal(settled.contextOutcome, 'none'); assert.equal(settled.compensation.proof, 'effects-definite');
  assert.deepEqual(settled.compensation.evidence.map(entry => entry.kind), ['no-intent', 'executed']);
  assert.equal(w.holds.size, 0); assert.equal(w.calls.release, 1); assert.equal(w.calls.wire, 1, 'no new context attempt is started');
});

test('a dispatch-started CREATE whose sink proves retirement classifies retired, gives no-effect and aborts', async t => {
  const w = world(t), job = await w.running();
  w.control.sources = sourcesOf({ ...createWith(job.seller, 'signed', 'dispatch-started'), retired: { [job.seller]: [ARTIFACT] } });
  await w.admission.compensate(job.jobId, 'd'); await restart(w);
  const aborted = w.row(job.jobId);
  assert.equal(aborted.state, 'aborted'); assert.equal(aborted.compensation.proof, 'no-effect'); assert.deepEqual(aborted.compensation.evidence.map(entry => entry.kind), ['no-intent', 'retired']);
  assert.equal(w.holds.size, 0);
  const other = world(t), second = await other.running();
  other.control.sources = sourcesOf({ ...createWith(second.seller, 'signed', 'dispatch-started'), retired: { [second.seller]: [OTHER_ARTIFACT] } });
  await other.admission.compensate(second.jobId, 'd');
  assert.equal(other.row(second.jobId).state, 'compensating', 'a retirement of another artifact does not cover the dispatched one');
});

test('a Vet CREATE from the native artifact anchor, which has no non-execution proof, never classifies retired; the row stays compensating', async t => {
  const w = world(t), job = await w.running();
  w.control.sources = sourcesOf(createWith(job.seller, 'signed', 'dispatch-started'));
  assert.equal('retirement' in w.control.sources, false);
  await w.admission.compensate(job.jobId, 'd'); await restart(w);
  const kept = w.row(job.jobId);
  assert.equal(kept.state, 'compensating'); assert.equal(kept.cleanup.cause.code, 'context_compensation_undetermined'); assert.equal(w.holds.size, 1); assert.equal(w.admission.cleanupPending(), true);
});

test('a running row with both Vets finalized and no journal outcome proves effects-definite on the delegation grace trigger', async t => {
  const w = world(t), job = await w.running();
  w.control.sources = sourcesOf({ anchor: { [job.buyer]: held(intent(true, OTHER_ARTIFACT)), [job.seller]: held(intent()) }, wallet: { [job.buyer]: held(intent(true, OTHER_ARTIFACT)), [job.seller]: held(intent()) },
    history: { [ARTIFACT]: { records: [record(1, 'signed'), record(2, 'dispatch-acknowledged')], complete: true }, [OTHER_ARTIFACT]: { records: [record(1, 'signed', OTHER_ARTIFACT), record(2, 'dispatch-acknowledged', OTHER_ARTIFACT)], complete: true } },
    executed: [job.buyer, job.seller] });
  w.control.clock = T0 + HOUR + GRACE_MS; await w.admission.compensate(job.jobId, 'c');
  const settled = w.row(job.jobId);
  assert.equal(settled.state, 'settled'); assert.equal(settled.contextOutcome, 'none'); assert.equal(w.calls.wire, 1); assert.equal(w.holds.size, 0);
});

test('a Vet CREATE whose only pass was withheld after the row was fenced is never-dispatched; with the other address no-intent the row aborts', async t => {
  const w = world(t), job = await w.running();
  w.control.sources = sourcesOf(createWith(job.seller, ...WITHHELD_PASS));
  await w.admission.compensate(job.jobId, 'd');
  const aborted = w.row(job.jobId);
  assert.equal(aborted.state, 'aborted'); assert.deepEqual(aborted.compensation.evidence.map(entry => entry.kind), ['no-intent', 'never-dispatched']); assert.equal(w.calls.wire, 1);
});

test('a CREATE durable with no dispatch intent when the row is fenced, then a crash and two sweeps: never-dispatched, no-effect, aborted, the same result twice', async t => {
  const w = world(t), job = await w.running(), history = createWith(job.seller, 'signed');
  w.control.sources = sourcesOf({ ...history, history: () => { throw new Error('TEST history offline'); } });
  await w.admission.compensate(job.jobId, 'd');
  assert.equal(w.row(job.jobId).state, 'compensating');
  w.control.sources = sourcesOf(history); await restart(w);
  const first = w.row(job.jobId);
  assert.equal(first.state, 'aborted'); assert.equal(w.control.sources.reads.history.length, 1, 'the whole history is read'); assert.equal(first.compensation.evidence[1].kind, 'never-dispatched');
  await sweepTwice(w); assert.deepEqual(w.row(job.jobId), first);
});

test('an earlier unknown dispatch keeps the address undetermined whatever later replay records say; after the chain executes it, effects-definite', async t => {
  const w = world(t), job = await w.running();
  const laterRecords = ['signed', 'dispatch-started', { state: 'dispatch-unknown', of: 2 }, 'signed-held', 'dispatch-started', { state: 'dispatch-withheld', of: 5 }, 'observed'];
  w.control.sources = sourcesOf(createWith(job.seller, ...laterRecords));
  await w.admission.compensate(job.jobId, 'd'); await restart(w);
  assert.equal(w.row(job.jobId).state, 'compensating'); assert.equal(w.holds.size, 1);
  w.control.sources = sourcesOf({ ...createWith(job.seller, ...laterRecords), executed: [job.seller] });
  await w.admission.sweep({ startup: false });
  assert.equal(w.row(job.jobId).state, 'settled'); assert.equal(w.row(job.jobId).contextOutcome, 'none'); assert.equal(w.calls.wire, 1, 'nothing is transmitted again');
});

test('a stored proof is read again after a restart: a crash between the proof and the abort aborts only when the evidence still holds', async t => {
  for (const changed of [false, true]) {
    const w = world(t), job = await w.running();
    w.control.sources = sourcesOf(); w.cutBeforeAbort(job.jobId);
    await w.admission.compensate(job.jobId, 'd');
    const proven = w.row(job.jobId);
    assert.equal(proven.state, 'compensating'); assert.equal(proven.compensation.proof, 'no-effect'); assert.equal(w.calls.evidence, 1);
    w.control.sources = changed ? sourcesOf({ ...createWith(job.seller, 'signed', 'dispatch-started'), executed: [job.seller] }) : sourcesOf();
    w.reopen(); await w.admission.sweep({ startup: true });
    assert.equal(w.calls.evidence, 2, 'the saved proof is not reused');
    const after = w.row(job.jobId);
    assert.equal(after.state, changed ? 'settled' : 'aborted'); assert.equal(after.contextOutcome, changed ? 'none' : null);
  }
});
