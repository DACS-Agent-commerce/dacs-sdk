// A host that stops at each cut of an effect route's attempt, and reopens over the same wire journal and transport store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SellerAgentError } from '../src/dacs/seller-agent.mjs';
import { PATHS, proposalFor, proposeJob, world } from './helpers/wire-routes-world.mjs';
import { NOW } from './helpers/protocol-fixture.mjs';

// The work is done and its answer computed, but the answer cannot be signed: nothing was completed.
const cutAfterWork = async (w, job) => {
  w.signing.failures = 2;
  const cut = await job.post();
  assert.equal(cut.status, 503);
  assert.equal(cut.signed, false);
};

test('a cut between the agent\'s durable write and completion (host reopened over the same journal): after the lease the next request recovers, reconciles the write and completes once', async t => {
  const w = await world(t), job = await proposeJob(w, 'cut-after-write');
  await cutAfterWork(w, job);
  assert.equal(w.agent.calls.proposals, 1, 'the agent wrote');
  w.reopen();
  assert.equal((await job.post()).body.error, 'seller_effect_pending', 'a live lease holds the operation across the restart');
  w.state.time += w.leaseMs;
  const recovered = await job.post();
  assert.equal(recovered.status, 200);
  assert.deepEqual({ proposals: w.agent.calls.proposals, reconciled: w.agent.calls.reconciled }, { proposals: 1, reconciled: 1 }, 'the write was reconciled, never run again');
  w.reopen();
  assert.equal((await job.post()).text, recovered.text, 'completed once: the stored outcome answers after another restart');
  assert.equal(w.agent.calls.reconciled, 1);
});

test('a null end whose reply was lost keeps its binding across a restart, and the same binding recovers at once', async t => {
  const w = await world(t), job = await proposeJob(w, 'null-lost-reply');
  w.agent.answer = () => { throw new SellerAgentError('peer_job_capacity', 'TEST no work was done', 503); };
  const refused = await job.post();
  assert.equal(refused.body.error, 'peer_job_capacity', 'the proof of no effect ended the attempt with null');
  // The reply is lost: the buyer never read it, and the host restarts.
  w.reopen();
  // The host's retained Agreement changed: a request under it is another binding of the same operation.
  const other = await proposalFor(job.jobId, NOW + 1000), original = w.agent.transportAgreementOf;
  w.agent.transportAgreementOf = () => structuredClone(other.body.proposal.plan.draft);
  const rebound = await w.post(PATHS.proposals, other.body, { jobId: job.jobId, agreementHash: other.agreementHash });
  assert.deepEqual({ status: rebound.status, error: rebound.body.error }, { status: 409, error: 'peer_job_conflict' }, 'the operation kept its binding');
  w.agent.transportAgreementOf = original;
  w.agent.answer = undefined;
  const reconciledBefore = w.agent.calls.reconciled;
  assert.equal((await job.post()).status, 200, 'the same binding recovers at once, with no lease to wait for');
  assert.equal(w.agent.calls.reconciled, reconciledBefore + 1);
});

test('a host cut between the end record and the outcome file answers the exact stored bytes after a restart, with no agent run', async t => {
  const w = await world(t), job = await proposeJob(w, 'end-only');
  const first = await job.post();
  assert.equal(first.status, 200);
  const outcomes = readdirSync(w.state.journals[0]).filter((name) => name.endsWith('.done'));
  assert.equal(outcomes.length, 1, 'the journal publishes the outcome as a file of its own');
  // The host died between publishing the end record and the outcome file.
  rmSync(join(w.state.journals[0], outcomes[0]));
  w.reopen();
  const calls = w.effects();
  const replayed = await job.post();
  assert.equal(replayed.text, first.text, 'the end record alone completes the operation with the exact stored bytes');
  assert.equal(w.effects(), calls, 'no agent ran');
});

test('a completed answer that cannot be signed keeps its stored outcome across a restart, never a refusal or a null end', async t => {
  const w = await world(t), job = await proposeJob(w, 'signing-failure');
  const first = await job.post();
  assert.equal(first.status, 200);
  const files = w.journalFiles().length;
  w.signing.failures = 2;
  assert.equal((await job.post()).status, 503, 'the stored answer cannot be signed now');
  w.reopen();
  const again = await job.post();
  assert.equal(again.text, first.text, 'the failure after completion substituted neither a refusal nor a null end');
  assert.equal(w.journalFiles().length, files + 2, 'only the two repeats\' nonce keys were added');
  assert.equal(w.agent.calls.proposals, 1);
});
