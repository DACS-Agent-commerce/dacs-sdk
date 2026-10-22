import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripTypeScriptTypes, createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = pathToFileURL(resolve(process.env.DACS_SWEEP_REPO ?? '.') + '/');
const { LIFECYCLE_SOURCE } = await import(new URL('packages/create-dacs-agent/src/lifecycleTemplate.ts', root));
const { liveProjectTemplates } = await import(new URL('packages/create-dacs-agent/src/liveTemplates.ts', root));
const { inspectDacsDemosNodeCompatibilityV1 } = await import(new URL('packages/dacs-node/src/demosCompatibility.ts', root));
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
function generated(source, deps, names) {
  const compiled = stripTypeScriptTypes(source.replaceAll('import.meta.url', JSON.stringify(import.meta.url)), { mode: 'transform' })
    .replace(/import\s*{([^}]+)}\s*from\s*"([^"]+)";/g, (_, members, spec) => `const {${members.replace(/\bas\b/g, ':')}} = dependencies(${JSON.stringify(spec)});`)
    .replace(/\bexport (?=(?:async )?function |const |class )/g, '');
  return new Function('dependencies', `${compiled}\nreturn { ${names.join(', ')} };`)(deps);
}
const require = createRequire(import.meta.url);
function lifecycle(version) {
  const constants = {
    VERSION: version, FIXED_PRICE_X402_STANDARD_REVISION: pkg.dacs.standardRevision,
    DACS_NODE_CONFIG_SCHEMA_VERSION: pkg.dacs.configSchemaVersion,
    DACS_NODE_SQLITE_SCHEMA_VERSION: pkg.dacs.sqliteSchemaVersion,
    DACS_NODE_SUPPORTED_SQLITE_MIGRATION_SOURCES: pkg.dacs.supportedSqliteMigrationFrom,
    loadRoleConfig: () => { throw Error('explicit paths required'); },
  };
  return generated(LIFECYCLE_SOURCE, s => s.startsWith('node:') ? require(s) : constants,
    ['assertGeneratedBackupRestorableV1', 'createGeneratedBackupV1', 'restoreGeneratedBackupV1']);
}
const manifest = sdkVersion => ({ release: { sdkVersion, standardRevision: pkg.dacs.standardRevision, configSchemaVersion: pkg.dacs.configSchemaVersion, sqliteSchemaVersion: pkg.dacs.sqliteSchemaVersion } });
test('restore admits the exact version, refuses both directions and different build metadata', () => {
  const api = lifecycle('1.2.3-beta.2');
  assert.doesNotThrow(() => api.assertGeneratedBackupRestorableV1(manifest('1.2.3-beta.2')));
  for (const version of ['1.2.2', '1.2.3-beta.1', '1.2.3-beta.2+build.7', '1.2.3', '2.0.0', '', 'bad']) {
    assert.throws(() => api.assertGeneratedBackupRestorableV1(manifest(version)), /restore-backup-release-incompatible/);
  }
});
test('same-release authenticated backups restore; other-release backups leave both roles intact', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dacs-sweep-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = { buyer: join(directory, 'buyer'), seller: join(directory, 'seller'), authKeyFile: join(directory, 'key.hex') };
  await writeFile(paths.authKeyFile, '12'.repeat(32), { mode: 0o600 });
  for (const role of ['buyer','seller']) { await mkdir(paths[role], { mode: 0o700 }); await writeFile(join(paths[role], 'actor.sqlite'), role + '-original', { mode: 0o600 }); }
  const api = lifecycle('1.2.3');
  const backupDirectory = join(directory, 'backup');
  const backup = await api.createGeneratedBackupV1({ outputDirectory: backupDirectory, paths });
  for (const role of ['buyer','seller']) await writeFile(join(paths[role], 'actor.sqlite'), role + '-current');
  for (const version of ['1.2.2', '1.2.4']) {
    await assert.rejects(lifecycle(version).restoreGeneratedBackupV1({ backupDirectory, expectedBackupId: backup.backupId, safetyBackupDirectory: join(directory, 'safety-'+version), paths }), /restore-backup-release-incompatible/);
    for (const role of ['buyer','seller']) assert.equal(await readFile(join(paths[role], 'actor.sqlite'), 'utf8'), role + '-current');
  }
  await api.restoreGeneratedBackupV1({ backupDirectory, expectedBackupId: backup.backupId, safetyBackupDirectory: join(directory, 'safety'), paths });
  for (const role of ['buyer','seller']) assert.equal(await readFile(join(paths[role], 'actor.sqlite'), 'utf8'), role + '-original');
});
function doctor(reply) {
  const source = liveProjectTemplates({ packageName:'doctor-contract', deployment:'docker', role:'buyer', rails:'pay-dem', runtimeUid:10001, runtimeGid:10001 })['src/doctor.ts'];
  const api = generated(source, s => s.startsWith('node:') ? require(s) : {
    inspectDacsDemosNodeCompatibilityV1, dacsLiveRailProfiles: () => ['pay-dem'],
    configuredRailStewardAuthority: () => undefined, loadRoleConfig: () => ({}),
  }, ['baseProbes']);
  let calls = 0;
  const runtime = { adapter: { raw: { nodeCall: async (method, args) => { calls++; assert.equal(method,'getNetworkInfo'); assert.deepEqual(args,{}); return structuredClone(reply); } } } };
  return { run: api.baseProbes({ buyer:{runtime}, seller:{runtime} }, undefined)['demos.rpc-chain'], calls: () => calls };
}
test('doctor distinguishes preserved transport envelopes from SDK-unwrapped string node errors', async () => {
  delete process.env.DACS_DEMOS_DEPLOYMENT_POLICY;
  for (const [reply, reasonCode] of [
    ['No address specified', 'demos-rpc-response-malformed'],
    ['Error in nodeCall: booting', 'demos-rpc-response-malformed'],
    [{result:500, response:{}}, 'demos-rpc-unavailable'],
  ]) assert.deepEqual(await doctor(reply).run(), {status:'fail',reasonCode});
  assert.equal((await doctor({ forks:{osDenomination:{activated:true}} }).run()).status, 'pass');
});
test('doctor accepts testnet and refuses invalid or unproven production intent before RPC', async () => {
  const reply = { forks:{osDenomination:{activated:true}} };
  for (const [policy, status, reasonCode] of [['testnet','pass',undefined], ['Testnet','fail','demos-deployment-policy-invalid'], ['production','blocked','demos-deployment-pin-unverified']]) {
    process.env.DACS_DEMOS_DEPLOYMENT_POLICY = policy;
    const probe = doctor(reply), result = await probe.run();
    assert.equal(result.status, status); assert.equal(result.reasonCode, reasonCode);
    assert.equal(probe.calls(), status === 'pass' ? 2 : 0);
  }
  delete process.env.DACS_DEMOS_DEPLOYMENT_POLICY;
});
test('library and generated project use the reviewed Demos SDK exactly', () => {
  assert.equal(pkg.peerDependencies['@kynesyslabs/demosdk'], '4.0.16');
  const files = liveProjectTemplates({ packageName:'pin-contract', deployment:'docker', role:'buyer', rails:'pay-dem', runtimeUid:10001, runtimeGid:10001 });
  assert.equal(JSON.parse(files['package.json']).dependencies['@kynesyslabs/demosdk'], '4.0.16');
  assert.match(files['README.md'], /Restore requires the exact creating/);
});
test('D402 session bridge refuses before payment while standalone preview remains available', async () => {
  const { payD402Settle, payD402SettleCore } = await import(new URL('src/rails/payD402.ts', root));
  let calls = 0;
  const bridge = payD402Settle({address:'payer',settle:async()=>{calls++;throw Error('must not submit');}}, {url:'https://seller.invalid',recipient:'seller'});
  assert.throws(() => bridge({rail:'pay-d402',phase:'pay-d402',amount:'1',asset:'DEM',payee:'did:demos:seller',expectedPayee:'seller',jobId:'01JZ0000000000000000000360'}), /inclusion\/finality observer/);
  assert.equal(calls,0);
  const preview = await payD402SettleCore({paywallUrl:'https://seller.invalid',recipient:'seller',amount:'1',network:'demos:testnet'}, {
    payerAddress:'payer',
    fetchImpl:async()=>new Response(JSON.stringify({recipient:'seller',amount:'1',resourceId:'resource'}),{status:402}),
    client:{createPayment:async()=>({preview:true}),settle:async()=>({success:true,hash:'preview-only'})},
  });
  assert.equal(preview.txHash,'preview-only');
});
