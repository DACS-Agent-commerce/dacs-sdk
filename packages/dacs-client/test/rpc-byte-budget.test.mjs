import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemosChainReader } from '../src/dacs/chain.mjs';

const RPC_LIMIT = 4 * 1024 * 1024;
const identity = 'a'.repeat(64);
const envelope = JSON.stringify({ result: 200, response: { number: 0, hash: identity, pad: '' } });
function blockBytes(length) {
  return Buffer.from(envelope.replace('"pad":""', `"pad":"${'x'.repeat(length - Buffer.byteLength(envelope))}"`));
}
function reader(bytes, declaredLength = false) {
  return createDemosChainReader({
    rpcUrl: 'https://rpc.invalid', network: 'test',
    fetchImpl: async (input, init) => {
      assert.equal(new URL(input).origin, 'https://rpc.invalid');
      assert.deepEqual(JSON.parse(init.body), {
        method: 'nodeCall', params: [{ message: 'getBlockByNumber', data: { blockNumber: 0 } }],
      });
      return new Response(bytes, { headers: {
        'content-type': 'application/json',
        ...(declaredLength ? { 'content-length': String(bytes.length) } : {}),
      } });
    },
  });
}

for (const length of [2 * 1024 * 1024 + 1, 2_100_036, RPC_LIMIT]) {
  test(`chain block read admits ${length} exact bytes within its 4 MiB budget`, async () => {
    const bytes = blockBytes(length);
    assert.equal(bytes.length, length);
    assert.deepEqual(await reader(bytes).networkIdentity(), { mode: 'public-chain-read', identity });
  });
}
for (const declared of [false, true]) {
  test(`chain block read refuses 4 MiB plus one byte (${declared ? 'declared' : 'streamed'})`, async () => {
    await assert.rejects(reader(blockBytes(RPC_LIMIT + 1), declared).networkIdentity(),
      error => error.kind === 'invalid' && /response exceeds byte limit/.test(error.message));
  });
}
for (const [suffix, code, stage] of [
  [',"result":200}', 'DUPLICATE-MEMBER', 'profile'],
  [',"rounded":9007199254740991.1}', 'NUMBER-OUTSIDE-DACS-MAGNITUDE', 'profile'],
  [',"unicode":"\\ud800"}', 'INVALID-UNICODE', 'profile'],
]) {
  test(`large chain block still receives token admission: ${code}`, async () => {
    const bytes = Buffer.concat([blockBytes(2_100_036).subarray(0, -1), Buffer.from(suffix)]);
    await assert.rejects(reader(bytes).networkIdentity(),
      error => error.kind === 'invalid' && error.code === code && error.stage === stage);
  });
}
test('large chain block still rejects invalid UTF-8 before parsing', async () => {
  const bytes = blockBytes(2_100_036);
  bytes[bytes.length - 4] = 0xff;
  await assert.rejects(reader(bytes).networkIdentity(),
    error => error.kind === 'invalid' && error.code === 'INVALID-UTF8' && error.stage === 'parse');
});
