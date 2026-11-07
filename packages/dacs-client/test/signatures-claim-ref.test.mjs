import assert from 'node:assert/strict';
import test from 'node:test';
import { WalletFormatError, addressForClaim } from '../src/signatures.mjs';

const KEY = 'ab'.repeat(32);

test('accepts the canonical claim', () => {
  assert.equal(addressForClaim(`did:demos:agent:${KEY}`), `0x${KEY}`);
});

test('accepts a differently-cased did scheme and returns the address', () => {
  assert.equal(addressForClaim(`DID:demos:agent:${KEY}`), `0x${KEY}`);
  assert.equal(addressForClaim(`Did:demos:agent:${KEY}`), `0x${KEY}`);
});

test('refuses an uppercase DEMOS method', () => {
  assert.throws(() => addressForClaim(`did:DEMOS:agent:${KEY}`), WalletFormatError);
  assert.throws(() => addressForClaim(`DID:DEMOS:agent:${KEY}`), WalletFormatError);
});

test('refuses an uppercase AGENT component', () => {
  assert.throws(() => addressForClaim(`did:demos:AGENT:${KEY}`), WalletFormatError);
  assert.throws(() => addressForClaim(`DID:demos:AGENT:${KEY}`), WalletFormatError);
});

test('refuses an uppercase key component', () => {
  assert.throws(() => addressForClaim(`did:demos:agent:${KEY.toUpperCase()}`), WalletFormatError);
  assert.throws(() => addressForClaim(`DID:demos:agent:${KEY.toUpperCase()}`), WalletFormatError);
});

test('refuses a key that is not 64 hex characters', () => {
  assert.throws(() => addressForClaim(`did:demos:agent:${KEY.slice(1)}`), WalletFormatError);
  assert.throws(() => addressForClaim(`did:demos:agent:${KEY}0`), WalletFormatError);
  assert.throws(() => addressForClaim(`did:demos:agent:${'g'.repeat(64)}`), WalletFormatError);
});
