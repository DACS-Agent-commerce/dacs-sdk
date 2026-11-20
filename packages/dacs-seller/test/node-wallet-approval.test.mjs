// The approval accounting of the seller's Node wallet: every request of the composed walletFactory runs as one approval
// attempt, and each request the approver accepted is settled in its ledger by what the request wrote to the journals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactWrite, inWalletPass, JOB_CREATE, jsonResponse, ok, outcomes, preparedWrite, refuseConfirmation, replyTo, sendWrite, settlingApproval, settlingWorld, writesOf } from './helpers/seller-node-wallet-world.mjs';

const { OPERATOR_CLOSING } = await import('../src/devnet-demo/operator-approval.mjs');
const { sellerDiagnostic } = await import('../src/seller-diagnostics.mjs');

// The transport's inclusion poll sleeps 500 ms between reads, up to 240 times.
const CLOCK_STEP_MS = 500;
const CLOCK_STEPS = 2_000;
/** Resolves `work` while moving the mocked clock forward, for a request that waits on a deadline. */
async function withClockAdvancing(t, work) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let done = false;
  const result = work().finally(() => { done = true; });
  for (let step = 0; !done && step < CLOCK_STEPS; step++) {
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(CLOCK_STEP_MS);
  }
  const answer = await result;
  t.mock.timers.reset();
  return answer;
}
const withheldAcknowledgement = world => replyTo(world.node, 'broadcastTx', () => { throw new Error('TEST-acknowledgement-lost'); });

test('an accepted, included artifact CREATE is settled spent', async t => {
  const world = await settlingWorld(t);
  const { answer } = await artifactWrite(world);
  assert.equal(answer.success, true, JSON.stringify(answer));
  assert.equal(world.node.broadcasts.length, 1);
  assert.deepEqual(world.approve.settled.map(({ request, outcome }) => [request.method, outcome]), [['sign', 'released'], ['sendTransaction', 'spent']],
    'the message signature wrote nothing and is released; the included write is spent');
});

test('a 200 broadcast reply carrying an included writeProof for a write the node never applied is settled unknown', async t => {
  const world = await settlingWorld(t);
  replyTo(world.node, 'broadcastTx', row => {
    const { hash } = row.body.params[0].data.response.data.transaction;
    return jsonResponse({ ...ok({ hash }), writeProof: { disposition: 'included', receipt: { hash }, noResend: true } });
  });
  const { answer } = await withClockAdvancing(t, () => artifactWrite(world));
  assert.equal(answer.data?.writeProof, undefined, 'the transport never passes on a proof the node supplied');
  assert.deepEqual(outcomes(world), ['unknown']);
});

test('a dropped broadcast acknowledgement is settled unknown, and a confirmation the node refuses before any broadcast is settled released', async t => {
  const dropped = await settlingWorld(t);
  withheldAcknowledgement(dropped);
  assert.equal((await artifactWrite(dropped)).answer.success, false);
  assert.equal(dropped.node.broadcasts.length, 1);
  assert.deepEqual(outcomes(dropped), ['unknown']);

  const refused = await settlingWorld(t);
  refuseConfirmation(refused);
  assert.equal((await artifactWrite(refused)).answer.success, false);
  assert.equal(refused.node.broadcasts.length, 0, 'nothing was sent');
  assert.deepEqual(outcomes(refused), ['released']);
});

test('issuance is recorded from the selected walletFactory journal and from the transport journal, not from a write outside a request', async t => {
  const world = await settlingWorld(t);
  const stages = [];
  const selected = { ...world.wallet.artifactJournal, put: (key, value) => { stages.push(value?.stage); return world.wallet.artifactJournal.put(key, value); } };
  withheldAcknowledgement(world);
  await artifactWrite(world, { anchorJournal: selected });
  assert.ok(stages.includes('broadcast-started'), 'the selected journal kept the record');
  assert.deepEqual(outcomes(world), ['unknown'], 'its record marked the request sent');

  await world.wallet.artifactJournal.put('TEST-unrelated-write', { stage: 'broadcast-started' });
  assert.equal(writesOf(world.approve).length, 1, 'a record written outside any request settles nothing');

  const transportOnly = await settlingWorld(t);
  withheldAcknowledgement(transportOnly);
  await artifactWrite(transportOnly, {});
  assert.deepEqual(outcomes(transportOnly), ['unknown'], 'the transport journal marks a request that selects no journal');
});

test('two overlapping wallet requests run one at a time, each in its own attempt with its own settlement', async t => {
  let active = 0, mostActive = 0;
  const approve = settlingApproval({ gate: async () => {
    active++; mostActive = Math.max(mostActive, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
  } });
  const world = await settlingWorld(t, { approve });
  withheldAcknowledgement(world);
  const write = await preparedWrite(world);
  const settledBefore = approve.settled.length;
  const [sent, signed] = await Promise.all([sendWrite(world, write), write.wallet.request({ method: 'sign', params: ['TEST-overlapping-message'] })]);
  assert.equal(sent.success, false, 'the write whose acknowledgement was lost fails');
  assert.equal(signed.success, true, JSON.stringify(signed));
  assert.equal(mostActive, 1, 'the approver never saw two requests at once');
  assert.deepEqual(approve.settled.slice(settledBefore).map(({ request, outcome }) => [request.method, outcome]).sort(), [['sendTransaction', 'unknown'], ['sign', 'released']],
    'the write is unknown, and the signature that overlapped it is released: it did not inherit the write\'s issuance');
});

test('a settlement error or a logger error never puts the message, nested cause or thrown-object text on stdout or stderr, and the wallet result is unchanged', async t => {
  const secret = 'TEST-secret-settlement-message';
  const failure = Object.assign(new Error(secret, { cause: new Error('TEST-secret-nested-cause') }), { code: 'approval_reservation_unavailable' });
  const written = [];
  for (const stream of [process.stdout, process.stderr]) t.mock.method(stream, 'write', chunk => { written.push(String(chunk)); return true; });
  const reference = await settlingWorld(t);
  const expected = (await artifactWrite(reference)).answer.success;

  const world = await settlingWorld(t, { approve: settlingApproval({ failure }) });
  const { answer } = await artifactWrite(world);
  assert.equal(answer.success, expected, 'the wallet result is what it was without the failure');
  assert.deepEqual(world.diagnostics, Array(2).fill(sellerDiagnostic('approval_reservation_unavailable')), 'the sink got the closed projection for the signature and for the write');

  const throwingSink = await settlingWorld(t, { approve: settlingApproval({ failure: { code: 'x', toString: () => 'TEST-secret-thrown-object' } }),
    diagnostics: () => { throw new Error('TEST-secret-logger-error'); } });
  assert.equal((await artifactWrite(throwingSink)).answer.success, expected);
  const output = written.join('');
  for (const text of [secret, 'TEST-secret-nested-cause', 'TEST-secret-thrown-object', 'TEST-secret-logger-error']) assert.ok(!output.includes(text), `${text} was not written`);
});

test('a request whose approval ended in a shutdown answers operator_closing and signs nothing, while the request already in flight is still settled', async t => {
  let closing = false, entered = false, release;
  const inFlight = new Promise(resolve => { release = resolve; });
  const approve = settlingApproval({ gate: async request => {
    if (closing) throw Object.assign(new Error('TEST-closing'), { code: OPERATOR_CLOSING });
    if (request.method === 'sendTransaction') { entered = true; await inFlight; }
  } });
  const flying = await settlingWorld(t, { approve }), queued = await settlingWorld(t, { approve });
  const [first, second] = [await preparedWrite(flying), await preparedWrite(queued)];
  const sending = sendWrite(flying, first);
  while (!entered) await new Promise(resolve => setImmediate(resolve));
  closing = true;
  release();
  assert.equal((await sending).success, true, 'the approval given before the shutdown is honoured');
  assert.deepEqual(outcomes(flying), ['spent'], 'the request in flight is still settled after the shutdown');
  const refused = await sendWrite(queued, second);
  assert.equal(refused.error?.code, OPERATOR_CLOSING);
  assert.equal(queued.node.broadcasts.length, 0, 'the refused request signed and sent nothing');
  assert.equal(writesOf(approve).length, 1, 'the refused request has no settlement to make');
});

test('a broadcast-started write that fails, or commits and then throws, leaves the request settled unknown and never released', async t => {
  for (const commitFirst of [false, true]) {
    const world = await settlingWorld(t);
    const journal = world.wallet.artifactJournal;
    const failing = { ...journal, put: async (key, value) => {
      if (value?.stage !== 'broadcast-started') return journal.put(key, value);
      if (commitFirst) await journal.put(key, value);
      throw new Error('TEST-journal-write-failed');
    } };
    const { answer } = await artifactWrite(world, { anchorJournal: failing });
    assert.equal(answer.success, false);
    assert.deepEqual(outcomes(world), ['unknown'], commitFirst ? 'committed then threw' : 'failed');
    assert.equal(world.node.broadcasts.length, 0, 'the failed write sent nothing');
  }
});

test('walletFactory refuses a selected anchor journal that cannot record writes', async t => {
  const world = await settlingWorld(t);
  assert.throws(() => world.wallet.walletFactory({ anchorJournal: {} }), TypeError);
  assert.throws(() => world.wallet.walletFactory({ anchorJournal: null }), TypeError);
});
