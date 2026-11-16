// The one message a Demos transaction signature may cover: the bare hash while the node's
// signature-domain fork is inactive, the chain-bound form once it is active.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { privateKeyFromSeed, publicKeyFromSeed, sha256Hex } from '@kynesyslabs/dacs';
import { verifyDemosSignature } from '../src/dacs/demos-claims.mjs';
import { signatureDomainFromNetworkInfo } from '../src/dacs/signature-domain.mjs';
import { verifyTransactionSignature } from '../src/dacs/transaction-signature.mjs';

const seed = new Uint8Array(32).fill(7);
const address = `0x${publicKeyFromSeed(seed).export({ format: 'der', type: 'spki' }).subarray(12).toString('hex')}`;
const hash = sha256Hex('TEST transaction content');
const signOver = (message) => `0x${sign(null, Buffer.from(message, 'utf8'), privateKeyFromSeed(seed)).toString('hex')}`;
const networkInfo = (signatureDomain, chainId) => ({ forks: { osDenomination: { activated: true }, ...(signatureDomain ? { signatureDomain } : {}) }, chainId });
const inactive = signatureDomainFromNetworkInfo(networkInfo({ activated: false }, 7));
const active = signatureDomainFromNetworkInfo(networkInfo({ activated: true }, 7));
const verify = (domain, message, signedHash = hash) => verifyTransactionSignature({ address, hash: signedHash, signature: signOver(message), domain });

test('while the fork is inactive only a signature over the bare hash verifies', () => {
  assert.equal(verify(inactive, hash), true);
  assert.equal(verify(inactive, `demos-tx:v1:7:${hash}`), false);
});

test('once the fork is active only a signature over the chain-bound message verifies', () => {
  assert.equal(verify(active, `demos-tx:v1:7:${hash}`), true);
  assert.equal(verify(active, hash), false);
});

test('a chain-bound signature for another chain id does not verify', () => {
  assert.equal(verify(active, `demos-tx:v1:8:${hash}`), false);
  assert.equal(verify(active, `demos-tx:v1:07:${hash}`), false);
});

test('any other message is refused under either domain', () => {
  for (const message of [`demos-tx:v2:7:${hash}`, `other:v1:7:${hash}`, `demos-tx:v1::${hash}`, `demos-tx:v1:7:${hash}\n`, ` demos-tx:v1:7:${hash}`, `demos-tx:v1:7:${hash.toUpperCase()}`, `demos-tx:v1:7:7:${hash}`]) {
    assert.equal(verify(active, message), false, message);
    assert.equal(verify(inactive, message), false, message);
  }
});

test('a signature never verifies without a domain read from a node answer', () => {
  for (const domain of [undefined, null, '7', 7, {}, { chainId: '7' }, { chainId: null }]) {
    assert.equal(verify(domain, hash), false, `bare hash with ${JSON.stringify(domain)}`);
    assert.equal(verify(domain, `demos-tx:v1:7:${hash}`), false, `chain-bound with ${JSON.stringify(domain)}`);
  }
  assert.equal(verifyTransactionSignature({ address, hash, signature: signOver(hash), signatureChainId: '7' }), false, 'a caller-supplied chain id is not a domain');
});

test('a hash that is not 64 lower-case hex digits is refused before any message is built', () => {
  for (const bad of ['', hash.toUpperCase(), hash.slice(1), `${hash}0`, 7, null]) assert.equal(verify(inactive, String(bad), bad), false, String(bad));
});

test('raw message verification covers exactly the signed bytes, with no network domain applied', () => {
  for (const message of ['login:TEST challenge', 'identity:TEST claim', `dacs-commitment:v1:${hash}`, hash, `demos-tx:v1:7:${hash}`]) {
    assert.equal(verifyDemosSignature({ address, message, signature: signOver(message) }), true, message);
    assert.equal(verifyDemosSignature({ address, message: `${message} `, signature: signOver(message) }), false, message);
  }
});
