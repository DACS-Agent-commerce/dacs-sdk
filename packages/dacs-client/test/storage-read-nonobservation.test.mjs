// CORE §5.1: a node's storage-program 404 (node2 answers
// {"success":false,"errorCode":"NOT_FOUND"}) or a malformed success body is a
// non-observation with no authenticated absence proof: indeterminate, never
// absent. Only a well-formed program is found.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDemosChainReader } from '../src/dacs/chain.mjs';

const locator = 'stor-' + '0'.repeat(40);
const reader = (status, body) => createDemosChainReader({ rpcUrl: 'https://rpc.invalid', network: 'testnet', timeoutMs: 1000,
  fetchImpl: async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) });

for (const [name, status, body] of [
  ['node2 404 NOT_FOUND', 404, { success: false, errorCode: 'NOT_FOUND' }],
  ['success false', 200, { success: false }],
  ['no data', 200, { success: true }],
  ['array data', 200, { success: true, data: [] }],
]) {
  test(`storage read: ${name} is indeterminate, not absent`, async () => {
    const read = await reader(status, body).readStorageProgram(locator);
    assert.equal(read.status, 'indeterminate');
    assert.equal(typeof read.reason, 'string');
  });
}

test('storage read: a well-formed program is found', async () => {
  const read = await reader(200, { success: true, data: { a: 1 }, owner: '0x' + 'A'.repeat(64), programName: 'TEST' }).readStorageProgram(locator);
  assert.deepEqual(read, { status: 'found', data: { a: 1 }, owner: '0x' + 'a'.repeat(64), programName: 'TEST' });
});

test('storage read: an unavailable node still throws', async () => {
  await assert.rejects(reader(503, {}).readStorageProgram(locator), (error) => error.kind === 'unavailable');
});
