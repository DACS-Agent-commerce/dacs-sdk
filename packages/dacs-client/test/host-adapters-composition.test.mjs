// The public purchase factories composed over only the package's own
// operations, accounts and challenges adapters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installPurchaseAdmissionHook, loadAdmissionDouble } from './helpers/purchase-admission-hook.mjs';

installPurchaseAdmissionHook();
const { setPurchaseAdmission } = await loadAdmissionDouble();
const { compositionWorld, NOW, HANDOFF_TTL_MS } = await import('./helpers/public-composition-world.mjs');
const { isPurchaseOperationId, OperationError } = await import('../src/index.mjs');

const admitted = (t) => { setPurchaseAdmission('testnet-tp1'); t.after(() => setPurchaseAdmission('held')); };
const refused = (code) => (error) => error instanceof OperationError && error.code === code;
const outcome = (promise) => promise.then(() => 'resolved', (error) => `rejected:${error?.code ?? error?.message}`);
const count = (world, table) => world.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const savedRow = (world, table, column, value) => ({ ...world.db.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`).get(value) });

test('both public purchase factories construct on a fresh schema with only the shipped adapters, and prepare, the identity request and status run through them', async (t) => {
  admitted(t);
  const world = await compositionWorld(t, { shippedAdapters: true });
  assert.equal(world.accountId, `local:${world.wallet.address}`);
  assert.equal(count(world, 'accounts'), 1);
  const { operation, created } = await world.prepare();
  assert.equal(created, true);
  assert.equal(isPurchaseOperationId(operation.id), true);
  assert.equal(operation.accountId, world.accountId);
  const row = savedRow(world, 'operations', 'id', operation.id);
  assert.equal(row.job_id, operation.terms.protocol.jobId);
  assert.equal(row.handoff_expires_at, new Date(NOW + HANDOFF_TTL_MS).toISOString());
  const { operationId, token, signature } = await world.preparedWithIdentity();
  assert.equal(operationId, operation.id);
  assert.equal(typeof signature, 'string');
  const status = world.service.status(world.accountId, operation.id, token);
  assert.equal(status.operation.id, operation.id);
});

test('status reads a prepared purchase with the token handoffTokenFor recomputes after the adapters are rebuilt, and refuses it once the handoff lifetime has passed', async (t) => {
  admitted(t);
  const world = await compositionWorld(t, { shippedAdapters: true });
  const { operation } = await world.prepare();
  // Held, status authenticates the handoff token and its lifetime on every call.
  setPurchaseAdmission('held');
  const restarted = world.rebuild({ now: () => NOW + 1 });
  const token = restarted.ops.handoffTokenFor(operation.id);
  assert.equal(token, world.ops.handoffTokenFor(operation.id));
  assert.equal(restarted.service.status(world.accountId, operation.id, token).operation.id, operation.id);
  const late = world.rebuild({ now: () => NOW + HANDOFF_TTL_MS });
  assert.throws(() => late.service.status(world.accountId, operation.id, token), refused('not_found'));
});

test('approval runs through the public purchase service on the shipped adapters: issueApprovalChallenge, a wallet signature over the returned text and approve record one approval, and a second approve is refused invalid_state with no second approval or charge', async (t) => {
  admitted(t);
  const world = await compositionWorld(t, { shippedAdapters: true });
  const { operation, token } = world.seed({ status: 'awaiting_approval', key: 'TEST-approval', currentListing: true });
  const challenge = await world.service.issueApprovalChallenge({ operationId: operation.id, token, address: world.wallet.address });
  const signature = world.wallet.signHex(challenge.message);
  const approval = { operationId: operation.id, token, challengeId: challenge.challengeId, signature };
  const first = await outcome(world.service.approve(approval));

  assert.equal(count(world, 'approvals'), 1);
  const saved = savedRow(world, 'approvals', 'operation_id', operation.id);
  assert.deepEqual([saved.challenge_id, saved.signer_address, saved.terms_hash], [challenge.challengeId, world.wallet.address, operation.termsHash]);
  const approvedEvents = () => world.ops.history(operation.id).filter((event) => event.type === 'approved');
  assert.equal(approvedEvents().length, 1);
  assert.equal(approvedEvents()[0].data.challengeId, challenge.challengeId);
  const consumed = savedRow(world, 'challenges', 'id', challenge.challengeId);
  assert.equal(consumed.consumed_by, operation.id);

  // The control runs on its own world: the first handoff left this wallet a payment in flight, which refuses another.
  const controlWorld = await compositionWorld(t, { shippedAdapters: true });
  const control = controlWorld.seed({ status: 'approved', key: 'TEST-control', currentListing: true });
  assert.equal(first, await outcome(controlWorld.service.prepareHandoff({ operationId: control.operation.id, token: control.token })),
    'the approval\'s handoff settles as a purchase seeded approved does');

  const broadcasts = world.chain.broadcasts;
  const status = world.ops.get(world.accountId, operation.id).status;
  await assert.rejects(world.service.approve(approval), refused('invalid_state'));
  assert.equal(count(world, 'approvals'), 1);
  assert.equal(approvedEvents().length, 1);
  assert.deepEqual(savedRow(world, 'challenges', 'id', challenge.challengeId), consumed);
  assert.equal(world.ops.get(world.accountId, operation.id).status, status);
  assert.equal(world.chain.broadcasts, broadcasts);
});
