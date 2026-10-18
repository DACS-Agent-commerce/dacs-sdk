// The Agreement CREATE step's operator RPC auth signatures under one Start
// (DACS_INTENT_APPROVAL=on): the SDK session makes them without a dialog
// (two source ones through sdk-provider.mjs sourceAuthHeaders, then confirmTx
// and broadcastTx inside the SDK's Demos.call), so the dialog lists them and
// the gate's fenced SDK class holds them, and every other step of the CREATE
// request, to the Start until the CREATE is issued. Also: a /intent/sign view
// that was not saved writes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixturePurchase, withListingHash, viewFor, identityFor, gatedWallet } from './helpers/start-intent.mjs';
import { buildIntent, describeIntent, OPERATOR_AUTH_SIGNATURES, OPERATOR_AUTH_TOTAL, DEVNET_CREATE_KIND } from '../public/portal-intent/intent.mjs';
import { createIntentGate, START_ANNOUNCEMENT } from '../public/portal-intent/gate.mjs';
import { runStart } from '../public/portal-intent/start-flow.mjs';
import { EmbeddedWalletError } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { applyIntentHooks, INTENT_HOOKS } from '../src/portal/intent-hooks.mjs';
import { attachIdentityPresentation } from '../src/dacs/listing.mjs';
import { planAgreement } from '../src/dacs/purchase-protocol.mjs';

const PUBLIC = fileURLToPath(new URL('../public/portal/', import.meta.url));
const w = await gatedWallet();
test.after(() => w.session.lock());
const now = Date.now();
const devnet = await withListingHash(fixturePurchase({ address: w.address, now, devnet: true }));
const intentFor = (p, recordId) => {
  const view = viewFor(p, { now, recordId });
  return buildIntent({ view, start: view.start, wallet: w.address, now });
};
const intentA = await intentFor(devnet, 'rec_aaaaaaaaaaaaaaaaaaaaaa');
const intentB = await intentFor(devnet, 'rec_bbbbbbbbbbbbbbbbbbbbbb');
const SIG = { type: 'ed25519', data: 'ab'.repeat(64) };

// A gate on the real session, its fenced SDK class over a recording base.
// pause(message): optional, awaited inside the base before it "signs" or,
// for call(), before the node answers. steps: the base's other SDK steps.
function fenced({ pause = null, clock = () => now } = {}) {
  const signed = [];
  const steps = [];
  const gate = createIntentGate({ approve: async () => true, now: clock });
  gate.attach(w.session);
  class Base {
    async signMessage(message) { if (pause) await pause(message); signed.push(message); return SIG; }
    // As the SDK's Demos.call: nodeCall reads, or execute with confirmTx/broadcastTx.
    async call(method, message, data, extra) { steps.push(`${method}:${extra || message}`); if (pause) await pause(extra || message); return { result: 200, method, extra }; }
    async connect(url) { steps.push(`connect:${url}`); return true; }
    async sign(transaction) { steps.push('tx-sign'); return { ...transaction, signed: true }; }
  }
  return { gate, signed, steps, Fenced: gate.fenceSdk(Base, EmbeddedWalletError) };
}
// The fenced anchor journal of `gate`, recording what it issues.
function journalOf(gate) {
  const puts = [];
  return { puts, journal: gate.fenceJournal({ get: async () => undefined, put: async (_key, value) => { puts.push(value.stage); }, withWalletLock: async (_key, work) => work() }, EmbeddedWalletError) };
}
const peer = (gate) => gate.peerStarted({ type: START_ANNOUNCEMENT, wallet: w.address });
const superseded = (e) => e instanceof EmbeddedWalletError && e.code === 'superseded' && /^Nothing was sent: a newer purchase start, a lock or another tab replaced this one while the wallet was preparing the Agreement record\..*this purchase is closed and nothing was paid/.test(e.message);

test('the fence needs the SDK class and the wallet session error class', () => {
  const gate = createIntentGate({ approve: async () => true });
  assert.throws(() => gate.fenceSdk(class {}), TypeError);
  assert.throws(() => gate.fenceSdk(null, EmbeddedWalletError), TypeError);
  assert.equal(gate.fencesSdk, false);
  gate.fenceSdk(class {}, EmbeddedWalletError);
  assert.equal(gate.fencesSdk, true);
});

test('outside the Agreement CREATE request the fenced SDK class signs as before (sign-in, payment, gate-checked steps)', async () => {
  const { gate, signed, Fenced } = fenced();
  assert.deepEqual(await new Fenced().signMessage('no start'), SIG);
  await gate.open(intentA);
  assert.deepEqual(await new Fenced().signMessage('a gate-checked step'), SIG, 'the gate checks these at its approve seam');
  const covered = gate.coverCreate({ request: async () => new Fenced().signMessage('auth') });
  await covered.request({});
  gate.finish();
  assert.deepEqual(await new Fenced().signMessage('payment auth after the Start'), SIG, 'the CREATE request ended, so nothing holds later signatures');
  assert.deepEqual(signed, ['no start', 'a gate-checked step', 'auth', 'payment auth after the Start']);
});

test('only a live Start that covers the Agreement CREATE can cover the request', async () => {
  const { gate } = fenced();
  assert.throws(() => gate.coverCreate({ request: async () => {} }), (e) => e.code === 'intent_mismatch' && e.field === 'intent');
  const fixture = await withListingHash(fixturePurchase({ address: w.address, now }));
  await gate.open(await intentFor(fixture, 'rec_cccccccccccccccccccccc'));
  assert.throws(() => gate.coverCreate({ request: async () => {} }), (e) => e.code === 'intent_mismatch' && e.field === 'step');
});

test('inside the CREATE request of a live Start: the two operator auth signatures, never a third', async () => {
  const { gate, signed, Fenced } = fenced();
  await gate.open(intentA);
  const covered = gate.coverCreate({ request: async () => { const sdk = new Fenced(); await sdk.signMessage('bind'); await sdk.signMessage('signature'); return sdk.signMessage('third'); } });
  // Of the 4 the record uses, 2 are source ones; a third source one is refused.
  await assert.rejects(covered.request({}), (e) => e instanceof EmbeddedWalletError && e.code === 'step' && /more than the 4 operator RPC auth signatures the Agreement record uses \(another source one\)/.test(e.message));
  assert.deepEqual(signed, ['bind', 'signature']);
  assert.equal(gate.lastRefusal.field, 'step');
});

test('a newer Start approved in this tab while an auth signature is pending: nothing is signed', async () => {
  const { gate, signed, Fenced } = fenced();
  await gate.open(intentA);
  let reached; let release;
  const pending = new Promise((resolve) => { reached = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  // Waiting before the fence, as sourceAuthHeaders waits on its hash.
  class Waiting extends Fenced { async signMessage(message) { reached(); await released; return super.signMessage(message); } }
  const outcome = gate.coverCreate({ request: async () => new Waiting().signMessage('bind') }).request({}).then(() => 'signed', (e) => e);
  await pending;
  await gate.open(intentB); // live, same wallet: only the generation tells the two apart
  assert.equal(gate.active, true);
  release();
  const error = await outcome;
  assert.ok(superseded(error), String(error?.message ?? error));
  assert.deepEqual(signed, [], 'the SDK was not asked');
  assert.equal(gate.lastRefusal.code, 'intent_mismatch');
  assert.equal(gate.lastRefusal.field, 'superseded');
});

test('a newer Start approved before the broker hands over the CREATE: the covered request signs nothing', async () => {
  const { gate, signed, Fenced } = fenced();
  await gate.open(intentA);
  const covered = gate.coverCreate({ request: async () => new Fenced().signMessage('bind') });
  await gate.open(intentB); // while the broker claims the CREATE
  assert.ok(superseded(await covered.request({}).then(() => 'signed', (e) => e)));
  assert.deepEqual(signed, []);
});

test('a peer Start while an auth signature is pending: nothing is signed', async () => {
  const { gate, signed, Fenced } = fenced();
  await gate.open(intentA);
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  class Waiting extends Fenced { async signMessage(message) { await released; return super.signMessage(message); } }
  const outcome = gate.coverCreate({ request: async () => new Waiting().signMessage('bind') }).request({}).then(() => 'signed', (e) => e);
  gate.peerStarted({ type: START_ANNOUNCEMENT, wallet: w.address });
  release();
  assert.ok(superseded(await outcome));
  assert.deepEqual(signed, []);
});

test('a write approval inside the covered CREATE request after the Start was dropped gets no dialog', async () => {
  let dialogs = 0;
  const gate = createIntentGate({ approve: async () => { dialogs++; return true; }, now: () => now });
  gate.attach(w.session);
  gate.fenceSdk(class {}, EmbeddedWalletError);
  await gate.open(intentA);
  dialogs = 0;
  const write = { method: 'sendTransaction', address: w.address, content: { kind: 'devnet-agreement-storage-create' } };
  const covered = gate.coverCreate({ request: async () => { gate.peerStarted({ type: START_ANNOUNCEMENT, wallet: w.address }); return gate.approve(write); } });
  assert.ok(superseded(await covered.request({}).then(() => 'approved', (e) => e)));
  assert.equal(dialogs, 0, 'no wallet dialog for the dropped Start\'s CREATE');
  assert.equal(await gate.approve(write), true, 'after the request, writes get the normal dialog again');
  assert.equal(dialogs, 1);
});

test('an auth signature that completes after a peer Start is discarded before the session can send it', async () => {
  let reached; let release;
  const pending = new Promise((resolve) => { reached = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  const { gate, signed, Fenced } = fenced({ pause: async () => { reached(); await released; } });
  await gate.open(intentA);
  let returned = null;
  const outcome = gate.coverCreate({ request: async () => { returned = await new Fenced().signMessage('signature'); } }).request({}).then(() => 'sent', (e) => e);
  await pending;
  gate.peerStarted({ type: START_ANNOUNCEMENT, wallet: w.address });
  release();
  assert.ok(superseded(await outcome));
  assert.deepEqual(signed, ['signature'], 'the SDK had already been asked');
  assert.equal(returned, null, 'its signature never reached the caller');
});

test('the dialog lists the operator RPC auth signatures with the Agreement record; the fixture profile has none', async () => {
  const text = describeIntent(intentA);
  const lines = text.split('\n');
  const create = lines.findIndex((line) => /one wallet write: the Agreement record/.test(line));
  assert.ok(create > 0);
  // The count is the gate's bound (OPERATOR_AUTH_SIGNATURES), which
  // start-intent-create-fence checks against the real CREATE on the wire.
  assert.equal(OPERATOR_AUTH_TOTAL, 4);
  assert.deepEqual({ ...OPERATOR_AUTH_SIGNATURES }, { source: 2, confirmTx: 1, broadcastTx: 1 });
  assert.equal(lines[create + 1], `   With the Agreement record the wallet also makes 4 operator RPC auth signatures: 2 for the source bind and signature requests, 1 when the node validates the record (confirmTx) and 1 when it broadcasts it (broadcastTx). Each signs only SHA-256 of "ed25519:${w.address}:<current time>": no transaction, no funds moved. If this start is replaced, locked or expires before the record is issued, the wallet stops: no more of these signatures and no new operator or node request, except freeing the source lease. A request already sent, including the SDK's automatic retries of it, cannot be recalled; its answer is discarded.`);
  assert.match(text, /Before each purchase signature the wallet checks the exact bytes against these values; it builds the operator RPC auth messages itself\./);
  const fixture = await withListingHash(fixturePurchase({ address: w.address, now }));
  const fixtureIntent = await intentFor(fixture, 'rec_dddddddddddddddddddddd');
  assert.doesNotMatch(describeIntent(fixtureIntent), /operator RPC auth/);
  // The approval note is shared by both profiles: it promises only what the
  // dialog lists (code review P3-C).
  const note = applyIntentHooks(PUBLIC).get('embedded-wallet/approval.mjs').body.toString('utf8');
  assert.match(note, /If an Agreement record is listed with operator RPC auth signatures, the wallet also makes exactly those; they sign no transaction and move no funds\./);
  assert.doesNotMatch(note, /the two operator RPC auth signatures/);
  // So is the Start dialog's purpose line: it names the auth signatures only on devnet.
  const purposes = [];
  const gate = createIntentGate({ approve: async (request) => { purposes.push(request.purpose); return false; }, now: () => now });
  gate.attach(w.session);
  for (const intent of [intentA, fixtureIntent]) await assert.rejects(gate.open(intent), (e) => e.field === 'rejected');
  assert.match(purposes[0], /the operator RPC auth signatures listed with the Agreement record are built by the wallet itself\.$/);
  assert.equal(purposes[1], 'Approve one bounded purchase start. Each later purchase signature is checked automatically against exactly these values.');
  const doc = readFileSync(new URL('../docs/START-INTENT.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.match(doc, /four operator RPC auth signatures: two for the source bind and signature requests, one when the node validates the record \(`confirmTx`\) and one when it broadcasts it \(`broadcastTx`\)\. The SDK makes the last two inside its own node request\. Each signs only SHA-256 of `ed25519:<address>:<timestamp>`, signs no transaction and moves no funds/);
  assert.doesNotMatch(doc, /two operator RPC auth signatures/);
  assert.doesNotMatch(doc, /before SDK signature requests, so no step is requested twice/);
  // What the fence covers, and the one request it lets through (both reviews' P3).
  assert.match(doc, /every step of the CREATE request until the wallet records it as issued: each SDK signature \(the source auth signatures and the CREATE transaction\), each node request \(reads, `confirmTx`\) and each source phase \(bind, signature, broadcast\), checked before it starts and again before its answer is used \(including source errors\), and the issuance itself/);
  assert.match(doc, /The source lease release still runs: it only frees the lease, signs nothing and sends nothing for the record\./);
  assert.doesNotMatch(doc, /sends no source request,/);
});

test('switch on, the hooked bridge builds the session from the gate\'s fenced SDK class', () => {
  const bridge = applyIntentHooks(PUBLIC).get('embedded-wallet-bridge.mjs').body.toString('utf8');
  assert.match(bridge, /export async function sessionFactory\(\{ approve, transactionTransport, anchorJournal, fenceSdk = null \}\) \{\n/);
  assert.match(bridge, /createSdkWalletSession\(\{ DemosCtor: fenceSdk \? fenceSdk\(Demos\) : Demos, /);
});

test('switch on, each source phase of the session\'s Agreement CREATE asks the fenced SDK class first; the shipped file has no hook', () => {
  const served = applyIntentHooks(PUBLIC).get('embedded-wallet/sdk-provider.mjs').body.toString('utf8');
  const shipped = readFileSync(new URL('../public/portal/embedded-wallet/sdk-provider.mjs', import.meta.url), 'utf8');
  const hook = '    const sourcePhase=async(body)=>{demos.holdSourcePhase?.(body.phase);try{const auth=';
  assert.equal(served.split(hook).length, 2, 'once, before the auth headers and the request');
  assert.equal(served, INTENT_HOOKS.filter((h) => h.asset === 'embedded-wallet/sdk-provider.mjs').reduce((text, h) => text.replace(h.anchor, h.replacement), shipped), 'only the declared switch-on hooks change the session module');
  assert.match(served, /return v;\}finally\{demos\.holdSourcePhase\?\.\(body.phase\);\}\};/);
  assert.match(served, /export const INTENT_SOURCE_PHASE_FENCE = true;/);
  assert.doesNotMatch(shipped, /holdSourcePhase/);
});

test('a devnet Start on a session without the SDK fence signs nothing', async () => {
  const gate = createIntentGate({ approve: async () => assert.fail('no dialog') });
  gate.attach(w.session);
  const view = viewFor(devnet, { now, recordId: 'rec_eeeeeeeeeeeeeeeeeeeeee' });
  const api = async (path) => { if (path.endsWith('/start')) return view; assert.fail(`unexpected ${path}`); };
  await assert.rejects(runStart({ id: devnet.id, token: 't', address: w.address, gate, api, origin: 'http://127.0.0.1', broker: {}, provider: {}, now: () => now }), /cannot hold its operator RPC auth signatures to the Start; nothing was signed/);
});

test('a /intent/sign view that lost to newer saved progress is re-checked; no Agreement CREATE is armed or delivered', async () => {
  const g = await gatedWallet();
  test.after(() => g.session.lock());
  const p = await withListingHash(fixturePurchase({ address: g.address, now, devnet: true }));
  const view = viewFor(p, { now, recordId: 'rec_ffffffffffffffffffffff' });
  const unsigned = identityFor(p, g.address, now);
  view.start.identity = { bundle: unsigned.bundle };
  const paths = [];
  const api = async (path, body) => {
    paths.push(path.split('/').pop());
    if (path.endsWith('/start')) return { ...view, start: { ...view.start, needs: { identitySignature: true } } };
    if (path.endsWith('/plan')) {
      const planned = planAgreement({ jobId: p.jobId, listing: p.listing, buyerBundle: attachIdentityPresentation(unsigned, body.signature), generatedAt: now });
      return { plan: { needs: { agreementSignature: false }, draft: planned.draft } };
    }
    if (path.endsWith('/sign')) return { status: 'agreement_pending', evidence: { protocol: { stage: 'agreement-signing', notSaved: { savedRevision: 4, savedStage: 'agreement-signing' } } } };
    throw new Error(`unexpected ${path}`);
  };
  const saved = { status: 'agreement_pending', evidence: { protocol: { stage: 'agreement-signing' } } };
  let rechecks = 0;
  let armed = 0;
  const gate = Object.create(g.gate, {
    expectAgreementCreate: { value: () => { armed++; return g.gate.expectAgreementCreate(); } },
    coverCreate: { value: (provider) => { armed++; return g.gate.coverCreate(provider); } },
  });
  const broker = { authenticate: async () => {}, approveOne: async () => assert.fail('no CREATE is delivered from a view that was not saved') };
  const next = await runStart({ id: p.id, token: 't', address: g.address, gate, api, origin: 'http://127.0.0.1', broker, provider: { request: async () => assert.fail('no wallet request') }, recheck: async () => { rechecks++; return saved; }, now: () => now });
  assert.equal(next, saved, 'the saved state, as re-checked');
  assert.equal(rechecks, 1);
  assert.equal(armed, 0, 'the CREATE was never armed');
  assert.deepEqual(paths, ['start', 'plan', 'sign']);
  assert.equal(g.gate.active, false, 'the Start ended');
});

// ---- Every step of the CREATE request until issuance (a review P2), and one invocation (a review P3) ----

const expired = (e) => e instanceof EmbeddedWalletError && e.code === 'expiry' && /^Nothing was sent: the approved purchase start expired; start again\. The wallet declined the write, so this purchase is closed and nothing was paid/.test(e.message);

test('inside the CREATE request every node request and SDK step is held to the Start before it starts; after a peer Start nothing more is sent', async () => {
  const { gate, steps, Fenced } = fenced();
  await gate.open(intentA);
  const sdk = new Fenced();
  const covered = gate.coverCreate({ request: async () => {
    await sdk.connect('rpc');
    await sdk.call('nodeCall', 'getNetworkInfo', {});
    await sdk.sign({ content: {} });
    await sdk.call('execute', '', {}, 'confirmTx');
    peer(gate);
    await sdk.call('nodeCall', 'getNetworkInfo', {});
  } });
  assert.ok(superseded(await covered.request({}).then(() => 'sent', (e) => e)));
  assert.deepEqual(steps, ['connect:rpc', 'nodeCall:getNetworkInfo', 'tx-sign', 'execute:confirmTx'], 'the node read after the drop was never sent');
  // Outside any CREATE request the class works as the SDK does.
  assert.equal(await sdk.connect('rpc'), true);
  assert.deepEqual(await sdk.call('nodeCall', 'getNetworkInfo', {}), { result: 200, method: 'nodeCall', extra: undefined });
  assert.deepEqual(steps.slice(4), ['connect:rpc', 'nodeCall:getNetworkInfo']);
});

for (const step of ['confirmTx', 'getNetworkInfo']) {
  test(`an answer to ${step} that arrives after a peer Start is discarded before the session can use it`, async () => {
    let reached; let release;
    const pending = new Promise((resolve) => { reached = resolve; });
    const released = new Promise((resolve) => { release = resolve; });
    const { gate, steps, Fenced } = fenced({ pause: async (what) => { if (what === step) { reached(); await released; } } });
    await gate.open(intentA);
    let answered = null;
    const outcome = gate.coverCreate({ request: async () => {
      answered = step === 'confirmTx' ? await new Fenced().call('execute', '', {}, 'confirmTx') : await new Fenced().call('nodeCall', 'getNetworkInfo', {});
    } }).request({}).then(() => 'used', (e) => e);
    await pending;
    peer(gate);
    release();
    assert.ok(superseded(await outcome));
    assert.equal(steps.length, 1, 'the request had been sent');
    assert.equal(answered, null, 'its answer never reached the session');
  });
}

test('the source phases: bind, signature and broadcast are held to the Start; the lease release is not, and outside the CREATE request nothing is held', async () => {
  const { gate, Fenced } = fenced();
  const sdk = new Fenced();
  for (const phase of ['bind', 'signature', 'broadcast', 'release']) assert.equal(sdk.holdSourcePhase(phase), undefined, `${phase} outside a CREATE request`);
  await gate.open(intentA);
  const seen = [];
  const answer = await gate.coverCreate({ request: async () => {
    for (const phase of ['bind', 'signature', 'broadcast']) { sdk.holdSourcePhase(phase); seen.push(phase); }
    peer(gate);
    for (const phase of ['bind', 'signature', 'broadcast']) assert.throws(() => sdk.holdSourcePhase(phase), superseded, phase);
    sdk.holdSourcePhase('release');
    seen.push('release');
    return { success: true, data: null, error: null };
  } }).request({});
  assert.deepEqual(seen, ['bind', 'signature', 'broadcast', 'release'], 'only the release after the drop');
  assert.equal(answer.success, true);
});

test('the CREATE\'s operator RPC auth signatures: 2 source and confirmTx before issuance, broadcastTx only after it, never more', async () => {
  const { gate, signed, steps, Fenced } = fenced();
  const sdk = new Fenced();
  const step = (e) => e instanceof EmbeddedWalletError && e.code === 'step';
  // A broadcastTx before the record is issued is refused, and never sent.
  await gate.open(intentA);
  await assert.rejects(gate.coverCreate({ request: async () => { await sdk.signMessage('bind'); await sdk.call('execute', '', {}, 'broadcastTx'); } }).request({}),
    (e) => step(e) && /asked for the broadcastTx operator RPC auth signature before the Agreement record was issued/.test(e.message));
  assert.deepEqual(steps, [], 'never sent');
  // A second confirmTx, or another auth-signed node request, is refused.
  for (const extra of ['confirmTx', 'web2ProxyRequest']) {
    steps.length = 0;
    await gate.open(intentA);
    await assert.rejects(gate.coverCreate({ request: async () => { if (extra === 'confirmTx') await sdk.call('execute', '', {}, 'confirmTx'); await sdk.call('execute', '', {}, extra); } }).request({}),
      (e) => step(e) && new RegExp(`more than the ${OPERATOR_AUTH_TOTAL} operator RPC auth signatures the Agreement record uses \\(another ${extra} one\\)`).test(e.message));
    assert.deepEqual(steps, extra === 'confirmTx' ? ['execute:confirmTx'] : []);
  }
  // The whole CREATE: exactly these, in this order; none after the broadcast.
  // That refusal comes after issuance: only the extra request fails, and the
  // purchase is not declined (the buyer's refusal stays as it was).
  steps.length = 0;
  signed.length = 0;
  await gate.open(intentA);
  const refusalBefore = gate.lastRefusal;
  const { journal, puts } = journalOf(gate);
  await assert.rejects(gate.coverCreate({ request: async () => {
    await sdk.signMessage('bind');
    await sdk.signMessage('signature');
    await sdk.call('nodeCall', 'getAddressNonce', {});
    await sdk.call('execute', '', {}, 'confirmTx');
    await journal.put('lane', { stage: 'broadcast-started' });
    await sdk.call('execute', '', {}, 'broadcastTx');
    await journal.put('lane', { stage: 'broadcast-accepted' });
    await sdk.call('execute', '', {}, 'confirmTx');
  } }).request({}), (e) => step(e) && /^Nothing was signed: the wallet was asked for more than the 4 operator RPC auth signatures the Agreement record uses \(another confirmTx one\)$/.test(e.message));
  assert.equal(gate.lastRefusal, refusalBefore);
  assert.deepEqual(signed, ['bind', 'signature']);
  assert.deepEqual(steps, ['nodeCall:getAddressNonce', 'execute:confirmTx', 'execute:broadcastTx']);
  assert.deepEqual(puts, ['broadcast-started', 'broadcast-accepted']);
  assert.equal(signed.length + steps.filter((s) => s.startsWith('execute:')).length, OPERATOR_AUTH_TOTAL);
  // A confirmTx only after issuance is out of order.
  steps.length = 0;
  await gate.open(intentA);
  const late = journalOf(gate);
  await assert.rejects(gate.coverCreate({ request: async () => { await late.journal.put('lane', { stage: 'broadcast-started' }); await sdk.call('execute', '', {}, 'confirmTx'); } }).request({}),
    (e) => step(e) && /asked for the confirmTx operator RPC auth signature after the Agreement record was issued/.test(e.message));
  assert.deepEqual(steps, []);
});

test('a peer Start after the CREATE is issued changes nothing: its one broadcast goes out and nothing is refused', async () => {
  const { gate, steps, Fenced } = fenced();
  const sdk = new Fenced();
  await gate.open(intentA);
  const { journal, puts } = journalOf(gate);
  const answer = await gate.coverCreate({ request: async () => {
    await sdk.call('execute', '', {}, 'confirmTx');
    await journal.put('lane', { stage: 'broadcast-started' });
    peer(gate);
    await sdk.call('execute', '', {}, 'broadcastTx');
    await journal.put('lane', { stage: 'broadcast-accepted' });
    return { success: true, data: { hash: 'h', nonce: 1 }, error: null };
  } }).request({});
  assert.equal(answer.success, true);
  assert.deepEqual(steps, ['execute:confirmTx', 'execute:broadcastTx'], 'broadcast once, never again');
  assert.deepEqual(puts, ['broadcast-started', 'broadcast-accepted']);
  assert.equal(gate.lastRefusal, null);
  assert.equal(gate.active, false, 'the Start itself was still replaced');
});

test('a write approved before its Start expired is not issued after expiry (no CREATE request around it)', async () => {
  // a review scenario: the approval happened, then only the gate clock moves.
  const clock = { now: Date.now() };
  const { g, intent, write } = await approvedCreate(clock, 'rec_8888888888888888888888');
  assert.equal(await g.gate.approve(write), true);
  clock.now = intent.expiresAt + 1;
  const { journal, puts } = journalOf(g.gate);
  await assert.rejects(journal.put('lane', { stage: 'broadcast-started' }), expired);
  assert.deepEqual(puts, [], 'never issued, so never broadcast');
  assert.equal(g.gate.lastRefusal.field, 'expiry');
});

for (const at of ['issuance', 'confirmTx']) {
  test(`inside the CREATE request, a Start that expires after the write approval is refused at ${at} with field expiry; nothing later runs`, async () => {
    const clock = { now: Date.now() };
    const { g, intent, write } = await approvedCreate(clock, at === 'issuance' ? 'rec_9999999999999999999999' : 'rec_7777777777777777777777');
    const steps = [];
    class Base { async call(method, message, data, extra) { steps.push(`${method}:${extra || message}`); return { result: 200 }; } }
    const sdk = new (g.gate.fenceSdk(Base, EmbeddedWalletError))();
    const { journal, puts } = journalOf(g.gate);
    const answer = await g.gate.coverCreate({ request: async () => {
      try {
        assert.equal(await g.gate.approve(write), true);
        if (at === 'confirmTx') clock.now = intent.expiresAt;
        await sdk.call('execute', '', {}, 'confirmTx');
        clock.now = intent.expiresAt + 1;
        await journal.put('lane', { stage: 'broadcast-started' });
        await sdk.call('execute', '', {}, 'broadcastTx');
        return { success: true, data: { hash: 'h', nonce: 1 }, error: null };
      } catch (error) {
        assert.ok(expired(error), String(error?.message ?? error));
        // A later step is refused with the same reason, and sends nothing.
        await assert.rejects(sdk.call('nodeCall', 'getNetworkInfo', {}), expired);
        assert.throws(() => sdk.holdSourcePhase('broadcast'), expired);
        sdk.holdSourcePhase('release');
        return { success: false, data: null, error: { code: 'upstream_unavailable', message: 'as the session wraps it' } };
      }
    } }).request({});
    assert.deepEqual(steps, at === 'issuance' ? ['execute:confirmTx'] : []);
    assert.deepEqual(puts, []);
    assert.equal(g.gate.lastRefusal.field, 'expiry');
    // The broker records the fence's reason, not the session's wrapper.
    assert.deepEqual(answer, { success: false, data: null, error: { code: 'expiry', message: g.gate.lastRefusal.message } });
  });
}

test('the covered provider is one-shot: a second invocation is refused before the wallet is asked, so the auth-signature bound never restarts', async () => {
  const { gate, signed, Fenced } = fenced();
  await gate.open(intentA);
  let calls = 0;
  const failed = { success: false, data: null, error: { code: 'upstream_unavailable', message: 'the node did not answer' } };
  const covered = gate.coverCreate({ request: async () => { calls++; const sdk = new Fenced(); await sdk.signMessage('bind'); await sdk.signMessage('signature'); return failed; } });
  assert.equal(await covered.request({}), failed, 'a failure the fence did not cause is reported as the session reported it');
  await assert.rejects(covered.request({}), (e) => e.code === 'intent_mismatch' && e.field === 'step' && /already handed to the wallet once; it is never requested again/.test(e.message));
  assert.equal(calls, 1, 'the wallet was asked once');
  assert.deepEqual(signed, ['bind', 'signature'], 'no fresh pair of auth signatures');
  // Two covered CREATE requests on one wallet never overlap either.
  await gate.open(intentB);
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const first = gate.coverCreate({ request: async () => { await released; return 'first'; } });
  const second = gate.coverCreate({ request: async () => assert.fail('never asked') });
  const running = first.request({});
  await assert.rejects(second.request({}), (e) => e.field === 'step' && /another Agreement CREATE request is still running/.test(e.message));
  release();
  assert.equal(await running, 'first');
});

// A gate with a checked, armed devnet CREATE on the real session (a review setup).
async function approvedCreate(clock, recordId) {
  const g = await gatedWallet({ now: () => clock.now });
  test.after(() => g.session.lock());
  const p = await withListingHash(fixturePurchase({ address: g.address, now: clock.now, devnet: true }));
  const view = viewFor(p, { now: clock.now, recordId, recordTtlMs: 60_000 });
  const unsigned = identityFor(p, g.address, clock.now);
  view.start.identity = { bundle: unsigned.bundle };
  const intent = await buildIntent({ view, start: view.start, wallet: g.address, now: clock.now });
  await g.gate.open(intent);
  const signature = await g.gate.signIdentity(view.start.identity.bundle);
  const plan = planAgreement({ jobId: p.jobId, listing: p.listing, buyerBundle: attachIdentityPresentation(unsigned, signature), generatedAt: clock.now });
  await g.gate.noteAgreement(plan.draft);
  g.gate.expectAgreementCreate();
  const write = { method: 'sendTransaction', address: g.address, content: { kind: DEVNET_CREATE_KIND, artifactKind: 'Agreement', jobId: p.jobId, logicalAddress: `dacs3:agreement:${p.jobId}`,
    owner: intent.buyer, wallet: g.address, contentHash: plan.plan.agreementHash, exactStorageBytes: JSON.stringify(plan.draft), network: intent.network.name, chainIdentity: intent.network.chainIdentity, nonce: 1, debit: { totalOs: '1' } } };
  return { g, intent, write };
}

test('the Start docs disclose automatic retries of a request already sent after a drop', () => {
  const docs = readFileSync(new URL('../docs/START-INTENT.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.match(docs, /already sent when the Start is dropped, including the SDK's automatic retries of it, cannot be recalled; its answer is discarded/);
});
