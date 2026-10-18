// The cancel/send exclusion names a cancelled payment by its settlement terms
// (payer lane, nonce, payee, amount in OS), read as settlement reads them
// (@kynesyslabs/dacs observePayDemTransferCore), not by its payload digest.
// Every re-signed copy that could settle the cancelled purchase (another time,
// data encoding, payee case, amount form, nonce form or fee) is refused at the
// signature lease and at confirmTx, before the node sees it; a transfer with
// other terms is not; and one whose terms settlement cannot read, or whose
// payer is not its signer, is refused at confirmTx. The plugin's read before
// a handoff names a cancelled payment the same way. Offline: the Node2
// coverage fixture's .invalid stub and in-memory journal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { admittedTransport, layoutAdmission, layoutChain, memoryJournal, NETWORK, CHAIN } from './helpers/review-node2-current-coverage-fixture.mjs';
import { FEES, PAYER, PAYEE, sdkHeaders, signTransaction } from './helpers/review-native-readback-current-fixture.mjs';
import { nativePayloadDigest } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { transferRefusal } from '../src/wallet/devnet-native-transport.mjs';

// A whole-DEM price, so the pre-fork whole-DEM encoding is an equivalent form.
const OS = '3000000000', DEM = 3, NONCE = 7, TIMESTAMP = 1_900_000_000_123;
const key = (kind) => `devnet/${kind}/${JSON.stringify([NETWORK, CHAIN, PAYER])}`;
const refused = (code) => (e) => e.code === code;
// The unsigned payload the plugin hands the wallet.
const prepared = () => ({ content: { type: 'native', from: PAYER, to: PAYEE, amount: OS, data: ['native', { nativeOperation: 'send', args: [PAYEE, OS] }], nonce: NONCE, timestamp: TIMESTAMP } });
// It signed by the buyer's key, with each change applied.
const signed = (change = () => {}) => {
  const content = { ...structuredClone(prepared().content), transaction_fee: { ...FEES, rpc_address: null }, from_ed25519_address: PAYER };
  change(content);
  return signTransaction(content);
};
const upper = (address) => `0x${address.slice(2).toUpperCase()}`;
const send = (c, to, amount) => { c.to = to; c.data = ['native', { nativeOperation: 'send', args: [to, amount] }]; };

// The same settlement terms as the cancelled payment: each one settles it.
const EQUIVALENT = {
  'its time (timestamp + 1)': (c) => { c.timestamp += 1; },
  'its data re-encoded (the amount as whole-DEM numbers)': (c) => { c.amount = DEM; send(c, PAYEE, DEM); },
  'the payee in upper case': (c) => { send(c, upper(PAYEE), OS); },
  'the payee without its 0x': (c) => { send(c, PAYEE.slice(2), OS); },
  'the amount as a number (OS) and its argument as a string': (c) => { c.amount = Number(OS); },
  'the nonce as decimal text': (c) => { c.nonce = String(NONCE); },
  'its fee': (c) => { c.transaction_fee = { ...FEES, rpc_fee: '2000000001', rpc_address: null }; },
  'no from_ed25519_address (its signer pays)': (c) => { delete c.from_ed25519_address; },
};
// Another transfer: it cannot settle the cancelled purchase.
const OTHER = {
  'the next nonce': (c) => { c.nonce = NONCE + 1; },
  'another amount': (c) => { c.amount = '3000000001'; send(c, PAYEE, '3000000001'); },
  'another payee': (c) => { send(c, `0x${'6'.repeat(64)}`, OS); },
};
// Terms settlement cannot read, or a payer that is not its signer.
const UNREADABLE = {
  'another payer than its signer': (c) => { c.from_ed25519_address = `0x${'6'.repeat(64)}`; },
  'an amount and argument that disagree': (c) => { c.amount = '1'; },
  'a whole-DEM argument with an OS string amount': (c) => { send(c, PAYEE, DEM); },
  'a nonce settlement cannot read': (c) => { c.nonce = '07'; },
};

async function world(t) {
  const journal = memoryJournal();
  const run = admittedTransport(await layoutAdmission(), { ...layoutChain(), getAddressNonce: { result: 200, response: { nonce: 6 } } }, { journal });
  const source = run.capability;
  t.after(() => source.close());
  const bind = async () => (await source.binding({ phase: 'bind', address: PAYER })).binding;
  // As the shipped wallet names a transfer: lowercased payee, amount in OS.
  const named = async (tx, terms = {}) => ({ nonce: NONCE, to: PAYEE, amountOs: OS, payloadDigest: await nativePayloadDigest(tx.content), ...terms });
  const confirm = async (tx) => {
    const lease = await source.binding({ phase: 'signature', address: PAYER, binding: await bind() });
    try { return await source.rpc({ method: 'execute', params: [{ extra: 'confirmTx', data: tx }] }, sdkHeaders()); }
    finally { await source.binding({ phase: 'release', address: PAYER, leaseId: lease.leaseId }); }
  };
  const reached = () => run.stub.messages().filter((m) => ['confirmTx', 'broadcastTx'].includes(m)).length;
  const cancelled = await source.cancelNativeTransfer({ address: PAYER, operationId: 'TEST-cancelled', payload: prepared(), unissued: async () => true });
  assert.deepEqual(cancelled, { cancelled: true, claimed: null });
  return { run, source, journal, bind, named, confirm, reached };
}

test('the cancellation keeps the settlement terms, with the payload digest as evidence', async (t) => {
  const w = await world(t);
  const [record] = (await w.journal.get(key('cancelled-payments'))).transfers;
  assert.deepEqual(Object.keys(record).sort(), ['amountOs', 'cancelledAt', 'nonce', 'operationId', 'payloadDigest', 'to']);
  assert.deepEqual([record.nonce, record.to, record.amountOs, record.operationId], [NONCE, PAYEE, OS, 'TEST-cancelled']);
  assert.equal(record.payloadDigest, await nativePayloadDigest(prepared().content));
});

// Before a handoff the plugin asks whether its payment has a cancelled
// payment's terms (purchases.mjs prepareHandoffCore, the out-of-order case),
// and asks again when the wallet reports an error (reportWalletResult).
test('the plugin\'s read before a handoff (nativeTransferCancelled) names a cancelled payment exactly as the source\'s refusals do: every equivalent payload is cancelled, another nonce, payee or amount is not; no network read, lock or write', async (t) => {
  const w = await world(t);
  const payload = (change = () => {}) => { const content = structuredClone(prepared().content); change(content); return { content }; };
  const locks = [], puts = w.journal.puts.length, messages = w.run.stub.messages().length, withWalletLock = w.journal.withWalletLock;
  w.journal.withWalletLock = (k, work) => { locks.push(k); return withWalletLock(k, work); };
  for (const [name, change] of Object.entries(EQUIVALENT)) assert.equal(await w.source.nativeTransferCancelled(PAYER, payload(change)), true, name);
  for (const [name, change] of Object.entries(OTHER)) assert.equal(await w.source.nativeTransferCancelled(PAYER, payload(change)), false, name);
  assert.deepEqual([locks, w.journal.puts.length, w.run.stub.messages().length], [[], puts, messages], 'no lock, write or network read');
  for (const [name, change] of Object.entries(UNREADABLE)) await assert.rejects(w.source.nativeTransferCancelled(PAYER, payload(change)), refused('invalid_params'), name);
  await assert.rejects(w.source.nativeTransferCancelled(`0x${'6'.repeat(64)}`, payload()), refused('invalid_params'), 'another payer\'s lane');
});

// The cancel tool says a payment "may be on its way" only for a claim on its
// transfer: a retained, unobserved transfer is that claim only when it has
// the transfer's terms. Another write retained on the lane still refuses the
// cancellation, through the plugin's proof (readback only, main's answer).
test('a retained transfer is a claim on this payment only with its settlement terms; another retained write is none, and the plugin\'s proof refuses the cancellation', async (t) => {
  const w = await world(t);
  const retain = (tx) => w.journal.put(key('native-wallet'), { stage: 'broadcast-accepted', hash: tx.hash, nonce: tx.content.nonce, signedTransaction: tx });
  const payload = { content: { ...prepared().content, nonce: NONCE + 1 } };
  await retain(signed((c) => { c.nonce = NONCE + 2; }));
  assert.equal(await w.source.nativeTransferClaimed(PAYER, payload), null, 'another transfer is no claim on it');
  assert.deepEqual(await w.source.cancelNativeTransfer({ address: PAYER, operationId: 'TEST-other', payload, unissued: async () => false }), { cancelled: false, claimed: null });
  await retain(signed((c) => { c.nonce = NONCE + 1; c.timestamp += 1; c.to = upper(PAYEE); c.data = ['native', { nativeOperation: 'send', args: [c.to, OS] }]; }));
  assert.equal(await w.source.nativeTransferClaimed(PAYER, payload), 'broadcast-accepted', 'a re-signed copy of it is');
  assert.deepEqual(await w.source.cancelNativeTransfer({ address: PAYER, operationId: 'TEST-other', payload, unissued: async () => true }), { cancelled: false, claimed: 'broadcast-accepted' });
});

for (const [name, change] of Object.entries(EQUIVALENT)) {
  test(`a re-signed copy with ${name}: the same settlement terms, so a lease naming it and its confirmTx are refused; nothing reaches the node`, async (t) => {
    const w = await world(t);
    const copy = signed(change);
    // The shipped wallet names its own payload; a direct relay call can name it as it likes.
    for (const transfer of [await w.named(copy), { ...await w.named(copy), to: copy.content.to }]) {
      await assert.rejects(async () => w.source.binding({ phase: 'signature', address: PAYER, binding: await w.bind(), transfer }), refused('payment_cancelled'), JSON.stringify(transfer));
    }
    await assert.rejects(w.confirm(copy), refused('payment_cancelled'), 'a lease naming nothing: its confirmTx');
    assert.equal(w.reached(), 0, 'nothing reached the node');
    assert.deepEqual((await w.journal.get(key('transfer-claims')))?.claims ?? [], [], 'nothing was claimed');
    // The plugin's question about the cancelled payload is about its terms.
    assert.equal(await w.source.nativeTransferClaimed(PAYER, prepared()), null);
  });
}

for (const [name, change] of Object.entries(OTHER)) {
  test(`a transfer with ${name} cannot settle the cancelled payment: the source does not refuse it`, async (t) => {
    const w = await world(t);
    const tx = signed(change);
    const lease = await w.source.binding({ phase: 'signature', address: PAYER, binding: await w.bind(), transfer: await w.named(tx, { nonce: Number(tx.content.nonce), to: tx.content.to.toLowerCase(), amountOs: String(tx.content.amount) }) });
    await w.source.binding({ phase: 'release', address: PAYER, leaseId: lease.leaseId });
    // The fixture's node refuses the confirmTx it is sent; what matters is that it was sent.
    await assert.rejects(w.confirm(tx), (e) => !['payment_cancelled', 'transfer_unreadable'].includes(e.code));
    assert.equal(w.reached(), 1, 'the confirmTx reached the node');
  });
}

for (const [name, change] of Object.entries(UNREADABLE)) {
  test(`a transfer with ${name}: the source cannot name it, so its confirmTx is refused; nothing reaches the node`, async (t) => {
    const w = await world(t);
    await assert.rejects(w.confirm(signed(change)), refused('transfer_unreadable'));
    assert.equal(w.reached(), 0);
  });
}

// After the source change's failed lane an earlier attempt may have been sent, so a refusal
// speaks for this attempt only.
test('the relays answer each transfer refusal with 409 and a text that says this attempt was not sent, never that nothing was sent', () => {
  for (const code of ['payment_cancelled', 'transfer_mismatch', 'transfer_unreadable']) {
    const [status, body] = transferRefusal({ code });
    assert.deepEqual([status, body.error, body.result, body.response], [409, code, 409, body.message], code);
    assert.match(body.message, /so this attempt was not sent/, code);
    assert.doesNotMatch(body.message, /nothing was sent/, code);
  }
});
