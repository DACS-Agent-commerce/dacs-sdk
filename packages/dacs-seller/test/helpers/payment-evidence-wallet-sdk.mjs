// The pinned demosdk (4.0.16) signing the payment-evidence storage CREATE, for
// the wallet journal tests: Demos.sign of the CREATE
// buildStorageProgramCreatePayload prepares, with the evidence metadata. Offline:
// the two node answers sign asks for (getNetworkInfo's denomination fork and
// getNetworkParameters' fee) are supplied in place of an RPC, so each fork's
// shape, with the node's fee or the SDK's own, is the SDK's real output.
import { register } from 'node:module';
import { canonicalize, logicalToStorageProgramName, sha256Hex } from '@kynesyslabs/dacs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../../src/dacs/wallet-transactions.mjs';

register(new URL('./demosdk-operations-resolve.mjs', import.meta.url));
const { Demos, GCRGeneration } = await import('@kynesyslabs/demosdk/websdk');
// Not a package export (the root barrel does not load in plain Node): the SDK's mirror of the node's content serializer.
const { serializeTransactionContent } = await import(new URL('../denomination/serializerGate.js', import.meta.resolve('@kynesyslabs/demosdk/websdk')).href);

// One test wallet for every chain and process (a crash child signs as its parent does).
const TEST_MASTER_SEED = new Uint8Array(128).fill(7);
const wallets = new Map();
function sdkWallet(postFork, nodeFee) {
  const key = JSON.stringify([postFork, nodeFee]);
  if (!wallets.has(key)) {
    wallets.set(key, (async () => {
      const demos = new Demos();
      await demos.connectWallet(TEST_MASTER_SEED, { algorithm: 'ed25519' });
      demos.rpc_url = 'http://TEST.invalid';
      demos.nodeCall = async (message) => (message === 'getNetworkInfo' ? { forks: { osDenomination: { activated: postFork } } }
        : message === 'getNetworkParameters' ? nodeFee : null);
      return demos;
    })());
  }
  return wallets.get(key);
}

export const SDK_WALLET_ADDRESS = (await sdkWallet(false, null)).getAddress();

// The public signed projection { hash, content, signature } of the evidence
// CREATE Demos.sign signs at nonce. postFork picks the node's denomination fork;
// nodeFee is getNetworkParameters' { networkFee, rpcFee } (null: the SDK sums
// its own fee from the edits). prepare(content) changes the CREATE before it is
// signed, as an operator's signer may (the SR-2 source binding).
export async function sdkSignedCreate(input, { nonce, timestamp, artifact = input.artifact, postFork = false, nodeFee = null, prepare } = {}) {
  const from = SDK_WALLET_ADDRESS, programName = logicalToStorageProgramName(input.logicalAddress);
  const storageAddress = deriveStorageAddress(from, programName, nonce, '');
  const tx = buildStorageProgramCreatePayload({ from, storageAddress, programName, logicalAddress: input.logicalAddress, signedListing: artifact, nonce, timestamp });
  tx.content.data[1].metadata = { logicalAddress: input.logicalAddress, contentHash: input.receiptContentHash,
    envelopeHash: sha256Hex(canonicalize(artifact)), artifactKind: input.artifactKind, ...(input.deliveryBinding ? { deliveryBinding: input.deliveryBinding } : {}) };
  prepare?.(tx.content);
  const { hash, content, signature } = await (await sdkWallet(postFork, nodeFee)).sign(tx, { nonce });
  return { hash, content, signature };
}

// A hostile signer's projection: content the SDK did not produce, hashed and
// signed by the same wallet the way Demos.sign hashes and signs.
export async function resignedProjection(content) {
  const hash = sha256Hex(JSON.stringify(content));
  return { hash, content, signature: await (await sdkWallet(false, null)).signMessage(hash) };
}

// The node's view of signed content, by the code the SDK shares with it: the
// content is already its fork's wire form (the bytes the node hashes,
// serializerGate), and its gcr_edits are the ones GCRGeneration regenerates
// from it. False when either differs or the content cannot be read.
export async function sdkRegeneratesSignedCreate(content) {
  try {
    const postFork = typeof content.amount === 'string', wire = serializeTransactionContent(content, postFork);
    const edits = await GCRGeneration.generate({ content: JSON.parse(wire), hash: '' });
    return wire === JSON.stringify(content) && serializeTransactionContent({ ...content, gcr_edits: edits }, postFork) === wire;
  } catch { return false; }
}
