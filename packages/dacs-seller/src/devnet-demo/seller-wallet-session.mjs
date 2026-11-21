// The seller's production wallet-session port for startSellerHost. Stage one opens the client's transport owner, its read-only
// authority capability and its connection reader, which the host binds through. Under the state lock the host finalizes the
// port with its binding and effect boundary: the port checks both, loads the key, builds the seller Node wallet over its own
// owner and binds the one artifact anchor handle the operator gave the host.
import { SELLER_FULFILMENT_VET_MODES } from '@kynesyslabs/dacs';
import { TP1_APPROVED_IDENTITY_RECORD, WireError, assertTp1Binding } from '@kynesyslabs/dacs/wire';
import { createAuthorityReader } from '@kynesyslabs/dacs-client';
import { createNodeAuthorityCapability, createNodeTransportOwner } from '@kynesyslabs/dacs-client/node-wallet';
import { boundedCall, isBoundedCallTimeout } from '../dacs/bounded-call.mjs';
import { effectBoundaryBinding } from '../dacs/effect-boundary.mjs';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';
import { OperationError } from '../operations.mjs';
import { SellerKeyError } from '../seller-key.mjs';
import { createDevnetDemoArtifactAnchor } from './artifact-anchor.mjs';
import { createSellerNodeWallet } from './seller-node-wallet.mjs';

const OPTIONS = Object.freeze(['endpoint', 'transportAuthority', 'fetchImpl', 'signer', 'loadKeyRecord', 'approve', 'approvalMode', 'journalMode', 'publications',
  'diagnostics', 'clock', 'buyerAccess']);
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

// The one place the kit builds the artifact anchor over a finalized session, with the host's binding and connection reader.
function composeSellerArtifactAnchor({ session, signer, buyerAccess, clock, binding, observeIdentity }) {
  return createDevnetDemoArtifactAnchor({ sourceCapability: session.transport, journal: session.artifactJournal, walletFactory: session.walletFactory,
    network: session.transport.pins.network, signer, buyerAccess, now: () => clock.now(), vetMode: VET_MODE, binding, observeIdentity });
}

/**
 * Builds the seller's production wallet-session port. The guard is checked first; then the options, a closed set: `endpoint`,
 * `transportAuthority`, `fetchImpl` (the node connection), `signer` `{ claim, sign }` (the seller signer the host takes),
 * `loadKeyRecord()` (resolves fresh `dacs-seller-key/v1` bytes), `approve`, `approvalMode`, `journalMode`, `publications` and
 * `diagnostics` (passed unchanged to the seller Node wallet), `clock` (wall-clock milliseconds, `Date.now` by default) and
 * `buyerAccess` (the anchor's, `null` by default).
 * Returns a frozen port `{ authority, connectionAuthority, artifactAnchor, finalize(input), close() }`:
 * - `authority` is the read-only capability (no sign or send); its `claim()` throws wallet_session_not_finalized until finalize.
 * - `connectionAuthority` is the client's authority reader over it; only its connection scope answers.
 * - `artifactAnchor` is the one anchor handle for the host, the Vet provider and the delivery capability. Its `source`, `authority`,
 *   `writer` and `vetMode` are fixed now; its methods reject wallet_session_not_finalized until finalize binds it to the anchor
 *   composed over the finalized session, and wallet_session_closed after a close, each before any read.
 * - `finalize({ binding, effectBoundary, stopped, feeCeilingOs, stateLock, dataDirectory })`, called once by the host's stages
 *   under the state lock, checks that the boundary was built over `binding` and that `binding` is current on this port's connection,
 *   then calls `loadKeyRecord` once, zero-fills what it returned on every outcome, builds the seller Node wallet and resolves the
 *   frozen session `{ effectPass, runInEffectPass, walletFactory, transport, acquireConnectionFence, address, observer, artifactJournal,
 *   paymentEvidence, readBalance, close }`. The session's `close()` closes the handle and the wallet; the port keeps its owner.
 * - `close()` closes a live session, then the owner, once.
 * Throws KitOperationGuardError, TypeError naming a malformed option, or the client's transport_mismatch. `finalize` rejects with
 * KitOperationGuardError, wallet_session_finalize_once, wallet_session_closed (the wallet build's refusal as `cause` when it failed),
 * wallet_session_boundary_mismatch, the wire's tp1_* refusal, SellerKeyError(seller_key_format_invalid) for a key value that is not a
 * Uint8Array, the key loader's own error, or the seller Node wallet's refusal.
 */
export function createSellerWalletSession(options) {
  assertKitOperationAdmitted('createSellerWalletSession');
  checkOptions(options);
  const { endpoint, transportAuthority, fetchImpl, signer, loadKeyRecord, approve, approvalMode, journalMode, publications, diagnostics,
    clock = { now: () => Date.now() }, buyerAccess = null } = options;
  const owner = createNodeTransportOwner({ endpoint, transportAuthority, fetchImpl });
  let finalizeCalled = false, closed = false, closing = null, session = null, anchor = null;
  const authority = createNodeAuthorityCapability({ owner, claim: () => {
    if (closed) throw sessionClosed();
    if (anchor === null) throw notFinalized();
    return signer.claim;
  } });
  const connectionAuthority = createAuthorityReader({ authority, identityRecord: TP1_APPROVED_IDENTITY_RECORD, claim: authority.claim, listings: { isRegistered: () => false },
    purchases: { findByJobId: () => null }, participantImplementations: { entriesFor: () => [] } });
  // The chain identity of the connection decision, as the anchor's readback compares it with the binding; undefined for a connection
  // the reader cannot authenticate.
  const observeConnectionIdentity = async () => {
    const decision = await boundedCall(() => connectionAuthority({ local: owner.currentLocal(), sessionId: null, participants: [] }), { timeoutMs: AUTHORITY_READ_TIMEOUT_MS })
      .catch((error) => { throw isBoundedCallTimeout(error) ? new WireError('tp1_authority_timeout', 500, undefined, error) : error; });
    return decision?.chainIdentity;
  };
  const boundAnchor = () => {
    if (closed) throw sessionClosed();
    if (anchor === null) throw notFinalized();
    return anchor;
  };
  const artifactAnchor = Object.freeze({ source: ARTIFACT_SOURCE, authority: publications.demoArtifactPublication.authority, writer: signer.claim, vetMode: VET_MODE,
    ...Object.fromEntries(ANCHOR_METHODS.map((name) => [name, async (...args) => boundAnchor()[name](...args)])) });

  // Builds the seller Node wallet; a close while it is built closes what it built and refuses wallet_session_closed.
  async function buildWallet({ binding, stopped, feeCeilingOs, stateLock, dataDirectory, keyRecord }) {
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
    const keyRecord = await loadKeyRecord();
    try {
      if (closed) throw sessionClosed();
      if (!(keyRecord instanceof Uint8Array)) throw new SellerKeyError('seller_key_format_invalid');
      const wallet = await buildWallet({ binding, stopped, feeCeilingOs, stateLock, dataDirectory, keyRecord });
      try {
        const finalized = sessionOver(wallet);
        anchor = composeSellerArtifactAnchor({ session: finalized, signer, buyerAccess, clock, binding, observeIdentity: observeConnectionIdentity });
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
    authority, connectionAuthority, artifactAnchor, finalize,
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
