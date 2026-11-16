// The old directly composed context route and its tests stay until the old auth is removed. The manifest in fixtures/context-wire-ports.json
// records, for each of those tests, which test covers the same subject over the wire (or why none is needed), so that no test is dropped
// without a passing replacement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const testDirectory = fileURLToPath(new URL('.', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('./fixtures/context-wire-ports.json', import.meta.url), 'utf8'));
const COVERED_FILES = ['d5-limits-before-effects.test.mjs', 'd5-recovery.test.mjs', 'd5-challenge-retention.test.mjs', 'seller-transport-auth.test.mjs'];
const DISPOSITIONS = ['wire-equivalent', 'predecessor-equivalent', 'obsolete-client'];
const REMOVAL_OWNERS = ['P11a2', 'P11c2ba', 'P12c'];
const TITLE = /^[ \t]*(?:await t\.)?test\((['"`])((?:\\.|(?!\1).)*)\1/gm;

/** The titles of the tests a file declares, as the test runner prints them. */
const titlesOf = (file) => [...readFileSync(testDirectory + file, 'utf8').matchAll(TITLE)].map((match) => match[2].replaceAll("\\'", "'").replaceAll('\\"', '"'));
const keyOf = ({ file, title }) => `${file}\u0000${title}`;

test('every old direct-context test is in the port manifest once, with a disposition, an owner and a reason', () => {
  const listed = manifest.map((entry) => keyOf(entry.legacy));
  assert.equal(new Set(listed).size, listed.length, 'each legacy test is listed once');
  const declared = COVERED_FILES.flatMap((file) => titlesOf(file).map((title) => keyOf({ file, title })));
  assert.deepEqual(declared.filter((key) => !listed.includes(key)), [], 'a test that exists is missing from the manifest');
  assert.deepEqual(listed.filter((key) => !declared.includes(key)), [], 'the manifest names a test that does not exist');
  for (const entry of manifest) {
    assert.ok(DISPOSITIONS.includes(entry.disposition) && REMOVAL_OWNERS.includes(entry.removalOwner) && entry.reason.length > 0, entry.legacy.title);
  }
});

test('every wire or predecessor replacement in the port manifest names a test that exists, and no client-only entry names one', () => {
  for (const entry of manifest) {
    if (entry.disposition === 'obsolete-client') {
      assert.equal(entry.replacement, null, entry.legacy.title);
      continue;
    }
    assert.ok(titlesOf(entry.replacement.file).includes(entry.replacement.title), `${entry.legacy.title} -> ${entry.replacement.title}`);
    assert.notEqual(keyOf(entry.replacement), keyOf(entry.legacy), 'a test is not its own replacement');
  }
});
