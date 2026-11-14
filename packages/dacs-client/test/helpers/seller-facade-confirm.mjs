import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { contentHash, listingAddress, logicalToStorageProgramName } from '@kynesyslabs/dacs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../../src/dacs/wallet-transactions.mjs';
import { STORAGE_WRITE_SUBMISSION_PROFILE } from '../../src/devnet-demo/storage-write-recovery.mjs';
import { fixtureListing } from '../fixtures/listings.mjs';
import { api, mnemonicBytes } from './tp1-node-fixture.mjs';

/** Returns the lower-case hex SHA-256 of `value`. */
export const sha = value => createHash('sha256').update(value).digest('hex');

/** Returns an independent signer for the wallet world `w`: {address, claim, signBytes(bytes)}. */
export async function signingWallet(w) {
  const { Demos } = await (await import('../../src/wallet/node-demos-loading.mjs')).loadNodeDemos();
  const demos = new Demos();
  await demos.connectWallet(new TextDecoder().decode(mnemonicBytes()));
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(demos.keypair.privateKey).subarray(0, 32)]), format: 'der', type: 'pkcs8' });
  const address = '0x' + Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('hex');
  assert.equal(address, w.session.wallet.getPublicAccount().address);
  return { address, claim: 'did:demos:agent:' + address.slice(2), signBytes: bytes => sign(null, bytes, key) };
}

/** Returns a copy of `payload` hashed and signed by `wallet`. */
export function signedTransaction(wallet, payload) {
  const tx = structuredClone(payload);
  tx.hash = sha(JSON.stringify(tx.content));
  tx.signature = { type: 'ed25519', data: '0x' + wallet.signBytes(Buffer.from(tx.hash)).toString('hex') };
  return tx;
}

/** Returns an own Listing storage CREATE for the seller composition `w`, signed by `wallet`. */
export function listingCreate(w, wallet) {
  const artifact = fixtureListing(wallet, { now: w.clock.now() });
  artifact.seller.publicEndpoint = 'https://seller.example.invalid/agent';
  // Re-sign the fixture after changing its endpoint to the reserved test domain.
  const { signature, ...unsigned } = artifact;
  artifact.signature = { ...signature, value: wallet.signBytes(Buffer.from('dacs-listing:v1:' + contentHash(unsigned))).toString('base64url') };
  const logicalAddress = listingAddress(wallet.claim, artifact.listingId, artifact.listingVersion), programName = logicalToStorageProgramName(logicalAddress);
  const tx = buildStorageProgramCreatePayload({ from: wallet.address, storageAddress: deriveStorageAddress(wallet.address, programName, 1, ''), programName, logicalAddress, signedListing: artifact, nonce: 1, timestamp: w.clock.now() });
  const f = w.session.transport;
  Object.assign(tx.content, { network: f.pins.network, chainIdentity: f.pins.chainIdentity });
  Object.assign(tx.content.data[1].metadata, { artifactKind: 'Listing', contentHash: contentHash(artifact), networkBinding: f.transportBinding,
    artifactBinding: { version: '1', policy: api.DEVNET_DEMO_ARTIFACT_POLICY, authority: f.demoArtifactPublication.authority, artifactKind: 'Listing', jobId: `listing:${artifact.listingId}`, logicalAddress, writer: wallet.claim } });
  return signedTransaction(wallet, tx);
}

/** Takes the signature lease through the held facade and sends `tx` to confirmTx; resolves {answer, lease}. */
export async function confirmThroughFacade(w, wallet, tx) {
  const f = w.session.transport, address = wallet.address;
  const { binding } = await f.binding({ phase: 'bind', address });
  const lease = await f.binding({ phase: 'signature', address, binding });
  const identity = 'ed25519:' + address, timestamp = String(w.clock.now() + 1);
  const headers = { identity, timestamp, signature: wallet.signBytes(Buffer.from(sha(`${identity}:${timestamp}`))).toString('hex') };
  const answer = await f.rpc({ method: 'execute', params: [{ extra: 'confirmTx', data: tx }] }, headers);
  return { answer, lease };
}

/** Retains `tx` in `w`'s journal as an accepted storage CREATE, the state the transport's recovery starts from. */
export async function retainAcceptedCreate(w, wallet, tx) {
  const { pins } = w.session.transport;
  const row = { hash: tx.hash, nonce: tx.content.nonce, stage: 'broadcast-accepted', signedTransaction: tx, networkBinding: await w.session.transport.observeBinding(),
    storageWriteSubmission: 'accepted', storageWriteSubmissionProfile: STORAGE_WRITE_SUBMISSION_PROFILE, storageWriteGas: null };
  await w.journal().put(`devnet/native-wallet/${JSON.stringify([pins.network, pins.chainIdentity, wallet.address])}`, row);
  await w.journal().put('devnet/native-transfer/' + tx.hash, row);
}
