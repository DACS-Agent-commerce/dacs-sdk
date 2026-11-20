// The scripted TP-1 world for the seller's Node wallet: the client's scripted node and authority fixture, the real seller
// state lock over a private temporary data directory, the client's recording payment-evidence ledger as `approve.retained`,
// and the key record `init` writes for the fixture mnemonic. The client's purchase hold is lifted through its test-only hook,
// which tp1-node-fixture.mjs installs before any client module loads, so every module that reaches the client is imported
// after it. The seller test runner's fixture loader admits the kit guard.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindTp1Profile, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { agreementRequest, api, finalization, mnemonicBytes, ok, scriptedNode, setPurchaseAdmission, T0 } from '../../../dacs-client/test/helpers/tp1-node-fixture.mjs';

const { createAuthorityFixture } = await import('../../../dacs-client/test/fixtures/tp1-authority-reader.mjs');
const { recordingApproval } = await import('../../../dacs-client/test/helpers/payment-evidence-approval-double.mjs');
const { createSellerNodeWallet } = await import('../../src/devnet-demo/seller-node-wallet.mjs');
const { acquireSellerStateLock } = await import('../../src/devnet-demo/seller-state-lock.mjs');
const { deriveWalletIdentity } = await import('../../src/cli/node-identity.mjs');
const { SELLER_ISSUANCE_JOURNALS } = await import('../../src/devnet-demo/operator-approval.mjs');

export { api, createSellerNodeWallet, finalization, ok, setPurchaseAdmission, T0 };
/** The two client durable journals the wallet opens in its data directory: the composition's and the artifact anchor's. */
export const [COMPOSITION_JOURNAL, ARTIFACT_JOURNAL] = SELLER_ISSUANCE_JOURNALS;
export const ENDPOINT = 'https://rpc.example.invalid/';
const PASS_WINDOW_MS = 10_000;
export const FIXTURE_MNEMONIC = new TextDecoder().decode(mnemonicBytes());

/** The `dacs-seller-key/v1` record bytes `init` writes for `mnemonic`. */
export const keyRecordBytes = (mnemonic = FIXTURE_MNEMONIC) => new TextEncoder().encode(JSON.stringify({ format: 'dacs-seller-key/v1', algorithm: 'ed25519', mnemonic }));

let derivedClaim;
/** The fixture mnemonic's claim, derived by the kit's own derivation (`init`'s), as the opened seller key reports it. */
export async function fixtureClaim() {
  if (!derivedClaim) {
    const identity = await deriveWalletIdentity(FIXTURE_MNEMONIC);
    identity.privateKey.fill(0);
    derivedClaim = identity.claim;
  }
  return derivedClaim;
}

/** A private (0700) temporary data directory, removed after the test. */
export function privateDataDirectory(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-seller-node-wallet-')));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Fixture publications for the seller composition. */
export const sellerPublications = () => ({
  settlementPublication: { artifactKind: 'SettlementEvidence', authority: 'TEST-seller-settlement', phase: 'pay-dem', phaseIndex: 2, policy: api.DEVNET_SETTLEMENT_POLICY, railId: 'demos-native:DEM' },
  deliveryPublication: { artifactKind: 'Deliverable', authority: 'TEST-seller-delivery', phase: 'deliver-storage-program', phaseIndex: 3, policy: api.DEVNET_DELIVERY_POLICY },
  demoArtifactPublication: { authority: 'TEST-RUN-seller-node-wallet-0001', policy: api.DEVNET_DEMO_ARTIFACT_POLICY, artifactKinds: [...api.DEVNET_DEMO_ARTIFACT_TYPES] },
});

const answer = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
// The serving node's answer to a valid confirmTx of `tx`.
const confirmation = tx => ok({ data: { valid: true, reference_block: 1, message: 'TEST-valid', gas_operation: null, transaction: tx },
  signature: { type: 'ed25519', data: `0x${'5'.repeat(128)}` }, rpc_public_key: { type: 'ed25519', data: `0x${'6'.repeat(64)}` } });

/**
 * The client's scripted node, answering confirmTx as the serving node does and applying each broadcast. `node.reply(row)`, when
 * set, answers a request first (a Response, or a promise of one); `node.reads` lists each nodeCall message and execute stage in order.
 * With `stateFile`, the chain (nonce, applied transactions, confirmations and broadcasts) is read from it first and written to it
 * after each confirmation, broadcast and application, so a process killed at any request leaves what it sent.
 */
export function replayNode(stateFile) {
  const node = scriptedNode();
  node.reply = null; node.reads = [];
  if (stateFile && existsSync(stateFile)) {
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
    node.nonce = saved.nonce; node.confirms.push(...saved.confirms); node.broadcasts.push(...saved.broadcasts);
    for (const tx of saved.applied) node.applied.set(tx.hash, tx);
  }
  node.save = () => { if (stateFile) writeFileSync(stateFile, JSON.stringify({ nonce: node.nonce, applied: [...node.applied.values()], confirms: node.confirms, broadcasts: node.broadcasts })); };
  // The scripted node calls intercept in the same step as fetch, so the signal recorded here is that request's.
  const fetch = node.fetch;
  let signal;
  node.fetch = (url, init) => { signal = init?.signal; return fetch(url, init); };
  node.intercept = async row => {
    row.signal = signal;
    const call = row.body?.params[0];
    if (!call) return undefined;
    node.reads.push(call.message || call.extra);
    if (call.extra === 'confirmTx') { node.confirms.push(structuredClone(call.data)); node.save(); }
    if (call.extra === 'broadcastTx') { node.broadcasts.push(structuredClone(call.data.response.data.transaction)); node.save(); }
    const changed = await node.reply?.(row);
    if (changed) return changed;
    if (call.extra === 'confirmTx') return answer(confirmation(call.data));
    if (call.extra === 'broadcastTx') {
      const tx = call.data.response.data.transaction;
      node.applied.set(tx.hash, structuredClone(tx)); node.nonce = tx.content.nonce; node.save();
      return answer(ok({ hash: tx.hash }));
    }
    return undefined;
  };
  return node;
}

/** The recording ledger double, its entries and settlements read from `stateFile` and written back after each change (`save()` writes now). */
export function persistedApproval(stateFile) {
  const approval = recordingApproval();
  if (existsSync(stateFile)) {
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
    approval.entries.push(...saved.entries);
    for (const [ledgerId, outcome] of saved.settled) approval.settled.set(ledgerId, outcome);
  }
  approval.save = () => writeFileSync(stateFile, JSON.stringify({ entries: approval.entries, settled: [...approval.settled] }));
  for (const name of ['prepare', 'settle']) {
    const inner = approval[name];
    approval[name] = async (...args) => { try { return await inner(...args); } finally { approval.save(); } };
  }
  return approval;
}

/**
 * Counts the inner transaction signatures of every Node composition built after the call, through `mocker` (a test's `t.mock`
 * or node:test's `mock`): the result lists the nonce of each transaction a composition's Demos signed. `onSigned(transaction)`
 * runs after each one.
 */
export async function spyTransactionSignatures(mocker, onSigned = () => {}) {
  const { Demos } = await (await import('../../../dacs-client/src/wallet/node-demos-loading.mjs')).loadNodeDemos();
  const spied = new WeakSet(), signatures = [], connectWallet = Demos.prototype.connectWallet;
  mocker.method(Demos.prototype, 'connectWallet', function spyConnectWallet(...args) {
    const prototype = Object.getPrototypeOf(this);
    if (prototype !== Demos.prototype && !spied.has(prototype)) {
      spied.add(prototype);
      const sign = prototype.sign;
      prototype.sign = async function spySign(transaction, ...rest) {
        const signed = await Reflect.apply(sign, this, [transaction, ...rest]);
        signatures.push(transaction.content.nonce);
        await onSigned(transaction);
        return signed;
      };
    }
    return Reflect.apply(connectWallet, this, args);
  });
  return signatures;
}

/** Answers `message` (a nodeCall message or an execute stage) with `respond(row)` and lets every other request through. */
export const replyTo = (node, message, respond) => { node.reply = row => ((row.body?.params[0].message || row.body?.params[0].extra) === message ? respond(row) : undefined); };
export const jsonResponse = answer;

/** Connects an owner to `node` and binds the TP-1 admission through the authority fixture. */
export async function nodeConnection(node = replayNode()) {
  const owner = api.createNodeTransportOwner({ endpoint: ENDPOINT, transportAuthority: 'vector-authority', fetchImpl: node.fetch });
  const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: owner.currentLocal(), readAuthority: createAuthorityFixture().read });
  return { node, owner, admission: { binding, currentLocal: owner.currentLocal } };
}

/** The composed seller approval double: `retained` is the ledger (the recording one by default); `confirm` records each confirmed write and approves it. */
export function sellerApproval(retained = recordingApproval()) {
  const approve = async () => true;
  approve.confirmed = [];
  approve.confirm = async validity => { approve.confirmed.push(validity); return true; };
  approve.retained = retained;
  return approve;
}

/** The options of a first start over `connection` in `directory`, holding `stateLock`; `overrides` replace any of them. */
export async function walletOptions({ connection, directory, stateLock, ...overrides }) {
  return { admission: connection.admission, owner: connection.owner, dataDirectory: directory, journalMode: 'create', stateLock, signer: { claim: await fixtureClaim() },
    keyRecord: keyRecordBytes(), approve: sellerApproval(), approvalMode: 'policy', clock: { now: () => T0 }, publications: sellerPublications(), ...finalization, ...overrides };
}

/**
 * Builds a seller Node wallet over a fresh scripted node in `directory` (a new private one by default). `t.after` closes the
 * wallet, the owner and the lock, and holds the client again. `restart()` closes the wallet and builds it again over the same
 * files, lock and node.
 */
export async function sellerWalletWorld(t, { held = false, directory = privateDataDirectory(t), node = replayNode(), options = {} } = {}) {
  setPurchaseAdmission(held ? 'held' : 'testnet-tp1');
  const connection = await nodeConnection(node), stateLock = await acquireSellerStateLock(directory), diagnostics = [];
  const built = await walletOptions({ connection, directory, stateLock, diagnostics: entry => diagnostics.push(entry), ...options });
  const world = { ...connection, directory, stateLock, diagnostics, options: built, approve: built.approve, approval: built.approve.retained };
  world.wallet = await createSellerNodeWallet(built);
  world.restart = async () => {
    await world.wallet.close();
    world.wallet = await createSellerNodeWallet({ ...built, journalMode: 'open', keyRecord: keyRecordBytes() });
  };
  t.after(async () => { setPurchaseAdmission('held'); await world.wallet.close(); await connection.owner.close(); stateLock.release(); });
  return world;
}

/** Runs `work` inside one effect pass of the wallet's composition, opened as an effect-boundary host does. */
export async function inWalletPass(world, work, pass = {}) {
  const lease = await world.owner.acquireConnectionFence();
  try {
    const handle = world.wallet.effectPass({ fence: lease, deadline: T0 + PASS_WINDOW_MS, refreshAuthority() {}, finalStop() {}, synchronousChecks: [],
      feeCeilingOs: finalization.feeCeilingOs, context: api.passContext({ operationClass: 'payment-evidence', currentAuthorization: () => true }), ...pass });
    return await world.wallet.runInEffectPass(handle, work);
  } finally { lease.release(); }
}

const CHILD = new URL('./seller-node-wallet-child.mjs', import.meta.url);
const CHILD_TIMEOUT_MS = 120_000;

/**
 * Runs seller-node-wallet-child.mjs in MODE and resolves `{code, signal, stdout, stderr}` once it exits. With `killWhenReady`,
 * the child is killed (SIGKILL) once it prints `ready`. Rejects when the child neither exits nor gets ready in time.
 */
export function runWalletChild(mode, directory, stateDirectory, { journalMode = 'create', killWhenReady = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(CHILD), mode, directory, stateDirectory, journalMode], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`the child ${mode} did not finish\n${stderr}`)); }, CHILD_TIMEOUT_MS);
    child.stdout.on('data', chunk => { stdout += chunk; if (killWhenReady && stdout.includes('ready\n')) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

/** Builds the wallet again over the files a killed child left: the same directory, chain and approval ledger, journals opened. */
export const restartedWorld = (t, directory, stateDirectory) => sellerWalletWorld(t, { directory, node: replayNode(join(stateDirectory, 'chain.json')),
  options: { journalMode: 'open', approve: sellerApproval(persistedApproval(join(stateDirectory, 'approval.json'))) } });

/** A payment-evidence anchor input written by the wallet's own address. */
export const evidenceInput = (world, label = 'a') => ({ logicalAddress: `dacs4:payment:TEST-job-${label}:demos-native:DEM:2`, artifact: { TEST: `evidence-${label}` },
  writer: `did:demos:agent:${world.wallet.address.slice(2)}`, artifactKind: 'SettlementEvidence', jobId: `TEST-job-${label}`, receiptContentHash: 'e1'.repeat(32) });

// Requests through the composed walletFactory, for the approval accounting suites.
export const JOB_CREATE = () => api.passContext({ operationClass: 'job-create', currentAuthorization: () => true });

/**
 * The seller approval double: it accepts every request after `gate(request)` resolves (or rejects), and `settle` records each
 * outcome, or throws `failure` when one is given.
 */
export function settlingApproval({ failure, gate = async () => {} } = {}) {
  const base = sellerApproval();
  const approve = async request => { await gate(request); approve.accepted.push(request); return true; };
  Object.assign(approve, { accepted: [], settled: [], confirm: base.confirm, retained: base.retained });
  approve.settle = async (request, outcome) => {
    if (failure) throw failure;
    approve.settled.push({ request, outcome });
  };
  return approve;
}
// The settlements of the transactions the wallet wrote; the message signature that precedes each is settled apart.
export const writesOf = approve => approve.settled.filter(({ request }) => request.method === 'sendTransaction');
export const outcomes = world => writesOf(world.approve).map(({ outcome }) => outcome);
export const settlingWorld = (t, { approve = settlingApproval(), ...options } = {}) => sellerWalletWorld(t, { options: { approve, ...options } });

/** An artifact CREATE request built through the walletFactory over `factoryOptions` (the artifact journal by default), and the wallet to send it with. */
export async function preparedWrite(world, factoryOptions = { anchorJournal: world.wallet.artifactJournal }) {
  const wallet = world.wallet.walletFactory(factoryOptions);
  return { wallet, request: await agreementRequest({ session: { wallet }, node: world.node }) };
}
export const sendWrite = (world, { wallet, request }) => inWalletPass(world, () => wallet.request(request), { context: JOB_CREATE() });
/** One artifact CREATE, prepared and sent. */
export const artifactWrite = async (world, factoryOptions) => ({ answer: await sendWrite(world, await preparedWrite(world, factoryOptions)) });
export const refuseConfirmation = world => replyTo(world.node, 'confirmTx', row => jsonResponse(ok({ data: { valid: false, message: 'TEST-insufficient-balance', gas_operation: null,
  transaction: row.body.params[0].data } })));

