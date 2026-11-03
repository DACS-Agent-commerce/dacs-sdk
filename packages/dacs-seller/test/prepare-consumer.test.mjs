// The setup script is the only path from this checkout to an installable
// package. It only ever fills a directory it creates itself, so these cases
// pin that an existing path is never touched, a failed setup leaves nothing
// behind and concurrent runs cannot share one directory. A stub `npm` on PATH
// keeps the cases offline and deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sellerSourceFingerprint, staleSetupReason } from '../../../scripts/prepare-seller-consumer.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const script = join(root, 'scripts', 'prepare-seller-consumer.mjs');
const RUN_TIMEOUT_MS = 120000;
const WAIT_STEP_MS = 10;

// pack answers with the tarball names the consumer lock records; ci installs
// the tree npm would have built, without the registry or the native build.
// PREPARE_PROBE_FAIL makes one step fail; PREPARE_PROBE_BARRIER holds ci until
// two runs reach it; PREPARE_PROBE_HOLD holds ci until the test releases it.
const STUB = `import {existsSync,mkdirSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const args=process.argv.slice(2),env=process.env,deadline=Date.now()+60000;
const waitUntil=ready=>{while(!ready())if(Date.now()>deadline)process.exit(3);};
writeFileSync(env.PREPARE_PROBE_LOG,args.join(' ')+'\\n',{flag:'a'});
if(env.PREPARE_PROBE_FAIL===args[0])process.exit(1);
if(args[0]==='pack'){
 const destination=args[args.indexOf('--pack-destination')+1],seller=args.includes('--workspace');
 const name=seller?'dacs-seller':'dacs',file=name+'-0.1.0-alpha.0.tgz';
 writeFileSync(join(destination,file),'stub tarball');
 process.stdout.write(JSON.stringify([{filename:file,integrity:'sha512-stub',files:[]}])+'\\n');
}
if(args[0]==='ci'){
 if(env.PREPARE_PROBE_BARRIER){writeFileSync(join(env.PREPARE_PROBE_BARRIER,String(process.pid)),'');waitUntil(()=>readdirSync(env.PREPARE_PROBE_BARRIER).length>=2);}
 if(env.PREPARE_PROBE_HOLD){writeFileSync(join(env.PREPARE_PROBE_HOLD,'started'),'');waitUntil(()=>existsSync(join(env.PREPARE_PROBE_HOLD,'release')));}
 for(const name of ['dacs','dacs-seller']){mkdirSync(join(process.cwd(),'node_modules/@kynesyslabs',name),{recursive:true});writeFileSync(join(process.cwd(),'node_modules/@kynesyslabs',name,'package.json'),'{}\\n');}
}
`;

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'dacs-seller-prepare-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bin = join(base, 'bin'), stub = join(base, 'stub.mjs'), log = join(base, 'npm.log'), temp = join(base, 'tmp');
  mkdirSync(bin);
  mkdirSync(temp);
  writeFileSync(stub, STUB);
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stub)} "$@"\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  writeFileSync(log, '');
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, PREPARE_PROBE_LOG: log, TMPDIR: temp };
  const args = (directory) => (directory === undefined ? [script] : [script, directory]);
  return {
    base,
    temp,
    calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
    run: (directory, extra = {}) => spawnSync(process.execPath, args(directory), { env: { ...env, ...extra }, encoding: 'utf8', timeout: RUN_TIMEOUT_MS }),
    start: (directory, extra = {}) => new Promise((resolve) => {
      const child = spawn(process.execPath, args(directory), { env: { ...env, ...extra } });
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    }),
  };
}

// Every name, link target, mode and byte under a path.
function snapshot(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return { link: readlinkSync(path) };
  if (stat.isDirectory()) return { mode: stat.mode, entries: Object.fromEntries(readdirSync(path).sort().map((name) => [name, snapshot(join(path, name))])) };
  return { mode: stat.mode, bytes: readFileSync(path).toString('base64') };
}

async function waitFor(path) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, `${path} appears`);
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
}

const preparedPath = (stdout) => stdout.match(/^Prepared locked seller consumer: (.+)$/m)?.[1];

test('a new directory is created and prepared, with prepared.json binding runtime, sources and lock', (t) => {
  const probe = fixture(t), directory = join(probe.base, 'consumer');
  const result = probe.run(directory);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(preparedPath(result.stdout), directory);
  assert.equal(probe.calls().length, 3, 'pack core, pack seller and install once');
  assert.ok(existsSync(join(directory, 'run.mjs')));
  const marker = JSON.parse(readFileSync(join(directory, 'prepared.json'), 'utf8'));
  assert.deepEqual(Object.keys(marker).sort(), ['corePack', 'lockDigest', 'runtime', 'sellerPack', 'sourceFingerprint']);
  assert.equal(staleSetupReason(directory, sellerSourceFingerprint([])), null, 'the setup matches the files its seller pack contained');
});

test('without a directory, each run prepares its own fresh temporary directory', (t) => {
  const probe = fixture(t);
  const first = probe.run(), second = probe.run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const paths = [preparedPath(first.stdout), preparedPath(second.stdout)];
  assert.notEqual(paths[0], paths[1]);
  for (const path of paths) {
    assert.equal(dirname(path), probe.temp);
    assert.ok(existsSync(join(path, 'prepared.json')));
  }
});

const EXISTING = {
  'an empty directory': (path) => mkdirSync(path),
  'a foreign project': (path) => { mkdirSync(path); writeFileSync(join(path, 'package.json'), '{"name":"unrelated-project"}'); writeFileSync(join(path, 'notes.txt'), 'TEST project data'); },
  'a directory with an empty prepared.json': (path) => { mkdirSync(path); writeFileSync(join(path, 'prepared.json'), ''); writeFileSync(join(path, 'notes.txt'), 'TEST project data'); },
  'a directory with a malformed prepared.json': (path) => { mkdirSync(path); writeFileSync(join(path, 'prepared.json'), '{'); writeFileSync(join(path, 'notes.txt'), 'TEST project data'); },
  'a directory whose manifest has the setup name': (path) => { mkdirSync(path); writeFileSync(join(path, 'package.json'), '{"name":"dacs-seller-locked-smoke"}\n'); writeFileSync(join(path, 'notes.txt'), 'TEST project data'); },
  'a regular file': (path) => writeFileSync(path, 'TEST project data'),
  'a link to another project': (path) => { const other = path + '-target'; mkdirSync(other); writeFileSync(join(other, 'notes.txt'), 'TEST project data'); symlinkSync(other, path); },
};

for (const [label, make] of Object.entries(EXISTING)) test(`${label} is refused and left byte-for-byte unchanged`, (t) => {
  const probe = fixture(t), path = join(probe.base, 'existing');
  make(path);
  const before = snapshot(probe.base);
  const result = probe.run(path);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to prepare .*existing: it already exists; pass a new directory/);
  assert.deepEqual(probe.calls(), [], 'nothing was packed or installed');
  assert.deepEqual(snapshot(probe.base), before);
});

for (const kind of ['a completed earlier setup', 'a foreign project holding a matching-looking prepared.json']) test(`${kind} is refused and left byte-for-byte unchanged`, (t) => {
  const probe = fixture(t), path = join(probe.base, 'existing');
  assert.equal(probe.run(path).status, 0);
  if (kind !== 'a completed earlier setup') {
    writeFileSync(join(path, 'package.json'), '{"name":"unrelated-project"}');
    writeFileSync(join(path, 'notes.txt'), 'TEST project data');
  }
  const before = snapshot(path), calls = probe.calls().length;
  const result = probe.run(path);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /it already exists; pass a new directory/);
  assert.equal(probe.calls().length, calls, 'nothing was packed or installed');
  assert.deepEqual(snapshot(path), before);
});

for (const step of ['pack', 'ci']) test(`a failing ${step} removes only the directory this run created and writes no prepared.json`, (t) => {
  const probe = fixture(t), directory = join(probe.base, 'consumer');
  writeFileSync(join(probe.base, 'sentinel.txt'), 'TEST sibling');
  const named = probe.run(directory, { PREPARE_PROBE_FAIL: step });
  assert.notEqual(named.status, 0);
  assert.equal(existsSync(directory), false);
  assert.equal(readFileSync(join(probe.base, 'sentinel.txt'), 'utf8'), 'TEST sibling');
  writeFileSync(join(probe.temp, 'sentinel.txt'), 'TEST temporary sibling');
  const temporary = probe.run(undefined, { PREPARE_PROBE_FAIL: step });
  assert.notEqual(temporary.status, 0);
  assert.deepEqual(readdirSync(probe.temp), ['sentinel.txt'], 'the fresh temporary directory is removed, and nothing else');
});

test('two setups of separate directories at once both succeed', async (t) => {
  const probe = fixture(t), barrier = join(probe.base, 'barrier');
  mkdirSync(barrier);
  const [first, second] = await Promise.all(['one', 'two'].map((name) => probe.start(join(probe.base, name), { PREPARE_PROBE_BARRIER: barrier })));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readdirSync(barrier).length, 2, 'both installs were running together');
  for (const name of ['one', 'two']) assert.equal(staleSetupReason(join(probe.base, name), sellerSourceFingerprint([])), null);
});

test('two setups of one directory: the first wins, the second is refused and the winner is left intact', async (t) => {
  const probe = fixture(t), hold = join(probe.base, 'hold'), directory = join(probe.base, 'shared');
  mkdirSync(hold);
  const winner = probe.start(directory, { PREPARE_PROBE_HOLD: hold });
  await waitFor(join(hold, 'started'));
  const before = snapshot(directory);
  const loser = probe.run(directory);
  assert.notEqual(loser.status, 0);
  assert.match(loser.stderr, /it already exists; pass a new directory/);
  assert.deepEqual(snapshot(directory), before, 'the refused run touched nothing of the running setup');
  writeFileSync(join(hold, 'release'), '');
  const finished = await winner;
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal(staleSetupReason(directory, sellerSourceFingerprint([])), null);
});

test('setup before the core build is refused with a clear message and creates nothing', (t) => {
  const probe = fixture(t), checkout = join(probe.base, 'checkout'), directory = join(probe.base, 'consumer');
  mkdirSync(join(checkout, 'scripts'), { recursive: true });
  copyFileSync(script, join(checkout, 'scripts', 'prepare-seller-consumer.mjs'));
  const result = spawnSync(process.execPath, [join(checkout, 'scripts', 'prepare-seller-consumer.mjs'), directory], { encoding: 'utf8', timeout: RUN_TIMEOUT_MS });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /the core is not built: run npm run build before npm run seller:prepare/);
  assert.equal(existsSync(directory), false);
});

test('a setup for another runtime, other sources, a changed lock or no marker is stale', (t) => {
  const probe = fixture(t), directory = join(probe.base, 'consumer'), fingerprint = sellerSourceFingerprint([]);
  assert.equal(probe.run(directory).status, 0);
  const markerPath = join(directory, 'prepared.json'), marker = readFileSync(markerPath, 'utf8'), lock = readFileSync(join(directory, 'package-lock.json'));
  const fresh = /; prepare a fresh directory with npm run seller:prepare -- <new directory>$/;
  writeFileSync(markerPath, JSON.stringify({ ...JSON.parse(marker), runtime: 'other-abi-other-platform-other-arch' }));
  assert.match(staleSetupReason(directory, fingerprint), /prepared for another Node runtime/);
  assert.match(staleSetupReason(directory, fingerprint), fresh);
  writeFileSync(markerPath, marker);
  assert.equal(staleSetupReason(directory, fingerprint), null);
  assert.match(staleSetupReason(directory, 'a'.repeat(64)), /prepared from other sources/);
  assert.match(staleSetupReason(directory), /prepared from other sources/, 'a setup whose packed files differ from the seller pack now is stale');
  writeFileSync(join(directory, 'package-lock.json'), lock + ' ');
  assert.match(staleSetupReason(directory, fingerprint), /has a changed lock/);
  writeFileSync(join(directory, 'package-lock.json'), lock);
  for (const content of ['', '{']) {
    writeFileSync(markerPath, content);
    assert.match(staleSetupReason(directory, fingerprint), /has no completed setup/);
  }
  rmSync(markerPath);
  assert.match(staleSetupReason(directory, fingerprint), /has no completed setup \(ENOENT\)/);
});
