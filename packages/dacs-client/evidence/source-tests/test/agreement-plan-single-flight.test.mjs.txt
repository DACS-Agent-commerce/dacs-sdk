// One Agreement plan step per purchase (src/dacs/protocol-purchases.mjs
// planRequest) and the portal's handling of a plan-step error
// (public/portal/portal.js signAgreement). From a live testnet purchase: the
// plan request waited in a seller approval prompt for longer than the page's
// request lived, the page ran the step again, and the second plan step re-ran
// the buyer Vet. Loopback servers and SIMULATED fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createDemDeliveryContext } from '../src/dacs/dem-delivery-context-consumer.mjs';
import { cutText } from '../src/util/text.mjs';
import { startProtocolHarness, addSeller } from './dacs-loopback-fixture.test.mjs';
import { linkedUser, tool, portal, tokenFrom } from './helpers/flows.mjs';
import { memoryAnchorJournal } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';

installLoopbackOnlyGuard();
let n = 0;
const key = () => `plan-single-flight-${++n}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The provider's surfaced failure from the live case (writer error first).
const WRITER_FAILURE = 'seller Vet record write failed (conflict: immutable demo artifact intent differs); Vet composite-anchor step failed: seller CVR submission outcome is indeterminate; refusing to resubmit';

async function setup(t, options = {}) {
  const h = await startProtocolHarness(options);
  t.after(() => h.close());
  const buyer = await linkedUser(h);
  const seller = await addSeller(h, { listingId: key() });
  return { h, buyer, seller };
}

test('concurrent plan requests for one purchase share one plan step; other signatures are told it is running; the attempt note keeps the writer error', async (t) => {
  const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
  let reads = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const demDeliveryContext = createDemDeliveryContext({ authority: 'TEST-plan-single-flight', resolveBuyer: async () => { reads += 1; await gate; throw new Error(WRITER_FAILURE); }, resolveSeller: async () => { throw new Error('TEST unexpected seller resolver'); } });
  const { h, buyer, seller } = await setup(t, { demDeliveryContext, browserAgreement: { journal }, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  const p = await tool(h, buyer, 'prepare_purchase', { listingId: seller.published.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: key(), protocol: 'dacs-sr2-wallet-agreement' });
  const token = tokenFrom(p.approvalUrl), path = `/portal/api/purchase/${p.operationId}/`;
  const identity = await portal(h, `${path}agreement/identity`, { token, address: buyer.wallet.address });
  assert.equal(identity.error, undefined, JSON.stringify(identity));
  const signature = buyer.wallet.signHex(identity.signRequest.message);
  const first = portal(h, `${path}agreement/plan`, { token, signature });
  while (reads === 0) await sleep(5);
  const rpcBefore = h.chain.faults.rpcCalls.length;
  // The page running the step again signs the same message: it waits.
  const second = portal(h, `${path}agreement/plan`, { token, signature });
  // Another signature gets a clear answer at once; nothing is read for it.
  const other = await portal(h, `${path}agreement/plan`, { token, signature: buyer.wallet.signHex('another message') });
  assert.equal(other.status, 409); assert.equal(other.error, 'plan_in_progress');
  assert.match(other.message, /already running.*Check the purchase status/);
  await sleep(200);
  assert.equal(reads, 1, 'one context read while the plan step runs');
  assert.deepEqual(h.chain.faults.rpcCalls.slice(rpcBefore), [], 'no domain, balance or fee read for a request that waits or is refused');
  release();
  const [a, b] = await Promise.all([first, second]);
  for (const out of [a, b]) {
    assert.equal(out.status, 409, JSON.stringify(out)); assert.equal(out.error, 'agreement_context_held');
    assert.equal(out.message, `the operator Agreement context is indeterminate (DEM delivery context failed: ${WRITER_FAILURE}); no Agreement was planned or signed`);
  }
  assert.equal(reads, 1);
  // The status the page reads names the writer's error, not only "indeterminate".
  const view = await portal(h, `${path}view`, { token });
  assert.deepEqual({ ...view.evidence.protocol.lastAttempt, at: undefined }, { at: undefined, step: 'agreement-context', outcome: 'indeterminate', reason: `DEM delivery context failed: ${WRITER_FAILURE}` });
  // The finished step leaves nothing behind: the next request runs its own.
  const next = await portal(h, `${path}agreement/plan`, { token, signature });
  assert.equal(next.error, 'agreement_context_held');
  assert.equal(reads, 2);
});

// The portal's own plan-step handling (public/portal/portal.js), run against
// the real portal API. A plan request "loses its response" the way a tunnel's
// response limit drops it, whether or not the server finished the step.
function portalSignAgreement(w, seen) {
  const source = readFileSync(new URL('../public/portal/portal.js', import.meta.url), 'utf8');
  const start = source.indexOf('  async function savedPlan() {'), body = source.indexOf('  async function signAgreement(t) {');
  assert.ok(start > 0 && body > start, 'the portal checks a plan saved after a plan-step error');
  const context = {
    id: w.p.operationId, token: w.p.token, address: w.buyer.wallet.address, offlineAgreementBroker: null, provider: null,
    needWallet() {}, needPaymentNetwork() {}, needBoundWallet() {}, log(message, kind) { seen.logs?.push({ message, kind }); },
    checkSellerSessionDelegation() { throw new Error('TEST no delegation expected'); },
    walletSign(message) { seen.signs.push(message); return w.buyer.wallet.signHex(message); },
    render(view) { seen.rendered = view; },
    async api(path, body) {
      const step = path.split('/').slice(-2).join('/');
      seen.calls.push(step);
      if (step === 'agreement/plan' && body.signature !== undefined && seen.lose > 0) {
        seen.lose -= 1;
        if (seen.serverFinishes) await portal(w.h, path, body);
        throw new Error('request failed (524)');
      }
      // The server's 202: api() resolves on any 2xx, as the page's does.
      // A definitive refusal the server gave, with its code.
      if (step === 'agreement/plan' && body.signature !== undefined && seen.refuse) throw Object.assign(new Error(`TEST ${seen.refuse}`), { code: seen.refuse });
      if (step === 'agreement/plan' && body.signature !== undefined && seen.accepted > 0) {
        seen.accepted -= 1;
        return { error: 'plan_in_progress', message: 'the Agreement plan step for this purchase is still running' };
      }
      const data = await portal(w.h, path, body);
      if (data.error) throw Object.assign(new Error(data.message), { code: data.error });
      return data;
    },
  };
  vm.createContext(context);
  return vm.runInContext(`${source.slice(start, source.indexOf('\n  }\n', body) + 4)}\nsignAgreement;`, context);
}

async function world(t) {
  const { h, buyer, seller } = await setup(t);
  const p = await tool(h, buyer, 'prepare_purchase', { listingId: seller.published.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: key(), protocol: 'dacs-pay-dem' });
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  const accountId = h.app.services.accounts.walletOwner(buyer.wallet.address);
  return { h, buyer, p: { ...p, token: tokenFrom(p.approvalUrl) }, get: () => h.app.services.ops.get(accountId, p.operationId),
    planned: () => h.app.services.ops.history(p.operationId).filter((e) => e.type === 'protocol_agreement_planned').length };
}

test('portal: a plan step whose response was lost after the server saved the plan continues from that plan', async (t) => {
  const w = await world(t);
  const seen = { calls: [], signs: [], lose: 1, serverFinishes: true };
  await portalSignAgreement(w, seen)(w.get().terms);
  assert.deepEqual(seen.calls, [`${w.p.operationId}/view`, 'agreement/identity', 'agreement/plan', `${w.p.operationId}/view`, 'agreement/plan', 'agreement/sign']);
  const planned = w.get().state.protocol.planned;
  assert.deepEqual(seen.signs.slice(1), [planned.agreementMessage, planned.anchorMessage], 'identity once, then the saved Agreement');
  assert.equal(w.planned(), 1);
  assert.notEqual(w.get().state.protocol.stage, 'agreement-signing', 'the Agreement was submitted');
  assert.ok(seen.rendered);
});

test('portal: running the step again after a plan-step error, or after a reload, checks the status first and signs nothing before the saved Agreement', async (t) => {
  const w = await world(t);
  const seen = { calls: [], signs: [], lose: 1, serverFinishes: false, logs: [] };
  const signAgreement = portalSignAgreement(w, seen);
  await assert.rejects(signAgreement(w.get().terms), /request failed \(524\)/);
  assert.deepEqual(seen.calls, [`${w.p.operationId}/view`, 'agreement/identity', 'agreement/plan', `${w.p.operationId}/view`]);
  assert.ok(seen.logs.some(({ message, kind }) => kind === 'warn' && /Nothing new was sent\./.test(message)));
  assert.equal(w.get().state.protocol.stage, 'identity');
  // The original plan step finishes on the server after the page gave up.
  const presentation = w.buyer.wallet.signHex(seen.signs[0]);
  assert.equal((await portal(w.h, `/portal/api/purchase/${w.p.operationId}/agreement/plan`, { token: w.p.token, signature: presentation })).error, undefined);
  // A reloaded page keeps nothing from the failed attempt.
  seen.calls = []; seen.signs = [];
  await portalSignAgreement(w, seen)(w.get().terms);
  assert.deepEqual(seen.calls, [`${w.p.operationId}/view`, 'agreement/plan', 'agreement/sign'], 'no identity request');
  const planned = w.get().state.protocol.planned;
  assert.deepEqual(seen.signs, [planned.agreementMessage, planned.anchorMessage], 'no identity or app-session signature');
  assert.equal(w.planned(), 1);
});

test('portal: after a plan-step error, a purchase that is no longer pending is shown and nothing is signed', async (t) => {
  const w = await world(t);
  const seen = { calls: [], signs: [], lose: 1, serverFinishes: false };
  const signAgreement = portalSignAgreement(w, seen);
  await assert.rejects(signAgreement(w.get().terms), /request failed \(524\)/);
  const accountId = w.h.app.services.accounts.walletOwner(w.buyer.wallet.address);
  assert.equal((await w.h.app.services.purchases.cancel({ accountId, operationId: w.p.operationId })).cancelled, true);
  seen.calls = []; seen.signs = [];
  await signAgreement(w.get().terms);
  assert.deepEqual(seen.calls, [`${w.p.operationId}/view`]);
  assert.deepEqual(seen.signs, []);
  assert.equal(seen.rendered.status, 'cancelled');
});

// A gated provider like the first test's; resolveBuyer records each purchase
// check (writable) it is handed.
async function gatedWorld(t, options = {}) {
  const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
  const g = { reads: 0, checks: [], release: null };
  const gate = new Promise((resolve) => { g.release = resolve; });
  const demDeliveryContext = createDemDeliveryContext({ authority: 'TEST-plan-single-flight', resolveSeller: async () => { throw new Error('TEST unexpected seller resolver'); },
    resolveBuyer: async (_request, { writable }) => { g.reads += 1; g.checks.push(await writable()); await gate; g.checks.push(await writable()); if (options.answer) return options.answer; throw new Error(options.failure ?? WRITER_FAILURE); } });
  const { failure: _failure, answer: _answer, ...harnessOptions } = options;
  const { h, buyer, seller } = await setup(t, { demDeliveryContext, browserAgreement: { journal }, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' }, ...harnessOptions });
  const p = await tool(h, buyer, 'prepare_purchase', { listingId: seller.published.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: key(), protocol: 'dacs-sr2-wallet-agreement' });
  const token = tokenFrom(p.approvalUrl), path = `/portal/api/purchase/${p.operationId}/`;
  const identity = await portal(h, `${path}agreement/identity`, { token, address: buyer.wallet.address });
  const signature = buyer.wallet.signHex(identity.signRequest.message);
  return { ...g, g, h, buyer, p, token, path, signature, plan: (sig = signature) => portal(h, `${path}agreement/plan`, { token, signature: sig }),
    accountId: h.app.services.accounts.walletOwner(buyer.wallet.address) };
}
const within = (promise, ms) => Promise.race([promise.then((value) => ({ value })), sleep(ms).then(() => 'pending')]);

test('a purchase cancelled while its plan step runs is refused at once and never joined; the running step\'s write check sees it', async (t) => {
  const w = await gatedWorld(t);
  const first = w.plan();
  while (w.g.reads === 0) await sleep(5);
  assert.deepEqual(w.g.checks, [true], 'pending when the step started');
  assert.equal((await w.h.app.services.purchases.cancel({ accountId: w.accountId, operationId: w.p.operationId })).cancelled, true);
  for (const signature of [w.signature, w.buyer.wallet.signHex('another message')]) {
    const out = await within(w.plan(signature), 2000);
    assert.notEqual(out, 'pending', 'answered without waiting for the running step');
    assert.equal(out.value.status, 409); assert.equal(out.value.error, 'invalid_state'); assert.match(out.value.message, /purchase is cancelled/);
  }
  w.g.release();
  assert.equal((await first).error, 'invalid_state');
  assert.deepEqual(w.g.checks, [true, 'purchase is cancelled'], 'a Vet write after the cancel would be refused');
  assert.equal(w.g.reads, 1);
});

test('a plan step running past the wait bound answers 202 plan_in_progress; no other step starts and its outcome is in the purchase status', async (t) => {
  const w = await gatedWorld(t, { planWaitMs: 1000 });
  const first = w.plan();
  while (w.g.reads === 0) await sleep(5);
  const second = w.plan();
  for (const out of await Promise.all([first, second])) {
    assert.equal(out.status, 202, JSON.stringify(out)); assert.equal(out.error, 'plan_in_progress');
    assert.match(out.message, /still running.*nothing else was started.*Check the purchase status/);
  }
  // A later request with the same signatures joins the same running step.
  assert.equal((await w.plan()).status, 202);
  assert.equal(w.g.reads, 1, 'one plan step');
  const pending = await portal(w.h, `${w.path}view`, { token: w.token });
  assert.equal(pending.status, 'agreement_pending'); assert.equal(pending.evidence.protocol.stage, 'identity');
  w.g.release();
  let view;
  do { await sleep(20); view = await portal(w.h, `${w.path}view`, { token: w.token }); } while (!view.evidence.protocol.lastAttempt);
  assert.equal(view.evidence.protocol.lastAttempt.reason, `DEM delivery context failed: ${WRITER_FAILURE}`, 'the step finished after its waiters left and saved its note');
  assert.equal((await w.plan()).error, 'agreement_context_held'); assert.equal(w.g.reads, 2, 'only now a new step');
});

test('an attempt note is cut by whole code points, never leaving half a surrogate pair', async (t) => {
  // The 240th UTF-16 unit of the note falls inside the emoji.
  const failure = `${'x'.repeat(240 - 'DEM delivery context failed: '.length - 1)}\u{1F600} and more`;
  const w = await gatedWorld(t, { failure });
  w.g.release();
  assert.equal((await w.plan()).error, 'agreement_context_held');
  const reason = (await portal(w.h, `${w.path}view`, { token: w.token })).evidence.protocol.lastAttempt.reason;
  assert.ok(reason.length <= 240); assert.doesNotMatch(reason, /[\uD800-\uDBFF]$/);
  assert.equal(reason, `DEM delivery context failed: ${'x'.repeat(240 - 'DEM delivery context failed: '.length - 1)}`);
});

test('a cut note keeps a combining mark or an emoji sequence with its character, and never splits a surrogate pair', () => {
  const cut = (tail, max) => cutText(`${'b'.repeat(max - 1)}${tail}`, max);
  assert.equal(cut('e\u0301', 240), 'b'.repeat(239), 'e and its accent go together');
  assert.equal(cutText(`${'b'.repeat(238)}e\u0301tail`, 240), `${'b'.repeat(238)}e\u0301`, 'a whole cluster that fits is kept');
  assert.equal(cut('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', 240), 'b'.repeat(239), 'a ZWJ family is one character');
  assert.equal(cut('\u{1F600}', 240), 'b'.repeat(239));
  assert.equal(cutText('short', 240), 'short'); assert.equal(cutText(12345, 3), '123');
});

test('portal: a 202 plan_in_progress answer reads the status, asks for nothing more and says nothing new was sent', async (t) => {
  const w = await world(t);
  const seen = { calls: [], signs: [], accepted: 1, logs: [] };
  await assert.rejects(portalSignAgreement(w, seen)(w.get().terms), (error) => error.code === 'plan_in_progress' && error.indeterminate === true);
  assert.deepEqual(seen.calls, [`${w.p.operationId}/view`, 'agreement/identity', 'agreement/plan', `${w.p.operationId}/view`]);
  assert.equal(seen.signs.length, 1, 'the identity presentation only');
  assert.ok(seen.logs.some(({ message, kind }) => kind === 'warn' && /may still be running.*Nothing new was sent\./.test(message)));
  assert.equal(w.planned(), 0);
});

test('a job quarantined as legacy is refused with its own code and a true message; the attempt note keeps it', async (t) => {
  const reason = 'legacy_party_vet_state_missing: this purchase was started by an earlier server version; nothing was signed or sent; start a new purchase';
  const w = await gatedWorld(t, { answer: { disposition: 'rejected', reason, code: 'legacy_party_vet_state_missing' } });
  w.g.release();
  const out = await w.plan();
  assert.equal(out.status, 409); assert.equal(out.error, 'legacy_party_vet_state_missing');
  assert.equal(out.message, 'this purchase was started by an earlier server version; nothing was signed or sent; start a new purchase');
  const view = await portal(w.h, `${w.path}view`, { token: w.token });
  assert.deepEqual({ ...view.evidence.protocol.lastAttempt, at: undefined }, { at: undefined, step: 'agreement-context', outcome: 'rejected', reason });
  assert.equal(view.status, 'agreement_pending');
});

test('the purchase view says whether this server runs the plan step now', async (t) => {
  const w = await gatedWorld(t);
  const view = () => portal(w.h, `${w.path}view`, { token: w.token });
  assert.equal((await view()).planRunning, undefined);
  const first = w.plan();
  while (w.g.reads === 0) await sleep(5);
  assert.equal((await view()).planRunning, true);
  w.g.release();
  await first;
  assert.equal((await view()).planRunning, undefined, 'the step ended');
});

test('portal: a definitive plan refusal is shown without the "may still be running" warning', async (t) => {
  for (const code of ['agreement_context_held', 'bad_signature']) {
    const w = await world(t);
    const seen = { calls: [], signs: [], refuse: code, logs: [] };
    await assert.rejects(portalSignAgreement(w, seen)(w.get().terms), (error) => error.code === code);
    assert.ok(!seen.logs.some(({ message }) => /may still be running/.test(message)), `${code}: no warning`);
    assert.equal(w.planned(), 0);
  }
});

test('plan single-flight harness never attempted an external connection', () => assert.deepEqual(externalAttempts, []));
