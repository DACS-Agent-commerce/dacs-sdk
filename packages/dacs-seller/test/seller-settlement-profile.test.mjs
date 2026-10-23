import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as core from '@kynesyslabs/dacs';
import { railAuthorityConfig } from '../src/dacs/rail-authority.mjs';
import { railSteward } from './helpers/rail-authority-fixture.mjs';
function key() {
  const pair = generateKeyPairSync('ed25519'), raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return { privateKey: pair.privateKey, address: `0x${raw.toString('hex')}`, claim: `did:demos:agent:${raw.toString('hex')}`,
    sign: (bytes) => sign(null, Buffer.from(bytes), pair.privateKey),
    signWallet: (message) => `0x${sign(null, Buffer.from(message, 'utf8'), pair.privateKey).toString('hex')}` };
}
test('rail key history authenticates only in-flight pins, including legacy pins, and never trusts a saved key or altered definition', () => {
  const previous = railSteward(), current = railSteward(), stranger = railSteward();
  const old = railAuthorityConfig(previous.railAuthority());
  const pin = old.pin();
  const config = { ...current.railAuthority(), historicalStewards: [{ stewardClaim: previous.stewardClaim, stewardPublicKey: previous.stewardPublicKey }] };
  const rotated = railAuthorityConfig(config);
  config.historicalStewards[0].stewardPublicKey = stranger.stewardPublicKey;
  assert.equal(rotated.evaluate(pin, 'in-flight').decision, 'pass');
  const legacy = structuredClone(pin); delete legacy.stewardClaim; delete legacy.stewardPublicKey;
  assert.equal(rotated.evaluate(legacy, 'in-flight').decision, 'pass');
  assert.equal(rotated.evaluate(pin, 'new').decision, 'fail');
  assert.equal(rotated.evaluate(rotated.pin(), 'new').decision, 'pass');
  assert.equal(railAuthorityConfig(current.railAuthority()).evaluate(pin, 'in-flight').decision, 'fail');
  assert.equal(rotated.evaluate(railAuthorityConfig(stranger.railAuthority()).pin(), 'in-flight').decision, 'fail');
  assert.equal(rotated.evaluate({ ...pin, stewardClaim: current.stewardClaim }, 'in-flight').decision, 'fail');
  assert.equal(rotated.evaluate({ ...pin, stewardPublicKey: stranger.stewardPublicKey }, 'in-flight').decision, 'fail');
  const sameClaim = current.railAuthority({ authority: { stewardClaim: previous.stewardClaim } });
  sameClaim.rail.signature.signer = previous.stewardClaim;
  const sameIdentity = railAuthorityConfig({ ...sameClaim, historicalStewards: [{ stewardClaim: previous.stewardClaim, stewardPublicKey: previous.stewardPublicKey }] });
  assert.equal(sameIdentity.evaluate(pin, 'in-flight').decision, 'pass', 'same claim with a new key');
  assert.equal(sameIdentity.evaluate(legacy, 'in-flight').decision, 'pass', 'legacy pin under a rotated stable identity');
  assert.equal(sameIdentity.evaluate(pin, 'new').decision, 'fail');
  assert.equal(sameIdentity.evaluate(sameIdentity.pin(), 'new').decision, 'pass');
  const altered = structuredClone(pin); altered.rail.parameters = { changed: true };
  assert.equal(rotated.evaluate(altered, 'in-flight').decision, 'fail');
  assert.throws(() => railAuthorityConfig({ ...current.railAuthority(), historicalStewards: {} }), /must be an array/);
  const many = Array.from({ length: 65 }, () => railSteward());
  const completeHistory = railAuthorityConfig({ ...current.railAuthority(), historicalStewards: many.map(({ stewardClaim, stewardPublicKey }) => ({ stewardClaim, stewardPublicKey })) });
  for (const identity of [many[0], many[64]]) assert.equal(completeHistory.evaluate(railAuthorityConfig(identity.railAuthority()).pin(), 'in-flight').decision, 'pass', 'every configured historical identity remains authorized');
});


test('steward history rejects malformed identities at configuration and retains valid old keys', () => {
  const previous = railSteward(), current = railSteward();
  const entry = { stewardClaim: previous.stewardClaim, stewardPublicKey: previous.stewardPublicKey };
  for (const changed of [{ stewardPublicKey: entry.stewardPublicKey + '=' }, { stewardClaim: 'not a claim' }, { stewardPublicKey: Buffer.alloc(31).toString('base64url') }]) {
    assert.throws(() => railAuthorityConfig({ ...current.railAuthority(), historicalStewards: [{ ...entry, ...changed }, entry] }), /historicalStewards/);
  }
  const retained = railAuthorityConfig(previous.railAuthority()).pin();
  delete retained.stewardClaim; delete retained.stewardPublicKey;
  assert.equal(railAuthorityConfig({ ...current.railAuthority(), historicalStewards: [entry] }).evaluate(retained, 'in-flight').decision, 'pass');
});

