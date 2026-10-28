// TEST-only actual app/MCP, seller HTTP, durable seller/journal, packaged buyer
// wallet and genuine SDK intake. No live authority/finality/Vet is established.
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNativeAgreementChain } from './native-agreement-payment-harness.mjs';
import { startAnchorFixture } from '../dacs-loopback-fixture.test.mjs';
import { startDirectoryFixture } from '../fixtures/directory-server.mjs';
import { seedSellerListing } from './flows.mjs';
import { CALLBACK_ORIGIN } from './harness.mjs';
import { loadConfig } from '../../src/config.mjs';
import { createApp } from '../../src/app.mjs';
import { createLogger } from '../../src/util/log.mjs';
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';
import { createSellerAgent } from '../../src/dacs/seller-agent.mjs';
import { createSellerHttpHandler } from '../../src/dacs/seller-http.mjs';
import { createFixtureAnchorClient } from '../../src/dacs/fixture-anchors.mjs';
import { createSellerSr2AgreementAnchor } from '../../src/dacs/seller-sr2-agreement-consumer.mjs';
import { createDemosSr2WalletBridge } from '../../src/dacs/demos-sr2-wallet-bridge.mjs';
import { createNativePaymentEvidenceConsumer } from '../../src/dacs/native-payment-evidence-consumer.mjs';
import { createEphemeralPackagedSeller } from './native-settlement-consumer-seller.mjs';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = (s) => new Promise((r) => { s.closeAllConnections(); s.close(r); });
export async function startNativeEvidenceHarness({ evidenceEnabled = true, now = () => Date.now(), env = {}, sellerTransport, fetchImpl } = {}) {
  const chain = await startNativeAgreementChain(), directory = await startDirectoryFixture(), anchors = await startAnchorFixture({ clock: now });
  const endpoints = new Map(), closers = [], logs = [], dataDir = mkdtempSync(join(tmpdir(), 'native-evidence-'));
  const journalPath = join(dataDir, 'journal.sqlite');
  let journal = openDurableWalletJournal({ path: journalPath, mode: 'create' }); const journalId = journal.journalId;
  const server = http.createServer(), origin = `http://127.0.0.1:${await listen(server)}`;
  const config = loadConfig({ DACS_PUBLIC_ORIGIN: origin, DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_OAUTH_COOKIE_KEYS: randomBytes(32).toString('hex'), DACS_DATA_DIR: dataDir,
    DACS_DIRECTORY_ORIGIN: directory.url, DACS_CHAIN_RPC_URL: chain.url, DACS_ALLOWED_REDIRECT_ORIGINS: CALLBACK_ORIGIN, DACS_LOG_LEVEL: 'debug', DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback', ...env });
  const consumer = createNativePaymentEvidenceConsumer({ rpcUrl: chain.url });
  let enabled = evidenceEnabled;
  const build = () => createApp({ config, now, ...(fetchImpl?{fetchImpl}:{}), logger: createLogger({ level: 'debug', sink: (line) => logs.push(line) }), dacsProtocol: { anchorUrl: anchors.url, ...(sellerTransport?{sellerTransport}:{}),
    sellerEndpoint: (claim) => endpoints.get(claim) ?? null, browserAgreement: { journal }, sellerSr2Commitment: { commitmentSubstrate: 'fixture', publicProjection: true },
    nativeAgreementPayment: { enabled: true }, ...(enabled ? { nativePaymentEvidence: consumer } : {}) } });
  let app = await build(); server.on('request', (req, res) => app.app(req, res));
  return { origin, mcpUrl: `${origin}/mcp`, chain, sellerChainUrl: chain.url, directory, anchors, endpoints, config, logs, dataDir,
    get app() { return app; }, get journal() { return journal; }, onClose: (fn) => closers.push(fn),
    async restart({ evidenceEnabled = enabled } = {}) { await app.close(); journal.close(); journal = openDurableWalletJournal({ path: journalPath, mode: 'open', expectedJournalId: journalId }); enabled = evidenceEnabled; app = await build(); },
    async close() { await close(server); await app.close(); journal.close(); for (const fn of closers.reverse()) await fn(); await anchors.close(); await chain.close(); await directory.close(); rmSync(dataDir, { recursive: true }); } };
}

export async function startNativeEvidenceSeller(h, { listingId }) {
  // Unchanged wallet contract requires its existing literal-loopback relay,
  // not the reader's bare node origin. No provider/guard/relay edits.
  const actor = await createEphemeralPackagedSeller({rpcUrl:`${h.origin}/portal/api/wallet-rpc`,network:h.config.chain.network});
  const wallet = actor.signer, { listing } = seedSellerListing(h, wallet, { listingId });
  const dir = mkdtempSync(join(tmpdir(), 'native-evidence-seller-')), durableDirectory = join(dir, 'seller');
  const requests = [], anchorWrites = [], evidenceAttempts = [], evidenceAnswers=[], functionalErrors = [];
  const walletJournalPath=join(dir,'seller-public-wallet.sqlite');
  let walletJournal=openDurableWalletJournal({path:walletJournalPath,mode:'create'});const walletJournalId=walletJournal.journalId;
  const anchors = createFixtureAnchorClient({ url: h.anchors.url });
  let bridge=createDemosSr2WalletBridge({rpcUrl:h.chain.url,network:h.config.chain.network,journal:walletJournal,walletFactory:actor.walletFactory});
  const faults={evidenceUnknownAfterApply:false};
  const publicProjection=async({logicalAddress,writer})=>{
    const rows=await walletJournal.entries();
    const candidates=rows.filter(([key,r])=>key.startsWith('sr2/wallet/')&&r.signedTransaction?.content?.data?.[1]?.metadata?.logicalAddress===logicalAddress
      &&`did:demos:agent:${r.signedTransaction.content.from.replace(/^0x/,'')}`===writer);
    assert.ok(candidates.length<=1,'exact public seller journal scope is unique');
    return candidates[0]?structuredClone(candidates[0][1].signedTransaction):undefined;
  };
  const consumer = createNativePaymentEvidenceConsumer({ rpcUrl: h.chain.url, anchorEvidence: (input) => {
    evidenceAttempts.push(structuredClone(input));
    h.chain.wire.faults.dropAfterApply=faults.evidenceUnknownAfterApply;
    return bridge.anchor(input).then(answer=>{evidenceAnswers.push(structuredClone(answer));return answer;});
  },readSignedProjection:publicProjection });
  const build = () => createSellerAgent({ signer: { claim: wallet.claim, sign: (bytes) => wallet.signBytes(bytes) }, listing,
    anchors: { ...anchors, write: (input) => { anchorWrites.push(input.logicalAddress); return anchors.write(input); } },
    observeDemosTransfer: async () => ({ status: 'unavailable', reason: 'legacy claims not configured in this test' }),
    agreementAnchor: createSellerSr2AgreementAnchor({ rpcUrl: h.chain.url }), durableDirectory, nativePaymentEvidence: consumer });
  const handle = (agent) => createSellerHttpHandler({ ...agent, submitPayment: async (input) => {
    try { return await agent.submitPayment(input); } catch (error) { functionalErrors.push({ code:error.code, message:error.message, stack:error.stack }); throw error; }
  } });
  let agent = await build(), handler = handle(agent);
  const server = http.createServer((req, res) => { requests.push(new URL(req.url, 'http://seller').pathname); return handler(req, res); });
  const origin = `http://127.0.0.1:${await listen(server)}`; h.endpoints.set(wallet.claim, origin);
  h.onClose(async () => { await close(server); agent.close(); walletJournal.close();actor.close();rmSync(dir, { recursive: true }); });
  return { wallet, listing, origin, requests, anchorWrites, evidenceAttempts, evidenceAnswers, functionalErrors,faults,packagedWallet:actor.wallet,sellerApprovals:actor.approvals,authority:actor.authority,
    publicProjection,get walletJournal(){return walletJournal;},get agent() { return agent; },
    async restart() { agent.close();walletJournal.close();walletJournal=openDurableWalletJournal({path:walletJournalPath,mode:'open',expectedJournalId:walletJournalId});
      bridge=createDemosSr2WalletBridge({rpcUrl:h.chain.url,network:h.config.chain.network,journal:walletJournal,walletFactory:actor.walletFactory});
      agent = await build(); handler = handle(agent); } };
}
