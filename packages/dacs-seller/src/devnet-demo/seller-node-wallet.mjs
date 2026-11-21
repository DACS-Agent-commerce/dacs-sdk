// The seller's Node wallet, built through the client's held Node composition (`@kynesyslabs/dacs-client/node-wallet`).
// The kit has no wallet of its own: the composition signs and sends through the client's effect gate, under the kit's
// operation guard and the client's purchase hold. This module adds the seller state directory's ownership proof, the
// recovery of lock rows a dead holder left in the client journals it opens, the custody claim check, and the
// payment-evidence journal over the composition's adapter.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createNodeSellerComposition, releaseAbandonedJournalLocks } from '@kynesyslabs/dacs-client/node-wallet';
import { openDurableWalletJournal } from '@kynesyslabs/dacs-client/wallet/durable-journal';
import { validateMnemonic } from '../cli/node-identity.mjs';
import { claimForAddress } from '../dacs/demos-claims.mjs';
import { createPaymentEvidenceWalletJournal } from '../dacs/payment-evidence-wallet-journal.mjs';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';
import { OperationError } from '../operations.mjs';
import { sellerDiagnostic } from '../seller-diagnostics.mjs';
import { parseSellerKeyRecord, runtimeSupported, SellerKeyError } from '../seller-key.mjs';
import { boundedResolutionValue, isResolverDeadline, resolveWithDeadline } from '../util/bounded-resolution.mjs';
import { SELLER_ISSUANCE_JOURNALS } from './operator-approval.mjs';
import { SELLER_STATE_LOCK_FILE } from './seller-state-lock.mjs';

// The two client durable journals are the seller's issuance journals: the composition's own and the artifact anchor's.
const [COMPOSITION_JOURNAL, ARTIFACT_JOURNAL] = SELLER_ISSUANCE_JOURNALS;
const PAYMENT_EVIDENCE_JOURNAL = 'seller-payment-evidence.sqlite';
const JOURNAL_MODES = ['create', 'open'];
const APPROVAL_MODES = ['policy', 'manual'];
// The balance read: one getAddressInfo answer, bounded before and after decoding, under one deadline.
const BALANCE_READ_LIMITS = Object.freeze({ maxBytes: 64 * 1024, timeoutMs: 10_000 });
const BALANCE_VALUE_LIMITS = Object.freeze({ ...BALANCE_READ_LIMITS, maxValues: 256, maxDepth: 8, maxListEntries: 64 });
const OS_AMOUNT = /^(?:0|[1-9][0-9]*)$/;

const withCause = (error, cause) => (cause === undefined ? error : Object.assign(error, { cause }));

// The state lock must be the one for this data directory and still be held by this process.
function assertStateOwnership(dataDirectory, stateLock) {
  let held = false, cause;
  try {
    held = stateLock.path === join(realpathSync(dataDirectory), SELLER_STATE_LOCK_FILE) && stateLock.held() === true;
  } catch (error) { cause = error; }
  if (!held) throw withCause(new OperationError('state_ownership_required', 'the seller state lock for this data directory must be held'), cause);
}

// A mode outside its two values is refused, never read as the other one.
function checkModes({ journalMode, approvalMode }) {
  if (!JOURNAL_MODES.includes(journalMode)) throw new TypeError("journalMode must be 'create' or 'open'");
  if (!APPROVAL_MODES.includes(approvalMode)) throw new TypeError("approvalMode must be 'policy' or 'manual'");
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

async function composeWallet(options, opened) {
  const { admission, owner, dataDirectory, journalMode, stateLock, signer, keyRecord, approve, approvalMode, clock, publications, stopped, feeCeilingOs } = options;
  const stateOwnership = { directory: dataDirectory, held: () => stateLock.held() };
  const compositionJournal = openJournal(dataDirectory, COMPOSITION_JOURNAL, journalMode, opened);
  const artifactJournal = openJournal(dataDirectory, ARTIFACT_JOURNAL, journalMode, opened);
  await releaseAbandonedJournalLocks({ journal: artifactJournal, stateOwnership });
  const composition = await createNodeSellerComposition({ admission, owner, journal: compositionJournal, key: mnemonicCopy(keyRecord), approve, clock, stopped, feeCeilingOs,
    publications, approveConfirmedWrite: approvalMode === 'policy' ? approve.confirm : null, stateOwnership, paymentEvidenceApproval: approve.retained });
  opened.push(() => composition.close());
  const address = composition.wallet.getPublicAccount().address;
  if (claimForAddress(address) !== signer.claim) throw new SellerKeyError('seller_key_claim_mismatch');
  const paymentEvidence = createPaymentEvidenceWalletJournal({ path: join(dataDirectory, PAYMENT_EVIDENCE_JOURNAL),
    ...composition.paymentEvidenceAdapter, now: () => clock.now() });
  opened.push(() => paymentEvidence.close());
  return Object.freeze({
    address,
    walletFactory: composition.walletFactory,
    sourceCapability: composition.transport,
    observer: composition.observer,
    effectPass: composition.effectPass,
    runInEffectPass: composition.runInEffectPass,
    artifactJournal,
    paymentEvidence,
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
 * `approvalMode` 'policy' (none in 'manual'). `keyRecord` is zero-filled on every outcome. Each failure's code goes to
 * `diagnostics` only as `sellerDiagnostic(code)`, and whatever it opened is closed.
 * Resolves `{address, walletFactory, sourceCapability, observer, effectPass, runInEffectPass, artifactJournal, paymentEvidence,
 * readBalance(), close()}`; `readBalance` resolves `{address, balanceOs}`. `close()` closes what this opened; the host keeps `owner`.
 * Throws KitOperationGuardError (kit_operation_guard_off), OperationError (runtime_unsupported, state_ownership_required with its
 * cause), TypeError for a malformed option, SellerKeyError (seller_key_format_invalid, seller_key_claim_mismatch), a journal's
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
    try { options.diagnostics?.(sellerDiagnostic(error?.code)); } catch { /* a failing sink never replaces the construction error */ }
    throw error;
  } finally {
    if (options?.keyRecord instanceof Uint8Array) options.keyRecord.fill(0);
  }
}
