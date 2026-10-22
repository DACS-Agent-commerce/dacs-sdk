// Owned loopback-only acceptance fixture. CREATE uses the unchanged realistic
// normalizing SR-2 wire fixture. Native transfers share its actual nonce map
// and monotonically allocated applied-write block namespace;
// no dummy payment/receipt/approval state is planted. Only the real packaged
// SDK signs; this fixture independently checks hash, signature, nonce/debits.
import http from 'node:http';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAgreementChain } from './offline-agreement-fixture.mjs';
import { startAnchorFixture } from '../dacs-loopback-fixture.test.mjs';
import { startDirectoryFixture } from '../fixtures/directory-server.mjs';
import { CALLBACK_ORIGIN } from './harness.mjs';
import { loadConfig } from '../../src/config.mjs';
import { createApp } from '../../src/app.mjs';
import { createLogger } from '../../src/util/log.mjs';
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';

const digest = (s) => createHash('sha256').update(s).digest('hex');
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = (s) => new Promise((r) => { s.closeAllConnections(); s.close(r); });
function ed(key, message, sig) {
  try { return verify(null, Buffer.from(message), createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(key.replace(/^0x/, ''), 'hex').toString('base64url') }, format: 'jwk' }), Buffer.from(sig.replace(/^0x/, ''), 'hex')); } catch { return false; }
}
export async function startNativeAgreementChain({nativeFees=null}={}) {
  if(nativeFees&&(!Number.isSafeInteger(nativeFees.networkFee)||nativeFees.networkFee<0||!Number.isSafeInteger(nativeFees.rpcFee)||nativeFees.rpcFee<0))throw new TypeError('fixture native fees must be nonnegative integer DEM');
  const base = await startAgreementChain();
  if(nativeFees){base.wire.faults.networkFee=nativeFees.networkFee;base.wire.faults.rpcFee=nativeFees.rpcFee;}
  const networkFee=String(BigInt(nativeFees?.networkFee??2)*1_000_000_000n),rpcFee=String(BigInt(nativeFees?.rpcFee??3)*1_000_000_000n);
  const record = { confirms: [], broadcasts: [], accepted: [], auth: [], rejections: [] };
  const faults = { payment: 'ok', unavailable: false, normalizeNonce: true };
  const confirmed = new Map();
  faults.failedHashes = new Set();
  const envelope = (response) => ({ result: 200, response, require_reply: false, extra: null });
  async function nextNonce(address) {
    const r = await fetch(base.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'nodeCall', params: [{ message: 'getAddressNonce', data: { address } }] }) }).then((r) => r.json());
    return r.response + 1;
  }
  async function check(tx) {
    const c = tx?.content;
    if (!c || digest(JSON.stringify(c)) !== tx.hash || tx.signature?.type !== 'ed25519' || !ed(c.from, tx.hash, tx.signature.data) || c.from !== c.from_ed25519_address) return 'signed-hash-or-writer';
    if (c.nonce !== await nextNonce(c.from)) return 'next-shared-nonce';
    const amount = c.data?.[1]?.args?.[1], edits = c.gcr_edits;
    if (c.type !== 'native' || c.data?.[0] !== 'native' || c.data[1].nativeOperation !== 'send' || c.data[1].args.length !== 2
      || c.data[1].args[0] !== c.to || typeof amount !== 'string' || !/^[1-9][0-9]*$/.test(amount) || c.amount !== amount || c.custom_charges != null) return 'native-send-tuple';
    const expected = [['balance','remove',c.from,amount],['balance','add',c.to,amount],['balance','remove',c.from,'1000000000'],['nonce','add',c.from,1]];
    if (!Array.isArray(edits) || edits.length !== 4 || edits.some((e, i) => {
      const [type, operation, account, value] = expected[i];
      return e.type !== type || e.operation !== operation || e.account !== account || e.amount !== value || e.isRollback !== false;
    }) || c.transaction_fee.network_fee !== networkFee || c.transaction_fee.rpc_fee !== rpcFee || c.transaction_fee.additional_fee !== '0' || c.transaction_fee.rpc_address !== null) return 'exact-debit-and-fees';
    return null;
  }
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'x-dacs-simulation': 'fixture', connection: 'close' }); res.end(JSON.stringify(body)); };
    try {
      if (faults.unavailable) return send(503, { error: 'owned fixture unavailable' });
      let body = ''; for await (const chunk of req) body += chunk;
      const parsed = req.method === 'POST' ? JSON.parse(body) : null, call = parsed?.params?.[0];
      if (parsed?.method === 'execute') {
        const tx = call.extra === 'confirmTx' ? call.data : call.data?.response?.data?.transaction;
        if (tx?.content?.type === 'native') {
          const identity = req.headers.identity ?? '', timestamp = req.headers.timestamp ?? '';
          const key = /^ed25519:(0x[0-9a-f]{64})$/.exec(identity)?.[1];
          const authenticated = Boolean(key && ed(key, digest(`${identity}:${timestamp}`), req.headers.signature ?? ''));
          record.auth.push(authenticated);
          let problem = authenticated ? await check(tx) : 'SDK-request-auth';
          if (call.extra === 'confirmTx') {
            record.confirms.push(structuredClone(tx));
            if (faults.payment === 'reject-confirm') problem = 'ordinary fixture confirmation refusal';
            if (!problem) confirmed.set(tx.hash, structuredClone(tx));
            else record.rejections.push(problem);
            return send(200, envelope({ data: { valid: !problem, message: problem ?? 'SIMULATED native validation', gas_operation: null, transaction: tx }, signature: { type: 'ed25519', data: '' }, rpc_public_key: '' }));
          }
          record.broadcasts.push(tx.hash);
          if (!confirmed.has(tx.hash) || JSON.stringify(confirmed.get(tx.hash)) !== JSON.stringify(tx)) problem ??= 'not-the-confirmed-signed-transaction';
          if (problem) { record.rejections.push(problem); return send(200, { result: 400, response: problem }); }
          if (faults.payment === 'drop-before-apply') return send(503, { error: 'SIMULATED unknown before apply' });
          if (faults.payment === 'fail-execution') faults.failedHashes.add(tx.hash);
          else base.wire.setNonce(tx.content.from, tx.content.nonce);
          base.inclusion.includeApplied(tx);
          record.accepted.push(structuredClone(tx));
          if (faults.payment === 'drop-after-apply') return send(503, { error: 'SIMULATED unknown after apply' });
          return send(200, envelope({ txHash: tx.hash, message: 'SIMULATED native accepted' }));
        }
      }
      if (parsed?.method === 'nodeCall') {
        const index = record.accepted.findIndex((tx) => tx.hash === call.data.hash);
        if (call.message === 'getTransactionStatus') return send(200, envelope(index >= 0 ? { state: 'included', blockNumber: base.inclusion.numberFor(call.data.hash) } : { state: 'not-found' }));
        if (call.message === 'getTxByHash' && index >= 0) {
          const tx = structuredClone(record.accepted[index]); tx.status = faults.failedHashes.has(tx.hash) ? 'failed' : 'confirmed'; tx.blockNumber = base.inclusion.numberFor(tx.hash);
          if (faults.normalizeNonce) tx.content.nonce = String(tx.content.nonce);
          tx.content.timestamp = String(tx.content.timestamp);
          return send(200, envelope(tx));
        }
      }
      const upstream = await fetch(`${base.url}${req.url}`, { method: req.method, headers: { 'content-type': 'application/json', ...(req.headers.identity ? { identity: req.headers.identity, timestamp: req.headers.timestamp, signature: req.headers.signature } : {}) }, ...(req.method === 'POST' ? { body } : {}) });
      const response = await upstream.json();
      if (call?.message === 'getAddressNonce' && faults.nonceObject) response.response = { nonce: response.response };
      return send(upstream.status, response);
    } catch (error) { return send(500, { error: String(error.message).slice(0, 200) }); }
  });
  const port = await listen(server);
  return { ...base, url: `http://127.0.0.1:${port}`, record, paymentFaults: faults, close: async () => { await close(server); await base.close(); } };
}

export async function startNativeAgreementHarness({ enabled = true, now = () => Date.now(), maxUnpaid = '1', readbackCache = '0', env = {}, commitOnSignature = false } = {}) {
  const chain = await startNativeAgreementChain(), directory = await startDirectoryFixture(), anchors = await startAnchorFixture({ clock: now });
  const endpoints = new Map(), closers = [], logs = [], dataDir = mkdtempSync(join(tmpdir(), 'dacs-native-'));
  const journalPath = join(dataDir, 'public-journal.sqlite');
  let journal = openDurableWalletJournal({ path: journalPath, mode: 'create' }), journalId = journal.journalId;
  const server = http.createServer(), origin = `http://127.0.0.1:${await listen(server)}`;
  const config = loadConfig({ DACS_COMMIT_ON_SIGNATURE: commitOnSignature ? 'on' : 'off', DACS_PUBLIC_ORIGIN: origin, DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_OAUTH_COOKIE_KEYS: randomBytes(32).toString('hex'), DACS_DATA_DIR: dataDir,
    DACS_READBACK_CACHE: readbackCache, DACS_DIRECTORY_ORIGIN: directory.url, DACS_CHAIN_RPC_URL: chain.url, DACS_ALLOWED_REDIRECT_ORIGINS: CALLBACK_ORIGIN, DACS_LOG_LEVEL: 'debug', DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback', DACS_MAX_UNPAID_PURCHASES_PER_ACCOUNT: maxUnpaid, DACS_MAX_UNPAID_PURCHASES_PER_WALLET: maxUnpaid, ...env });
  let active = enabled, restarts = 0;
  const build = () => createApp({ config, now, logger: createLogger({ level: 'debug', sink: (line) => logs.push(line) }), dacsProtocol: { anchorUrl: anchors.url,
    sellerEndpoint: (claim) => endpoints.get(claim) ?? null, browserAgreement: { journal }, sellerSr2Commitment: { commitmentSubstrate: 'fixture', publicProjection: true }, ...(active ? { nativeAgreementPayment: { enabled: true } } : {}) } });
  let app = await build(); server.on('request', (req, res) => app.app(req, res));
  return { origin, mcpUrl: `${origin}/mcp`, chain, sellerChainUrl: chain.url, directory, anchors, endpoints, config, logs, dataDir,
    get app() { return app; }, get journal() { return journal; }, restarts: () => restarts, onClose: (fn) => closers.push(fn),
    async restart({ enabled = active } = {}) { await app.close(); journal.close(); journal = openDurableWalletJournal({ path: journalPath, mode: 'open', expectedJournalId: journalId }); active = enabled; app = await build(); restarts += 1; },
    async close() { await close(server); await app.close(); journal.close(); for (const fn of closers.reverse()) await fn(); await anchors.close(); await chain.close(); await directory.close(); rmSync(dataDir, { recursive: true }); } };
}
