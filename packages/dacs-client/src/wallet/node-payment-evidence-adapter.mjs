// The seller composition's payment-evidence CREATE adapter. `signCreate` signs one storage CREATE on the signer reservation
// (`signer-reservation.mjs`) and sends nothing. `broadcast` confirms and dispatches the stored bytes, and `readTransactionState`
// reads the chain back for them; neither signs. The reservation keeps one live write per signer; the in-process queue only
// orders callers.
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
//
// `broadcast` acts on the signed bytes the reservation holds, once per call and with no retry:
//   authorization  the stored approval id is reopened. An id the ledger no longer holds open is replaced by the exact request's
//                  open authorization or a new one, and the reservation stores the replacement's id before anything is sent.
//   confirmation   `confirmTx` with the exact projection. An answer that is not a valid confirmation of those bytes is unknown and
//                  never advances; a valid refusal is `confirm_rejected`.
//   policy         `approval.confirm` runs on every replay against the held authorization; `false` or a throw sends nothing.
//   dispatch       one `broadcastTx`. Whatever goes wrong after it starts is `outcome_unknown`: the receiver may hold the bytes.
// `readTransactionState` answers `applied` only when the chain executed exactly these bytes and settles the reservation's
// authorization spent; every other outcome is `pending` with its cause kept. It never answers `absent`.
import { canonicalize, demosTransactionContentMatches, logicalToStorageProgramName, sha256Hex } from '@kynesyslabs/dacs';
import { OperationError } from '../client-errors.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../dacs/wallet-transactions.mjs';
import { classifyStorageWriteSubmission, rpcEnvelope, storageWriteAccountNonce, storageWriteConfirmationMatches, storageWriteIdentityMatches } from '../devnet-demo/storage-write-recovery.mjs';
import { AUTHORITY_READ_DEADLINE_MS } from '../public-admission.mjs';
import { EmbeddedWalletError } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { verifyDemosSignature } from '../signatures.mjs';
import { fetchBoundedJson, observeWithDeadline, settleOnAbort } from '../util/http.mjs';
import { nativeWalletLaneKey } from './devnet-native-transport.mjs';
import { hasKeys } from './payload-helpers.mjs';

const OPERATION = 'payment-evidence';
const UNCERTAIN = 'signer_reservation_uncertain';
const RETAINED_INVALID = 'retained_transaction_invalid';
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
 * stamp source; `recordCause(answer, error)` keeps the cause of a `pending` answer. Returns `{signCreate, broadcast,
 * readAccountNonce, readTransactionState}`. `signCreate(input, {signal})` resolves `{signedTransaction, txHash, nonce}`: the JSON
 * of exactly `{hash, content, signature}`, its hash and its account nonce. It must run inside the caller's effect pass and
 * sends nothing. It rejects `signer_input_invalid`, `signer_lane_busy`, `locked` (the session's wallet is locked),
 * `user_rejected` (a refused or failed approval, cause kept), `approval_mismatch`, `node_reply_invalid`, the gate's or the
 * signer's own error, an abort's reason, the reservation's own refusals, and `signer_reservation_uncertain` when the
 * reservation is kept (see above).
 * `broadcast({signedTransaction, txHash}, {signal})` must also run in an effect pass. It resolves `{status: 'accepted', txHash}`
 * after one dispatch of the held bytes and signs nothing. It rejects `retained_transaction_invalid` (the reservation does not
 * hold exactly these bytes; nothing was sent), `approval_required` (the authorization could not be reopened, renewed or confirmed
 * by current policy; nothing was sent), `confirm_rejected` (the node refused the confirmation), `outcome_unknown` (the
 * confirmation or the dispatch has no valid answer; the cause is kept), `locked`, or an abort's reason before the dispatch starts.
 * `readAccountNonce({signal})` resolves the account nonce, or rejects `node_reply_invalid` or `invalid_nonce`.
 * `readTransactionState({signedTransaction, txHash, nonce}, {signal})` resolves `{state: 'applied' | 'pending'}` and never rejects
 * for a failed read; a `pending` answer's cause is `internalCauseOf(answer)`. It starts no read after an abort.
 */
export function createPaymentEvidenceCreateAdapter({ reservations, approval, demos, observer, journal, pins, clock, rpcUrl, isWalletLocked, owner, fetchImpl, stamps, recordCause }) {
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
    return answer;
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
  // The exact request's open authorization, else a new one. A preparation that failed may have committed, so it is read back first.
  async function replacementApproval(requestText, signal) {
    const open = await settleOnAbort(approval.open(requestText), signal);
    if (open !== null) return open;
    try { return await prepareApproval(requestText, signal); }
    catch (cause) {
      const committed = await settleOnAbort(approval.open(requestText), signal);
      if (committed === null) throw cause;
      return committed;
    }
  }
  // Reopens the stored authorization by id. One the ledger no longer holds open is replaced, and the reservation stores the
  // replacement's id before anything is sent. A manual authorization has no id and is asked for again.
  async function replayApproval(held, signal) {
    const { approvalId, approvalIntent: requestText } = held.active;
    try {
      const reopened = approvalId === null ? null : await reopenApproval(approvalId, requestText, signal);
      if (reopened !== null) return reopened;
      const binding = await replacementApproval(requestText, signal);
      if (binding?.requestText !== requestText) throw refuse('approval_mismatch');
      if (binding.ledgerId !== null && binding.ledgerId !== approvalId) await reservations.renewApproval(held, binding);
      return binding;
    } catch (cause) { throw signal.aborted ? cause : refuse('approval_required', cause); }
  }
  // The approved request must describe these very bytes.
  function assertApprovalCovers(requestText, content) {
    const asked = JSON.parse(requestText).content;
    if (asked?.exactCreate !== JSON.stringify(content.data[1]) || asked.wallet !== signer || asked.nonce !== content.nonce || asked.timestamp !== content.timestamp) {
      throw refuse('approval_required', refuse('approval_mismatch'));
    }
  }

  async function post(body, headers, signal) {
    signal.throwIfAborted();
    const context = await owner.getContext();
    if (context.network !== pins.network || context.endpoint !== pins.endpoint || context.transportAuthority !== pins.transportAuthority) throw refuse('transport_mismatch');
    signal.throwIfAborted();
    return fetchBoundedJson(pins.endpoint, { method: 'POST', body, headers, fetchImpl, signal, timeoutMs: AUTHORITY_READ_DEADLINE_MS,
      maxBytes: NODE_REPLY_MAX_BYTES, expectedOrigin: new URL(pins.endpoint).origin });
  }
  // A confirmTx or broadcastTx body with fresh authentication headers from the wallet's stamp source; the effect gate runs in `fetchImpl`.
  async function execute(stage, data, signal) {
    signal.throwIfAborted();
    const identity = `ed25519:${signer}`, timestamp = String(stamps.next(identity));
    const { data: signature } = await settleOnAbort(demos.signMessage(sha256Hex(`${identity}:${timestamp}`), { algorithm: 'ed25519', raw: true }), signal);
    return post({ method: 'execute', params: [{ message: '', data, extra: stage }] }, { identity, timestamp, signature }, signal);
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
  async function replay(retained, signal) {
    assertUnlocked();
    signal.throwIfAborted();
    const tx = parseRetained(retained), held = await reservationHolding(retained);
    if (held === null) throw refuse(RETAINED_INVALID);
    const binding = await replayApproval(held, signal);
    assertApprovalCovers(binding.requestText, tx.content);
    const validity = await confirmRetained(tx, retained, signal);
    try {
      if (await settleOnAbort(approval.confirm(binding, validity), signal) !== true) throw new Error('the approval ledger did not confirm the write');
      if (!paymentEvidenceConfirmationMatches(validity, retained.signedTransaction)) throw new Error('the confirmation changed during the policy check');
    } catch (cause) { throw signal.aborted ? cause : refuse('approval_required', cause); }
    signal.throwIfAborted();
    try {
      const answer = await execute('broadcastTx', validity, signal);
      if (classifyStorageWriteSubmission(answer, retained.txHash) !== 'accepted') throw refuse('node_reply_invalid');
      return { status: 'accepted', txHash: retained.txHash };
    } catch (cause) { throw refuse('outcome_unknown', cause); }
  }

  // The executed form of the original: successful, in the status's block, with the same signature and complete content.
  function executedMatches(executed, tx, blockNumber) {
    return hasKeys(executed, ['hash', 'content', 'signature', 'status', 'blockNumber']) && executed.hash === tx.hash && executed.status === 'confirmed'
      && executed.blockNumber === blockNumber && sameJson(executed.signature, tx.signature) && isObject(executed.content) && demosTransactionContentMatches(tx.content, executed.content, tx.hash);
  }
  // An authenticated block of this chain that lists the hash; block one's previous hash is the chain identity.
  function blockListsHash(block, blockNumber, txHash) {
    const hashes = block?.content?.ordered_transactions;
    return (hasKeys(block, ['number', 'status', 'hash', 'content']) || storageWriteIdentityMatches(block)) && block.number === blockNumber && block.status === 'confirmed' && SHA256_HEX.test(block.hash)
      && hasKeys(block.content, ['previousHash', 'ordered_transactions']) && SHA256_HEX.test(block.content.previousHash) && (blockNumber !== 1 || block.content.previousHash === pins.chainIdentity)
      && Array.isArray(hashes) && hashes.length <= MAX_BLOCK_TRANSACTIONS && hashes.every(hash => SHA256_HEX.test(hash)) && hashes.includes(txHash);
  }
  async function verifyExecution(tx, signal) {
    await observer.observe({ signal });
    const status = await nodeRead('getTransactionStatus', { hash: tx.hash }, signal);
    if (!hasKeys(status, ['state', 'blockNumber']) || status.state !== 'included' || !Number.isSafeInteger(status.blockNumber) || status.blockNumber < 0) throw refuse('readback_unverified');
    const executed = await nodeRead('getTxByHash', { hash: tx.hash }, signal);
    if (!executedMatches(executed, tx, status.blockNumber)) throw refuse('readback_unverified');
    if (!blockListsHash(await nodeRead('getBlockByNumber', { blockNumber: status.blockNumber }, signal), status.blockNumber, tx.hash)) throw refuse('readback_unverified');
  }
  // `applied` after the chain proves the execution of exactly the retained bytes; the reservation holding them, if any, ends and its authorization is spent.
  async function transactionState(retained, signal) {
    try {
      signal.throwIfAborted();
      const tx = parseRetained(retained), held = await reservationHolding(retained);
      if (retained.nonce !== tx.content.nonce) throw refuse(RETAINED_INVALID);
      await verifyExecution(tx, signal);
      signal.throwIfAborted();
      if (held !== null) await reservations.consume(held, { status: 'executed', authenticated: true, txHash: tx.hash, projectionText: retained.signedTransaction });
      return { state: 'applied' };
    } catch (cause) {
      const answer = { state: 'pending' };
      recordCause(answer, cause);
      return answer;
    }
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
    broadcast(retained, { signal = new AbortController().signal } = {}) { return inQueue(signal, () => replay(retained, signal)); },
    async readAccountNonce({ signal = new AbortController().signal } = {}) {
      const nonce = storageWriteAccountNonce(await nodeRead('getAddressNonce', { address: signer }, signal));
      if (nonce === null) throw refuse('invalid_nonce');
      return nonce;
    },
    readTransactionState(retained, { signal = new AbortController().signal } = {}) { return transactionState(retained, signal); },
  });
}
