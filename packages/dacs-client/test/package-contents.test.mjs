import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const sdkDir = resolve(packageDir, '../..');
function entryPointClosure() {
  const files = new Set();
  function visit(path) {
    if (files.has(path)) return;
    assert.ok(path.startsWith('src/') && path.endsWith('.mjs'), path);
    files.add(path);
    const source = readFileSync(join(packageDir, path), 'utf8');
    for (const [, specifier] of source.matchAll(/\b(?:from|import)\s*(?:\(\s*)?['"](\.[^'"]+)['"]/g)) {
      visit(relative(packageDir, resolve(packageDir, dirname(path), specifier)));
    }
  }
  visit('src/index.mjs');
  visit('src/wallet/durable-journal.mjs');
  return [...files].sort();
}

test('npm pack ships only the two entry points and their reviewed import closure', t => {
  const directory = mkdtempSync(join(tmpdir(), 'dacs-client-pack-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of ['src', 'package.json', 'README.md', 'LICENSE']) {
    cpSync(join(packageDir, path), join(directory, path), { recursive: true });
  }
  // New plugin or internal files must stay excluded even when present locally.
  for (const path of ['src/public/portal/TEST-unreviewed.mjs', 'src/dacs/TEST-seller-state.mjs',
    'src/config/TEST-unreviewed.mjs', 'src/TEST-unused.mjs', 'FIX-REPORT.md', '.fix-tmp/PR.md', '.rr-tmp/REVIEW.md', '.stack/TEST.md']) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), 'TEST unreviewed content\n');
  }
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: directory,
    encoding: 'utf8', maxBuffer: 4 << 20, env: { ...process.env, npm_config_cache: join(directory, '.npm-cache') } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [pack] = JSON.parse(result.stdout);
  const files = pack.files.map(file => file.path).sort();
  for (const path of files) {
    assert.doesNotMatch(path, /(?:^|\/)(?:public|portal|portal-intent|config|seller-agent|seller-durable-state|switch-files|FIX-REPORT|\.fix-tmp|\.rr-tmp|\.stack)(?:[/.]|$)/, path);
  }
  assert.deepEqual(files, [...entryPointClosure(), 'package.json', 'README.md', 'LICENSE'].sort());
});

test('paired packed artifacts supply the schema needed by every buyer factory', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dacs-client-consumer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = (command, args, cwd) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 4 << 20,
      env: { ...process.env, npm_config_cache: join(directory, '.npm-cache') } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  const core = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], sdkDir))[0];
  const client = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], packageDir))[0];
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
  for (const [name, packed, source] of [['@kynesyslabs/dacs', core, sdkDir], ['@kynesyslabs/dacs-client', client, packageDir]]) {
    const pkg = JSON.parse(readFileSync(join(source, 'package.json')));
    lock.packages['node_modules/' + name] = { version: pkg.version, resolved: dependencies[name], integrity: packed.integrity,
      dependencies: pkg.dependencies, peerDependencies: pkg.peerDependencies, peerDependenciesMeta: pkg.peerDependenciesMeta, engines: pkg.engines };
  }
  writeFileSync(join(app, 'package-lock.json'), JSON.stringify(lock));
  run('npm', ['ci', '--offline', '--ignore-scripts', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'], app);
  await t.test('installed root resolves the complete diagnostic factory graph', () => {
    run(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const client = await import('@kynesyslabs/dacs-client');
      for (const name of ['createPurchaseService', 'createProtocolPurchases']) {
        assert.equal(typeof client[name], 'function', name);
      }
    `], app);
  });
  await t.test('installed README example commits or rolls back operation and coordinate writes', () => {
    const readme = readFileSync(join(app, 'node_modules/@kynesyslabs/dacs-client/README.md'), 'utf8');
    const example = /```js\n([\s\S]*?)```/.exec(readme)?.[1];
    assert.ok(example, 'README has an executable factory example');
    writeFileSync(join(app, 'readme-example.mjs'), example);
    writeFileSync(join(app, 'readme-harness.mjs'), `
      import assert from 'node:assert/strict';
      import { createHash } from 'node:crypto';
      const rollback = process.argv[2] === 'rollback', NOW = Date.UTC(2030, 0, 1);
      Date.now = () => NOW;
      const sentinel = new Error('TEST-after-operation-write');
      const token = 'TEST-readme-token', accountId = 'TEST-buyer', id = 'TEST-operation';
      const terms = { buyer: { wallet: '0x' + 'b'.repeat(64) }, seller: { payee: '0x' + 'c'.repeat(64) },
        price: { amountOs: '1' }, listing: { listingId: 'TEST-listing', version: 1, contentHash: 'f'.repeat(64) },
        network: 'testnet', rail: 'demos-native:DEM' };
      let connection, diagnosed = false;
      globalThis.host = {
        accountId, token, config: {}, accounts: {}, verifier: {}, chain: {}, challenges: {}, dacsProtocol: {},
        coordinate: { operationId: id, kind: 'dem-transfer', network: 'testnet', from: 'TEST-buyer',
          nonceFence: 0, expectedNonce: 1, target: 'TEST-seller', amountOs: '1', payload: {} },
        createOperations(db) {
          connection = db;
          const at = new Date(NOW).toISOString(), expires = new Date(NOW + 3600000).toISOString();
          db.prepare('INSERT INTO accounts(id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run(accountId,'TEST',accountId,at);
          db.prepare('INSERT INTO operations(id,account_id,kind,idempotency_key,request_hash,status,terms,terms_hash,handoff_token_hash,handoff_expires_at,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(id,accountId,'purchase','TEST','TEST','broadcast_reported',JSON.stringify(terms),'TEST',
              createHash('sha256').update('dacs-handoff-hash:' + token).digest('hex'),expires,expires,at,at);
          const byId = db.prepare('SELECT * FROM operations WHERE id=?');
          const update = db.prepare('UPDATE operations SET state=? WHERE id=? AND status=?');
          const hydrate = () => {
            const row = byId.get(id);
            return { id, accountId, kind: row.kind, status: row.status, terms, termsHash: row.terms_hash,
              state: JSON.parse(row.state), expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at };
          };
          host.operation = hydrate();
          return {
            get: (owner, key) => owner === accountId && key === id ? hydrate() : null,
            getByHandoff: (key, value) => key === id && value === token ? hydrate() : null,
            history: () => {
              assert.equal(db.prepare('SELECT count(*) n FROM write_coordinates').get().n, 1);
              diagnosed = true;
              return [];
            },
            transition(key, from, to, patch) {
              assert.equal(to, from);
              assert.equal(update.run(JSON.stringify(patch.state), key, from).changes, 1);
              if (rollback) throw sentinel;
              return hydrate();
            },
          };
        },
      };
      try {
        if (rollback) await assert.rejects(import('./readme-example.mjs'), error => error === sentinel);
        else await import('./readme-example.mjs');
        assert.ok(connection, 'example constructs host operations after the purchase store');
        assert.equal(connection.prepare('SELECT count(*) n FROM write_coordinates').get().n, rollback ? 0 : 1);
        assert.deepEqual(JSON.parse(connection.prepare('SELECT state FROM operations WHERE id=?').get(id).state),
          rollback ? {} : { hostNote: 'local bookkeeping' });
        assert.equal(diagnosed, !rollback, 'diagnostic runs after successful transaction');
      } finally { connection?.close(); }
    `);
    for (const outcome of ['commit', 'rollback']) run(process.execPath, ['readme-harness.mjs', outcome], app);
  });
  // This consumer has no source-tree imports or test database helper.
  writeFileSync(join(app, 'consumer.mjs'), `
    import assert from 'node:assert/strict';
    Date.now = () => 1700000000000;
    import { DatabaseSync } from 'node:sqlite';
    import { PURCHASE_STATE_SCHEMA, createSqlitePurchaseStore, createCoordinateStore,
      createPurchaseService, createProtocolPurchases, createDeliveryDeadlineWatch } from '@kynesyslabs/dacs-client';
    import { fileURLToPath } from 'node:url';
    import { openDurableWalletJournal, DurableWalletJournalError } from '@kynesyslabs/dacs-client/wallet/durable-journal';
    const journalPath = fileURLToPath(new URL('./TEST-journal.sqlite', import.meta.url));
    assert.throws(() => openDurableWalletJournal({ path: journalPath, mode: 'invalid' }), error => error instanceof DurableWalletJournalError && error.code === 'journal-invalid');
    let journal = openDurableWalletJournal({ path: journalPath, mode: 'create' });
    const journalId = journal.journalId, record = { receipt: 'TEST-public-receipt' };
    try { await journal.put('TEST-record', record); } finally { journal.close(); }
    journal = openDurableWalletJournal({ path: journalPath, mode: 'open', expectedJournalId: journalId });
    try { assert.deepEqual(await journal.get('TEST-record'), record); } finally { journal.close(); }
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys=ON');
      db.exec(PURCHASE_STATE_SCHEMA);
      const store = createSqlitePurchaseStore(), coordinates = createCoordinateStore({ db });
      assert.equal(typeof createPurchaseService({ db, coordinates, config: {}, ops: {}, accounts: {}, verifier: {}, chain: {},
        challenges: {}, store, purposes: { APPROVE_PURCHASE: 'purchase-approval' } }).verifyDeal, 'function');
      assert.equal(createProtocolPurchases({ db, coordinates, ops: {}, dacsProtocol: {}, store }).actionsAdmitted, false);
      assert.equal(typeof createDeliveryDeadlineWatch({ db, coordinates, ops: {}, store, enabled: true }).observe, 'function');
      db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('buyer','TEST','buyer','TEST');
      const operation = db.prepare('INSERT INTO operations (id,account_id,kind,idempotency_key,request_hash,status,terms,terms_hash,handoff_token_hash,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
      const challenge = db.prepare('INSERT INTO challenges (id,nonce,purpose,binding,message,issued_at,expires_at) VALUES (?,?,?,?,?,?,?)');
      for (const id of ['first','second']) {
        operation.run(id,'buyer','purchase',id,'TEST','broadcast_reported','{}','TEST',id,'TEST','TEST','TEST');
        challenge.run(id,id,'purchase-approval','{}','TEST','TEST','TEST');
        coordinates.save({ operationId: id, kind: 'dem-transfer', network: 'testnet', from: 'TEST-buyer',
          nonceFence: 0, expectedNonce: 1, target: 'TEST-seller', amountOs: '1', payload: {} });
        assert.equal(coordinates.reportHash(id, 'a'.repeat(64)), true);
      }
      // A fully matching host projection is diagnostic in the installed API.
      const hash = 'a'.repeat(64), identity = 'f'.repeat(64), wallet = '0x' + 'b'.repeat(64), payee = '0x' + 'c'.repeat(64);
      const saved = { id: 'first', accountId: 'buyer', kind: 'purchase', status: 'broadcast_reported', termsHash: identity,
        terms: { buyer: { wallet }, seller: { payee }, price: { amountOs: '1' }, network: 'testnet', rail: 'demos-native:DEM',
          listing: { listingId: 'TEST-listing', version: 1, contentHash: identity },
          domain: { network: 'testnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: identity } } };
      const forbidden = () => { throw new Error('host observations cannot authorize a write'); };
      const chain = { network: 'testnet', pinnedIdentity: identity,
        networkIdentity: async () => ({ identity, mode: 'public-chain-read' }),
        observePassiveTransfer: async () => ({ status: 'included', txHash: hash, payer: wallet, payee, amountOs: '1', blockNumber: 10 }),
        observeTransfer: forbidden, getTransaction: forbidden };
      // Deliberately mis-scoped host seam: the installed client must check ownership.
      let secondaryReads = 0;
      const ops = { get: (_account, id) => id === 'first' ? saved : null,
        getByHandoff: (id, _token) => id === 'first' ? saved : null,
        history: () => { secondaryReads++; return []; }, handoffTokenFor: forbidden,
        transition: forbidden, record: forbidden };
      const service = createPurchaseService({ db, coordinates, config: {}, chain, ops, store,
        diagnosticOnly: false, settlementAuthority: chain, purposes: { APPROVE_PURCHASE: 'purchase-approval' } }, false);
      db.prepare('UPDATE operations SET handoff_token_hash=?, handoff_expires_at=? WHERE id=?')
        .run((await import('node:crypto')).createHash('sha256').update('dacs-handoff-hash:TEST-token').digest('hex'), '2099-01-01T00:00:00.000Z', 'first');
      await assert.rejects(service.verifyDeal({ accountId: 'buyer', operationId: 'first' }), { code: 'not_found' });
      assert.throws(() => service.status('buyer', 'first'), { code: 'not_found' });
      assert.equal(secondaryReads, 0);
      const snapshot = coordinates.get('first');
      const result = await service.verifyDeal({ accountId: 'buyer', operationId: 'first', token: 'TEST-token', txHash: hash });
      assert.equal(result.verification.outcome, 'readback_only');
      assert.equal(result.verification.authority, 'unqualified_host');
      assert.equal(result.verification.observation.status, 'included', JSON.stringify(result.verification.observation));
      assert.equal(result.verification.termsMatch, true);
      assert.deepEqual(coordinates.get('first'), snapshot);
      assert.equal(db.prepare('SELECT status FROM operations WHERE id=?').get('first').status, 'broadcast_reported');
      assert.equal(db.prepare('SELECT count(*) n FROM wallet_nonce_consumptions').get().n, 0);
      await assert.rejects(service.verifyDeal({ accountId: 'someone-else', operationId: 'first' }), { code: 'not_found' });
      assert.throws(() => service.status('someone-else', 'first'), { code: 'not_found' });
      assert.equal(secondaryReads, 0);
      assert.throws(() => service.portalEvidence({ ...saved, accountId: 'someone-else' }), { code: 'not_found' });
      assert.throws(() => service.portalEvidence('first', 'TEST-wrong-token'), { code: 'not_found' });
      for (const status of ['awaiting_approval', 'approved', 'payment_handoff', 'settled_verified']) {
        saved.status = status;
        assert.equal(service.status('buyer', 'first', 'TEST-token').approvalUrl, null);
        assert.match(service.status('buyer', 'first', 'TEST-token').next, /historical.*held/);
        assert.equal(service.portalEvidence('first', 'TEST-token').actionable, false);
      }
      saved.status = 'broadcast_reported';
      for (const method of ['cancel', 'reportWalletResult', 'protocolRecheck']) {
        await assert.rejects(service[method]({ accountId: 'buyer', operationId: 'first' }), { code: 'profile_not_admitted' });
      }
      const approval = db.prepare('INSERT INTO approvals VALUES (?,?,?,?,?,?,?)');
      approval.run('a','first','first','TEST','TEST','TEST','TEST');
      assert.throws(() => approval.run('b','first','second','TEST','TEST','TEST','TEST'), store.isUniqueViolation);
      assert.throws(() => approval.run('c','second','first','TEST','TEST','TEST','TEST'), store.isUniqueViolation);
      coordinates.recordObservation('first', { txHash: 'a'.repeat(64) }, true);
      assert.throws(() => coordinates.recordObservation('second', { txHash: 'a'.repeat(64) }, true), store.isUniqueViolation);
    } finally { db.close(); }
  `);
  run(process.execPath, ['consumer.mjs'], app);
});

test('documented local packing builds core before skipping pack lifecycle scripts', () => {
  const readme = readFileSync(join(packageDir, 'README.md'), 'utf8');
  const commands = /```sh\n([\s\S]*?)```/.exec(readme)?.[1].trim().split('\n');
  assert.ok(commands, 'local installation command block is present');
  const install = commands.indexOf('npm ci'), build = commands.indexOf('npm run build');
  const pack = commands.findIndex(command => command.startsWith('npm pack --ignore-scripts'));
  assert.ok(install >= 0 && build > install && pack > build, 'fresh clones build dist before packing core');
});
