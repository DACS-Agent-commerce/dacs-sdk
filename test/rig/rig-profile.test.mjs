import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { RIG_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs/canonical';

const root = fileURLToPath(new URL('../../', import.meta.url));
const rewritingLoaders = [
  'packages/dacs-seller/test/helpers/kit-guard-fixture.mjs',
  'test/kit-client/test-loader.mjs',
].map(path => pathToFileURL(resolve(root, path)).href);
// Keep unrelated flags/preloads, including the host's sandbox preload. Preserve
// token quoting so paths with spaces retain the same NODE_OPTIONS meaning.
function cleanNodeOptions(options = '') {
  const tokens = options.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const decode = token => token.replace(/"([^"]*)"|'([^']*)'/g, (_, a, b) => a ?? b);
  const isRewriter = value => {
    try { return rewritingLoaders.includes(new URL(value, pathToFileURL(root)).href); }
    catch { return false; }
  };
  return tokens.filter((token, i) => {
    if (token === '--import' && isRewriter(decode(tokens[i + 1] ?? ''))) return false;
    if (tokens[i - 1] === '--import' && isRewriter(decode(token))) return false;
    return !(decode(token).startsWith('--import=') && isRewriter(decode(token).slice(9)));
  }).join(' ');
}
let temporary, first, second;
before(() => {
  mkdirSync(resolve(root, '.fix-tmp'), { recursive: true });
  temporary = mkdtempSync(resolve(root, '.fix-tmp/rig-profile-'));
  for (const copy of ['a', 'b']) {
    const dir = resolve(temporary, copy);
    const core = resolve(dir, 'node_modules/@kynesyslabs/dacs');
    mkdirSync(core, { recursive: true });
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: `rig-consumer-${copy}`, private: true, type: 'module' }));
    cpSync(resolve(root, 'dist'), resolve(core, 'dist'), { recursive: true });
    cpSync(resolve(root, 'package.json'), resolve(core, 'package.json'));
    for (const pkg of ['dacs-seller', 'dacs-client']) {
      const destination = resolve(dir, 'node_modules/@kynesyslabs', pkg);
      mkdirSync(destination, { recursive: true });
      cpSync(resolve(root, 'packages', pkg, 'src'), resolve(destination, 'src'), { recursive: true });
      cpSync(resolve(root, 'packages', pkg, 'package.json'), resolve(destination, 'package.json'));
    }
    cpSync(new URL('helpers/rig-profile-child.mjs', import.meta.url), resolve(dir, 'probe.mjs'));
    cpSync(new URL('helpers/rig-forgery.mjs', import.meta.url), resolve(dir, 'rig-forgery.mjs'));
    // Transpile only the shared test fixture; production modules stay built bytes.
    const fixture = readFileSync(resolve(root, 'test/wire/commitmentFixture.ts'), 'utf8')
      .replaceAll('../../src/wire/profile.js', '@kynesyslabs/dacs/wire')
      .replaceAll('../../src/index.js', '@kynesyslabs/dacs');
    writeFileSync(resolve(dir, 'commitment-fixture.mjs'), ts.transpileModule(fixture, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText);
    writeFileSync(resolve(dir, 'public.mjs'), `
      import * as wire from '@kynesyslabs/dacs/wire';
      export { wire };
      export * as sellerApi from '@kynesyslabs/dacs-seller';
      export * as clientApi from '@kynesyslabs/dacs-client';
      export { KIT_OPERATION_GUARD } from './node_modules/@kynesyslabs/dacs-seller/src/kit-operation-guard.mjs';
      export { PURCHASE_ADMISSION } from './node_modules/@kynesyslabs/dacs-client/src/dacs/purchase-admission-state.mjs';
    `);
  }
  first = resolve(temporary, 'a/probe.mjs');
  second = pathToFileURL(resolve(temporary, 'b/public.mjs')).href;
});
after(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

const cases = [
  ['defaults', 'C1: imports, misleading environment and ordinary factories stay closed'],
  ['runner-environment', 'C21: clean children strip both rewriters and preserve harmless preloads'],
  ['invalid', 'C2: exact owned input and invalid inputs never latch'],
  ['incomplete', 'C2: a test-built record without its image pin never latches'],
  ['digest', 'the frozen record recomputes to its compiled JCS digest'],
  ['forgery', 'every built rig export refuses to vouch for a payment commitment'],
  ['tp1-first', 'C3: successful TP-1 binding permanently excludes selection'],
  ['pending', 'C3: pending reservations exclude selection; failed reads release only their reservation'],
  ['pending-success', 'C3: selection loses to a pending TP-1 bind that succeeds'],
  ['tp1-cross', 'C5/C18: TP-1 refuses rig peer and purchase tuples'],
  ['closed-registry', 'C4/C10: unselected duplicate copies, forged records and sources fail closed'],
  ['selected', 'C2/C3/C21: selected rig excludes TP-1; immutable selection is single use'],
  ['duplicate', 'C4: selecting installed A leaves B unlatched; B rejects opaque A values'],
  ['identities', 'C5: exact allowlist refuses TP-1, fixtures, refused and 1,000 generated identities'],
  ['authority', 'C6/C10: registered source, exact connection, participants and fresh observations'],
  ['unregistered', 'C6/C21: lookalike rig observations never execute without membership'],
  ['kinds', 'C10: wrong capability kind and agreement-to-demo promotion refuse'],
  ['deadline', 'C6: timeout and late observations never produce a binding'],
  ['reset', 'C8: immutable run hash and continuation mismatch prevent signing after reset'],
];
for (const [name, description] of cases) test(`${name} — ${description}`, { timeout: 30000 }, () => {
  let options = process.env.NODE_OPTIONS;
  const env = { ...process.env, DACS_RIG_PROFILE: 'on', KIT_OPERATION_GUARD: 'testnet-tp1', PURCHASE_ADMISSION: 'testnet-tp1' };
  if (name === 'runner-environment') {
    const preload = resolve(temporary, 'harmless preload.mjs');
    writeFileSync(preload, 'globalThis.rigHarmlessPreload = process.env.RIG_PRELOAD_MARKER;');
    env.RIG_PRELOAD_MARKER = 'preserved';
    options = [options, `--import=${rewritingLoaders[0]}`, `--import "${fileURLToPath(rewritingLoaders[1])}"`,
      `--import="${pathToFileURL(preload).href}"`, '--no-warnings'].filter(Boolean).join(' ');
  }
  env.NODE_OPTIONS = cleanNodeOptions(options);
  let probe = first;
  if (name === 'incomplete') {
    const dir = resolve(temporary, 'incomplete');
    cpSync(resolve(temporary, 'a'), dir, { recursive: true });
    const incompleteRecord = structuredClone(RIG_IDENTITY_RECORD);
    incompleteRecord.deployment.artifactSha256 = null;
    const rig = resolve(dir, 'node_modules/@kynesyslabs/dacs/dist/wire/rig.js');
    const compiled = readFileSync(rig, 'utf8');
    const replaced = compiled.replace(/export const RIG_IDENTITY_RECORD = deepFreeze\([\s\S]*?\n\}\);/,
      `export const RIG_IDENTITY_RECORD = deepFreeze(${JSON.stringify(incompleteRecord)});`)
      .replace(/const RIG_RECORD_SHA256 = "[0-9a-f]{64}";/,
        `const RIG_RECORD_SHA256 = "${sha256Hex(canonicalize(incompleteRecord))}";`);
    assert.notEqual(replaced, compiled);
    writeFileSync(rig, replaced);
    probe = resolve(dir, 'probe.mjs');
  }
  const result = execFileSync(process.execPath, [probe, name, second], {
    cwd: root, env, timeout: 25000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.deepEqual(JSON.parse(result), { passed: name });
});
