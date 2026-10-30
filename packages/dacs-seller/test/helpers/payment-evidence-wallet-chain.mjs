// A seller wallet over one account on a chain with the node's nonce rule
// (node 61b8e75 validateTransaction: a nonce not above the account's is never
// executed), for the payment-evidence wallet journal. signCreate answers the
// public signed projection { hash, content, signature } of the storage CREATE
// the pinned demosdk signs (helpers/payment-evidence-wallet-sdk.mjs);
// `land(hash)` executes a broadcast transaction only while its nonce is above
// the account nonce, and `other()` lands another write from the same account.
// With `file`, the chain is kept in that JSON file after every change, so a
// process killed at any step leaves it for the next process (a crash test).
import { readFileSync, writeFileSync } from 'node:fs';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { resignedProjection, SDK_WALLET_ADDRESS, sdkSignedCreate } from './payment-evidence-wallet-sdk.mjs';

export const evidenceInput = (writer, extra = {}) => ({ logicalAddress: 'dacs4:payment:TEST-job:demos-native:DEM:2', artifact: { TEST: 'evidence' }, writer,
  artifactKind: 'SettlementEvidence', jobId: 'TEST-job', receiptContentHash: 'e1'.repeat(32), ...extra });

// What the agent asks a Deliverable journal about: the report, its canonical hash and its fulfilment binding.
const DELIVERABLE_JOB = '01J8N4YV7YVYQ4DB7M8T4C7W0A';
const DELIVERABLE_REPORT = { reportVersion: '1', kind: 'TEST/report', jobId: DELIVERABLE_JOB, body: ['TEST report'] };
export const deliverableInput = (writer, extra = {}) => ({ logicalAddress: `dacs4:deliverable:${DELIVERABLE_JOB}`, report: DELIVERABLE_REPORT, writer,
  jobId: DELIVERABLE_JOB, receiptContentHash: sha256Hex(canonicalize(DELIVERABLE_REPORT)),
  deliveryBinding: { version: '1', jobId: DELIVERABLE_JOB, fulfilmentId: 'f1'.repeat(32), payloadHash: sha256Hex(canonicalize(DELIVERABLE_REPORT)) }, ...extra });

export function newWalletChainState() {
  return { accountNonce: 0, nextNonce: 1, timestamp: 1, signed: {}, applied: [], pending: [] };
}

export function walletChain({ state = newWalletChainState(), file = null } = {}) {
  const chain = file ? JSON.parse(readFileSync(file, 'utf8')) : state;
  const save = () => { if (file) writeFileSync(file, JSON.stringify(chain)); };
  save();
  const address = SDK_WALLET_ADDRESS, claim = `did:demos:agent:${address.slice(2)}`;
  // `change` picks what the SDK signs ({ nonce, artifact, postFork, nodeFee,
  // prepare }: see sdkSignedCreate), or alters it as a hostile wallet would:
  // `edit(content)` changes the SDK's signed content, which is then hashed and
  // signed again; `signature` replaces the signature; `wrap(signed)` changes the
  // signed projection; `txHash` and `claimedNonce` change what the answer claims.
  const signCreate = async (input, change = {}) => {
    const nonce = change.nonce ?? chain.nextNonce++;
    let projection = await sdkSignedCreate(input, { ...change, nonce, timestamp: chain.timestamp++ });
    if (change.edit) { change.edit(projection.content); projection = await resignedProjection(projection.content); }
    if (change.signature) projection.signature = { type: 'ed25519', data: change.signature };
    const signed = change.wrap ? change.wrap(projection) : projection;
    chain.signed[projection.hash] = projection.content.nonce;
    save();
    return { signedTransaction: JSON.stringify(signed), txHash: change.txHash ?? projection.hash, nonce: change.claimedNonce ?? projection.content.nonce };
  };
  const land = (hash) => {
    const nonce = chain.signed[hash];
    if (nonce !== undefined && !chain.applied.includes(hash) && nonce > chain.accountNonce) { chain.applied.push(hash); chain.accountNonce = nonce; save(); }
  };
  const other = () => { chain.accountNonce = Math.max(chain.accountNonce, chain.nextNonce); chain.nextNonce = chain.accountNonce + 1; save(); };
  const transactionState = (hash) => (chain.applied.includes(hash) ? 'applied' : chain.pending.includes(hash) ? 'pending' : 'absent');
  return { chain, address, claim, signCreate, land, other, transactionState, accountNonce: () => chain.accountNonce, save };
}
