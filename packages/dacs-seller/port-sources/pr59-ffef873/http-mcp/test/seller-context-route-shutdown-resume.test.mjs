import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';
import { shutdownClock } from './helpers/shutdown-clock.mjs';
import { resolveDemDeliveryBuyerContext } from '../src/dacs/dem-delivery-context-consumer.mjs';

// DACS_SELLER_CONTEXT=route: an operator shutdown that cuts a seller Vet
// approval of a waiting plan leaves the step's CREATE intent askable
// ('closing') and the transport journal's step uncertain. After a restart the
// purchase's exact saved request runs the step again (seller-context-route.mjs
// resume): the cut Vet is asked again, a Vet already written is read back,
// and no CREATE is made twice. Cut 'first': before the first Vet CREATE; cut
// 'second': after the buyer Vet was written.
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function bounded(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
const vetCreates = h => h.node2.chain.wire.record.accepted.filter(tx => tx.content?.data?.[1]?.metadata?.artifactKind === 'CompositeVerificationRecord').length;
const setEnv = (t, key, value) => {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
};
// The transport journal's context step state for the job (the restarted operator holds the file open; this reads it).
const contextStep = (h, jobId) => {
  const db = new DatabaseSync(join(h.config.stateDirectory, 'seller-transport.sqlite'), { readOnly: true });
  try { const row = db.prepare('SELECT e.state, e.status FROM peer_context_admissions a JOIN peer_effects e ON e.effect = a.effect WHERE a.job = ?').get(jobId); return row ? { ...row } : null; }
  finally { db.close(); }
};

// cancelled (sweep, code P1-1): the purchase is cancelled after the cut; its
// resend then stays fenced (no prompt, no CREATE) until the purchase is open again.
for (const [signature, cut, cancelled] of [['off', 'first', false], ['off', 'second', false], ['on', 'first', false], ['on', 'second', false], ['off', 'second', true]]) {
  const title = cancelled ? `switch ${signature}: a route step a shutdown cut at the ${cut} Vet approval stays fenced while its purchase is cancelled after the cut, then runs again`
    : `switch ${signature}: a route step a shutdown cut at the ${cut} Vet approval runs again after a restart, with no second CREATE`;
  test(title, { timeout: 240000 }, async t => {
    setEnv(t, 'DACS_SELLER_CONTEXT', 'route');
    setEnv(t, 'DACS_COMMIT_ON_SIGNATURE', signature);
    const clock = shutdownClock({ graceMs: 30, laneMs: 100, autoLanes: true });
    const held = deferred(), prompted = deferred(), s = { prompts: [], restarted: false, closing: 0 };
    const wrapPublicJournal = journal => ({ ...journal, put: async (key, value) => { if (value?.stage === 'closing') s.closing++; return journal.put(key, value); } });
    const h = await startOperatorPurchaseNode2({ authorizeBuyerApproval: () => true, shutdownTimer: clock, wrapPublicJournal,
      authorizeSellerApproval: ({ request }) => {
        if (request.content?.artifactKind !== 'CompositeVerificationRecord') return true;
        s.prompts.push({ restarted: s.restarted });
        if (s.restarted) return true;
        // Before the stop: the approval to cut waits; an earlier one is approved.
        if (s.prompts.length === (cut === 'first' ? 1 : 2)) { prompted.resolve(); return held.promise; }
        return true;
      } });
    const originalFetch = globalThis.fetch;
    t.after(async () => {
      globalThis.fetch = originalFetch;
      held.resolve(false);
      for (const stop of [() => h.operator.close(), () => h.node2.close()]) await Promise.resolve().then(stop).catch(() => {});
      await rm(h.root, { recursive: true, force: true });
    });
    const responseSeen = deferred(), buyerStopped = new Error('TEST buyer stops after the plan response');
    globalThis.fetch = async (url, options) => {
      const response = await originalFetch(url, options);
      if (new URL(url).pathname.endsWith('/agreement/plan')) { responseSeen.resolve(); throw buyerStopped; }
      return response;
    };
    const purchase = h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: `context-cut-${cut}-${signature}${cancelled ? '-cancelled' : ''}` })
      .then(value => ({ value }), error => ({ error }));
    await prompted.promise; await responseSeen.promise;
    assert.equal((await purchase).error, buyerStopped);
    globalThis.fetch = originalFetch;
    const { id, account_id: accountId } = h.application.db.prepare("SELECT id, account_id FROM operations WHERE kind = 'purchase'").get();
    const jobId = h.application.services.ops.get(accountId, id).terms.protocol.jobId;
    const writtenBefore = cut === 'first' ? 0 : 1;
    assert.equal(vetCreates(h), writtenBefore);

    // The stop cuts the waiting approval at the grace: nothing is signed for it.
    const closing = h.operator.close().then(() => ({}), error => ({ error }));
    await clock.advance(30);
    const closed = await bounded(closing, 10000, 'shutdown must finish after the grace');
    assert.equal(closed.error, undefined, `the stop completes: ${closed.error?.stack ?? ''}`);
    assert.equal(s.closing, 1, 'the cut Vet intent stays askable');
    assert.equal(vetCreates(h), writtenBefore);
    assert.deepEqual(contextStep(h, jobId), { state: 'uncertain', status: 503 }, 'the transport journal fenced the cut step');
    held.resolve(true);

    // After the restart the purchase's exact saved request resumes the step.
    s.restarted = true;
    await h.restart();
    const retry = () => {
      const current = h.application.services.ops.get(accountId, id), state = current.state.protocol;
      return resolveDemDeliveryBuyerContext(h.composition.dacsProtocol.demDeliveryContext, { operation: current, listing: state.listing,
        buyerBundle: state.sellerContextRequest.buyerBundle, generatedAt: state.sellerContextRequest.generatedAt });
    };
    if (cancelled) {
      const { status } = h.application.db.prepare('SELECT status FROM operations WHERE id = ?').get(id);
      h.application.db.prepare("UPDATE operations SET status = 'cancelled' WHERE id = ?").run(id);
      const fenced = await retry();
      assert.equal(fenced.disposition, 'indeterminate', JSON.stringify(fenced));
      assert.equal(s.prompts.filter(prompt => prompt.restarted).length, 0, 'nothing is asked for a cancelled purchase');
      assert.equal(vetCreates(h), writtenBefore, 'nothing is written');
      assert.deepEqual(contextStep(h, jobId), { state: 'uncertain', status: 503 }, 'the step stays fenced');
      h.application.db.prepare('UPDATE operations SET status = ? WHERE id = ?').run(status, id);
    }
    const resumed = await retry();
    assert.equal(resumed.disposition, 'present', JSON.stringify(resumed));
    assert.equal(vetCreates(h), 2, 'each party Vet has exactly one CREATE');
    assert.equal(s.prompts.filter(prompt => prompt.restarted).length, 2 - writtenBefore, 'only the Vets not yet written are asked again');
    assert.deepEqual(contextStep(h, jobId), { state: 'complete', status: 200 });

    // The completed step answers from the journal: nothing runs or is asked again.
    const prompts = s.prompts.length, again = await retry();
    assert.equal(again.disposition, 'present');
    assert.deepEqual(again.input, resumed.input);
    assert.equal(s.prompts.length, prompts);
    assert.equal(vetCreates(h), 2);
  });
}
