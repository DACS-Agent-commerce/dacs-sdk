import assert from 'node:assert/strict';
import { writeSync } from 'node:fs';
import { openWorld } from './domain-store-crash-world.mjs';

const [path, kind, stage] = process.argv.slice(2);
const world = openWorld(path), exec = world.db.exec.bind(world.db);
// Intercept the real adapter's outer COMMIT, after all domain writes. No
// production hook or replacement transaction implementation is involved.
world.db.exec = sql => {
  if (sql !== 'COMMIT') return exec(sql);
  const snapshot = world.snapshot(kind);
  if (kind === 'settlement') {
    assert.equal(snapshot.operation.status, 'settled_verified');
    assert.ok(snapshot.coordinate.verifiedAt);
    assert.equal(snapshot.consumptions.length, 1);
    assert.equal(snapshot.replacement.status, 'superseded');
  } else {
    assert.ok(snapshot.operation.state.protocol.deliveryDeadline.overdue);
    assert.equal(snapshot.events.filter(event => event.type === 'protocol_delivery_deadline_overdue').length, 1);
  }
  if (stage === 'after-commit') exec(sql);
  writeSync(1, `TEST-crash:${kind}:${stage}\n`);
  process.kill(process.pid, 'SIGKILL');
};
if (kind === 'settlement') await world.verify();
else world.observe();
throw new Error('TEST-domain-commit-was-not-reached');
