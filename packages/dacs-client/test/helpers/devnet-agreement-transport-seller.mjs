// TEST-only seller: native Agreement read via the explicit source capability;
// seller commitment remains the existing simulated fixture substrate.
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEphemeralWallet} from '../fixtures/wallet.mjs';
import {seedSellerListing} from './flows.mjs';
import {createSellerAgent} from '../../src/dacs/seller-agent.mjs';
import {createSellerHttpHandler} from '../../src/dacs/seller-http.mjs';
import {createFixtureAnchorClient} from '../../src/dacs/fixture-anchors.mjs';
import {createSellerSr2AgreementAnchor} from '../../src/dacs/seller-sr2-agreement-consumer.mjs';
import {createDemosSr2Adapter} from '../../src/dacs/demos-sr2-adapter.mjs';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));
const closer=s=>()=>new Promise(r=>{s.closeAllConnections();s.close(r);});
// `sr2Reader: false` builds the seller exactly as before (fixture Agreement
// read). `durable: true` keeps seller state in a directory so restart() can
// rebuild the agent from it.
export async function startDevnetAgreementTransportSeller(h, { listingId, sr2Reader = true, durable = false, onSign = () => {} } = {}) {
  const wallet = createEphemeralWallet();
  const { listing } = seedSellerListing(h, wallet, { listingId });
  const durableDirectory = durable ? join(mkdtempSync(join(tmpdir(), 'dacs-seller-sr2-state-')), 'seller') : undefined;
  const requests = [];
  const anchorWrites = [];
  const anchorClient = createFixtureAnchorClient({ url: h.anchors.url });
  const build = async () => createSellerAgent({
    signer: { claim: wallet.claim, sign: (bytes) => { onSign(bytes); return wallet.signBytes(bytes); } },
    listing,
    anchors: { ...anchorClient, write: (input) => { anchorWrites.push(input.logicalAddress); return anchorClient.write(input); } },
    commitOnSignature: h.config.commitOnSignature ?? false,
    observeDemosTransfer: async () => ({ status: 'unavailable', reason: 'payment is held in this slice' }),
    ...(sr2Reader ? { agreementAnchor: createSellerSr2AgreementAnchor({reader:{
      read:(...args)=>observer().read(...args),verifyReceipt:(...args)=>observer().verifyReceipt(...args),
    }}) } : {}),
    ...(durableDirectory ? { durableDirectory } : {}),
  });
  let agent = await build();
  // Reconstruct the independent read-only observer over the current actual
  // source connection after app restart. No buyer plan/journal is imported.
  function observer(){return createDemosSr2Adapter({rpcUrl:h.expected.endpoint,sourceCapability:h.capability,journal:{get:()=>null,put:()=>{throw new Error('read-only seller observation');},records:()=>[],withWalletLock:(_k,work)=>work()}});}
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
