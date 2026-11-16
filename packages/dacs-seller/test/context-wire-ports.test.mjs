// The old server auth stays in the source until its own removal; no HTTP handler serves a request with it any more. An old-path test is one
// that runs on the old HTTP world (the directly composed context route) or calls the old auth's own checks.
// The manifest in fixtures/context-wire-ports.json gives each of them one disposition: the wire test that asserts the same property
// (wire-equivalent), the store or coordinator test of what the wire uses (predecessor-equivalent), the wire's own behaviour where the old
// one goes with the old path (retired), a buyer-side client test the client package owns (obsolete-client), or a property no wire test
// shows yet (gap). No test is dropped without its replacement or its reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const testDirectory = fileURLToPath(new URL('.', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('./fixtures/context-wire-ports.json', import.meta.url), 'utf8'));
// Files whose every test is listed, also those that never reach the old path.
const COVERED_FILES = ['d5-limits-before-effects.test.mjs', 'd5-recovery.test.mjs', 'd5-challenge-retention.test.mjs', 'seller-transport-auth.test.mjs'];
// Files that use the old auth only to make a signed request object for a store-level test: none of their tests is served by it.
const REQUEST_SETUP_ONLY = ['context-hold-startup.test.mjs', 'reservation-accounting.test.mjs', 'context-compensation.test.mjs', 'host-wire-state.test.mjs', 'transport-reconciliation.test.mjs', 'vet-orchestrator-route.test.mjs'];
const DISPOSITIONS = ['wire-equivalent', 'predecessor-equivalent', 'retired', 'obsolete-client', 'gap'];
const NAME_A_REPLACEMENT = ['wire-equivalent', 'predecessor-equivalent'];
const NAME_NONE = ['obsolete-client', 'gap'];
const REMOVAL_OWNERS = ['P11a2', 'P11c2ba', 'P12c'];
// A title as written in a string or template literal, for a test, a subtest, or a test declared in a `for` loop.
const TITLE = /^[ \t]*(?:for\s*\(.*?\)\s*)*(?:await t\.)?test\((['"`])((?:\\.|(?!\1).)*)\1/gm;
const SERVER_AUTH = /createSellerTransportServerAuth\(/;
const OLD_AUTH_CHECK = /\.(?:readRequest|validate|responseHeader|readbackOnly|assertLive)\(/;
// The HTTP world whose handler serves the directly composed context route with the old auth.
const OLD_WORLD = /^import \{[^}\n]*\bworld\b[^}\n]*\} from '\.\/helpers\/d5-http-fixture\.mjs'|\{ ?world: \w+[^}\n]*\} = await import\('\.\/helpers\/d5-http-fixture\.mjs'\)/m;

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
/** True when a test file composes the old path: the old HTTP world, or the old auth's own checks beside the old auth. */
const composesOldPath = (source) => OLD_WORLD.test(source) || (SERVER_AUTH.test(source) && OLD_AUTH_CHECK.test(source));
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

// Checked per file: which tests of a file reach the old path is read from a run, not from the source.
test('every seller test file that composes the old path has tests in the manifest, unless it uses the old auth only to make requests', () => {
  const listedFiles = new Set(manifest.map((entry) => entry.legacy.file));
  const composing = readdirSync(testDirectory).filter((file) => file.endsWith('.test.mjs') && composesOldPath(sourceOf(file)));
  assert.deepEqual(composing.filter((file) => !listedFiles.has(file) && !REQUEST_SETUP_ONLY.includes(file)), [], 'a file composes the old path and lists none of its tests');
  assert.deepEqual(REQUEST_SETUP_ONLY.filter((file) => !composing.includes(file) || listedFiles.has(file)), [], 'a request-setup file no longer uses the old auth, or has listed tests');
});
