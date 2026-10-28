// TEST-ONLY harness for the seller SR-2 Agreement consumer
// (src/dacs/seller-sr2-agreement-consumer.mjs). The actual plugin app with the
// loopback browser broker and, optionally, the programmatic
// `sellerSr2Commitment` capability; the SR-2 SDK-wire fixture chain; the
// SIMULATED fixture substrate; and a seller built from the actual
// createSellerAgent behind the existing seller HTTP handler on its own
// loopback origin. `restart()` rebuilds the seller agent over its durable
// directory behind the same origin. Every observation is simulated.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAnchorFixture } from '../dacs-loopback-fixture.test.mjs';
import { startDirectoryFixture } from '../fixtures/directory-server.mjs';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';
import { startAgreementChain } from './offline-agreement-fixture.mjs';
import { CALLBACK_ORIGIN } from './harness.mjs';
import { seedSellerListing } from './flows.mjs';
import { loadConfig } from '../../src/config.mjs';
import { createApp } from '../../src/app.mjs';
import { createLogger } from '../../src/util/log.mjs';
import { createSellerAgent } from '../../src/dacs/seller-agent.mjs';
import { createSellerHttpHandler } from '../../src/dacs/seller-http.mjs';
import { createFixtureAnchorClient } from '../../src/dacs/fixture-anchors.mjs';
import { createSellerSr2AgreementAnchor } from '../../src/dacs/seller-sr2-agreement-consumer.mjs';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const closer = (server) => () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

// IDEALIZED seller-only RPC view (test-only, `exactContentNode: true`): answers
// getTxByHash with the accepted transaction exactly as the buyer signed it
// instead of the wire-normalized executed content the agreement chain fixture
// returns (string nonce/timestamp/amounts); everything else is forwarded. It
// stands in for the MISSING upstream conveyance of the buyer's public signed
// projection to the seller. The buyer and plugin keep the realistic
// normalizing node, under which a third-party SR-2 read cannot authenticate.
async function exactContentFront(chain) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const send = (status, payload, marker) => { res.writeHead(status, { 'content-type': 'application/json', connection: 'close', ...(marker ? { 'x-dacs-simulation': marker } : {}) }); res.end(payload); };
    try {
      const parsed = req.method === 'POST' ? JSON.parse(body) : null;
      const call = parsed?.params?.[0];
      if (parsed?.method === 'nodeCall' && call?.message === 'getTxByHash' && !chain.faults.unavailable) {
        const index = chain.wire.record.accepted.findIndex((x) => x.hash === call.data.hash);
        if (index >= 0) {
          const tx = structuredClone(chain.wire.record.accepted[index]);
          tx.status = 'confirmed'; tx.blockNumber = index + 1;
          return send(200, JSON.stringify({ result: 200, response: tx, require_reply: false, extra: null }), 'fixture');
        }
      }
      const upstream = await fetch(`${chain.url}${req.url}`, { method: req.method, headers: { 'content-type': 'application/json' }, ...(req.method === 'POST' ? { body } : {}) });
      return send(upstream.status, await upstream.text(), upstream.headers.get('x-dacs-simulation'));
    } catch { return send(500, '{"error":"fixture unavailable"}', 'fixture'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: closer(server) };
}

export async function startSr2Harness({ sellerSr2Commitment = { commitmentSubstrate: 'fixture' }, journal, exactContentNode = false } = {}) {
  const chain = await startAgreementChain();
  const front = exactContentNode ? await exactContentFront(chain) : null;
  const directory = await startDirectoryFixture();
  const anchors = await startAnchorFixture();
  const endpoints = new Map();
  const dataDir = mkdtempSync(join(tmpdir(), 'dacs-seller-sr2-'));
  const server = http.createServer();
  const origin = `http://127.0.0.1:${await listen(server)}`;
  const config = loadConfig({
    DACS_PUBLIC_ORIGIN: origin, DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_OAUTH_COOKIE_KEYS: randomBytes(32).toString('hex'),
    DACS_DATA_DIR: dataDir, DACS_DIRECTORY_ORIGIN: directory.url, DACS_CHAIN_RPC_URL: chain.url, DACS_ALLOWED_REDIRECT_ORIGINS: CALLBACK_ORIGIN,
    DACS_LOG_LEVEL: 'debug', DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback',
  });
  const logs = [];
  let app;
  try {
    app = await createApp({ config, logger: createLogger({ level: 'debug', sink: (line) => logs.push(line) }),
      dacsProtocol: { anchorUrl: anchors.url, sellerEndpoint: (claim) => endpoints.get(claim) ?? null, browserAgreement: { journal },
        ...(sellerSr2Commitment ? { sellerSr2Commitment } : {}) } });
  } catch (error) {
    await closer(server)(); await anchors.close(); await chain.close(); await directory.close(); rmSync(dataDir, { recursive: true });
    throw error;
  }
  server.on('request', app.app);
  const closers = [];
  return { origin, mcpUrl: `${origin}/mcp`, chain, sellerChainUrl: front?.url ?? chain.url, directory, anchors, endpoints, config, app, logs, dataDir, onClose: (fn) => closers.push(fn),
    async close() {
      await closer(server)(); await app.close();
      for (const fn of closers.reverse()) await fn();
      await front?.close();
      await anchors.close(); await chain.close(); await directory.close(); rmSync(dataDir, { recursive: true });
    } };
}

// `sr2Reader: false` builds the seller exactly as before (fixture Agreement
// read). `durable: true` keeps seller state in a directory so restart() can
// rebuild the agent from it.
export async function startSr2Seller(h, { listingId, sr2Reader = true, durable = false, onSign = () => {} } = {}) {
  const wallet = createEphemeralWallet();
  const { listing } = seedSellerListing(h, wallet, { listingId });
  const durableDirectory = durable ? join(mkdtempSync(join(tmpdir(), 'dacs-seller-sr2-state-')), 'seller') : undefined;
  const requests = [];
  const anchorWrites = [];
  const anchorClient = createFixtureAnchorClient({ url: h.anchors.url });
  const build = async () => createSellerAgent({
    signer: { claim: wallet.claim, sign: (bytes) => { onSign(bytes); return wallet.signBytes(bytes); } },
    listing,
    commitOnSignature: h.config.commitOnSignature ?? false,
    anchors: { ...anchorClient, write: (input) => { anchorWrites.push(input.logicalAddress); return anchorClient.write(input); } },
    observeDemosTransfer: async () => ({ status: 'unavailable', reason: 'payment is held in this slice' }),
    ...(sr2Reader ? { agreementAnchor: createSellerSr2AgreementAnchor({ rpcUrl: h.sellerChainUrl }) } : {}),
    ...(durableDirectory ? { durableDirectory } : {}),
  });
  let agent = await build();
  const handlerOptions = { commitOnSignature: h.config.commitOnSignature ?? false };
  let handler = createSellerHttpHandler(agent, handlerOptions);
  const server = http.createServer((req, res) => { requests.push(new URL(req.url, 'http://seller').pathname); return handler(req, res); });
  const origin = `http://127.0.0.1:${await listen(server)}`;
  h.endpoints.set(wallet.claim, origin);
  let restarts = 0;
  h.onClose(async () => { await closer(server)(); agent.close?.(); if (durableDirectory) rmSync(join(durableDirectory, '..'), { recursive: true, force: true }); });
  return { wallet, listing, origin, requests, anchorWrites, get agent() { return agent; }, restarts: () => restarts,
    async restart() { agent.close?.(); agent = await build(); handler = createSellerHttpHandler(agent, handlerOptions); restarts += 1; } };
}
