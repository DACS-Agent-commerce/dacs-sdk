// Every static deploy/env-contract.json entry agrees with loadConfig: setting
// a variable to its contract default changes nothing against leaving it
// unset, another value does change the result (so the comparison can see
// it), every listed value is accepted and any other is refused. This is the
// drift check the removed digest of src/config.mjs gave reviewers. Switch
// entries come from the files loadConfig itself parses (switch-registry).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConfigError, loadConfig } from '../src/config.mjs';

const { variables } = JSON.parse(readFileSync(new URL('../deploy/env-contract.json', import.meta.url), 'utf8'));
const BASE = { DACS_PUBLIC_ORIGIN: 'https://plugin.example', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(32) };
const external = { DACS_AUTH_MODE: 'external', DACS_OAUTH_ISSUER: 'https://issuer.example' };
const directory = { DACS_DIRECTORY_ORIGIN: 'https://directory.example' };
const chain = { DACS_CHAIN_RPC_URL: 'https://rpc.example' };
// The settings a variable is read under, when it is not read by default.
const CONTEXT = {
  DACS_AUTH_MODE: { DACS_OAUTH_ISSUER: 'https://issuer.example' },
  DACS_OAUTH_SCOPE_CLAIM: external,
  DACS_OAUTH_REQUIRE_AT_JWT: external,
  DACS_DIRECTORY_TIMEOUT_MS: directory,
  DACS_DIRECTORY_MAX_BYTES: directory,
  DACS_CHAIN_NETWORK: chain,
  DACS_CHAIN_TIMEOUT_MS: chain,
  // on requires seller identities on (a cross-variable rule in loadConfig).
  DACS_IDENTITY_GITHUB_SIGNALS: { DACS_SELLER_IDENTITIES: 'on' },
};
// Values accepted only together with other settings.
const VALUE_CONTEXT = {
  'DACS_EMBEDDED_WALLET_WRITES=simulated-loopback': { DACS_CHAIN_RPC_URL: 'http://127.0.0.1:9', DACS_ALLOW_INSECURE_LOCALHOST: '1' },
  'DACS_EMBEDDED_WALLET_WRITES=testnet-held': { DACS_CHAIN_RPC_URL: 'https://rpc.example', DACS_CHAIN_NETWORK: 'demos-testnet' },
};

function otherValue(spec) {
  if (spec.values) return spec.values.find((v) => v !== spec.default);
  if (spec.kind === 'integer') return String(Number(spec.default) + 1);
  if (spec.kind === 'flag') return spec.default === '1' ? '0' : '1';
  if (spec.kind === 'list') return `${spec.default},https://other.example`;
  // A URL with a default (DACS_FUNDING_HELP_URL's empty one): suffixing it is no URL.
  if (spec.kind === 'url') return 'https://other.example/help';
  return `${spec.default}-other`;
}

test('static env contract defaults are what loadConfig uses when the variable is unset', () => {
  const withDefault = Object.entries(variables).filter(([, spec]) => spec.default !== undefined);
  assert.ok(withDefault.length >= 15);
  for (const [name, spec] of withDefault) {
    const context = { ...BASE, ...CONTEXT[name] };
    const unset = loadConfig(context);
    assert.deepEqual(loadConfig({ ...context, [name]: spec.default }), unset, `${name}: loadConfig's default is not the contract's ${spec.default}`);
    const other = otherValue(spec);
    assert.notDeepEqual(loadConfig({ ...context, ...VALUE_CONTEXT[`${name}=${other}`], [name]: other }), unset, `${name}=${other} changes nothing here; add the settings it is read under to CONTEXT`);
  }
});

test('static env contract values are exactly the values loadConfig accepts', () => {
  const enums = Object.entries(variables).filter(([, spec]) => spec.values);
  assert.ok(enums.length >= 4);
  for (const [name, spec] of enums) {
    const context = { ...BASE, ...CONTEXT[name] };
    for (const value of spec.values) assert.doesNotThrow(() => loadConfig({ ...context, ...VALUE_CONTEXT[`${name}=${value}`], [name]: value }), `${name}=${value}`);
    assert.throws(() => loadConfig({ ...context, [name]: 'not-a-listed-value' }), ConfigError, `${name} accepts a value the contract does not list`);
  }
});
