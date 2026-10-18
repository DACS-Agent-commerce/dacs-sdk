// Fix 5: a seller write whose purchase is cancelled or expires while the call
// is in flight. The attempt can no longer be saved on the purchase (its status
// changed), but it is still written to the event log, so ops health reads the
// unresolved write from the live database. The purchase itself is unchanged:
// same error, same status, same stored attempts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startProtocolHarness, addSeller } from './dacs-loopback-fixture.test.mjs';
import { linkedUser, tool, portal, tokenFrom } from './helpers/flows.mjs';
import { opsHealth } from '../src/ops/health.mjs';
import { createDemDeliveryContext } from '../src/dacs/dem-delivery-context-consumer.mjs';
import { createSellerContextClient } from '../src/dacs/seller-context-route.mjs';
import { SellerTlsUnusableError, createSellerAgentClient } from '../src/dacs/seller-http.mjs';
import { memoryAnchorJournal } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';

let h;
before(async () => { h = await startProtocolHarness(); });
after(async () => h.close());

// The seller's commit endpoint answers 503 (the commit outcome is unknown to
// the buyer); `during` runs first, while the buyer is waiting on that answer.
async function lostCommitAnswer(label, during) {
  const buyer = await linkedUser(h), seller = await addSeller(h, { listingId: `fix5-${label}` });
  const accountId = h.app.services.accounts.walletOwner(buyer.wallet.address);
  const p = await tool(h, buyer, 'prepare_purchase', { listingId: seller.published.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `fix5-${label}-${Date.now()}`, protocol: 'dacs-pay-dem' });
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  const token = tokenFrom(p.approvalUrl), path = `/portal/api/purchase/${p.operationId}/agreement/`;
  const identity = await portal(h, `${path}identity`, { token, address: buyer.wallet.address });
  const plan = await portal(h, `${path}plan`, { token, signature: buyer.wallet.signHex(identity.signRequest.message) });
  assert.equal(plan.error, undefined, JSON.stringify(plan));
  let commits = 0;
  seller.state.failPaths = { has: (route) => {
    if (route !== '/dacs/v1/commitments') return false;
    commits += 1;
    during({ accountId, operationId: p.operationId });
    return true;
  } };
  const signed = await portal(h, `${path}sign`, { token, agreementSignature: buyer.wallet.signHex(plan.signRequest.agreementMessage), anchorSignature: buyer.wallet.signHex(plan.signRequest.anchorMessage) });
  assert.equal(commits, 1, 'one commit request was sent');
  return { id: p.operationId, signed, op: () => h.app.services.ops.get(accountId, p.operationId), history: () => h.app.services.ops.history(p.operationId) };
}

const stuckFor = (report, id) => report.stuck.filter((s) => s.purchaseId === id).map((s) => [s.stage, s.outcome, s.unresolvedWrites]);

test('fix5: a commit answer lost while the purchase is cancelled is recorded and reported as an unresolved write', async () => {
  const w = await lostCommitAnswer('cancelled', (ids) => { h.app.services.purchases.cancel(ids); });
  // The purchase behaves as before: the save after the commit call is refused.
  assert.equal(w.signed.error, 'invalid_state', JSON.stringify(w.signed));
  const o = w.op();
  assert.deepEqual([o.status, o.state.protocol.stage], ['cancelled', 'agreement-anchored']);
  assert.equal(o.state.protocol.attempts.some((a) => a.step === 'commit-request'), false, 'the stored attempts are unchanged');
  const events = w.history().filter((e) => e.type === 'protocol_commit-request');
  assert.equal(events.length, 1, 'the attempt is in the event log');
  assert.equal(events[0].data.outcome, 'unavailable');
  assert.equal(Object.hasOwn(events[0].data, 'stage'), false, 'the attempt moves no stage');
  const report = opsHealth({ databasePath: h.config.databasePath, now: Date.now() });
  assert.equal(report.healthy, false);
  assert.deepEqual(stuckFor(report, w.id), [['cancelled', 'unknown-readback-required', ['commit-request']]]);
});

test('fix5: a commit answer lost while the purchase expires is recorded and reported as an unresolved write', async () => {
  // Persisted exactly as purchases.mjs expireIfNeeded does from any portal call.
  const w = await lostCommitAnswer('expired', ({ operationId }) => { h.app.services.ops.transition(operationId, 'agreement_pending', 'expired', { data: { reason: 'approval window elapsed' } }); });
  assert.equal(w.signed.error, 'invalid_state', JSON.stringify(w.signed));
  assert.equal(w.op().status, 'expired');
  assert.equal(w.history().filter((e) => e.type === 'protocol_commit-request').length, 1);
  const report = opsHealth({ databasePath: h.config.databasePath, now: Date.now() });
  assert.equal(report.healthy, false);
  assert.deepEqual(stuckFor(report, w.id), [['expired', 'unknown-readback-required', ['commit-request']]]);
});

// Integration on main 25977d1 (#26): another check saves newer progress while
// the commit request is in flight. The buyer's check saves nothing; save() logs
// it as protocol_check_not_saved, with the attempt's outcome under its original
// event name. Ops health still reads the possibly-issued commit as unresolved.
test('integration: a commit answer lost by a check that another check overtook is reported as an unresolved write', async () => {
  const w = await lostCommitAnswer('not-saved', ({ accountId, operationId }) => {
    const stored = h.app.services.ops.get(accountId, operationId), protocol = stored.state.protocol;
    h.app.services.ops.transition(operationId, stored.status, stored.status, { state: { protocol: { ...protocol, revision: (protocol.revision ?? 0) + 1 } }, event: 'protocol_step', data: { stage: protocol.stage } });
  });
  // The purchase behaves as on main: the stale check ends with its own unsaved view.
  assert.equal(w.signed.error, undefined, JSON.stringify(w.signed));
  const o = w.op();
  assert.deepEqual([o.status, o.state.protocol.stage], ['agreement_pending', 'agreement-anchored']);
  assert.equal(o.state.protocol.attempts.some((a) => a.step === 'commit-request'), false, 'nothing of the check was saved');
  const history = w.history();
  assert.equal(history.filter((e) => e.type === 'protocol_commit-request').length, 0);
  const notSaved = history.filter((e) => e.type === 'protocol_check_not_saved');
  assert.deepEqual(notSaved.map((e) => [e.data.event, e.data.outcome]), [['protocol_commit-request', 'unavailable']]);
  const report = opsHealth({ databasePath: h.config.databasePath, now: Date.now() });
  assert.equal(report.healthy, false);
  assert.deepEqual(stuckFor(report, w.id), [['agreement-anchored', 'unknown-readback-required', ['commit-request']]]);
});

// Keep the existing event/attempt order, with the bounded cause beside the
// outcome, for both saved and lost seller failures.
test('saved and lost seller failures retain event order and a bounded cause', async () => {
  const w = await lostCommitAnswer('key-order', () => {});
  const event = w.history().find((e) => e.type === 'protocol_commit-request');
  assert.deepEqual(Object.keys(event.data), ['stage', 'outcome', 'causeCode', 'reason']);
  assert.equal(event.data.causeCode,'status-5xx');
  assert.equal(event.data.reason,'seller agent response is unavailable or unauthenticated; the operation outcome may be unknown');
  const attempt = w.op().state.protocol.attempts.find((a) => a.step === 'commit-request');
  assert.deepEqual(Object.keys(attempt), ['at', 'step', 'outcome', 'causeCode', 'reason']);
  assert.equal(attempt.causeCode,'status-5xx');
  const lost = await lostCommitAnswer('key-order-lost', (ids) => { h.app.services.purchases.cancel(ids); });
  assert.deepEqual(lost.history().filter((e) => e.type === 'protocol_commit-request').map((e) => Object.keys(e.data)), [['outcome', 'causeCode', 'reason']]);
  assert.equal(lost.history().find(e=>e.type==='protocol_commit-request').data.causeCode,'status-5xx');
});

// Fix 6: the same race on the Agreement-context provider read. The provider may
// publish seller Vet records before it answers; the purchase is cancelled or
// expires while it runs, so planRequest refuses. Its answer is still written to
// the event log; the purchase is unchanged (same error, status, no stored attempt).
test('fix6: an Agreement-context answer that may follow a Vet write is recorded when the purchase is cancelled or expires during the read', async (t) => {
  let skew = 0, resolveBuyer = null;
  const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
  const demDeliveryContext = createDemDeliveryContext({ authority: 'TEST-fix6-party-vet', resolveBuyer: (input) => resolveBuyer(input),
    resolveSeller: async () => { throw new Error('TEST unexpected seller resolver'); } });
  const d = await startProtocolHarness({ now: () => Date.now() + skew, demDeliveryContext, browserAgreement: { journal }, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  t.after(() => d.close());
  const seller = await addSeller(d, { listingId: 'fix6-context-race' });
  const cases = [
    ['cancelled', 'cancelled', 'cancelled', /changed while its Agreement context was read/, (w) => { d.app.services.purchases.cancel(w); }],
    // Persisted exactly as purchases.mjs expireIfNeeded does from any portal call.
    ['expired', 'expired', 'expired', /changed while its Agreement context was read/, (w) => { d.app.services.ops.transition(w.operationId, 'agreement_pending', 'expired', { data: { reason: 'approval window elapsed' } }); }],
    // Not yet persisted: the approval window elapses during the read.
    ['elapsed', 'agreement_pending', 'expired', /approval window elapsed while its Agreement context was read/, () => { skew += 3 * 3600000; }],
  ];
  for (const [label, status, stage, message, during] of cases) {
    const buyer = await linkedUser(d), accountId = d.app.services.accounts.walletOwner(buyer.wallet.address);
    const p = await tool(d, buyer, 'prepare_purchase', { listingId: seller.published.listingId, version: 1, seller: seller.wallet.claim, protocol: 'dacs-sr2-wallet-agreement', idempotencyKey: `fix6-${label}` });
    assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
    const token = tokenFrom(p.approvalUrl), path = `/portal/api/purchase/${p.operationId}/agreement/`;
    const identity = await portal(d, `${path}identity`, { token, address: buyer.wallet.address });
    let published = 0;
    resolveBuyer = async () => { published += 1; during({ accountId, operationId: p.operationId }); return { disposition: 'indeterminate', reason: 'TEST Vet publish answer lost' }; };
    const out = await portal(d, `${path}plan`, { token, signature: buyer.wallet.signHex(identity.signRequest.message) });
    assert.equal(published, 1, label);
    // The purchase behaves as before.
    assert.deepEqual([out.status, out.error], [409, 'invalid_state'], `${label}: ${JSON.stringify(out)}`);
    assert.match(out.message, message, label);
    const o = d.app.services.ops.get(accountId, p.operationId);
    assert.deepEqual([o.status, o.state.protocol.stage, o.state.protocol.planned, o.state.protocol.attempts], [status, 'identity', undefined, []], label);
    const events = d.app.services.ops.history(p.operationId).filter((e) => e.type.startsWith('protocol_agreement'));
    assert.deepEqual(events.map((e) => [e.type, e.data]), [['protocol_agreement-context', { outcome: 'indeterminate', reason: 'TEST Vet publish answer lost' }]], label);
    const report = opsHealth({ databasePath: d.config.databasePath, now: Date.now() + skew });
    assert.equal(report.healthy, false, label);
    assert.deepEqual(stuckFor(report, p.operationId), [[stage, 'seller-journal-not-read', []]], label);
    skew = 0;
  }
});

// an earlier review round (a review): DACS_SELLER_CONTEXT=route. The route client's
// own failed request carries main's attempt facts (seller-http.mjs
// sellerFailureAttempt) to the purchase: the local TLS guard's refusal before
// signing is `causeCode: 'tls'` and `dispatched: false`, saved or logged when
// the purchase ends during the read, and never `written`. Only main's genuine
// guard error is trusted as not sent. The route's signed fresh refusal keeps its
// `written: false` in the lost event too (an earlier review round's a review).
test('merge 4: a route context request refused before signing is recorded as not sent, also when the purchase ends during the read', async (t) => {
  let during = () => {}, failure = null, resolver = null;
  const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
  // The plugin's route client over main's seller client; its authentication
  // stands for the operator's guarded one (operator.mjs guardedSellerAuth).
  const routeClient = createSellerContextClient({ clientFor: () => createSellerAgentClient({ url: 'https://127.0.0.1:9', authentication: {
    request: () => { during(); throw failure(); }, verifyResponse: () => { throw new Error('TEST nothing is answered'); } } }) });
  const demDeliveryContext = createDemDeliveryContext({ authority: 'TEST-merge4-route-tls', buyerOperation: true, resolveBuyer: (input, options) => (resolver ?? routeClient.resolveBuyer)(input, options),
    resolveSeller: async () => { throw new Error('TEST unexpected seller resolver'); } });
  const d = await startProtocolHarness({ demDeliveryContext, browserAgreement: { journal }, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  t.after(() => d.close());
  const seller = await addSeller(d, { listingId: 'merge4-route-tls' });
  const plan = async (label, { cancel = false } = {}) => {
    const buyer = await linkedUser(d), accountId = d.app.services.accounts.walletOwner(buyer.wallet.address);
    const p = await tool(d, buyer, 'prepare_purchase', { listingId: seller.published.listingId, version: 1, seller: seller.wallet.claim, protocol: 'dacs-sr2-wallet-agreement', idempotencyKey: `merge4-${label}` });
    assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
    const token = tokenFrom(p.approvalUrl), path = `/portal/api/purchase/${p.operationId}/agreement/`;
    const identity = await portal(d, `${path}identity`, { token, address: buyer.wallet.address });
    during = cancel ? () => { d.app.services.purchases.cancel({ accountId, operationId: p.operationId }); } : () => {};
    const out = await portal(d, `${path}plan`, { token, signature: buyer.wallet.signHex(identity.signRequest.message) });
    const o = d.app.services.ops.get(accountId, p.operationId), report = opsHealth({ databasePath: d.config.databasePath, now: Date.now() });
    return { out, o, events: d.app.services.ops.history(p.operationId).filter((e) => e.type === 'protocol_agreement-context').map((e) => e.data),
      purchase: report.purchases.find((row) => row.purchaseId === p.operationId), stuck: stuckFor(report, p.operationId) };
  };
  const expired = 'seller TLS certificate expired (starts 2026-01-01T00:00:00.000Z; ends 2026-01-02T00:00:00.000Z)';
  const tls = { outcome: 'indeterminate', dispatched: false, causeCode: 'tls', reason: `DEM delivery context failed: ${expired}` };
  failure = () => new SellerTlsUnusableError(expired);

  const saved = await plan('saved');
  assert.equal(saved.out.error, 'agreement_context_held', JSON.stringify(saved.out));
  assert.deepEqual(saved.o.state.protocol.attempts.filter((a) => a.step === 'agreement-context').map(({ at, step, ...rest }) => rest), [tls]);
  assert.deepEqual(saved.events.map(({ stage, ...rest }) => rest), [tls]);
  assert.ok(Number.isSafeInteger(saved.o.state.protocol.sellerContextRequest?.generatedAt), 'the saved request is kept');
  assert.deepEqual([saved.purchase.outcome, saved.purchase.causeCode, saved.purchase.lastAttemptDispatched, saved.stuck], ['not-sent', 'tls', false, []]);

  const lost = await plan('lost', { cancel: true });
  assert.equal(lost.out.error, 'invalid_state', JSON.stringify(lost.out));
  assert.deepEqual([lost.o.status, lost.o.state.protocol.attempts], ['cancelled', []]);
  assert.deepEqual(lost.events, [tls], 'logged with no stage, as noteLost logs');
  assert.deepEqual([lost.purchase.outcome, lost.stuck], ['not-sent', []]);

  // A thrown value that only claims main's marks is not main's guard error: the
  // request may have been signed and sent, so the Vet write stays unread.
  failure = () => Object.assign(new Error('TEST forged'), { causeCode: 'tls', dispatched: false });
  const forged = await plan('forged');
  assert.deepEqual(forged.events.map(({ stage, reason, ...rest }) => rest), [{ outcome: 'indeterminate', causeCode: 'client-sign' }]);
  assert.deepEqual(forged.stuck, [['identity', 'seller-journal-not-read', []]]);

  // The route's signed fresh refusal, given before the seller's provider ran, while the purchase is cancelled.
  resolver = async () => { during(); return { disposition: 'rejected', reason: 'seller refused the context request (seller_budget_refused)', written: false }; };
  const refused = await plan('refused-lost', { cancel: true });
  assert.deepEqual(refused.events, [{ outcome: 'rejected', reason: 'seller refused the context request (seller_budget_refused)', written: false }]);
  assert.deepEqual(refused.stuck, []);
});
