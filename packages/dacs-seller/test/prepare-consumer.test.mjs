// The setup script is the only path from this checkout to an installable
// package, so its repeat, interrupted and concurrent behaviour is part of the
// kit. A stub `npm` on PATH keeps the cases offline and deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const script = join(root, 'scripts', 'prepare-seller-consumer.mjs');

// pack answers with the tarball names the consumer lock records; ci installs
// the tree npm would have built, without the registry or the native build.
const STUB = `import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const args=process.argv.slice(2);
writeFileSync(process.env.PREPARE_PROBE_LOG,args.join(' ')+'\\n',{flag:'a'});
if(args[0]==='pack'){
 const destination=args[args.indexOf('--pack-destination')+1],seller=args.includes('--workspace');
 const name=seller?'dacs-seller':'dacs',file=name+'-0.1.0-alpha.0.tgz';
 writeFileSync(join(destination,file),'stub tarball');
 process.stdout.write(JSON.stringify([{filename:file,integrity:'sha512-stub',files:[]}])+'\\n');
}
if(args[0]==='ci'){
 const end=Date.now()+Number(process.env.PREPARE_PROBE_DELAY??0);
 while(Date.now()<end);
 for(const name of ['dacs','dacs-seller']){mkdirSync(join(process.cwd(),'node_modules/@kynesyslabs',name),{recursive:true});writeFileSync(join(process.cwd(),'node_modules/@kynesyslabs',name,'package.json'),'{}\\n');}
}
`;

function fixture(t){
  const base = mkdtempSync(join(tmpdir(), 'dacs-seller-prepare-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bin = join(base, 'bin'), stub = join(base, 'stub.mjs'), log = join(base, 'npm.log');
  mkdirSync(bin);
  writeFileSync(stub, STUB);
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stub)} "$@"\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  writeFileSync(log, '');
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, PREPARE_PROBE_LOG: log };
  return {
    base,
    env,
    calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
    run: (directory) => spawnSync(process.execPath, [script, directory], { env, encoding: 'utf8', timeout: 120000 }),
    runSlow: (directory) => new Promise((resolve) => {
      const child = spawn(process.execPath, [script, directory], { env: { ...env, PREPARE_PROBE_DELAY: '1500' } });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('close', (status) => resolve({ status, stdout }));
    }),
  };
}

test('a completed setup is reused and the command can be run again', (t) => {
  const probe = fixture(t), directory = join(probe.base, 'consumer');
  const first = probe.run(directory);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(existsSync(join(directory, 'prepared.json')), 'the setup is marked complete');
  assert.equal(probe.calls().length, 3, 'pack core, pack seller and install once');
  const second = probe.run(directory);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /reused existing setup/);
  assert.equal(probe.calls().length, 3, 'a repeat run installs nothing');
});

test('an interrupted setup of ours is rebuilt and a foreign directory is never replaced', (t) => {
  const probe = fixture(t), interrupted = join(probe.base, 'interrupted'), foreign = join(probe.base, 'foreign');
  mkdirSync(interrupted);
  writeFileSync(join(interrupted, 'package.json'), '{"name":"dacs-seller-locked-smoke"}\n');
  const rebuilt = probe.run(interrupted);
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.ok(existsSync(join(interrupted, 'prepared.json')), 'the interrupted setup is completed');
  mkdirSync(foreign);
  writeFileSync(join(foreign, 'keep.txt'), 'keep\n');
  const refused = probe.run(foreign);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /refusing to replace .* not a seller consumer setup/);
  assert.equal(readFileSync(join(foreign, 'keep.txt'), 'utf8'), 'keep\n', 'its contents are untouched');
  assert.ok(!existsSync(join(foreign, 'prepared.json')));
});

test('a setup built for another Node ABI is rebuilt, not reused', (t) => {
  const probe = fixture(t), directory = join(probe.base, 'consumer');
  assert.equal(probe.run(directory).status, 0);
  const markerPath = join(directory, 'prepared.json'), marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  assert.equal(typeof marker.runtime, 'string');
  marker.runtime = 'other-abi-other-platform-other-arch';
  writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n');
  const before = probe.calls().length, rebuilt = probe.run(directory);
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.equal(probe.calls().length - before, 3, 'the native binding is built for this runtime again');
  assert.notEqual(JSON.parse(readFileSync(markerPath, 'utf8')).runtime, 'other-abi-other-platform-other-arch');
});

test('two setups of one directory both succeed with one prepared consumer', async (t) => {
  const probe = fixture(t), directory = join(probe.base, 'shared');
  const [first, second] = await Promise.all([probe.runSlow(directory), probe.runSlow(directory)]);
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.ok(existsSync(join(directory, 'prepared.json')));
  assert.ok(existsSync(join(directory, 'node_modules')));
  assert.equal(readFileSync(join(directory, 'prepared.json'), 'utf8').includes('sourceFingerprint'), true);
});
