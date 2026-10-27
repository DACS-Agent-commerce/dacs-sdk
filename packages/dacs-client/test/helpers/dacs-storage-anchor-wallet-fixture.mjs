// Test-owned SDK-wire fixture. Independent hash/signature/debit checks; no
// real RPC, keys on disk, funds, finality, DACS receipt or consensus claim.
import http from 'node:http';
import { createHash, createPublicKey, verify } from 'node:crypto';

export const FIXTURE_IDENTITY = '834375ad6381d9eedbaea18bfe841416fe680e00fa74b09ab711fde45d08e8e2';
export const digest = (s) => createHash('sha256').update(s).digest('hex');
const clone = (v) => structuredClone(v);
const os = (v, postFork) => postFork ? BigInt(v) : BigInt(v) * 1000000000n;
const addressFrom = (address, name, nonce) => `stor-${digest(`${address}:${name}:${nonce}:`).slice(0, 40)}`;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function memoryAnchorJournal(initial = []) {
  const records = new Map(initial);
  const tails = new Map();
  return {
    get: (key) => clone(records.get(key)),
    put: (key, value) => records.set(key, clone(value)),
    snapshot: () => clone([...records]),
    async withWalletLock(key, work) {
      const previous = tails.get(key) ?? Promise.resolve();
      let unlock;
      const next = new Promise((resolve) => { unlock = resolve; });
      tails.set(key, next);
      await previous;
      try { return await work(); } finally { unlock(); if (tails.get(key) === next) tails.delete(key); }
    },
  };
}

export function anchorRequest(address, network, { artifact, artifactKind, logicalAddress = 'dacs3:agreement:offline-sr2-job', nonce = 1 } = {}) {
  // Independently written fixture expectations; this intentionally does not
  // import the wallet's plan/hash/address functions or DACS SDK helpers.
  const value = artifact ?? { artifactType: 'Agreement', jobId: 'offline-sr2-job', signatures: [{ opaque: 'scope-carrier' }], terms: { amount: '2.5', currency: 'DEM' } };
  const canonical = (v) => v === null || typeof v !== 'object' ? JSON.stringify(typeof v === 'string' ? v.normalize('NFC') : v)
    : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  const contentHash = digest(canonical(Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'signature' && k !== 'signatures'))));
  const envelopeHash = digest(canonical(value));
  const programName = logicalAddress.replaceAll(':', '%3A');
  const storageAddress = addressFrom(address, programName, nonce);
  return {
    kind: 'dacs-storage-anchor-create', profile: 'simulated-loopback', network, owner: `did:demos:agent:${address.slice(2)}`,
    artifactKind: artifactKind ?? value.artifactType, jobId: value.jobId, logicalAddress, contentHash, envelopeHash,
    transaction: { content: { type: 'storageProgram', from: address, to: storageAddress, amount: 0,
      data: ['storageProgram', { operation: 'CREATE_STORAGE_PROGRAM', storageAddress, programName, encoding: 'json', data: value,
        metadata: { logicalAddress, contentHash, envelopeHash, ...(artifactKind !== undefined ? { artifactKind } : {}) }, acl: { mode: 'public' }, salt: '', storageLocation: 'onchain' }],
      nonce, timestamp: 1791144000000, network, chainIdentity: FIXTURE_IDENTITY,
      transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0, rpc_address: null } },
      signature: null, hash: '', status: '', blockNumber: null },
  };
}

export async function startAnchorFixture({ postFork = true, networkFee = 2, rpcFee = 3 } = {}) {
  const nonces = new Map();
  const programs = new Map();
  const confirmed = new Map();
  const record = { calls: [], confirms: [], broadcastAttempts: [], accepted: [] };
  const faults = { networkFee, rpcFee, postFork, chainIdentity: FIXTURE_IDENTITY, simulated: true, marker: true,
    confirmation: null, dropAfterApply: false, beforeNetworkParameters: null };
  function signatureValid(tx) {
    try {
      const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(tx.content.from.slice(2), 'hex').toString('base64url') }, format: 'jwk' });
      return verify(null, Buffer.from(tx.hash), key, Buffer.from(tx.signature.data.replace(/^0x/, ''), 'hex'));
    } catch { return false; }
  }
  function projected(content, txHash) {
    const c = clone(content);
    for (const k of ['amount', 'nonce', 'timestamp']) c[k] = String(c[k]);
    for (const k of ['network_fee', 'rpc_fee', 'additional_fee']) c.transaction_fee[k] = String(c.transaction_fee[k]);
    for (const edit of c.gcr_edits) {
      if (Object.hasOwn(edit, 'amount')) edit.amount = String(edit.amount);
      if (edit.txhash === '' || edit.txhash === txHash) edit.txhash = '<expected-execution-hash>';
    }
    return c;
  }
  function check(tx, signed = tx) {
    const c = tx?.content;
    const op = c?.data?.[1];
    if (!c || tx.hash !== digest(JSON.stringify(signed.content)) || !signatureValid(signed) || c.from !== c.from_ed25519_address
      || !equal(tx.signature, signed.signature) || !equal(projected(c, tx.hash), projected(signed.content, signed.hash))) return 'signature/projection';
    if (Number(c.nonce) !== (nonces.get(c.from) ?? 0) + 1) return 'nonce';
    if (c.type !== 'storageProgram' || c.data[0] !== 'storageProgram' || op?.operation !== 'CREATE_STORAGE_PROGRAM' || op.encoding !== 'json'
      || c.to !== op.storageAddress || c.to !== addressFrom(c.from, op.programName, c.nonce) || programs.has(c.to)) return 'immutable-create';
    const edits = c.gcr_edits;
    const storageFee = BigInt(Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(op.data)) / 10240))) * 1000000000n;
    if (!Array.isArray(edits) || edits.length !== 4 || edits[0].type !== 'balance' || edits[0].operation !== 'remove' || os(edits[0].amount, postFork) !== storageFee
      || edits[1].type !== 'storageProgram' || !equal(edits[1].context.data.variables, op) || !equal(edits[1].context.data.metadata, op.metadata)
      || edits[2].type !== 'balance' || edits[2].operation !== 'remove' || os(edits[2].amount, postFork) !== 1000000000n
      || edits[3].type !== 'nonce' || edits[3].operation !== 'add' || Number(edits[3].amount) !== 1
      || [edits[0], edits[2], edits[3]].some((e) => e.account !== c.from || e.isRollback !== false)
      || os(c.transaction_fee.network_fee, postFork) !== BigInt(faults.networkFee) * 1000000000n
      || os(c.transaction_fee.rpc_fee, postFork) !== BigInt(faults.rpcFee) * 1000000000n || os(c.transaction_fee.additional_fee, postFork) !== 0n) return 'debit';
    return null;
  }
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close', ...(faults.marker ? { 'x-dacs-simulation': 'fixture' } : {}) });
      res.end(JSON.stringify(body));
    };
    const envelope = (response) => ({ result: 200, response, require_reply: false, extra: null });
    if (req.method === 'GET') return send(200, envelope({ simulated: true }));
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    const call = parsed.params?.[0];
    record.calls.push(`${parsed.method}:${call?.message ?? call?.extra}`);
    if (parsed.method === 'nodeCall') {
      if (call.message === 'getAddressInfo') return send(200, envelope({ balance: '1000000000000' }));
      if (call.message === 'getAddressNonce') return send(200, envelope(nonces.get(call.data.address) ?? 0));
      if (call.message === 'getNetworkInfo') return send(200, envelope({ simulated: faults.simulated, chainIdentity: faults.chainIdentity,
        forks: { osDenomination: { activated: faults.postFork, activationHeight: 0 } } }));
      if (call.message === 'getNetworkParameters') {
        faults.beforeNetworkParameters?.();
        return send(200, envelope({ networkFee: faults.networkFee, rpcFee: faults.rpcFee }));
      }
    }
    if (parsed.method === 'execute' && call.extra === 'confirmTx') {
      const tx = clone(call.data);
      record.confirms.push(tx);
      const problem = check(tx);
      if (problem === null) confirmed.set(tx.hash, clone(tx));
      const data = { valid: problem === null, message: problem ?? 'SIMULATED SDK-wire validation only', gas_operation: null, transaction: tx };
      const response = { data, signature: { type: 'ed25519', data: '' }, rpc_public_key: '' };
      faults.confirmation?.(response);
      return send(200, envelope(response));
    }
    if (parsed.method === 'execute' && call.extra === 'broadcastTx') {
      const tx = clone(call.data?.response?.data?.transaction);
      record.broadcastAttempts.push(tx?.hash);
      const problem = check(tx, confirmed.get(tx.hash) ?? tx);
      if (problem) return send(200, { result: 400, response: problem });
      nonces.set(tx.content.from, Number(tx.content.nonce));
      programs.set(tx.content.to, clone(tx.content.data[1]));
      record.accepted.push(tx);
      if (faults.dropAfterApply) return send(503, { error: 'SIMULATED lost response after apply' });
      return send(200, envelope({ message: 'SIMULATED accepted; no real inclusion or consensus', txHash: tx.hash }));
    }
    return send(200, { result: 400, response: 'unknown fixture call' });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, record, faults, setNonce: (a, n) => nonces.set(a, n), programs,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}
