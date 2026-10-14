import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readdirSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDevnetDemoOperator } from '../src/devnet-demo/operator.mjs';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';

// sellerApproval.purchaseSource "seller" with DACS_COMMIT_ON_SIGNATURE=on, on
// the owned loopback Node2 profile. Seller records take the buyer's signed
// Agreement as the seller read it back from chain before committing; an early
// commitment precedes that readback, so policy mode refuses the pair at start.
// The operator reads the switch from its environment when created; this file
// runs in its own process.
process.env.DACS_COMMIT_ON_SIGNATURE = 'on';

const REFUSED = 'sellerApproval policy mode with purchaseSource "seller" cannot run with DACS_COMMIT_ON_SIGNATURE=on: seller records check the commitment against the Agreement the seller read back from chain, and commitment on signature commits before that readback';
const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
const connects = port => new Promise(resolve => { const socket = net.connect({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const kindsOf = h => h.node2.chain.wire.record.accepted.map(tx => tx.content?.data?.[1]?.metadata?.artifactKind);
const broadcastKind = body => body?.method === 'execute' && body?.params?.[0]?.extra === 'broadcastTx'
  ? body.params[0].data?.response?.data?.transaction?.content?.data?.[1]?.metadata?.artifactKind : undefined;
const ledger = async h => (await readFile(join(h.config.stateDirectory, 'evidence', 'seller-approvals.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);

test('policy mode with seller records refuses to start with commitment on signature, before any journal, ledger or listener opens', { timeout: 300000 }, async t => {
  // A running app-source policy operator supplies the reviewed admission, TLS files and custody.
  const h = await startOperatorPurchaseNode2({ sellerApproval: { mode: 'policy' }, authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true, listen: false });
  t.after(() => h.close());
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seller-records-signature-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [appPort, sellerPort, directoryPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const stateDirectory = join(root, 'state'), configPath = join(root, 'operator.json'), base = JSON.parse(await readFile(h.configPath, 'utf8'));
  await writeFile(configPath, `${JSON.stringify({ ...base, publicOrigin: `http://127.0.0.1:${appPort}`, sellerOrigin: `https://127.0.0.1:${sellerPort}`, directoryOrigin: `http://127.0.0.1:${directoryPort}`, stateDirectory, sellerApproval: { mode: 'policy', purchaseSource: 'seller' } })}\n`, { mode: 0o600 });
  const started = await createDevnetDemoOperator({ configPath, fetchImpl: h.fetchImpl, authorizeSellerApproval: () => true }).then(operator => ({ operator }), error => ({ error }));
  await started.operator?.close();
  assert.equal(started.error?.message, REFUSED, String(started.error?.stack ?? 'the operator started'));
  // Only main's operator secret exists: no journal, issuance binding, approval ledger or seller state.
  assert.deepEqual(readdirSync(stateDirectory), ['app-secret.json']);
  for (const port of [appPort, sellerPort, directoryPort]) assert.equal(await connects(port), false, `nothing listens on ${port}`);
});

test('with commitment on signature, seller records in manual mode commit early and complete one purchase; every seller write is approved by hand', { timeout: 300000 }, async t => {
  const manual = [];
  const h = await startOperatorPurchaseNode2({ sellerApproval: { mode: 'manual', purchaseSource: 'seller' }, authorizeSellerApproval: ({ request }) => { manual.push(request.content.artifactKind); return true; }, authorizeBuyerApproval: () => true });
  t.after(() => h.close());
  const result = await h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: 'seller-records-signature-manual-001' });
  assert.equal(result.status, 'delivery-ready', JSON.stringify(result));
  const session = h.composition.sellerAgent.durableSessionOf(result.jobId);
  assert.equal(session.signatureCommitmentHeld, true, 'the seller committed through the early route');
  assert.ok(session.commitment, 'and then read the Agreement back and finalized it');
  assert.equal(kindsOf(h).filter(kind => kind === 'FinalityCommitmentRecord').length, 1);
  assert.equal(kindsOf(h).filter(kind => kind === 'Agreement').length, 1);
  assert.equal(manual.filter(kind => kind === 'FinalityCommitmentRecord').length, 1);
  // Manual mode runs no policy: no line on the ledger is a policy line.
  assert.ok((await ledger(h)).every(row => !Object.hasOwn(row, 'approvalMode')));
});

// App-source policy approves the early commitment itself. The test fails the
// commitment's status reads once it is broadcast and closes the operator, so
// the wallet ends with an issued write and no inclusion proof.
test('app-source policy with commitment on signature: operator close while an approved early commitment is issued keeps its reservation and never resends it', { timeout: 300000 }, async t => {
  const entered = deferred();
  let h, commitment = null, failing = true;
  const rpcFault = async ({ body }) => {
    if (!commitment && h && broadcastKind(body) === 'FinalityCommitmentRecord') { commitment = body.params[0].data.response.data.transaction.hash; entered.resolve(); }
    if (commitment && failing && body?.params?.[0]?.message === 'getTransactionStatus' && body.params[0].data?.hash === commitment)
      return new Response(JSON.stringify({ result: 500, response: 'TEST status unavailable' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return null;
  };
  h = await startOperatorPurchaseNode2({ sellerApproval: { mode: 'policy' }, authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true, rpcFault });
  t.after(() => h.close());
  const purchase = h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: 'seller-policy-signature-stop-001' }).then(value => ({ value }), error => ({ error }));
  await Promise.race([entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('the early commitment was not broadcast')), 60000))]);
  const closed = await h.operator.close().then(() => ({}), error => ({ error }));
  assert.equal(closed.error, undefined, String(closed.error?.stack ?? closed.error));
  await purchase;
  failing = false;
  const reservationOf = async () => {
    const lines = await ledger(h), row = lines.find(line => line.approvalMode === 'policy' && line.decision === 'approved' && JSON.parse(line.requestBytes).content.artifactKind === 'FinalityCommitmentRecord');
    return { row, completions: lines.filter(line => line.format === 'dacs-node2-seller-policy-attempt/v1' && line.reservationId === row?.reservationId) };
  };
  const stopped = await reservationOf();
  assert.match(stopped.row?.reservationId ?? '', /\S/, 'the policy approved the early commitment with a reservation');
  assert.deepEqual(stopped.completions.filter(line => line.outcome === 'released'), [], 'an issued write is never released by shutdown');
  const commitmentSends = () => h.node2.chain.wire.record.broadcastAttempts.filter(hash => hash === commitment).length;
  assert.equal(commitmentSends(), 1);
  await h.restart();
  const row = h.application.db.prepare("SELECT id, account_id FROM operations WHERE kind = 'purchase'").get();
  await h.application.services.purchases.verifyDeal({ accountId: row.account_id, operationId: row.id });
  const after = h.application.db.prepare("SELECT status, json_extract(state, '$.protocol.stage') AS stage FROM operations WHERE id = ?").get(row.id);
  assert.deepEqual({ ...after }, { status: 'awaiting_approval', stage: 'seller-committed' }, 'the restart reads the one commitment back');
  assert.equal(commitmentSends(), 1, 'and never sends it again');
  assert.equal(kindsOf(h).filter(kind => kind === 'FinalityCommitmentRecord').length, 1);
  assert.deepEqual((await reservationOf()).completions.filter(line => line.outcome === 'released'), []);
});
