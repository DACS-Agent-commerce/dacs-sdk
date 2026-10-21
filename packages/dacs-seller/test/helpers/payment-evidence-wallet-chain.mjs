// A seller wallet over one account on a chain with the node's nonce rule
// (node 61b8e75 validateTransaction: a nonce not above the account's is never
// executed), for the payment-evidence wallet journal. signCreate answers the
// Demos signed storage CREATE { hash, content, signature } the journal checks;
// `land(hash)` executes a broadcast transaction only while its nonce is above
// the account nonce, and `other()` lands another write from the same account.
// With `file`, the chain is kept in that JSON file after every change, so a
// process killed at any step leaves it for the next process (a crash test).
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../../src/dacs/wallet-transactions.mjs';
import { canonicalize, logicalToStorageProgramName, sha256Hex } from '@kynesyslabs/dacs';

export const evidenceInput = (writer, extra = {}) => ({ logicalAddress: 'dacs4:payment:TEST-job:demos-native:DEM:2', artifact: { TEST: 'evidence' }, writer,
  artifactKind: 'SettlementEvidence', jobId: 'TEST-job', receiptContentHash: 'e1'.repeat(32), ...extra });

// A new chain state with a fresh Ed25519 wallet key (kept only in the state).
export function newWalletChainState() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { key: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), accountNonce: 0, nextNonce: 1, timestamp: 1, signed: {}, applied: [], pending: [] };
}

export function walletChain({ state = newWalletChainState(), file = null } = {}) {
  const chain = file ? JSON.parse(readFileSync(file, 'utf8')) : state;
  const save = () => { if (file) writeFileSync(file, JSON.stringify(chain)); };
  save();
  const privateKey = createPrivateKey({ key: Buffer.from(chain.key, 'base64'), format: 'der', type: 'pkcs8' });
  const raw = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  const address = `0x${raw}`, claim = `did:demos:agent:${raw}`;
  const signHash = (hash) => `0x${sign(null, Buffer.from(hash, 'utf8'), privateKey).toString('hex')}`;
  // `change` alters what is signed or what the answer claims (a hostile wallet):
  // `edit(content)` changes the content before it is hashed and signed, and
  // `wrap(signed)` the signed transaction after it is signed.
  const signCreate = (input, change = {}) => {
    const nonce = change.nonce ?? chain.nextNonce++, programName = logicalToStorageProgramName(input.logicalAddress);
    const from = change.from ?? address, storageAddress = deriveStorageAddress(from, programName, nonce, '');
    const artifact = change.artifact ?? input.artifact;
    const { content } = buildStorageProgramCreatePayload({ from, storageAddress, programName, logicalAddress: input.logicalAddress,
      signedListing: artifact, nonce, timestamp: chain.timestamp++ });
    content.data[1].metadata = { logicalAddress: input.logicalAddress, contentHash: input.receiptContentHash, envelopeHash: sha256Hex(canonicalize(artifact)), artifactKind: input.artifactKind };
    content.from_ed25519_address = from;
    change.edit?.(content);
    const hash = sha256Hex(JSON.stringify(content));
    const projection = { hash, content, signature: { type: 'ed25519', data: change.signature ?? signHash(hash) } };
    const signed = change.wrap ? change.wrap(projection) : projection;
    chain.signed[hash] = content.nonce;
    save();
    return { signedTransaction: JSON.stringify(signed), txHash: change.txHash ?? hash, nonce: change.claimedNonce ?? content.nonce };
  };
  const land = (hash) => {
    const nonce = chain.signed[hash];
    if (nonce !== undefined && !chain.applied.includes(hash) && nonce > chain.accountNonce) { chain.applied.push(hash); chain.accountNonce = nonce; save(); }
  };
  const other = () => { chain.accountNonce = Math.max(chain.accountNonce, chain.nextNonce); chain.nextNonce = chain.accountNonce + 1; save(); };
  const transactionState = (hash) => (chain.applied.includes(hash) ? 'applied' : chain.pending.includes(hash) ? 'pending' : 'absent');
  return { chain, address, claim, signCreate, land, other, transactionState, accountNonce: () => chain.accountNonce, save };
}
