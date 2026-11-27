// The seller's Node wallet, built through the client's held Node composition (`@kynesyslabs/dacs-client/node-wallet`).
// The kit has no wallet of its own: the composition signs and sends through the client's effect gate, under the kit's
// operation guard and the client's purchase hold. This module adds the seller state directory's ownership proof, the
// recovery of lock rows a dead holder left in the client journals it opens, the custody claim check, the approval
// accounting of every wallet request, each request's own signing check, and the composition's payment-evidence adapter,
// with the kit operation guard checked at each of its effect calls.
import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createNodeSellerComposition, releaseAbandonedJournalLocks } from '@kynesyslabs/dacs-client/node-wallet';
import { openDurableWalletJournal } from '@kynesyslabs/dacs-client/wallet/durable-journal';
import { validateMnemonic } from '../cli/node-identity.mjs';
import { claimForAddress } from '../dacs/demos-claims.mjs';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';
import { OperationError } from '../operations.mjs';
import { sellerDiagnostic } from '../seller-diagnostics.mjs';
import { parseSellerKeyRecord, runtimeSupported, SellerKeyError } from '../seller-key.mjs';
import { boundedResolutionValue, isResolverDeadline, resolveWithDeadline } from '../util/bounded-resolution.mjs';
import { OPERATOR_CLOSING, SELLER_ISSUANCE_JOURNALS } from './operator-approval.mjs';
import { assertQualifiedDeployment } from './deployment-qualification.mjs';
import { SELLER_STATE_LOCK_FILE } from './seller-state-lock.mjs';

// The two client durable journals are the seller's issuance journals: the composition's own and the artifact anchor's.
const [COMPOSITION_JOURNAL, ARTIFACT_JOURNAL] = SELLER_ISSUANCE_JOURNALS;
const JOURNAL_MODES = ['create', 'open'];
const APPROVAL_MODES = ['policy', 'manual'];
// The balance read: one getAddressInfo answer, bounded before and after decoding, under one deadline.
const BALANCE_READ_LIMITS = Object.freeze({ maxBytes: 64 * 1024, timeoutMs: 10_000 });
const BALANCE_VALUE_LIMITS = Object.freeze({ ...BALANCE_READ_LIMITS, maxValues: 256, maxDepth: 8, maxListEntries: 64 });
const OS_AMOUNT = /^(?:0|[1-9][0-9]*)$/;
const SEND = 'sendTransaction';
// The client gate's two execute stages, which come after the signature (GATED_EXECUTE_STAGES in the client's
// node-wallet-session.mjs, not exported); every other gate phase is a signing phase.
const TRANSMISSION_STAGES = ['confirmTx', 'broadcastTx'];

const withCause = (error, cause) => (cause === undefined ? error : Object.assign(error, { cause }));

// The state lock must be the one for this data directory and still be held by this process.
function assertStateOwnership(dataDirectory, stateLock) {
  let held = false, cause;
  try {
    held = stateLock.path === join(realpathSync(dataDirectory), SELLER_STATE_LOCK_FILE) && stateLock.held() === true;
  } catch (error) { cause = error; }
  if (!held) throw withCause(new OperationError('state_ownership_required', 'the seller state lock for this data directory must be held'), cause);
}

// A mode outside its two values is refused, never read as the other one; the deployment evidence reader has no default.
function checkModes({ journalMode, approvalMode, readDeploymentEvidence }) {
  if (!JOURNAL_MODES.includes(journalMode)) throw new TypeError("journalMode must be 'create' or 'open'");
  if (!APPROVAL_MODES.includes(approvalMode)) throw new TypeError("approvalMode must be 'policy' or 'manual'");
  if (typeof readDeploymentEvidence !== 'function') throw new TypeError('readDeploymentEvidence must be a function');
}

// The record's mnemonic as a detached UTF-8 copy, which the client zero-fills.
function mnemonicCopy(keyRecord) {
  return new TextEncoder().encode(parseSellerKeyRecord(keyRecord, validateMnemonic).mnemonic);
}

// Runs every close in `opened`, newest first, and empties it; throws the first failure after trying them all.
async function closeAll(opened) {
  let failure;
  for (const close of opened.splice(0).reverse()) {
    try { await close(); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
}

// Opens a client durable journal in the data directory; a first start creates it, every later one opens it, so a lost journal is never made anew.
function openJournal(dataDirectory, name, journalMode, opened) {
  const journal = openDurableWalletJournal({ path: join(dataDirectory, name), mode: journalMode });
  opened.push(() => journal.close());
  return journal;
}

// The account balance in OS through the source's read-only RPC: a 64 KiB reply, a 10 s deadline, then value limits.
async function readBalanceOf(transport, address) {
  let reply;
  try {
    reply = boundedResolutionValue(await resolveWithDeadline(limits => transport.readRpc('/', { method: 'nodeCall', params: [{ message: 'getAddressInfo', data: { address } }] }, limits),
      BALANCE_READ_LIMITS), BALANCE_VALUE_LIMITS);
  } catch (cause) {
    throw withCause(new OperationError('seller_balance_unavailable', 'the balance read did not answer', isResolverDeadline(cause) ? 'timeout' : 'read-failed'), cause);
  }
  const balance = reply?.result === 200 ? reply.response?.balance : undefined;
  if (typeof balance !== 'string' || !OS_AMOUNT.test(balance)) throw new OperationError('seller_balance_invalid', 'the balance answer is not one canonical OS amount');
  return { address, balanceOs: balance };
}

// A diagnostics sink sees only the closed projection of an error's code; a failing sink changes nothing.
function reportDiagnostic(diagnostics, error) {
  try { diagnostics?.(sellerDiagnostic(error?.code)); } catch { /* the caller's own outcome is the one to report */ }
}

// The request's own check, when it has one: called with no arguments and never awaited, it must answer exactly true. Any
// other answer, a throw or a promise withdraws the write: the attempt keeps `when`, and the refusal is thrown.
function checkRequest(attempt, when) {
  const authorize = attempt?.authorize;
  if (authorize === undefined) return;
  let allowed, cause;
  try { allowed = authorize(); } catch (error) { cause = error; }
  if (allowed === true) return;
  try { if (typeof allowed?.then === 'function') allowed.then(undefined, () => {}); } catch { /* refused either way */ }
  attempt.withdrawn = when;
  throw withCause(new OperationError('not-authorized', `the write was withdrawn ${when}; nothing was signed`), cause);
}

// Accounts one wallet request in the approval ledger. `approve` records every request it accepts, then asks the request's own
// check. A broadcast-started record written to a journal (`issuing`) marks the request sent before the write runs, so a failed
// write still counts as sent. When the request ends, each recorded request is settled: released if nothing was sent; spent if
// the transport itself proved inclusion or the node refused the broadcast; otherwise unknown, which keeps the hold. A 200 reply
// alone proves nothing. A shutdown that ended the approval answers the request with OPERATOR_CLOSING, which the caller keeps
// askable. `signingCheck` asks the current request's check again at every gate phase before transmission.
function createApprovalAttempt(approve, diagnostics) {
  const scope = new AsyncLocalStorage();
  const outcomeOf = (attempt, result) => !attempt.sent ? 'released'
    : result?.data?.writeProof?.disposition === 'included' || result?.error?.code === 'broadcast_rejected' ? 'spent' : 'unknown';
  return {
    approve: async request => {
      let accepted;
      try { accepted = await approve(request); } catch (error) {
        if (error?.code === OPERATOR_CLOSING) { const attempt = scope.getStore(); if (attempt) attempt.closing = true; }
        throw error;
      }
      if (accepted && approve.settle) scope.getStore()?.requests.push(request);
      if (accepted === true) checkRequest(scope.getStore(), 'after its approval');
      return accepted;
    },
    signingCheck: ({ phase }) => { if (!TRANSMISSION_STAGES.includes(phase)) checkRequest(scope.getStore(), 'before it was signed'); },
    issuing(value) {
      if (value?.stage === 'broadcast-started') { const attempt = scope.getStore(); if (attempt) attempt.sent = true; }
    },
    run(work, authorize) {
      return scope.run({ sent: false, closing: false, requests: [], authorize, withdrawn: null }, async () => {
        const attempt = scope.getStore();
        let result;
        try {
          result = await work();
          if (attempt.closing && !attempt.sent && result?.success === false && result.error?.code === 'internal_error')
            return { success: false, data: null, error: { code: OPERATOR_CLOSING, message: 'the operator is closing: the approval was not decided and nothing was signed' } };
          if (attempt.withdrawn && !attempt.sent && result?.success === false && result.data == null)
            return { success: false, data: null, error: { code: 'not-authorized', message: `the write was withdrawn ${attempt.withdrawn}; nothing was signed or sent` } };
          return result;
        } finally {
          for (const request of attempt.requests) {
            try { await approve.settle(request, outcomeOf(attempt, result)); } catch (error) { reportDiagnostic(diagnostics, error); }
          }
        }
      });
    },
  };
}

// The journal with each broadcast-started record marked as sent in the request that writes it.
const issuingJournal = (journal, approvalAttempt) => ({ ...journal, put: (key, value) => { approvalAttempt.issuing(value); return journal.put(key, value); } });

// A request's second argument, when given, is exactly { authorize } (a function). Only a sendTransaction may carry it: only a
// transaction signature passes the effect gate, where the check runs right before the key signs. The guarded request is
// passed on as { method, params }, so the method the check was accepted for is the one the session runs.
function guardedRequest(wallet, approvalAttempt) {
  return async (input, options) => {
    if (options === undefined) return approvalAttempt.run(() => wallet.request(input));
    if (options === null || typeof options !== 'object' || Reflect.ownKeys(options).length !== 1 || !Object.hasOwn(options, 'authorize'))
      throw new TypeError('a wallet request takes at most { authorize }');
    const { authorize } = options;
    if (typeof authorize !== 'function') throw new TypeError('authorize must be a function');
    const { method, params } = input ?? {};
    if (method !== SEND) return { success: false, data: null, error: { code: 'not-authorized', message: 'only a sendTransaction can carry authorize; nothing was asked, signed or sent' } };
    return approvalAttempt.run(() => wallet.request({ method, params }), authorize);
  };
}

// The composition's walletFactory with every request run as an approval attempt, carrying its own signing check, and the
// selected journal marking issuance. Each view says it runs that check (guardsSigning).
function approvedWalletFactory(walletFactory, approvalAttempt) {
  return (options = {}) => {
    const selected = options.anchorJournal;
    if (selected !== undefined && typeof selected?.put !== 'function') throw new TypeError('the wallet factory needs an anchor journal');
    const wallet = walletFactory(selected === undefined ? options : { ...options, anchorJournal: issuingJournal(selected, approvalAttempt) });
    return Object.freeze({ ...wallet, guardsSigning: true, request: guardedRequest(wallet, approvalAttempt) });
  };
}

// Every pass made through this wallet carries the request's own signing check as its last synchronous check, on a copy of
// the caller's options. A list that is not an array is passed on unchanged, and the client refuses it.
const passWithRequestCheck = (effectPass, check) => options => {
  const copy = { ...options };
  if (Array.isArray(copy.synchronousChecks)) copy.synchronousChecks = [...copy.synchronousChecks, check];
  return effectPass(copy);
};

// The client's payment-evidence adapter with the kit operation guard checked at each effect call; its two reads are passive.
function kitGuardedAdapter(adapter) {
  return Object.freeze({ ...adapter,
    approveAhead: async (...args) => { assertKitOperationAdmitted('paymentEvidenceAdapter.approveAhead'); return adapter.approveAhead(...args); },
    signCreate: async (...args) => { assertKitOperationAdmitted('paymentEvidenceAdapter.signCreate'); return adapter.signCreate(...args); },
    approveSendAhead: async (...args) => { assertKitOperationAdmitted('paymentEvidenceAdapter.approveSendAhead'); return adapter.approveSendAhead(...args); },
    broadcast: async (...args) => { assertKitOperationAdmitted('paymentEvidenceAdapter.broadcast'); return adapter.broadcast(...args); } });
}

// The effect gate's first step in every pass: the serving node build qualifies on the composition's own observer and
// registered transport. A pass cannot start before the composition exists; a call before then refuses.
function qualificationStep({ admission, readDeploymentEvidence, clock = { now: () => Date.now() } }, compositionOf) {
  return async ({ phase, signal }) => {
    const composition = compositionOf();
    if (composition === undefined) throw new OperationError('deployment_unqualified', 'the seller composition is not built yet', 'node_build_unavailable');
    return assertQualifiedDeployment({ phase, signal, binding: admission.binding, currentLocal: admission.currentLocal, observer: composition.observer,
      source: composition.transport, readDeploymentEvidence, clock });
  };
}

async function composeWallet(options, opened) {
  const { admission, owner, dataDirectory, journalMode, stateLock, signer, keyRecord, approve, approvalMode, clock, publications, stopped, feeCeilingOs, diagnostics } = options;
  const stateOwnership = { directory: dataDirectory, held: () => stateLock.held() };
  const approvalAttempt = createApprovalAttempt(approve, diagnostics);
  const compositionJournal = openJournal(dataDirectory, COMPOSITION_JOURNAL, journalMode, opened);
  const artifactJournal = openJournal(dataDirectory, ARTIFACT_JOURNAL, journalMode, opened);
  await releaseAbandonedJournalLocks({ journal: artifactJournal, stateOwnership });
  let composition;
  const qualify = qualificationStep(options, () => composition);
  composition = await createNodeSellerComposition({ admission, owner, journal: issuingJournal(compositionJournal, approvalAttempt), key: mnemonicCopy(keyRecord),
    approve: approvalAttempt.approve, clock, stopped, feeCeilingOs, qualify,
    publications, approveConfirmedWrite: approvalMode === 'policy' ? approve.confirm : null, stateOwnership, paymentEvidenceApproval: approve.retained });
  opened.push(() => composition.close());
  const address = composition.wallet.getPublicAccount().address;
  if (claimForAddress(address) !== signer.claim) throw new SellerKeyError('seller_key_claim_mismatch');
  return Object.freeze({
    address,
    walletFactory: approvedWalletFactory(composition.walletFactory, approvalAttempt),
    sourceCapability: composition.transport,
    observer: composition.observer,
    effectPass: passWithRequestCheck(composition.effectPass, approvalAttempt.signingCheck),
    runInEffectPass: composition.runInEffectPass,
    artifactJournal,
    paymentEvidenceAdapter: kitGuardedAdapter(composition.paymentEvidenceAdapter),
    qualify,
    readBalance: () => readBalanceOf(composition.transport, address),
    close: () => closeAll(opened),
  });
}

/**
 * Builds the seller's Node wallet through the client's held Node composition. Checks, in order and before anything in
 * `dataDirectory` is opened: the kit operation guard, the Node floor, and `stateLock` (the `acquireSellerStateLock(dataDirectory)`
 * result, still held). It then opens the composition and artifact journals (`journalMode` 'create' on the first start, 'open'
 * after), removes the artifact journal's lock rows of dead holders with the same ownership proof (the composition does the same
 * for its journal), parses `keyRecord` (the `dacs-seller-key/v1` bytes) with the real BIP-39 check and hands the client a
 * detached copy of the mnemonic, then checks the session's claim against `signer.claim`. `approve` is the composed seller
 * approval: its `retained` member is the payment-evidence ledger, and its `confirm` is the confirmed-write policy in
 * `approvalMode` 'policy' (none in 'manual'). Every request of `walletFactory` runs as one approval attempt: the requests `approve`
 * accepts are settled in its ledger when the request ends, released if nothing was written to the transport journal or to the
 * journal selected for the factory as a broadcast-started record, spent if the transport proved inclusion or the node refused the
 * broadcast, and unknown (the hold stays) otherwise. `keyRecord` is zero-filled on every outcome. Each failure's code, and each
 * settlement failure's, goes to `diagnostics` only as `sellerDiagnostic(code)`, and whatever it opened is closed.
 * Each `walletFactory` view says `guardsSigning: true`. Its `request(input, { authorize })` asks `authorize()` (never awaited)
 * as the approval answer `true` returns, and again right before each transaction signature of that request; it is not asked
 * at confirmTx or broadcastTx. Any answer but exactly `true` resolves `not-authorized` with nothing signed or sent, and the
 * accepted request is settled released. Only a sendTransaction may carry `authorize` (any other method resolves `not-authorized`
 * before approval), and a second argument that is not exactly `{ authorize: function }` rejects TypeError before approval.
 * `readDeploymentEvidence({signal})` (required, no default) resolves the host's deployment evidence of the serving node build; the
 * composition's effect gate awaits `qualify` first in every pass, before each transaction signature and each confirmTx and broadcastTx,
 * which runs assertQualifiedDeployment over that reader, the composition's observer and its registered transport.
 * Resolves `{address, walletFactory, sourceCapability, observer, effectPass, runInEffectPass, artifactJournal, paymentEvidenceAdapter,
 * qualify({phase, signal}), readBalance(), close()}`; `effectPass` adds the current request's signing check last to every pass's `synchronousChecks`.
 * `paymentEvidenceAdapter` is the composition's payment-evidence adapter, whose four effect members check the kit operation guard
 * (kit_operation_guard_off) at each call. `qualify` is the gate's step, which the artifact anchor also runs as a preflight.
 * `readBalance` resolves `{address, balanceOs}`. `close()` closes what this opened; the host keeps `owner`.
 * Throws KitOperationGuardError (kit_operation_guard_off), OperationError (runtime_unsupported, state_ownership_required with its
 * cause), TypeError for a malformed option (`readDeploymentEvidence` before anything in `dataDirectory` opens; `walletFactory` also for
 * a selected `anchorJournal` without `put`), SellerKeyError (seller_key_format_invalid, seller_key_claim_mismatch), a journal's
 * refusal, or the composition's own error. `readBalance` rejects seller_balance_unavailable (cause kept) or seller_balance_invalid.
 */
export async function createSellerNodeWallet(options) {
  try {
    assertKitOperationAdmitted('createSellerNodeWallet');
    if (!runtimeSupported(process.version)) throw new OperationError('runtime_unsupported', `the seller's Node wallet needs Node ^22.22.2 || ^24.15.0; this is ${process.version}`);
    assertStateOwnership(options.dataDirectory, options.stateLock);
    checkModes(options);
    const opened = [];
    try {
      return await composeWallet(options, opened);
    } catch (error) {
      await closeAll(opened).catch(() => { /* the construction error is the one to report */ });
      throw error;
    }
  } catch (error) {
    reportDiagnostic(options.diagnostics, error);
    throw error;
  } finally {
    if (options?.keyRecord instanceof Uint8Array) options.keyRecord.fill(0);
  }
}
