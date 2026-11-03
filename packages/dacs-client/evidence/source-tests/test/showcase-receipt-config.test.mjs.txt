import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig, ConfigError } from '../src/config.mjs';
import { contractView, runtimeNames } from './helpers/env-contract-view.mjs';

test('switch default, strict off/on, env names, contract entry and example', () => {
  const base = { DACS_PUBLIC_ORIGIN: 'https://plugin.example', DACS_OAUTH_COOKIE_KEYS: 'TEST'.repeat(16) };
  assert.equal(loadConfig(base).showcaseReceipt, 'off');
  for (const value of ['off','on']) assert.equal(loadConfig({ ...base, DACS_SHOWCASE_RECEIPT: value }).showcaseReceipt, value);
  for (const value of ['', 'ON', 'true', '1', 0, false]) assert.throws(() => loadConfig({ ...base, DACS_SHOWCASE_RECEIPT: value }), ConfigError);
  const contract = contractView();
  assert.deepEqual(Object.keys(contract.variables).sort(), runtimeNames());
  assert.deepEqual(contract.variables.DACS_SHOWCASE_RECEIPT, { kind: 'enum', values: ['off','on'], default: 'off', deployValue: 'off', operator: true });
  assert.match(readFileSync(new URL('../deploy/dacs-chatgpt.env.example', import.meta.url), 'utf8'), /^DACS_SHOWCASE_RECEIPT=off$/m);
});
