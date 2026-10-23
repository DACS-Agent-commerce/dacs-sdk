import { deriveStorageAddress } from '../src/dacs/wallet-transactions.mjs';
// The claim, address and wallet-signature contract the ported seller kit relies on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { addressForClaim, claimForAddress, decodeSignature, normalizeDemosAddress, verifyDemosSignature, DemosClaimFormatError } from '../src/dacs/demos-claims.mjs';

const keyHex = () => randomBytes(32).toString('hex');

test('addresses read case-insensitively with one 0x prefix and are written lower-case', () => {
  const hex = keyHex();
  for (const value of [`0x${hex}`, `0X${hex.toUpperCase()}`, hex, `  0x${hex}\n`]) assert.equal(normalizeDemosAddress(value), `0x${hex}`);
  for (const value of [`0x0x${hex}`, `0x${hex.slice(1)}`, `0x${hex}0`, `0x${hex.slice(1)}g`, '', 42, null]) assert.throws(() => normalizeDemosAddress(value), DemosClaimFormatError);
});

test('claims and addresses convert both ways; claim key digits must be lower-case', () => {
  const hex = keyHex(), claim = `did:demos:agent:${hex}`;
  assert.equal(claimForAddress(`0X${hex.toUpperCase()}`), claim);
  assert.equal(addressForClaim(claim), `0x${hex}`);
  assert.equal(addressForClaim(`DID:demos:agent:${hex}`), `0x${hex}`, 'the did scheme is matched without case');
  for (const value of [`DID:Demos:Agent:${hex}`, `did:DEMOS:AGENT:${hex}`, `did:demos:Agent:${hex}`, `did:demos:agent:${hex.toUpperCase()}`, `did:demos:agent:0x${hex}`, `did:demos:agent:${hex}0`, `did:demos:other:${hex}`, `${claim}\n`, undefined, {}]) {
    assert.throws(() => addressForClaim(value), DemosClaimFormatError);
  }
});

test('signatures decode from canonical base64url first, then from hex or base64url behind 0x prefixes', () => {
  const bytes = randomBytes(64), base64url = bytes.toString('base64url'), hex = bytes.toString('hex');
  for (const value of [base64url, ` ${base64url} `, hex, `0x${hex}`, `0x0x${hex}`, `0X${hex.toUpperCase()}`, `0x${base64url}`]) assert.deepEqual(decodeSignature(value), bytes);
  // A genuine base64url signature may begin with "0x"; it is not stripped.
  const leading = Buffer.from(bytes); leading[0] = 0xd3; leading[1] = (leading[1] & 0x0f) | 0x10;
  assert.ok(leading.toString('base64url').startsWith('0x'));
  assert.deepEqual(decodeSignature(leading.toString('base64url')), leading);
  // A non-canonical final base64url character still names the same 64 bytes.
  const last = base64url.at(-1), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const loose = base64url.slice(0, -1) + alphabet[alphabet.indexOf(last) | 1];
  if (loose !== base64url) assert.deepEqual(decodeSignature(loose), bytes);
  for (const value of [hex.slice(2), `${hex}00`, base64url.slice(1), `${base64url}A`, 'not a signature', 7, null]) assert.throws(() => decodeSignature(value), DemosClaimFormatError);
});

test('a wallet signature verifies over the exact UTF-8 message; anything else is false, never a throw', () => {
  const pair = generateKeyPairSync('ed25519'), address = `0x${pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex')}`;
  const message = 'dacs-bundle-presentation:v1:é', signature = `0x${sign(null, Buffer.from(message, 'utf8'), pair.privateKey).toString('hex')}`;
  assert.equal(verifyDemosSignature({ address, message, signature }), true);
  assert.equal(verifyDemosSignature({ address: address.toUpperCase().replace('0X', '0x'), message, signature: Buffer.from(signature.slice(2), 'hex').toString('base64url') }), true);
  const other = `0x${keyHex()}`;
  for (const input of [{ address, message: `${message} `, signature }, { address: other, message, signature }, { address, message, signature: 'bad' }, { address: 'bad', message, signature }, { address, message: undefined, signature }, {}]) {
    assert.equal(verifyDemosSignature(input), false);
  }
});


test('storage addresses hash the exact owner bytes, including case, as demosdk does', () => {
  assert.equal(deriveStorageAddress('0xABCDEF', 'probe', 1, ''), 'stor-26913fea878a28f7ca48cbccd148baa6db47a6f4');
  assert.equal(deriveStorageAddress('0xabcdef', 'probe', 1, ''), 'stor-b52de5b1050c95ef271b53a0d40b5be43717d48c');
});
