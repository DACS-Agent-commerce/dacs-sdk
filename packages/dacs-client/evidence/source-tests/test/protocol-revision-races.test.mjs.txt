// Concurrent checks of one DACS purchase (two verify_deal polls, a poll and a
// counter-signature, two counter-signatures). Protocol state carries a
// revision and every save compares it: a check that read an older revision
// saves nothing, reports its own result marked notSaved, and continues no
// further. Adapted from the a review review witnesses (listing-revision and
// -provider-effect, 2026-10-08).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { bundleAddress, finalityCommitmentAddress, paymentEvidenceAddress } from '@kynesyslabs/dacs';
import { startProtocolHarness, addSeller } from './dacs-loopback-fixture.test.mjs';
import { linkedUser, tool, portal, tokenFrom, approvePurchase } from './helpers/flows.mjs';
import { protocolView } from '../src/dacs/protocol-purchases.mjs';
import { opsHealth } from '../src/ops/health.mjs';

let serial = 0;

async function bounded(promise, diagnostic, phase) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Fetch gate ${phase} timed out after 30s: ${diagnostic()}`)), 30_000);
    })]);
  } finally { clearTimeout(timer); }
}

// One purchase with the Agreement prepared. A fetch gate holds or fails the
// next request that matches a predicate; every request is counted.
async function world(t, { agreement = true } = {}) {
  const original = globalThis.fetch;
  const seen = [];
  let gate = null;
  globalThis.fetch = async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    const method = options?.method ?? 'GET';
    seen.push({ origin: url.origin, path: url.pathname, method, logicalAddress: url.pathname === '/sr2/records' && method === 'POST' ? JSON.parse(options.body).logicalAddress : null });
    if (gate && gate.match(url, options)) {
      const active = gate;
      const { mode, entered, released, receipt } = active;
      gate = null;
      if (mode === 'fail') return new Response('{}', { status: 503 });
      // Acknowledge a write that was never applied, with another record's receipt.
      if (mode === 'fake-success') return new Response(JSON.stringify({ receipt }), { headers: { 'x-dacs-simulation': 'fixture', 'content-type': 'application/json' } });
      entered();
      await bounded(released, () => `not released: ${method} ${url}`, 'release').catch((error) => {
        active.gateTimedOut = true;
        throw error;
      });
      if (mode === 'hold-then-fail') return new Response('{}', { status: 503 });
    }
    return original(input, options);
  };
  const h = await startProtocolHarness();
  let releaseHeld = () => {};
  t.after(async () => { releaseHeld(); globalThis.fetch = original; await h.close(); });
  const seller = await addSeller(h, { listingId: `revision-race-${++serial}` });
  const buyer = await linkedUser(h);
  const purchase = await tool(h, buyer, 'prepare_purchase', { listingId: seller.published.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `revision-race-${serial}`, protocol: 'dacs-pay-dem' });
  assert.equal(purchase.status, 'agreement_pending');
  const id = purchase.operationId;
  const token = tokenFrom(purchase.approvalUrl);
  const accountId = h.app.services.accounts.walletOwner(buyer.wallet.address);
  const get = () => h.app.services.ops.get(accountId, id);
  const identity = agreement ? await portal(h, `/portal/api/purchase/${id}/agreement/identity`, { token, address: buyer.wallet.address }) : null;
  const plan = agreement ? await portal(h, `/portal/api/purchase/${id}/agreement/plan`, { token, signature: buyer.wallet.signHex(identity.signRequest.message) }) : null;
  const job = get().terms.protocol.jobId;
  // hold: pause the next matching request, then let it through (or fail it).
  const hold = (match, then = 'pass') => new Promise((entered) => {
    let release;
    const released = new Promise((r) => { release = r; });
    releaseHeld = release;
    gate = { match, mode: then === 'fail' ? 'hold-then-fail' : 'hold', entered, released, gateTimedOut: false };
  });
  const fail = (match) => { gate = { match, mode: 'fail' }; };
  const fakeSuccess = (match, receipt) => { gate = { match, mode: 'fake-success', receipt }; };
  // Always release and drain the paused action, including when a competing
  // assertion fails. A safe rejection before the gate is an immediate failure.
  const withGate = async (match, start, whileHeld, then = 'pass') => {
    const held = hold(match, then);
    const installed = gate;
    const release = releaseHeld;
    let pending;
    const errors = [];
    const diagnostic = () => JSON.stringify({ stage: get().state.protocol.stage, lastAttempt: get().state.protocol.attempts.at(-1) });
    try {
      pending = start();
      await bounded(Promise.race([held, pending.then(() => {
        throw new Error(`Race operation finished before entering fetch gate: ${diagnostic()}`);
      }, (cause) => {
        throw new Error(`Race operation rejected before entering fetch gate: ${diagnostic()}`, { cause });
      })]), diagnostic, 'entry');
      await bounded(whileHeld(), diagnostic, 'competing work');
    } catch (error) {
      errors.push(error);
    } finally {
      if (gate === installed) gate = null;
      release();
      try {
        if (pending) await bounded(pending.catch(() => {}), diagnostic, 'drain');
      } catch (error) {
        errors.push(error);
      }
      try {
        assert.equal(installed.gateTimedOut, false, 'fetch gate must be released explicitly, not by its timeout');
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Fetch gate failed and cleanup also failed');
    return pending;
  };
  const read = (address) => (url, options) => url.pathname === '/sr2/records' && url.searchParams.get('address') === address && (options?.method ?? 'GET') === 'GET';
  const sellerPost = (path) => (url, options) => url.origin === seller.url && url.pathname === path && options?.method === 'POST';
  const sellerCalls = (path) => seen.filter((x) => x.origin === seller.url && x.path === path && x.method === 'POST').length;
  const buyerCopy = bundleAddress(job, 'buyer');
  const buyerCopyPost = (url, options) => url.origin === h.anchors.url && url.pathname === '/sr2/records' && options?.method === 'POST' && JSON.parse(options.body).logicalAddress === buyerCopy;
  const buyerCopyPosts = () => seen.filter((x) => x.logicalAddress === buyerCopy).length;
  return {
    h, seller, buyer, id, token, accountId, get, job, withGate, fail, fakeSuccess, read, sellerPost, sellerCalls, buyerCopy, buyerCopyPost, buyerCopyPosts,
    history: () => h.app.services.ops.history(id),
    delivery: read(`dacs4:deliverable:${job}`),
    submit: () => h.app.services.purchases.agreementSubmit({ operationId: id, token, agreementSignature: buyer.wallet.signHex(plan.signRequest.agreementMessage), anchorSignature: buyer.wallet.signHex(plan.signRequest.anchorMessage) }),
    verify: (extra = {}) => h.app.services.purchases.verifyDeal({ accountId, operationId: id, ...extra }),
    async pay() {
      const { approved } = await approvePurchase(h, id, purchase.approvalUrl, buyer.wallet);
      assert.equal(approved.status, 'payment_handoff', JSON.stringify(approved));
      return h.chain.walletBroadcast(approved.payload);
    },
    request: () => h.app.services.purchases.completionRequest({ operationId: id, token }).request,
    // A request fetched earlier models a tab that fetched it before another
    // counter-signature was saved.
    countersign(request = h.app.services.purchases.completionRequest({ operationId: id, token }).request) {
      return h.app.services.purchases.completionCountersign({ operationId: id, token, bundleSignature: buyer.wallet.signHex(request.bundleMessage), anchorSignature: buyer.wallet.signHex(request.anchorMessage) });
    },
  };
}

const steps = (protocol) => protocol.attempts.map((x) => `${x.step}/${x.outcome}`);
const notSavedEvents = (w) => w.history().filter((x) => x.type === 'protocol_check_not_saved');

for (const step of ['claim', 'payment-evidence', 'delivery']) {
  test(`a failed ${step} read that loses the race to a successful poll reports its own check and overwrites nothing`, async (t) => {
    const w = await world(t);
    await w.submit();
    const hash = await w.pay();
    const evidence = (() => { const terms = w.get().state.protocol.agreement.terms; return w.read(paymentEvidenceAddress(w.job, terms.rail, terms.paymentPhaseIndex)); })();
    const target = step === 'claim' ? w.sellerPost('/dacs/v1/payments') : step === 'delivery' ? w.delivery : evidence;
    w.fail(target);
    await w.verify({ txHash: hash });
    const before = w.get();
    assert.equal(before.state.protocol.stage, step === 'delivery' ? 'payment-evidenced' : 'awaiting-claim');

    let saved;
    const late = await w.withGate(target, w.verify, async () => {
      const b = await w.verify();
      assert.equal(b.operation.state.protocol.stage, 'awaiting-countersignature');
      assert.equal(b.operation.state.protocol.notSaved, undefined);
      saved = b.operation.state.protocol;
    }, 'fail');

    // A's response: its own stage and failed attempt, marked as not saved.
    const view = protocolView(late.operation);
    assert.equal(view.stage, before.state.protocol.stage);
    assert.equal(view.delivery, null);
    assert.deepEqual([view.lastAttempt.step, view.lastAttempt.outcome], [step, 'unavailable']);
    assert.deepEqual(view.notSaved, { savedRevision: saved.revision, savedStage: 'awaiting-countersignature' });
    assert.match(view.next, /not saved/);

    // Stored: B's progress and B's attempts, untouched by A.
    const stored = w.get().state.protocol;
    assert.deepEqual(stored, saved);
    assert.ok(stored.attempts.length < 10, 'the attempt cap cannot explain a loss');
    assert.ok(steps(stored).includes('delivery/verified') && steps(stored).includes('bundle-request/ready'), steps(stored).join(','));
    // A's check is in the event log only.
    const events = notSavedEvents(w);
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].data.event, events[0].data.outcome, events[0].data.stage, events[0].data.savedStage], [`protocol_${step}`, 'unavailable', before.state.protocol.stage, 'awaiting-countersignature']);
    // A may have saved earlier steps of its own (the claim) before it paused.
    assert.equal(events[0].data.revision, view.revision);
    assert.ok(view.revision >= before.state.protocol.revision && view.revision < saved.revision);
    assert.equal(events[0].data.savedRevision, saved.revision);

    const next = await w.verify();
    assert.equal(next.operation.state.protocol.stage, 'awaiting-countersignature');
    assert.equal(protocolView(next.operation).notSaved, undefined);
  });
}

test('a failed delivery read that loses the race to completion cannot erase the counter-signature', async (t) => {
  const w = await world(t);
  await w.submit();
  const hash = await w.pay();
  w.fail(w.delivery);
  await w.verify({ txHash: hash });
  let complete;
  const late = await w.withGate(w.delivery, w.verify, async () => {
    await w.verify();
    const done = await w.countersign();
    assert.equal(done.operation.state.protocol.stage, 'completed');
    for (const role of ['buyer', 'seller']) assert.ok(w.h.anchors.records.has(bundleAddress(w.job, role)), `${role} copy anchored`);
    complete = w.get();
    assert.ok(complete.state.protocol.bundle.buyerSignature);
  }, 'fail');
  assert.equal(late.operation.state.protocol.stage, 'payment-evidenced');
  assert.deepEqual(protocolView(late.operation).notSaved, { savedRevision: complete.state.protocol.revision, savedStage: 'completed' });
  assert.deepEqual(w.get(), complete);

  const next = await w.verify();
  assert.equal(next.operation.state.protocol.stage, 'completed');
  assert.equal(next.operation.state.protocol.bundle.buyerSignature, complete.state.protocol.bundle.buyerSignature);
  assert.equal(w.sellerCalls('/dacs/v1/bundles/request'), 1);
});

test('a successful delivery read that loses the race to a failed poll is not saved and stops before the bundle request', async (t) => {
  const w = await world(t);
  await w.submit();
  const hash = await w.pay();
  w.fail(w.delivery);
  await w.verify({ txHash: hash });
  let saved;
  const late = await w.withGate(w.delivery, w.verify, async () => {
    w.fail(w.delivery);
    const b = await w.verify();
    assert.equal(b.operation.state.protocol.stage, 'payment-evidenced');
    saved = b.operation.state.protocol;
  });
  // A verified delivery, but B saved first: A's success is reported as its
  // own check, not saved, and A asked the seller for nothing further.
  const view = protocolView(late.operation);
  assert.equal(view.stage, 'delivered');
  assert.equal(view.delivery.status, 'verified');
  assert.deepEqual(view.notSaved, { savedRevision: saved.revision, savedStage: 'payment-evidenced' });
  assert.deepEqual(w.get().state.protocol, saved);
  assert.equal(w.sellerCalls('/dacs/v1/bundles/request'), 0);
  assert.equal(notSavedEvents(w)[0].data.outcome, 'verified');

  // The next poll re-reads and saves the delivery; one bundle request.
  const next = await w.verify();
  assert.equal(next.operation.state.protocol.stage, 'awaiting-countersignature');
  assert.equal(w.sellerCalls('/dacs/v1/bundles/request'), 1);
});

test('two concurrent counter-signatures complete once; the other is not saved and shows no bundle to sign', async (t) => {
  const w = await world(t);
  await w.submit();
  const hash = await w.pay();
  await w.verify({ txHash: hash });
  assert.equal(w.get().state.protocol.stage, 'awaiting-countersignature');

  const results = await Promise.all([w.countersign(), w.countersign()]);
  const views = results.map((r) => protocolView(r.operation));
  const done = views.filter((v) => !v.notSaved);
  const dropped = views.filter((v) => v.notSaved);
  assert.equal(done.length, 1, JSON.stringify(views.map((v) => [v.stage, v.notSaved])));
  assert.equal(dropped.length, 1);
  assert.equal(done[0].stage, 'completed');
  assert.equal(dropped[0].stage, 'awaiting-countersignature');
  assert.equal(dropped[0].bundle.message, undefined, 'an unsaved bundle message is never offered for signing');

  const stored = w.get().state.protocol;
  assert.equal(stored.stage, 'completed');
  assert.ok(stored.bundle.buyerSignature && stored.bundle.buyerCopyRef && stored.bundle.sellerCopyRef);
  assert.equal(w.sellerCalls('/dacs/v1/bundles/countersignature'), 1);
  assert.equal(w.buyerCopyPosts(), 1, 'the losing counter-signature sends no buyer copy write');
  assert.equal(w.history().filter((x) => x.type === 'protocol_seller-copy' && x.data.outcome === 'verified').length, 1);
});

// a review revision comparison: a buyer copy write whose success was not
// saved must be read back, never sent again.
test('a buyer copy write held while a second counter-signature fails is sent once', async (t) => {
  const w = await world(t);
  await w.submit();
  await w.verify({ txHash: await w.pay() });
  const request = w.request();
  await w.withGate(w.buyerCopyPost, () => w.countersign(), async () => {
    w.fail(w.buyerCopyPost);
    await w.countersign(request);
  });
  assert.ok(w.h.anchors.records.has(w.buyerCopy));
  const before = w.buyerCopyPosts();
  await w.verify();
  assert.equal(w.buyerCopyPosts(), before, 'recovery reads back the applied buyer copy instead of sending it again');
  assert.equal(before, 1);
});

test('a buyer copy write is sent once: checks during it and after its unsaved success only read the copy back', async (t) => {
  const w = await world(t);
  await w.submit();
  await w.verify({ txHash: await w.pay() });
  const request = w.request();
  const late = await w.withGate(w.buyerCopyPost, () => w.countersign(), async () => {
    // The counter-signature is saved before the write: a second one (from a tab
    // that fetched its request earlier) and a poll read back and send nothing.
    for (const check of [() => w.countersign(request), w.verify]) {
      const { operation } = await check();
      const p = operation.state.protocol;
      assert.equal(p.stage, 'awaiting-countersignature');
      assert.deepEqual(p.attempts.at(-1), { ...p.attempts.at(-1), step: 'buyer-copy', outcome: 'absent' });
      const view = protocolView(operation);
      assert.equal(view.notSaved, undefined);
      assert.equal(view.bundle.counterSigned, true);
      assert.equal(view.bundle.message, undefined, 'a saved counter-signature is never offered for signing again');
      assert.match(view.next, /never sent again/);
    }
  });
  // A's write applied, but the poll saved first: A's success is not saved.
  assert.equal(protocolView(late.operation).notSaved.savedStage, 'awaiting-countersignature');
  assert.ok(w.h.anchors.records.has(w.buyerCopy));
  assert.equal(w.get().state.protocol.bundle.buyerCopyRef, undefined);
  assert.equal(w.sellerCalls('/dacs/v1/bundles/countersignature'), 0);

  const next = await w.verify();
  assert.equal(next.operation.state.protocol.stage, 'completed');
  assert.deepEqual(next.operation.state.protocol.bundle.buyerCopyRef.anchor.locator, w.buyerCopy);
  assert.equal(w.buyerCopyPosts(), 1);
  assert.equal(w.sellerCalls('/dacs/v1/bundles/countersignature'), 1);
});

// a review revision comparison: a write acknowledgement is not proof,
// and a saved counter-signature is never offered for signing again.
test('a buyer copy write acknowledged but never applied does not complete the purchase', async (t) => {
  const w = await world(t);
  await w.submit();
  await w.verify({ txHash: await w.pay() });
  const otherReceipt = [...w.h.anchors.records.values()][0].receipt;
  w.fakeSuccess(w.buyerCopyPost, otherReceipt);
  const { operation } = await w.countersign();
  const view = protocolView(operation);
  assert.equal(w.h.anchors.records.has(w.buyerCopy), false);
  assert.equal(view.stage, 'awaiting-countersignature');
  assert.deepEqual([view.lastAttempt.step, view.lastAttempt.outcome], ['buyer-copy', 'absent']);
  assert.equal(view.layers.completedCopies, 'not-exchanged');
  assert.equal(view.bundle.buyerCopy, null);
  assert.equal(w.sellerCalls('/dacs/v1/bundles/countersignature'), 0);
  assert.equal(w.buyerCopyPosts(), 1);
});

test('a saved counter-signature is never offered for signing again', async (t) => {
  const w = await world(t);
  await w.submit();
  await w.verify({ txHash: await w.pay() });
  const done = await w.withGate(w.buyerCopyPost, () => w.countersign(), async () => {
    const request = await portal(w.h, `/portal/api/purchase/${w.id}/completion/request`, { token: w.token });
    assert.equal(request.status, 409);
    assert.equal(request.error, 'already_countersigned');
    assert.equal(request.signRequest, undefined);
  });
  assert.equal(done.operation.state.protocol.stage, 'completed');
  assert.throws(() => w.h.app.services.purchases.completionRequest({ operationId: w.id, token: w.token }), { code: 'already_countersigned' });
});

// a review revision comparison: a buyer copy reference saved by older
// code from the write acknowledgement alone is not proof, and a tab left open
// after completion is refused like any other.
// Rewrites the stored bundle the way older code saved it.
function saveAsOlderCode(w, edit) {
  const op = w.get();
  w.h.app.services.ops.transition(w.id, op.status, op.status, { state: { protocol: { ...op.state.protocol, bundle: edit(op.state.protocol.bundle) } }, event: 'test_older_code_row' });
}

test('a buyer copy reference saved without a readback is read back before the seller is asked to counter-sign', async (t) => {
  const w = await world(t);
  await w.submit();
  await w.verify({ txHash: await w.pay() });
  const request = w.request();
  // Older code saved the counter-signature and a reference from an
  // acknowledgement whose write was never applied.
  const otherReceipt = [...w.h.anchors.records.values()][0].receipt;
  saveAsOlderCode(w, (b) => ({ ...b, buyerSignature: w.buyer.wallet.signHex(request.bundleMessage), buyerCopyRef: otherReceipt }));
  assert.equal(protocolView(w.get()).bundle.buyerCopy, null);
  const { operation } = await w.verify();
  const view = protocolView(operation);
  assert.equal(view.stage, 'awaiting-countersignature');
  assert.deepEqual([view.lastAttempt.step, view.lastAttempt.outcome], ['buyer-copy', 'absent']);
  assert.equal(view.layers.completedCopies, 'not-exchanged');
  assert.equal(view.bundle.buyerCopy, null);
  assert.equal(w.sellerCalls('/dacs/v1/bundles/countersignature'), 0);
  assert.equal(w.buyerCopyPosts(), 0);
});

for (const copy of ['present', 'absent']) {
  test(`a completed purchase saved without a buyer copy readback is not shown completed until a re-check reads the copy (${copy})`, async (t) => {
    const w = await world(t);
    await w.submit();
    await w.verify({ txHash: await w.pay() });
    await w.countersign();
    assert.equal(w.get().state.protocol.bundle.buyerCopyReadBack, true);
    // Older code completed it on the acknowledgement: no readback mark, and
    // for "absent" a write that was never applied.
    saveAsOlderCode(w, ({ buyerCopyReadBack, ...b }) => b);
    if (copy === 'absent') w.h.anchors.records.delete(w.buyerCopy);
    assert.equal(w.get().state.protocol.stage, 'completed');
    const shown = protocolView(w.get());
    assert.equal(shown.stage, 'awaiting-countersignature');
    assert.equal(shown.layers.completedCopies, 'not-exchanged');
    assert.equal(shown.bundle.buyerCopy, null);
    assert.equal(shown.bundle.message, undefined);
    assert.match(shown.next, /never sent again/);

    const { operation } = await w.verify();
    const view = protocolView(operation);
    if (copy === 'present') {
      assert.equal(operation.state.protocol.stage, 'completed');
      assert.equal(view.layers.completedCopies, 'both-copies-verified');
      assert.ok(view.bundle.buyerCopy);
      assert.deepEqual([view.lastAttempt.step, view.lastAttempt.outcome], ['buyer-copy', 'anchored']);
    } else {
      assert.equal(operation.state.protocol.stage, 'awaiting-countersignature');
      assert.equal(view.layers.completedCopies, 'not-exchanged');
      assert.deepEqual([view.lastAttempt.step, view.lastAttempt.outcome], ['buyer-copy', 'absent']);
      assert.equal(protocolView((await w.verify()).operation).stage, 'awaiting-countersignature');
    }
    // Read only: no second buyer copy write, no second seller countersignature.
    assert.equal(w.buyerCopyPosts(), 1);
    assert.equal(w.sellerCalls('/dacs/v1/bundles/countersignature'), 1);
    assert.throws(() => w.request(), { code: 'already_countersigned' });
  });
}

// The portal's own counter-sign handler (public/portal/portal.js) against the
// real API, with a wallet that fails the test if it is asked to sign.
function portalCountersign(w, seen) {
  const source = readFileSync(new URL('../public/portal/portal.js', import.meta.url), 'utf8');
  const start = source.indexOf('  async function countersign(t) {');
  assert.ok(start > 0);
  const context = {
    id: w.id, token: w.token, needWallet() {}, needBoundWallet() {}, log() {},
    walletSign() { seen.signs += 1; throw new Error('the wallet must not be asked to sign again'); },
    render(view) { seen.rendered = view; },
    async api(path, body) {
      seen.calls.push(path.split('/').slice(-2).join('/'));
      const data = await portal(w.h, path, body);
      if (data.status >= 400) throw Object.assign(new Error(data.message), { code: data.error });
      return data;
    },
  };
  vm.createContext(context);
  return vm.runInContext(`${source.slice(start, source.indexOf('\n  }\n', start) + 4)}\ncountersign;`, context);
}

for (const completed of [false, true]) {
  test(`a portal tab left open ${completed ? 'after completion' : 'during the buyer copy write'} re-checks and never asks the wallet to sign`, async (t) => {
    const w = await world(t);
    await w.submit();
    await w.verify({ txHash: await w.pay() });
    const seen = { signs: 0, calls: [] };
    const recheck = () => portalCountersign(w, seen)(w.get().terms);
    if (completed) {
      await w.countersign();
      await recheck();
    } else {
      await w.withGate(w.buyerCopyPost, () => w.countersign(), recheck);
    }
    assert.equal(seen.signs, 0);
    assert.deepEqual(seen.calls, ['completion/request', 'protocol/recheck']);
    assert.ok(seen.rendered?.evidence?.protocol);
    assert.equal(w.buyerCopyPosts(), 1);
  });
}

test('a failed buyer copy write is never sent again; re-checks only read it back', async (t) => {
  const w = await world(t);
  await w.submit();
  await w.verify({ txHash: await w.pay() });
  const request = w.request();
  w.fail(w.buyerCopyPost);
  const first = await w.countersign(request);
  assert.equal(first.operation.state.protocol.attempts.at(-1).outcome, 'unavailable');
  assert.ok(w.get().state.protocol.bundle.buyerSignature, 'the counter-signature was saved before the write');
  for (const check of [w.verify, () => w.countersign(request), w.verify]) {
    const p = (await check()).operation.state.protocol;
    assert.equal(p.stage, 'awaiting-countersignature');
    assert.equal(p.attempts.at(-1).outcome, 'absent');
  }
  assert.equal(w.buyerCopyPosts(), 1);
  assert.equal(w.h.anchors.records.has(w.buyerCopy), false);
  assert.equal(w.sellerCalls('/dacs/v1/bundles/countersignature'), 0);
});

for (const toStatus of ['cancelled', 'terms_changed']) {
  test(`a late failed commitment read cannot overwrite ${toStatus}`, async (t) => {
    const w = await world(t);
    await w.withGate(w.read(finalityCommitmentAddress(w.job)), () => assert.rejects(w.submit(), { code: 'invalid_state' }), async () => {
      const before = w.get();
      if (toStatus === 'cancelled') assert.equal((await w.h.app.services.purchases.cancel({ accountId: w.accountId, operationId: w.id })).cancelled, true);
      else w.h.app.services.ops.transition(w.id, before.status, toStatus, { event: 'review_status_move' });
    }, 'fail');
    assert.equal(w.get().status, toStatus);
    assert.equal(w.get().state.protocol.commitment, undefined);
  });
}

test('a failed commitment read racing a successful one keeps the saved commitment', async (t) => {
  const w = await world(t);
  let commitment;
  await w.withGate(w.read(finalityCommitmentAddress(w.job)), () => assert.rejects(w.submit(), { code: 'invalid_state' }), async () => {
    const b = await w.verify();
    assert.equal(b.operation.status, 'awaiting_approval');
    commitment = b.operation.state.protocol.commitment;
  }, 'fail');
  assert.deepEqual(w.get().state.protocol.commitment, commitment);
  assert.equal(w.history().filter((x) => x.type === 'protocol_commitment' && x.data.outcome === 'verified').length, 1);
});

test('two simultaneous Agreement submissions save the commitment once and exchange it with the seller once', async (t) => {
  const w = await world(t);
  const results = await Promise.allSettled([w.submit(), w.submit()]);
  const saved = results.filter((x) => x.status === 'fulfilled' && !x.value.operation.state.protocol.notSaved);
  const other = results.filter((x) => !saved.includes(x));
  assert.equal(saved.length, 1, JSON.stringify(results.map((x) => x.status === 'fulfilled' ? x.value.operation.state.protocol.notSaved ?? 'saved' : x.reason.code)));
  assert.ok(other[0].status === 'rejected' ? other[0].reason.code === 'invalid_state' : Boolean(other[0].value.operation.state.protocol.notSaved));
  assert.equal(w.get().status, 'awaiting_approval');
  assert.equal(w.history().filter((x) => x.type === 'protocol_commitment' && x.data.outcome === 'verified').length, 1);
  assert.equal(w.sellerCalls('/dacs/v1/agreements/proposals'), 1);
  assert.equal(w.sellerCalls('/dacs/v1/commitments'), 1);
});

test('two concurrent identity requests both get the saved identity, never an unsaved one', async (t) => {
  const w = await world(t, { agreement: false });
  const ask = () => w.h.app.services.purchases.agreementIdentity({ operationId: w.id, token: w.token, address: w.buyer.wallet.address });
  // Admission re-reads the purchase just before the save, so the two requests
  // rarely interleave. A request holding the purchase as read before either
  // save models the window that remains.
  const stale = w.get();
  const [a, b] = await Promise.all([ask(), ask()]);
  const lost = notSavedEvents(w).length;
  const late = w.h.app.services.protocol.identityRequest(stale, w.buyer.wallet.address);
  const saved = w.get().state.protocol.identity.message;
  for (const answer of [a, b, late]) {
    assert.equal(answer.message, saved);
    assert.equal(answer.operation.state.protocol.notSaved, undefined);
  }
  // The late request's save lost and it was answered from the stored identity.
  assert.equal(notSavedEvents(w).length, lost + 1);
  assert.equal(w.history().filter((x) => x.type === 'protocol_identity_requested').length, 1);
});

test('a plan request that read the purchase before another plan was saved gets the saved plan', async (t) => {
  const w = await world(t, { agreement: false });
  const identity = await w.h.app.services.purchases.agreementIdentity({ operationId: w.id, token: w.token, address: w.buyer.wallet.address });
  const signature = w.buyer.wallet.signHex(identity.message);
  const stale = w.get();
  const first = await w.h.app.services.purchases.agreementPlan({ operationId: w.id, token: w.token, signature });
  const late = await w.h.app.services.protocol.planRequest(stale, signature);
  assert.deepEqual(late.request, first.request);
  assert.equal(late.operation.state.protocol.notSaved, undefined);
  assert.equal(notSavedEvents(w).length, 1);
  assert.equal(w.history().filter((x) => x.type === 'protocol_agreement_planned').length, 1);
});

test('the revision starts at 0 for a purchase saved without one and rises by one per save', async (t) => {
  const w = await world(t);
  // A row written before revisions existed: no revision field at all.
  const legacy = w.get();
  const { revision, ...withoutRevision } = legacy.state.protocol;
  assert.equal(typeof revision, 'number');
  w.h.app.services.ops.transition(w.id, legacy.status, legacy.status, { state: { protocol: withoutRevision }, event: 'test_legacy_row' });
  assert.equal(w.get().state.protocol.revision, undefined);
  assert.equal(protocolView(w.get()).revision, 0);

  await w.submit();
  const hash = await w.pay();
  await w.verify({ txHash: hash });
  await w.countersign();
  const stored = w.get().state.protocol;
  assert.equal(stored.stage, 'completed');
  const saves = w.history().slice(w.history().findIndex((x) => x.type === 'test_legacy_row') + 1).filter((x) => x.type.startsWith('protocol_'));
  assert.equal(stored.revision, saves.length);
  assert.equal(notSavedEvents(w).length, 0);
});

// Ops health (PR the source change, an earlier review). A check is not saved only because another
// check saved first, so its possibly-issued write is logged after that check's
// saved readback, which is never recorded again. The saved readback of the
// same canonical address settles it; it must not alert forever.
const healthOf = (w) => opsHealth({ databasePath: w.h.config.databasePath, now: Date.now() }).stuck.filter((s) => s.purchaseId === w.id).map((s) => [s.stage, s.outcome, s.unresolvedWrites]);
const order = (w) => w.history().filter((x) => x.type.startsWith('protocol_') && (x.data.outcome !== undefined))
  .map((x) => x.type === 'protocol_check_not_saved' ? `not-saved ${x.data.event}/${x.data.outcome}` : `${x.type}/${x.data.outcome}${Object.hasOwn(x.data, 'stage') ? '' : ' (no stage)'}`);

test('ops health: a failed claim read logged after the winning poll read the payment evidence back raises no alert', async (t) => {
  const w = await world(t);
  await w.submit();
  const hash = await w.pay();
  const claim = w.sellerPost('/dacs/v1/payments');
  w.fail(claim);
  await w.verify({ txHash: hash });
  await w.withGate(claim, w.verify, async () => {
    assert.equal((await w.verify()).operation.state.protocol.stage, 'awaiting-countersignature');
  }, 'fail');
  const log = order(w);
  assert.ok(log.indexOf('not-saved protocol_claim/unavailable') > log.indexOf('protocol_payment-evidence/verified'), log.join(', '));
  assert.deepEqual(healthOf(w), []);
});

test('ops health: a lost commit answer logged after the winning check verified the commitment raises no alert, through completion', async (t) => {
  const w = await world(t);
  await w.withGate(w.read(finalityCommitmentAddress(w.job)), () => assert.rejects(w.submit(), { code: 'invalid_state' }), async () => {
    assert.equal((await w.verify()).operation.status, 'awaiting_approval');
  }, 'fail');
  const log = order(w);
  assert.ok(log.indexOf('protocol_commit-request/unavailable (no stage)') > log.indexOf('protocol_commitment/verified'), log.join(', '));
  assert.deepEqual(healthOf(w), []);
  await w.verify({ txHash: await w.pay() });
  await w.countersign();
  assert.deepEqual([w.get().status, w.get().state.protocol.stage], ['settled_verified', 'completed']);
  assert.deepEqual(healthOf(w), []);
});

for (const phase of ['entry', 'competing work', 'release', 'drain']) {
  test(`fetch gate timeout names the ${phase} phase and keeps its diagnostic`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const timeout = bounded(new Promise(() => {}), () => 'stage=committed', phase);
    const rejected = assert.rejects(timeout, { message: `Fetch gate ${phase} timed out after 30s: stage=committed` });
    t.mock.timers.tick(30_000);
    await rejected;
  });
}

test('fetch gate preserves a competing assertion when draining also times out', async (t) => {
  const w = await world(t, { agreement: false });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = new assert.AssertionError({ message: 'competing assertion failed' });
  const pending = w.withGate(() => true,
    () => fetch(w.h.chain.url).then(() => new Promise(() => {})),
    () => { throw original; });
  const rejected = assert.rejects(pending, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], original);
    assert.match(error.errors[1].message, /Fetch gate drain timed out after 30s:/);
    return true;
  });
  // Let entry settle and cleanup install the drain timer before advancing it.
  await new Promise(setImmediate);
  t.mock.timers.tick(30_000);
  await rejected;
  t.mock.timers.reset();
});

test('fetch gate rejects a timeout release even if the paused operation swallows it', async (t) => {
  const w = await world(t, { agreement: false });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await assert.rejects(w.withGate(() => true,
    () => fetch(w.h.chain.url).catch(() => 'swallowed fetch failure'),
    async () => {
      t.mock.timers.tick(30_000);
      await new Promise(setImmediate);
    }), /fetch gate must be released explicitly, not by its timeout/);
  t.mock.timers.reset();
});
