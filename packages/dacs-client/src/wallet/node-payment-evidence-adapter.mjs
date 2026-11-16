// The seller composition's payment-evidence CREATE adapter. `signCreate` signs one storage CREATE on the signer reservation
// (`signer-reservation.mjs`) and sends nothing: no confirmation, no broadcast, no recovery. The reservation keeps one live
// write per signer; the in-process queue only orders callers.
//
// `signCreate` reserves the signer for the evidence's logical address and then acts on the stored record:
//   signed bytes, same input      the stored bytes come back with no new signature and no write.
//   signed bytes, other input     `signer_lane_busy`. Signed bytes are never retired: only an execution frees them.
//   approval request, no bytes    `signer_reservation_uncertain`: an earlier call stopped while its approval could still be
//                                 prepared. Startup recovery retires it.
//   a fresh claim                 reads the fees, stores the approval request, prepares the approval, binds its id, signs
//                                 with the final content check, stores the signed bytes and returns them.
// A failure before the signed bytes are stored retires the reservation, which releases its approval and keeps the nonce for
// the next call; a signature that arrives after it is dropped. Two failures keep the reservation and throw
// `signer_reservation_uncertain`: an abort while the approval is still being prepared, and a store of the signed bytes whose
// result cannot be read back.
import { canonicalize, logicalToStorageProgramName, sha256Hex } from '@kynesyslabs/dacs';
import { OperationError } from '../client-errors.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../dacs/wallet-transactions.mjs';
import { AUTHORITY_READ_DEADLINE_MS } from '../public-admission.mjs';
import { EmbeddedWalletError } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { observeWithDeadline, settleOnAbort } from '../util/http.mjs';
import { nativeWalletLaneKey } from './devnet-native-transport.mjs';

const OPERATION = 'payment-evidence';
const UNCERTAIN = 'signer_reservation_uncertain';
const OS_PER_DEM = 1_000_000_000n;
const GAS_DEM = 1n;
const STORAGE_FEE_CHUNK_BYTES = 10_240;
const NODE_ADDRESS_PREFIX = 'did:demos:agent:';
const SHA256_HEX = /^[0-9a-f]{64}$/;
const FINISHED_LANE_STAGES = ['observed', 'failed'];
const INPUT_FIELDS = ['logicalAddress', 'artifact', 'writer', 'artifactKind', 'jobId', 'receiptContentHash'];
const BUILT_CONTENT_MEMBERS = ['type', 'from', 'to', 'data', 'nonce', 'timestamp'];
const FINAL_CONTENT_KEYS = [...BUILT_CONTENT_MEMBERS, 'amount', 'from_ed25519_address', 'transaction_fee', 'gcr_edits'].sort().join();

const refuse = (code, cause) => new OperationError(code, code, undefined, cause === undefined ? undefined : { cause });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.length > 0;
const isWholeDem = value => Number.isSafeInteger(value) && value >= 0;
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// Orders callers in this process. A waiter that aborts leaves its slot to the call ahead of it, so nobody runs beside a stalled call.
function createQueue() {
  let tail = Promise.resolve();
  return async function inQueue(signal, work) {
    const ahead = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    try { await settleOnAbort(ahead, signal); } catch (error) { ahead.then(release); throw error; }
    try { return await work(); } finally { release(); }
  };
}

// The exact input with its storage program name and digest, or signer_input_invalid. Members the evidence CREATE does not carry are refused.
function checkedInput(input, signer) {
  if (!isObject(input) || Object.keys(input).some(name => !INPUT_FIELDS.includes(name))) throw refuse('signer_input_invalid');
  const fields = Object.fromEntries(INPUT_FIELDS.map(name => [name, input[name]]));
  const valid = [fields.logicalAddress, fields.artifactKind, fields.jobId].every(isText) && isObject(fields.artifact)
    && fields.writer === `${NODE_ADDRESS_PREFIX}${signer.slice(2)}` && SHA256_HEX.test(fields.receiptContentHash);
  if (!valid) throw refuse('signer_input_invalid');
  try { return { ...fields, programName: logicalToStorageProgramName(fields.logicalAddress), inputDigest: sha256Hex(canonicalize(fields)) }; }
  catch (cause) { throw refuse('signer_input_invalid', cause); }
}

// The storage fee, gas, network and RPC fee of the CREATE in whole DEM, and its total debit in OS.
function debitOf(operation, networkFeeDem, rpcFeeDem) {
  const storageFeeDem = BigInt(Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(operation.data), 'utf8') / STORAGE_FEE_CHUNK_BYTES)));
  return { storageFeeDem, totalDebitOs: String((storageFeeDem + GAS_DEM + networkFeeDem + rpcFeeDem) * OS_PER_DEM) };
}

// The CREATE as the journal checks it, its approval request, and the closure that compares the SDK's finalized content with both.
function planCreate(request, { signer, nonce, timestamp, postFork, networkFeeDem, rpcFeeDem, pins, assertUnlocked }) {
  const storageAddress = deriveStorageAddress(signer, request.programName, nonce, '');
  const transaction = buildStorageProgramCreatePayload({ from: signer, storageAddress, programName: request.programName,
    logicalAddress: request.logicalAddress, signedListing: request.artifact, nonce, timestamp });
  const operation = transaction.content.data[1], envelopeHash = sha256Hex(canonicalize(request.artifact));
  operation.metadata = { logicalAddress: request.logicalAddress, artifactKind: request.artifactKind, contentHash: request.receiptContentHash, envelopeHash };
  const amountOf = dem => (postFork ? String(dem * OS_PER_DEM) : Number(dem));
  const { storageFeeDem, totalDebitOs } = debitOf(operation, networkFeeDem, rpcFeeDem);
  const fee = { network_fee: amountOf(networkFeeDem), rpc_fee: amountOf(rpcFeeDem), additional_fee: amountOf(0n), rpc_address: null };
  const storageContext = { operation: 'CREATE_STORAGE_PROGRAM', sender: signer, data: { variables: operation, metadata: operation.metadata } };
  const edits = [
    { type: 'balance', operation: 'remove', isRollback: false, account: signer, txhash: '', amount: amountOf(storageFeeDem) },
    { type: 'storageProgram', target: storageAddress, isRollback: false, txhash: '', context: storageContext },
    { type: 'balance', account: signer, operation: 'remove', amount: amountOf(GAS_DEM), txhash: '', isRollback: false },
    { type: 'nonce', operation: 'add', account: signer, amount: 1, txhash: '', isRollback: false },
  ];
  const debit = { storageFeeOs: String(storageFeeDem * OS_PER_DEM), gasOs: String(GAS_DEM * OS_PER_DEM), networkFeeOs: String(networkFeeDem * OS_PER_DEM),
    rpcFeeOs: String(rpcFeeDem * OS_PER_DEM), additionalFeeOs: '0', totalOs: totalDebitOs };
  const approvalRequest = { method: 'sendTransaction', address: signer,
    purpose: `Create immutable ${request.artifactKind} for job ${request.jobId}. Total debit ${totalDebitOs} OS.`,
    content: { kind: 'payment-evidence-storage-create', action: 'immutable DACS storage anchor CREATE', artifactKind: request.artifactKind,
      jobId: request.jobId, owner: request.writer, wallet: signer, logicalAddress: request.logicalAddress, storageAddress,
      programName: request.programName, contentHash: request.receiptContentHash, envelopeHash, exactCreate: JSON.stringify(operation),
      nonce, timestamp, network: pins.network, chainIdentity: pins.chainIdentity, debit } };
  const built = transaction.content;
  // Runs at the inner signature, after the SDK's own awaits: a wallet locked by then signs nothing.
  function finalContent(content) {
    assertUnlocked();
    const unchanged = isObject(content) && Object.keys(content).sort().join() === FINAL_CONTENT_KEYS
      && BUILT_CONTENT_MEMBERS.every(name => sameJson(content[name], built[name])) && content.from_ed25519_address === signer
      && content.amount === amountOf(0n) && sameJson(content.transaction_fee, fee) && sameJson(content.gcr_edits, edits);
    if (!unchanged) throw new EmbeddedWalletError('payload_mismatch', 'the finalized CREATE differs from the approved content, fee or edits; nothing was signed');
    return { totalDebitOs, feeDebitOs: totalDebitOs };
  }
  return { transaction, approvalRequest, finalContent };
}

/**
 * Creates the payment-evidence CREATE adapter over the composition's signer reservations and a Demos instance bound to the
 * seller's wallet. Returns `{signCreate(input, {signal})}`. `signCreate` resolves `{signedTransaction, txHash, nonce}`: the JSON
 * of exactly `{hash, content, signature}`, its hash and its account nonce. It must run inside the caller's effect pass and
 * sends nothing. It rejects `signer_input_invalid`, `signer_lane_busy`, `locked` (the session's wallet is locked),
 * `user_rejected` (a refused or failed approval, cause kept), `approval_mismatch`, `node_reply_invalid`, the gate's or the
 * signer's own error, an abort's reason, the reservation's own refusals, and `signer_reservation_uncertain` when the
 * reservation is kept (see above).
 */
export function createPaymentEvidenceCreateAdapter({ reservations, approval, demos, observer, journal, pins, clock, rpcUrl, isWalletLocked }) {
  const signer = String(demos.getAddress()).toLowerCase(), inQueue = createQueue();

  // The adapter holds its own Demos instance, so the session's lock does not stop it; this check makes a locked wallet sign nothing.
  function assertUnlocked() {
    if (isWalletLocked()) throw new EmbeddedWalletError('locked', 'the wallet is locked; nothing was signed');
  }
  async function assertNativeLaneIdle() {
    const lane = await journal.get(nativeWalletLaneKey(pins, signer));
    if (lane !== undefined && !FINISHED_LANE_STAGES.includes(lane?.stage)) throw refuse('signer_lane_busy');
  }
  async function connected() { if (demos.rpc_url !== rpcUrl) await demos.connect(rpcUrl); }
  async function readChainNonce({ signal }) {
    await connected();
    return observeWithDeadline(({ signal: stop }) => settleOnAbort(demos.nodeCall('getAddressNonce', { address: signer }), stop),
      { timeoutMs: AUTHORITY_READ_DEADLINE_MS, signal });
  }
  async function readDebitInputs(signal) {
    const info = await observer.readNodeInfo('getNetworkInfo', { signal }), parameters = await observer.readNodeInfo('getNetworkParameters', { signal });
    const postFork = info?.forks?.osDenomination?.activated;
    if (typeof postFork !== 'boolean' || !isWholeDem(parameters?.networkFee) || !isWholeDem(parameters?.rpcFee)) throw refuse('node_reply_invalid');
    return { postFork, networkFeeDem: BigInt(parameters.networkFee), rpcFeeDem: BigInt(parameters.rpcFee) };
  }

  // Asks the ledger once and returns `{ledgerId, requestText}`. A refusal or failure is user_rejected and an answer for other
  // bytes is approval_mismatch (its hold released). An abort while `prepare` has not settled is `signer_reservation_uncertain`,
  // as the preparation may still land.
  async function prepareApproval(requestText, signal) {
    const asked = JSON.parse(requestText), preparing = (async () => approval.prepare(asked))();
    let settled = false, answer;
    preparing.then(() => { settled = true; }, () => { settled = true; });
    try { answer = await settleOnAbort(preparing, signal); }
    catch (error) { throw settled ? refuse('user_rejected', error) : refuse(UNCERTAIN, error); }
    if (!answer) throw refuse('user_rejected');
    if (!sameJson(asked, JSON.parse(requestText)) || answer.requestText !== requestText) {
      if (isText(answer.ledgerId)) await approval.settle(answer.ledgerId, 'released', 'approval-mismatch');
      throw refuse('approval_mismatch');
    }
    return { ledgerId: answer.ledgerId, requestText };
  }

  // Signs a fresh claim and stores the bytes. Every failure before they are stored retires the reservation, except an abort
  // during the preparation, which keeps it.
  async function signFresh(request, reservation, nonce, signal) {
    let held = reservation, signed;
    try {
      const plan = planCreate(request, { signer, nonce, timestamp: clock.now(), pins, assertUnlocked, ...await readDebitInputs(signal) });
      const requestText = JSON.stringify(plan.approvalRequest);
      signal.throwIfAborted();
      held = await reservations.bindApprovalIntent(held, requestText);
      held = await reservations.bindApproval(held, await prepareApproval(requestText, signal));
      signal.throwIfAborted();
      await connected();
      signed = await settleOnAbort(demos.sign(structuredClone(plan.transaction), { nonce, finalContent: plan.finalContent }), signal);
    } catch (error) {
      if (error?.code !== UNCERTAIN) await reservations.retireUnsigned(held);
      throw error;
    }
    const projectionText = JSON.stringify({ hash: signed.hash, content: signed.content, signature: { type: signed.signature.type, data: signed.signature.data } });
    try { await reservations.bindSigned(held, { txHash: signed.hash, projectionText, inputDigest: request.inputDigest }); }
    catch (error) {
      // An uncertain store was read back by the reservation and stays; any other failure proves the bytes are not stored.
      if (error?.code !== UNCERTAIN) await reservations.retireUnsigned(held);
      throw error;
    }
    return { signedTransaction: projectionText, txHash: signed.hash, nonce };
  }

  return Object.freeze({
    async signCreate(input, { signal = new AbortController().signal } = {}) {
      assertUnlocked();
      const request = checkedInput(input, signer);
      signal.throwIfAborted();
      return inQueue(signal, async () => {
        await assertNativeLaneIdle();
        const { reservation, nonce } = await reservations.reserve({ signer, operation: OPERATION, operationKey: request.logicalAddress, readChainNonce, signal });
        const { signed, approvalIntent } = reservation.active;
        if (signed !== null) {
          if (signed.inputDigest !== request.inputDigest) throw refuse('signer_lane_busy');
          return { signedTransaction: signed.projectionText, txHash: signed.txHash, nonce };
        }
        if (approvalIntent !== null) throw refuse(UNCERTAIN, new Error('an earlier call stopped while its approval could still be prepared'));
        return signFresh(request, reservation, nonce, signal);
      });
    },
  });
}
