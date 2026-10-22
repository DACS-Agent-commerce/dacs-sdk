import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openWorld, HASH, WALLET, ACCOUNT } from './helpers/domain-store-crash-world.mjs';

for (const kind of ['settlement', 'delivery']) for (const stage of ['before-commit', 'after-commit']) {
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
    world = openWorld(path);
    t.after(() => world.db.close());
    if (stage === 'before-commit') assert.deepEqual(world.snapshot(kind), before, 'all uncommitted domain writes roll back');
    else assertCommitted(world.snapshot(kind), kind);

    // Restart retries the real domain entry point without adding a second
    // settlement, consumption, supersession or overdue event.
    if (kind === 'settlement') assert.equal((await world.verify()).verification.outcome, 'verified');
    else world.observe();
    const committed = world.snapshot(kind);
    assertCommitted(committed, kind);
    world.db.close();
    world = openWorld(path);
    if (kind === 'settlement') assert.equal((await world.verify()).verification.outcome, 'verified');
    else world.observe();
    assert.deepEqual(world.snapshot(kind), committed, 'a repeated request after another restart has no second effect');
  });
}

function assertCommitted(s, kind) {
  assert.equal(s.coordinate.reportedTxHash, HASH, 'the exact payment pointer survives');
  assert.ok(s.coordinate.verifiedAt);
  assert.equal(s.operation.status, 'settled_verified');
  if (kind === 'settlement') {
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
    assert.equal(overdue.disposition, 'indeterminate');
    assert.equal(s.operation.accountId, ACCOUNT);
    const events = s.events.filter(event => event.type === 'protocol_delivery_deadline_overdue');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].data, overdue);
    assert.equal(s.consumptions.length, 0);
  }
}
