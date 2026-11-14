// The messages a Demos transaction signature may cover: the bare hash, or the hash behind the
// domain prefix and the chain id the verifier is configured with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { privateKeyFromSeed, publicKeyFromSeed, sha256Hex } from '@kynesyslabs/dacs';
import { assertSignatureChainId, verifyTransactionSignature } from '../src/dacs/transaction-signature.mjs';

const seed = new Uint8Array(32).fill(7);
const address = `0x${publicKeyFromSeed(seed).export({ format: 'der', type: 'spki' }).subarray(12).toString('hex')}`;
const hash = sha256Hex('TEST transaction content');
const signOver = (message) => `0x${sign(null, Buffer.from(message, 'utf8'), privateKeyFromSeed(seed)).toString('hex')}`;
const verify = (message, signatureChainId) => verifyTransactionSignature({ address, hash, signature: signOver(message), signatureChainId });

test('a signature over the bare hash verifies with or without a chain id configured', () => {
  assert.equal(verify(hash), true);
  assert.equal(verify(hash, '7'), true);
});

test('a signature over the chain-bound form verifies only under the same configured chain id', () => {
  assert.equal(verify(`demos-tx:v1:7:${hash}`, '7'), true);
  assert.equal(verify(`demos-tx:v1:7:${hash}`, '8'), false);
  assert.equal(verify(`demos-tx:v1:7:${hash}`), false);
});

test('a signature over one form never verifies as the other', () => {
  const bound = `demos-tx:v1:7:${hash}`;
  assert.equal(verifyTransactionSignature({ address, hash: bound, signature: signOver(hash) }), false, 'a bare-hash signature is not a signature over the bound message');
  assert.equal(verifyTransactionSignature({ address, hash, signature: signOver(bound) }), false, 'a chain-bound signature is not a bare-hash signature');
});

test('any other message is refused', () => {
  for (const message of [`demos-tx:v2:7:${hash}`, `other:v1:7:${hash}`, `demos-tx:v1::${hash}`, `demos-tx:v1:07:${hash}`, `demos-tx:v1:7:${hash}\n`, ` demos-tx:v1:7:${hash}`, `demos-tx:v1:7:${hash.toUpperCase()}`]) {
    assert.equal(verify(message, '7'), false, message);
  }
});

test('a chain id that is not a canonical decimal string verifies nothing', () => {
  for (const bad of ['07', 'x7', '', 7, null]) assert.equal(verify(hash, bad), false, String(bad));
});

test('a hash that is not 64 lower-case hex digits is refused before any message is built', () => {
  for (const bad of ['', hash.toUpperCase(), hash.slice(1), `${hash}0`, 7, null]) {
    assert.equal(verifyTransactionSignature({ address, hash: bad, signature: signOver(String(bad)), signatureChainId: '7' }), false, String(bad));
  }
});

test('a signature chain id must be a canonical decimal string', () => {
  for (const good of [undefined, '0', '7', '1234567890123456789012']) assert.doesNotThrow(() => assertSignatureChainId(good), String(good));
  for (const bad of ['', '07', '-1', '7.0', 'x7', ' 7', '7 ', '7:', 7, 7n, null, {}]) assert.throws(() => assertSignatureChainId(bad), { name: 'TypeError', message: /signatureChainId/ }, String(bad));
});
