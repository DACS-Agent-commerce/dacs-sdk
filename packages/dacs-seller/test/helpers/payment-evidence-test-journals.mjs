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
 * The production chain over the world: a kit effect boundary over the world's binding (history in the world's directory), a
 * runCreate over the wallet's passes whose final stop awaits `stopped`, the payment-evidence pass over `adapter` (the wallet's
 * guarded adapter by default) and a journal over the pass that approves ahead. Resolves `{ journal, runCreate, effectBoundary }`.
 */
export function journalOverPass(world, { readTimeoutMs, adapter = world.wallet.paymentEvidenceAdapter, stopped = () => false, approvalSignal } = {}) {
  const effects = join(world.directory, 'effects');
  mkdirSync(effects, { recursive: true, mode: 0o700 });
  const effectBoundary = createEffectBoundary({ stopped: () => false, binding: world.admission.binding, currentLocal: world.admission.currentLocal,
    feeCeilingOs: finalization.feeCeilingOs, history: createEffectHistory({ dataDirectory: effects }), clock: MONOTONIC_CLOCK });
  const session = { effectPass: world.wallet.effectPass, runInEffectPass: world.wallet.runInEffectPass, acquireConnectionFence: () => world.owner.acquireConnectionFence() };
  const { runCreate } = createSellerCreatePass({ effectBoundary, session, stopped, feeCeilingOs: finalization.feeCeilingOs, clock: world.options.clock });
  const journal = createPaymentEvidenceWalletJournal({ path: join(world.directory, PAYMENT_EVIDENCE_JOURNAL), ...createPaymentEvidencePass({ runCreate, adapter }),
    approvalSignal, readTimeoutMs, now: () => world.options.clock.now() });
  world.journals?.push(journal);
  return { journal, runCreate, effectBoundary };
}

/**
 * A runCreate stop check that answers false, for journalOverPass's `stopped`. `holdNext()` holds its next call, the pass's final
 * stop await, and resolves `{ release }` once that call is held; `release()` lets it answer false.
 */
export function holdableStop() {
  let next = null;
  const stopped = async () => {
    const hold = next;
    next = null;
    if (hold) await hold();
    return false;
  };
  const holdNext = () => new Promise((reached) => { next = () => new Promise((release) => reached({ release })); });
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
