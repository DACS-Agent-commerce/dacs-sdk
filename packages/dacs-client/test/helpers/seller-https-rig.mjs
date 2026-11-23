// A loopback TLS seller and the stand-in connectors that tests hand to the seller HTTPS client.
// The TLS rig keeps Node's own request creation, TLS verification and response parsing: only the
// admitted address is mapped to the loopback server and the test CA is trusted.
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSellerHttpsConnector } from '../../src/dacs/seller-https-connector.mjs';
import { createLoopbackTestCa } from './loopback-test-ca.mjs';

export const SELLER_HOST = 'seller.example.test';
const PUBLIC_ADDRESS = '8.8.8.8';
const HOUR_MS = 3_600_000;

/**
 * Starts a TLS seller on loopback that answers each request through `respond(req, res, record)`, where
 * `record` is `{method, path, headers, body}`. Returns the origin to give the client, a real connector
 * that reaches it, and `seen` (`requests`, `connections`). Everything closes when the test ends.
 */
export async function startHttpsSeller(t, respond) {
  const root = mkdtempSync(join(tmpdir(), 'seller-https-rig-'));
  const pki = createLoopbackTestCa(root);
  const seen = { requests: [], connections: 0, sockets: new Set() };
  const server = https.createServer(pki.issue(Date.now() + HOUR_MS, { san: `DNS:${SELLER_HOST}` }), (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const record = { method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      seen.requests.push(record);
      respond(req, res, record);
    });
  });
  server.on('secureConnection', (socket) => { seen.connections++; seen.sockets.add(socket); socket.on('error', () => {}); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { seen.sockets.forEach((socket) => socket.destroy()); server.close(); rmSync(root, { recursive: true, force: true }); });
  const request = (options, callback) => https.request({ ...options, ca: pki.ca,
    lookup: (_host, lookupOptions, done) => (lookupOptions.all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4)) }, callback);
  const connector = createSellerHttpsConnector({ resolveHost: async () => [PUBLIC_ADDRESS], request });
  return { origin: `https://${SELLER_HOST}:${server.address().port}`, connector, seen };
}

/**
 * A stand-in connector that answers each send from `fetchImpl(url, {method, headers, body})`, where `body` is the
 * request text. A fetch Response becomes `{status, headers, body}` the way the real connector returns it.
 */
export const connectorFromFetch = (fetchImpl) => Object.freeze({
  async send({ origin, path, method, headers, body }) {
    const response = await fetchImpl(`${origin}${path}`, { method, headers, body: new TextDecoder().decode(body) });
    return { status: response.status, headers: Object.fromEntries(response.headers), body: new Uint8Array(await response.arrayBuffer()) };
  },
});

/**
 * Wraps `createSellerHttpsClient` so a test names its seller as `{url, fetchImpl, ...options}`: the client
 * reaches `url` through a stand-in connector that answers from `fetchImpl`.
 */
export const fetchClient = (createSellerHttpsClient) => ({ url, fetchImpl, ...options }) => createSellerHttpsClient({ publicEndpoint: url, connector: connectorFromFetch(fetchImpl), ...options });
