// The seller's production wallet-session port for startSellerHost. Stage one opens the client's transport owner, its read-only
// authority capability and its connection reader, which the host binds through. Under the state lock the host finalizes the
// port with its binding and effect boundary: the port checks both, loads the key, builds the seller Node wallet over its own
// owner, binds the one artifact anchor handle the operator gave the host and builds the payment-evidence journal over its passes.
import { join } from 'node:path';
import { SELLER_FULFILMENT_VET_MODES } from '@kynesyslabs/dacs';
import { WireError, assertTp1Binding } from '@kynesyslabs/dacs/wire';
import { admitTp1Authority, createNodeTransportOwner, tp1AuthorityLabel } from '@kynesyslabs/dacs-client/node-wallet';
import { boundedCall, isBoundedCallTimeout } from '../dacs/bounded-call.mjs';
import { effectBoundaryBinding } from '../dacs/effect-boundary.mjs';
import { createNativePaymentEvidenceConsumer } from '../dacs/native-payment-evidence-consumer.mjs';
import { createPaymentEvidencePass } from '../dacs/payment-evidence-pass.mjs';
import { createPaymentEvidenceWalletJournal } from '../dacs/payment-evidence-wallet-journal.mjs';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';
import { OperationError } from '../operations.mjs';
import { SellerKeyError } from '../seller-key.mjs';
import { createDevnetDemoArtifactAnchor } from './artifact-anchor.mjs';
import { createConnectionAuthorityReader } from './connection-authority.mjs';
import { createSellerCreatePass, lateSellerCreatePass } from './create-pass.mjs';
import { createNodeChainReaders } from './node-chain-readers.mjs';
import { OPERATOR_CLOSING } from './operator-approval.mjs';
import { createSellerNodeWallet } from './seller-node-wallet.mjs';

const OPTIONS = Object.freeze(['endpoint', 'transportAuthority', 'fetchImpl', 'signer', 'loadKeyRecord', 'approve', 'approvalMode', 'journalMode', 'publications',
  'diagnostics', 'clock', 'buyerAccess', 'participantImplementations', 'sessionOf', 'trustedFinality']);
const NODE_AUTHORITY_READER_INPUTS = Object.freeze(['owner', 'claim', 'chain', 'participantImplementations', 'sessionOf', 'trustedFinality']);
const ANCHOR_METHODS = Object.freeze(['publish', 'read', 'readRetained', 'retainedSignedCreate', 'hasIntent', 'verifyReceipt']);
const ARTIFACT_SOURCE = 'dacs-devnet-demo-native-artifacts/v1';
// The kit host's one Vet mode (KIT_TP1_VET_MODE in host.mjs).
const VET_MODE = SELLER_FULFILMENT_VET_MODES.tp1G3Orchestrator;
// The connection read the anchor's readback asks ends within this many milliseconds, as each of the host stages' authority reads does.
const AUTHORITY_READ_TIMEOUT_MS = 10000;
const PAYMENT_EVIDENCE_JOURNAL = 'seller-payment-evidence.sqlite';
const APPROVALS_ENDED = 'the seller host is closing: no new payment-evidence approval or signature is made, and nothing was signed or kept for this call';
const ports = new WeakSet();

const sessionClosed = (cause) => Object.assign(new OperationError('wallet_session_closed', 'the wallet session is closed'), cause === undefined ? {} : { cause });
const notFinalized = () => new OperationError('wallet_session_not_finalized', 'the wallet session is not finalized yet');

// Clears every byte `value` holds when it is an ArrayBuffer or a view of one; any other value holds none the port can clear.
function zeroFill(value) {
  if (value instanceof ArrayBuffer) new Uint8Array(value).fill(0);
  else if (ArrayBuffer.isView(value)) new Uint8Array(value.buffer, value.byteOffset, value.byteLength).fill(0);
}

function checkOptions(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('createSellerWalletSession options must be an object');
  const unknown = Object.keys(options).filter((name) => !OPTIONS.includes(name));
  if (unknown.length) throw new TypeError(`unknown createSellerWalletSession option: ${unknown.join(', ')}`);
  const { signer, loadKeyRecord, publications, participantImplementations, sessionOf, trustedFinality } = options;
  if (typeof signer?.claim !== 'string' || typeof signer.sign !== 'function') throw new TypeError('signer must be { claim: string, sign: function }');
  if (typeof loadKeyRecord !== 'function') throw new TypeError('loadKeyRecord must be a function');
  if (typeof publications?.demoArtifactPublication?.authority !== 'string') throw new TypeError('publications.demoArtifactPublication.authority must be a string');
  if (participantImplementations !== undefined && typeof participantImplementations?.entriesFor !== 'function') throw new TypeError('participantImplementations must be { entriesFor: function }');
  if (sessionOf !== undefined && typeof sessionOf !== 'function') throw new TypeError('sessionOf must be a function');
  if (trustedFinality !== undefined && (trustedFinality === null || typeof trustedFinality !== 'object' || Object.getPrototypeOf(trustedFinality) !== Object.prototype)) {
    throw new TypeError('trustedFinality must be a plain object');
  }
}

/**
 * Returns frozen `{ authority, connectionAuthority, sessionAdmission, readCommitmentReceipt, observePayment }` over a node
 * transport owner. The first two are the read-only pair createConnectionAuthorityReader builds (`claim` is the capability's claim
 * reader); they answer the connection scope only. The other three are createNodeChainReaders' over `claim`, the late-bound
 * `chain()` thunk, `participantImplementations`, `sessionOf` and `trustedFinality`, each optional: a reader whose input is missing
 * rejects reader_input_missing. Building reads, signs and opens nothing.
 * Throws TypeError for an input other than these six, and the client's TypeError for a refused owner or claim.
 */
export function createNodeAuthorityReader(inputs) {
  const extra = Object.keys(inputs ?? {}).filter((name) => !NODE_AUTHORITY_READER_INPUTS.includes(name));
  if (extra.length) throw new TypeError(`unknown createNodeAuthorityReader input: ${extra.join(', ')}`);
  const { owner, claim, chain, participantImplementations, sessionOf, trustedFinality } = inputs;
  return Object.freeze({ ...createConnectionAuthorityReader({ owner, claim }),
    ...createNodeChainReaders({ claim, chain, participantImplementations, sessionOf, trustedFinality }) });
}

// The one place the kit builds the artifact anchor over a finalized session, with the host's binding and connection reader.
// Its wallet CREATEs and resends run through runCreate, the port's one pass over the host's effect boundary and this session;
// `stopped`, the host's stop check, keeps a read under a stop to its readback.
function composeSellerArtifactAnchor({ session, signer, buyerAccess, clock, binding, observeIdentity, runCreate, stopped }) {
  return createDevnetDemoArtifactAnchor({ sourceCapability: session.transport, journal: session.artifactJournal, walletFactory: session.walletFactory,
    network: session.transport.pins.network, signer, buyerAccess, now: () => clock.now(), vetMode: VET_MODE, binding, observeIdentity, runCreate, stopped });
}

// The session's payment-evidence journal, which signs and sends only in runCreate passes and asks its approvals before them,
// and the native payment-evidence consumer that anchors through it. `endApprovalWaits()` ends every approval the journal waits
// for and refuses later ones and every new signature; it is idempotent and never throws.
function composeSellerPaymentEvidence({ runCreate, wallet, dataDirectory, clock, binding, observeIdentity }) {
  const approvalsEnd = new AbortController();
  const pass = createPaymentEvidencePass({ runCreate, adapter: wallet.paymentEvidenceAdapter });
  const journal = createPaymentEvidenceWalletJournal({ path: join(dataDirectory, PAYMENT_EVIDENCE_JOURNAL), ...pass, approvalSignal: approvalsEnd.signal, now: () => clock.now() });
  try {
    const nativePaymentEvidence = createNativePaymentEvidenceConsumer({ rpcUrl: wallet.sourceCapability.pins.endpoint, sourceCapability: wallet.sourceCapability, binding, observeIdentity,
      now: () => clock.now(), anchorEvidence: journal.anchorEvidence, readSignedProjection: journal.readSignedProjection });
    const endApprovalWaits = () => approvalsEnd.abort(new OperationError(OPERATOR_CLOSING, APPROVALS_ENDED));
    return { journal, nativePaymentEvidence, endApprovalWaits };
  } catch (error) { journal.close(); throw error; }
}

// The finalized session with its payment-evidence pieces; its close() closes the journal once, then the wallet.
function withPaymentEvidence(finalized, { journal, nativePaymentEvidence, endApprovalWaits }) {
  let journalOpen = true;
  const close = () => {
    if (journalOpen) { journalOpen = false; journal.close(); }
    return finalized.close();
  };
  return Object.freeze({ ...finalized, paymentEvidence: journal, nativePaymentEvidence, endApprovalWaits, close });
}

/**
 * Builds the seller's production wallet-session port. The guard is checked first; then the options, a closed set: `endpoint`,
 * `transportAuthority`, `fetchImpl` (the node connection), `signer` `{ claim, sign }` (the seller signer the host takes),
 * `loadKeyRecord()` (resolves fresh `dacs-seller-key/v1` bytes), `approve`, `approvalMode`, `journalMode`, `publications` and
 * `diagnostics` (passed to the seller Node wallet; see finalize for a `TP1-` label), `clock` (wall-clock milliseconds, `Date.now` by default),
 * `buyerAccess` (the anchor's, `null` by default), and the chain readers' optional host inputs `participantImplementations`
 * `{ entriesFor(claim, { sessionId, signal }) }` (the host's enrollment source), `sessionOf(jobId)` (the seller's durable session view)
 * and `trustedFinality` (a plain object: the operator's pinned finality checkpoint from the seller's configuration; without it the
 * revocation reader asks the node for no storage proof or finalized head).
 * Returns a frozen port `{ authority, connectionAuthority, sessionAdmission, readCommitmentReceipt, observePayment, artifactAnchor, runCreate,
 * finalize(input), close() }`:
 * - `authority` is the read-only capability (no sign or send); its `claim()` throws wallet_session_not_finalized until finalize.
 * - `connectionAuthority` is the client's authority reader over it; only its connection scope answers.
 * - `sessionAdmission` (the agent's six admission reads), `readCommitmentReceipt` (the wire's receipt reader) and `observePayment`
 *   (the approval policy's payment observer) read through the finalized session on every call (see createNodeChainReaders). Each
 *   rejects wallet_session_not_finalized before finalize and wallet_session_closed after a close, before any read, and
 *   reader_input_missing when the option it reads was not given; `observePayment` rejects payment_unverified for a payment it
 *   cannot prove verified or absent, which the agent's admission refusal and the policy treat as unavailable.
 * - `artifactAnchor` is the one anchor handle for the host, the Vet provider and the delivery capability. Its `source`, `authority`,
 *   `writer` and `vetMode` are fixed now; its methods reject wallet_session_not_finalized until finalize binds it to the anchor
 *   composed over the finalized session, and wallet_session_closed after a close, each before any read.
 * - `runCreate(op, work)` is the one pass finalize builds over the host's effect boundary and the finalized session, the one
 *   the anchor uses too (createSellerCreatePass); it rejects wallet_session_not_finalized before finalize and wallet_session_closed
 *   after a close, each before any read. The Vet provider and the Listing publisher take it as their `runCreate`.
 * - `finalize({ binding, effectBoundary, stopped, feeCeilingOs, stateLock, dataDirectory })`, called once by the host's stages
 *   under the state lock, checks that the boundary was built over `binding` and that `binding` is current on this port's connection,
 *   gives a publication naming `tp1AuthorityLabel(binding)` one token for `binding` in the wallet build's copy (the anchor keeps the label),
 *   then calls `loadKeyRecord` once, zero-fills what it returned on every outcome, builds the seller Node wallet and resolves the
 *   frozen session `{ effectPass, runInEffectPass, walletFactory, transport, acquireConnectionFence, address, observer, artifactJournal,
 *   paymentEvidence, nativePaymentEvidence, endApprovalWaits, readBalance, close }`:
 *   - `paymentEvidence` is the session's payment-evidence journal. It signs and sends only in `runCreate` passes and asks the
 *     operator's approval before each pass. `nativePaymentEvidence` is the native payment-evidence consumer anchoring through it;
 *   - `endApprovalWaits()` ends every approval that journal waits for and refuses later ones and every new signature
 *     (operator_closing), with the journal left open. A kept CREATE not yet sent stays unsent, and its call says so; a send whose
 *     approval is held still runs;
 *   - `close()` closes the journal and the wallet, once; the port keeps its owner.
 * - `close()` closes a live session, then the owner, once.
 * `endpoint` is a canonical root URL over https; a plain-http root refuses transport_mismatch. Binding then refuses a node whose
 * live chain is another before any key load or signature.
 * Throws KitOperationGuardError, TypeError naming a malformed option (a `participantImplementations` without `entriesFor`, a
 * `sessionOf` that is not a function, a `trustedFinality` that is not a plain object, among others), or the client's transport_mismatch. `finalize` rejects with
 * KitOperationGuardError, wallet_session_finalize_once, wallet_session_closed (the wallet build's refusal as `cause` when it failed),
 * wallet_session_boundary_mismatch, the wire's tp1_* refusal (also the token admission's, before the key load), SellerKeyError(seller_key_format_invalid) for a key value that is not a
 * Uint8Array, the key loader's own error, the seller Node wallet's refusal (authority_unbound, or profile_not_admitted while purchase actions are held),
 * or the payment-evidence journal's refusal (a TypeError for its file, wallet_journal_busy).
 */
export function createSellerWalletSession(options) {
  assertKitOperationAdmitted('createSellerWalletSession');
  checkOptions(options);
  const { endpoint, transportAuthority, fetchImpl, signer, loadKeyRecord, approve, approvalMode, journalMode, publications, diagnostics,
    clock = { now: () => Date.now() }, buyerAccess = null, participantImplementations, sessionOf, trustedFinality } = options;
  const owner = createNodeTransportOwner({ endpoint, transportAuthority, fetchImpl });
  let finalizeCalled = false, closed = false, closing = null, session = null, anchor = null, finalizedRunCreate = null, finalizedChain = null;
  // The finalized session the chain readers read through: wallet_session_closed after a close, wallet_session_not_finalized before finalize.
  const chain = () => {
    if (closed) throw sessionClosed();
    if (finalizedChain === null) throw notFinalized();
    return finalizedChain;
  };
  const { authority, connectionAuthority, sessionAdmission, readCommitmentReceipt, observePayment } = createNodeAuthorityReader({ owner, claim: () => {
    if (closed) throw sessionClosed();
    if (anchor === null) throw notFinalized();
    return signer.claim;
  }, chain, participantImplementations, sessionOf, trustedFinality });
  // The anchor readback's observeIdentity({ signal, timeoutMs }): the chain identity of the connection decision, which the readback
  // compares with the binding, or undefined for a connection the reader cannot authenticate. An aborted signal refuses before the read;
  // the wait ends at the readback's remaining time, at most AUTHORITY_READ_TIMEOUT_MS. Any other read error is the reader's own.
  const observeConnectionIdentity = async ({ signal, timeoutMs } = {}) => {
    signal?.throwIfAborted();
    const bound = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, AUTHORITY_READ_TIMEOUT_MS) : AUTHORITY_READ_TIMEOUT_MS;
    const decision = await boundedCall(() => connectionAuthority({ local: owner.currentLocal(), sessionId: null, participants: [] }), { timeoutMs: bound })
      .catch((error) => { throw isBoundedCallTimeout(error) ? new WireError('tp1_authority_timeout', 500, undefined, error) : error; });
    return decision?.chainIdentity;
  };
  const boundAnchor = () => {
    if (closed) throw sessionClosed();
    if (anchor === null) throw notFinalized();
    return anchor;
  };
  const boundRunCreate = () => {
    if (closed) throw sessionClosed();
    if (finalizedRunCreate === null) throw notFinalized();
    return finalizedRunCreate;
  };
  const artifactAnchor = Object.freeze({ source: ARTIFACT_SOURCE, authority: publications.demoArtifactPublication.authority, writer: signer.claim, vetMode: VET_MODE,
    ...Object.fromEntries(ANCHOR_METHODS.map((name) => [name, async (...args) => boundAnchor()[name](...args)])) });

  // The publications the wallet build gets: each one whose authority is the binding's own TP1- label carries one token admitted
  // for that binding instead. Any other label stays as it is, so a TP1- label of another record is refused by the build.
  async function publicationsFor(binding) {
    const label = tp1AuthorityLabel(binding);
    const named = Object.keys(publications).filter((name) => publications[name]?.authority === label);
    if (named.length === 0) return publications;
    const token = await admitTp1Authority({ binding, currentLocal: owner.currentLocal });
    return { ...publications, ...Object.fromEntries(named.map((name) => [name, { ...publications[name], authority: token }])) };
  }

  // Builds the seller Node wallet; a close while it is built closes what it built and refuses wallet_session_closed.
  async function buildWallet({ binding, stopped, feeCeilingOs, stateLock, dataDirectory, keyRecord, publications }) {
    const wallet = await createSellerNodeWallet({ admission: { binding, currentLocal: owner.currentLocal }, owner, dataDirectory, stateLock, stopped, feeCeilingOs, keyRecord,
      signer, approve, approvalMode, journalMode, publications, clock, diagnostics }).catch((error) => { throw closed ? sessionClosed(error) : error; });
    if (closed) {
      await wallet.close().catch(() => { /* the close is the refusal reported */ });
      throw sessionClosed();
    }
    return wallet;
  }

  function sessionOver(wallet) {
    let sessionClosing = null;
    return Object.freeze({
      effectPass: wallet.effectPass, runInEffectPass: wallet.runInEffectPass, walletFactory: wallet.walletFactory, transport: wallet.sourceCapability,
      async acquireConnectionFence() {
        if (closed) throw sessionClosed();
        return owner.acquireConnectionFence();
      },
      address: wallet.address, observer: wallet.observer, artifactJournal: wallet.artifactJournal, readBalance: wallet.readBalance,
      close() {
        closed = true;
        sessionClosing ??= wallet.close();
        return sessionClosing;
      },
    });
  }

  async function finalize({ binding, effectBoundary, stopped, feeCeilingOs, stateLock, dataDirectory }) {
    assertKitOperationAdmitted('sellerWalletSession.finalize');
    if (finalizeCalled) throw new OperationError('wallet_session_finalize_once', 'the wallet session finalizes once');
    if (closed) throw sessionClosed();
    finalizeCalled = true;
    if (effectBoundaryBinding(effectBoundary) !== binding) throw new OperationError('wallet_session_boundary_mismatch', 'the effect boundary was not built over this binding');
    await assertTp1Binding(binding, owner.currentLocal());
    const walletPublications = await publicationsFor(binding);
    const keyRecord = await loadKeyRecord();
    try {
      if (closed) throw sessionClosed();
      if (!(keyRecord instanceof Uint8Array)) throw new SellerKeyError('seller_key_format_invalid');
      const wallet = await buildWallet({ binding, stopped, feeCeilingOs, stateLock, dataDirectory, keyRecord, publications: walletPublications });
      let evidence = null;
      try {
        const finalized = sessionOver(wallet);
        const { runCreate } = createSellerCreatePass({ effectBoundary, session: finalized, stopped, feeCeilingOs, clock });
        evidence = composeSellerPaymentEvidence({ runCreate, wallet, dataDirectory, clock, binding, observeIdentity: observeConnectionIdentity });
        const composedAnchor = composeSellerArtifactAnchor({ session: finalized, signer, buyerAccess, clock, binding, observeIdentity: observeConnectionIdentity, runCreate, stopped });
        const composed = withPaymentEvidence(finalized, evidence);
        anchor = composedAnchor;
        finalizedRunCreate = runCreate;
        finalizedChain = Object.freeze({ anchor: composedAnchor, transport: finalized.transport, binding, observeIdentity: observeConnectionIdentity, clock });
        session = composed;
        return composed;
      } catch (error) {
        evidence?.journal.close();
        await wallet.close().catch(() => { /* the composition error is the one reported */ });
        throw error;
      }
    } finally {
      zeroFill(keyRecord);
    }
  }

  const port = Object.freeze({
    authority, connectionAuthority, sessionAdmission, readCommitmentReceipt, observePayment, artifactAnchor, runCreate: lateSellerCreatePass(boundRunCreate), finalize,
    close: () => closing ??= (async () => {
      closed = true;
      try { await session?.close(); } finally { owner.close(); }
    })(),
  });
  ports.add(port);
  return port;
}

/** True when `value` is a port `createSellerWalletSession` returned. Never throws. */
export const isSellerWalletSession = (value) => ports.has(value);
