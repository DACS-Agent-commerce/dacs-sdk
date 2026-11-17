// The old server auth is gone from the source and no test calls it. The tests that ran on the old path and still exist are listed in
// fixtures/context-wire-ports.json, each with one disposition: the wire test that asserts the same property (wire-equivalent), the store
// or coordinator test of what the wire uses (predecessor-equivalent), the wire's own behaviour where the old one went with the old path
// (retired), a buyer-side client test the client package owns (obsolete-client), or a property no wire test shows yet (gap). A test
// leaves the list when it is deleted, with its wire test or its reason named in the change that deletes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const testDirectory = fileURLToPath(new URL('.', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('./fixtures/context-wire-ports.json', import.meta.url), 'utf8'));
// Files whose every test is listed, also those that never reach the old path.
const COVERED_FILES = ['d5-limits-before-effects.test.mjs', 'd5-recovery.test.mjs', 'd5-challenge-retention.test.mjs'];
const DISPOSITIONS = ['wire-equivalent', 'predecessor-equivalent', 'retired', 'obsolete-client', 'gap'];
const NAME_A_REPLACEMENT = ['wire-equivalent', 'predecessor-equivalent'];
const NAME_NONE = ['obsolete-client', 'gap'];
const REMOVAL_OWNERS = ['P11c2ba', 'P12c'];
// A title as written in a string or template literal, for a test, a subtest, or a test declared in a `for` loop.
const TITLE = /^[ \t]*(?:for\s*\(.*?\)\s*)*(?:await t\.)?test\((['"`])((?:\\.|(?!\1).)*)\1/gm;
const SERVER_AUTH = /createSellerTransportServerAuth\(/;

const sourceOf = (file) => readFileSync(testDirectory + file, 'utf8');
/** Titles a file gives through a table: `test(name('ID'), ...)` where `const name = id => \`<prefix>${id} ${titles[id]}\``. */
const tableTitlesOf = (source) => {
  const maker = /^const (\w+) = id => `([^`$]*)\$\{id\} \$\{titles\[id\]\}`;$/m.exec(source);
  if (maker === null) return [];
  const [, name, prefix] = maker;
  return [...source.matchAll(new RegExp(`^[ \\t]*test\\(${name}\\('(\\w+)'\\)`, 'gm'))].map(([, id]) => {
    const entry = new RegExp(`^\\s*"${id}": "((?:\\\\.|[^"\\\\])*)",?$`, 'm').exec(source);
    return `${prefix}${id} ${JSON.parse(`"${entry[1]}"`)}`;
  });
};
/** The titles of the tests a file declares, as written in it. */
const titlesOf = (file) => {
  const source = sourceOf(file);
  return [...[...source.matchAll(TITLE)].map((match) => match[2].replaceAll("\\'", "'").replaceAll('\\"', '"')), ...tableTitlesOf(source)];
};
const keyOf = ({ file, title }) => `${file}\u0000${title}`;

test('every listed test exists and is listed once, with a disposition, an owner and a reason; covered files are listed whole', () => {
  const listed = manifest.map((entry) => keyOf(entry.legacy));
  assert.equal(new Set(listed).size, listed.length, 'each legacy test is listed once');
  const declared = new Set();
  for (const file of new Set(manifest.map((entry) => entry.legacy.file))) for (const title of titlesOf(file)) declared.add(keyOf({ file, title }));
  assert.deepEqual(listed.filter((key) => !declared.has(key)), [], 'the manifest names a test that does not exist');
  const whole = COVERED_FILES.flatMap((file) => titlesOf(file).map((title) => keyOf({ file, title })));
  assert.deepEqual(whole.filter((key) => !listed.includes(key)), [], 'a test of a covered file is missing from the manifest');
  for (const entry of manifest) {
    assert.ok(DISPOSITIONS.includes(entry.disposition) && REMOVAL_OWNERS.includes(entry.removalOwner) && entry.reason.length > 0, entry.legacy.title);
  }
});

test('every named replacement is a test that exists; an equivalent names one, and a gap or a client-only entry names none', () => {
  for (const entry of manifest) {
    if (NAME_NONE.includes(entry.disposition)) {
      assert.equal(entry.replacement, null, entry.legacy.title);
      continue;
    }
    if (entry.replacement === null) {
      assert.ok(!NAME_A_REPLACEMENT.includes(entry.disposition), `${entry.legacy.title}: an equivalent names its replacement`);
      continue;
    }
    assert.ok(titlesOf(entry.replacement.file).includes(entry.replacement.title), `${entry.legacy.title} -> ${entry.replacement.title}`);
    assert.notEqual(keyOf(entry.replacement), keyOf(entry.legacy), 'a test is not its own replacement');
  }
});

test('no seller test file calls the old server auth', () => {
  const calling = readdirSync(testDirectory).filter((file) => file.endsWith('.test.mjs') && SERVER_AUTH.test(sourceOf(file)));
  assert.deepEqual(calling, []);
});
