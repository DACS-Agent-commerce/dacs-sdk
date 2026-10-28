// Independent offline wire observations for the actual packaged wallet's
// complete Agreement CREATE. Ordinary Listing discovery remains a fixture.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { startAnchorFixture, FIXTURE_IDENTITY } from './dacs-storage-anchor-wallet-fixture.mjs';
import { startChainFixture } from '../fixtures/chain-server.mjs';
import { CookieJar, TestOAuthProvider } from './oauth.mjs';
import { CALLBACK_URL } from './harness.mjs';
import { auth } from '@modelcontextprotocol/client';

const clone = (v) => structuredClone(v);
const digest = (v) => createHash('sha256').update(v).digest('hex');
export async function startAgreementChain() {
  const wire = await startAnchorFixture();
  const listingChain = await startChainFixture();
  const faults = { native: null, unavailable: false, marker: true };
  // Share inclusion numbers across actual applied CREATEs/native transfers.
  // The wire appends CREATEs at its apply point even if its ack is lost;
  // synchronize them before allocating a native block. No journal is seeded.
  const inclusions = new Map(), blocks = new Map();
  const include = (tx) => {
    if (!inclusions.has(tx.hash)) {
      const number = blocks.size + 1, nativeTransfer = tx.content.type === 'native';
      const block = { number, status: 'confirmed',
        hash: digest(nativeTransfer ? `native-fixture:${tx.hash}` : `agreement-fixture:${number}`),
        content: { timestamp: nativeTransfer ? Math.floor(tx.content.timestamp / 1000) : 1791144000 + number, ordered_transactions: [tx.hash] },
        validation_data: { simulated: true, chainIdentity: FIXTURE_IDENTITY, fixtureValidator: 'no-real-consensus' } };
      inclusions.set(tx.hash, number); blocks.set(number, block);
    }
    return inclusions.get(tx.hash);
  };
  const syncCreates = () => { for (const tx of wire.record.accepted) include(tx); };
  const inclusion = {
    includeApplied(tx) { syncCreates(); return include(tx); },
    numberFor(hash) { syncCreates(); return inclusions.get(hash); },
    block(number) { syncCreates(); return clone(blocks.get(number) ?? null); },
  };
  const native = (tx) => ({ success: true, storageAddress: tx.content.to, owner: tx.content.from,
    programName: tx.content.data[1].programName, data: clone(tx.content.data[1].data), metadata: clone(tx.content.data[1].metadata), createdByTx: tx.hash, interactionTxs: [tx.hash] });
  const server = http.createServer(async (req, res) => {
    const send = (status, body, marker = faults.marker) => { res.writeHead(status, { 'content-type': 'application/json', connection: 'close', ...(marker ? { 'x-dacs-simulation': 'fixture' } : {}) }); res.end(JSON.stringify(body)); };
    const envelope = (response) => ({ result: 200, response, require_reply: false, extra: null });
    try {
      if (faults.unavailable) return send(503, { simulated: true });
      if (req.method === 'GET') {
        const tx = wire.record.accepted.find((x) => `/storage-program/${x.content.to}` === req.url);
        if (tx) return send(200, faults.native ? faults.native(native(tx)) : native(tx));
        const response = await fetch(`${listingChain.url}${req.url}`);
        return send(response.status, await response.json());
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body), call = parsed.params?.[0];
      if (parsed.method === 'nodeCall' && call.message === 'searchStoragePrograms') {
        const rows = wire.record.accepted.map(native).filter((n) => n.programName === call.data.query).map((n) => ({ storageAddress: n.storageAddress, programName: n.programName }));
        return send(200, envelope(rows.slice(call.data.options.offset, call.data.options.offset + call.data.options.limit)));
      }
      if (parsed.method === 'nodeCall' && call.message === 'getTxByHash') {
        const index = wire.record.accepted.findIndex((x) => x.hash === call.data.hash);
        if (index < 0) return send(200, { result: 400, response: 'error', require_reply: false, extra: null });
        const tx = clone(wire.record.accepted[index]);
        tx.status = 'confirmed'; tx.blockNumber = inclusion.numberFor(tx.hash);
        for (const k of ['amount', 'nonce', 'timestamp']) tx.content[k] = String(tx.content[k]);
        for (const k of ['network_fee', 'rpc_fee', 'additional_fee']) tx.content.transaction_fee[k] = String(tx.content.transaction_fee[k]);
        for (const e of tx.content.gcr_edits) { if (Object.hasOwn(e, 'amount')) e.amount = String(e.amount); if (e.txhash === '') e.txhash = tx.hash; }
        return send(200, envelope(tx));
      }
      if (parsed.method === 'nodeCall' && call.message === 'getBlockByNumber') {
        const number = call.data.blockNumber;
        if (number === 0) return send(200, envelope({ number: 0, status: 'confirmed', hash: FIXTURE_IDENTITY }));
        return send(200, envelope(inclusion.block(number) ?? { number, status: 'confirmed', hash: digest(`agreement-fixture:${number}`),
          content: { timestamp: 1791144000 + number, ordered_transactions: [] },
          validation_data: { simulated: true, chainIdentity: FIXTURE_IDENTITY, fixtureValidator: 'no-real-consensus' } }));
      }
      const target = parsed.method === 'gcr_routine' ? listingChain.url : wire.url;
      const response = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      return send(response.status, await response.json(), response.headers.get('x-dacs-simulation') === 'fixture');
    } catch { return send(500, { error: 'fixture unavailable' }); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, wire, faults, inclusion,
    seedStorage: (...args) => listingChain.seedStorage(...args),
    close: async () => { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); await wire.close(); await listingChain.close(); } };
}

// Real OAuth/MCP contracts, with async signatures from the actual packaged
// wallet. The test-owned approval callback is simulated human consent.
export async function linkPackagedWallet(h, wallet) {
  const scope = 'dacs.account.read dacs.agents.write dacs.purchases.write';
  const provider = new TestOAuthProvider({ scope });
  const jar = new CookieJar();
  async function follow(url) {
    let current = new URL(url);
    for (let n = 0; n < 10; n++) {
      const r = await fetch(current, { redirect: 'manual', headers: { cookie: jar.header(current) } });
      jar.store(r);
      const location = r.headers.get('location');
      await r.body?.cancel();
      if (!location) return current;
      current = new URL(location, current);
      if (current.href.startsWith(CALLBACK_URL)) return current;
    }
    throw new Error('fixture OAuth redirect bound');
  }
  async function portal(path, body) {
    const r = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: jar.header(`${h.origin}${path}`) }, body: JSON.stringify(body) });
    jar.store(r); const data = await r.json();
    if (!r.ok) throw new Error(`fixture OAuth: ${data.error}`);
    return data;
  }
  if (await auth(provider, { serverUrl: h.mcpUrl, scope }) !== 'REDIRECT') throw new Error('fixture OAuth expected redirect');
  const start = await follow(provider.authorizationUrl);
  const uid = /\/portal\/authorize\/([^/?#]+)/.exec(start.pathname)?.[1];
  const challenge = await portal(`/portal/authorize/${uid}/api/challenge`, { address: wallet.getPublicAccount().address });
  const signed = await wallet.request({ method: 'sign', params: [challenge.message] });
  if (!signed.success) throw new Error(`fixture wallet signature: ${signed.error.code}`);
  const done = await portal(`/portal/authorize/${uid}/api/complete`, { challengeId: challenge.challengeId, signature: signed.data.signature });
  const callback = await follow(done.redirectTo);
  if (await auth(provider, { serverUrl: h.mcpUrl, authorizationCode: callback.searchParams.get('code'), iss: callback.searchParams.get('iss'), scope }) !== 'AUTHORIZED') throw new Error('fixture OAuth expected authorization');
  return { provider };
}
