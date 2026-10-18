// DACS_BUYER_CHAIN_READBACK=off (the default) must be byte-identical to the
// tree it was built on: tool output, routes, MCP tools, Agreement and artifact
// bytes, transport bindings, seller answers and every journal and database row.
// The expected digests are written by scripts/buyer-chain-readback-identity.mjs
// from the merge base's src/ with this test overlaid, and only once the base
// and merged-tree captures are byte-identical. The purchase runs twice, with
// fresh keys, ids and clocks: values both runs share are kept literally and
// only run-random ones are replaced, relation-preservingly; every request and
// row is kept in wire order (buyer-chain-readback-identity.mjs).
// DACS_TEST_RECORD_IDENTITY=<file> writes the normalized capture instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { NATIVE_PAYMENT_EVIDENCE } from '../src/dacs/native-payment-evidence-consumer.mjs';
import { agree, handoff, payAndDeliver, start } from './helpers/buyer-chain-readback-flow.mjs';
import { captureIdentity, normalizeRuns, sectionDigests } from './helpers/buyer-chain-readback-identity.mjs';

// The fixture keeps one SHA-256 per section. Record mode writes the whole
// capture so a mismatch can be diffed.
const EXPECTED = new URL('./fixtures/buyer-chain-readback-off-identity.json', import.meta.url);

// One full switch-off purchase on its own harness, captured raw.
async function purchase(t) {
  // A long seller timeout keeps a loaded host from adding retry rows to either run.
  const h = await start(t, { sellerRequestTimeoutMs: 120000 });
  assert.notEqual(h.config.buyerChainReadback, 'on');
  const commitAnswers = []; h.testHooks.afterSellerCommit = (answer) => commitAnswers.push(answer);
  const f = await agree(t, h);
  const committed = await f.raw('verify_deal');
  assert.equal(committed.structuredContent?.protocol?.stage, 'seller-committed', JSON.stringify(committed.structuredContent));
  const { txHash } = await payAndDeliver(h, f, await handoff(f));
  const repeated = await f.raw('verify_deal'), status = await f.raw('get_purchase_status');
  assert.equal(repeated.structuredContent?.protocol?.stage, 'delivery-ready');
  const sellerAnswer = await h.composition.sellerAgent.submitPayment({ jobId: f.operation().terms.protocol.jobId, txHash, payerPayingKey: f.buyerActor.signer.claim, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE });
  return captureIdentity(h, { tools: await f.listTools(), toolOutputs: { prepare: f.preparedRaw, committed, delivered: repeated, status }, commitAnswers, sellerAnswer, operation: f.operation() });
}

test('switch off: a full purchase shows, sends, writes and keeps exactly what the base tree does', { timeout: 840000 }, async (t) => {
  const previous = process.env.DACS_BUYER_CHAIN_READBACK; delete process.env.DACS_BUYER_CHAIN_READBACK;
  t.after(() => { if (previous !== undefined) process.env.DACS_BUYER_CHAIN_READBACK = previous; });
  const capture = normalizeRuns([await purchase(t), await purchase(t)]);
  if (process.env.DACS_TEST_RECORD_IDENTITY) { writeFileSync(process.env.DACS_TEST_RECORD_IDENTITY, `${JSON.stringify(capture, null, 1)}\n`); return; }
  const expected = JSON.parse(readFileSync(EXPECTED, 'utf8')).sections, actual = sectionDigests(capture);
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const key of Object.keys(expected)) assert.equal(actual[key], expected[key], `${key} differs from the base tree (record with DACS_TEST_RECORD_IDENTITY and diff)`);
});
