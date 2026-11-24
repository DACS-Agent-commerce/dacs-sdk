// The seller receipt on an ordinary committed answer: the Agreement hash and the most the buyer reserves for this purchase (the Agreement
// price plus the seller's two explicit fee ceilings), signed with the answer by the wire. The agents are the real durable native agent;
// the wire handler, its response signer and the buyer's response verifier are the real ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_PATHS as PATHS } from '@kynesyslabs/dacs/wire';
import { agreementTerms } from '../src/dacs/purchase-protocol.mjs';
import { KIT_TP1_VET_MODE, startSellerHost } from '../src/host.mjs';
import { agreementCreateProjection } from './helpers/agreement-create-projection.mjs';
import { commitmentFixture } from './helpers/commitment-fixture.mjs';
import { hostAuthority } from './helpers/kit-wallet-session.mjs';
import { proxyListener } from './helpers/listener-host.mjs';
import { RECEIPT_FEE_CEILINGS } from './helpers/protocol-fixture.mjs';
import { SHORT_LEASE_MS, realWorld } from './helpers/route-recovery-world.mjs';
import { FIXTURE_ENDPOINT } from './helpers/wire-buyer.mjs';

const OS_TEXT = /^(?:0|[1-9][0-9]{0,77})$/;
const PAY = BigInt(RECEIPT_FEE_CEILINGS.payFeeCeilingOs), ANCHOR = BigInt(RECEIPT_FEE_CEILINGS.anchorFeeCeilingOs);
// The receipt the seller must declare for `agreement` under the pay and anchor fee ceilings, summed here in integers.
const expectedReceipt = (agreement, pay = PAY, anchor = ANCHOR) => ({ agreementHash: contentHash(agreement),
  reservedMaximumOs: (BigInt(agreementTerms(agreement).price.amountOs) + pay + anchor).toString() });
const ceilings = (pay, anchor) => ({ payFeeCeilingOs: String(pay), anchorFeeCeilingOs: String(anchor) });
// Malformed receipt fee ceilings, each refused with a TypeError that names the option.
const MALFORMED_CEILINGS = [
  ['only the Pay ceiling', { payFeeCeilingOs: '1' }],
  ['only the anchor ceiling', { anchorFeeCeilingOs: '1' }],
  ['an extra member', { ...RECEIPT_FEE_CEILINGS, feeCeilingOs: '1' }],
  ['a number', { ...RECEIPT_FEE_CEILINGS, payFeeCeilingOs: 7000013 }],
  ['a leading zero', { ...RECEIPT_FEE_CEILINGS, anchorFeeCeilingOs: '0300007' }],
  ['a sign', { ...RECEIPT_FEE_CEILINGS, payFeeCeilingOs: '-1' }],
  ['a fraction', { ...RECEIPT_FEE_CEILINGS, anchorFeeCeilingOs: '1.5' }],
  ['79 digits', { ...RECEIPT_FEE_CEILINGS, payFeeCeilingOs: `1${'0'.repeat(78)}` }],
  ['a sum past 78 digits', ceilings('9'.repeat(78), '9'.repeat(78))],
  ['an array', ['7000013', '300007']],
];

/** A wire world over a committed ordinary job whose proposal the host admitted: commitment requests reach the real agent. */
async function committedWorld(t, options = {}) {
  const w = await realWorld(t, options);
  assert.equal((await w.request(PATHS.proposals)).status, 200, 'the host admits the job through its proposal');
  w.agent.transportAgreementOf = (jobId) => w.fixture.agent().transportAgreementOf(jobId);
  return w;
}

test('a committed seller answer signs the Agreement hash and canonical reserved maximum from price and two explicit fee ceilings', async (t) => {
  // The fresh commitment, straight from the agent.
  const f = await commitmentFixture(t);
  const { agent, agreement } = await f.prepare();
  const fresh = await agent.commit({ jobId: agreement.jobId });
  assert.equal(fresh.status, 'committed');
  assert.deepEqual(fresh.sellerReceipt, expectedReceipt(agreement));
  assert.match(fresh.sellerReceipt.agreementHash, /^[0-9a-f]{64}$/);
  assert.match(fresh.sellerReceipt.reservedMaximumOs, OS_TEXT);
  // Each ceiling is its own addend: raising either one by one OS raises the declaration by exactly one OS.
  for (const [pay, anchor] of [[PAY + 1n, ANCHOR], [PAY, ANCHOR + 1n]]) {
    agent.close();
    const raised = await f.open({ receiptFeeCeilings: ceilings(pay, anchor) });
    assert.deepEqual((await raised.commit({ jobId: agreement.jobId })).sellerReceipt, expectedReceipt(agreement, pay, anchor), `pay ${pay}, anchor ${anchor}`);
    raised.close();
  }

  // Over the wire, the answer the buyer verifies carries the same receipt, and the response signature covers it.
  const w = await committedWorld(t);
  const answer = await w.commitmentRequest();
  assert.equal(answer.status, 200, answer.text);
  await w.verified(answer);
  assert.equal(answer.body.status, 'committed');
  assert.deepEqual(answer.body.sellerReceipt, expectedReceipt(w.fixture.agreement));
  const raisedBy = (amount) => ({ ...answer, text: JSON.stringify({ ...answer.body, sellerReceipt: { ...answer.body.sellerReceipt,
    reservedMaximumOs: (BigInt(answer.body.sellerReceipt.reservedMaximumOs) + amount).toString() } }) });
  // The same body text, rebuilt, still verifies; one OS more or less in the declaration does not.
  await w.verified(raisedBy(0n));
  for (const amount of [1n, -1n]) await assert.rejects(async () => w.verified(raisedBy(amount)), undefined, `a declaration changed by ${amount} OS`);
});

test('an early held commitment has no payment receipt and a completed replay retains the same receipt bytes', async (t) => {
  // Early: the held answer declares nothing; the ordinary answer that follows declares the receipt, and the published commitment record does not.
  const early = await commitmentFixture(t, { early: true });
  const { agent, agreement } = await early.prepare();
  const held = await agent.commitOnSignature({ jobId: agreement.jobId, agreement, signedProjection: agreementCreateProjection(agreement) });
  assert.equal(held.status, 'commitment-held');
  assert.equal(Object.hasOwn(held, 'sellerReceipt'), false);
  const committed = await agent.commit({ jobId: agreement.jobId });
  assert.deepEqual(committed.sellerReceipt, expectedReceipt(agreement));
  const records = [...early.local.rows.values()].map((row) => JSON.stringify(row));
  assert.ok(records.length > 0, 'the commitment record was published');
  for (const record of records) assert.doesNotMatch(record, /sellerReceipt|reservedMaximumOs/);

  // Over the wire, an early held answer is signed without a receipt.
  const heldWorld = await realWorld(t, { early: true });
  assert.equal((await heldWorld.request(PATHS.proposals)).status, 200);
  heldWorld.agent.transportAgreementOf = (jobId) => heldWorld.fixture.agent().transportAgreementOf(jobId);
  const heldAnswer = await heldWorld.commitmentRequest();
  assert.equal(heldAnswer.status, 200, heldAnswer.text);
  await heldWorld.verified(heldAnswer);
  assert.equal(heldAnswer.body.status, 'commitment-held');
  assert.equal(Object.hasOwn(heldAnswer.body, 'sellerReceipt'), false);

  // A completed ordinary answer replays byte for byte, also after the agent and the wire restart.
  const w = await committedWorld(t);
  const first = await w.commitmentRequest();
  assert.equal(first.status, 200, first.text);
  const again = await w.commitmentRequest();
  assert.equal(again.text, first.text, 'the completed answer is replayed');
  await w.verified(again);
  await w.fixture.reopen();
  w.reopen();
  const restarted = await w.commitmentRequest();
  assert.equal(restarted.text, first.text, 'the completed answer is replayed after a restart');
  await w.verified(restarted);
  // A seller restarted with other ceilings would declare another maximum: the stored answer is not replayed as if it were current.
  w.fixture.config.receiptFeeCeilings = ceilings(PAY + 1n, ANCHOR);
  await w.fixture.reopen();
  const changed = await w.commitmentRequest();
  assert.deepEqual({ status: changed.status, error: changed.body.error }, { status: 503, error: 'seller_source_unavailable' }, changed.text);
  assert.equal(Object.hasOwn(changed.body, 'sellerReceipt'), false);
});

test('a commitment answer whose response signature failed recovers with the same signed receipt', async (t) => {
  const w = await committedWorld(t, { leaseMs: SHORT_LEASE_MS });
  // The answer cannot be signed, so the attempt stays open; the lapsed attempt is then recovered from the retained commitment.
  w.signing.failures = 2;
  assert.equal((await w.commitmentRequest()).status, 503);
  w.state.time += w.leaseMs;
  const recovered = await w.commitmentRequest();
  assert.equal(recovered.status, 200, recovered.text);
  await w.verified(recovered);
  assert.deepEqual(recovered.body.sellerReceipt, expectedReceipt(w.fixture.agreement));
});

test('a native seller agent refuses construction without both explicit receipt fee ceilings', async (t) => {
  const f = await commitmentFixture(t);
  for (const missing of [undefined, null]) {
    await assert.rejects(f.open({ receiptFeeCeilings: missing }), { name: 'TypeError', message: /native seller profile needs receiptFeeCeilings/ }, String(missing));
  }
  for (const [label, value] of MALFORMED_CEILINGS) {
    await assert.rejects(f.open({ receiptFeeCeilings: value }), { name: 'TypeError', message: /^receiptFeeCeilings must be/ }, label);
  }
  // Zero is a declared ceiling, not a missing one.
  (await f.open({ receiptFeeCeilings: ceilings(0, 0) })).close();
});

test('a native seller host without either explicit receipt fee ceiling refuses before serving purchases', async (t) => {
  const f = await commitmentFixture(t, { vetMode: KIT_TP1_VET_MODE, publicEndpoint: FIXTURE_ENDPOINT });
  // The host builds its own challenge ledger and fixes the Vet mode and the agent's durable directory.
  const { durableDirectory, commitOnSignature, nativeArtifactAnchor, vetMode, challengeLedger, ...config } = f.config;
  const dataDirectory = await mkdtemp(join(tmpdir(), 'TEST-receipt-ceilings-host-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const options = { ...config, artifactAnchor: nativeArtifactAnchor, dataDirectory, ...hostAuthority(), listener: proxyListener() };
  const refusals = [[undefined, /^the seller host requires receiptFeeCeilings$/], [null, /^the seller host requires receiptFeeCeilings$/],
    ...MALFORMED_CEILINGS.map(([, value]) => [value, /^receiptFeeCeilings must be/])];
  for (const [value, message] of refusals) {
    await assert.rejects(startSellerHost({ ...options, receiptFeeCeilings: value }), { name: 'TypeError', message }, JSON.stringify(value) ?? 'undefined');
    assert.deepEqual(await readdir(dataDirectory), [], 'the refusal opens no state');
  }
  // With both ceilings the same options start a host that listens.
  const host = await startSellerHost(options);
  try { assert.match(host.url, /^http:/); } finally { await host.close(); }
});
