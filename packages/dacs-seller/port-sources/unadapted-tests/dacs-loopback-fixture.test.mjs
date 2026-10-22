// SIMULATED loopback fixtures for the offline DACS purchase slice. This is a
// shared test FIXTURE module that registers no tests (it is named *.test.mjs
// only so it lives in test/ under this checkout's file-ownership rules).
//  - startAnchorFixture: a write-once SR-2 store (`x-dacs-simulation: fixture`
//    on every answer) that accepts a write only with the writer's Ed25519
//    authorization over the fixture write message and returns SDK-shaped
//    finalized receipts;
//  - startSellerFixture: the seller agent (src/dacs/seller-agent.mjs) behind
//    its HTTP adapter, with a FRESH ephemeral seller key (never a buyer key).
// Fault switches let tests make the substrate or seller unavailable, alter a
// stored artifact, or set the substrate clock.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, contentHash, createPayDemSellerObserver, storAddress } from '@kynesyslabs/dacs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { fixtureListing } from './fixtures/listings.mjs';
import { startChainFixture } from './fixtures/chain-server.mjs';
import { startDirectoryFixture } from './fixtures/directory-server.mjs';
import { CALLBACK_ORIGIN } from './helpers/harness.mjs';
import { seedSellerListing } from './helpers/flows.mjs';
import { loadConfig } from '../src/config.mjs';
import { createApp } from '../src/app.mjs';
import { createLogger } from '../src/util/log.mjs';
import { anchorWriteMessage, canonicalSignature, createFixtureAnchorClient, fixtureWriteHash, FIXTURE_FINALITY, FIXTURE_SUBSTRATE } from '../src/dacs/fixture-anchors.mjs';
import { verifyDemosSignature, addressForClaim } from '../src/wallet/demos-signature.mjs';
import { createSellerAgent } from '../src/dacs/seller-agent.mjs';
import { createSellerHttpHandler } from '../src/dacs/seller-http.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function closer(server) {
  return () => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
}

export async function startAnchorFixture({ clock = () => Date.now() } = {}) {
  const records = new Map();
  const faults = { unavailable: false, unmarked: false, alter: new Map(), writes: [], clock };
  let height = 0;
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', ...(faults.unmarked ? {} : { 'x-dacs-simulation': 'fixture' }) });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    if (faults.unavailable) return send(res, 503, { error: 'unavailable' });
    const url = new URL(req.url, 'http://sr2');
    if (url.pathname !== '/sr2/records') return send(res, 404, { error: 'not_found' });
    if (req.method === 'GET') {
      const address = url.searchParams.get('address');
      const record = records.get(address);
      if (!record) return send(res, 404, { status: 'absent' });
      const artifact = faults.alter.has(address) ? faults.alter.get(address)(structuredClone(record.artifact)) : record.artifact;
      return send(res, 200, { status: 'present', artifact, receipt: record.receipt });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    let text = '';
    for await (const chunk of req) text += chunk;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return send(res, 400, { error: 'bad_json' });
    }
    const { logicalAddress, artifact, writer, writerSignature } = body ?? {};
    if (typeof logicalAddress !== 'string' || !artifact || typeof artifact !== 'object') return send(res, 400, { error: 'bad_write' });
    const hash = contentHash(artifact);
    let address;
    try {
      address = addressForClaim(writer);
    } catch {
      return send(res, 400, { error: 'bad_writer' });
    }
    let signature;
    try {
      signature = canonicalSignature(writerSignature);
    } catch {
      return send(res, 400, { error: 'writer_signature_invalid' });
    }
    if (!verifyDemosSignature({ address, message: anchorWriteMessage(logicalAddress, hash), signature: `0x${Buffer.from(signature, 'base64url').toString('hex')}` })) {
      return send(res, 400, { error: 'writer_signature_invalid' });
    }
    const existing = records.get(logicalAddress);
    if (existing) {
      if (canonicalize(existing.artifact) === canonicalize(artifact) && existing.receipt.writer === writer) return send(res, 200, { receipt: existing.receipt });
      return send(res, 409, { error: 'address_occupied' });
    }
    height += 1;
    const ts = faults.clock();
    const receipt = {
      receiptVersion: '1',
      substrate: FIXTURE_SUBSTRATE,
      finalityProfile: FIXTURE_FINALITY,
      logicalAddress,
      nativeAddress: storAddress(logicalAddress),
      contentHash: hash,
      transactionRef: { kind: 'fixture-sr2-write', value: fixtureWriteHash({ logicalAddress, contentHash: hash, writer, writerSignature: signature }) },
      writer,
      state: 'finalized',
      observationDisposition: 'established',
      observedAt: ts,
      blockRef: { id: `fixture-block-${height}`, height: String(height), timestamp: ts },
      evidence: { kind: 'fixture-writer-signature', value: signature },
    };
    records.set(logicalAddress, { artifact: structuredClone(artifact), receipt });
    faults.writes.push({ logicalAddress, writer });
    return send(res, 200, { receipt });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, records, faults, close: closer(server) };
}

// Seller agent + its loopback HTTP endpoint, observing payments on `chainUrl`
// through the SDK's read-only pay-dem observer.
export async function startSellerFixture({ anchorUrl, chainUrl, listingOptions = {}, sellerWallet = createEphemeralWallet(), listing: given, now } = {}) {
  const listing = given ?? fixtureListing(sellerWallet, { listingId: 'dacs-e2e-report', price: '2.5', ...listingOptions });
  const observer = createPayDemSellerObserver({ rpc: chainUrl, timeoutMs: 5000 });
  const state = { unavailable: false, failPaths: new Set(), requests: [] };
  const agent = await createSellerAgent({
    signer: { claim: sellerWallet.claim, sign: (bytes) => sellerWallet.signBytes(bytes) },
    listing,
    anchors: createFixtureAnchorClient({ url: anchorUrl }),
    observeDemosTransfer: (hash) => observer.observeDemosTransfer(hash),
    ...(now ? { now } : {}),
  });
  const handler = createSellerHttpHandler(agent);
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://seller').pathname;
    state.requests.push(path);
    if (state.unavailable || state.failPaths.has(path)) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end('{"error":"unavailable"}');
    }
    return handler(req, res);
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, agent, listing, wallet: sellerWallet, state, close: closer(server) };
}

// The real plugin app (as test/helpers/harness.mjs starts it) with DACS
// protocol purchases enabled against the fixture substrate and a seller
// endpoint map. Same shape as the shared harness for the OAuth/MCP helpers.
// `now` (optional) is the plugin clock; the SR-2 fixture uses it too.
export async function startProtocolHarness({ chain: givenChain, env = {}, now, walletAgreement, browserAgreement, demDeliveryContext, planWaitMs, fetchImpl, chainIdentityPin } = {}) {
  const chain = givenChain ?? (await startChainFixture());
  const directory = await startDirectoryFixture();
  const anchors = await startAnchorFixture(now ? { clock: now } : {});
  const endpoints = new Map();
  const dataDir = mkdtempSync(join(tmpdir(), 'dacs-chatgpt-dacs-'));
  const server = http.createServer();
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  const loadedConfig = loadConfig({
    DACS_PUBLIC_ORIGIN: origin,
    DACS_ALLOW_INSECURE_LOCALHOST: '1',
    DACS_OAUTH_COOKIE_KEYS: randomBytes(32).toString('hex'),
    DACS_DATA_DIR: dataDir,
    DACS_DIRECTORY_ORIGIN: directory.url,
    DACS_CHAIN_RPC_URL: chain.url,
    DACS_ALLOWED_REDIRECT_ORIGINS: CALLBACK_ORIGIN,
    DACS_LOG_LEVEL: 'debug',
    ...env,
  });
  const config = chainIdentityPin ? Object.freeze({ ...loadedConfig, chain: Object.freeze({ ...loadedConfig.chain, pinnedIdentity: chainIdentityPin }) }) : loadedConfig;
  const logs = [];
  const created = await createApp({
    config,
    ...(fetchImpl ? { fetchImpl } : {}),
    logger: createLogger({ level: 'debug', sink: (line) => logs.push(line) }),
    dacsProtocol: { anchorUrl: anchors.url, sellerEndpoint: (claim) => endpoints.get(claim) ?? null, ...(walletAgreement ? { walletAgreement } : {}), ...(browserAgreement ? { browserAgreement } : {}), ...(demDeliveryContext ? { demDeliveryContext } : {}), ...(planWaitMs ? { planWaitMs } : {}) },
    ...(now ? { now } : {}),
  });
  server.on('request', created.app);
  const sellers = [];
  const h = {
    origin,
    mcpUrl: `${origin}/mcp`,
    chain,
    directory,
    anchors,
    endpoints,
    config,
    app: created,
    logs,
    sellers,
    async close() {
      await closer(server)();
      await created.close();
      for (const s of sellers) await s.close();
      await anchors.close();
      await chain.close();
      await directory.close();
      rmSync(dataDir, { recursive: true });
    },
  };
  return h;
}

// Publish a Listing (chain storage + directory) and run its seller agent.
// `listingNow` backdates the Listing's validity window; `now` is the agent clock.
export async function addSeller(h, { listingId = 'dacs-e2e-report', price = '2.5', title, agentListing, sellerWallet = createEphemeralWallet(), now, listingNow } = {}) {
  const backdated = listingNow ? { now: listingNow, summary: { observedAt: new Date(listingNow).toISOString() } } : {};
  const { listing } = seedSellerListing(h, sellerWallet, { listingId, price, ...(title !== undefined ? { title } : {}), ...backdated });
  const seller = await startSellerFixture({ anchorUrl: h.anchors.url, chainUrl: h.chain.url, sellerWallet, listing: agentListing?.(listing, sellerWallet) ?? listing, ...(now ? { now } : {}) });
  h.endpoints.set(sellerWallet.claim, seller.url);
  h.sellers.push(seller);
  return { ...seller, published: listing };
}
