// The seller composition's payment-evidence CREATE adapter. `signCreate` signs one storage CREATE on the signer reservation
// (`signer-reservation.mjs`) and sends nothing. `broadcast` confirms and dispatches the stored bytes, and `readTransactionState`
// reads the chain back for them; neither signs. The reservation keeps one live write per signer; the in-process queue only
// orders callers.
//
// `signCreate` reserves the signer for the evidence's logical address and then acts on the stored record:
//   signed bytes, same input      the stored bytes come back with no new signature and no write.
//   signed bytes, other input     `signer_lane_busy`. Signed bytes are never retired: only an execution frees them. For another
//                                 address, `signCreate` first reads the chain for those bytes and consumes them if they executed.
//   approval request, no bytes    `signer_reservation_uncertain`: an earlier call stopped while its approval could still be
//                                 prepared. Startup recovery retires it.
//   a fresh claim                 reads the fees, stores the approval request, prepares the approval, binds its id, signs
//                                 with the final content check, stores the signed bytes and returns them.
// A failure before the signed bytes are stored retires the reservation, which releases its approval and keeps the nonce for
// the next call; a signature that arrives after it is dropped. Two failures keep the reservation and throw
// `signer_reservation_uncertain`: an abort while the approval is still being prepared, and a store of the signed bytes whose
// result cannot be read back.
//
// `approveAhead` takes the approval outside every pass, holding no lock, queue, fence or pass while the operator decides. With
// the same checks before it reserves and right before it asks (wallet lock, purchase hold, the ledger's `revocationGeneration()`,
// one synchronous `stopped()` read), it claims and plans as a fresh claim does, asks `prepare`, binds the answer and resolves a
// hold for those exact bytes (`approval-hold.mjs`). `signCreate(input, {approval})` uses it once in the caller's pass: only this
// adapter's hold is taken, the input, reservation, open authorization, chain nonce and fee reads must be the approved ones, and
// the gate's last synchronous run checks that the hold is current right before the planned bytes are signed. An unused or failed
// hold retires the reservation as above, after a grant the operator gave alone is settled `released` by its token. Until then
// the signer stays reserved, and other writes of it are refused `signer_lane_busy`.
//
// `approveSendAhead` does the same for kept bytes: with the same checks, it runs the broadcast's authorization step below before
// the pass and resolves a send hold. Only a replacement's `prepare` runs outside the queue, and it holds no lock, fence or pass.
// `broadcast(retained, {approval})` then asks the ledger nothing new: the authorization must still be the reservation's and open,
// and the gate's last synchronous run before `broadcastTx` checks that the hold is current. Releasing a send hold changes nothing.
//
// `broadcast` acts on the signed bytes the reservation holds, once per call and with no retry:
//   authorization  the stored approval id is reopened. An id the ledger no longer holds open may have been spent by an execution
//                  whose reservation write did not commit, so the chain is read for the held bytes first, with the readback below:
//                  an execution ends the reservation and is `transaction_already_executed`, and only a chain that answers it has not
//                  seen the hash lets the id be replaced; any other answer refuses. An id the ledger shows spent is never replaced,
//                  whatever the chain answers. The replacement is the exact request's open authorization or a new one, and the
//                  reservation stores its id before anything is sent. A manual authorization has no id and also reads the chain
//                  before every broadcast.
//   confirmation   the node's chain identity is checked first, then `confirmTx` with the exact projection. An answer that is not a
//                  valid confirmation of those bytes is unknown and never advances; a valid refusal is `confirm_rejected`.
//   policy         `approval.confirm` runs on every replay against the held authorization; `false` or a throw sends nothing.
//   dispatch       under the signer's reservation lock, the reservation must still hold these bytes; then one `broadcastTx`, still
//                  under the lock. Whatever goes wrong after it starts is `outcome_unknown`: the receiver may hold the bytes.
// `readTransactionState` answers `applied` only when the chain executed exactly these bytes, lists the hash in its block and serves
// the storage program the CREATE made; it then ends the reservation holding them and settles its authorization spent, or ends it
// without a settlement when the ledger refuses the spend and no longer holds the authorization open. Every other outcome is
// `pending` with its cause kept. It never answers `absent`.
import { canonicalize, demosTransactionContentMatches, logicalToStorageProgramName, sha256Hex } from '@kynesyslabs/dacs';
import { OperationError } from '../client-errors.mjs';
import { creationProvenanceMatches } from '../dacs/demos-sr2-adapter.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../dacs/wallet-transactions.mjs';
import { classifyStorageWriteSubmission, rpcEnvelope, storageWriteAccountNonce, storageWriteConfirmationMatches, storageWriteIdentityMatches } from '../devnet-demo/storage-write-recovery.mjs';
import { AUTHORITY_READ_DEADLINE_MS, notAdmittedError, purchaseActionsAdmitted } from '../public-admission.mjs';
import { EmbeddedWalletError } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { verifyDemosSignature } from '../signatures.mjs';
import { fetchBoundedJson, observeWithDeadline, settleOnAbort } from '../util/http.mjs';
import { assertNotStoppedNow, createApprovalHold, endApprovalHold, takeApprovalHold } from './approval-hold.mjs';
import { nativeWalletLaneKey } from './devnet-native-transport.mjs';
import { hasKeys } from './payload-helpers.mjs';
import { signerReservationKey } from './signer-reservation.mjs';

const OPERATION = 'payment-evidence';
const UNCERTAIN = 'signer_reservation_uncertain';
const RETAINED_INVALID = 'retained_transaction_invalid';
const ALREADY_EXECUTED = 'transaction_already_executed';
const NOT_EXECUTED = 'transaction_not_executed';
const SETTLEMENT_FAILED = 'signer_settlement_failed';
const APPROVAL_UNAVAILABLE = 'approval_reservation_unavailable';
const NODE_REPLY_MAX_BYTES = 4 * 1024 * 1024;
const MAX_BLOCK_TRANSACTIONS = 10_000;
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
 * seller's wallet. `owner`, `fetchImpl` and `stamps` are the composition's transport owner, its effect-gated fetch and its RPC
 * stamp source; `recordCause(answer, error)` keeps the cause of a `pending` answer. Returns `{approveAhead, approveSendAhead,
 * signCreate, broadcast, readAccountNonce, readTransactionState}`. `signCreate(input, {signal})` resolves `{signedTransaction, txHash, nonce}`: the JSON
 * of exactly `{hash, content, signature}`, its hash and its account nonce. It must run inside the caller's effect pass and
 * sends nothing. It rejects `signer_input_invalid`, `signer_lane_busy`, `locked` (the session's wallet is locked),
 * `user_rejected` (a refused or failed approval, cause kept), `approval_mismatch`, `node_reply_invalid`, the gate's or the
 * signer's own error, an abort's reason, the reservation's own refusals, and `signer_reservation_uncertain` when the
 * reservation is kept (see above). Given `{approval}`, a hold from `approveAhead`, it asks the ledger nothing and also rejects
 * `approval_required` (a hold not this adapter's or no longer current, or a changed reservation or authorization).
 * `approveAhead(input, {signal})` runs outside every effect pass and resolves `{answer}`, the bytes already stored for this input,
 * or `{approval}`, a hold whose `release()` never rejects: `{released: true}`, or `{released: false}` with the cause kept by
 * `recordCause`. Before it reserves and again before it asks it rejects `locked`, `profile_not_admitted`, `approval_required`
 * (the ledger has no `revocationGeneration()`) and the stop codes of `stopped`, the composition's stop check, which it must
 * answer synchronously; then it rejects as `signCreate` does for the same steps. Every member's `signal` is optional.
 * `broadcast({signedTransaction, txHash}, {signal})` must also run in an effect pass. It resolves `{status: 'accepted', txHash}`
 * after one dispatch of the held bytes and signs nothing. It rejects `retained_transaction_invalid` (the reservation does not
 * hold exactly these bytes, at the start or at the send; nothing was sent), the observer's refusal (the node does not serve the
 * pinned chain; nothing was sent), a journal error such as `journal-busy` (the signer's lock was not free; nothing was sent),
 * `approval_required` (the authorization could not be reopened, renewed or confirmed
 * by current policy, or the chain could not show that the bytes never ran; nothing was sent), `transaction_already_executed` (the
 * stored authorization is no longer open and the chain shows the execution, which ended the reservation; nothing was sent),
 * `confirm_rejected` (the node refused the confirmation), `outcome_unknown` (the confirmation or the dispatch has no valid answer;
 * the cause is kept), `locked`, or an abort's reason before the dispatch starts.
 * `approveSendAhead({signedTransaction, txHash}, {signal})` runs outside every effect pass, with `approveAhead`'s checks before its
 * reads and again before it asks for a replacement. It resolves `{approval}`, a send hold for the authorization of the held bytes,
 * and rejects as `broadcast` does before the dispatch. Given `{approval}`, `broadcast` asks the ledger nothing new and also rejects
 * `approval_required` (a hold not this adapter's or for other bytes, or an authorization no longer the reservation's, open or
 * current, also at the gate's last check before the send; nothing was sent).
 * `readAccountNonce({signal})` resolves the account nonce, or rejects `node_reply_invalid` or `invalid_nonce`.
 * `readTransactionState({signedTransaction, txHash, nonce}, {signal})` resolves `{state: 'applied' | 'pending'}` and never rejects
 * for a failed read; a `pending` answer's cause is `internalCauseOf(answer)`. It starts no read after an abort. The seller journal
 * passes the bytes and nonce it keeps, which also reads a CREATE whose reservation has ended. Given `{txHash}` alone, it reads back
 * the bytes and nonce of the reservation holding that hash, and is `pending` when none does.
 */
export function createPaymentEvidenceCreateAdapter({ reservations, approval, demos, observer, journal, pins, clock, rpcUrl, isWalletLocked, owner, fetchImpl, stamps, stopped, recordCause }) {
  const signer = String(demos.getAddress()).toLowerCase(), inQueue = createQueue();
  // The sign attempts of `approveAhead` that this adapter made and that have not ended.
  const liveAttempts = new Set();

  // The adapter holds its own Demos instance, so the session's lock does not stop it; this check makes a locked wallet sign nothing.
  function assertUnlocked() {
    if (isWalletLocked()) throw new EmbeddedWalletError('locked', 'the wallet is locked; nothing was signed');
  }
  // Runs before an ahead approval reserves anything and again in the same synchronous step that asks the ledger.
  function assertReadyToAsk() {
    assertUnlocked();
    if (!purchaseActionsAdmitted()) throw notAdmittedError();
    const reportsWithdrawals = typeof approval.revocationGeneration === 'function';
    if (!reportsWithdrawals) throw refuse('approval_required', new Error('the approval ledger cannot report a withdrawal synchronously; nothing was reserved or asked'));
    assertNotStoppedNow(stopped);
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
  // The fee inputs are approved and signed over, so they are read only from a node whose chain is the pinned one.
  async function readDebitInputs(signal) {
    await observer.observe({ signal });
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
      if (isText(answer.ledgerId)) await approval.settle({ ledgerId: answer.ledgerId, requestText }, 'released', 'approval-mismatch');
      throw refuse('approval_mismatch');
    }
    return answer;
  }

  // Every failure before the signed bytes are stored retires the reservation, except an abort during the preparation and a
  // store whose read-back cannot decide, which keep it: an uncertain store was read back by the reservation and stays.
  async function retireUnlessUncertain(held, error) {
    if (error?.code !== UNCERTAIN) await reservations.retireUnsigned(held);
  }
  // Reads the fees, plans the CREATE at `nonce` and stores its exact approval request on the reservation.
  async function planFresh(request, reservation, nonce, signal) {
    const debitInputs = await readDebitInputs(signal);
    const plan = planCreate(request, { signer, nonce, timestamp: clock.now(), pins, assertUnlocked, ...debitInputs });
    const requestText = JSON.stringify(plan.approvalRequest);
    signal.throwIfAborted();
    return { held: await reservations.bindApprovalIntent(reservation, requestText), plan, requestText, debitInputs };
  }
  // Asks the ledger for the stored request and binds its answer. Given an attempt, the answer is kept on it as soon as the ledger
  // gives it, so a manual grant whose binding then fails is still settled.
  async function approveFresh(held, requestText, signal, attempt = null) {
    const binding = await prepareApproval(requestText, signal);
    if (attempt) attempt.binding = binding;
    return { held: await reservations.bindApproval(held, binding), binding };
  }
  // Signs the planned bytes of an approved claim `{request, held, plan, nonce}` and stores them. `finalCheck` runs in the gate's
  // last synchronous run, right before the plan's own final content check and the inner signature. A signature that arrives
  // after an abort is dropped.
  async function signPlanned({ request, held, plan, nonce }, signal, finalCheck) {
    signal.throwIfAborted();
    await connected();
    const finalContent = content => { finalCheck(); return plan.finalContent(content); };
    const signed = await settleOnAbort(demos.sign(structuredClone(plan.transaction), { nonce, finalContent }), signal);
    const projectionText = JSON.stringify({ hash: signed.hash, content: signed.content, signature: { type: signed.signature.type, data: signed.signature.data } });
    await reservations.bindSigned(held, { txHash: signed.hash, projectionText, inputDigest: request.inputDigest });
    return { signedTransaction: projectionText, txHash: signed.hash, nonce };
  }
  // Signs a fresh claim in one call and stores the bytes.
  async function signFresh(request, reservation, nonce, signal) {
    let held = reservation;
    try {
      const { plan, requestText, held: intended } = await planFresh(request, held, nonce, signal);
      held = intended;
      ({ held } = await approveFresh(held, requestText, signal));
      return await signPlanned({ request, held, plan, nonce }, signal, () => {});
    } catch (error) {
      await retireUnlessUncertain(held, error);
      throw error;
    }
  }

  // The retained text as a signed storage CREATE of this signer: its hash, its signature and its shape.
  function parseRetained({ signedTransaction, txHash }) {
    let tx;
    try { tx = JSON.parse(signedTransaction); } catch (cause) { throw refuse(RETAINED_INVALID, cause); }
    const content = tx?.content;
    const signed = hasKeys(tx, ['hash', 'content', 'signature']) && hasKeys(tx.signature, ['type', 'data']) && tx.hash === txHash && tx.signature.type === 'ed25519'
      && isObject(content) && sha256Hex(JSON.stringify(content)) === txHash && verifyDemosSignature({ address: signer, message: txHash, signature: tx.signature.data });
    if (!(signed && content.from === signer && content.type === 'storageProgram' && content.data?.[0] === 'storageProgram' && content.data[1]?.operation === 'CREATE_STORAGE_PROGRAM')) throw refuse(RETAINED_INVALID);
    return tx;
  }
  // The reservation that holds the signed bytes of this hash, or null when none does. Other text under that hash is refused.
  async function reservationHolding({ signedTransaction, txHash }) {
    const held = await reservations.current(signer), signed = held?.active?.signed;
    if (signed?.txHash !== txHash) return null;
    if (held.active.operation !== OPERATION || signed.projectionText !== signedTransaction) throw refuse(RETAINED_INVALID);
    return held;
  }

  // The authorization the held bytes were signed under, reopened by id; null when the ledger no longer holds it open.
  async function reopenApproval(approvalId, requestText, signal) {
    let reopened;
    try { reopened = await settleOnAbort(approval.reopen(approvalId), signal); }
    catch (cause) { if (cause?.code === APPROVAL_UNAVAILABLE && !signal.aborted) return null; throw cause; }
    if (reopened?.ledgerId !== approvalId || reopened.requestText !== requestText) throw refuse('approval_mismatch');
    return reopened;
  }
  // The exact request's open authorization, else a new one; with `ask` false, the open one or null. A preparation that failed may
  // have committed, so it is read back first.
  async function replacementApproval(requestText, signal, ask = true) {
    const open = await settleOnAbort(approval.open(requestText), signal);
    if (open !== null || !ask) return open;
    try { return await prepareApproval(requestText, signal); }
    catch (cause) {
      const committed = await settleOnAbort(approval.open(requestText), signal);
      if (committed === null) throw cause;
      return committed;
    }
  }
  // Reopens the stored authorization by id. One the ledger no longer holds open is replaced only after the chain shows the held bytes
  // never ran (`assertNotExecuted`) and the ledger shows the authorization was not spent (`assertNotSpent`), and the reservation
  // stores the replacement's id before anything is sent. A manual authorization has no id and is asked for again; it also reads the
  // chain for the held bytes before every broadcast. With `ask` false nothing is prepared, and null means nothing is open.
  async function replayApproval(held, signal, { ask = true } = {}) {
    const { approvalId, approvalIntent: requestText } = held.active;
    try {
      const reopened = approvalId === null ? null : await reopenApproval(approvalId, requestText, signal);
      if (reopened !== null) return reopened;
      await assertNotExecuted(held.active.signed.txHash, signal);
      if (approvalId !== null) await assertNotSpent({ ledgerId: approvalId, requestText }, signal);
      const binding = await replacementApproval(requestText, signal, ask);
      return binding === null && !ask ? null : await renewedBinding(held, binding);
    } catch (cause) { throw signal.aborted || cause?.code === ALREADY_EXECUTED ? cause : refuse('approval_required', cause); }
  }
  // The replacement must be for the held request; the reservation stores a new id before anything is sent.
  async function renewedBinding(held, binding) {
    if (binding?.requestText !== held.active.approvalIntent) throw refuse('approval_mismatch');
    if (binding.ledgerId !== null && binding.ledgerId !== held.active.approvalId) await reservations.renewApproval(held, binding);
    return binding;
  }
  // Asks for the held request's replacement, outside the queue: its open authorization again, else a new one, then the renewal.
  async function askReplacement(held, signal) {
    try { return await renewedBinding(held, await replacementApproval(held.active.approvalIntent, signal)); }
    catch (cause) { throw signal.aborted ? cause : refuse('approval_required', cause); }
  }
  // An authorization is settled spent only by a consume after a proven execution, so an execution whose reservation write did not
  // commit leaves a record naming a spent id. The readback runs on the held hash before any replacement: a proven execution ends the
  // reservation (the stored id is settled spent again, which the ledger treats as a repeat) and refuses. Only the chain's answer that
  // it has not seen the hash lets a replacement through; any other answer cannot tell, and its cause is thrown.
  async function assertNotExecuted(txHash, signal) {
    try { await endIfExecuted({ txHash }, signal); } catch (cause) {
      if (cause?.code === NOT_EXECUTED) return;
      throw cause;
    }
    throw refuse(ALREADY_EXECUTED);
  }
  // An id the ledger does not hold open is released or spent. A spent one belongs to an execution whose reservation write did not
  // commit, so a status that has not seen the hash (it may be stale) never replaces it. Settling the binding `released` again is a
  // repeat for a released authorization and is refused for a spent one; it changes nothing either way. A ledger that cannot answer
  // refuses too.
  async function assertNotSpent(binding, signal) {
    await settleOnAbort(approval.settle(binding, 'released', 'replacement-check'), signal);
  }
  // The approved request must describe these very bytes.
  function assertApprovalCovers(requestText, content) {
    const asked = JSON.parse(requestText).content;
    if (asked?.exactCreate !== JSON.stringify(content.data[1]) || asked.wallet !== signer || asked.nonce !== content.nonce || asked.timestamp !== content.timestamp) {
      throw refuse('approval_required', refuse('approval_mismatch'));
    }
  }

  // One bounded request to the pinned node, after the transport's current context is checked against the pins. A `finalCheck`
  // reaches the composition's `fetchImpl` as its third argument, which runs it in the gate's last synchronous run before the send.
  async function fetchPinned(url, options, signal, finalCheck) {
    signal.throwIfAborted();
    const context = await owner.getContext();
    if (context.network !== pins.network || context.endpoint !== pins.endpoint || context.transportAuthority !== pins.transportAuthority) throw refuse('transport_mismatch');
    signal.throwIfAborted();
    const send = finalCheck ? (input, init) => fetchImpl(input, init, { finalCheck }) : fetchImpl;
    return fetchBoundedJson(url, { ...options, fetchImpl: send, signal, timeoutMs: AUTHORITY_READ_DEADLINE_MS, maxBytes: NODE_REPLY_MAX_BYTES, expectedOrigin: new URL(pins.endpoint).origin });
  }
  const post = (body, headers, signal, finalCheck) => fetchPinned(pins.endpoint, { method: 'POST', body, headers }, signal, finalCheck);
  // A confirmTx or broadcastTx body with fresh authentication headers from the wallet's stamp source; the effect gate runs in `fetchImpl`.
  async function execute(stage, data, signal, finalCheck) {
    signal.throwIfAborted();
    const identity = `ed25519:${signer}`, timestamp = String(stamps.next(identity));
    const { data: signature } = await settleOnAbort(demos.signMessage(sha256Hex(`${identity}:${timestamp}`), { algorithm: 'ed25519', raw: true }), signal);
    return post({ method: 'execute', params: [{ message: '', data, extra: stage }] }, { identity, timestamp, signature }, signal, finalCheck);
  }
  async function nodeRead(message, data, signal) {
    const answer = await post({ method: 'nodeCall', params: [{ message, data }] }, {}, signal);
    signal.throwIfAborted();
    if (!rpcEnvelope(answer, 200, extra => extra === null || extra === '')) throw refuse('node_reply_invalid');
    return answer.response;
  }

  // The session's five-member confirmation shape does not apply to this executable three-member projection. A `valid: false`
  // answer is checked as if it were valid, so a refusal is told apart from a malformed answer.
  function paymentEvidenceConfirmationMatches(answer, signedTransaction) {
    const data = answer?.response?.data;
    return rpcEnvelope(answer, 200, null) && typeof data?.valid === 'boolean' && storageWriteConfirmationMatches({ ...answer.response, data: { ...data, valid: true } })
      && hasKeys(data.transaction, ['hash', 'content', 'signature']) && hasKeys(data.transaction.signature, ['type', 'data']) && JSON.stringify(data.transaction) === signedTransaction;
  }
  async function confirmRetained(tx, retained, signal) {
    let validity;
    try { validity = await execute('confirmTx', tx, signal); }
    catch (cause) { throw signal.aborted ? cause : refuse('outcome_unknown', cause); }
    if (!paymentEvidenceConfirmationMatches(validity, retained.signedTransaction)) throw refuse('outcome_unknown', refuse('node_reply_invalid'));
    if (!validity.response.data.valid) throw refuse('confirm_rejected', new Error(validity.response.data.message));
    return validity;
  }
  // With a taken send hold `{hold, attempt}`, the authorization is the hold's, checked again and never asked for anew, and the
  // hold must still be current right before the dispatch and in the gate's last synchronous run before the send.
  async function replay(retained, signal, { hold = null, attempt = null } = {}) {
    assertUnlocked();
    signal.throwIfAborted();
    const tx = parseRetained(retained), held = await reservationHolding(retained);
    if (held === null) throw refuse(RETAINED_INVALID);
    const binding = attempt ? await heldSendApproval(held, attempt, signal) : await replayApproval(held, signal);
    assertApprovalCovers(binding.requestText, tx.content);
    // The confirmation reaches the approval, so it is asked only of a node whose chain is the pinned one.
    await observer.observe({ signal });
    const validity = await confirmRetained(tx, retained, signal);
    try {
      if (await settleOnAbort(approval.confirm(binding, validity), signal) !== true) throw new Error('the approval ledger did not confirm the write');
      if (!paymentEvidenceConfirmationMatches(validity, retained.signedTransaction)) throw new Error('the confirmation changed during the policy check');
    } catch (cause) { throw signal.aborted ? cause : refuse('approval_required', cause); }
    signal.throwIfAborted();
    if (hold && hold.revision() === null) throw refuse('approval_required', new Error('the approval held for this send is no longer current; nothing was sent'));
    return dispatchHeld(retained, validity, signal, hold);
  }
  // The send runs under the signer's reservation lock: a native write holds it from its reservation check through its send, and a
  // readback holds it to end the reservation. So the reservation is read again under it and must still hold exactly these bytes.
  // Only this lock is taken, never a lane lock, so the native transport's order (lane lock, then this one) is never reversed.
  // With a hold, the gate checks it in its last synchronous run before the send; that refusal comes before anything is sent.
  function dispatchHeld(retained, validity, signal, hold = null) {
    let refusedAtBarrier = false;
    const finalCheck = hold ? () => {
      if (hold.revision() !== null) return;
      refusedAtBarrier = true;
      throw new EmbeddedWalletError('approval_required', 'the approval held for this send is no longer current; nothing was sent');
    } : undefined;
    return journal.withWalletLock(signerReservationKey(pins, signer), async () => {
      if (await reservationHolding(retained) === null) throw refuse(RETAINED_INVALID);
      signal.throwIfAborted();
      try {
        const answer = await execute('broadcastTx', validity, signal, finalCheck);
        if (classifyStorageWriteSubmission(answer, retained.txHash) !== 'accepted') throw refuse('node_reply_invalid');
        return { status: 'accepted', txHash: retained.txHash };
      } catch (cause) { throw refuse(refusedAtBarrier ? 'approval_required' : 'outcome_unknown', cause); }
    });
  }

  // The executed form of the original: successful, in the status's block, with the same signature and complete content. The node
  // also reports an empty `ed25519_signature` and `attrs` beside the signed members; any other member refuses.
  function executedMatches(executed, tx, blockNumber) {
    const { ed25519_signature: dual = null, attrs, ...reported } = isObject(executed) ? executed : {};
    return hasKeys(reported, ['hash', 'content', 'signature', 'status', 'blockNumber']) && (dual === null || dual === '') && (attrs === undefined || isObject(attrs))
      && reported.hash === tx.hash && reported.status === 'confirmed' && reported.blockNumber === blockNumber && sameJson(reported.signature, tx.signature)
      && isObject(reported.content) && demosTransactionContentMatches(tx.content, reported.content, tx.hash);
  }
  // An authenticated block of this chain that lists the hash; block one's previous hash is the chain identity. Only the members that
  // decide this are read: the block's `content` also carries the node's other members, which are accepted.
  function blockListsHash(block, blockNumber, txHash) {
    const { previousHash, ordered_transactions: hashes } = isObject(block?.content) ? block.content : {};
    return (hasKeys(block, ['number', 'status', 'hash', 'content']) || storageWriteIdentityMatches(block)) && block.number === blockNumber && block.status === 'confirmed' && SHA256_HEX.test(block.hash)
      && (blockNumber !== 1 || previousHash === pins.chainIdentity)
      && Array.isArray(hashes) && hashes.length <= MAX_BLOCK_TRANSACTIONS && hashes.every(hash => SHA256_HEX.test(hash)) && hashes.includes(txHash);
  }
  // The node must serve the program this CREATE made: its address, its exact data and metadata, its program name, the signer as owner,
  // and creation provenance that names this CREATE (both members, or neither).
  async function verifyStorageProgram(tx, signal) {
    const operation = tx.content.data[1];
    if (tx.content.to !== deriveStorageAddress(signer, operation.programName, tx.content.nonce, '')) throw refuse('readback_unverified');
    const program = await fetchPinned(`${pins.endpoint.replace(/\/$/, '')}/storage-program/${tx.content.to}`, {}, signal);
    signal.throwIfAborted();
    const programOwner = typeof program?.owner === 'string' ? program.owner.toLowerCase() : null;
    const matches = program?.success === true && programOwner === signer && program.storageAddress === tx.content.to && program.programName === operation.programName
      && isObject(program.data) && canonicalize(program.data) === canonicalize(operation.data) && isObject(program.metadata) && canonicalize(program.metadata) === canonicalize(operation.metadata)
      && creationProvenanceMatches(program, tx.hash, true);
    if (!matches) throw refuse('readback_unverified');
  }
  // Only the exact answer `{state: 'unknown'}` says the chain has not seen the hash (`transaction_not_executed`); it is still not applied.
  async function verifyExecution(tx, signal) {
    await observer.observe({ signal });
    const status = await nodeRead('getTransactionStatus', { hash: tx.hash }, signal);
    if (hasKeys(status, ['state']) && status.state === 'unknown') throw refuse(NOT_EXECUTED);
    if (!hasKeys(status, ['state', 'blockNumber']) || status.state !== 'included' || !Number.isSafeInteger(status.blockNumber) || status.blockNumber < 0) throw refuse('readback_unverified');
    const executed = await nodeRead('getTxByHash', { hash: tx.hash }, signal);
    if (!executedMatches(executed, tx, status.blockNumber)) throw refuse('readback_unverified');
    if (!blockListsHash(await nodeRead('getBlockByNumber', { blockNumber: status.blockNumber }, signal), status.blockNumber, tx.hash)) throw refuse('readback_unverified');
    await verifyStorageProgram(tx, signal);
  }
  // A caller that names only the hash gets the bytes and nonce of the reservation holding it; no reservation holds them otherwise.
  async function retainedFor({ txHash, signedTransaction, nonce }) {
    if (signedTransaction !== undefined) return { txHash, signedTransaction, nonce };
    const { active } = (await reservations.current(signer)) ?? {};
    if (active?.operation !== OPERATION || active.signed?.txHash !== txHash) throw refuse(RETAINED_INVALID);
    return { txHash, signedTransaction: active.signed.projectionText, nonce: active.nonce };
  }
  // Ends the reservation that holds the proven bytes. An authorization the operator released cannot be settled spent and would keep
  // the signer reserved after the execution: when the ledger refuses the spend and no longer holds it open, the reservation ends
  // without a settlement. A ledger that still holds it open, or cannot be read, keeps the reservation.
  async function consumeExecuted(held, observation, signal) {
    try { await reservations.consume(held, observation); } catch (cause) {
      const { approvalId, approvalIntent } = held.active;
      if (cause?.code !== SETTLEMENT_FAILED || approvalId === null || await reopenApproval(approvalId, approvalIntent, signal) !== null) throw cause;
      await reservations.consume(held, observation, { approvalEnded: true });
    }
  }
  // Returns once the chain proves the execution of exactly the retained bytes, after the reservation holding them, if any, ended;
  // throws the cause otherwise.
  async function endIfExecuted(asked, signal) {
    signal.throwIfAborted();
    const retained = await retainedFor(asked), tx = parseRetained(retained), held = await reservationHolding(retained);
    if (retained.nonce !== tx.content.nonce) throw refuse(RETAINED_INVALID);
    await verifyExecution(tx, signal);
    signal.throwIfAborted();
    if (held !== null) await consumeExecuted(held, { status: 'executed', authenticated: true, txHash: tx.hash, projectionText: retained.signedTransaction }, signal);
  }
  // `applied` after `endIfExecuted` returns; `pending` with the cause kept otherwise.
  async function transactionState(asked, signal) {
    try {
      await endIfExecuted(asked, signal);
      return { state: 'applied' };
    } catch (cause) {
      const answer = { state: 'pending' };
      recordCause(answer, cause);
      return answer;
    }
  }

  // Signed bytes of another address hold the signer until the chain executes them. The chain is read here, before the signer's lock is taken;
  // `reserve` then refuses `signer_lane_busy` unless the bytes were consumed.
  async function freeSignerIfExecuted(logicalAddress, signal) {
    const { active } = (await reservations.current(signer)) ?? {};
    if (active?.signed == null || active.operationKey === logicalAddress) return;
    await transactionState({ txHash: active.signed.txHash }, signal);
    signal.throwIfAborted();
  }
  // Claims the signer for the input: `{answer}` (its stored bytes) or `{reservation, nonce}`. A stored request without bytes is
  // uncertain, or busy while this adapter's own ahead approval for it is in progress.
  async function claimFor(request, signal) {
    await freeSignerIfExecuted(request.logicalAddress, signal);
    // The lane is checked under the signer's lock, the lock the native transport holds to issue a write, so no write is issued between this check and the claim.
    const { reservation, nonce } = await reservations.reserve({ signer, operation: OPERATION, operationKey: request.logicalAddress, readChainNonce, signal, beforeClaim: assertNativeLaneIdle });
    const { signed, approvalIntent, attemptId } = reservation.active;
    if (signed !== null) {
      if (signed.inputDigest !== request.inputDigest) throw refuse('signer_lane_busy');
      return { answer: { signedTransaction: signed.projectionText, txHash: signed.txHash, nonce } };
    }
    if (approvalIntent === null) return { reservation, nonce };
    const inProgress = [...liveAttempts].some(attempt => attempt.kind === 'sign' && attempt.held.active.attemptId === attemptId);
    if (inProgress) throw refuse('signer_lane_busy', new Error('an approval for this evidence is in progress; nothing was signed'));
    throw refuse(UNCERTAIN, new Error('an earlier call stopped while its approval could still be prepared'));
  }

  // A grant the operator gave alone has no ledger id, and the reservation settles nothing for it: it is ended here by its token.
  async function settleManualGrant({ binding }) {
    if (binding?.ledgerId === null) await approval.settle(binding, 'released', 'unsigned-retired');
  }
  // Ends a sign attempt that failed before its bytes were stored. A manual grant is settled first; if that fails, its cause is
  // recorded on `error` and the reservation is kept. With `retire` false the reservation is no longer the attempt's and stays.
  async function retireAttempt(attempt, error, { retire = true } = {}) {
    liveAttempts.delete(attempt);
    if (error?.code === UNCERTAIN) return;
    try { await settleManualGrant(attempt); } catch (cause) {
      if (Object(error) === error) recordCause(error, cause);
      return;
    }
    if (retire) await retireUnlessUncertain(attempt.held, error);
  }
  // Settles an unused hold. Never rejects: a failure is `{released: false}` with its cause, and recovery retires the reservation.
  // A send hold's authorization stays with the kept bytes, which the reservation keeps.
  async function releaseAttempt(attempt) {
    liveAttempts.delete(attempt);
    if (attempt.kind === 'send') return Object.freeze({ released: true });
    try {
      await settleManualGrant(attempt);
      await reservations.retireUnsigned(attempt.held);
      return Object.freeze({ released: true });
    } catch (error) {
      const answer = Object.freeze({ released: false });
      recordCause(answer, error);
      return answer;
    }
  }
  // Claims and plans in the queue, then asks outside it, right after the checks run again with no await in between.
  async function approveClaim(request, signal) {
    const claim = await inQueue(signal, async () => {
      const claimed = await claimFor(request, signal);
      if (claimed.answer) return claimed;
      const attempt = { kind: 'sign', request, held: claimed.reservation, nonce: claimed.nonce, binding: null };
      liveAttempts.add(attempt);
      try { Object.assign(attempt, await planFresh(request, attempt.held, attempt.nonce, signal)); }
      catch (error) { await retireAttempt(attempt, error); throw error; }
      return { attempt };
    });
    if (claim.answer) return { answer: claim.answer };
    const { attempt } = claim;
    try {
      assertReadyToAsk();
      attempt.held = (await approveFresh(attempt.held, attempt.requestText, signal, attempt)).held;
    } catch (error) { await retireAttempt(attempt, error); throw error; }
    return { approval: createApprovalHold({ requestText: attempt.requestText, attempt, stopped,
      revocationGeneration: () => approval.revocationGeneration(), settle: releaseAttempt }) };
  }
  // The ledger still holds the attempt's authorization open: its id reopens, or a manual grant is open under the same token.
  // Returns the ledger's answer.
  async function assertAuthorizationOpen(binding, signal) {
    let open;
    try {
      open = binding.ledgerId === null ? await settleOnAbort(approval.open(binding.requestText), signal) : await reopenApproval(binding.ledgerId, binding.requestText, signal);
    } catch (cause) { throw signal.aborted ? cause : refuse('approval_required', cause); }
    const stillOpen = binding.ledgerId === null ? open?.ledgerId === null && open.requestText === binding.requestText && open.token === binding.token : open !== null;
    if (!stillOpen) throw refuse('approval_required', new Error('the approval is no longer open; nothing was signed or sent'));
    return open;
  }
  // A send hold's authorization must still be the reservation's and still open; nothing is asked of the ledger.
  async function heldSendApproval(held, { binding }, signal) {
    const { approvalId, approvalIntent } = held.active;
    if (approvalIntent !== binding.requestText || approvalId !== binding.ledgerId) throw refuse('approval_required', new Error('the reservation no longer holds the approved authorization; nothing was sent'));
    return assertAuthorizationOpen(binding, signal);
  }
  // The chain's next nonce and the fee reads must still be the ones the approved bytes were planned from.
  async function assertPlannedInputs(attempt, current, signal) {
    const chain = await readChainNonce({ signal });
    if (!Number.isSafeInteger(chain) || chain < 0) throw refuse('invalid_nonce');
    if (Math.max(chain + 1, current.floor) !== attempt.nonce) throw refuse('approval_mismatch');
    const { postFork, networkFeeDem, rpcFeeDem } = await readDebitInputs(signal), planned = attempt.debitInputs;
    if (postFork !== planned.postFork || networkFeeDem !== planned.networkFeeDem || rpcFeeDem !== planned.rpcFeeDem) throw refuse('approval_mismatch');
  }
  const ownsSignAttempt = attempt => attempt.kind === 'sign' && liveAttempts.has(attempt);
  // Uses this adapter's current hold once, in the caller's pass; a refusal before the bytes are stored retires the attempt.
  async function signWithHold(request, hold, signal) {
    const attempt = takeApprovalHold(hold, ownsSignAttempt);
    if (attempt === null) throw refuse('approval_required', new Error('the approval held for this CREATE is gone, used, stopped, withdrawn or not this wallet\'s; nothing was read or signed'));
    let retire = true;
    const finalCheck = () => {
      if (hold.revision() === null) throw new EmbeddedWalletError('approval_required', 'the approval held for this CREATE is no longer current; nothing was signed');
    };
    try {
      return await inQueue(signal, async () => {
        if (request.inputDigest !== attempt.request.inputDigest) throw refuse('approval_mismatch');
        const current = await reservations.current(signer);
        if (current?.revision !== attempt.held.revision || current.active?.attemptId !== attempt.held.active.attemptId) {
          retire = false;
          throw refuse('approval_required', refuse('signer_reservation_stale'));
        }
        await assertAuthorizationOpen(attempt.binding, signal);
        await assertPlannedInputs(attempt, current, signal);
        signal.throwIfAborted();
        return await signPlanned(attempt, signal, finalCheck);
      });
    } catch (error) {
      await retireAttempt(attempt, error, { retire });
      throw error;
    } finally {
      endApprovalHold(hold);
      liveAttempts.delete(attempt);
    }
  }
  // Makes the kept bytes' authorization current before the pass: every step that asks nobody runs in the queue, and only a
  // replacement's `prepare` runs outside it, right after the checks run again. Signs and sends nothing.
  async function approveSend(retained, tx, signal) {
    const { held, open } = await inQueue(signal, async () => {
      const holding = await reservationHolding(retained);
      if (holding === null) throw refuse(RETAINED_INVALID);
      return { held: holding, open: await replayApproval(holding, signal, { ask: false }) };
    });
    let binding = open;
    if (binding === null) {
      assertReadyToAsk();
      binding = await askReplacement(held, signal);
    }
    signal.throwIfAborted();
    assertApprovalCovers(binding.requestText, tx.content);
    const attempt = { kind: 'send', txHash: retained.txHash, binding };
    liveAttempts.add(attempt);
    return { approval: createApprovalHold({ requestText: binding.requestText, attempt, stopped,
      revocationGeneration: () => approval.revocationGeneration(), settle: releaseAttempt }) };
  }
  // Uses this adapter's current send hold for these bytes once, in the caller's pass.
  async function broadcastWithHold(retained, hold, signal) {
    const attempt = takeApprovalHold(hold, candidate => candidate.kind === 'send' && liveAttempts.has(candidate) && candidate.txHash === retained?.txHash);
    if (attempt === null) throw refuse('approval_required', new Error('the approval held for this send is gone, used, stopped, withdrawn or not this wallet\'s; nothing was read or sent'));
    try { return await inQueue(signal, () => replay(retained, signal, { hold, attempt })); } finally {
      endApprovalHold(hold);
      liveAttempts.delete(attempt);
    }
  }

  return Object.freeze({
    async approveAhead(input, { signal = new AbortController().signal } = {}) {
      assertReadyToAsk();
      const request = checkedInput(input, signer);
      signal.throwIfAborted();
      return approveClaim(request, signal);
    },
    async signCreate(input, { signal = new AbortController().signal, approval: hold } = {}) {
      assertUnlocked();
      const request = checkedInput(input, signer);
      signal.throwIfAborted();
      if (hold !== undefined) return signWithHold(request, hold, signal);
      return inQueue(signal, async () => {
        const claim = await claimFor(request, signal);
        return claim.answer ?? signFresh(request, claim.reservation, claim.nonce, signal);
      });
    },
    async approveSendAhead(retained, { signal = new AbortController().signal } = {}) {
      assertReadyToAsk();
      signal.throwIfAborted();
      return approveSend(retained, parseRetained(retained), signal);
    },
    broadcast(retained, { signal = new AbortController().signal, approval: hold } = {}) {
      return hold === undefined ? inQueue(signal, () => replay(retained, signal)) : broadcastWithHold(retained, hold, signal);
    },
    async readAccountNonce({ signal = new AbortController().signal } = {}) {
      const nonce = storageWriteAccountNonce(await nodeRead('getAddressNonce', { address: signer }, signal));
      if (nonce === null) throw refuse('invalid_nonce');
      return nonce;
    },
    readTransactionState(retained, { signal = new AbortController().signal } = {}) { return transactionState(retained, signal); },
  });
}
