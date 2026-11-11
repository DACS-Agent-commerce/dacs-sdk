import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// The package does not ship src/switches/, and config.mjs refuses to load without a switch file. So the config is
// loaded from a scratch copy of the files it imports, next to a switch directory holding one unrelated switch.
const SCRATCH_SWITCH = { env: 'DACS_SCRATCH_SWITCH', configKey: 'scratchSwitch', kind: 'enum', values: ['off', 'on'], default: 'off', deployValue: 'off', operatorNote: 'An unrelated switch that only lets the config load.' };
const sourceText = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

async function loadConfigModuleWithScratchSwitch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nonce-slot-proof-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'switches'));
  writeFileSync(join(dir, 'switches', `${SCRATCH_SWITCH.env}.switch`), JSON.stringify(SCRATCH_SWITCH));
  for (const file of ['purchase-limits.mjs', 'switch-files.mjs']) writeFileSync(join(dir, file), sourceText(file));
  writeFileSync(join(dir, 'config.mjs'), sourceText('config.mjs'));
  return import(pathToFileURL(join(dir, 'config.mjs')).href);
}

const env = { DACS_PUBLIC_ORIGIN: 'http://127.0.0.1:8787', DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_OAUTH_COOKIE_KEYS: 'a'.repeat(64), DACS_DATA_DIR: '.data' };

test('the nonce slot gate is off unless the deployment sets it to account', async (t) => {
  const { loadConfig } = await loadConfigModuleWithScratchSwitch(t);
  assert.equal(loadConfig(env).nonceSlotProof, 'off');
  assert.equal(loadConfig({ ...env, DACS_NONCE_SLOT_PROOF: 'account' }).nonceSlotProof, 'account');
  assert.throws(() => loadConfig({ ...env, DACS_NONCE_SLOT_PROOF: 'on' }), /DACS_NONCE_SLOT_PROOF/);
});

test('loadConfig falls back to the default purchase limits when no limit is set', async (t) => {
  const { loadConfig } = await loadConfigModuleWithScratchSwitch(t);
  const defaults = (await import('../src/purchase-limits.mjs')).PURCHASE_LIMITS;
  assert.deepEqual(loadConfig(env).purchaseLimits, defaults);
});

test('loadConfig reads purchase limits from the environment', async (t) => {
  const { loadConfig } = await loadConfigModuleWithScratchSwitch(t);
  const limits = loadConfig({ ...env, DACS_MAX_UNPAID_PURCHASES_PER_ACCOUNT: '3', DACS_MAX_UNPAID_PURCHASES_PER_WALLET: '4', DACS_MAX_PURCHASE_STARTS_PER_ACCOUNT_PER_HOUR: '7' }).purchaseLimits;
  assert.deepEqual({ ...limits }, { maxUnpaidPerAccount: 3, maxUnpaidPerWallet: 4, maxStartsPerHour: 7 });
});

test('config.mjs still exports PURCHASE_LIMITS', async (t) => {
  const { PURCHASE_LIMITS } = await loadConfigModuleWithScratchSwitch(t);
  assert.deepEqual(PURCHASE_LIMITS, (await import('../src/purchase-limits.mjs')).PURCHASE_LIMITS);
});
