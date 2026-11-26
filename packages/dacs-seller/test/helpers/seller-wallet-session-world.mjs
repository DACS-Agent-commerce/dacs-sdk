// Unshipped test helper: the seller's production wallet-session port over the client's scripted TP-1 node, with the fixture
// mnemonic's key and a signer from the same key. The world opens the host's real stages over the port and finalizes them under
// the real seller state lock in a private directory, which is the host's own call of the port's finalize. The client's purchase
// hold is lifted through its test hook for the test, as sellerWalletWorld does.
import { createPrivateKey, sign as signWithKey } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACT_JOURNAL, COMPOSITION_JOURNAL, ENDPOINT, FIXTURE_MNEMONIC, T0, keyRecordBytes, privateDataDirectory, replayNode, sellerApproval,
  sellerPublications, setPurchaseAdmission } from './seller-node-wallet-world.mjs';

const { createSellerWalletSession } = await import('../../src/devnet-demo/seller-wallet-session.mjs');
const { openSellerStages } = await import('../../src/dacs/host-stages.mjs');
const { acquireSellerStateLock } = await import('../../src/devnet-demo/seller-state-lock.mjs');
const { deriveWalletIdentity } = await import('../../src/cli/node-identity.mjs');
const { enrollment } = await import('./kit-wallet-session.mjs');

export { createSellerWalletSession };
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const NODE_AUTHORITY = 'vector-authority';
/** The Listing pin the world's stages are opened with. */
export const LISTING_PIN = Object.freeze({ listingId: 'TEST-listing', version: 1, contentHash: 'c'.repeat(64) });
/** The node's execute stages: each confirmTx and broadcastTx body the world's node received. */
export const EXECUTE_STAGES = Object.freeze(['confirmTx', 'broadcastTx']);

/** The signer `{ claim, sign, signBytes }` of `mnemonic` (the fixture's by default), from the key `init` derives. */
export async function mnemonicSigner(mnemonic = FIXTURE_MNEMONIC) {
  const identity = await deriveWalletIdentity(mnemonic);
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, identity.privateKey.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
  identity.privateKey.fill(0);
  const signBytes = (bytes) => signWithKey(null, bytes, key);
  return { claim: identity.claim, sign: signBytes, signBytes };
}

/** True when every byte `value` (a Uint8Array, another ArrayBuffer view or an ArrayBuffer) holds is 0. */
export const allZero = (value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).every((byte) => byte === 0);

/**
 * The port's options over `node` with the fixture key: `loadKeyRecord` is the given one. `overrides` replace any option; a key set to
 * `undefined` is left out.
 */
export async function portOptions(node, loadKeyRecord, overrides = {}) {
  const options = { endpoint: ENDPOINT, transportAuthority: NODE_AUTHORITY, fetchImpl: node.fetch, signer: await mnemonicSigner(), loadKeyRecord, approve: sellerApproval(),
    approvalMode: 'policy', journalMode: 'create', publications: sellerPublications(), clock: { now: () => T0 }, ...overrides };
  for (const [name, value] of Object.entries(options)) if (value === undefined) delete options[name];
  return options;
}

/**
 * Builds the production port over the client's scripted node (`replayNode`) in `directory` (a new private one by default), opens the
 * host's stages over it and takes the seller state lock. Resolves the world:
 * - `port`, `stages`, `node`, `directory`, `stateLock` (the lock the host passes), `signer`;
 * - `returnedKeys`: every value `loadKeyRecord` returned, and `keyLoads`: how often it was called;
 * - `finalize()`: the host's `stages.finalize({ dataDirectory, stopped, stateLock })`;
 * - `issuanceJournals()`: the issuance journals present in the directory; `executeStages()`: the node's execute stages so far.
 * Seams: `keyBytes()` is what `loadKeyRecord` returns (or throws); with `gateKeyLoad` it waits for `world.releaseKeyLoad()` and
 * `world.keyLoadStarted` resolves when it is called; with `closeInsideWalletBuild` the lock's `held()` closes the port on its first
 * call after `loadKeyRecord` returned, then answers the real value; `nodeScript(row)` answers the node's requests after the binding;
 * `createPort(options)` builds the port (`createSellerWalletSession` by default). With `countAuthority`, the stages are opened over
 * a frozen delegate of the port whose `connectionAuthority` adds one to `world.authorityReads` on each call, so every authority
 * read through the stages' binding is counted.
 * `t.after` closes the stages and releases the lock.
 */
export async function walletSessionWorld(t, { directory = privateDataDirectory(t), node = replayNode(), keyBytes = () => keyRecordBytes(), gateKeyLoad = false,
  closeInsideWalletBuild = false, nodeScript = null, options = {}, createPort = createSellerWalletSession, countAuthority = false } = {}) {
  setPurchaseAdmission('testnet-tp1');
  const world = { node, directory, returnedKeys: [], keyLoads: 0 };
  let keyReturned = false, closedInBuild = false, started;
  world.keyLoadStarted = new Promise((resolve) => { started = resolve; });
  const gate = gateKeyLoad ? new Promise((resolve) => { world.releaseKeyLoad = resolve; }) : null;
  const loadKeyRecord = async () => {
    world.keyLoads += 1;
    started();
    await gate;
    const bytes = keyBytes();
    if (typeof bytes === 'object' && bytes !== null) world.returnedKeys.push(bytes);
    keyReturned = true;
    return bytes;
  };
  world.options = await portOptions(node, loadKeyRecord, options);
  world.signer = world.options.signer;
  world.port = createPort(world.options);
  world.authorityReads = 0;
  const { authority, connectionAuthority, artifactAnchor, finalize, close } = world.port;
  const walletSession = !countAuthority ? world.port : Object.freeze({ authority, artifactAnchor, finalize, close,
    connectionAuthority: (...args) => { world.authorityReads += 1; return connectionAuthority(...args); } });
  world.stages = await openSellerStages({ walletSession, participantImplementations: enrollment(), sellerClaim: world.signer.claim, listingPin: LISTING_PIN,
    retainedJob: () => null, maxConcurrent: 1 });
  if (nodeScript) node.reply = nodeScript;
  const lock = await acquireSellerStateLock(directory);
  t.after(async () => { setPurchaseAdmission('held'); try { await world.stages.close(); } finally { lock.release(); } });
  world.lock = lock;
  world.stateLock = !closeInsideWalletBuild ? lock : { path: lock.path, release: () => lock.release(), held: () => {
    if (keyReturned && !closedInBuild) { closedInBuild = true; world.port.close(); }
    return lock.held();
  } };
  // The stop check is synchronous: the session's payment-evidence adapter reads it before each approval ask.
  world.finalize = (stopped = () => false) => world.stages.finalize({ dataDirectory: directory, stopped, stateLock: world.stateLock });
  world.issuanceJournals = () => [COMPOSITION_JOURNAL, ARTIFACT_JOURNAL].filter((name) => existsSync(join(directory, name)));
  world.executeStages = () => node.reads.filter((read) => EXECUTE_STAGES.includes(read)).length;
  return world;
}
