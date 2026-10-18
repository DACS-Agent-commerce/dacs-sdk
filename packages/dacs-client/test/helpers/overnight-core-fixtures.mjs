// SIMULATED loopback fixtures for the overnight-core seller publication tests
// (test-owned; a reference for the offline fixture operator, which is owned
// elsewhere). Every response carries `x-dacs-simulation: fixture`.
//
// Chain: speaks the wire upstream @kynesyslabs/demosdk 4.0.16 sends through
// the plugin's same-origin relay and verifies what the SDK signed
// independently of the SDK and of the plugin: hash = sha256 over the exact
// JSON content, an Ed25519 signature by content.from over the UTF-8 hash hex,
// the next-nonce rule, and for a storage-program create the address the SDK
// formula gives ("stor-" + sha256(`${from}:${programName}:${nonce}:${salt}`)
// [0..40]), `to` equal to that address and no existing program there. Only
// native DEM sends and storage-program creates are simulated. A broadcast
// re-validates and then stores the program, so GET /storage-program/<addr>
// is the plugin's independent readback.
//
// Directory: the Community read endpoints plus /api/dacs/register. A
// registration whose first anchor is a storage program on the fixture chain is
// queued; indexPending() (or autoIndex) publishes its summary, built from the
// stored listing with test/fixtures/listings.mjs summaryFor, so a separate
// buyer can discover it. Not a Demos node, not a directory; test-only.
import http from 'node:http';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { summaryFor } from '../fixtures/listings.mjs';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const strip = (hex) => String(hex ?? '').toLowerCase().replace(/^0x/, '');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const HEADERS = { 'content-type': 'application/json', 'x-dacs-simulation': 'fixture' };

function ed25519Verify(publicKeyHex, message, signatureHex) {
  const raw = Buffer.from(strip(publicKeyHex), 'hex');
  const sig = Buffer.from(strip(signatureHex), 'hex');
  if (raw.length !== 32 || sig.length !== 64) return false;
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(message, 'utf8'), key, sig);
}

function send(res, status, body) {
  res.writeHead(status, HEADERS);
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closer(server) {
  return () => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

export async function startOvernightChain({ networkFee = 0, rpcFee = 0, osDenominationActivated = true } = {}) {
  const nonces = new Map();
  const storage = new Map(); // stor-… -> { data, owner, programName }
  const txs = new Map();
  const blocks = [];
  const calls = []; // 'nodeCall:<m>' | 'execute:<extra>' | 'GET <path>'
  const broadcasts = []; // every broadcastTx attempt: { hash, applied, kind }
  const faults = {
    confirmInvalid: false, // confirmTx answers valid:false
    broadcastRefuse: false, // broadcastTx answers {result:400}
    broadcastDropAfterApply: false, // applies, then drops the connection (outcome unknown to the caller)
    broadcastDropBeforeApply: false, // drops the connection without applying
  };
  let clock = Math.floor(Date.now() / 1000);

  function classify(content, from) {
    if (content.type === 'native') {
      const op = content.data?.[1];
      if (content.data?.[0] !== 'native' || op?.nativeOperation !== 'send' || !Array.isArray(op.args) || strip(op.args[0]) !== strip(content.to)) return { problem: 'only native DEM send is simulated' };
      return { kind: 'native-send' };
    }
    if (content.type === 'storageProgram') {
      const op = content.data?.[1];
      if (content.data?.[0] !== 'storageProgram' || op?.operation !== 'CREATE_STORAGE_PROGRAM') return { problem: 'only storage program create is simulated' };
      const derived = `stor-${sha256(`${from}:${op.programName}:${content.nonce}:${op.salt ?? ''}`).slice(0, 40)}`;
      if (op.storageAddress !== derived || content.to !== derived) return { problem: 'storage address is not derived from sender, program name and nonce' };
      if (storage.has(derived)) return { problem: 'a storage program already exists at this address' };
      if (op.encoding !== 'json' || !op.data || typeof op.data !== 'object') return { problem: 'only json storage programs are simulated' };
      return { kind: 'storage-create', storageAddress: derived, programName: op.programName, data: op.data };
    }
    return { problem: `transaction type ${String(content.type).slice(0, 32)} is not simulated` };
  }

  function checkSigned(tx) {
    const content = tx?.content;
    if (!content || typeof tx.hash !== 'string') return { problem: 'malformed transaction' };
    if (sha256(JSON.stringify(content)) !== tx.hash) return { problem: 'hash does not match the content' };
    if (tx.signature?.type !== 'ed25519' || !ed25519Verify(content.from, tx.hash, tx.signature.data)) return { problem: 'invalid signature' };
    if (strip(content.from_ed25519_address) !== strip(content.from)) return { problem: 'sender mismatch' };
    const from = `0x${strip(content.from)}`;
    if (content.nonce !== (nonces.get(from) ?? 0) + 1) return { problem: `nonce ${content.nonce} is not the next nonce` };
    return { from, ...classify(content, from) };
  }

  function apply(tx, checked) {
    nonces.set(checked.from, (nonces.get(checked.from) ?? 0) + 1);
    clock += 5;
    const block = { number: blocks.length, txs: [tx.hash], timestamp: clock };
    blocks.push(block);
    txs.set(tx.hash, { hash: tx.hash, content: structuredClone(tx.content), blockNumber: block.number });
    if (checked.kind === 'storage-create') storage.set(checked.storageAddress, { data: structuredClone(checked.data), owner: checked.from, programName: checked.programName });
  }

  function nodeCall(message, data) {
    switch (message) {
      case 'getNetworkInfo':
        return { network: 'overnight-core-fixture', simulated: true, forks: { osDenomination: { activated: osDenominationActivated } } };
      case 'getNetworkParameters':
        return { networkFee, rpcFee };
      case 'getAddressNonce':
        return nonces.get(`0x${strip(data.address)}`) ?? 0;
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
      if (url.pathname === '/') return send(res, 200, { result: 200, response: 'SIMULATED overnight-core fixture node' });
      return send(res, 404, { error: 'not found' });
    }
    let parsed;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { result: 400, response: 'bad json' });
    }
    const call = parsed?.params?.[0];
    if (parsed?.method === 'gcr_routine') {
      calls.push(`gcr_routine:${call?.method}`);
      if (call?.method === 'getIdentities') return send(res, 200, { result: 200, response: { xm: {}, web2: {}, ud: [], pqc: {} } });
      return send(res, 200, { result: 400, response: 'unknown routine' });
    }
    if (parsed?.method === 'execute') {
      calls.push(`execute:${call?.extra}`);
      if (call?.extra === 'confirmTx') {
        const checked = faults.confirmInvalid ? { problem: 'simulated validation refusal' } : checkSigned(call.data);
        const valid = !checked.problem;
        return send(res, 200, {
          result: 200,
          response: { data: { valid, reference_block: blocks.length, message: valid ? 'valid (SIMULATED)' : checked.problem, gas_operation: null, transaction: call.data }, signature: { type: 'ed25519', data: '0x00' }, rpc_public_key: { type: 'ed25519', data: '0x00' } },
          require_reply: false,
          extra: null,
        });
      }
      if (call?.extra === 'broadcastTx') {
        const tx = call.data?.response?.data?.transaction;
        const checked = call.data?.response?.data?.valid === true ? checkSigned(tx) : { problem: 'not validated' };
        if (faults.broadcastDropBeforeApply) {
          broadcasts.push({ hash: tx?.hash ?? null, applied: false, kind: checked.kind ?? null });
          return req.socket.destroy();
        }
        if (faults.broadcastRefuse || checked.problem) {
          broadcasts.push({ hash: tx?.hash ?? null, applied: false, kind: checked.kind ?? null });
          return send(res, 200, { result: 400, response: checked.problem ?? 'simulated broadcast refusal', require_reply: false, extra: null });
        }
        apply(tx, checked);
        broadcasts.push({ hash: tx.hash, applied: true, kind: checked.kind });
        if (faults.broadcastDropAfterApply) return req.socket.destroy();
        return send(res, 200, { result: 200, response: JSON.stringify({ message: 'recorded (SIMULATED, not settlement)', hash: tx.hash }), require_reply: false, extra: null });
      }
      return send(res, 200, { result: 400, response: 'unknown execute', require_reply: false, extra: null });
    }
    calls.push(`nodeCall:${call?.message}`);
    const response = nodeCall(call?.message, call?.data ?? {});
    if (response === undefined) return send(res, 200, { result: 400, response: 'unknown method' });
    return send(res, 200, { result: 200, response });
  });
  const port = await listen(server);

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    broadcasts,
    faults,
    nonceOf: (address) => nonces.get(`0x${strip(address)}`) ?? 0,
    txContent: (hash) => structuredClone(txs.get(strip(hash))?.content ?? null),
    storageAt: (address) => structuredClone(storage.get(address) ?? null),
    storageCount: () => storage.size,
    seedStorage(address, { data, owner, programName = 'fixture' }) {
      storage.set(address, { data: structuredClone(data), owner: owner.toLowerCase(), programName });
    },
    resetFaults() {
      for (const name of Object.keys(faults)) faults[name] = false;
    },
    close: closer(server),
  };
}

export async function startOvernightDirectory({ chain, autoIndex = false } = {}) {
  const entries = new Map(); // seller\0id\0version -> { summary, detail }
  const registrations = [];
  const pending = [];
  const key = (seller, id, version) => `${seller}\0${id}\0${version}`;
  const add = (summary, listing) => entries.set(key(summary.seller.primaryClaim, summary.listingId, summary.version), { summary, detail: structuredClone(listing) });

  function indexRegistration(body) {
    const locator = body?.listingAnchors?.[0];
    const stored = typeof locator === 'string' ? chain?.storageAt(locator) : null;
    if (!stored || stored.data?.seller?.identity?.presentedBy !== body.primaryClaim) return false;
    add(summaryFor(stored.data, locator), stored.data);
    return true;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (req.method === 'GET' && url.pathname === '/api/dacs/listings') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const seller = url.searchParams.get('primaryClaim');
      const all = [...entries.values()].map((e) => e.summary).filter((s) => (!seller || s.seller.primaryClaim === seller)
        && (!q || `${s.offering.title} ${s.offering.description}`.toLowerCase().includes(q)));
      return send(res, 200, { listings: all.slice(0, 50), total: all.length });
    }
    const detail = /^\/api\/dacs\/listings\/([^/]+)\/(\d+)$/.exec(url.pathname);
    if (req.method === 'GET' && detail) {
      const entry = entries.get(key(url.searchParams.get('seller'), decodeURIComponent(detail[1]), Number(detail[2])));
      return entry ? send(res, 200, entry.detail) : send(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && url.pathname === '/api/dacs/register') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: 'bad json' });
      }
      registrations.push(body);
      if (autoIndex) indexRegistration(body);
      else pending.push(body);
      return send(res, 200, { ok: true, ownerVerified: true, queued: true, note: 'SIMULATED overnight-core directory' });
    }
    return send(res, 404, { error: 'not found' });
  });
  const port = await listen(server);

  return {
    url: `http://127.0.0.1:${port}`,
    registrations,
    add,
    // Index every queued registration whose anchor is on the fixture chain.
    indexPending() {
      let indexed = 0;
      while (pending.length) if (indexRegistration(pending.shift())) indexed += 1;
      return indexed;
    },
    get listingCount() {
      return entries.size;
    },
    close: closer(server),
  };
}
