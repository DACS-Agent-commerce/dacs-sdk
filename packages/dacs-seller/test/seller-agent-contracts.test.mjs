import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalize } from '@kynesyslabs/dacs';
import { SellerAgentError, buildReport, canonicalSignature, proposalTimeProblem } from '../src/dacs/seller-agent.mjs';
import { canonicalSignature as anchorSignature } from '../src/dacs/fixture-anchors.mjs';
import { proposalTimeProblem as timeProblem } from '../src/dacs/seller-proposal-time.mjs';
import { protocolFixture, JOB } from './helpers/protocol-fixture.mjs';

test('error contract preserves code, message and default or custom status', () => {
  for (const [status, expected] of [[undefined, 422], [503, 503]]) {
    const error = new SellerAgentError('test_refusal', 'specific cause', status);
    assert.ok(error instanceof Error);
    assert.equal(error.code, 'test_refusal');
    assert.equal(error.message, 'specific cause');
    assert.equal(error.status, expected);
  }
});
test('report contract binds the Agreement and Listing without mutating inputs', async () => {
  const { agreement, listing } = await protocolFixture();
  const input = { agreement, listing, settlementId: 'test-settlement' }, original = structuredClone(input);
  const report = buildReport(input);
  const { signature: _signature, signatures: _signatures, ...scope } = agreement;
  const expectedHash = createHash('sha256').update(canonicalize(scope)).digest('hex');
  assert.deepEqual(report, {
    reportVersion: '1', kind: 'dacs-chatgpt-plugin/fixture-test-report', jobId: JOB,
    agreementHash: expectedHash, listing: agreement.listingRef,
    title: listing.offering.title, settlementId: input.settlementId,
    body: [`Deterministic fixture report for job ${JOB}.`,
      `Listing ${listing.listingId}@v${listing.listingVersion}, price ${listing.pricing.price.amount} DEM.`,
      'SIMULATED offline fixture content; not a real market report.'],
  });
  assert.equal(JSON.stringify(buildReport(input)), JSON.stringify(report));
  assert.deepEqual(input, original);
  report.listing.contentHash = 'changed';
  assert.deepEqual(input, original);
});
test('report refuses malformed jobs before building output', async () => {
  const input = await protocolFixture();
  for (const jobId of [undefined, '', 'invalid', JOB.toLowerCase(), ` ${JOB}`]) {
    assert.throws(() => buildReport({ ...input, agreement: { ...input.agreement, jobId } }), { code: 'job_invalid' });
  }
});
test('report refuses a mismatched or malformed Listing', async () => {
  const input = await protocolFixture();
  for (const listing of [null, {}, { ...input.listing, offering: { ...input.listing.offering, title: 'substituted' } }]) {
    assert.throws(() => buildReport({ ...input, listing }), { code: 'listing_invalid' });
  }
});
test('contract re-exports preserve module identity', () => {
  assert.equal(canonicalSignature, anchorSignature);
  assert.equal(proposalTimeProblem, timeProblem);
});
