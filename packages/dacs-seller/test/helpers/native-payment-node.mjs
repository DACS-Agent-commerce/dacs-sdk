// A scripted Demos node for the native payment world. It stands in for the network only: it keeps what was actually sent to it (a
// transfer, a signed CREATE) and answers every read from those records. It never reports a transaction that nobody sent.
import * as core from '@kynesyslabs/dacs';
import { DEMOS_SR2_FIXTURE_CHAIN_IDENTITY, createDemosSr2Adapter, createInMemoryDemosSr2Journal } from '../../src/dacs/demos-sr2-adapter.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../../src/dacs/wallet-transactions.mjs';

const BLOCK_SPACING_S = 2;
const STORAGE_FEE_BYTES = 10_240;
const RPC_URL = 'http://127.0.0.1:9/';
const clone = (value) => structuredClone(value);
const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-dacs-simulation': 'fixture' } });

/**
 * One scripted node. `now` is the world's wall clock; blocks are stamped at least two seconds apart and never before it.
 * Returns `fetchImpl` (the node's RPC), `reader` (the SR-2 adapter over it), `pay` (a buyer transfer), `create` (a CREATE the seller's wallet
 * signs, applied unless `land: false`), `apply` (a signed transaction that reaches the node), `rebroadcast` (applies a kept CREATE once),
 * and the reads the wallet journal needs: `accountNonce`, `transactionState`, `blockHeight`.
 */
export function scriptedDemosNode(now) {
  const chain = DEMOS_SR2_FIXTURE_CHAIN_IDENTITY;
  const blocks = [{ number: 0, status: 'confirmed', hash: chain, content: { timestamp: 0, ordered_transactions: [] }, validation_data: { simulated: true, chainIdentity: chain } }];
  const transactions = new Map(), programs = new Map(), nonces = new Map(), accountNonces = new Map(), pending = new Map(), applied = [];
  let clock = Math.ceil(now() / 1000);
  const include = (transaction) => {
    clock = Math.max(clock + BLOCK_SPACING_S, Math.ceil(now() / 1000));
    const number = blocks.length;
    blocks.push({ number, status: 'confirmed', hash: core.sha256Hex(`TEST-block:${number}:${transaction.hash}`), content: { timestamp: clock, ordered_transactions: [transaction.hash] },
      validation_data: { simulated: true, chainIdentity: chain } });
    const executed = { ...clone(transaction), status: 'confirmed', blockNumber: number };
    for (const edit of executed.content.gcr_edits ?? []) if (edit.txhash === '') edit.txhash = transaction.hash;
    transactions.set(transaction.hash, executed);
    return number;
  };
  // `script.transferRead(hash, record, message)` answers a read of a transaction in place of the node's record (null reads as not found; a throw
  // as an unreachable node), and is told which read it answers (`getTransactionStatus` or `getTxByHash`); `script.programRead(record)` does the
  // same for a storage program; `script.onRead({ message, hash })` is told of each transaction read before it is answered;
  // `counts.transactionReads` counts transaction reads. A record whose status is `failed` reads as a failed transaction.
  const script = { transferRead: null, programRead: null, onRead: null }, counts = { transactionReads: 0 };
  const transactionRecord = (message, hash) => {
    counts.transactionReads++;
    script.onRead?.({ message, hash });
    const record = transactions.get(hash) ?? null;
    return script.transferRead ? script.transferRead(hash, record && clone(record), message) : clone(record);
  };
  const nodeCall = (message, data) => {
    switch (message) {
      case 'getBlockByNumber': return clone(blocks[data.blockNumber] ?? null);
      case 'getAddressNonce': return accountNonces.get(data.address) ?? 0;
      case 'getTransactionStatus': { const found = transactionRecord(message, String(data.hash).toLowerCase()); return found ? { state: found.status === 'failed' ? 'failed' : 'included', blockNumber: found.blockNumber } : { state: 'not-found' }; }
      case 'getTxByHash': return transactionRecord(message, String(data.hash).toLowerCase());
      case 'searchStoragePrograms': return [...programs.values()].filter((program) => program.programName === data.query).map(({ storageAddress, programName }) => ({ storageAddress, programName }));
      default: return undefined;
    }
  };
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const program = /^\/storage-program\/(stor-[0-9a-f]{40})$/.exec(pathname);
    if ((init.method ?? 'GET') === 'GET' && program) {
      const stored = programs.get(program[1]) ?? null;
      let served;
      try { served = script.programRead ? script.programRead(stored && clone(stored)) : stored && clone(stored); } catch (error) { return answer(503, { error: error.message }); }
      return served ? answer(200, served) : answer(404, { success: false });
    }
    if (init.method === 'POST' && pathname === '/') {
      const call = JSON.parse(init.body).params[0];
      let response;
      try { response = nodeCall(call.message, call.data ?? {}); } catch (error) { return answer(503, { error: error.message }); }
      return answer(200, response === undefined ? { result: 400, response: 'unknown method' } : { result: 200, response });
    }
    return answer(404, { error: 'not found' });
  };
  // A signed CREATE reaches the node: it is included, its program is created and its writer's account nonce moves up.
  const apply = (signed) => {
    const [, operation] = signed.content.data, owner = signed.content.from_ed25519_address ?? signed.content.from;
    include(signed);
    accountNonces.set(owner, signed.content.nonce);
    if (operation?.operation === 'CREATE_STORAGE_PROGRAM') {
      programs.set(operation.storageAddress, { success: true, storageAddress: operation.storageAddress, owner, programName: operation.programName, data: clone(operation.data),
        metadata: clone(operation.metadata), createdByTx: signed.hash, interactionTxs: [signed.hash] });
    }
    applied.push({ logicalAddress: operation?.metadata?.logicalAddress, artifactKind: operation?.metadata?.artifactKind, hash: signed.hash });
  };
  const pay = ({ from, to, amountOs }) => {
    const nonce = (nonces.get(from) ?? 0) + 1;
    nonces.set(from, nonce);
    const content = { type: 'native', from, from_ed25519_address: from, to, amount: amountOs, data: ['native', { nativeOperation: 'send', args: [to, amountOs] }], nonce, timestamp: now() };
    const transfer = { hash: core.sha256Hex(JSON.stringify(content)), content, signature: { type: 'ed25519', data: 'TEST-buyer-transfer' } };
    include(transfer);
    accountNonces.set(from, nonce);
    return transfer.hash;
  };
  const rebroadcast = (hash) => {
    const kept = pending.get(hash);
    if (!kept || kept.signed.content.nonce <= (accountNonces.get(kept.owner) ?? 0)) return;
    pending.delete(hash);
    apply(kept.signed);
  };
  // What demosdk signs for a storage CREATE: the node's fee and the execution edits written before the hash exists.
  const create = (writer, { logicalAddress, artifact, artifactKind }, { land = true } = {}) => {
    const owner = writer.address, programName = core.logicalToStorageProgramName(logicalAddress), nonce = Math.max(nonces.get(owner) ?? 0, accountNonces.get(owner) ?? 0) + 1;
    nonces.set(owner, nonce);
    const storageAddress = deriveStorageAddress(owner, programName, nonce, '');
    const { content } = buildStorageProgramCreatePayload({ from: owner, storageAddress, programName, logicalAddress, signedListing: clone(artifact), nonce, timestamp: now() });
    const metadata = { logicalAddress, contentHash: core.contentHash(artifact), envelopeHash: core.sha256Hex(core.canonicalize(artifact)), artifactKind };
    content.data[1].metadata = metadata;
    content.from_ed25519_address = owner;
    content.transaction_fee = { network_fee: 2, rpc_fee: 3, additional_fee: 0, rpc_address: null };
    const storageFee = Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(content.data[1].data)) / STORAGE_FEE_BYTES));
    content.gcr_edits = [{ type: 'balance', operation: 'remove', isRollback: false, account: owner, txhash: '', amount: storageFee },
      { type: 'storageProgram', target: storageAddress, isRollback: false, txhash: '', context: { operation: 'CREATE_STORAGE_PROGRAM', sender: owner, data: { variables: clone(content.data[1]), metadata: clone(metadata) } } },
      { type: 'balance', account: owner, operation: 'remove', amount: 1, txhash: '', isRollback: false }, { type: 'nonce', operation: 'add', account: owner, amount: 1, txhash: '', isRollback: false }];
    const hash = core.sha256Hex(JSON.stringify(content)), signed = { hash, content, signature: { type: 'ed25519', data: writer.signWallet(hash) } };
    pending.set(hash, { owner, signed });
    if (land) rebroadcast(hash);
    return clone(signed);
  };
  const reader = createDemosSr2Adapter({ rpcUrl: RPC_URL, journal: createInMemoryDemosSr2Journal(), fetchImpl, now });
  return { fetchImpl, reader, pay, create, apply, rebroadcast, applied, rpcUrl: RPC_URL, script, counts,
    inclusion: (hash) => { const { blockNumber } = transactions.get(hash); return { blockNumber, includedAt: blocks[blockNumber].content.timestamp * 1000 }; },
    accountNonce: (owner) => accountNonces.get(owner) ?? 0, transactionState: (hash) => (transactions.has(String(hash).toLowerCase()) ? 'applied' : 'absent'),
    blockHeight: () => blocks.length - 1, latestBlockMs: () => blocks.at(-1).content.timestamp * 1000, hasTransaction: (hash) => transactions.has(hash) };
}
