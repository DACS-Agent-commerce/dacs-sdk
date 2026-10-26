import { canonicalize, contentHash, logicalToStorageProgramName, sha256Hex } from '@kynesyslabs/dacs';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal, DEMOS_SR2_FIXTURE_CHAIN_IDENTITY as identity } from '../../src/dacs/demos-sr2-adapter.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../../src/dacs/wallet-transactions.mjs';
import { seller, NOW, JOB } from './protocol-fixture.mjs';

export function readbackFixture(options = {}) {
  const logicalAddress = options.logicalAddress ?? `dacs4:deliverable:${JOB}`, artifact = options.artifact ?? { report: 'TEST storage readback' };
  const programName = logicalToStorageProgramName(logicalAddress);
  const nativeAddress = deriveStorageAddress(seller.address, programName, 1);
  const signed = buildStorageProgramCreatePayload({ from: seller.address, storageAddress: nativeAddress, programName, logicalAddress, signedListing: artifact, nonce: 1, timestamp: NOW });
  signed.content.from_ed25519_address = seller.address;
  signed.content.data[1].metadata = { logicalAddress, artifactKind: 'Deliverable', contentHash: contentHash(artifact), envelopeHash: sha256Hex(canonicalize(artifact)) };
  Object.assign(signed.content.data[1].metadata, options.metadata);
  if (signed.content.data[1].metadata.artifactKind === undefined) delete signed.content.data[1].metadata.artifactKind;
  signed.hash = sha256Hex(JSON.stringify(signed.content));
  signed.signature = { type: 'ed25519', data: `0x${seller.signBytes(Buffer.from(signed.hash)).toString('hex')}` };
  const tx = { ...structuredClone(signed), status: 'confirmed', blockNumber: 1 };
  const native = { success: true, storageAddress: nativeAddress, owner: seller.address, programName, data: structuredClone(artifact), metadata: structuredClone(signed.content.data[1].metadata), createdByTx: signed.hash, interactionTxs: [signed.hash] };
  const block = { number: 1, status: 'confirmed', hash: sha256Hex('TEST SR2 block'), content: { timestamp: NOW / 1000, ordered_transactions: [signed.hash] }, validation_data: { simulated: true, chainIdentity: identity } };
  const state = { signed, tx, native, block, rows: [{ programName, storageAddress: nativeAddress }], calls: [] };
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    state.calls.push({ path, init });
    if (options.respond) { const value = await options.respond(url, init, state); if (value !== undefined) return value; }
    let response;
    if (path.startsWith('/storage-program/')) response = state.native;
    else {
      const { message, data } = JSON.parse(init.body).params[0];
      const values = { getTxByHash: state.tx, searchStoragePrograms: state.rows, getAddressNonce: 0 };
      response = { result: 200, response: message === 'getBlockByNumber' ? data.blockNumber === 0 ? { number: 0, status: 'confirmed', hash: identity } : state.block : values[message] };
    }
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json', 'x-dacs-simulation': 'fixture' } });
  };
  const journal = options.journal ?? createInMemoryDemosSr2Journal();
  const adapter = createDemosSr2Adapter({ rpcUrl: 'http://127.0.0.1:9922/', journal, fetchImpl, now: () => NOW, ...options.adapter });
  return { ...state, state, adapter, journal, fetchImpl, logicalAddress, artifact, expectedWriter: seller.claim };
}
