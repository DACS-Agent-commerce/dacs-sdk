import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CORE_FILES, isCorePath } from './delta-record.mjs';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreScripts = CORE_FILES.filter(path => path.endsWith('.mjs'));
// Bare specifiers a core script may load besides node: built-ins.
const LISTED_PACKAGES = ['typescript'];
// The runner starts every package test file; being run does not make a file core.
const RUNNER = 'every *.test.mjs file under scripts/ and test/';
// Each child Node process and computed import() in a core file, in source
// order, with the package files it runs.
const LAUNCHES = {
  'scripts/test.mjs': [RUNNER],
  'scripts/check-hold.test.mjs': ['scripts/check-hold.mjs'],
  'scripts/check-provenance.test.mjs': ['scripts/check-provenance.mjs', 'scripts/check-provenance.mjs', 'scripts/check-provenance.mjs', 'scripts/check-provenance.mjs', 'scripts/check-hold.mjs', 'scripts/check-provenance.mjs', 'scripts/import-cut-map.mjs'],
  'scripts/delta-assemble.test.mjs': ['scripts/delta-map.mjs'],
  'scripts/delta-continuity.test.mjs': ['scripts/delta-map.mjs', 'scripts/delta-map.mjs'],
  'scripts/delta-frontier.test.mjs': ['scripts/delta-map.mjs', 'scripts/check-provenance.mjs', 'scripts/check-provenance.mjs'],
  'scripts/delta-provenance.test.mjs': ['scripts/check-provenance.mjs', 'scripts/delta-map.mjs', 'scripts/delta-map.mjs', 'scripts/delta-map.mjs', 'scripts/delta-map.mjs', 'scripts/delta-map.mjs'],
  'scripts/test-layout.test.mjs': ['scripts/test.mjs', 'scripts/test.mjs'],
  'test/delta-ledger-gate.test.mjs': ['scripts/check-provenance.mjs', ['scripts/delta-provenance.test.mjs', 'scripts/delta-frontier.test.mjs', 'scripts/delta-continuity.test.mjs']],
};

// Source without whole-line and leading block comments, which may quote code.
const code = path => readFileSync(join(pkg, path), 'utf8').replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '');
const SPECIFIERS = [/\bfrom\s*(['"])([^'"\n]+)\1/g, /^\s*import\s*(['"])([^'"\n]+)\1/gm, /\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g, /\brequire\(\s*(['"])([^'"\n]+)\1\s*\)/g];
const specifiers = source => SPECIFIERS.flatMap(pattern => [...source.matchAll(pattern)].map(match => match[2]));
const LAUNCH = /process\.execPath|\bimport\((?!\s*['"])/g;

// Why `specifier`, loaded by the core file `path`, breaks the rule, or null.
function importRefusal(path, specifier) {
  if (specifier.startsWith('node:')) return null;
  if (!specifier.startsWith('.')) return LISTED_PACKAGES.includes(specifier.split('/')[0]) ? null : `${path} loads the unlisted package ${specifier}`;
  const target = posix.normalize(posix.join(posix.dirname(path), specifier));
  return isCorePath(target) ? null : `${path} loads ${target}, which is not core`;
}

test('every core file is in the package', () => {
  assert.deepEqual(CORE_FILES.filter(path => !existsSync(join(pkg, path))), []);
});

test('every module a core script loads is core, and every outside package it loads is listed', () => {
  assert.deepEqual(coreScripts.flatMap(path => specifiers(code(path)).map(specifier => importRefusal(path, specifier))).filter(Boolean), []);
  assert.equal(importRefusal('scripts/delta-map.mjs', './generate-payload-helpers.mjs'), 'scripts/delta-map.mjs loads scripts/generate-payload-helpers.mjs, which is not core');
  assert.equal(importRefusal('scripts/delta-map.mjs', '../src/index.mjs'), 'scripts/delta-map.mjs loads src/index.mjs, which is not core');
  assert.equal(importRefusal('scripts/delta-map.mjs', 'yaml'), 'scripts/delta-map.mjs loads the unlisted package yaml');
});

test('every child process and computed import in a core file is listed, and runs a core file', () => {
  const found = Object.fromEntries(coreScripts.map(path => [path, code(path).match(LAUNCH)?.length ?? 0]).filter(([, count]) => count > 0));
  assert.deepEqual(found, Object.fromEntries(Object.entries(LAUNCHES).map(([path, sites]) => [path, sites.length])));
  for (const [path, sites] of Object.entries(LAUNCHES)) for (const target of sites.flat()) {
    assert.ok(target === RUNNER ? path === 'scripts/test.mjs' : isCorePath(target), `${path} runs ${target}, which is not core`);
  }
  // A script named on the line that starts it is core as well.
  for (const path of coreScripts) for (const line of code(path).split('\n').filter(text => new RegExp(LAUNCH.source).test(text) || /\bnode\(/.test(text))) {
    for (const [script] of line.matchAll(/scripts\/[\w.-]+\.mjs/g)) assert.ok(isCorePath(script), `${path} runs ${script}, which is not core`);
  }
});

test('check-hold loads no package module before it has checked the package', () => {
  assert.deepEqual(specifiers(code('scripts/check-hold.mjs')).filter(specifier => !specifier.startsWith('node:')), []);
});
