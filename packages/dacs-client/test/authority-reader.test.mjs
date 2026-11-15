import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bindTp1Profile, assertTp1Binding } from '@kynesyslabs/dacs/wire';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal } from '../src/dacs/demos-sr2-adapter.mjs';
import { createDevnetAgreementTransport } from '../src/wallet/devnet-native-transport.mjs';
import { createAuthorityFixture } from './fixtures/tp1-authority-reader.mjs';
import { record, ownLocal, shared } from './helpers/chain-identity-fixture.mjs';

// Reuse the retained, signed public CREATE unchanged. The counterparty's
// endpoint is in its signed metadata; each reader owns a different endpoint.
const f = JSON.parse(readFileSync(new URL('./fixtures/sr2-public-creates.json', import.meta.url)));
function adapterAt(t, endpoint, pinChange = {}) {
  const pins = { ...f.pins, endpoint, transportAuthority: 'TEST-independent-reader', ...pinChange };
  const context = { network: pins.network, endpoint, transportAuthority: pins.transportAuthority, connectionId: 'TEST-reader-connection' };
  const tx = { ...structuredClone(f.valid), status: 'confirmed', blockNumber: 7 }, op = tx.content.data[1];
  const native = { success: true, storageAddress: op.storageAddress, owner: f.owner, programName: op.programName, data: op.data, metadata: op.metadata, createdByTx: tx.hash, interactionTxs: [tx.hash] };
  const block = { number: 7, status: 'confirmed', hash: 'a'.repeat(64), content: { timestamp: 1790000010, ordered_transactions: [tx.hash] }, validation_data: { TEST: 'single-node-observation', chainIdentity: pins.chainIdentity } };
  const source = createDevnetAgreementTransport({ expected: pins, now: () => 1790000020000,
    journal: { get: async () => null, put: async () => assert.fail('unexpected write'), entries: async () => [], withWalletLock: (_key, work) => work() },
    transportOwner: { getContext: () => ({ ...context }), acquireConnectionFence: () => ({ context: { ...context }, release() {} }) },
    fetchImpl: async (_url, options) => {
      const body = options.body ? JSON.parse(options.body) : null, call = body?.params[0];
      const responses = { getBlockByNumber: call?.data.blockNumber === 0 ? { number: 0, status: 'confirmed', hash: pins.chainIdentity } : block,
        searchStoragePrograms: [{ storageAddress: op.storageAddress, programName: op.programName }], getTxByHash: tx };
      if (body) assert.ok(Object.hasOwn(responses, call.message), 'only bounded source reads are allowed');
      return new Response(JSON.stringify(body ? { result: 200, response: responses[call.message] } : native), { headers: { 'content-type': 'application/json' } });
    },
  });
  t.after(() => source.close());
  const adapter = createDemosSr2Adapter({ rpcUrl: endpoint, sourceCapability: source, journal: createInMemoryDemosSr2Journal(), now: () => 1790000020000 });
  const writer = `did:demos:agent:${f.owner.slice(2)}`;
  return { read: () => adapter.read(f.logical, { expectedWriter: writer, signedProjection: f.valid }),
    verify: receipt => adapter.verifyReceipt({ receipt, logicalAddress: f.logical, artifact: f.artifact, expectedWriter: writer, signedProjection: f.valid }) };
}

test("two RPC endpoints on the same chain both verify, also in the client SR-2 adapter; changing the buyer's own endpoint invalidates only the buyer's authorization", async t => {
  const authority = createAuthorityFixture(), a = ownLocal;
  const b = { ...a, endpoint: 'https://identity-b.invalid/', transportAuthority: 'TEST-other-owner', connectionId: 'TEST-other-connection' };
  const first = await bindTp1Profile({ record, local: a, readAuthority: authority.read });
  const second = await bindTp1Profile({ record, local: b, readAuthority: authority.read });
  await assertTp1Binding(first, a); await assertTp1Binding(second, b);
  await assert.rejects(assertTp1Binding(first, { ...a, endpoint: b.endpoint }), { code: 'tp1_local_binding_changed' });
  await assertTp1Binding(second, b);
  for (const endpoint of [a.endpoint, b.endpoint]) {
    const adapter = adapterAt(t, endpoint), result = await adapter.read();
    assert.equal(result.status, 'present');
    assert.equal(await adapter.verify(result.receipt), 'valid');
  }
  for (const pins of [{ network: 'another-testnet' }, { chainIdentity: 'c'.repeat(64) }, { pinVersion: 'TEST-retired-pin' }]) {
    await assert.rejects(adapterAt(t, b.endpoint, pins).read(), { code: 'invalid' });
  }
});

test("a fresh observation from the buyer's RPC is compared with the record and never authorizes", async () => {
  const authority = createAuthorityFixture();
  const binding = await bindTp1Profile({ record, local: ownLocal, readAuthority: authority.read });
  const observation = await shared().binder.bind();
  assert.equal(observation.chainIdentity, record.chainIdentity);
  await assert.rejects(assertTp1Binding(observation, ownLocal), { code: 'tp1_binding_required' });
  authority.state.chainIdentity = 'c'.repeat(64);
  await assert.rejects(assertTp1Binding(binding, ownLocal), { code: 'tp1_connection_unverified' });
  const wrong = shared({ getBlock: () => ({ number: 0, status: 'confirmed', hash: 'c'.repeat(64) }) });
  await assert.rejects(wrong.binder.bind(), { code: 'identity_mismatch' });
});
