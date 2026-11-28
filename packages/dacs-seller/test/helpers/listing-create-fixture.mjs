// Unshipped test helper: the seller's own Listing CREATE request as the artifact anchor builds it, and a scripted-node reply that
// acknowledges a broadcast it never applies, so the CREATE reads back pending and its one resend stays open.
import { canonicalize, contentHash, listingAddress, logicalToStorageProgramName, sha256Hex } from '@kynesyslabs/dacs';
import { jsonResponse, T0 } from './seller-node-wallet-world.mjs';

const { buildStorageProgramCreatePayload, deriveStorageAddress } = await import('../../src/dacs/wallet-transactions.mjs');
const { DEVNET_AGREEMENT_PROFILE, DEVNET_DEMO_ARTIFACT_KIND, DEVNET_DEMO_ARTIFACT_POLICY } = await import('../../src/dacs/devnet-source.mjs');
const { fixtureListing } = await import('../fixtures/listings.mjs');

/** A node answer in the RPC envelope. */
export const rpc = (response, extra = null) => jsonResponse({ result: 200, response, require_reply: false, extra });

/**
 * A `node.reply` that acknowledges a broadcast it never applies. With `statusUnavailable` (while the CREATE is sent) its status read
 * fails, which ends the transport's inclusion wait at once; otherwise the status is unknown.
 */
export const pendingNode = ({ statusUnavailable }) => (row) => {
  const call = row.body?.params[0], message = call?.message || call?.extra;
  if (message === 'broadcastTx') return rpc({ hash: call.data.response.data.transaction.hash });
  if (message === 'getTransactionStatus') return statusUnavailable ? jsonResponse({ result: 500, response: 'TEST-unavailable', require_reply: false, extra: null }) : rpc({ state: 'unknown' }, '');
  if (message === 'getTxByHash') return jsonResponse({ result: 400, response: 'error', require_reply: false, extra: null });
  return undefined;
};

/** The `sendTransaction` request of `signer`'s Listing CREATE over `transport`, from `address` at `nonce`. */
export function listingCreateRequest({ transport, address, signer, nonce }) {
  const writer = signer.claim;
  const artifact = fixtureListing(signer, { now: T0 }), contentHashOf = contentHash(artifact), envelopeHash = sha256Hex(canonicalize(artifact));
  const logicalAddress = listingAddress(writer, artifact.listingId, artifact.listingVersion), programName = logicalToStorageProgramName(logicalAddress);
  const transaction = buildStorageProgramCreatePayload({ from: address, storageAddress: deriveStorageAddress(address, programName, nonce, ''), programName, logicalAddress,
    signedListing: artifact, nonce, timestamp: T0 });
  Object.assign(transaction.content, { from_ed25519_address: address, network: transport.pins.network, chainIdentity: transport.pins.chainIdentity });
  const jobId = `listing:${artifact.listingId}`;
  Object.assign(transaction.content.data[1].metadata, { contentHash: contentHashOf, envelopeHash, artifactKind: 'Listing', networkBinding: structuredClone(transport.transportBinding),
    artifactBinding: { version: '1', policy: DEVNET_DEMO_ARTIFACT_POLICY, authority: transport.demoArtifactPublication.authority, artifactKind: 'Listing', jobId, logicalAddress, writer } });
  return { method: 'sendTransaction', params: [{ kind: DEVNET_DEMO_ARTIFACT_KIND, profile: DEVNET_AGREEMENT_PROFILE, network: transport.pins.network, owner: writer,
    artifactKind: 'Listing', jobId, logicalAddress, contentHash: contentHashOf, envelopeHash, transaction }] };
}
