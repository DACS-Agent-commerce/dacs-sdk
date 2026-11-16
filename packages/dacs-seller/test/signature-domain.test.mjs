// What a node's getNetworkInfo answer says about the message a transaction signature covers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoCallerSignatureDomain, signatureDomainFromNetworkInfo, transactionSignatureMessage } from '../src/dacs/signature-domain.mjs';

const HASH = 'a'.repeat(64);
const preFork = { activated: true };
const answer = (signatureDomain, chainId) => ({ forks: { osDenomination: preFork, ...(signatureDomain === undefined ? {} : { signatureDomain }) }, ...(chainId === undefined ? {} : { chainId }) });
const messageFor = (info) => transactionSignatureMessage(signatureDomainFromNetworkInfo(info), HASH);

test('a node answer without the signature-domain fork reads as the bare hash', () => {
  assert.equal(messageFor(answer(undefined)), HASH);
});

test('a node answer whose signature-domain fork is inactive reads as the bare hash, whatever chain id it carries', () => {
  assert.equal(messageFor(answer({ activated: false }, 7)), HASH);
  assert.equal(messageFor(answer({ activated: false }, null)), HASH);
});

test('an active signature-domain fork reads as the chain-bound message for a safe nonnegative chain id', () => {
  for (const chainId of [0, 7, Number.MAX_SAFE_INTEGER]) assert.equal(messageFor(answer({ activated: true }, chainId)), `demos-tx:v1:${chainId}:${HASH}`, String(chainId));
});

test('an answer that is unreadable or malformed yields no domain', () => {
  const unreadable = [undefined, null, 'forks', 7, [], {}, { forks: null }, { forks: [] }, { forks: {} }, { forks: { osDenomination: null } }, { forks: { osDenomination: {} } },
    { forks: { osDenomination: { activated: 'true' } } }, answer(null), answer('active'), answer([]), answer({}), answer({ activated: 'true' }, 7), answer({ activated: 1 }, 7)];
  for (const info of unreadable) assert.throws(() => signatureDomainFromNetworkInfo(info), { code: 'signature_domain_unreadable' }, JSON.stringify(info));
});

test('an active fork with a chain id that is not a safe nonnegative integer yields no domain', () => {
  for (const chainId of [undefined, null, -1, 1.5, NaN, Infinity, 2 ** 53, '7', 7n, [7], { value: 7 }]) {
    assert.throws(() => signatureDomainFromNetworkInfo(answer({ activated: true }, chainId)), { code: 'signature_domain_unreadable' }, String(chainId));
  }
});

test('a domain that was not read from a node answer gives no message', () => {
  for (const forged of [undefined, null, '7', 7, {}, { chainId: '7' }, { chainId: null }, { active: true, chainId: 7 }]) assert.equal(transactionSignatureMessage(forged, HASH), null, JSON.stringify(forged));
});

test('a hash that is not 64 lower-case hex digits gives no message', () => {
  const domain = signatureDomainFromNetworkInfo(answer({ activated: true }, 7));
  for (const bad of ['', HASH.toUpperCase(), HASH.slice(1), `${HASH}0`, `${HASH}\n`, 7, null, undefined]) assert.equal(transactionSignatureMessage(domain, bad), null, String(bad));
});

test('a caller-supplied signature chain id is refused', () => {
  assert.doesNotThrow(() => assertNoCallerSignatureDomain({}));
  assert.doesNotThrow(() => assertNoCallerSignatureDomain({ signatureChainId: undefined }));
  for (const value of ['7', 7, null, '']) assert.throws(() => assertNoCallerSignatureDomain({ signatureChainId: value }), { name: 'TypeError', message: /getNetworkInfo/ }, String(value));
});
