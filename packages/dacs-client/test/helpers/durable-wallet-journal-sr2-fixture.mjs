// Test-owned loopback native-readback fixture for the SR-2 bridge, copied from
// test/dacs-demos-sr2-wallet.test.mjs observedFixture (not exported there).
// Independent observations from accepted wire data; no real RPC or consensus.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { startAnchorFixture, FIXTURE_IDENTITY } from './dacs-storage-anchor-wallet-fixture.mjs';

const clone = (v) => structuredClone(v);
const digest = (v) => createHash('sha256').update(v).digest('hex');

export async function observedFixture() {
  const wire = await startAnchorFixture();
  const faults = { marker: true, unavailable: false };
  const native = (tx) => { const op = tx.content.data[1]; return { success: true, storageAddress: tx.content.to, owner: tx.content.from,
    programName: op.programName, data: clone(op.data), metadata: clone(op.metadata), createdByTx: tx.hash, interactionTxs: [tx.hash] }; };
  const server = http.createServer(async (req, res) => {
    const send = (status, body, marker = faults.marker) => { res.writeHead(status, { 'content-type': 'application/json', connection: 'close', ...(marker ? { 'x-dacs-simulation': 'fixture' } : {}) }); res.end(JSON.stringify(body)); };
    const envelope = (response) => ({ result: 200, response, require_reply: false, extra: null });
    try {
      if (req.method === 'GET') {
        if (faults.unavailable) return send(503, { simulated: true });
        const tx = wire.record.accepted.find((x) => `/storage-program/${x.content.to}` === req.url);
        return tx ? send(200, native(tx)) : send(404, { simulated: true });
      }
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      const call = body.params?.[0];
      if (body.method === 'nodeCall' && ['getBlockByNumber', 'getTxByHash', 'searchStoragePrograms'].includes(call.message)) {
        if (faults.unavailable) return send(503, { simulated: true });
        if (call.message === 'searchStoragePrograms') {
          const rows = wire.record.accepted.map((tx) => native(tx)).filter((n) => n.programName === call.data.query).map((n) => ({ storageAddress: n.storageAddress, programName: n.programName }));
          return send(200, envelope(rows.slice(call.data.options.offset, call.data.options.offset + call.data.options.limit)));
        }
        if (call.message === 'getTxByHash') {
          const index = wire.record.accepted.findIndex((x) => x.hash === call.data.hash);
          if (index < 0) return send(200, envelope(null));
          const tx = clone(wire.record.accepted[index]);
          tx.status = 'confirmed'; tx.blockNumber = index + 1;
          for (const k of ['amount', 'nonce', 'timestamp']) tx.content[k] = String(tx.content[k]);
          for (const k of ['network_fee', 'rpc_fee', 'additional_fee']) tx.content.transaction_fee[k] = String(tx.content.transaction_fee[k]);
          for (const e of tx.content.gcr_edits) { if (Object.hasOwn(e, 'amount')) e.amount = String(e.amount); if (e.txhash === '') e.txhash = tx.hash; }
          return send(200, envelope(tx));
        }
        if (call.data.blockNumber === 0) return send(200, envelope({ number: 0, status: 'confirmed', hash: FIXTURE_IDENTITY }));
        const number = call.data.blockNumber;
        const tx = wire.record.accepted[number - 1];
        return send(200, envelope({ number, status: 'confirmed', hash: digest(`test-block:${number}`), content: { timestamp: 1791144000 + number,
          ordered_transactions: tx ? [tx.hash] : [] }, validation_data: { simulated: true, chainIdentity: FIXTURE_IDENTITY, fixtureValidator: 'no-real-consensus' } }));
      }
      const response = await fetch(wire.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
      return send(response.status, await response.json(), response.headers.get('x-dacs-simulation') === 'fixture');
    } catch { return send(500, { error: 'test fixture unavailable' }); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, wire, faults,
    close: async () => { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); await wire.close(); } };
}
