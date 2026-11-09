// The seller composition's payment-evidence CREATE adapter. `signCreate` signs one storage CREATE on the signer reservation:
// one live write per signer, with the approval bound by id before anything is signed. It sends nothing: no confirmation,
// no broadcast, no recovery. The in-process queue only orders callers; the reservation is what keeps the nonce safe.
//
// Each exit of `signCreate` ends in one of these states:
//   refused         a busy signer (reservation or native write lane), an invalid input, or an abort before reserving: nothing changes.
//   adopted         this evidence's bound, never-dispatched bytes for the same input come back with no new signature.
//   retired         the same evidence's bound bytes for a changed input are retired never-dispatched and the nonce is signed afresh.
//   unsigned exit   an approval refusal or throw, a failed fee or fork read, a gate refusal, a signer failure, an abort before
//                   signing, a mismatching approval, or a bind step the read-back proves unlinked: the authorization is released
//                   and the nonce is freed.
//   kept            an abort while the preparation or the inner signature may still land, or a bind step the read-back cannot
//                   decide: the reservation stays, `signer_reservation_uncertain` is thrown and the next call reconciles it.
//                   A late result is dropped, never bound.
import { randomUUID } from 'node:crypto';
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
const ABANDONED_CAUSE = { code: 'approval-abandoned', message: 'an earlier call stopped after storing its approval intent; its request holds an older clock and fees' };

const refuse = (code, cause) => new OperationError(code, code, undefined, cause === undefined ? undefined : { cause });
const uncertain = cause => refuse(UNCERTAIN, cause);
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

// The CREATE as the journal checks it, its approval request, and the closure that compares the SDK's finalized content with both.
function planCreate(request, { signer, nonce, timestamp, postFork, networkFeeDem, rpcFeeDem, pins }) {
  const storageAddress = deriveStorageAddress(signer, request.programName, nonce, '');
  const transaction = buildStorageProgramCreatePayload({ from: signer, storageAddress, programName: request.programName, logicalAddress: request.logicalAddress,
    signedListing: request.artifact, nonce, timestamp });
  const operation = transaction.content.data[1], envelopeHash = sha256Hex(canonicalize(request.artifact));
  operation.metadata = { logicalAddress: request.logicalAddress, artifactKind: request.artifactKind, contentHash: request.receiptContentHash, envelopeHash };
  const amountOf = dem => (postFork ? String(dem * OS_PER_DEM) : Number(dem));
  const storageFeeDem = BigInt(Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(operation.data), 'utf8') / STORAGE_FEE_CHUNK_BYTES)));
  const totalDebitOs = String((storageFeeDem + GAS_DEM + networkFeeDem + rpcFeeDem) * OS_PER_DEM);
  const fee = { network_fee: amountOf(networkFeeDem), rpc_fee: amountOf(rpcFeeDem), additional_fee: amountOf(0n), rpc_address: null };
  const edits = [{ type: 'balance', operation: 'remove', isRollback: false, account: signer, txhash: '', amount: amountOf(storageFeeDem) },
    { type: 'storageProgram', target: storageAddress, isRollback: false, txhash: '', context: { operation: 'CREATE_STORAGE_PROGRAM', sender: signer, data: { variables: operation, metadata: operation.metadata } } },
    { type: 'balance', account: signer, operation: 'remove', amount: amountOf(GAS_DEM), txhash: '', isRollback: false },
    { type: 'nonce', operation: 'add', account: signer, amount: 1, txhash: '', isRollback: false }];
  const approvalRequest = { method: 'sendTransaction', address: signer, purpose: `Create immutable ${request.artifactKind} for job ${request.jobId}. Total debit ${totalDebitOs} OS.`,
    content: { kind: 'payment-evidence-storage-create', action: 'immutable DACS storage anchor CREATE', artifactKind: request.artifactKind, jobId: request.jobId, owner: request.writer,
      wallet: signer, logicalAddress: request.logicalAddress, storageAddress, programName: request.programName, contentHash: request.receiptContentHash, envelopeHash,
      exactCreate: JSON.stringify(operation), nonce, timestamp, network: pins.network, chainIdentity: pins.chainIdentity,
      debit: { storageFeeOs: String(storageFeeDem * OS_PER_DEM), gasOs: String(GAS_DEM * OS_PER_DEM), networkFeeOs: String(networkFeeDem * OS_PER_DEM),
        rpcFeeOs: String(rpcFeeDem * OS_PER_DEM), additionalFeeOs: '0', totalOs: totalDebitOs } } };
  const built = transaction.content;
  function finalContent(content) {
    const unchanged = isObject(content) && Object.keys(content).sort().join() === FINAL_CONTENT_KEYS && BUILT_CONTENT_MEMBERS.every(name => sameJson(content[name], built[name]))
      && content.from_ed25519_address === signer && content.amount === amountOf(0n) && sameJson(content.transaction_fee, fee) && sameJson(content.gcr_edits, edits);
    if (!unchanged) throw new EmbeddedWalletError('payload_mismatch', 'the finalized CREATE differs from the approved content, fee or edits; nothing was signed');
    return { totalDebitOs, feeDebitOs: totalDebitOs };
  }
  return { transaction, approvalRequest, finalContent };
}

/**
 * Creates the payment-evidence CREATE adapter over the composition's signer reservations and a Demos instance bound to the seller's wallet.
 * Returns `{signCreate(input, {signal})}`. `signCreate` resolves `{signedTransaction, txHash, nonce}`: the JSON of exactly `{hash, content,
 * signature}`, its hash and its account nonce. It must run inside the caller's effect pass and sends nothing. It rejects `signer_input_invalid`,
 * `signer_lane_busy`, `locked` (the session's wallet is locked), `user_rejected` (a refused or failed approval, cause kept), `approval_mismatch`, `node_reply_invalid`, the gate's or the
 * signer's own error (unsigned exits: the authorization is released and the nonce freed), `approval_lookup_refused` when a stored approval
 * request cannot be resolved, and `signer_reservation_uncertain` when the reservation is kept for the next call to reconcile. An abort rejects
 * with its reason.
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
  async function readChainNonce(signal) {
    await connected();
    return observeWithDeadline(({ signal: stop }) => settleOnAbort(demos.nodeCall('getAddressNonce', { address: signer }), stop), { timeoutMs: AUTHORITY_READ_DEADLINE_MS, signal });
  }
  async function readDebitInputs(signal) {
    const info = await observer.readNodeInfo('getNetworkInfo', { signal }), parameters = await observer.readNodeInfo('getNetworkParameters', { signal });
    const postFork = info?.forks?.osDenomination?.activated;
    if (typeof postFork !== 'boolean' || !isWholeDem(parameters?.networkFee) || !isWholeDem(parameters?.rpcFee)) throw refuse('node_reply_invalid');
    return { postFork, networkFeeDem: BigInt(parameters.networkFee), rpcFeeDem: BigInt(parameters.rpcFee) };
  }
  const reserveFor = (request, signal) => reservations.reserve({ signer, operation: OPERATION, operationKey: request.logicalAddress, attemptId: randomUUID(),
    readChainNonce: ({ signal: stop }) => readChainNonce(stop), signal });

  // Adopts this evidence's bound unsent bytes for the same input. Otherwise it frees what an earlier call left and returns a fresh claim.
  async function claim(request, signal) {
    const first = await reserveFor(request, signal), bound = await reservations.boundUnsent(signer, request.logicalAddress);
    if (bound?.transaction.inputDigest === request.inputDigest) {
      const { reservation, transaction } = await reservations.adopt(bound.reservation);
      return { adopted: { signedTransaction: transaction.projectionText, txHash: reservation.active.txHash, nonce: reservation.active.nonce } };
    }
    if (bound) await reservations.retireNeverDispatched(bound.reservation);
    else if (first.reservation.active.approvalIntent !== null) await reservations.retireUnsigned(first.reservation, { revision: first.reservation.revision, cause: ABANDONED_CAUSE });
    else return { claimed: first };
    return { claimed: await reserveFor(request, signal) };
  }

  // Asks the ledger once. A refusal or failure is user_rejected; an abort keeps the reservation, as the preparation may still land.
  async function prepareApproval(requestText, signal) {
    const asked = JSON.parse(requestText);
    let answer;
    try { answer = await settleOnAbort(approval.prepare(asked), signal); }
    catch (error) { throw signal.aborted ? uncertain(error) : refuse('user_rejected', error); }
    if (!answer) throw refuse('user_rejected');
    if (!sameJson(asked, JSON.parse(requestText)) || answer.requestText !== requestText) {
      if (isText(answer.ledgerId) && answer.requestText !== requestText) await approval.settle(answer.ledgerId, 'released', 'approval-mismatch');
      throw refuse('approval_mismatch');
    }
    return { ledgerId: answer.ledgerId, requestText };
  }

  // The SDK's signature. An abort while it is still unsettled keeps the reservation; its late result is dropped.
  async function signUnderGate(plan, nonce, signal) {
    await connected();
    const signing = demos.sign(structuredClone(plan.transaction), { nonce, finalContent: plan.finalContent });
    let settled = false;
    signing.then(() => { settled = true; }, () => { settled = true; });
    try { return await settleOnAbort(signing, signal); }
    catch (error) { throw settled ? error : uncertain(error); }
  }

  async function bindSignedBytes(held, signed, inputDigest) {
    const projectionText = JSON.stringify({ hash: signed.hash, content: signed.content, signature: { type: signed.signature.type, data: signed.signature.data } });
    try { await reservations.bindSigned(held, { txHash: signed.hash, projectionText, inputDigest }); }
    catch (error) { throw await settleFailedBind(held, error); }
    return { signedTransaction: projectionText, txHash: signed.hash, nonce: held.active.nonce };
  }
  // Reads ownership back after a failed bind: an unlinked reservation is retired and the failure stands; anything else stays for the next call.
  async function settleFailedBind(held, error) {
    if (error?.code === UNCERTAIN) return error;
    let current;
    try { current = await reservations.current(signer); } catch (cause) { return uncertain(cause); }
    if (current?.active?.attemptId !== held.active.attemptId || current.active.txHash !== null) return uncertain(error);
    await reservations.retireUnsigned(current, { revision: current.revision, cause: error });
    return error;
  }

  // Every failure before the signature exists frees the nonce, except an uncertain one, which keeps the reservation.
  async function signClaimed(request, claimed, signal) {
    let held = claimed.reservation, signed;
    try {
      signal.throwIfAborted();
      const plan = planCreate(request, { signer, nonce: claimed.nonce, timestamp: clock.now(), pins, ...await readDebitInputs(signal) });
      const requestText = JSON.stringify(plan.approvalRequest);
      signal.throwIfAborted();
      held = await reservations.bindApprovalIntent(held, requestText);
      held = await reservations.bindApproval(held, await prepareApproval(requestText, signal));
      signal.throwIfAborted();
      assertUnlocked();
      signed = await signUnderGate(plan, claimed.nonce, signal);
    } catch (error) {
      if (error?.code !== UNCERTAIN) await reservations.retireUnsigned(held, { revision: held.revision, cause: error });
      throw error;
    }
    return bindSignedBytes(held, signed, request.inputDigest);
  }

  return Object.freeze({
    async signCreate(input, { signal = new AbortController().signal } = {}) {
      assertUnlocked();
      const request = checkedInput(input, signer);
      signal.throwIfAborted();
      return inQueue(signal, async () => {
        await assertNativeLaneIdle();
        const { adopted, claimed } = await claim(request, signal);
        return adopted ?? signClaimed(request, claimed, signal);
      });
    },
  });
}
