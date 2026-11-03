// SIMULATED Demos RPC for local tests. Every response carries
// `x-dacs-simulation: fixture` so the plugin labels evidence as simulated.
// Implements only the read surface the plugin uses plus a test-only
// "wallet broadcast" entry point that applies Demos-like nonce rules.
// It is written independently of the plugin's payload builders: it accepts any
// transaction body and records exactly what was submitted.
import http from 'node:http';
import { createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export async function startChainFixture() {
  const nonces = new Map();
  const storage = new Map();
  const txs = new Map();
  const blocks = [];
  // address -> { web2: {<context>: [entry]}, xm: {<chain>: {<subchain>: [entry]}} },
  // shaped like demosdk 4.0.12's Web2Identities / XMIdentities.
  const identities = new Map();
  const balances = new Map();
  const faults = { unavailable: false, pendingHashes: new Set(), alterStorage: new Map(), rpcCalls: [], failTxBodyAfter: new Map() }; // hash -> successful body reads allowed before failing
  let clock = Math.floor(Date.now() / 1000);

  function send(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json', 'x-dacs-simulation': 'fixture' });
    res.end(JSON.stringify(body));
  }

  function nodeCall(message, data) {
    faults.rpcCalls.push(message);
    switch (message) {
      case 'getAddressInfo':
        return { balance: balances.has(String(data.address).toLowerCase()) ? balances.get(String(data.address).toLowerCase()) : '1000000000000' };
      case 'getNetworkParameters':
        return faults.fees ?? { networkFee: 1, rpcFee: 0 };
      case 'getAddressNonce':
        return nonces.get(String(data.address).toLowerCase()) ?? 0;
      case 'getTransactionStatus': {
        const hash = String(data.hash).toLowerCase();
        const tx = txs.get(hash);
        if (!tx) return { state: 'not-found' };
        // A node answer chosen by the test (e.g. a state the SDK does not support).
        if (faults.transactionStatus) return faults.transactionStatus(hash);
        if (faults.pendingHashes.has(hash)) return { state: 'pending' };
        return { state: tx.failed ? 'failed' : 'included', blockNumber: tx.blockNumber };
      }
      case 'getTxByHash': {
        const key = String(data.hash).toLowerCase();
        if (faults.failTxBodyAfter.has(key)) {
          const left = faults.failTxBodyAfter.get(key);
          if (left <= 0) throw new Error('simulated transient body read failure');
          faults.failTxBodyAfter.set(key, left - 1);
        }
        const tx = txs.get(String(data.hash).toLowerCase());
        if (!tx || faults.pendingHashes.has(tx.hash)) return null;
        return { hash: tx.hash, content: tx.content, status: 'confirmed', blockNumber: tx.blockNumber };
      }
      case 'getBlockByNumber': {
        const block = blocks[data.blockNumber];
        return block ? { number: block.number, status: 'confirmed', content: { ordered_transactions: block.txs, timestamp: block.timestamp } } : null;
      }
      default:
        return undefined;
    }
  }

  const server = http.createServer(async (req, res) => {
    if (faults.unavailable) return send(res, 503, { error: 'unavailable' });
    const url = new URL(req.url, 'http://fixture');
    const storageMatch = /^\/storage-program\/(stor-[0-9a-f]{40})$/.exec(url.pathname);
    if (req.method === 'GET' && storageMatch) {
      const entry = storage.get(storageMatch[1]);
      if (!entry) return send(res, 404, { success: false, error: 'not found' });
      const data = faults.alterStorage.get(storageMatch[1]) ?? entry.data;
      return send(res, 200, { success: true, data, owner: entry.owner, programName: entry.programName });
    }
    if (req.method === 'POST' && url.pathname === '/') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return send(res, 400, { result: 400, response: 'bad json' });
      }
      const call = parsed?.params?.[0];
      if (parsed?.method === 'gcr_routine') {
        faults.rpcCalls.push(`gcr_routine:${call?.method}`);
        const address = String(call?.params?.[0] ?? '').toLowerCase();
        const entry = identities.get(address) ?? { web2: {}, xm: {} };
        if (faults.identityEnvelope) return send(res, 200, structuredClone(faults.identityEnvelope));
        if (faults.identityResponse) return send(res, 200, { result: 200, response: structuredClone(faults.identityResponse) });
        // Unified read only, in the envelope the pinned @kynesyslabs/dacs
        // consumer projects: {result:200, response:{xm, web2, ud, pqc}}. The
        // split getWeb2Identities/getXmIdentities routines are not served.
        if (call?.method === 'getIdentities') {
          return send(res, 200, { result: 200, response: { xm: structuredClone(entry.xm), web2: structuredClone(entry.web2), ud: [], pqc: {} } });
        }
        return send(res, 200, { result: 400, response: 'unknown routine' });
      }
      let response;
      try {
        response = nodeCall(call?.message, call?.data ?? {});
      } catch {
        return send(res, 500, { result: 500, response: 'fixture fault' });
      }
      if (response === undefined) return send(res, 200, { result: 400, response: 'unknown method' });
      return send(res, 200, { result: 200, response });
    }
    send(res, 404, { error: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  // Test-only: what a wallet extension does on sendTransaction (sign + broadcast).
  // Applies the nonce rule (content.nonce must equal current nonce + 1).
  function walletBroadcast(tx, { failOnChain = false } = {}) {
    const content = structuredClone(tx.content);
    const from = String(content.from).toLowerCase();
    const current = nonces.get(from) ?? 0;
    if (content.nonce !== current + 1) throw new Error(`fixture chain rejected nonce ${content.nonce}; expected ${current + 1}`);
    content.from_ed25519_address = from;
    const hash = sha256(JSON.stringify(content));
    nonces.set(from, current + 1);
    clock += 5;
    const block = { number: blocks.length, txs: [hash], timestamp: clock };
    blocks.push(block);
    txs.set(hash, { hash, content, blockNumber: block.number, failed: failOnChain });
    if (!failOnChain && content.type === 'storageProgram') {
      const op = content.data?.[1];
      if (op?.operation === 'CREATE_STORAGE_PROGRAM' && !storage.has(op.storageAddress)) {
        storage.set(op.storageAddress, { data: structuredClone(op.data), owner: from, programName: op.programName });
      }
    }
    return hash;
  }

  // Test-only: publish a storage program directly (seed a seller listing).
  function seedStorage(address, { data, owner, programName = 'fixture' }) {
    storage.set(address, { data: structuredClone(data), owner: owner.toLowerCase(), programName });
  }

  // Test-only: seed or remove a public identity association for an address.
  function seedWeb2Identity(address, context, { username, userId = null, proof = null }) {
    const key = address.toLowerCase();
    const entry = identities.get(key) ?? { web2: {}, xm: {} };
    entry.web2[context] = [...(entry.web2[context] ?? []), { proof, userId, username, proofHash: proof ? sha256(proof) : null, timestamp: clock }];
    identities.set(key, entry);
  }
  function removeWeb2Identity(address, context, username) {
    const entry = identities.get(address.toLowerCase());
    if (entry?.web2[context]) entry.web2[context] = entry.web2[context].filter((i) => i.username.toLowerCase() !== username.toLowerCase());
  }
  function seedXmIdentity(address, chain, subchain, targetAddress) {
    const key = address.toLowerCase();
    const entry = identities.get(key) ?? { web2: {}, xm: {} };
    entry.xm[chain] ??= {};
    entry.xm[chain][subchain] = [...(entry.xm[chain][subchain] ?? []), { address: targetAddress, timestamp: clock }];
    identities.set(key, entry);
  }

  return {
    url: `http://127.0.0.1:${port}`,
    faults,
    walletBroadcast,
    // Test-only: the next mined payment must follow a finalized SR-2 write.
    advanceTo(timestampMs) {
      if (!Number.isSafeInteger(timestampMs) || timestampMs < 1e12) throw new RangeError('fixture timestamp must be epoch milliseconds (at least 1e12)');
      clock = Math.max(clock, Math.ceil(timestampMs / 1000));
    },
    seedStorage,
    seedWeb2Identity,
    removeWeb2Identity,
    seedXmIdentity,
    identities,
    nonceOf: (address) => nonces.get(address.toLowerCase()) ?? 0,
    setNonce: (address, value) => nonces.set(address.toLowerCase(), value),
    setBalance: (address, value) => balances.set(address.toLowerCase(), value),
    storage,
    txs,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
