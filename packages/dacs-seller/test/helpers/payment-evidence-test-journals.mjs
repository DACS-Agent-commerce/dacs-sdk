// Unshipped test helper: the seller's payment-evidence journal over a seller Node wallet world (seller-node-wallet-world.mjs),
// either over the wallet's adapter's one-call members inside the caller's own test pass, or over the real chain the
// production session builds: a kit effect boundary, its runCreate over the wallet's passes and the payment-evidence pass.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { finalization, T0 } from './seller-node-wallet-world.mjs';

const { createPaymentEvidenceWalletJournal } = await import('../../src/dacs/payment-evidence-wallet-journal.mjs');
const { createPaymentEvidencePass } = await import('../../src/dacs/payment-evidence-pass.mjs');
const { createEffectBoundary } = await import('../../src/dacs/effect-boundary.mjs');
const { createEffectHistory } = await import('../../src/dacs/effect-history.mjs');
const { createSellerCreatePass } = await import('../../src/devnet-demo/create-pass.mjs');
const { composeSellerApproval, createExactOperatorApproval } = await import('../../src/devnet-demo/operator-approval.mjs');
const { MONOTONIC_CLOCK } = await import('./agent-signing.mjs');

/** The journal file name the production session uses in its data directory. */
export const PAYMENT_EVIDENCE_JOURNAL = 'seller-payment-evidence.sqlite';
const ONE_CALL_MEMBERS = ['signCreate', 'broadcast', 'readAccountNonce', 'readTransactionState'];
// Above every write's debit; the manual answers never read it.
const MANUAL_MAX_TOTAL_OS = '1000000000000';
const byWallet = new WeakMap();

/**
 * The journal over the world's `wallet.paymentEvidenceAdapter` one-call members (no approve members, so every call asks inside
 * the adapter), at `path` (the world's journal file by default): one journal per wallet and path, closed with the world.
 */
export function journalOverAdapter(world, { path = join(world.directory, PAYMENT_EVIDENCE_JOURNAL) } = {}) {
  const journals = byWallet.get(world.wallet) ?? new Map();
  byWallet.set(world.wallet, journals);
  if (!journals.has(path)) {
    const adapter = world.wallet.paymentEvidenceAdapter;
    const journal = createPaymentEvidenceWalletJournal({ path, ...Object.fromEntries(ONE_CALL_MEMBERS.map((name) => [name, adapter[name]])), now: () => world.options.clock.now() });
    journals.set(path, journal);
    world.journals?.push(journal);
  }
  return journals.get(path);
}

/**
 * The production chain over the world: a kit effect boundary over `binding` (the world's by default; history in the world's
 * directory), a runCreate over the wallet's passes whose final stop awaits `stopped`, the payment-evidence pass over `adapter` (the
 * wallet's guarded adapter by default) and a journal over the pass that approves ahead. Returns `{ journal, pass, runCreate, effectBoundary }`.
 */
export function journalOverPass(world, { readTimeoutMs, adapter = world.wallet.paymentEvidenceAdapter, stopped = () => false, approvalSignal, binding = world.admission.binding } = {}) {
  const effects = join(world.directory, 'effects');
  mkdirSync(effects, { recursive: true, mode: 0o700 });
  const effectBoundary = createEffectBoundary({ stopped: () => false, binding, currentLocal: world.admission.currentLocal,
    feeCeilingOs: finalization.feeCeilingOs, history: createEffectHistory({ dataDirectory: effects }), clock: MONOTONIC_CLOCK });
  const session = { effectPass: world.wallet.effectPass, runInEffectPass: world.wallet.runInEffectPass, acquireConnectionFence: () => world.owner.acquireConnectionFence() };
  const { runCreate } = createSellerCreatePass({ effectBoundary, session, stopped, feeCeilingOs: finalization.feeCeilingOs, clock: world.options.clock });
  const pass = createPaymentEvidencePass({ runCreate, adapter });
  const journal = createPaymentEvidenceWalletJournal({ path: join(world.directory, PAYMENT_EVIDENCE_JOURNAL), ...pass, approvalSignal, readTimeoutMs, now: () => world.options.clock.now() });
  world.journals?.push(journal);
  return { journal, pass, runCreate, effectBoundary };
}

// The block height both stand-in reads below name: the nonce snapshot's and the absence index's, so every answer is fenced.
const CHECKED_BLOCK = 1;
/**
 * A journal that approves ahead over the stand-in wallet chain `wallet` (payment-evidence-wallet-chain.mjs), at `path`: each ask
 * answers a hold, each send records its hash in `wallet.chain.sent` (after `onSend(txHash)`), and the reads answer the chain
 * with a nonce snapshot and a complete absence index through the same block. Unlike the client adapter, these reads can prove
 * that a kept CREATE whose nonce another write took will never execute, so the journal supersedes it.
 */
export function approvingChainJournal(path, wallet, { onSend = () => {} } = {}) {
  const ask = async () => ({ approval: { revision: () => 'TEST-hold', release: async () => ({ released: true }) } });
  return createPaymentEvidenceWalletJournal({ path, approveAhead: ask, approveSendAhead: ask, signCreate: (input) => wallet.signCreate(input),
    broadcast: async ({ txHash }) => {
      onSend(txHash);
      wallet.chain.sent = [...(wallet.chain.sent ?? []), txHash];
      wallet.save();
      return { status: 'accepted', txHash };
    },
    readAccountNonce: async () => ({ nonce: wallet.accountNonce(), blockHeight: CHECKED_BLOCK }),
    readTransactionState: async ({ txHash }) => ({ state: wallet.transactionState(txHash), checkedThroughBlock: CHECKED_BLOCK }) });
}

/**
 * A runCreate stop check that answers false, for journalOverPass's `stopped`. `holdNext(skip = 0)` lets `skip` calls pass, holds
 * the next one (a pass's final stop await) and resolves `{ release }` once that call is held; `release()` lets it answer false.
 */
export function holdableStop() {
  let next = null, skip = 0;
  const stopped = async () => {
    if (next !== null && skip > 0) skip--;
    else if (next !== null) {
      const hold = next;
      next = null;
      await hold();
    }
    return false;
  };
  const holdNext = (calls = 0) => new Promise((reached) => { skip = calls; next = () => new Promise((release) => reached({ release })); });
  return { stopped, holdNext };
}

/** The `code` of `error` and of every `cause` under it, outermost first. */
export function causeCodes(error) {
  const codes = [];
  for (let link = error; link instanceof Error && codes.length < 16; link = link.cause) codes.push(link.code);
  return codes;
}

/**
 * An operator double that holds every request until the test answers it: `asked` lists `{ request, answer(yes) }` in order, and
 * `nextAsk()` resolves at the next request.
 */
export function heldOperator() {
  const asked = [], waiting = [];
  const operator = (request) => new Promise((answer) => {
    asked.push({ request, answer });
    for (const notify of waiting.splice(0)) notify();
  });
  return { operator, asked, nextAsk: () => new Promise((notify) => { waiting.push(notify); }) };
}

/** The kit's own manual-mode approval: every request goes to `operator(request)`; its ledger file is in `directory`. */
export function manualSellerApproval({ directory, operator, now = () => T0, t }) {
  const policy = createExactOperatorApproval({ maxTotalOs: MANUAL_MAX_TOTAL_OS, evidencePath: join(directory, 'TEST-manual-approval.jsonl'), sellerApproval: { mode: 'manual' }, now });
  t.after(() => policy.stop());
  return composeSellerApproval({ mode: 'manual', policy, manual: operator });
}
