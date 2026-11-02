import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';

const env = { DACS_PUBLIC_ORIGIN: 'http://127.0.0.1:8787', DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_OAUTH_COOKIE_KEYS: 'a'.repeat(64), DACS_DATA_DIR: '.data' };

test('the nonce slot gate is off unless the deployment sets it to account', () => {
  assert.equal(loadConfig(env).nonceSlotProof, 'off');
  assert.equal(loadConfig({ ...env, DACS_NONCE_SLOT_PROOF: 'account' }).nonceSlotProof, 'account');
  assert.throws(() => loadConfig({ ...env, DACS_NONCE_SLOT_PROOF: 'on' }), /DACS_NONCE_SLOT_PROOF/);
});
