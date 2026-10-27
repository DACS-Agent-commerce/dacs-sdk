// SIMULATED loopback Demos node for the embedded wallet transaction tests.
// Every response carries `x-dacs-simulation: fixture`. It speaks the wire the
// upstream @kynesyslabs/demosdk 4.0.16 actually sends (Demos.call ->
// {method, params:[{type, message, data, extra, ...}]}) and verifies what the
// SDK signed independently of the SDK: hash = sha256 over the exact JSON
// content bytes, an Ed25519 signature by content.from over the UTF-8 hash hex,
// the timestamped request auth header, and the next-nonce rule. It also serves
// the plugin server's own readback (getTransactionStatus, getTxByHash,
// getBlockByNumber, gcr_routine getIdentities, storage programs) and a
// GitHub-users stand-in at /\x75sers/<name>. Test-only; no real network.
import http from 'node:http';
import { createHash, createPublicKey, verify } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const strip = (hex) => String(hex ?? '').toLowerCase().replace(/^0x/, '');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

function ed25519Verify(publicKeyHex, message, signatureHex) {
  const raw = Buffer.from(strip(publicKeyHex), 'hex');
  const sig = Buffer.from(strip(signatureHex), 'hex');
  if (raw.length !== 32 || sig.length !== 64) return false;
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(message, 'utf8'), key, sig);
}

export async function startSdkChainFixture({ osDenominationActivated = true, networkFee = 1, rpcFee = 0 } = {}) {
  const nonces = new Map();
  const storage = new Map();
  const txs = new Map();
  const blocks = [];
  const identities = new Map(); // address -> { web2: {context: [entry]}, xm: {} }
  const tweets = new Map(); // tweet URL -> { username, userId }
  const githubUsers = new Map(); // lowercased login -> { login, id }
  const calls = []; // every RPC call: 'nodeCall:<message>' | 'execute:<extra>' | 'gcr_routine:<m>' | 'GET <path>'
  const auth = []; // execute calls: { identity, verified }
  const broadcasts = []; // every broadcastTx attempt: { hash, applied }
  const faults = {
    confirmInvalid: false, // confirmTx answers valid:false
    broadcastRefuse: false, // broadcastTx answers {result:400}
    broadcastDropAfterApply: false, // applies the tx, then drops the connection (outcome unknown to the caller)
    broadcastDropBeforeApply: false, // drops the connection without applying
    tweetMismatch: null, // getTweet answers this username instead
  };
  let clock = Math.floor(Date.now() / 1000);

  function send(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json', 'x-dacs-simulation': 'fixture' });
    res.end(JSON.stringify(body));
  }

  // Independent checks of a signed transaction as the SDK put it on the wire.
  function checkSigned(tx) {
    const content = tx?.content;
    if (!content || typeof tx.hash !== 'string') return 'malformed transaction';
    if (sha256(JSON.stringify(content)) !== tx.hash) return 'hash does not match the content';
    if (tx.signature?.type !== 'ed25519' || !ed25519Verify(content.from, tx.hash, tx.signature.data)) return 'invalid signature';
    if (strip(content.from_ed25519_address) !== strip(content.from)) return 'sender mismatch';
    const from = `0x${strip(content.from)}`;
    if (content.nonce !== (nonces.get(from) ?? 0) + 1) return `nonce ${content.nonce} is not the next nonce`;
    return null;
  }

  function checkAuth(headers) {
    const identity = headers.identity ?? '';
    const timestamp = headers.timestamp ?? '';
    const match = /^ed25519:(0x[0-9a-f]{64})$/i.exec(identity);
    const verified = Boolean(match && /^\d+$/.test(timestamp) && ed25519Verify(match[1], sha256(`${identity}:${timestamp}`), headers.signature));
    auth.push({ identity, verified });
    return verified;
  }

  function apply(tx) {
    const content = structuredClone(tx.content);
    const from = `0x${strip(content.from)}`;
    nonces.set(from, (nonces.get(from) ?? 0) + 1);
    clock += 5;
    const block = { number: blocks.length, txs: [tx.hash], timestamp: clock };
    blocks.push(block);
    txs.set(tx.hash, { hash: tx.hash, content, blockNumber: block.number });
    if (content.type === 'identity') {
      const op = content.data?.[1];
      const payload = op?.payload ?? {};
      const entry = identities.get(from) ?? { web2: {}, xm: {} };
      const list = entry.web2[payload.context] ?? [];
      if (op?.method === 'web2_identity_assign') {
        entry.web2[payload.context] = [...list, { proof: payload.proof, userId: payload.userId, username: payload.username, proofHash: sha256(String(payload.proof)), timestamp: content.timestamp }];
      } else if (op?.method === 'web2_identity_remove') {
        entry.web2[payload.context] = list.filter((i) => i.username.toLowerCase() !== String(payload.username).toLowerCase());
      }
      identities.set(from, entry);
    }
  }

  function nodeCall(message, data) {
    switch (message) {
      case 'getNetworkInfo':
        return { forks: { osDenomination: { activated: osDenominationActivated } } };
      case 'getNetworkParameters':
        return { networkFee, rpcFee };
      case 'getAddressNonce':
        return nonces.get(`0x${strip(data.address)}`) ?? 0;
      case 'getTweet': {
        const tweet = tweets.get(data.tweetUrl);
        if (!tweet) return { success: false, error: 'tweet not found' };
        return { success: true, tweet: { username: faults.tweetMismatch ?? tweet.username, userId: tweet.userId } };
      }
      case 'getTransactionStatus': {
        const tx = txs.get(strip(data.hash));
        return tx ? { state: 'included', blockNumber: tx.blockNumber } : { state: 'not-found' };
      }
      case 'getTxByHash': {
        const tx = txs.get(strip(data.hash));
        return tx ? { hash: tx.hash, content: tx.content, status: 'confirmed', blockNumber: tx.blockNumber } : null;
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
    const url = new URL(req.url, 'http://fixture');
    if (req.method === 'GET') {
      calls.push(`GET ${url.pathname}`);
      const storageMatch = /^\/storage-program\/(stor-[0-9a-f]{40})$/.exec(url.pathname);
      if (storageMatch) {
        const entry = storage.get(storageMatch[1]);
        return entry ? send(res, 200, { success: true, data: entry.data, owner: entry.owner, programName: entry.programName }) : send(res, 404, { success: false });
      }
      const userMatch = /^\/users\/([A-Za-z0-9-]{1,39})$/.exec(url.pathname);
      if (userMatch) {
        const user = githubUsers.get(userMatch[1].toLowerCase());
        return user ? send(res, 200, user) : send(res, 404, { message: 'Not Found' });
      }
      if (url.pathname === '/') return send(res, 200, { result: 200, response: 'simulated demos node' });
      return send(res, 404, { error: 'not found' });
    }
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
      calls.push(`gcr_routine:${call?.method}`);
      const entry = identities.get(`0x${strip(call?.params?.[0])}`) ?? { web2: {}, xm: {} };
      if (call?.method === 'getIdentities') return send(res, 200, { result: 200, response: { xm: structuredClone(entry.xm), web2: structuredClone(entry.web2), ud: [], pqc: {} } });
      return send(res, 200, { result: 400, response: 'unknown routine' });
    }
    if (parsed?.method === 'execute') {
      calls.push(`execute:${call?.extra}`);
      checkAuth({ identity: req.headers.identity, signature: req.headers.signature, timestamp: req.headers.timestamp });
      if (call?.extra === 'confirmTx') {
        const problem = faults.confirmInvalid ? 'simulated validation refusal' : checkSigned(call.data);
        const valid = problem === null;
        return send(res, 200, {
          result: 200,
          response: { data: { valid, reference_block: blocks.length, message: valid ? 'valid' : problem, gas_operation: null, transaction: call.data }, signature: { type: 'ed25519', data: '0x00' }, rpc_public_key: { type: 'ed25519', data: '0x00' } },
          require_reply: false,
          extra: null,
        });
      }
      if (call?.extra === 'broadcastTx') {
        const tx = call.data?.response?.data?.transaction;
        const problem = call.data?.response?.data?.valid === true ? checkSigned(tx) : 'not validated';
        if (faults.broadcastDropBeforeApply) {
          broadcasts.push({ hash: tx?.hash ?? null, applied: false });
          return req.socket.destroy();
        }
        if (faults.broadcastRefuse || problem) {
          broadcasts.push({ hash: tx?.hash ?? null, applied: false });
          return send(res, 200, { result: 400, response: problem ?? 'simulated broadcast refusal', require_reply: false, extra: null });
        }
        apply(tx);
        broadcasts.push({ hash: tx.hash, applied: true });
        if (faults.broadcastDropAfterApply) return req.socket.destroy();
        return send(res, 200, { result: 200, response: JSON.stringify({ message: 'transaction accepted', hash: tx.hash }), require_reply: false, extra: null });
      }
      return send(res, 200, { result: 400, response: 'unknown execute', require_reply: false, extra: null });
    }
    calls.push(`nodeCall:${call?.message}`);
    const response = nodeCall(call?.message, call?.data ?? {});
    if (response === undefined) return send(res, 200, { result: 400, response: 'unknown method' });
    return send(res, 200, { result: 200, response });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    auth,
    broadcasts,
    faults,
    txs,
    nonceOf: (address) => nonces.get(`0x${strip(address)}`) ?? 0,
    seedStorage(address, { data, owner, programName = 'fixture' }) {
      storage.set(address, { data: structuredClone(data), owner: owner.toLowerCase(), programName });
    },
    seedTweet(url, { username, userId }) {
      tweets.set(url, { username, userId });
    },
    seedGithubUser(login, id) {
      githubUsers.set(login.toLowerCase(), { login, id });
    },
    web2Of(address) {
      return structuredClone(identities.get(`0x${strip(address)}`)?.web2 ?? {});
    },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    }),
  };
}
