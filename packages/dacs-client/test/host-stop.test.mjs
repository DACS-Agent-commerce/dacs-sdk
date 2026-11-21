// The host stop gate and the places the purchase factories read it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OperationError } from '../src/client-errors.mjs';
import { bindHostStop, createHostStop, HOST_STOP_CODES, hostStopSourceOf, isHostStopRefusal } from '../src/host-stop.mjs';

const refusal = (code) => (error) => error instanceof OperationError && error.code === code && error.message === `host stop refused: ${code}`;
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a stop check that returns false admits, true refuses writes_stopped, a throw refuses stop_check_failed with the thrown error as cause, and a non-boolean refuses stop_check_invalid', () => {
  assert.equal(createHostStop(() => false).assert(), undefined);
  assert.throws(() => createHostStop(() => true).assert(), refusal('writes_stopped'));
  const failure = new Error('TEST-stop-check-failure');
  assert.throws(() => createHostStop(() => { throw failure; }).assert(), (error) => refusal('stop_check_failed')(error) && error.cause === failure);
  for (const answer of [undefined, null, 0, 1, 'true', {}]) {
    assert.throws(() => createHostStop(() => answer).assert(), (error) => refusal('stop_check_invalid')(error) && error.cause === undefined, String(answer));
  }
  let answer = false;
  const gate = createHostStop(() => answer);
  gate.assert();
  answer = true;
  assert.throws(() => gate.assert(), refusal('writes_stopped'));
  assert.ok(HOST_STOP_CODES.every((code) => isHostStopRefusal(new OperationError(code, 'TEST'))));
  assert.equal(isHostStopRefusal(new OperationError('profile_not_admitted', 'TEST')), false);
  assert.equal(isHostStopRefusal(Object.assign(new Error('TEST'), { code: 'writes_stopped' })), false);
});

test('a stop check that returns a promise is refused stop_check_invalid at once and without a cause, pending, resolved or rejected, and a rejected one raises no unhandled rejection', async () => {
  const unhandled = [];
  const record = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', record);
  try {
    const answers = [new Promise(() => {}), Promise.resolve(false), Promise.resolve(true), Promise.reject(new Error('TEST-rejected-stop-check')), { then() {} }];
    for (const answer of answers) {
      assert.throws(() => createHostStop(() => answer).assert(), (error) => refusal('stop_check_invalid')(error) && error.cause === undefined);
    }
    await flush();
    await flush();
  } finally { process.off('unhandledRejection', record); }
  assert.deepEqual(unhandled, []);
});

test('no stop check installs nothing, and a non-function or an async function throws stop_seam_invalid', () => {
  const none = createHostStop(undefined);
  assert.equal(none.source, undefined);
  assert.equal(none.assert(), undefined);
  assert.equal(createHostStop(undefined), none);
  const invalid = (error) => error instanceof TypeError && error.message === 'stop_seam_invalid';
  for (const stopped of [null, false, 'yes', {}, async () => false, function* () {}, async function* () {}]) assert.throws(() => createHostStop(stopped), invalid);
  const stopped = () => false;
  assert.equal(createHostStop(stopped).source, stopped);
  const object = {};
  assert.equal(bindHostStop(object, stopped), object);
  assert.equal(hostStopSourceOf(object), stopped);
  assert.equal(hostStopSourceOf({}), undefined);
});

const sourceDirectory = fileURLToPath(new URL('../src/', import.meta.url));
const readSource = (path) => readFileSync(join(sourceDirectory, path), 'utf8').split('\n');
const callsOfHold = (lines) => lines.map((line, index) => ({ line, next: lines[index + 1] ?? '' }))
  .filter(({ line }) => line.includes('assertPurchaseActionsAdmitted()') && !line.startsWith('import '));
const sourceFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith('.mjs') ? [join(dir, entry.name)] : []);

test('inside both purchase factories no hold check stands without the host stop except the three held-only checks, and every seller request record and wire authentication is built with the stop check of its factory', () => {
  const heldOnly = ({ line }) => line.trim() === 'if (diagnostic()) assertPurchaseActionsAdmitted();';
  const withStop = ({ line, next }) => line.includes('hostStop.assert()') || next.includes('hostStop.assert()');
  const service = callsOfHold(readSource('purchases.mjs'));
  assert.equal(service.filter(heldOnly).length, 3);
  assert.deepEqual(service.filter((call) => !heldOnly(call) && !withStop(call)), []);
  const protocol = callsOfHold(readSource('dacs/protocol-purchases.mjs'));
  assert.ok(protocol.length >= 2);
  assert.deepEqual(protocol.filter((call) => !withStop(call)), []);
  const wire = callsOfHold(readSource('dacs/seller-wire-authentication.mjs'));
  assert.equal(wire.length, 3);
  assert.deepEqual(wire.filter(({ next }) => !next.includes('assertNotStopped(path)') && !next.includes('assertNotStopped(payload.path)')), []);
  const constructions = sourceFiles(sourceDirectory).flatMap((file) => readFileSync(file, 'utf8').split('\n').filter((line) => line.includes('createSellerRequestRecords({') && !line.startsWith('export function')));
  assert.equal(constructions.length, 3);
  assert.deepEqual(constructions.filter((line) => !line.includes('hostStop')), []);
  const authentications = readSource('dacs/protocol-purchases.mjs').join('\n').match(/createSellerWireAuthentication\(\{[^]*?job: \{/g) ?? [];
  assert.equal(authentications.length, 1);
  assert.ok(authentications.every((text) => text.includes('assertNotStopped: requestRecords.assertNotStopped')));
});
