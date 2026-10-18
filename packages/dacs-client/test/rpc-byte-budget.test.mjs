import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemosChainReader } from '../src/dacs/chain.mjs';

const RPC_LIMIT = 4 * 1024 * 1024;
const identity = 'a'.repeat(64);
// Exact block-zero refusal from node 61b8e75 getBlockByNumber (also node2).
const blockZero = '{"result":400,"response":"error","extra":"Block number not provided","require_reply":false}';
const envelope = JSON.stringify({ result: 200, response: {
  number: 1, status: 'confirmed', hash: 'b'.repeat(64), content: { previousHash: identity }, pad: '',
} });
function blockBytes(length) {
  return Buffer.from(envelope.replace('"pad":""', `"pad":"${'x'.repeat(length - Buffer.byteLength(envelope))}"`));
}
function reader(t, bytes, declaredLength = false) {
  const calls = [];
  t.after(() => assert.deepEqual(calls, [0, 1]));
  return createDemosChainReader({
    rpcUrl: 'https://rpc.invalid', network: 'test',
    fetchImpl: async (input, init) => {
      assert.equal(new URL(input).origin, 'https://rpc.invalid');
      const blockNumber = calls.length;
      assert.deepEqual(JSON.parse(init.body), {
        method: 'nodeCall', params: [{ message: 'getBlockByNumber', data: { blockNumber } }],
      });
      calls.push(blockNumber);
      return new Response(blockNumber === 0 ? blockZero : bytes, { headers: {
        'content-type': 'application/json',
        ...(declaredLength ? { 'content-length': String(blockNumber === 0 ? Buffer.byteLength(blockZero) : bytes.length) } : {}),
      } });
    },
  });
}

for (const length of [2 * 1024 * 1024 + 1, 2_100_036, RPC_LIMIT]) {
  test(`chain block-one fallback admits ${length} exact bytes within its 4 MiB budget`, async t => {
    const bytes = blockBytes(length);
    assert.equal(bytes.length, length);
    assert.deepEqual(await reader(t, bytes).networkIdentity(), { mode: 'public-chain-read', identity });
  });
}
for (const declared of [false, true]) {
  test(`chain block-one fallback refuses 4 MiB plus one byte (${declared ? 'declared' : 'streamed'})`, async t => {
    await assert.rejects(reader(t, blockBytes(RPC_LIMIT + 1), declared).networkIdentity(),
      error => error.kind === 'invalid' && /response exceeds byte limit/.test(error.message));
  });
}
for (const [suffix, code, stage] of [
  [',"result":200}', 'DUPLICATE-MEMBER', 'profile'],
  [',"rounded":9007199254740991.1}', 'NUMBER-OUTSIDE-DACS-MAGNITUDE', 'profile'],
  [',"unicode":"\\ud800"}', 'INVALID-UNICODE', 'profile'],
]) {
  test(`large fallback block still receives token admission: ${code}`, async t => {
    const bytes = Buffer.concat([blockBytes(2_100_036).subarray(0, -1), Buffer.from(suffix)]);
    await assert.rejects(reader(t, bytes).networkIdentity(),
      error => error.kind === 'invalid' && error.code === code && error.stage === stage);
  });
}
test('large fallback block still rejects invalid UTF-8 before parsing', async t => {
  const bytes = blockBytes(2_100_036);
  bytes[bytes.length - 4] = 0xff;
  await assert.rejects(reader(t, bytes).networkIdentity(),
    error => error.kind === 'invalid' && error.code === 'INVALID-UTF8' && error.stage === 'parse');
});
