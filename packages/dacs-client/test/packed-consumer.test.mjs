// DC-CW11: behaviour of the packed archives after the hold is switched. The switched
// copy rewrites only purchase-admission-state.mjs (P35's diff) in a temporary
// directory; nothing here is committed, published or pinned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installPackedPair, packageDir, switchedCopy } from './helpers/packed-install.mjs';

// What the composition test needs besides the installed package, copied into the empty app.
const COMPOSITION_FILES = ['test/public-composition.test.mjs', 'test/helpers/public-composition-world.mjs', 'test/helpers/purchase-integrity-operations.mjs',
  'test/helpers/purchase-integrity-database.mjs', 'test/helpers/passive-native-world.mjs', 'test/fixtures/listings.mjs', 'test/fixtures/wallet.mjs', 'test/fixtures/tp1-authority-reader.mjs'];

test('tests 24-29\'s composition passes from the packed client and core archives installed in an empty directory (switched-copy archive, DC-CW11)', t => {
  const { app, run } = installPackedPair(t, { clientDir: switchedCopy(t) });
  for (const path of COMPOSITION_FILES) {
    mkdirSync(dirname(join(app, path)), { recursive: true });
    cpSync(join(packageDir, path), join(app, path));
  }
  // The helpers reach the package as ../../src; here that is the installed copy.
  symlinkSync(join(app, 'node_modules/@kynesyslabs/dacs-client/src'), join(app, 'src'));
  const output = run(process.execPath, ['--test', '--test-concurrency=1', 'test/public-composition.test.mjs'], app, { DACS_PACKED_COMPOSITION: '1' });
  assert.match(output, /^# pass 6$/m, 'all six composition tests ran from the installed package');
  assert.match(output, /^# fail 0$/m);
});

test('the installed ./substrate/demos entry exports one testnet-pinned reader that both public factories use unchanged, and no reader internals or source paths (switched-copy archive)', t => {
  const { app, run } = installPackedPair(t, { clientDir: switchedCopy(t) });
  writeFileSync(join(app, 'demos-reader.mjs'), `
    import assert from 'node:assert/strict';
    import { DatabaseSync } from 'node:sqlite';
    import * as demos from '@kynesyslabs/dacs-client/substrate/demos';
    import * as client from '@kynesyslabs/dacs-client';
    import { bindTp1Profile, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
    assert.deepEqual(Object.keys(demos), ['createDemosPublicChainReader']);
    for (const name of ['createDemosChainReader', 'createDemosPublicChainReader', 'createDemosSr2WalletBridge', 'isDevnetAgreementTransport', 'isDevnetNativeTransport']) {
      assert.equal(client[name], undefined, name);
    }
    for (const path of ['src/substrate/demos.mjs', 'src/dacs/chain.mjs', 'substrate/demos.mjs']) {
      await assert.rejects(import('@kynesyslabs/dacs-client/' + path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }, path);
    }
    // An in-process testnet node: nothing leaves the process.
    const identity = 'e'.repeat(64), seller = '0x' + 'a'.repeat(64), wallet = '0x' + 'b'.repeat(64), requests = [];
    const answer = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const fetchImpl = async (url, init) => {
      if (init.method !== 'POST') { requests.push(new URL(url).pathname); return answer({ success: true, data: { title: 'TEST' }, owner: seller, programName: 'TEST' }); }
      const { message, data } = JSON.parse(init.body).params[0];
      requests.push(message);
      if (message === 'getBlockByNumber' && data.blockNumber === 0) return answer({ result: 200, response: { number: 0, hash: identity } });
      if (message === 'getAddressNonce') return answer({ result: 200, response: 6 });
      throw new Error('TEST-unexpected ' + message);
    };
    const options = { rpcUrl: 'https://rpc.testnet.invalid', network: 'testnet', pinnedIdentity: identity, fetchImpl };
    assert.throws(() => demos.createDemosPublicChainReader({ ...options, network: 'mainnet' }), { code: 'invalid_configuration' });
    const chain = demos.createDemosPublicChainReader(options);
    for (const name of ['getIdentities', 'observePassiveTransfer', 'raw', 'inner', 'request', 'fetch']) assert.equal(name in chain, false, name);
    const local = { endpoint: 'https://rpc.example.invalid/', transportAuthority: 'vector-authority', connectionId: 'vector-conn-1' };
    const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local, readAuthority: async scope => ({ local: { ...scope.local },
      chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, provenance: 'TEST-authority', sessionId: scope.sessionId, participants: [] }) });
    const admission = { binding, currentLocal: () => ({ ...local }) };
    const locator = 'stor-' + 'c'.repeat(40);
    const directory = { findSummary: async () => ({ status: 'active', contentHash: 'TEST', anchor: { kind: 'storage-program', locator } }), getListingDetail: async () => ({ title: 'TEST' }) };
    const listed = await client.createListingVerifier({ directory, chain, admission }).verify({ listingId: 'TEST-listing', version: 1, seller: 'did:demos:agent:' + seller.slice(2) });
    const checks = Object.fromEntries(listed.checks.map(({ name, ok }) => [name, ok]));
    assert.equal(checks['chain-anchor-present'], true);
    assert.equal(checks['chain-anchor-owner-is-seller'], true);
    assert.equal(listed.evidence.chainRpcOrigin, chain.rpcOrigin);
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys=ON');
      db.exec(client.PURCHASE_STATE_SCHEMA);
      db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('buyer', 'TEST', 'buyer', 'TEST');
      db.prepare('INSERT INTO operations (id,account_id,kind,idempotency_key,request_hash,status,terms,terms_hash,handoff_token_hash,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('first', 'buyer', 'purchase', 'first', 'TEST', 'payment_handoff', '{}', 'TEST', 'first', 'TEST', 'TEST', 'TEST');
      const store = client.createSqlitePurchaseStore(), coordinates = client.createCoordinateStore({ db });
      coordinates.save({ operationId: 'first', kind: 'native-dem-transfer', network: 'testnet', from: wallet, nonceFence: 6, expectedNonce: 7, target: seller, amountOs: '1', payload: {} });
      const saved = { id: 'first', accountId: 'buyer', kind: 'purchase', status: 'payment_handoff', expiresAt: '2099-01-01T00:00:00.000Z',
        terms: { buyer: { wallet }, seller: { payee: seller }, price: { amountOs: '1' }, network: 'testnet', rail: 'demos-native:DEM',
          domain: { network: 'testnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: identity } } };
      const service = client.createPurchaseService({ db, coordinates, config: {}, ops: { get: (account, id) => (account === 'buyer' && id === 'first' ? saved : null) },
        accounts: {}, verifier: {}, chain, challenges: {}, store, purposes: { APPROVE_PURCHASE: 'purchase-approval' }, admission });
      const { verification } = await service.verifyDeal({ accountId: 'buyer', operationId: 'first' });
      assert.equal(verification.outcome, 'not_broadcast', JSON.stringify(verification));
    } finally { db.close(); }
    assert.deepEqual(requests, ['getBlockByNumber', '/storage-program/' + locator, 'getBlockByNumber', 'getAddressNonce']);
  `);
  run(process.execPath, ['demos-reader.mjs'], app);
});

test('a binding made through the consumer\'s own @kynesyslabs/dacs/wire import is accepted by the packed client (switched-copy archive)', t => {
  const { app, run } = installPackedPair(t, { clientDir: switchedCopy(t) });
  writeFileSync(join(app, 'identity.mjs'), `
    import assert from 'node:assert/strict';
    import { bindTp1Profile, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
    import { createProtocolPurchases, createSqlitePurchaseStore } from '@kynesyslabs/dacs-client';
    const local = { endpoint: 'https://rpc.example.invalid/', transportAuthority: 'vector-authority', connectionId: 'vector-conn-1' };
    const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local, readAuthority: async scope => ({ local: { ...scope.local },
      chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, provenance: 'TEST-authority', sessionId: scope.sessionId, participants: [] }) });
    const store = createSqlitePurchaseStore(), currentLocal = () => ({ ...local });
    const accepted = createProtocolPurchases({ store, admission: { binding, currentLocal } });
    assert.equal(accepted.actionsAdmitted, true, 'the switched copy is admitted');
    // Admitted: the original ran and gave its own refusal, not the wrapper's.
    await assert.rejects(accepted.prepareTerms({ verification: {}, domain: {}, sellerClaim: 'TEST-seller' }), { code: 'dacs_protocol_unavailable' });
    const cloned = createProtocolPurchases({ store, admission: { binding: structuredClone(binding), currentLocal } });
    await assert.rejects(cloned.prepareTerms({}), error => error.code === 'profile_not_admitted' && error.cause?.code === 'tp1_binding_required');
  `);
  run(process.execPath, ['identity.mjs'], app);
});
