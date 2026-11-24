// Unshipped fixture: the seller host composed over the real Vet provider. The provider's Vet component signatures run through an
// issued runCreate over the host's own effect boundary (the one the host hands its wallet session's finalize), and the host's
// authority reads and that pass's final stop check go through a gate a test can pause: `gate.pause('authority' | 'stop', at)` holds the
// `at`-th such call (counted from the pause) until `gate.resume()`; `gate.closed` makes the authority read refuse and `gate.stop` makes the
// stop check answer true. `gate.onHeld`, when set, runs as a call is held.
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from '@kynesyslabs/dacs';
import { WireError } from '@kynesyslabs/dacs/wire';
import { createDemDeliveryContext } from '../../src/dacs/dem-delivery-context-consumer.mjs';
import { provenUnsignedAbsence } from '../../src/dacs/native-dem-delivery-consumer.mjs';
import { createOperatorBuyerAccess } from '../../src/devnet-demo/buyer-access.mjs';
import { createDevnetDemoAgreementContextProvider } from '../../src/devnet-demo/agreement-context.mjs';
import { createSellerCreatePass, lateSellerCreatePass } from '../../src/devnet-demo/create-pass.mjs';
import { openPartyVetStore } from '../../src/devnet-demo/party-vet-store.mjs';
import { KIT_TP1_VET_MODE } from '../../src/host.mjs';
import { TEST_PASS_SESSION } from './agent-signing.mjs';
import { contextHostFixture } from './host-context-client.mjs';
import { enrollment, testWalletSession } from './kit-wallet-session.mjs';
import { buyer, seller } from './protocol-fixture.mjs';

const VET_PREFIX = 'dacs-composite:v1:';
const WORKER = fileURLToPath(new URL('./composed-vet-host-worker.mjs', import.meta.url));
const refused = () => new WireError('tp1_participant_refused', 503, undefined, new Error('TEST the authority is closed'));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };

/** The gate a composed host's authority reads and final stop checks pass through. */
export function pauseGate() {
  return { calls: { authority: 0, stop: 0 }, at: null, held: null, closed: false, stop: false, onHeld: null,
    pause(kind, at) { this.calls = { authority: 0, stop: 0 }; this.at = { kind, at }; },
    resume() { const held = this.held; this.held = null; held?.(); },
    async hold(kind) {
      this.calls[kind] += 1;
      if (this.at?.kind !== kind || this.at.at !== this.calls[kind]) return;
      const resumed = new Promise((resume) => { this.held = resume; });
      this.onHeld?.();
      await resumed;
    } };
}

/** A Vet record anchor in memory: what it publishes reads back present and finalized. `records` holds what it keeps. */
export function vetRecordAnchor(records = new Map()) {
  const receipt = (logicalAddress, artifact) => ({ receiptVersion: '1', substrate: 'TEST-landing-reader', finalityProfile: 'TEST-finalized', logicalAddress, nativeAddress: logicalAddress,
    contentHash: contentHash(artifact), writer: seller.claim, transactionRef: { kind: 'storage-program', value: contentHash(artifact) }, state: 'finalized', observationDisposition: 'established',
    observedAt: 1, blockRef: { id: 'TEST-block', height: '1' }, evidence: { kind: 'TEST-finalized-observation', value: contentHash(artifact) } });
  const read = async ({ logicalAddress }) => structuredClone(records.get(logicalAddress) ?? { status: 'absent' });
  // An address it never published is proven unsigned when the reader asks for that proof.
  const readRetained = async (query) => (records.has(query.logicalAddress) || query.proofOfNoIntent !== true ? read(query) : provenUnsignedAbsence('TEST no CREATE intent'));
  return { records, writer: seller.claim, vetMode: KIT_TP1_VET_MODE, hasIntent: async (logicalAddress) => records.has(logicalAddress), read, readRetained,
    verifyReceipt: async ({ logicalAddress }) => (records.has(logicalAddress) ? 'valid' : 'invalid'),
    publish: async ({ logicalAddress, artifact }) => { records.set(logicalAddress, { status: 'present', artifact: structuredClone(artifact), receipt: receipt(logicalAddress, artifact) }); return read({ logicalAddress }); } };
}

/**
 * `start()` starts a host on the one data directory (`dataDirectory`, the fixture's own by default), over a fresh provider on the one party
 * Vet store at `vetPath` (as after a restart), and answers `{ host, buyer }`. `signatures` lists every Vet component signature the
 * seller's wallet made in this process, as text, across every start, and `hooks.onSign(text)`, when set, runs right before each one;
 * `effectSigns()` counts the host's effect-role signatures, and `hooks.onEffect()` runs right before each.
 * `failedSteps()` answers the error codes of the Vet steps the latest provider's store keeps as failed.
 */
export async function composedVetHost(t, { gate = pauseGate(), dataDirectory = null, vetPath = null, anchor = vetRecordAnchor() } = {}) {
  const f = await contextHostFixture(t);
  const vetDirectory = await mkdtemp(join(tmpdir(), 'TEST-composed-vet-'));
  const stores = [];
  t.after(async () => { for (const store of stores) store.close(); await rm(vetDirectory, { recursive: true, force: true }); });
  const signatures = [], hooks = { onSign: null, onEffect: null }, effect = { signs: 0 };
  // The host's effect role, counted: it signs the effect-route answers (the challenge's and the context step's) in passes of the boundary.
  const signer = { ...f.config.signer, sign: (bytes) => { hooks.onEffect?.(); effect.signs++; return f.config.signer.sign(bytes); } };
  const wallet = { claim: seller.claim, signBytes: async (bytes) => {
    const text = Buffer.from(bytes).toString();
    if (text.startsWith(VET_PREFIX)) { hooks.onSign?.(text); signatures.push(text); }
    return seller.signBytes(bytes);
  } };
  const storePath = vetPath ?? join(vetDirectory, 'party.sqlite');
  let mode = vetPath === null ? 'create' : 'open';
  const start = async (changes = {}) => {
    const finalized = {};
    const { walletSession } = testWalletSession({ finalize: async (input) => { Object.assign(finalized, input); return { close: async () => {} }; } });
    const connectionAuthority = async (scope) => {
      await gate.hold('authority');
      if (gate.closed) throw refused();
      return walletSession.connectionAuthority(scope);
    };
    const stopped = async () => { await gate.hold('stop'); return gate.stop || await finalized.stopped(); };
    const store = openPartyVetStore({ path: storePath, mode });
    mode = 'open';
    stores.push(store);
    const provider = createDevnetDemoAgreementContextProvider({ anchor, vetMode: KIT_TP1_VET_MODE, listing: f.config.listing, store, wallet, log: () => {}, now: () => Date.now(),
      runCreate: lateSellerCreatePass(() => createSellerCreatePass({ effectBoundary: finalized.effectBoundary, session: TEST_PASS_SESSION, stopped, feeCeilingOs: finalized.feeCeilingOs,
        clock: { now: () => Date.now() } }).runCreate),
      buyerAccess: createOperatorBuyerAccess({ openBuyerAccess: false, custodyBuyer: buyer.claim, buyerForJob: () => buyer.address }),
      counterparty: Object.fromEntries(['issueChallenge', 'evaluate', 'readRecord'].map((key) => [key, () => { throw new Error(`TEST the orchestrator Vet calls no counterparty ${key}`); }])) });
    const demDeliveryContext = createDemDeliveryContext({ authority: 'TEST-composed-vet-host', vetMode: provider.vetMode, resolveSeller: provider.resolveSeller, release: provider.release,
      resolveBuyer: provider.resolveBuyer, recoverBuyer: provider.recoverBuyer, resumableBuyer: provider.resumableBuyer, bindRetainedScope: provider.bindRetainedScope });
    const host = await f.start({ signer, walletSession: { ...walletSession, connectionAuthority }, participantImplementations: enrollment(), demDeliveryContext,
      ...(dataDirectory === null ? {} : { dataDirectory }), ...changes });
    return { host, buyer: await f.buyerFor(host) };
  };
  const failedSteps = async () => (await stores.at(-1).entries()).flatMap(([, row]) => Object.values(row?.ops ?? {})
    .flatMap((ops) => Object.values(ops?.steps ?? {}).filter((step) => step?.state === 'failed').map((step) => step.error?.code)));
  return { ...f, dataDirectory: dataDirectory ?? f.dataDirectory, vetPath: storePath, gate, start, signatures, effectSigns: () => effect.signs, anchor, hooks, failedSteps };
}

/**
 * The composed host in a child process (composed-vet-host-worker.mjs) on `dataDirectory` and the party Vet store at `vetPath`, its Vet
 * records answered by `anchor` here, paused at the `at`-th `kind` call once it has started. Answers `{ host, held, kill, signatures() }`:
 * `held` resolves when the child waits at that call, `signatures()` counts the Vet component signatures the child made, and `kill()`
 * ends it with SIGKILL, as a process dies.
 */
export async function composedVetHostProcess(t, { dataDirectory, vetPath, anchor, kind, at }) {
  const temporary = await mkdtemp(join(tmpdir(), 'TEST-composed-vet-process-'));
  const child = fork(WORKER, [], { env: { ...process.env, TMPDIR: temporary }, serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  const kill = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; };
  t.after(async () => { await kill(); await rm(temporary, { recursive: true, force: true }); });
  let stderr = '', signed = 0;
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const started = deferred(), held = deferred();
  held.promise.catch(() => {});
  child.on('message', (message) => {
    if (message.type === 'anchor') {
      const answer = (reply) => { if (child.connected) child.send({ type: 'anchor', id: message.id, ...reply }); };
      Promise.resolve().then(() => anchor[message.method](message.input)).then((value) => answer({ value }), (error) => answer({ error: { message: error.message, code: error.code } }));
    } else if (message.type === 'started') started.resolve(message);
    else if (message.type === 'held') held.resolve();
    else if (message.type === 'signed') signed++;
  });
  exited.then(([code, signal]) => {
    const ended = new Error(`TEST the host process ended (${signal ?? code}): ${stderr}`);
    started.reject(ended);
    held.reject(ended);
  }, () => {});
  child.send({ type: 'start', dataDirectory, vetPath, kind, at });
  const { url, listingPin } = await started.promise;
  return { host: { url, listingPin }, held: held.promise, kill, signatures: () => signed };
}
