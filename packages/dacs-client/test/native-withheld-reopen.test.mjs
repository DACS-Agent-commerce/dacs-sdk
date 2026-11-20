// A native broadcast that the final check withheld before any possible transmission is sent once, by a new explicit
// request that names it with a one-use capability. Every other retained broadcast stays readback-only.
// The real transport, effect boundary, dispatch history and durable journal run in this process against a scripted TEST
// node; a restart reopens the same journal with a new transport and a new capability registry. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize } from '@kynesyslabs/dacs';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { code, cutAppend, flush, setPurchaseAdmission } from './helpers/effect-boundary-fixture.mjs';
import { finalizedWorld } from './helpers/finalized-node-world.mjs';
import { LANE_PREFIX, nativeWorld as world } from './helpers/native-effect-world.mjs';
import { inPass } from './helpers/pass-context-fixture.mjs';

const { createReopenGrants } = await import('../src/wallet/withheld-reopen-grants.mjs');

const gas = (network, rpc) => ({ fees: { network_fee: network, rpc_fee: rpc, additional_fee: '0' } });
const GAS = gas('1000000000', '1000000000');
const STOP = { change: w => { w.stopped = true; }, cause: 'writes_stopped' };
const REHOLD = { change: () => setPurchaseAdmission('held'), cause: 'profile_not_admitted' };
const states = records => records.map(record => record.state);
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
const intentKey = tx => `devnet/native-transfer/${tx.hash}`;

// One process: the transport over the shared journal, with its own registry of capabilities, as the session wires it.
// `faults.finish` makes the lane and intent writes that finish a withheld broadcast as failed fail.
function boot(w) {
  const grants = createReopenGrants(), faults = {};
  let tick = Date.now();
  const extra = { reopenGrants: { consume: grants.consume }, stamps: { next: () => ++tick },
    journal: w.faultyJournal((key, value) => { w.puts.push({ key, stage: value?.stage }); return faults.finish === true && value?.stage === 'failed'; }),
    fetchImpl: (url, init) => faults.broadcast && JSON.parse(init.body).params?.[0]?.extra === 'broadcastTx' ? Promise.reject(new Error('TEST-answer-lost')) : w.node.fetch(url, init) };
  return { grants, faults, extra };
}
async function start(t) {
  const w = world(t, { bound: await bindFixture() });
  w.puts = [];
  const process = boot(w);
  w.open({}, process.extra);
  w.node.gas = GAS;
  return Object.assign(w, process);
}
async function restart(w) {
  const process = boot(w);
  await w.restart({}, process.extra);
  return Object.assign(w, process);
}

const laneKey = w => `${LANE_PREFIX}${JSON.stringify(['testnet', 'c'.repeat(64), w.address])}`;
const signedRecord = async (w, tx) => (await w.records(tx)).find(record => record.state === 'signed');
async function reopen(w, tx, scope = {}) {
  const capability = w.grants.register({ operationId: (await signedRecord(w, tx)).operationId, lane: laneKey(w), hash: tx.hash, ...scope });
  return w.transport().reopenWithheldBroadcast({ capability, signRpc: w.signRpc });
}
// Adds a history record for the artifact of `tx`, naming the operation of its signed record.
async function plant(w, tx, passId, state, extra = {}) {
  const { operationId, lane, kind, paidWrite, debitOs, pinVersion, artifactHash } = await signedRecord(w, tx);
  await w.history.append({ operationId, lane, kind, paidWrite, debitOs, pinVersion, artifactHash, passId, state, ...extra });
}
const plantRows = async (w, tx, stage = 'broadcast-started') => {
  const row = { stage, hash: tx.hash, nonce: tx.content.nonce, signedTransaction: tx };
  await w.plant(laneKey(w), row);
  await w.plant(intentKey(tx), row);
};

// The first broadcast of `tx`, withheld by `change` at the final check, after its lane rows were retained.
async function withholdBroadcast(w, tx, { change, cause }) {
  const lease = await w.lease(), confirmation = await w.confirm(tx);
  await w.prepareBroadcast(lease.leaseId, tx.hash);
  let held, fired = false;
  cutAppend(w, 'dispatch-started', { mutate: () => { if (!fired) { fired = true; held = w.gate.hold(); } } });
  const refused = assert.rejects(w.broadcast(confirmation), code(cause));
  for (let tries = 0; tries < 100 && !held?.reached; tries++) await flush();
  assert.equal(held?.reached, true, 'the broadcast reached its final check');
  change(w);
  held.release();
  await refused;
  w.stopped = false;
  setPurchaseAdmission('testnet-tp1');
}

// A retained transaction whose history and rows are written directly: confirmed, then a withheld dispatch.
async function seeded(t, { confirmed = true, withheld = true, rows = true } = {}) {
  const w = await start(t), tx = w.signedTransfer(1);
  if (confirmed) {
    const lease = await w.lease();
    await w.confirm(tx);
    await w.release(lease.leaseId);
  } else {
    await w.boundary.signPass({ operationId: 'TEST-operation', lane: laneKey(w), kind: 'native', paidWrite: true, debitOs: '2500000000', pinVersion: w.bound.binding.profile.pinVersion },
      async () => Buffer.from(JSON.stringify(tx)));
  }
  await plant(w, tx, 'p1', 'dispatch-started');
  if (withheld) await plant(w, tx, 'p1', 'dispatch-withheld', { cause: { code: 'writes_stopped' } });
  if (rows) await plantRows(w, tx);
  return { w: await restart(w), tx };
}

test('with the real transport, history adapter and durable journal, the first native broadcast withheld by a stop and, separately, by a re-hold, then reopened in another process: clearing the stop or re-enabling sends nothing automatically; a new explicit request broadcasts the identical retained transaction once; a repeat and two concurrent explicit requests make no second broadcast; an earlier possible dispatch followed by a withheld pass stays readback-only; a crash before the withheld record commits stays unknown; the public resume and every transport guard are exercised', async t => {
  for (const [name, withheld] of [['a stop', STOP], ['a re-hold', REHOLD]]) {
    await t.test(`a broadcast withheld by ${name} and reopened after a restart is sent once with the identical bytes`, async t => {
      const first = await start(t), tx = first.signedTransfer(1);
      await withholdBroadcast(first, tx, withheld);
      assert.deepEqual(first.node.broadcasts, []);
      assert.deepEqual(states(await first.records(tx)).slice(-2), ['dispatch-started', 'dispatch-withheld']);
      const finished = await first.journal().get(laneKey(first));
      assert.deepEqual([finished.stage, finished.failure], ['failed', { withheld: true }], 'the last check finishes the lane as withheld');
      const w = await restart(first);
      assert.deepEqual(w.node.broadcasts, [], 'clearing the stop or re-enabling sends nothing by itself');
      const confirms = w.node.confirms, puts = w.puts.length;
      const answer = await reopen(w, tx);
      assert.equal(answer.result, 200);
      assert.deepEqual(w.node.broadcasts, [tx.hash]);
      assert.deepEqual(w.node.applied.get(tx.hash), tx, 'the node received the signed transaction unchanged');
      assert.equal(w.node.confirms, confirms, 'the retained confirmation is restored, not asked for again');
      assert.deepEqual(w.puts.slice(puts).map(put => put.stage), ['broadcast-started', 'broadcast-started', 'broadcast-accepted', 'broadcast-accepted'], 'the finished rows are retained again just before the send');
      assert.equal((await w.journal().get(laneKey(w))).stage, 'broadcast-accepted');
      const records = states(await w.records(tx));
      assert.equal(records.filter(state => state === 'dispatch-withheld').length, 1, 'the earlier records are kept');
      assert.equal(records.at(-1), 'dispatch-acknowledged');
      await assert.rejects(reopen(w, tx), code('outcome_unknown'));
      assert.deepEqual(w.node.broadcasts, [tx.hash], 'a repeat makes no second broadcast');
    });
  }
  await t.test('a withheld broadcast whose finishing writes failed keeps its rows at broadcast-started: a new lease refuses it, and the reopen sends it once without retaining its rows again', async t => {
    const first = await start(t), tx = first.signedTransfer(1);
    first.faults.finish = true;
    await withholdBroadcast(first, tx, STOP);
    assert.deepEqual(states(await first.records(tx)).slice(-2), ['dispatch-started', 'dispatch-withheld']);
    assert.equal((await first.journal().get(laneKey(first))).stage, 'broadcast-started');
    const w = await restart(first);
    await assert.rejects(w.lease(), code('outcome_unknown'));
    assert.deepEqual(w.node.broadcasts, []);
    const puts = w.puts.length;
    assert.equal((await reopen(w, tx)).result, 200);
    assert.deepEqual(w.node.broadcasts, [tx.hash]);
    assert.deepEqual(w.puts.slice(puts).map(put => put.stage), ['broadcast-accepted', 'broadcast-accepted'], 'the lane and intent rows are not retained again before the send');
    await assert.rejects(reopen(w, tx), code('outcome_unknown'));
    assert.deepEqual(w.node.broadcasts, [tx.hash], 'a repeat makes no second broadcast');
  });
  await t.test('two concurrent explicit requests make one broadcast', async t => {
    const first = await start(t), tx = first.signedTransfer(1);
    await withholdBroadcast(first, tx, STOP);
    const w = await restart(first);
    const outcomes = await Promise.all([settle(reopen(w, tx)), settle(reopen(w, tx))]);
    assert.equal(outcomes.filter(outcome => outcome.value).length, 1);
    assert.deepEqual(w.node.broadcasts, [tx.hash]);
  });
  await t.test('an earlier possible dispatch followed by a withheld pass stays readback-only', async t => {
    const { w, tx } = await seeded(t, { withheld: false });
    await plant(w, tx, 'p1', 'dispatch-unknown', { cause: { code: 'TEST-answer-lost' } });
    await plant(w, tx, 'p2', 'signed', { bytes: (await signedRecord(w, tx)).bytes });
    await plant(w, tx, 'p2', 'dispatch-started');
    await plant(w, tx, 'p2', 'dispatch-withheld', { cause: { code: 'writes_stopped' } });
    await assert.rejects(reopen(w, tx), code('outcome_unknown'));
    assert.deepEqual(w.node.broadcasts, []);
  });
  await t.test('a crash before the withheld record commits leaves the dispatch unknown and the lane readback-only', async t => {
    const first = await start(t), tx = first.signedTransfer(1);
    const lease = await first.lease(), confirmation = await first.confirm(tx);
    await first.prepareBroadcast(lease.leaseId, tx.hash);
    cutAppend(first, 'dispatch-withheld');
    first.stopped = true;
    await assert.rejects(first.broadcast(confirmation));
    first.stopped = false;
    const w = await restart(first);
    assert.deepEqual(states(await w.records(tx)).slice(-1), ['dispatch-started']);
    await assert.rejects(reopen(w, tx), code('outcome_unknown'));
    assert.deepEqual(w.node.broadcasts, []);
  });
  await t.test('a reopened broadcast whose answer is lost is never reopened again', async t => {
    const { w, tx } = await seeded(t);
    w.faults.broadcast = true;
    await assert.rejects(reopen(w, tx));
    assert.equal(states(await w.records(tx)).at(-1), 'dispatch-unknown');
    w.faults.broadcast = false;
    await assert.rejects(reopen(w, tx), code('outcome_unknown'));
    assert.deepEqual(w.node.broadcasts, []);
  });
  await t.test('a death after the acknowledgement but before the lane rows are updated stays readback-only', async t => {
    const { w, tx } = await seeded(t);
    await plant(w, tx, 'p2', 'signed', { bytes: (await signedRecord(w, tx)).bytes });
    await plant(w, tx, 'p2', 'dispatch-started');
    await plant(w, tx, 'p2', 'dispatch-acknowledged');
    assert.equal((await w.journal().get(laneKey(w))).stage, 'broadcast-started');
    await assert.rejects(reopen(w, tx), code('outcome_unknown'));
    assert.deepEqual(w.node.broadcasts, []);
  });
  await t.test('the reopen is an effect pass: a re-hold refuses it before any effect', async t => {
    const { w, tx } = await seeded(t);
    setPurchaseAdmission('held');
    await assert.rejects(reopen(w, tx), code('profile_not_admitted'));
    setPurchaseAdmission('testnet-tp1');
    assert.deepEqual(w.node.broadcasts, []);
  });
  await t.test('a stop at the reopen withholds it again and a later explicit request still sends once', async t => {
    const { w, tx } = await seeded(t);
    w.stopped = true;
    await assert.rejects(reopen(w, tx), code('writes_stopped'));
    w.stopped = false;
    assert.deepEqual(w.node.broadcasts, []);
    assert.equal((await reopen(w, tx)).result, 200);
    assert.deepEqual(w.node.broadcasts, [tx.hash]);
  });
  await t.test('a lane whose broadcast was withheld before its rows were written is reopened without writing them early', async t => {
    const { w, tx } = await seeded(t, { rows: false });
    assert.equal((await reopen(w, tx)).result, 200);
    assert.deepEqual(w.node.broadcasts, [tx.hash]);
    assert.equal((await w.journal().get(laneKey(w))).stage, 'broadcast-accepted');
  });
  await t.test('a confirmed transaction that no broadcast ever reached is sent once by a reopen after a restart', async t => {
    const first = await start(t), tx = first.signedTransfer(1);
    const lease = await first.lease();
    await first.confirm(tx);
    await first.release(lease.leaseId);
    const w = await restart(first);
    assert.deepEqual(w.node.broadcasts, []);
    assert.equal((await reopen(w, tx)).result, 200);
    assert.deepEqual(w.node.broadcasts, [tx.hash]);
    assert.equal(w.node.confirms, 1, 'the retained confirmation is restored');
    await assert.rejects(reopen(w, tx), code('outcome_unknown'));
    assert.deepEqual(w.node.broadcasts, [tx.hash]);
  });
});

test('a reopen restores the retained confirmation byte for byte, gas included, and the fee check reads it; without it, or after an unknown confirmation, a new confirmation pass is required and an unknown is never treated as confirmed; a retry path, a timer, a startup sweep and a caller-supplied flag cannot create a reopen operation; missing, conflicting or incomplete history refuses with its cause and transmits nothing; the registration seam exists only on the trusted composition; a capability for another operation id, lane or hash authorizes nothing and every capability is consumed by its first pass; the reopen takes only the capability and sends the retained bytes; the private current-authorization check reaches the final check; an ordinary pass without its check is withheld', async t => {
  await t.test('the retained confirmation is restored byte for byte, gas included, and the fee ceiling is checked against it', async t => {
    const { w, tx } = await seeded(t), restored = (await w.records(tx)).find(record => record.state === 'confirm-acknowledged');
    const answer = await reopen(w, tx);
    assert.equal(answer.result, 200);
    assert.equal(w.node.confirms, 1, 'no new confirmation was asked for');
    assert.equal(canonicalize(w.node.applied.get(tx.hash)), canonicalize(restored.confirmation.response.data.transaction));
    assert.deepEqual(restored.gasOperation, GAS);
    const over = await seeded(t);
    over.w.feeCeilingOs = '4499999999';
    const low = await restart(over.w);
    await assert.rejects(reopen(low, over.tx), code('write-fee-cap'));
    assert.deepEqual(low.node.broadcasts, []);
    assert.equal(states(await low.records(over.tx)).at(-1), 'dispatch-withheld');
  });
  await t.test('after an unknown confirmation a new confirmation pass runs before the broadcast', async t => {
    const { w, tx } = await seeded(t);
    await plant(w, tx, 'p2', 'signed', { bytes: (await signedRecord(w, tx)).bytes });
    await plant(w, tx, 'p2', 'confirm-started');
    await plant(w, tx, 'p2', 'confirm-unknown', { cause: { code: 'TEST-answer-lost' } });
    await reopen(w, tx);
    assert.equal(w.node.confirms, 2, 'the unknown confirmation did not count as confirmed');
    assert.deepEqual(w.node.broadcasts, [tx.hash]);
  });
  await t.test('without a retained confirmation a new confirmation pass is required', async t => {
    const { w, tx } = await seeded(t, { confirmed: false });
    await reopen(w, tx);
    assert.equal(w.node.confirms, 1);
    assert.deepEqual(w.node.broadcasts, [tx.hash]);
  });
  for (const [name, [expected, build]] of Object.entries({
    'an intent row without its lane row': ['outcome_unknown', async t => {
      const made = await seeded(t, { rows: false });
      await made.w.plant(intentKey(made.tx), { stage: 'broadcast-started', hash: made.tx.hash, nonce: 1, signedTransaction: made.tx });
      return made;
    }],
    'a lane row naming another transaction': ['outcome_unknown', async t => {
      const made = await seeded(t);
      await made.w.plant(laneKey(made.w), { stage: 'broadcast-started', hash: 'f'.repeat(64), nonce: 7, signedTransaction: made.w.signedTransfer(7) });
      return made;
    }],
    'a lane row from a retired pin': ['pin_version_retired', async t => {
      const made = await seeded(t);
      const row = await made.w.journal().get(laneKey(made.w));
      await made.w.plant(laneKey(made.w), { ...row, networkBinding: { pinVersion: 'TEST-retired-pin' } });
      return made;
    }],
    'a withheld record that has no start': ['outcome_unknown', async t => {
      const made = await seeded(t);
      await plant(made.w, made.tx, 'p9', 'dispatch-withheld', { cause: { code: 'writes_stopped' } });
      return made;
    }],
    'a history that never recorded the signed bytes': ['outcome_unknown', async t => {
      const w = await start(t), tx = w.signedTransfer(1);
      await plantRows(w, tx);
      return { w, tx };
    }],
  })) {
    await t.test(`${name} refuses with ${expected} and transmits nothing`, async t => {
      const { w, tx } = await build(t);
      const capability = w.grants.register({ operationId: (await signedRecord(w, tx).catch(() => null))?.operationId ?? 'TEST-operation', lane: laneKey(w), hash: tx.hash });
      const { error } = await settle(w.transport().reopenWithheldBroadcast({ signRpc: w.signRpc, capability }));
      assert.equal(error?.code, expected, error?.message);
      assert.notEqual(error.message, '');
      assert.deepEqual(w.node.broadcasts, []);
    });
  }
  await t.test('a capability for an operation that holds no retained transaction refuses and transmits nothing', async t => {
    const { w, tx } = await seeded(t, { rows: false });
    await assert.rejects(reopen(w, tx, { operationId: 'TEST-other-operation' }), code('outcome_unknown'));
    assert.deepEqual(w.node.broadcasts, []);
  });
  await t.test('a retry path, a request flag and an ordinary job pass cannot reopen a withheld lane', async t => {
    const { w, tx } = await seeded(t);
    const { binding } = await w.transport().binding({ phase: 'bind', address: w.address });
    await assert.rejects(w.transport().binding({ phase: 'signature', address: w.address, binding, reopen: true, explicit: true, hash: tx.hash }), code('outcome_unknown'));
    await assert.rejects(inPass({ operationClass: 'job-resume', operationId: 'TEST-operation', currentAuthorization: () => true }, () => w.lease()), code('outcome_unknown'));
    await assert.rejects(w.lease(), code('outcome_unknown'));
    assert.deepEqual(w.node.broadcasts, []);
  });
  await t.test('a capability for another hash or lane authorizes nothing, and every capability is consumed by its first pass', async t => {
    const { w, tx } = await seeded(t);
    await assert.rejects(reopen(w, tx, { hash: 'e'.repeat(64) }), code('reopen_scope_invalid'));
    await assert.rejects(reopen(w, tx, { lane: 'devnet/native-wallet/other' }), code('outcome_unknown'));
    const capability = w.grants.register({ operationId: (await signedRecord(w, tx)).operationId, lane: laneKey(w), hash: tx.hash });
    w.stopped = true;
    await assert.rejects(w.transport().reopenWithheldBroadcast({ capability, signRpc: w.signRpc }), code('writes_stopped'));
    w.stopped = false;
    await assert.rejects(w.transport().reopenWithheldBroadcast({ capability, signRpc: w.signRpc }), code('reopen_capability_invalid'));
    await assert.rejects(w.transport().reopenWithheldBroadcast({ capability: {}, signRpc: w.signRpc }), code('reopen_capability_invalid'));
    assert.deepEqual(w.node.broadcasts, []);
  });
  await t.test('the reopen sends the retained bytes and accepts no caller transaction', async t => {
    const { w, tx } = await seeded(t), other = w.signedTransfer(2);
    const capability = w.grants.register({ operationId: (await signedRecord(w, tx)).operationId, lane: laneKey(w), hash: tx.hash });
    await w.transport().reopenWithheldBroadcast({ capability, signRpc: w.signRpc, signedTransaction: other, transaction: other, tx: other });
    assert.deepEqual(w.node.broadcasts, [tx.hash]);
  });
  await t.test('a job reopen without its current-authorization check, with a false one or with a refusing one is withheld before the send', async t => {
    const original = Object.assign(new Error('TEST-credit-gone'), { code: 'TEST_credit_gone' });
    for (const [name, scope, cause] of [['missing', { operationClass: 'job-resume' }, 'context_authorization_required'], ['false', { operationClass: 'job-resume', currentAuthorization: () => false }, 'context_authorization_refused'],
      ['refusing', { operationClass: 'job-resume', currentAuthorization: () => { throw original; } }, 'TEST_credit_gone']]) {
      const { w, tx } = await seeded(t);
      await assert.rejects(reopen(w, tx, scope), code(cause), name);
      assert.deepEqual(w.node.broadcasts, [], name);
      assert.equal((await w.records(tx)).findLast(record => record.state === 'dispatch-withheld').cause.code, cause, name);
      assert.equal((await w.journal().get(laneKey(w))).stage, 'broadcast-started', name);
    }
    const { w, tx } = await seeded(t);
    assert.equal((await reopen(w, tx, { operationClass: 'job-resume', currentAuthorization: () => true })).result, 200);
  });
  await t.test('a registered capability lost with the process grants nothing to the next process', async t => {
    const { w, tx } = await seeded(t);
    const capability = w.grants.register({ operationId: (await signedRecord(w, tx)).operationId, lane: laneKey(w), hash: tx.hash });
    const next = await restart(w);
    await assert.rejects(next.transport().reopenWithheldBroadcast({ capability, signRpc: next.signRpc }), code('reopen_capability_invalid'));
    assert.deepEqual(next.node.broadcasts, []);
    assert.equal((await reopen(next, tx)).result, 200, 'a new explicit authorization sends once');
  });
  await t.test('the registration seam exists only on the composition result: no request, wallet method or relay call registers', async t => {
    const w = await finalizedWorld(t);
    await w.build();
    const { withheldReopen, wallet, transport } = w.session;
    assert.deepEqual(Object.keys(withheldReopen).sort(), ['register', 'reopen']);
    assert.equal(Object.isFrozen(withheldReopen), true);
    for (const surface of [wallet, transport]) for (const name of ['register', 'reopen', 'reopenWithheldBroadcast', 'withheldReopen']) assert.equal(name in surface, false, name);
    await assert.rejects(transport.binding({ phase: 'reopen', address: wallet.getPublicAccount().address, hash: 'a'.repeat(64) }));
    await assert.rejects(withheldReopen.reopen({ capability: {}, signRpc: async () => '' }), code('reopen_capability_invalid'));
    assert.deepEqual(w.effects(), []);
  });
  await t.test('an ordinary seller pass without its registered check is withheld with no node call, for each job class', async t => {
    for (const operationClass of ['job-create', 'payment-evidence', 'job-resume']) {
      const w = await start(t), tx = w.signedTransfer(1);
      const lease = await w.lease();
      await assert.rejects(inPass({ operationClass, operationId: lease.leaseId }, () => w.confirm(tx)), code('context_authorization_required'), operationClass);
      assert.equal(w.node.confirms, 0, operationClass);
    }
    const w = await start(t), tx = w.signedTransfer(1);
    await w.lease();
    assert.equal((await inPass({ operationClass: 'job-create', currentAuthorization: () => true }, () => w.confirm(tx))).result, 200, 'the authorized control transmits');
  });
});
