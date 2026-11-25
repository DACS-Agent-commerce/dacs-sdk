// The seller's production wallet-session port for startSellerHost. Stage one opens the client's transport owner, its read-only
// authority capability and its connection reader, which the host binds through. Under the state lock the host finalizes the
// port with its binding and effect boundary: the port checks both, loads the key, builds the seller Node wallet over its own
// owner and binds the one artifact anchor handle the operator gave the host.
import { SELLER_FULFILMENT_VET_MODES } from '@kynesyslabs/dacs';
import { WireError, assertTp1Binding } from '@kynesyslabs/dacs/wire';
import { admitTp1Authority, createNodeTransportOwner, tp1AuthorityLabel } from '@kynesyslabs/dacs-client/node-wallet';
import { boundedCall, isBoundedCallTimeout } from '../dacs/bounded-call.mjs';
import { effectBoundaryBinding } from '../dacs/effect-boundary.mjs';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';
import { OperationError } from '../operations.mjs';
import { SellerKeyError } from '../seller-key.mjs';
import { createDevnetDemoArtifactAnchor } from './artifact-anchor.mjs';
import { createConnectionAuthorityReader } from './connection-authority.mjs';
import { createSellerCreatePass, lateSellerCreatePass } from './create-pass.mjs';
import { createSellerNodeWallet } from './seller-node-wallet.mjs';

const OPTIONS = Object.freeze(['endpoint', 'transportAuthority', 'fetchImpl', 'signer', 'loadKeyRecord', 'approve', 'approvalMode', 'journalMode', 'publications',
  'diagnostics', 'clock', 'buyerAccess']);
const NODE_AUTHORITY_READER_INPUTS = Object.freeze(['owner', 'claim']);
const ANCHOR_METHODS = Object.freeze(['publish', 'read', 'readRetained', 'retainedSignedCreate', 'hasIntent', 'verifyReceipt']);
const ARTIFACT_SOURCE = 'dacs-devnet-demo-native-artifacts/v1';
// The kit host's one Vet mode (KIT_TP1_VET_MODE in host.mjs).
const VET_MODE = SELLER_FULFILMENT_VET_MODES.tp1G3Orchestrator;
// The connection read the anchor's readback asks ends within this many milliseconds, as each of the host stages' authority reads does.
const AUTHORITY_READ_TIMEOUT_MS = 10000;
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
  const { signer, loadKeyRecord, publications } = options;
  if (typeof signer?.claim !== 'string' || typeof signer.sign !== 'function') throw new TypeError('signer must be { claim: string, sign: function }');
  if (typeof loadKeyRecord !== 'function') throw new TypeError('loadKeyRecord must be a function');
  if (typeof publications?.demoArtifactPublication?.authority !== 'string') throw new TypeError('publications.demoArtifactPublication.authority must be a string');
}

/**
 * Returns the frozen read-only pair `{ authority, connectionAuthority }` over a node transport owner, as
 * createConnectionAuthorityReader builds it; `claim` is the capability's claim reader. It answers the connection scope only.
 * Throws TypeError for an input other than `owner` and `claim`, and the client's TypeError for a refused owner or claim.
 */
export function createNodeAuthorityReader(inputs) {
  const extra = Object.keys(inputs ?? {}).filter((name) => !NODE_AUTHORITY_READER_INPUTS.includes(name));
  if (extra.length) throw new TypeError(`unknown createNodeAuthorityReader input: ${extra.join(', ')}`);
  return createConnectionAuthorityReader(inputs);
}

// The one place the kit builds the artifact anchor over a finalized session, with the host's binding and connection reader.
// Its wallet CREATEs and resends run through runCreate, the port's one pass over the host's effect boundary and this session.
function composeSellerArtifactAnchor({ session, signer, buyerAccess, clock, binding, observeIdentity, runCreate }) {
  return createDevnetDemoArtifactAnchor({ sourceCapability: session.transport, journal: session.artifactJournal, walletFactory: session.walletFactory,
    network: session.transport.pins.network, signer, buyerAccess, now: () => clock.now(), vetMode: VET_MODE, binding, observeIdentity, runCreate });
}

/**
 * Builds the seller's production wallet-session port. The guard is checked first; then the options, a closed set: `endpoint`,
 * `transportAuthority`, `fetchImpl` (the node connection), `signer` `{ claim, sign }` (the seller signer the host takes),
 * `loadKeyRecord()` (resolves fresh `dacs-seller-key/v1` bytes), `approve`, `approvalMode`, `journalMode`, `publications` and
 * `diagnostics` (passed to the seller Node wallet; see finalize for a `TP1-` label), `clock` (wall-clock milliseconds, `Date.now` by default) and
 * `buyerAccess` (the anchor's, `null` by default).
 * Returns a frozen port `{ authority, connectionAuthority, artifactAnchor, runCreate, finalize(input), close() }`:
 * - `authority` is the read-only capability (no sign or send); its `claim()` throws wallet_session_not_finalized until finalize.
 * - `connectionAuthority` is the client's authority reader over it; only its connection scope answers.
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
 *   paymentEvidence, readBalance, close }`. The session's `close()` closes the handle and the wallet; the port keeps its owner.
 * - `close()` closes a live session, then the owner, once.
 * `endpoint` is a canonical root URL over https; a plain-http root refuses transport_mismatch. Binding then refuses a node whose
 * live chain is another before any key load or signature.
 * Throws KitOperationGuardError, TypeError naming a malformed option, or the client's transport_mismatch. `finalize` rejects with
 * KitOperationGuardError, wallet_session_finalize_once, wallet_session_closed (the wallet build's refusal as `cause` when it failed),
 * wallet_session_boundary_mismatch, the wire's tp1_* refusal (also the token admission's, before the key load), SellerKeyError(seller_key_format_invalid) for a key value that is not a
 * Uint8Array, the key loader's own error, or the seller Node wallet's refusal (authority_unbound, or profile_not_admitted while purchase actions are held).
 */
export function createSellerWalletSession(options) {
  assertKitOperationAdmitted('createSellerWalletSession');
  checkOptions(options);
  const { endpoint, transportAuthority, fetchImpl, signer, loadKeyRecord, approve, approvalMode, journalMode, publications, diagnostics,
    clock = { now: () => Date.now() }, buyerAccess = null } = options;
  // No chain identity is passed, so the owner admits only an https root.
  const owner = createNodeTransportOwner({ endpoint, transportAuthority, fetchImpl });
  let finalizeCalled = false, closed = false, closing = null, session = null, anchor = null, finalizedRunCreate = null;
  const { authority, connectionAuthority } = createNodeAuthorityReader({ owner, claim: () => {
    if (closed) throw sessionClosed();
    if (anchor === null) throw notFinalized();
    return signer.claim;
  } });
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
      address: wallet.address, observer: wallet.observer, artifactJournal: wallet.artifactJournal, paymentEvidence: wallet.paymentEvidence, readBalance: wallet.readBalance,
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
      try {
        const finalized = sessionOver(wallet);
        const { runCreate } = createSellerCreatePass({ effectBoundary, session: finalized, stopped, feeCeilingOs, clock });
        anchor = composeSellerArtifactAnchor({ session: finalized, signer, buyerAccess, clock, binding, observeIdentity: observeConnectionIdentity, runCreate });
        finalizedRunCreate = runCreate;
        session = finalized;
        return finalized;
      } catch (error) {
        await wallet.close().catch(() => { /* the composition error is the one reported */ });
        throw error;
      }
    } finally {
      zeroFill(keyRecord);
    }
  }

  const port = Object.freeze({
    authority, connectionAuthority, artifactAnchor, runCreate: lateSellerCreatePass(boundRunCreate), finalize,
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
