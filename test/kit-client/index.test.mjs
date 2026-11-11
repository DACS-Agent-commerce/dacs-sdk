// The flip protocol's own check (K12 section 1): the index and the harness tests describe the same cases, and each flip names its PR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { CASE_IDS, indexProblems } from './index-rules.mjs';

const HARNESS_DIRECTORY = new URL('./', import.meta.url);
const TITLE = /^test\((['"])(K12-.+?)\1,/gm;
const CASE_ID = /^K12-(H\d[a-z]?(?:-(?:wire|host))?)(?:\([ivx]+\))?(?: \/ A37)? (today|target|control)(?: \([^)]*\))?:/;
const CASES_WITHOUT_SEPARATE_CONTROL = new Set(['H6b', 'H7']);

const index = JSON.parse(readFileSync(new URL('./harness-index.json', HARNESS_DIRECTORY), 'utf8'));
const harnessTitles = readdirSync(HARNESS_DIRECTORY).filter((name) => name.endsWith('.test.mjs'))
  .flatMap((name) => [...readFileSync(new URL(name, HARNESS_DIRECTORY), 'utf8').matchAll(TITLE)].map((match) => match[2]));
const parsed = harnessTitles.map((title) => { const match = CASE_ID.exec(title); return { title, id: match?.[1], kind: match?.[2] }; });
const count = (id, kind) => parsed.filter((entry) => entry.id === id && entry.kind === kind).length;

test('K12 index: every case id has exactly one harness test, every harness test is indexed, and every flip names its PR', () => {
  assert.deepEqual(indexProblems(index), []);
  assert.deepEqual(parsed.filter((entry) => entry.id === undefined).map((entry) => entry.title), [], 'every K12 test title names its case and kind');
  assert.equal(new Set(harnessTitles).size, harnessTitles.length, 'no test title repeats');
  const indexed = new Set(CASE_IDS.map((id) => id.replace(/^K12-/, '')));
  assert.deepEqual(parsed.filter((entry) => !indexed.has(entry.id)).map((entry) => entry.title), [], 'every harness test belongs to an indexed case');
  for (const entry of index) {
    const id = entry.id.replace(/^K12-/, '');
    const activeKind = entry.flippedBy === null ? 'today' : 'target';
    const activeTests = count(id, activeKind);
    assert.equal(activeTests, id === 'H3' ? 2 : 1, `${entry.id} has ${id === 'H3' ? 'one test per part' : 'exactly one test'} of its ${activeKind} behaviour`);
    assert.equal(count(id, activeKind === 'today' ? 'target' : 'today'), 0, `${entry.id} keeps no assertion of its ${activeKind === 'today' ? 'target' : 'today'} behaviour`);
    assert.equal(count(id, 'control'), CASES_WITHOUT_SEPARATE_CONTROL.has(id) ? 0 : activeTests, `${entry.id} has a positive control for each assertion`);
  }
});

test('split insertion preserves prior flips and attributes H7 current observations without a target flip', () => {
  const entry = (id, extra = {}) => ({ id, today: 'today', target: 'target', owner: 'P99', flippedBy: null, ...extra });
  const current = { step: 'plan', code: null, failureClass: 'SellerUnavailableError', layer: 'response-auth', counters: { context: 1 }, updatedBy: 'P06' };
  const withoutH7 = CASE_IDS.slice(0, -1);
  const flippedBefore = withoutH7.map((id) => entry(id, id === 'K12-H4-wire' ? { flippedBy: 'P99' } : {}));
  assert.deepEqual(indexProblems(flippedBefore, withoutH7), [], 'an index of the cases introduced so far, one already flipped, holds');
  assert.deepEqual(indexProblems([...flippedBefore, entry('K12-H7', { current })]), [], 'H7 inserted after a flip keeps the flip and records its observation, unflipped');
  assert.deepEqual(indexProblems([...flippedBefore, entry('K12-H7', { current: { ...current, updatedBy: 'P12b1' } })]), [], 'a later PR updates the observation without flipping');
  assert.match(indexProblems([...flippedBefore, entry('K12-H7', { current, flippedBy: 'P12b1' })]).join(), /K12-H7 is unflipped or flipped by its owner/, 'an update by another PR is not a flip');
  assert.match(indexProblems([...flippedBefore, entry('K12-H7')]).join(), /K12-H7 has no current observation/);
  assert.match(indexProblems([...flippedBefore, entry('K12-H7', { current: { ...current, counters: { context: -1 } } })]).join(), /non-negative integers/);
  assert.match(indexProblems([...flippedBefore, entry('K12-H7', { current: { ...current, failureClass: undefined } })]).join(), /error class of its failed context exchange/, 'an observation without its error class is refused');
  assert.match(indexProblems(flippedBefore).join(), /not exactly/, 'the full index requires every case');
});
