import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openWorld, nativeMarker, HASH, WALLET, ACCOUNT } from './helpers/domain-store-crash-world.mjs';

for (const kind of ['settlement', 'delivery', 'native-settlement', 'native-supersession', 'native-nonce',
  'native-supersession-pending', 'native-nonce-pending']) for (const stage of ['before-commit', 'after-commit']) {
  test(`${kind} SIGKILL ${stage}: reopen and repeat preserve the complete domain decision`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'dacs-domain-crash-')), path = join(dir, 'state.sqlite');
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let world = openWorld(path);
    world.seed(kind);
    const before = world.snapshot(kind);
    world.db.close();
    const crash = spawnSync(process.execPath,
      [fileURLToPath(new URL('./helpers/domain-store-crash-worker.mjs', import.meta.url)), path, kind, stage],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 1 << 20 });
    assert.equal(crash.error, undefined);
    assert.equal(crash.signal, 'SIGKILL', crash.stdout + crash.stderr);
    assert.match(crash.stdout, new RegExp(`TEST-crash:${kind}:${stage}`));
    world = openWorld(path, { failResolution: kind.endsWith('-pending') });
    t.after(() => world.db.close());
    const marker = nativeMarker(kind), reopened = world.snapshot(kind);
    if (marker) {
      assertCommitted(reopened, kind);
      assert.equal(reopened[marker.events].filter(event => event.type === marker.type).length,
        stage === 'after-commit' ? 1 : 0, 'only the targeted marker commit can persist its event');
      const observation = marker.events === 'replacementEvents' ? reopened.replacementCoordinate.observation : reopened.coordinate.observation;
      assert.equal(observation[marker.events === 'replacementEvents' ? 'nativeLaneResolved' : 'nativeNonceResolved'] === true,
        stage === 'after-commit' && !kind.endsWith('-pending'), 'marker and event commit together');
    } else if (stage === 'before-commit') assert.deepEqual(reopened, before, 'all uncommitted domain writes roll back');
    else assertCommitted(reopened, kind);

    if (kind.endsWith('-pending')) {
      const retry = await world.verify();
      assert.equal(retry.verification.nativeNonceResolved, false);
      assert.match(retry.verification.nextStep, /Retry verify_deal/);
      const pending = world.snapshot(kind);
      for (const [events, type] of [[pending.events, 'native_nonce_pending'],
        [pending.replacementEvents, 'native_supersession_pending']]) {
        const matching = events.filter(event => event.type === type);
        assert.equal(matching.length, 1);
        assert.equal(matching[0].data.reason, 'TEST-source-reconciliation-pending');
      }
      await world.verify();
      assert.deepEqual(world.snapshot(kind), pending, 'the same source failure adds no duplicate pending event');
      world.db.close();
      world = openWorld(path);
    }

    // Restart retries the real domain entry point without adding a second
    // settlement, consumption, supersession or overdue event.
    if (kind !== 'delivery') assert.equal((await world.verify()).verification.outcome, 'verified');
    else world.observe();
    const committed = world.snapshot(kind);
    assertCommitted(committed, kind);
    if (kind.startsWith('native-')) {
      assert.equal(committed.coordinate.observation.nativeNonceResolved, true);
      assert.equal(committed.replacementCoordinate.observation.nativeLaneResolved, true);
      assert.equal(committed.events.filter(event => event.type === 'native_nonce_resolved').length, 1);
      assert.equal(committed.replacementEvents.filter(event => event.type === 'native_supersession_resolved').length, 1);
    }
    world.db.close();
    world = openWorld(path);
    if (kind !== 'delivery') assert.equal((await world.verify()).verification.outcome, 'verified');
    else world.observe();
    assert.deepEqual(world.snapshot(kind), committed, 'a repeated request after another restart has no second effect');
    assert.equal(world.resolutionCalls.length, 0, 'completed source reconciliation is not repeated after restart');
  });
}

function assertCommitted(s, kind) {
  assert.equal(s.coordinate.reportedTxHash, HASH, 'the exact payment pointer survives');
  assert.ok(s.coordinate.verifiedAt);
  assert.equal(s.operation.status, 'settled_verified');
  if (kind !== 'delivery') {
    assert.equal(s.coordinate.observation.txHash, HASH);
    assert.equal(s.coordinate.observation.slotConsumed, true);
    assert.equal(s.consumptions.length, 1);
    const consumption = s.consumptions[0];
    assert.equal(consumption.operation_id, s.operation.id);
    assert.equal(consumption.from_address, WALLET);
    assert.equal(consumption.network, 'testnet');
    assert.equal(consumption.nonce, 7);
    assert.equal(consumption.tx_hash, HASH);
    assert.equal(s.events.filter(event => event.type === 'settled_verified').length, 1);
    assert.equal(s.replacement.status, 'superseded');
    assert.equal(s.replacementCoordinate.observation.supersededBy, s.operation.id);
    assert.equal(s.replacementCoordinate.observation.txHash, HASH);
    assert.equal(s.replacementEvents.filter(event => event.type === 'superseded').length, 1);
  } else {
    const overdue = s.operation.state.protocol.deliveryDeadline.overdue;
    assert.equal(overdue.authority, 'local-observation');
    assert.equal(overdue.source, 'host-supplied');
    assert.equal(overdue.disposition, 'indeterminate');
    assert.equal(s.operation.accountId, ACCOUNT);
    const events = s.events.filter(event => event.type === 'protocol_delivery_deadline_overdue');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].data, overdue);
    assert.equal(s.consumptions.length, 0);
  }
}

for (const kind of ['settlement', 'delivery']) {
  test(`${kind} callback COMMIT cannot split the domain decision, including after reopen`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'dacs-domain-host-commit-')), path = join(dir, 'state.sqlite');
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let world = openWorld(path);
    world.seed(kind);
    const before = world.snapshot(kind), transition = world.ops.transition;
    world.ops.transition = (...args) => {
      const result = transition(...args);
      // The host adapter attempts to finish the package's outer transaction.
      world.db.exec('COMMIT');
      return result;
    };
    if (kind === 'delivery') assert.throws(() => world.observe(), /statements in progress/);
    else await assert.rejects(world.verify(), /statements in progress/);
    assert.deepEqual(world.snapshot(kind), before);
    world.db.close();
    world = openWorld(path);
    try {
      assert.deepEqual(world.snapshot(kind), before, 'no partial observation, event, status or nonce survived');
      if (kind === 'delivery') world.observe(); else await world.verify();
      assertCommitted(world.snapshot(kind), kind);
    } finally { world.db.close(); }
  });
}
