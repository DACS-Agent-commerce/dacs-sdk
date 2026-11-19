import test from 'node:test';
import assert from 'node:assert/strict';
import { commitmentFixture } from './helpers/commitment-fixture.mjs';
import { JOB } from './helpers/protocol-fixture.mjs';
import { NOW } from './helpers/protocol-fixture.mjs';
import { SellerAgentError, transportOutcome } from '../src/dacs/seller-agent.mjs';
import { DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';

const untilDeadline = (agreement) => agreement.terms.deadline - NOW;

test('a first commitment at the Agreement deadline is refused and leaves no commitment work', async (t) => {
  const f = await commitmentFixture(t), { agent, agreement } = await f.prepare();
  f.advance(untilDeadline(agreement));
  await assert.rejects(agent.commit({ jobId: JOB }), (error) => error.code === 'agreement_deadline_passed' && error.status === 409);
  assert.equal(agent.retainsCommitmentWork(JOB), false);
  assert.equal(f.local.writes.length, 0);
});

test('a first commitment one millisecond before the Agreement deadline is accepted', async (t) => {
  const f = await commitmentFixture(t), { agent, agreement } = await f.prepare();
  f.advance(untilDeadline(agreement) - 1);
  assert.equal((await agent.commit({ jobId: JOB })).status, 'committed');
});

test('a commitment made before the deadline is read back after it', async (t) => {
  const f = await commitmentFixture(t), { agent, agreement } = await f.prepare();
  assert.equal((await agent.commit({ jobId: JOB })).status, 'committed');
  f.advance(untilDeadline(agreement) + 1);
  assert.equal((await agent.commit({ jobId: JOB })).status, 'committed');
});

test('a first commitment refused after the deadline is answered as a definite 409 refusal on both commitment routes, not as an uncertain outcome', async (t) => {
  const f = await commitmentFixture(t), { agent, agreement } = await f.prepare();
  f.advance(untilDeadline(agreement));
  const refused = await agent.commit({ jobId: JOB }).catch((failure) => failure);
  assert.equal(refused.code, 'agreement_deadline_passed');
  // The fixture's agent comes from its own copy of the module, so the transport sees the same refusal as this module's error class.
  const error = new SellerAgentError(refused.code, refused.message, refused.status);
  for (const path of [DACS_SELLER_HTTP_PATHS.commitments, DACS_SELLER_HTTP_PATHS.commitmentSignature]) {
    const outcome = transportOutcome(path, { error }, { retained: false });
    assert.deepEqual({ status: outcome.status, disposition: outcome.disposition, error: outcome.value.error }, { status: 409, disposition: 'no-effect', error: 'agreement_deadline_passed' }, path);
  }
});
