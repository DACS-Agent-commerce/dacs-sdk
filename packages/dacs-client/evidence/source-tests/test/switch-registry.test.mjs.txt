// Feature switch files (src/switches/, docs/SWITCHES.md): each file's contract
// entry matches what loadConfig does with it, malformed files are refused at
// load, the check order is fixed, and a new switch needs only a new file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConfigError, SWITCHES, loadConfig } from '../src/config.mjs';
import { envContract, readSwitchRegistry, switchContractEntry } from '../deploy/scripts/lib/rules.mjs';
import { contractView, runtimeNames } from './helpers/env-contract-view.mjs';

const base = { DACS_PUBLIC_ORIGIN: 'https://plugin.example', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(32) };
const SRC = new URL('../src/', import.meta.url);
// Only the switches that existed when the files were introduced are named
// here, so adding a switch never edits this test.
const ENUMS = ['DACS_SHOWCASE_RECEIPT', 'DACS_SELLER_WRITE_BATCHES', 'DACS_DELIVERY_DEADLINE_WATCH', 'DACS_SHOWCASE_WALKTHROUGH'];
const SEVEN = [...ENUMS, 'DACS_SHOWCASE_LEDGER', 'DACS_SHOWCASE_PUBLICATION_VIEW', 'DACS_WALLET_EXTENSION_PROBE'];
const among = (switches, names) => switches.map((s) => s.env).filter((env) => names.includes(env));

test('every switch file is in the contract view, and its entry matches its runtime parsing', () => {
  const contract = contractView();
  assert.deepEqual(Object.keys(contract.variables).sort(), runtimeNames());
  assert.ok(SWITCHES.length >= 7);
  for (const s of SWITCHES) {
    const entry = contract.variables[s.env];
    assert.deepEqual(entry, switchContractEntry(s), s.env);
    assert.equal(entry.operator, true, s.env);
    const parse = (value) => loadConfig({ ...base, [s.env]: value })[s.configKey];
    if (s.kind === 'flag') {
      assert.equal(loadConfig(base)[s.configKey], false, `${s.env} default`);
      for (const value of [undefined, '', '0', 'true', 'yes', '01', ' 1']) assert.equal(parse(value), false, `${s.env}=${value}`);
      if (Object.hasOwn(s.held, '1')) assert.throws(() => parse('1'), (e) => e instanceof ConfigError && e.message === s.held['1'], `${s.env}=1 held`);
      else assert.equal(parse('1'), true, `${s.env}=1`);
    } else {
      assert.equal(loadConfig(base)[s.configKey], entry.default, `${s.env} default`);
      for (const value of entry.values) {
        if (Object.hasOwn(s.held, value)) assert.throws(() => parse(value), (e) => e instanceof ConfigError && e.message === s.held[value], `${s.env}=${value} held`);
        else assert.equal(parse(value), value, `${s.env}=${value}`);
      }
      const invalid = `${s.env} must be ${entry.values.slice(0, -1).join(', ')} or ${entry.values.at(-1)}`;
      for (const value of ['', 'ON', 'bogus', ` ${entry.default}`]) assert.throws(() => parse(value), (e) => e instanceof ConfigError && e.message === invalid, `${s.env}=${JSON.stringify(value)}`);
    }
    // A declared deploy value is one the runtime accepts.
    if (entry.deployValue !== undefined) assert.doesNotThrow(() => parse(entry.deployValue), s.env);
  }
});

test('today\'s seven switches keep their exact contract entries and config keys', () => {
  const v = contractView().variables;
  const offOn = { kind: 'enum', values: ['off', 'on'], default: 'off', deployValue: 'off', operator: true };
  assert.deepEqual(v.DACS_SHOWCASE_RECEIPT, offOn);
  assert.deepEqual(v.DACS_DELIVERY_DEADLINE_WATCH, offOn);
  assert.deepEqual(v.DACS_SHOWCASE_WALKTHROUGH, offOn);
  assert.deepEqual(v.DACS_SELLER_WRITE_BATCHES, { ...offOn, note: 'on is refused by loadConfig (and createApp) pending native SDK preparation and batch transport integration', operator: true });
  assert.deepEqual(v.DACS_SHOWCASE_LEDGER, { kind: 'flag', default: '0', operator: true });
  assert.deepEqual(v.DACS_SHOWCASE_PUBLICATION_VIEW, { kind: 'flag', default: '0', operator: true });
  assert.deepEqual(v.DACS_WALLET_EXTENSION_PROBE, { kind: 'flag', default: '0', note: 'Owner-run portal discovery and sign-only probes; never enables extension purchases', operator: true });
  const keys = Object.fromEntries(SWITCHES.filter((s) => SEVEN.includes(s.env)).map((s) => [s.env, s.configKey]));
  assert.deepEqual(keys, {
    DACS_SHOWCASE_RECEIPT: 'showcaseReceipt', DACS_SELLER_WRITE_BATCHES: 'sellerWriteBatches', DACS_DELIVERY_DEADLINE_WATCH: 'deliveryDeadlineWatch',
    DACS_SHOWCASE_WALKTHROUGH: 'showcaseWalkthrough', DACS_SHOWCASE_LEDGER: 'showcaseLedger', DACS_SHOWCASE_PUBLICATION_VIEW: 'showcasePublicationView',
    DACS_WALLET_EXTENSION_PROBE: 'walletExtensionProbe',
  });
  assert.throws(() => loadConfig({ ...base, DACS_SELLER_WRITE_BATCHES: 'on' }), { message: 'DACS_SELLER_WRITE_BATCHES=on is held until native SDK preparation and batch transport integration are reviewed' });
});

test('switches are checked in a fixed order between the cookie keys and identity writes', () => {
  // The four enum checks keep the order they had in loadConfig; flags never throw.
  assert.deepEqual(among(SWITCHES, ENUMS), ENUMS);
  const firstUnordered = SWITCHES.findIndex((s) => s.order === undefined);
  assert.ok(firstUnordered === -1 || SWITCHES.slice(firstUnordered).every((s) => s.order === undefined), 'unordered switches come last');
  const first = (env) => { try { loadConfig({ ...base, ...env }); return null; } catch (e) { return e.message; } };
  const bad = { DACS_SHOWCASE_RECEIPT: 'x', DACS_SELLER_WRITE_BATCHES: 'on', DACS_DELIVERY_DEADLINE_WATCH: 'x', DACS_SHOWCASE_WALKTHROUGH: 'x', DACS_IDENTITY_WRITES: 'x' };
  assert.equal(first(bad), 'DACS_SHOWCASE_RECEIPT must be off or on');
  assert.match(first({ ...bad, DACS_SHOWCASE_RECEIPT: 'on' }), /^DACS_SELLER_WRITE_BATCHES=on is held/);
  assert.equal(first({ ...bad, DACS_SHOWCASE_RECEIPT: 'on', DACS_SELLER_WRITE_BATCHES: 'off' }), 'DACS_DELIVERY_DEADLINE_WATCH must be off or on');
  assert.equal(first({ ...bad, DACS_SHOWCASE_RECEIPT: 'on', DACS_SELLER_WRITE_BATCHES: 'off', DACS_DELIVERY_DEADLINE_WATCH: 'on' }), 'DACS_SHOWCASE_WALKTHROUGH must be off or on');
  assert.equal(first({ ...bad, DACS_SHOWCASE_RECEIPT: 'on', DACS_SELLER_WRITE_BATCHES: 'off', DACS_DELIVERY_DEADLINE_WATCH: 'on', DACS_SHOWCASE_WALKTHROUGH: 'on' }), 'DACS_IDENTITY_WRITES must be held or simulated-fixture-only');
  // Earlier checks still win over every switch.
  assert.match(first({ ...bad, DACS_OAUTH_COOKIE_KEYS: 'short' }), /at least 32 characters/);
  assert.equal(first({ ...bad, DACS_AUTH_MODE: 'other' }), 'DACS_AUTH_MODE must be builtin or external');
});

test('the two static settings among the switches keep their place, values and rule', () => {
  // docs/SWITCHES.md, "Static settings among the switches": where main checks them.
  const first = (env) => { try { loadConfig({ ...base, ...env }); return null; } catch (e) { return e.message; } };
  const commit = 'DACS_COMMIT_ON_SIGNATURE must be off or on', intent = 'DACS_INTENT_APPROVAL must be off or on';
  const pair = 'DACS_INTENT_APPROVAL=on and DACS_PORTAL_AUTO_ADVANCE=on cannot be enabled together; turn one of them off';
  assert.equal(first({ DACS_COMMIT_ON_SIGNATURE: 'x', DACS_PORTAL_AUTO_ADVANCE: 'x' }), 'DACS_PORTAL_AUTO_ADVANCE must be off or on');
  assert.equal(first({ DACS_COMMIT_ON_SIGNATURE: 'x', DACS_DELIVERY_DEADLINE_WATCH: 'x' }), commit);
  assert.equal(first({ DACS_INTENT_APPROVAL: 'x', DACS_SHOWCASE_WALKTHROUGH: 'x' }), 'DACS_SHOWCASE_WALKTHROUGH must be off or on');
  assert.equal(first({ DACS_INTENT_APPROVAL: 'x', DACS_COMMIT_ON_SIGNATURE: 'x' }), commit);
  assert.equal(first({ DACS_INTENT_APPROVAL: 'x', DACS_IDENTITY_WRITES: 'x' }), intent);
  assert.equal(first({ DACS_INTENT_APPROVAL: 'on', DACS_PORTAL_AUTO_ADVANCE: 'on', DACS_IDENTITY_WRITES: 'x' }), pair);
  assert.equal(first({ DACS_INTENT_APPROVAL: 'on', DACS_PORTAL_AUTO_ADVANCE: 'on', DACS_SHOWCASE_WALKTHROUGH: 'x' }), 'DACS_SHOWCASE_WALKTHROUGH must be off or on');
  assert.equal(first({ DACS_COMMIT_ON_SIGNATURE: 'x', DACS_OAUTH_COOKIE_KEYS: 'short' }), 'each DACS_OAUTH_COOKIE_KEYS entry must be at least 32 characters');
  // Values: commit is returned as a boolean, intent as its string.
  assert.deepEqual([loadConfig(base).commitOnSignature, loadConfig({ ...base, DACS_COMMIT_ON_SIGNATURE: 'off' }).commitOnSignature, loadConfig({ ...base, DACS_COMMIT_ON_SIGNATURE: 'on' }).commitOnSignature], [false, false, true]);
  assert.deepEqual([loadConfig(base).intentApproval, loadConfig({ ...base, DACS_INTENT_APPROVAL: 'on' }).intentApproval], ['off', 'on']);
  for (const value of ['', 'ON', '1']) assert.deepEqual([first({ DACS_COMMIT_ON_SIGNATURE: value }), first({ DACS_INTENT_APPROVAL: value })], [commit, intent]);
  // Neither is a switch file: both stay static env-contract.json entries.
  assert.deepEqual(SWITCHES.filter((s) => ['DACS_COMMIT_ON_SIGNATURE', 'DACS_INTENT_APPROVAL'].includes(s.env)), []);
});

// A private copy of config.mjs with its own switches/ directory.
function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'switch-registry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src'));
  cpSync(new URL('config.mjs', SRC), join(dir, 'src/config.mjs'));
  cpSync(new URL('switch-files.mjs', SRC), join(dir, 'src/switch-files.mjs'));
  cpSync(new URL('switches/', SRC), join(dir, 'src/switches'), { recursive: true });
  let n = 0;
  return {
    dir,
    write: (name, value) => writeFileSync(join(dir, 'src/switches', name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`),
    load: () => import(`${pathToFileURL(join(dir, 'src/config.mjs')).href}?v=${n++}`),
  };
}

test('a new switch is one new file: loadConfig, its check order and the contract view pick it up', async (t) => {
  const box = sandbox(t);
  box.write('DACS_ZZ_NEW_MODE.switch', { env: 'DACS_ZZ_NEW_MODE', configKey: 'zzNewMode', kind: 'enum', values: ['off', 'on', 'shadow'], default: 'off', deployValue: 'off', held: { shadow: 'DACS_ZZ_NEW_MODE=shadow is held' }, operatorNote: 'Fixture switch.' });
  box.write('DACS_AA_NEW_FLAG.switch', { env: 'DACS_AA_NEW_FLAG', configKey: 'aaNewFlag', kind: 'flag', default: '0', deployValue: '0', operatorNote: 'Fixture flag.' });
  const { loadConfig: load, SWITCHES: switches } = await box.load();
  // Files without an order come after the ordered ones, by env name.
  const unordered = switches.filter((s) => s.order === undefined).map((s) => s.env);
  assert.deepEqual(switches.slice(-unordered.length).map((s) => s.env), unordered);
  assert.deepEqual(unordered, [...unordered].sort());
  assert.equal(unordered[0], 'DACS_AA_NEW_FLAG'); assert.equal(unordered.at(-1), 'DACS_ZZ_NEW_MODE');
  const config = load(base);
  assert.equal(config.zzNewMode, 'off');
  assert.equal(config.aaNewFlag, false);
  assert.ok(Object.isFrozen(config));
  assert.equal(load({ ...base, DACS_AA_NEW_FLAG: '1', DACS_ZZ_NEW_MODE: 'on' }).zzNewMode, 'on');
  assert.throws(() => load({ ...base, DACS_ZZ_NEW_MODE: 'x' }), { message: 'DACS_ZZ_NEW_MODE must be off, on or shadow' });
  assert.throws(() => load({ ...base, DACS_ZZ_NEW_MODE: 'shadow' }), { message: 'DACS_ZZ_NEW_MODE=shadow is held' });
  // An unordered new switch never pre-empts an existing switch's error.
  assert.throws(() => load({ ...base, DACS_ZZ_NEW_MODE: 'x', DACS_SHOWCASE_WALKTHROUGH: 'x' }), { message: 'DACS_SHOWCASE_WALKTHROUGH must be off or on' });
  const view = envContract({ derivedFrom: {}, variables: {} }, box.dir).variables;
  assert.deepEqual(view.DACS_ZZ_NEW_MODE, { kind: 'enum', values: ['off', 'on', 'shadow'], default: 'off', deployValue: 'off', operator: true });
  assert.deepEqual(view.DACS_AA_NEW_FLAG, { kind: 'flag', default: '0', deployValue: '0', operator: true });
  // An order places a new switch between existing checks.
  box.write('DACS_ZZ_NEW_MODE.switch', { ...JSON.parse(readFileSync(join(box.dir, 'src/switches/DACS_ZZ_NEW_MODE.switch'), 'utf8')), order: 25 });
  const reordered = await box.load();
  assert.deepEqual(among(reordered.SWITCHES, [...ENUMS, 'DACS_ZZ_NEW_MODE']), ['DACS_SHOWCASE_RECEIPT', 'DACS_SELLER_WRITE_BATCHES', 'DACS_ZZ_NEW_MODE', 'DACS_DELIVERY_DEADLINE_WATCH', 'DACS_SHOWCASE_WALKTHROUGH']);
  assert.throws(() => reordered.loadConfig({ ...base, DACS_ZZ_NEW_MODE: 'x', DACS_DELIVERY_DEADLINE_WATCH: 'x' }), { message: 'DACS_ZZ_NEW_MODE must be off, on or shadow' });
});

test('malformed switch files are refused when config loads, naming the file', async (t) => {
  const good = { env: 'DACS_FIXTURE', configKey: 'fixture', kind: 'enum', values: ['off', 'on'], default: 'off', deployValue: 'off', operatorNote: 'Fixture.' };
  const cases = [
    ['not JSON', '{', /src\/switches\/DACS_FIXTURE\.switch: not valid JSON/],
    ['unknown field', { ...good, defualt: 'off' }, /unknown field defualt/],
    ['name mismatch', { ...good, env: 'DACS_OTHER' }, /equal to the file name/],
    ['bad config key', { ...good, configKey: 'Fixture-key' }, /configKey/],
    ['config key reused', { ...good, configKey: 'showcaseReceipt' }, /configKey showcaseReceipt is used by another switch/],
    ['no operator note', { ...good, operatorNote: '' }, /operatorNote is required/],
    ['bad kind', { ...good, kind: 'string' }, /kind must be enum or flag/],
    ['one value', { ...good, values: ['off'] }, /two or more distinct strings/],
    ['default not a value', { ...good, default: 'maybe' }, /default must be one of values/],
    ['default held', { ...good, held: { off: 'held' } }, /held values must be non-default values/],
    ['held not a value', { ...good, held: { maybe: 'held' } }, /held values must be non-default values/],
    ['held without message', { ...good, held: { on: '' } }, /held must map values to error messages/],
    ['deploy value held', { ...good, held: { on: 'held' }, deployValue: 'on' }, /deployValue must be null or an accepted value/],
    ['deploy value missing', (({ deployValue, ...rest }) => rest)(good), /deployValue must be null or an accepted value/],
    // An unlisted switch runs its default, so a set deploy value must be the default.
    ['deploy value not the default', { ...good, deployValue: 'on' }, /src\/switches\/DACS_FIXTURE\.switch: deployValue must equal default when it is set/],
    ['flag deploy value 1', { env: 'DACS_FIXTURE', configKey: 'fixture', kind: 'flag', default: '0', deployValue: '1', operatorNote: 'x' }, /deployValue must equal default when it is set/],
    ['flag with values', { ...good, kind: 'flag', default: '0', deployValue: null }, /a flag has no values/],
    ['flag default on', { env: 'DACS_FIXTURE', configKey: 'fixture', kind: 'flag', default: '1', deployValue: null, operatorNote: 'x' }, /a flag defaults to 0/],
    ['bad order', { ...good, order: '10' }, /order must be a number/],
    // JSON.parse keeps the last of two equal keys; the file is refused instead.
    ['duplicate key', '{"env":"DACS_FIXTURE","configKey":"fixture","kind":"enum","values":["off","on"],"default":"off","default":"on","deployValue":"off","operatorNote":"Fixture."}', /src\/switches\/DACS_FIXTURE\.switch: duplicate key "default"/],
    ['duplicate held key', '{"env":"DACS_FIXTURE","configKey":"fixture","kind":"enum","values":["off","on"],"default":"off","deployValue":"off","held":{"on":"a","on":"b"},"operatorNote":"Fixture."}', /duplicate key "on"/],
  ];
  for (const [label, content, message] of cases) {
    const box = sandbox(t);
    box.write('DACS_FIXTURE.switch', content);
    await assert.rejects(box.load(), message, label);
  }
  const misnamed = sandbox(t);
  misnamed.write('DACS_FIXTURE.json', good);
  await assert.rejects(misnamed.load(), /src\/switches\/DACS_FIXTURE\.json: not a \.switch file/);
  const dotfile = sandbox(t);
  dotfile.write('.DS_Store', 'x');
  await assert.doesNotReject(dotfile.load());
  // Only regular files: npm pack leaves a symbolic link out of the package.
  const linked = sandbox(t);
  writeFileSync(join(linked.dir, 'elsewhere.json'), JSON.stringify(good));
  symlinkSync(join(linked.dir, 'elsewhere.json'), join(linked.dir, 'src/switches/DACS_FIXTURE.switch'));
  await assert.rejects(linked.load(), { name: 'SwitchFileError', message: 'src/switches/DACS_FIXTURE.switch: must be a regular file, not a symbolic link' });
  const directory = sandbox(t);
  mkdirSync(join(directory.dir, 'src/switches/DACS_FIXTURE.switch'));
  await assert.rejects(directory.load(), { message: 'src/switches/DACS_FIXTURE.switch: must be a regular file' });
  // A missing or empty directory is an incomplete package, refused with a plain message.
  const missing = sandbox(t);
  rmSync(join(missing.dir, 'src/switches'), { recursive: true });
  await assert.rejects(missing.load(), { name: 'SwitchFileError', message: 'src/switches/: the directory is missing; the package is incomplete (every package ships its switch files)' });
  const empty = sandbox(t);
  rmSync(join(empty.dir, 'src/switches'), { recursive: true });
  mkdirSync(join(empty.dir, 'src/switches'));
  await assert.rejects(empty.load(), { message: 'src/switches/: has no switch files; the package is incomplete' });
  // A config key a static setting already uses is refused when loadConfig runs.
  const taken = sandbox(t);
  taken.write('DACS_FIXTURE.switch', { ...good, configKey: 'port' });
  const { loadConfig: load } = await taken.load();
  assert.throws(() => load(base), { name: 'SwitchFileError', message: 'src/switches/DACS_FIXTURE.switch: configKey port is already a loadConfig key' });
});

test('a flag may hold 1: exactly 1 is refused with its message, anything else is off', async (t) => {
  const box = sandbox(t);
  box.write('DACS_FIXTURE_FLAG.switch', { env: 'DACS_FIXTURE_FLAG', configKey: 'fixtureFlag', kind: 'flag', default: '0', deployValue: '0', held: { 1: 'DACS_FIXTURE_FLAG=1 is held' }, operatorNote: 'Fixture.' });
  const { ConfigError: Refused, loadConfig: load } = await box.load();
  assert.throws(() => load({ ...base, DACS_FIXTURE_FLAG: '1' }), (e) => e instanceof Refused && e.message === 'DACS_FIXTURE_FLAG=1 is held');
  for (const value of [undefined, '', '0', 'true']) assert.equal(load({ ...base, DACS_FIXTURE_FLAG: value }).fixtureFlag, false, String(value));
});

test('a switch file named like a static env-contract.json entry is refused by the contract view', (t) => {
  const box = sandbox(t);
  box.write('DACS_TRUST_PROXY.switch', { env: 'DACS_TRUST_PROXY', configKey: 'trustProxyShadow', kind: 'flag', default: '0', deployValue: null, operatorNote: 'Fixture shadow.' });
  const contract = JSON.parse(readFileSync(new URL('../deploy/env-contract.json', import.meta.url), 'utf8'));
  assert.throws(() => envContract(contract, box.dir), { message: 'src/switches/DACS_TRUST_PROXY.switch: DACS_TRUST_PROXY is also a static env-contract.json entry; a switch cannot replace it' });
});

test('switch file names never trip the wallet-material packaging rules', () => {
  // Both rules refuse wallet-named *.json paths; switch files are <env>.switch.
  const { entries, errors } = readSwitchRegistry(fileURLToPath(new URL('../', import.meta.url)));
  assert.deepEqual(errors, []);
  for (const name of Object.keys(entries)) {
    const path = `src/switches/${name}.switch`;
    assert.doesNotMatch(path, /wallet.*\.json/i, path);
  }
});
