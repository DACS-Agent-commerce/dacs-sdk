// Cancel of a handed-off non-native payment, through the real purchase service and SQLite stores over ONE fake node RPC. The slot
// read, the transfer observation (through createDemosChainReader) and the nonce read are the package's own code. Every scenario runs
// in both node projections, with the gate (config.nonceSlotProof) off and on, and for each key that may sign the buyer's transactions:
//   wallet  the wallet's own key signs everything
//   alt     from = ALT_KEY, from_ed25519_address = WALLET (another key signs for the wallet)
//   mixed   transfers to the payee are signed by ALT_KEY, the self-transfer release by the wallet's key
// nonceOwner is which nonce the node counts for an alternate-signed transaction: the account's, or its signing key's.
import { describe, test, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The purchase actions are held at this ref; the scenarios run with the hold lifted.
vi.mock('../../packages/dacs-client/src/dacs/action-admission.mjs', async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, assertPurchaseActionsAdmitted: () => {} };
});
// @ts-ignore
import { openDatabase, transaction, isUniqueViolation } from '../../packages/dacs-client/test/helpers/purchase-integrity-database.mjs';
// @ts-ignore
import { createOperationStore } from '../../packages/dacs-client/test/helpers/purchase-integrity-operations.mjs';
// @ts-ignore
import { createPurchaseService } from '../../packages/dacs-client/src/purchases.mjs';
// @ts-ignore
import { createCoordinateStore } from '../../packages/dacs-client/src/dacs/wallet-transactions.mjs';
// @ts-ignore
import { createDemosChainReader } from '../../packages/dacs-client/src/dacs/chain.mjs';

type Gate = 'off' | 'account';
type View = 'int' | 'node2';
type Variant = { signer: 'wallet' | 'alt' | 'mixed'; nonceOwner: 'account' | 'signer' };
type Opts = { historyDown?: boolean; noSeam?: boolean; lag?: number; cap?: number; oldestFirst?: boolean; base?: number;
  failPayment?: 'consumes' | 'free' | null; amountDem?: boolean; bodyNonceOff?: boolean; bodyStatus?: 'failed' | 'pending'; bodyHash?: string; bodyPayer?: string; bodyDown?: boolean; badHash?: boolean; farGap?: number; tsOf?: (a: any, i: number) => number | undefined;
  // The purchase declares a seller transport; this is the seller request the protocol makes once a payment settles it.
  sellerRecheck?: (operation: any, coords: any) => Promise<any> };
// Node payloads, history rows and operation records are untyped JSON here.
type Row = { name: string; transfers: number; rejected: number; doublePay: boolean; paidCancelled: boolean; doublePayMismatch: boolean; extra: any };
type World = ReturnType<typeof world>;
type Scenario = (world: (o?: Opts) => World) => Promise<Row[]>;

const CHAIN = 'f'.repeat(64), WALLET = '0x' + 'a'.repeat(64), PAYEE = '0x' + '7'.repeat(64), OTHER = '0x' + '5'.repeat(64), AMOUNT = '2500000000';
const ALT_KEY = '0x' + 'c'.repeat(64);
const SELLER_PROTOCOL = { jobId: 'TEST-job', transportBinding: { source: 'TEST-seller-transport' } };
const store = { transaction, isUniqueViolation }, purposes = { APPROVE_PURCHASE: 'approve-purchase' };
const ok = (response: any) => new Response(JSON.stringify({ result: 200, response }), { headers: { 'content-type': 'application/json' } });

function world(view: View, variant: Variant, gate: Gate, o: Opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nonce-slot-'));
  const db = openDatabase(join(dir, 'state.sqlite'));
  const base = o.base ?? 6;
  const hex = (n: number) => 'd'.repeat(60) + String(n).padStart(4, '0');
  const chain: any = { nonce: base, altNonce: base, pending: [] as any[], rejected: 0, reads: {} as Record<string, number>, failedOnce: o.failPayment === 'free',
    applied: Array.from({ length: base }, (_, i) => ({ hash: hex(i + 1), nonce: i + 1, from: WALLET, signer: WALLET, to: OTHER, amount: '1', type: 'native' })) as any[] };
  const hashOf = (p: any) => createHash('sha256').update(JSON.stringify(p)).digest('hex');
  const broadcast = (payload: any) => { chain.pending.push(payload); };
  const signerOf = (c: any) => (c.from !== WALLET || variant.signer === 'wallet') ? c.from : variant.signer === 'alt' ? ALT_KEY : (c.to === WALLET ? WALLET : ALT_KEY);
  const mine = () => {
    for (const p of chain.pending.splice(0)) {
      const c = p.content, signer = signerOf(c), alt = variant.nonceOwner === 'signer' && signer === ALT_KEY, at = alt ? chain.altNonce : chain.nonce;
      if (c.nonce <= at) { chain.rejected++; continue; }
      // farGap: a nonce that far above the account's ends failed and leaves its nonce where it was (measured live).
      const far = o.farGap !== undefined && c.nonce > at + o.farGap;
      const fails = far || (o.failPayment && c.to === PAYEE && (o.failPayment === 'consumes' || chain.failedOnce));
      if (fails && !far && o.failPayment === 'free') chain.failedOnce = false;
      if (!far && (!fails || o.failPayment === 'consumes')) { if (alt) chain.altNonce = c.nonce; else chain.nonce = c.nonce; }
      chain.applied.push({ hash: hashOf(p), nonce: c.nonce, from: c.from, signer, to: c.to, amount: String(c.amount), type: c.type, failed: Boolean(fails) });
    }
  };
  const external = (nonce = chain.nonce + 1, type = 'native') => { chain.nonce = nonce; chain.applied.push({ hash: 'e'.repeat(60) + String(nonce).padStart(4, '0'), nonce, from: WALLET, signer: WALLET, to: OTHER, amount: '5', type }); };
  // Rows that only pay the wallet carry the sender's nonce; a failed row with a far nonce leaves the account's nonce where it was.
  const inbound = (...nonces: number[]) => nonces.forEach((n) => chain.applied.push({ hash: 'b'.repeat(56) + String(n).padStart(4, '0') + String(chain.applied.length).padStart(4, '0'), nonce: n, from: OTHER, signer: OTHER, to: WALLET, amount: '3', type: 'native' }));
  const farFail = (n: number) => chain.applied.push({ hash: 'f'.repeat(56) + String(n).padStart(4, '0') + String(chain.applied.length).padStart(4, '0'), nonce: n, from: WALLET, signer: WALLET, to: OTHER, amount: '1', type: 'native', failed: true });
  const byHash = (hash: string) => chain.applied.find((a: any) => a.hash === hash);
  const amountOf = (a: any) => o.amountDem ? String(Number(a.amount) / 1e9) : view === 'node2' ? Number(a.amount) : a.amount;
  // A row's signed timestamp: the node orders the history by it, not by nonce.
  const stamp = (a: any) => { const i = chain.applied.indexOf(a); return 1761900000000 + (o.tsOf?.(a, i) ?? i) * 1000; };
  const project = (a: any) => ({ type: a.type, from: a.signer, from_ed25519_address: a.from, to: a.to, amount: amountOf(a), nonce: view === 'node2' ? String(a.nonce) : a.nonce,
    data: a.type === 'native' ? ['native', { nativeOperation: 'send', args: [a.to, String(a.amount)] }] : ['storageProgram', {}], timestamp: view === 'node2' ? String(stamp(a)) : stamp(a) });
  // The live history query lists a row whose signer or `to` is the address (measured live).
  const listed = (a: any) => a.signer === a.from || a.to === WALLET;
  const rpc = async (_input: any, init: any) => {
    const { message, data } = JSON.parse(init.body).params[0];
    if (message === 'getTransactionHistory') {
      if (o.historyDown) throw new Error('history unavailable');
      const newest = chain.applied.filter(listed).sort((x: any, y: any) => stamp(y) - stamp(x)).slice(o.lag ?? 0);
      const ordered = o.oldestFirst ? newest.slice().reverse() : newest;
      return ok(ordered.slice(data.start, data.start + Math.min(data.limit, o.cap ?? data.limit))
        .map((a: any) => ({ hash: o.badHash && a === chain.applied.at(-1) ? 'not-a-hash' : a.hash, blockNumber: 10, status: a.failed ? 'failed' : 'confirmed', content: project(a) })));
    }
    if (message === 'getAddressNonce') return ok(chain.nonce);
    if (message === 'getTransactionStatus') { const a = byHash(data.hash); return ok(a ? { state: a.failed ? 'failed' : 'included', blockNumber: 10 } : { state: 'not-found' }); }
    if (message === 'getTxByHash') {
      const a = byHash(data.hash); if (!a) return ok(null);
      const content = project(a); if (o.bodyNonceOff) content.nonce = view === 'node2' ? String(a.nonce + 1) : a.nonce + 1;
      // bodyStatus: the observation reads the transaction confirmed; every later read of its body (cancel's own) shows another status.
      const reads = (chain.reads[a.hash] = (chain.reads[a.hash] ?? 0) + 1);
      // bodyPayer and bodyDown: every later read answers another payer, or fails. bodyHash: only cancel's first read of the body answers
      // another transaction's hash, so a repeated cancel reads the agreeing body.
      if (o.bodyDown && reads > 1) throw new Error('body unavailable');
      if (o.bodyPayer && reads > 1) { content.from = o.bodyPayer; content.from_ed25519_address = o.bodyPayer; }
      return ok({ hash: o.bodyHash && reads === 2 ? o.bodyHash : a.hash, status: a.failed ? 'failed' : o.bodyStatus && reads > 1 ? o.bodyStatus : 'confirmed', blockNumber: 10, content });
    }
    if (message === 'getBlockByNumber') return ok({ number: 10, status: 'confirmed', content: { ordered_transactions: chain.applied.map((a: any) => a.hash), timestamp: 1761900000 } });
    throw new Error(`unexpected ${message}`);
  };
  const reader = createDemosChainReader({ rpcUrl: 'https://rpc.invalid', network: 'test', fetchImpl: rpc });
  const chainApi: any = { ...reader, network: 'testnet', pinnedIdentity: CHAIN, rpcOrigin: 'https://rpc.invalid', evidenceMode: 'TEST-stub',
    networkIdentity: async () => ({ identity: CHAIN, mode: 'public-chain-read' }) };
  if (o.noSeam) delete chainApi.findTransferAtNonce;
  const verifier = { verify: async () => ({ transactable: true, contentHash: CHAIN, price: { amountOs: AMOUNT }, payee: PAYEE, checks: [], evidence: { chainMode: 'public-chain-read' } }) };
  const ops = createOperationStore({ db, handoffSecret: 'TEST-'.repeat(8) });
  const coordinates = createCoordinateStore({ db });
  const protocol = o.sellerRecheck ? { available: true, assertBuyerAccess() {}, recheckCommitment: async () => {}, recheck: o.sellerRecheck } : null;
  const purchases = createPurchaseService({ db, ops, coordinates, config: { demAmountEncoding: 'os-string', nonceSlotProof: gate }, chain: chainApi, verifier, protocol, store, purposes });
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer', 'TEST', 'TEST-buyer', new Date().toISOString());
  const terms = { buyer: { wallet: WALLET }, seller: { payee: PAYEE, claim: 'TEST-seller' }, price: { amountOs: AMOUNT, amount: '2.5' },
    listing: { listingId: 'TEST-listing', version: 1, contentHash: CHAIN }, network: 'testnet', rail: 'demos-native:DEM',
    domain: { network: 'testnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: CHAIN }, ...(o.sellerRecheck ? { protocol: SELLER_PROTOCOL } : {}) };
  const buy = (key: string) => ops.createIdempotent({ accountId: 'TEST-buyer', kind: 'purchase', idempotencyKey: key, request: { k: key }, status: 'approved',
    terms, termsHash: CHAIN, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }).operation;
  const handoff = (op: any) => purchases.prepareHandoff({ operationId: op.id, token: ops.handoffTokenFor(op.id) });
  const cancel = (op: any) => purchases.cancel({ accountId: 'TEST-buyer', operationId: op.id });
  const verifyHash = (op: any, txHash: string) => purchases.verifyDeal({ accountId: 'TEST-buyer', operationId: op.id, txHash });
  const verifyReportedHash = (op: any) => purchases.verifyDeal({ accountId: 'TEST-buyer', operationId: op.id });
  const verify = (op: any, payload: any) => verifyHash(op, hashOf(payload));
  const status = (op: any) => ops.get('TEST-buyer', op.id)?.status;
  const toPayee = () => chain.applied.filter((a: any) => a.to === PAYEE && !a.failed).length;
  const landed = (p: any) => Boolean(p) && chain.applied.some((a: any) => a.hash === hashOf(p) && !a.failed);
  return { chain, coordinates, broadcast, mine, external, inbound, farFail, buy, handoff, cancel, verify, verifyHash, verifyReportedHash, status, toPayee, landed, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const attempt = async (fn: () => Promise<any>) => { try { return await fn(); } catch (e: any) { return { threw: e?.code ?? String(e.message) }; } };
const outcome = (r: any) => r.threw ?? (r.payload ? 'payload' : (r.refused ?? 'none'));
const cancelled = (c: any) => c.cancelled ?? c.threw;
const verdict = (v: any) => v.threw ?? v.verification?.outcome;
// `doublePay`: both payloads landed although the first purchase ended cancelled; `paidCancelled`: the first landed and it ended cancelled;
// `doublePayMismatch`: both landed although the first purchase ended payment_mismatch.
const row = (name: string, w: World, extra: any, p: { p1?: any; p2?: any } = {}): Row => {
  const l1 = w.landed(p.p1), l2 = w.landed(p.p2);
  const made = { name, transfers: w.toPayee(), rejected: w.chain.rejected, doublePay: l1 && l2 && extra.op1 === 'cancelled', paidCancelled: l1 && extra.op1 === 'cancelled',
    doublePayMismatch: l1 && l2 && extra.op1 === 'payment_mismatch', extra };
  w.close();
  return made;
};
// The buyer's first purchase is handed off and its payment lands; then cancel and a second purchase.
const paid = async (world: (o?: Opts) => World, o: Opts, after: (w: World) => void = () => {}, before: (w: World) => void = () => {}) => {
  const w = world(o); before(w); const op1 = w.buy('one'); const r = await w.handoff(op1); w.broadcast(r.payload); w.mine(); after(w);
  const c = await attempt(() => w.cancel(op1)); const op2 = w.buy('two'); const r2 = await attempt(() => w.handoff(op2));
  if (r2.payload) { w.broadcast(r2.payload); w.mine(); }
  return { w, op1, c, r, r2 };
};
const paidRow = async (name: string, world: (o?: Opts) => World, o: Opts, after?: (w: World) => void, before?: (w: World) => void) => {
  const { w, op1, c, r, r2 } = await paid(world, o, after, before);
  return row(name, w, { cancel: cancelled(c), op1: w.status(op1), rebuy: outcome(r2) }, { p1: r.payload, p2: r2.payload });
};
// The buyer declines: cancel, then the release lands.
const decline = async (w: World, op: any) => { const c = await attempt(() => w.cancel(op)); if (c.release) { w.broadcast(c.release); w.mine(); } return c; };
const buyAgain = async (w: World) => { const r = await attempt(() => w.handoff(w.buy('two'))); if (r.payload) { w.broadcast(r.payload); w.mine(); } return r; };
// Cancel, then another own-key transaction takes the slot, then cancel again and buy again.
const slotTaken = async (name: string, w: World, take: () => void, o: { pending?: boolean } = {}) => {
  const op1 = w.buy('one'); const r = await w.handoff(op1); if (o.pending) w.broadcast(r.payload);
  const c = await attempt(() => w.cancel(op1)); take(); const c2 = await attempt(() => w.cancel(op1)); const st = w.status(op1); w.mine(); const r2 = await buyAgain(w);
  return row(name, w, { cancel: cancelled(c), resolve: cancelled(c2), op1AtResolve: st, op1: w.status(op1), rebuy: outcome(r2) }, { p1: r.payload, p2: r2.payload });
};
// A purchase whose slot is taken, read for an answer that must stay open.
const openAfterSlotTaken = async (name: string, w: World, take: () => void) => {
  const op1 = w.buy('one'); await w.handoff(op1); await attempt(() => w.cancel(op1)); take();
  const c2 = await attempt(() => w.cancel(op1));
  return row(name, w, { resolve: cancelled(c2), op1: w.status(op1) });
};

const SCENARIOS: Array<[string, Scenario]> = [
  ['cancel while the transfer is pending leaves it open, and the landed transfer is never paid twice', async (world) => {
    // X2: the transfer lands after the first cancel; the re-buy is refused until cancel settles the purchase.
    const landing = world(); const first = landing.buy('one'); const sent = await landing.handoff(first); landing.broadcast(sent.payload);
    const firstCancel = await attempt(() => landing.cancel(first)); landing.mine();
    const rebuy = await attempt(() => landing.handoff(landing.buy('two')));
    if (rebuy.payload) { landing.broadcast(rebuy.payload); landing.mine(); }
    const secondCancel = await attempt(() => landing.cancel(first)); const rebuyAfterResolve = await attempt(() => landing.handoff(landing.buy('three')));
    if (rebuyAfterResolve.payload) { landing.broadcast(rebuyAfterResolve.payload); landing.mine(); }
    const x2 = row('X2', landing, { cancel: cancelled(firstCancel), rebuy: outcome(rebuy), resolve: cancelled(secondCancel), op1: landing.status(first), rebuyAfterResolve: outcome(rebuyAfterResolve) },
      { p1: sent.payload, p2: rebuy.payload ?? rebuyAfterResolve.payload });
    // X3: the transfer lands after the re-buy was refused.
    const w = world(); const op1 = w.buy('one'); const r = await w.handoff(op1); w.broadcast(r.payload);
    const c = await attempt(() => w.cancel(op1)); const op2 = w.buy('two'); const r2 = await attempt(() => w.handoff(op2));
    if (r2.payload) w.broadcast(r2.payload); w.mine();
    const c2 = await attempt(() => w.cancel(op1));
    return [x2, row('X3', w, { cancel: cancelled(c), rebuy: outcome(r2), resolve: cancelled(c2), op1: w.status(op1) }, { p1: r.payload, p2: r2.payload })];
  }],
  ['a declined handoff is cancelled once the release transfer lands, and the wallet is free', async (world) => {
    const w = world(); const op1 = w.buy('one'); const r = await w.handoff(op1);
    const c = await attempt(() => w.cancel(op1)); const op2 = w.buy('two'); const r2 = await attempt(() => w.handoff(op2));
    if (r2.payload) { w.broadcast(r2.payload); w.mine(); }
    const status1 = w.status(op1);
    if (c.release) { w.broadcast(c.release); w.mine(); }
    const c2 = await attempt(() => w.cancel(op1)); const r3 = await attempt(() => w.handoff(op2));
    if (r3.payload) { w.broadcast(r3.payload); w.mine(); }
    return [row('X0', w, { cancel: cancelled(c), hasRelease: Boolean(c.release), op1AfterCancel: status1, rebuyBeforeRelease: outcome(r2), resolve: cancelled(c2), op1: w.status(op1), rebuyAfterRelease: outcome(r3) }, { p1: r.payload, p2: r2.payload ?? r3.payload })];
  }],
  ['an unrelated transaction at the slot releases it', async (world) => {
    const w = world(); const op1 = w.buy('one'); const r = await w.handoff(op1);
    const c = await attempt(() => w.cancel(op1)); w.external();
    const c2 = await attempt(() => w.cancel(op1)); const op2 = w.buy('two'); const r2 = await attempt(() => w.handoff(op2));
    if (r2.payload) { w.broadcast(r2.payload); w.mine(); }
    const x4 = row('X4', w, { cancel: cancelled(c), resolve: cancelled(c2), op1: w.status(op1), rebuy: outcome(r2) }, { p1: r.payload, p2: r2.payload });
    // X7: the wallet's next transaction skips the slot; the page has no row at it, so the purchase stays open.
    const v = world(); const op = v.buy('one'); const old = (await v.handoff(op)).payload;
    const d = await attempt(() => v.cancel(op)); v.external(9);
    const d2 = await attempt(() => v.cancel(op)); const op3 = v.buy('two'); const s2 = await attempt(() => v.handoff(op3));
    if (s2.payload) { v.broadcast(s2.payload); v.mine(); }
    v.broadcast(old); v.mine();
    return [x4, row('X7', v, { cancel: cancelled(d), resolve: cancelled(d2), op1: v.status(op), rebuy: outcome(s2), rebuyNonce: s2.payload?.content?.nonce ?? null }, { p1: old, p2: s2.payload })];
  }],
  ['a late landing of the old payload after release is rejected by the chain', async (world) => {
    const w = world(); const op1 = w.buy('one'); const old = (await w.handoff(op1)).payload;
    const c = await attempt(() => w.cancel(op1)); if (c.release) { w.broadcast(c.release); w.mine(); }
    const c2 = await attempt(() => w.cancel(op1)); const op2 = w.buy('two'); const r2 = await attempt(() => w.handoff(op2));
    if (r2.payload) { w.broadcast(r2.payload); w.mine(); }
    w.broadcast(old); w.mine();
    return [row('X5', w, { resolve: cancelled(c2), op1: w.status(op1), rebuy: outcome(r2) }, { p1: old, p2: r2.payload })];
  }],
  ['the release transfer and the old payload pending together end with one transaction at the slot', async (world) => {
    const rows: Row[] = [];
    for (const order of ['release first', 'old first']) {
      const w = world(); const op1 = w.buy('one'); const old = (await w.handoff(op1)).payload;
      const c = await attempt(() => w.cancel(op1));
      const send = (p: any) => { if (p) w.broadcast(p); };
      if (order === 'release first') { send(c.release); send(old); } else { send(old); send(c.release); }
      w.mine();
      const c2 = await attempt(() => w.cancel(op1)); const op2 = w.buy('two'); const r2 = await attempt(() => w.handoff(op2));
      if (r2.payload) { w.broadcast(r2.payload); w.mine(); }
      rows.push(row(`X9 ${order}`, w, { resolve: cancelled(c2), op1: w.status(op1), rebuy: outcome(r2) }, { p1: old, p2: r2.payload }));
    }
    return rows;
  }],
  ['an unreadable history, or a reader without the method, leaves the purchase open', async (world) => {
    const unreadable = world({ historyDown: true }), withoutMethod = world({ noSeam: true });
    return [await openAfterSlotTaken('X8', unreadable, () => unreadable.external()), await openAfterSlotTaken('X10', withoutMethod, () => withoutMethod.external())];
  }],
  ['re-offering the same payload twice pays once', async (world) => {
    const w = world(); const op1 = w.buy('one'); const a = await w.handoff(op1); w.broadcast(a.payload);
    const b = await attempt(() => w.handoff(op1)); if (b.payload) w.broadcast(b.payload); w.mine();
    return [row('X6', w, { samePayload: JSON.stringify(a.payload) === JSON.stringify(b.payload), op1: w.status(op1) }, { p1: a.payload })];
  }],
  ['cancel after a landed handoff settles it', async (world) => {
    const w = world(); const op1 = w.buy('one'); const r = await w.handoff(op1); w.broadcast(r.payload); w.mine();
    const c = await attempt(() => w.cancel(op1)); const op2 = w.buy('two'); const r2 = await attempt(() => w.handoff(op2));
    if (r2.payload) { w.broadcast(r2.payload); w.mine(); }
    return [row('X1', w, { cancel: cancelled(c), op1: w.status(op1), rebuy: outcome(r2) }, { p1: r.payload, p2: r2.payload })];
  }],
  ['a failed payment at the slot leaves the purchase open', async (world) => {
    const w = world({ failPayment: 'consumes' }); const op1 = w.buy('one'); const r = await w.handoff(op1); w.broadcast(r.payload); w.mine();
    const c = await attempt(() => w.cancel(op1));
    return [row('X11', w, { cancel: cancelled(c), op1: w.status(op1) }, { p1: r.payload })];
  }],
  ['a failed row beside a confirmed one does not hide it', async (world) => {
    const w = world({ failPayment: 'free' }); const op1 = w.buy('one'); const a = await w.handoff(op1); w.broadcast(a.payload); w.mine();
    const b = await attempt(() => w.handoff(op1)); const again = b.payload && { ...b.payload, content: { ...b.payload.content, timestamp: b.payload.content.timestamp + 1 } };
    if (again) w.broadcast(again); w.mine();
    const c = await attempt(() => w.cancel(op1));
    return [row('X11b', w, { samePayload: Boolean(b.payload), cancel: cancelled(c), op1: w.status(op1) }, { p1: again })];
  }],
  ['a transaction that is not a native transfer at the slot leaves it open', async (world) => {
    const w = world(); return [await openAfterSlotTaken('X12', w, () => w.external(w.chain.nonce + 1, 'storageProgram'))];
  }],
  ['a slot row whose canonical nonce differs leaves it open', async (world) => {
    const w = world({ bodyNonceOff: true }); return [await openAfterSlotTaken('X13', w, () => w.external())];
  }],
  // The status read says the slot's transaction is included; the canonical body of the same transaction says it failed, or is still pending.
  ['a slot transaction whose canonical body is not confirmed leaves it open', async (world) => {
    const failed = world({ bodyStatus: 'failed' }), pending = world({ bodyStatus: 'pending' });
    return [await openAfterSlotTaken('X25 failed', failed, () => failed.external()), await openAfterSlotTaken('X25 pending', pending, () => pending.external())];
  }],
  ['a slot row with no readable hash leaves it open', async (world) => {
    const w = world({ badHash: true }); return [await openAfterSlotTaken('X14', w, () => w.external())];
  }],
  ['an amount the node projects as DEM text is never read as another transaction', async (world) => [await paidRow('X15', world, { amountDem: true })]],
  ['a history that lags the nonce leaves the purchase open', async (world) => [await paidRow('X16', world, { lag: 1 })]],
  ['a payment signed by another key and missing from the wallet\'s history leaves the purchase open', async (world) => [await paidRow('X17', world, {})]],
  ['a history served oldest first leaves the purchase open', async (world) => [await paidRow('X18', world, { oldestFirst: true, base: 120 })]],
  // The node caps a page below the limit and 25 later rows push the payment off it.
  ['a page capped below the limit leaves the purchase open', async (world) => [await paidRow('X19', world, { cap: 20 }, (x) => { for (let i = 0; i < 25; i++) x.external(); })]],

  ['a release signed by the wallet\'s own key does not cancel while another key\'s payment can still land', async (world) => {
    const w = world(); const op1 = w.buy('one'); const old = (await w.handoff(op1)).payload; await decline(w, op1);
    const c2 = await attempt(() => w.cancel(op1)); w.broadcast(old); w.mine(); const r2 = await buyAgain(w);
    return [row('A', w, { resolve: cancelled(c2), op1: w.status(op1), rebuy: outcome(r2) }, { p1: old, p2: r2.payload })];
  }],
  ['an own-key transaction at the slot with another key\'s payment pending does not cancel', async (world) => {
    const w = world(); return [await slotTaken('B', w, () => w.external(), { pending: true })];
  }],
  ['an own-key transaction past the slot with another key\'s payment pending does not end the purchase', async (world) => {
    const w = world(); return [await slotTaken('C', w, () => w.external(9), { pending: true })];
  }],
  ['an own-key transaction after an unlisted payment signed by another key does not end the purchase', async (world) => [await paidRow('D', world, {}, (x) => x.external())]],
  // The release lands, 100 later rows (the wallet's own, or inbound) push its row off the one page the reader asks for, and cancel is called again.
  ['a release that has left the one page the reader asks for is still a way out through `verify_deal` with the gate on, and with it off the purchase stays open', async (world) => {
    const rows: Row[] = [];
    for (const [name, later] of [['E own', (x: World) => { for (let i = 0; i < 100; i++) x.external(); }], ['E inbound', (x: World) => x.inbound(...Array.from({ length: 100 }, (_, i) => i + 1))]] as const) {
      const w = world(); const op1 = w.buy('one'); await w.handoff(op1); const c = await decline(w, op1); later(w);
      const c2 = await attempt(() => w.cancel(op1)); const st = w.status(op1);
      const early = await attempt(() => w.handoff(w.buy('two'))); const v = c.release ? await attempt(() => w.verify(op1, c.release)) : { threw: 'no release' };
      rows.push(row(name, w, { resolve: cancelled(c2), op1AtResolve: st, rebuyBefore: outcome(early), verifyRelease: verdict(v), op1: w.status(op1), rebuyAfter: outcome(await attempt(() => w.handoff(w.buy('three')))) }));
    }
    return rows;
  }],
  ['a decliner who sends the release and calls `verify_deal` with its hash is free with the gate on, and stays blocked with it off', async (world) => {
    const w = world(); const op1 = w.buy('one'); await w.handoff(op1); const c = await decline(w, op1);
    const st = w.status(op1); const early = await attempt(() => w.handoff(w.buy('two'))); const v = c.release ? await attempt(() => w.verify(op1, c.release)) : { threw: 'no release' };
    return [row('F', w, { resolve: 'not called', op1AtResolve: st, rebuyBefore: outcome(early), verifyRelease: verdict(v), op1: w.status(op1), rebuyAfter: outcome(await attempt(() => w.handoff(w.buy('three')))) })];
  }],
  // verify_deal's mismatch branch frees the wallet only under the gate (one nonce per account, every such transaction listed); with it off
  // the purchase stays payment_uncertain, so a payload that lands afterwards cannot be a second payment.
  ['a payload that lands after `verify_deal` freed the wallet (gate on) or left it blocked (gate off) is never a second payment for a wallet that signs with its own key', async (world) => {
    const w = world(); const op1 = w.buy('one'); const old = (await w.handoff(op1)).payload; const c = await decline(w, op1);
    const v = await attempt(() => w.verify(op1, c.release)); w.broadcast(old); w.mine(); const r2 = await buyAgain(w);
    return [row('F late', w, { verifyRelease: verdict(v), op1: w.status(op1), rebuy: outcome(r2) }, { p1: old, p2: r2.payload })];
  }],
  // A wallet with no transaction before the handoff (slot 1) whose slot another client skips: no row at slot 1 exists to give verify_deal.
  ['a wallet with no earlier transaction whose slot is skipped stays blocked', async (world) => {
    const w = world({ base: 0 }); const op1 = w.buy('one'); const old = (await w.handoff(op1)).payload;
    const c = await attempt(() => w.cancel(op1)); if (c.release) w.broadcast(c.release); w.external(old.content.nonce + 1); w.mine();
    const c2 = await attempt(() => w.cancel(op1)); const r2 = await attempt(() => w.handoff(w.buy('two'))); const v = c.release ? await attempt(() => w.verify(op1, c.release)) : { threw: 'no release' };
    return [row('G', w, { releaseLanded: w.landed(c.release), resolve: cancelled(c2), op1: w.status(op1), rebuy: outcome(r2), verifyRelease: verdict(v) })];
  }],
  // A transaction with a nonce far ahead ended failed and stays in the history, newest by its signed timestamp, with the account's nonce where it was.
  ['a failed row at N+50 does not hide a release or a landed payment', async (world) => {
    const farNewest = { tsOf: (a: any) => a.failed ? 1e6 : undefined };
    const w = world(farNewest); w.farFail(57); const op1 = w.buy('one'); const old = (await w.handoff(op1)).payload; const c = await decline(w, op1);
    const c2 = await attempt(() => w.cancel(op1)); const r2 = await buyAgain(w);
    const release = row('X20 release', w, { hasRelease: Boolean(c.release), resolve: cancelled(c2), op1: w.status(op1), rebuy: outcome(r2) }, { p1: old, p2: r2.payload });
    const v = world(farNewest); v.farFail(57); const op = v.buy('one'); const r = await v.handoff(op); v.broadcast(r.payload); v.mine();
    const d = await attempt(() => v.cancel(op));
    return [release, row('X20 landed', v, { cancel: cancelled(d), op1: v.status(op) }, { p1: r.payload })];
  }],
  // The payment itself ends failed at the slot (the nonce stays free), or is signed far ahead (N+50) and ends failed.
  ['a failed payment at the slot, or one signed 50 ahead, never settles or ends the purchase, and `verify_deal` on its hash does not settle it', async (world) => {
    const w = world({ failPayment: 'free' }); const op1 = w.buy('one'); const r = await w.handoff(op1); w.broadcast(r.payload); w.mine();
    const c = await attempt(() => w.cancel(op1)); const v = await attempt(() => w.verify(op1, r.payload)); const r2 = await buyAgain(w);
    const atSlot = row('X21 at the slot', w, { cancel: cancelled(c), verify: verdict(v), op1: w.status(op1), rebuy: outcome(r2) }, { p1: r.payload, p2: r2.payload });
    const x = world({ farGap: 10 }); const op = x.buy('one'); const q = await x.handoff(op);
    const far = { ...q.payload, content: { ...q.payload.content, nonce: q.payload.content.nonce + 50 } }; x.broadcast(far); x.mine();
    const d = await attempt(() => x.cancel(op)); const dv = await attempt(() => x.verify(op, far)); const q2 = await buyAgain(x);
    return [atSlot, row('X21 at N+50', x, { cancel: cancelled(d), verify: verdict(dv), op1: x.status(op), rebuy: outcome(q2) }, { p1: far, p2: q2.payload })];
  }],
  // Rows that only pay the wallet carry the sender's nonce, at the slot's and above: they do not hide a lagging payment, and are not the slot's.
  ['rows that only pay the wallet do not hide a landed payment and are not the slot\'s transaction', async (world) => {
    const lag = await paidRow('X22 lag', world, { lag: 1 }, undefined, (x) => x.inbound(6, 7, 8));
    const w = world(); const op1 = w.buy('one'); const old = (await w.handoff(op1)).payload; await decline(w, op1); w.inbound(7, 8, 20);
    const c2 = await attempt(() => w.cancel(op1)); const r2 = await buyAgain(w);
    return [lag, row('X22 release', w, { resolve: cancelled(c2), op1: w.status(op1), rebuy: outcome(r2) }, { p1: old, p2: r2.payload })];
  }],
  // The payment was signed before every row already in the history, so its row is last and its nonce the highest: nonce order and page order disagree.
  // X24 adds a cap that cuts the page between the lower rows and the payment.
  ['a page ordered by signed timestamp, with or without a cap, leaves the purchase open', async (world) => {
    const signedEarly = { tsOf: (a: any) => a.to === PAYEE ? -1 : undefined };
    return [await paidRow('X23', world, signedEarly), await paidRow('X24', world, { ...signedEarly, cap: 6 })];
  }],

  // The wallet's last row before the handoff is stamped after the payment and 99 own rows follow: own rows on both sides, none at the slot.
  ['a lower own row stamped after the payment, with the slot\'s row off the page, never ends the purchase', async (world) => [
    await paidRow('T3', world, { tsOf: (_a: any, i: number) => i === 5 ? 6.5 : undefined }, (x) => { for (let i = 0; i < 99; i++) x.external(); }),
  ]],
  // With the gate off the answer names the slot's transaction (a release would be refused); verify_deal with it leaves the purchase open.
  ['a decliner whose slot their own other transaction took is given its hash, and `verify_deal` with it does not free the wallet', async (world) => {
    const w = world(); const op1 = w.buy('one'); await w.handoff(op1); await attempt(() => w.cancel(op1)); w.external();
    const c2 = await attempt(() => w.cancel(op1)); const v = c2.slotTxHash ? await attempt(() => w.verifyHash(op1, c2.slotTxHash)) : { threw: 'no hash' };
    return [row('H', w, { release: Boolean(c2.release), verify: verdict(v), op1: w.status(op1), rebuy: outcome(await buyAgain(w)) })];
  }],
  // The release's hash is reported before it lands and the pending payment takes the slot: the purchase is broadcast_reported, which cancel
  // refuses; only verify_deal with the payment's hash settles it. The answer says to report the release's hash only once it has landed.
  ['a release whose hash is reported before it lands, with the payment taking the slot, is settled only by `verify_deal` with the payment\'s hash', async (world) => {
    const w = world(); const op1 = w.buy('one'); const r = await w.handoff(op1); w.broadcast(r.payload); const c = await attempt(() => w.cancel(op1)); w.broadcast(c.release);
    const v1 = await attempt(() => w.verify(op1, c.release)); w.mine(); const c2 = await attempt(() => w.cancel(op1)); const st = w.status(op1); const v2 = await attempt(() => w.verify(op1, r.payload));
    return [row('R', w, { told: /only after it has landed.*payment's hash/.test(c.message), verifyRelease: verdict(v1), cancelAfter: cancelled(c2), op1AtCancel: st, verifyPayment: verdict(v2), op1: w.status(op1), rebuy: outcome(await buyAgain(w)) }, { p1: r.payload })];
  }],
];

// What each row ends with when the wallet signs with its own key: [name, transfers to the payee, payloads the chain refused, the answers].
const EXPECTED: Array<[string, number, number, any]> = [
  ['X1', 2, 0, { cancel: false, op1: 'settled_verified', rebuy: 'payload' }],
  ['X2', 2, 0, { cancel: false, rebuy: 'unresolved_payment', resolve: false, op1: 'settled_verified', rebuyAfterResolve: 'payload' }],
  ['X3', 1, 0, { cancel: false, rebuy: 'unresolved_payment', resolve: false, op1: 'settled_verified' }],
  ['X0', 1, 0, { cancel: false, hasRelease: true, op1AfterCancel: 'payment_uncertain', rebuyBeforeRelease: 'unresolved_payment', resolve: true, op1: 'cancelled', rebuyAfterRelease: 'payload' }],
  ['X4', 1, 0, { cancel: false, resolve: true, op1: 'cancelled', rebuy: 'payload' }],
  ['X5', 1, 1, { resolve: true, op1: 'cancelled', rebuy: 'payload' }],
  ['X6', 1, 1, { samePayload: true, op1: 'payment_handoff' }],
  ['X7', 0, 1, { cancel: false, resolve: false, op1: 'payment_uncertain', rebuy: 'unresolved_payment', rebuyNonce: null }],
  ['X8', 0, 0, { resolve: 'request failed', op1: 'payment_uncertain' }],
  ['X9 release first', 1, 1, { resolve: true, op1: 'cancelled', rebuy: 'payload' }],
  ['X9 old first', 2, 1, { resolve: false, op1: 'settled_verified', rebuy: 'payload' }],
  ['X10', 0, 0, { resolve: false, op1: 'payment_uncertain' }],
  ['X11', 0, 0, { cancel: false, op1: 'payment_uncertain' }],
  ['X11b', 1, 0, { samePayload: true, cancel: false, op1: 'settled_verified' }],
  ['X12', 0, 0, { resolve: false, op1: 'payment_uncertain' }],
  ['X13', 0, 0, { resolve: false, op1: 'payment_uncertain' }],
  ['X14', 0, 0, { resolve: false, op1: 'payment_uncertain' }],
  ['X25 failed', 0, 0, { resolve: false, op1: 'payment_uncertain' }],
  ['X25 pending', 0, 0, { resolve: false, op1: 'payment_uncertain' }],
  ['R', 2, 1, { told: true, verifyRelease: 'awaiting_inclusion', cancelAfter: 'invalid_state', op1AtCancel: 'broadcast_reported', verifyPayment: 'verified', op1: 'settled_verified', rebuy: 'payload' }],
  ...['X15', 'X16', 'X17', 'X18', 'X19'].map((n): [string, number, number, any] => n === 'X17' // nothing is unlisted when the wallet signs with its own key
    ? [n, 2, 0, { cancel: false, op1: 'settled_verified', rebuy: 'payload' }]
    : [n, 1, 0, { cancel: false, op1: 'payment_uncertain', rebuy: 'unresolved_payment' }]),
];
// The other rows (wallet key), by name: [transfers, the first purchase's final status] with the gate on, then with it off where that differs.
const cuts = [1, 'cancelled', 0, 'payment_uncertain'], open = [0, 'payment_uncertain'], mismatch = [0, 'payment_mismatch', 0, 'payment_uncertain'];
const ENDS: Record<string, any[]> = { ...Object.fromEntries(['X0', 'X4', 'X5', 'X9 release first', 'A', 'B', 'X20 release', 'X22 release'].map((n) => [n, cuts])),
  X7: [0, 'payment_uncertain'], C: [0, 'payment_uncertain'], T3: [1, 'payment_uncertain'], H: [1, 'cancelled', 0, 'payment_uncertain'], D: [2, 'settled_verified'], 'E own': mismatch, 'E inbound': mismatch, F: mismatch, 'F late': [1, 'payment_mismatch', 0, 'payment_uncertain'], G: [0, 'broadcast_reported'],
  'X20 landed': [1, 'settled_verified'], 'X21 at the slot': open, 'X21 at N+50': open, 'X22 lag': [1, 'payment_uncertain'], X23: [1, 'payment_uncertain'], X24: [1, 'payment_uncertain'] };
// Rows that end paid twice, or paid and cancelled, with the gate on where the node counts a nonce per signing key: the gate stays off there.
const KNOWN_WITH_GATE_ON: Record<Variant['signer'], string[]> = { wallet: [], alt: ['B', 'D', 'T3'], mixed: ['X9 release first', 'X9 old first', 'A', 'B', 'D', 'T3'] };

const VARIANTS: Variant[] = (['wallet', 'alt', 'mixed'] as const).flatMap((signer) => (['account', 'signer'] as const).map((nonceOwner) => ({ signer, nonceOwner })));
const SETTINGS = VARIANTS.flatMap((variant) => (['off', 'account'] as const).map((gate) => ({ variant, gate })));

describe.each(SETTINGS)('cancel of a handed-off non-native payment, signer $variant.signer, nonce owner $variant.nonceOwner, gate $gate', ({ variant, gate }) => {
  const known = gate === 'account' && variant.nonceOwner === 'signer' ? KNOWN_WITH_GATE_ON[variant.signer] : [];
  test.each(SCENARIOS)('%s', async (_name, scenario) => {
    for (const view of ['int', 'node2'] as const) {
      const rows = await scenario((o) => world(view, variant, gate, o));
      expect(rows.filter((r) => r.doublePay || r.paidCancelled).map((r) => r.name), `${view}: paid for a cancelled purchase`)
        .toEqual(rows.map((r) => r.name).filter((n) => known.includes(n)));
      if (variant.signer !== 'wallet') continue;
      expect(rows.filter((r) => r.doublePayMismatch).map((r) => r.name), `${view}: paid after a mismatch`).toEqual([]);
      for (const r of rows) {
        const [t, s, offT = t, offS = s] = ENDS[r.name] ?? [], full = EXPECTED.find((e) => e[0] === r.name);
        if (ENDS[r.name]) expect([r.name, r.transfers, r.extra.op1], view).toEqual([r.name, ...(gate === 'account' ? [t, s] : [offT, offS])]);
        if (full && (gate === 'account' || !ENDS[r.name])) expect([r.name, r.transfers, r.rejected, r.extra], view).toEqual(full);
        expect(Boolean(ENDS[r.name] || full), `${view}: ${r.name} has no expected end`).toBe(true);
        if (r.name === 'H' && gate === 'off') expect(r.extra, view).toMatchObject({ release: false, verify: 'mismatch_unproven', rebuy: 'unresolved_payment' });
      }
    }
  }, 120_000);
});

// The slot's transaction body is read back by hash: cancel ends the purchase only when that body is the slot's own transaction.
describe.each(['int', 'node2'] as const)('cancel reads the nonce slot body back, view %s', (view) => {
  const walletKey: Variant = { signer: 'wallet', nonceOwner: 'account' };
  const afterSlotTaken = async (name: string, o: Opts) => {
    const w = world(view, walletKey, 'account', o);
    return (await openAfterSlotTaken(name, w, () => w.external())).extra;
  };
  test('a body that agrees with the slot ends the purchase cancelled', async () => {
    expect(await afterSlotTaken('agree', {})).toEqual({ resolve: true, op1: 'cancelled' });
  });
  test.each([
    ['a body whose hash is another transaction\'s hash', { bodyHash: 'c'.repeat(64) }],
    ['a body from another payer than the observation', { bodyPayer: OTHER }],
    ['a body whose nonce is not the slot\'s nonce', { bodyNonceOff: true }],
    ['a body read that fails', { bodyDown: true }],
  ] as [string, Opts][])('%s leaves the purchase payment_uncertain', async (name, o) => {
    expect(await afterSlotTaken(name, o)).toEqual({ resolve: false, op1: 'payment_uncertain' });
  });
  test('a repeated cancel after a disagreeing body reads the slot again and ends the purchase cancelled', async () => {
    const w = world(view, walletKey, 'account', { bodyHash: 'c'.repeat(64) });
    const op1 = w.buy('one'); await w.handoff(op1); await attempt(() => w.cancel(op1)); w.external();
    const first = await attempt(() => w.cancel(op1)), open = w.status(op1);
    const again = await attempt(() => w.cancel(op1));
    expect([cancelled(first), open, cancelled(again), w.status(op1)]).toEqual([false, 'payment_uncertain', true, 'cancelled']);
    w.close();
  });
});

// A purchase that declares a seller transport: when cancel finds the payment at the nonce slot, the purchase settles and the protocol
// makes its seller request for that transaction. A slot taken by another transaction settles nothing and sends no seller request.
describe.each(['int', 'node2'] as const)('cancel of a purchase with a declared seller transport, view %s', (view) => {
  const walletKey: Variant = { signer: 'wallet', nonceOwner: 'account' };
  const advanced = (operation: any) => ({ ...operation, state: { ...operation.state, protocol: { stage: 'payment-observed' } } });
  const landedPayment = async (sellerRecheck: Opts['sellerRecheck']) => {
    const w = world(view, walletKey, 'account', { sellerRecheck });
    const op = w.buy('one'); const sent = await w.handoff(op); w.broadcast(sent.payload); w.mine();
    return { w, op, paymentHash: createHash('sha256').update(JSON.stringify(sent.payload)).digest('hex') };
  };
  test('a payment found at the slot makes one seller request for that transaction and returns the advanced purchase', async () => {
    const recheck = vi.fn(async (operation: any) => advanced(operation));
    const { w, op, paymentHash } = await landedPayment(recheck);
    const result = await w.cancel(op);
    expect(recheck).toHaveBeenCalledTimes(1);
    const [asked, coords] = recheck.mock.calls[0] as unknown as [any, any];
    expect([asked.id, asked.status, coords.reportedTxHash]).toEqual([op.id, 'settled_verified', paymentHash]);
    expect([result.cancelled, result.operation.state.protocol.stage, w.status(op)]).toEqual([false, 'payment-observed', 'settled_verified']);
    w.close();
  });
  test('a failed seller request leaves the payment settled and reaches the caller with its own error', async () => {
    const recheck = vi.fn(async () => { throw new Error('TEST-seller-refused'); });
    const { w, op } = await landedPayment(recheck);
    await expect(w.cancel(op)).rejects.toThrow('TEST-seller-refused');
    expect(w.status(op)).toBe('settled_verified');
    w.close();
  });
  test('a release transfer at the slot cancels the purchase without a seller request', async () => {
    const recheck = vi.fn(async (operation: any) => advanced(operation));
    const w = world(view, walletKey, 'account', { sellerRecheck: recheck });
    const op = w.buy('one'); await w.handoff(op); await decline(w, op);
    const result = await w.cancel(op);
    expect([result.cancelled, w.status(op), recheck.mock.calls.length]).toEqual([true, 'cancelled', 0]);
    w.close();
  });
});

// verify_deal's mismatch branch, read directly: where the network may count a nonce per signing key (gate off) a different transfer at the
// approved slot leaves the purchase payment_uncertain and the wallet blocked, whichever key signed it; the gate on is what ends it.
describe.each(['int', 'node2'] as const)('verify_deal on a transfer that took the approved slot, view %s', (view) => {
  const declined = async (variant: Variant, gate: Gate) => {
    const w = world(view, variant, gate); const op1 = w.buy('one'); await w.handoff(op1); const c = await decline(w, op1);
    return { w, op1, v: await w.verify(op1, c.release) };
  };
  test.each(['wallet', 'alt'] as const)('with the gate off, a %s-signed transfer keeps the purchase uncertain and blocks the wallet', async (signer) => {
    const { w, op1, v } = await declined({ signer, nonceOwner: 'signer' }, 'off');
    expect([v.verification.outcome, w.status(op1)]).toEqual(['mismatch_unproven', 'payment_uncertain']);
    expect(outcome(await attempt(() => w.handoff(w.buy('two'))))).toBe('unresolved_payment');
    w.close();
  });
  test('with the gate off, the mismatching hash is detached so a hash can be reported again', async () => {
    const { w, op1, v } = await declined({ signer: 'wallet', nonceOwner: 'account' }, 'off');
    expect(w.coordinates.get(op1.id).reportedTxHash).toBeNull();
    expect(verdict(await attempt(() => w.verifyReportedHash(op1)))).toBe('hash_required');
    expect(verdict(await attempt(() => w.verifyHash(op1, v.verification.txHash)))).toBe('mismatch_unproven');
    w.close();
  });
  test('with the gate on, the same transfer ends the purchase payment_mismatch and frees the wallet', async () => {
    const { w, op1, v } = await declined({ signer: 'wallet', nonceOwner: 'account' }, 'account');
    expect([v.verification.outcome, w.status(op1)]).toEqual(['mismatch', 'payment_mismatch']);
    expect(outcome(await attempt(() => w.handoff(w.buy('two'))))).toBe('payload');
    w.close();
  });
});
