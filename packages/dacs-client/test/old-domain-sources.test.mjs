import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOADING_MODULES, entryPointClosure, packageDir } from './helpers/entry-point-closure.mjs';

const OLD_TRANSPORT_DOMAINS = [
  'dacs-chatgpt-plugin:loopback-seller-peer:v1:',
  'dacs-chatgpt-plugin:seller-session-delegation:v1:',
];
// Browser copies that are never packed. They keep their old domain until the browser code is replaced.
const UNPACKED_BROWSER_COPIES = [
  'src/public/portal/seller-session-delegation.mjs',
  'src/public/portal-intent/intent.mjs',
];
// Colon-form labels that are not transport domains: the session nonce seed and the delivery schema URN.
const OTHER_COLON_LABELS = [
  'dacs-chatgpt-plugin:${sessionSeed}:${claim}:${presentedAt}',
  'dacs-chatgpt-plugin:v0.1:seller-defined-delivery',
];
const COLON_LABEL = /dacs-chatgpt-plugin:[^'"`\s]*/g;

const read = path => readFileSync(join(packageDir, path), 'utf8');
const sourceFiles = () => readdirSync(join(packageDir, 'src'), { recursive: true })
  .filter(path => path.endsWith('.mjs')).map(path => `src/${path}`).sort();

test('no shipped client file contains a D6 old domain and labels outside D6 are unchanged', () => {
  const closure = entryPointClosure();
  for (const path of UNPACKED_BROWSER_COPIES) assert.ok(!closure.includes(path), `${path} must stay outside the packed closure`);
  const shipped = [...closure, ...LOADING_MODULES];
  for (const path of sourceFiles().filter(file => !UNPACKED_BROWSER_COPIES.includes(file))) {
    for (const domain of OLD_TRANSPORT_DOMAINS) assert.ok(!read(path).includes(domain), `${path} carries ${domain}`);
  }
  const labels = new Set(shipped.flatMap(path => read(path).match(COLON_LABEL) ?? []));
  assert.deepEqual([...labels].sort(), [...OTHER_COLON_LABELS].sort());
});
