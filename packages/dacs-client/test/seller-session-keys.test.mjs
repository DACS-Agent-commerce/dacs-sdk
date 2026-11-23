import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createSellerSessionKeys } from '../src/dacs/seller-session-keys.mjs';

const CLAIM = /^did:demos:agent:[0-9a-f]{64}$/;
const code = (expected) => (error) => error.code === expected;
const operation = (id, protocol = {}) => ({ id, state: { protocol } });
const delegationNaming = (claim) => ({ payload: { sessionPublicKey: claim.slice('did:demos:agent:'.length) }, signature: 'c2ln' });
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const verifiesUnder = (claim, bytes, signature) => verify(null, bytes, createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(claim.slice('did:demos:agent:'.length), 'hex')]), format: 'der', type: 'spki' }), signature);

// Every value reachable through own properties, not through closures.
function reachable(root) {
  const seen = new Set(), values = [];
  const visit = (value) => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) { if (typeof value === 'string') values.push(value); return; }
    seen.add(value); values.push(value);
    for (const key of Reflect.ownKeys(value)) visit(value[key]);
  };
  visit(root);
  return values;
}

test('start makes one in-memory ed25519 key per purchase, returns only its claim, and a second start in the same process returns the same claim', async () => {
  const keys = createSellerSessionKeys();
  const first = keys.start('purchase-1'), again = keys.start('purchase-1'), other = keys.start('purchase-2');
  assert.deepEqual(Object.keys(first), ['claim']);
  assert.match(first.claim, CLAIM);
  assert.equal(again.claim, first.claim);
  assert.notEqual(other.claim, first.claim);
  const signer = keys.signerFor(operation('purchase-1'));
  assert.equal(signer.claim, first.claim);
  const bytes = Buffer.from('signed bytes');
  assert.equal(verifiesUnder(first.claim, bytes, await signer.sign(bytes)), true);
});

test('the session-key module imports no file-system, SQLite or journal module, and no member of the registry or of a signer holds key or seed bytes', () => {
  const source = readFileSync(new URL('../src/dacs/seller-session-keys.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((match) => match[1]);
  assert.deepEqual(imports.filter((name) => /fs|sqlite|journal|store/i.test(name)), []);
  const keys = createSellerSessionKeys();
  keys.start('purchase-1');
  const found = [...reachable(keys), ...reachable(keys.signerFor(operation('purchase-1')))];
  assert.equal(found.some((value) => ArrayBuffer.isView(value) || value instanceof ArrayBuffer), false);
  assert.equal(found.some((value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)), false);
  assert.equal(found.some((value) => typeof value === 'object' && value !== null && Object.prototype.toString.call(value) === '[object KeyObject]'), false);
});

test('after stop, and in a new registry standing for a restart, signerFor answers session_gone_reapprove for a purchase with a retained delegation and session_not_started for one without, and a signer handed out before stop refuses to sign', async () => {
  const keys = createSellerSessionKeys(), { claim } = keys.start('purchase-1');
  const retained = operation('purchase-1', { sessionDelegation: delegationNaming(claim) });
  const handedOut = keys.signerFor(retained);
  assert.equal(keys.stop('purchase-1'), true);
  assert.equal(keys.stop('purchase-1'), false);
  assert.throws(() => keys.signerFor(retained), code('session_gone_reapprove'));
  assert.throws(() => keys.signerFor(operation('purchase-1')), code('session_not_started'));
  await assert.rejects(handedOut.sign(Buffer.from('late')), code('session_gone_reapprove'));
  const restarted = createSellerSessionKeys();
  assert.throws(() => restarted.signerFor(retained), code('session_gone_reapprove'));
  assert.throws(() => restarted.signerFor(operation('purchase-1')), code('session_not_started'));
  restarted.start('purchase-1'); restarted.start('purchase-2');
  assert.equal(restarted.stopAll(), 2);
  assert.equal(restarted.stopAll(), 0);
});

test("state reports live, gone and not_started from the registry and the purchase's retained delegation alone", () => {
  const keys = createSellerSessionKeys();
  assert.equal(keys.state(operation('purchase-1')), 'not_started');
  const { claim } = keys.start('purchase-1');
  assert.equal(keys.state(operation('purchase-1')), 'live');
  assert.equal(keys.state(operation('purchase-1', { sessionDelegation: delegationNaming(claim) })), 'live');
  assert.equal(keys.state(operation('purchase-1', { sessionDelegation: delegationNaming(`did:demos:agent:${'ab'.repeat(32)}`) })), 'gone');
  keys.stop('purchase-1');
  assert.equal(keys.state(operation('purchase-1', { sessionDelegation: delegationNaming(claim) })), 'gone');
  assert.equal(keys.state(operation('purchase-1', { pendingSessionDelegation: { payload: delegationNaming(claim).payload } })), 'gone');
  assert.equal(keys.state(operation('purchase-1')), 'not_started');
});

test('start refuses an operation id that is not a non-empty string with session_operation_invalid and creates no key', () => {
  const keys = createSellerSessionKeys();
  for (const id of [undefined, '', 7, {}]) {
    assert.throws(() => keys.start(id), (error) => error instanceof TypeError && error.message === 'session_operation_invalid');
    assert.equal(keys.state({ id, state: { protocol: {} } }), 'not_started');
  }
  assert.equal(keys.stopAll(), 0);
});
