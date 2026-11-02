// Packs the core and client archives and installs them offline in an empty app
// directory (no registry, no source-tree import). DC-CW11: `switchedCopy` makes
// the one-line diff P35 will make, in a temporary copy that is never committed.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

export const packageDir = fileURLToPath(new URL('../..', import.meta.url));
export const sdkDir = resolve(packageDir, '../..');
const STATE_MODULE = 'src/dacs/purchase-admission-state.mjs';

/** A temporary copy of the client package whose hold constant reads "testnet-tp1". Removed after the test. */
export function switchedCopy(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dacs-client-switched-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of ['src', 'package.json', 'README.md', 'LICENSE']) cpSync(join(packageDir, path), join(directory, path), { recursive: true });
  const state = join(directory, STATE_MODULE);
  const source = readFileSync(state, 'utf8');
  assert.match(source, /PURCHASE_ADMISSION = 'held'/);
  writeFileSync(state, source.replace("PURCHASE_ADMISSION = 'held'", "PURCHASE_ADMISSION = 'testnet-tp1'"));
  return directory;
}

/** Installs the core archive and the archive of `clientDir` in an empty app; returns the app path and a runner that asserts exit 0. */
export function installPackedPair(t, { clientDir = packageDir } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dacs-client-consumer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = (command, args, cwd, env = {}) => {
    // A nested `node --test` must not inherit this runner's test context, or it reports nothing.
    const childEnv = { ...process.env, ...env, npm_config_cache: join(directory, '.npm-cache') };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 4 << 20, env: childEnv });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  const core = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], sdkDir))[0];
  const client = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], clientDir))[0];
  const app = join(directory, 'app');
  mkdirSync(app);
  const dependencies = { '@kynesyslabs/dacs': 'file:' + join(directory, core.filename),
    '@kynesyslabs/dacs-client': 'file:' + join(directory, client.filename) };
  const manifest = { name: 'TEST-packed-buyer', private: true, type: 'module', dependencies };
  writeFileSync(join(app, 'package.json'), JSON.stringify(manifest));
  // Stage exact installed runtime packages as local artifacts. This test owns
  // its fresh npm cache and never needs ambient registry tarballs or a network.
  const lock = JSON.parse(readFileSync(join(sdkDir, 'package-lock.json')));
  lock.name = manifest.name;
  lock.packages[''] = manifest;
  for (const path of Object.keys(lock.packages)) {
    if (path && (!path.startsWith('node_modules/') || lock.packages[path].link)) delete lock.packages[path];
  }
  const dependencyArtifacts = join(directory, 'dependencies');
  mkdirSync(dependencyArtifacts);
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path || entry.dev || entry.optional) continue;
    const installed = join(sdkDir, path);
    assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'))).version, entry.version, path);
    const artifact = join(dependencyArtifacts, String(Object.keys(lock.packages).indexOf(path)) + '.tgz');
    run('tar', ['-czf', artifact, '--exclude=./node_modules', '--transform=s,^.,package,', '-C', installed, '.'], directory);
    entry.resolved = 'file:' + artifact;
    entry.integrity = 'sha512-' + createHash('sha512').update(readFileSync(artifact)).digest('base64');
  }
  for (const [name, packed, source] of [['@kynesyslabs/dacs', core, sdkDir], ['@kynesyslabs/dacs-client', client, clientDir]]) {
    const pkg = JSON.parse(readFileSync(join(source, 'package.json')));
    lock.packages['node_modules/' + name] = { version: pkg.version, resolved: dependencies[name], integrity: packed.integrity,
      dependencies: pkg.dependencies, peerDependencies: pkg.peerDependencies, peerDependenciesMeta: pkg.peerDependenciesMeta, engines: pkg.engines };
  }
  writeFileSync(join(app, 'package-lock.json'), JSON.stringify(lock));
  run('npm', ['ci', '--offline', '--ignore-scripts', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'], app);
  return { app, run };
}
