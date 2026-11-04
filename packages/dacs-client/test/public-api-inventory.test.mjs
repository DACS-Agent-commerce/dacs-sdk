// K6's export map against the plugin import inventory (test/fixtures/plugin-import-inventory.json).
// The fixture holds names, dispositions and owners only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installPackedPair } from './helpers/packed-install.mjs';

const INVENTORY_URL = new URL('./fixtures/plugin-import-inventory.json', import.meta.url);
const inventory = JSON.parse(readFileSync(INVENTORY_URL, 'utf8'));
const DISPOSITIONS = ['client-root', 'client-journal', 'p52b-export', 'p21a-export', 'refused', 'plugin-side', 'replaced'];
const EXPORTED = ['client-root', 'client-journal', 'p52b-export'];
const NOT_EXPORTED = ['p21a-export', 'refused', 'plugin-side', 'replaced'];
const ENTRIES = ['root', 'wallet/durable-journal'];
const named = (dispositions) => inventory.filter(({ disposition }) => dispositions.includes(disposition)).map(({ name }) => name);

test('every name the carried http-mcp modules and the stdio buyer import from excluded paths has one recorded disposition and owner', () => {
  assert.ok(inventory.length > 0);
  assert.equal(new Set(inventory.map(({ name }) => name)).size, inventory.length, 'each name has one row');
  for (const row of inventory) {
    assert.deepEqual(Object.keys(row).sort(), ['disposition', 'entry', 'name', 'owner'], `${row.name} holds names only`);
    assert.ok(DISPOSITIONS.includes(row.disposition), `${row.name}: ${row.disposition}`);
    assert.ok(typeof row.owner === 'string' && row.owner.length > 0, `${row.name} has an owner`);
    assert.equal(EXPORTED.includes(row.disposition) ? ENTRIES.includes(row.entry) : row.entry === null, true, `${row.name} entry matches its disposition`);
  }
});

test('every name the inventory marks exported resolves from the packed archive installed in an empty directory with better-sqlite3 absent (K6-W14)', (t) => {
  const { app, run } = installPackedPair(t);
  const exported = Object.fromEntries(ENTRIES.map((entry) => [entry, inventory.filter((row) => EXPORTED.includes(row.disposition) && row.entry === entry).map(({ name }) => name)]));
  writeFileSync(join(app, 'inventory.json'), JSON.stringify({ exported, withheld: named(NOT_EXPORTED) }));
  writeFileSync(join(app, 'resolve.mjs'), `
    import assert from 'node:assert/strict';
    import { existsSync, readFileSync } from 'node:fs';
    assert.equal(existsSync(new URL('./node_modules/better-sqlite3', import.meta.url)), false, 'better-sqlite3 is absent');
    const { exported, withheld } = JSON.parse(readFileSync(new URL('./inventory.json', import.meta.url), 'utf8'));
    const root = await import('@kynesyslabs/dacs-client');
    const journal = await import('@kynesyslabs/dacs-client/wallet/durable-journal');
    for (const name of exported.root) assert.notEqual(root[name], undefined, name);
    for (const name of exported['wallet/durable-journal']) assert.notEqual(journal[name], undefined, name);
    for (const name of withheld) assert.equal(root[name], undefined, name + ' stays outside the root');
  `);
  run(process.execPath, ['resolve.mjs'], app);
  assert.equal(existsSync(join(app, 'node_modules/better-sqlite3')), false);
});

test('no fixture identity, fixture anchor, simulation header or unqualified reader is exported', async () => {
  const client = await import('@kynesyslabs/dacs-client');
  const journal = await import('@kynesyslabs/dacs-client/wallet/durable-journal');
  const exportedNames = [...Object.keys(client), ...Object.keys(journal)];
  for (const name of named(NOT_EXPORTED)) assert.equal(exportedNames.includes(name), false, name);
  for (const name of exportedNames) assert.doesNotMatch(name, /fixture|simulat/i, name);
});
