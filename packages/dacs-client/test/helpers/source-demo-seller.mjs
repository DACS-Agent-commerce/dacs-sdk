// Source-demo TEST seller: fresh RAM-only actor, existing signed seller HTTP,
// genuine SDK payment intake, packaged wallet CREATE, and opaque source reads.
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSellerListing } from './flows.mjs';
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';
import { createSellerAgent } from '../../src/dacs/seller-agent.mjs';
import { createSellerHttpHandler } from '../../src/dacs/seller-http.mjs';
import { createSellerTransportClientAuth, createSellerTransportServerAuth, createSellerTransportStore } from '../../src/dacs/seller-transport-auth.mjs';
import { createFixtureAnchorClient } from '../../src/dacs/fixture-anchors.mjs';
import { createSellerSr2AgreementAnchor } from '../../src/dacs/seller-sr2-agreement-consumer.mjs';
import { createDemosSr2WalletBridge } from '../../src/dacs/demos-sr2-wallet-bridge.mjs';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal } from '../../src/dacs/demos-sr2-adapter.mjs';
import { createNativePaymentEvidenceConsumer } from '../../src/dacs/native-payment-evidence-consumer.mjs';
import { createDevnetAgreementWalletTransport } from '../../public/portal/embedded-wallet/sdk-provider.mjs';
import { createEphemeralPackagedSeller } from './native-settlement-consumer-seller.mjs';
import { createSourceDemoDeliveryContextProvider } from './source-demo-delivery-context.mjs';
import { createSourceNativeDeliveryProvider } from './native-dem-delivery-provider.mjs';

const listen=(s)=>new Promise((r)=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));
const close=(s)=>new Promise((r)=>{s.closeAllConnections();s.close(r);});

export async function startSourceDemoSeller(h,{listingId,buyerSigner,authenticationRegistry,jobContexts,demDeliveryContext,nativeDemDelivery,requireDelegation=false,now=()=>Date.now()}){
  const actor=await createEphemeralPackagedSeller({network:h.expected.network,transactionTransport:createDevnetAgreementWalletTransport(await h.profile())});
  const wallet=actor.signer,{listing}=seedSellerListing(h,wallet,{listingId});
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'source-demo-seller-'))),durableDirectory=join(dir,'seller');
  const requests=[],responses=[],anchorWrites=[],evidenceAttempts=[],evidenceAnswers=[],functionalErrors=[];
  const walletJournalPath=join(dir,'seller-public-wallet.sqlite');
  let walletJournal=openDurableWalletJournal({path:walletJournalPath,mode:'create'});const walletJournalId=walletJournal.journalId;
  const anchors=createFixtureAnchorClient({url:h.anchors.url});
  const tracedAnchors={...anchors,write:(input)=>{anchorWrites.push(input.logicalAddress);return anchors.write(input);}};
  const deliveryContextProvider=createSourceDemoDeliveryContextProvider({anchors:tracedAnchors,wallet});
  deliveryContextProvider.installListing(listing);
  let bridge=createDemosSr2WalletBridge({rpcUrl:h.expected.endpoint,network:h.expected.network,journal:walletJournal,walletFactory:actor.walletFactory,sourceCapability:h.capability});
  const publicProjection=async({logicalAddress,writer})=>{
    const rows=await walletJournal.entries();
    const candidates=rows.filter(([key,r])=>key.startsWith('sr2/wallet/')&&r.signedTransaction?.content?.data?.[1]?.metadata?.logicalAddress===logicalAddress
      &&`did:demos:agent:${r.signedTransaction.content.from.replace(/^0x/,'')}`===writer);
    assert.ok(candidates.length<=1,'exact public seller journal scope is unique');
    return candidates[0]?structuredClone(candidates[0][1].signedTransaction):undefined;
  };
  const nativeDeliveryProvider=createSourceNativeDeliveryProvider({bridge:()=>bridge,sourceCapability:()=>h.capability,rpcUrl:h.expected.endpoint,writer:wallet.claim,readSignedProjection:publicProjection});
  const consumer=()=>createNativePaymentEvidenceConsumer({rpcUrl:h.expected.endpoint,sourceCapability:h.capability,anchorEvidence:(input)=>{
    evidenceAttempts.push(structuredClone(input));
    return bridge.anchor(input).then((answer)=>{evidenceAnswers.push(structuredClone(answer));return answer;});
  },readSignedProjection:publicProjection});
  const agreementReader=()=>createSellerSr2AgreementAnchor({reader:createDemosSr2Adapter({rpcUrl:h.expected.endpoint,sourceCapability:h.capability,journal:{...createInMemoryDemosSr2Journal(),put:async()=>{throw Error('read-only source observer');}}})});
  const build=()=>createSellerAgent({signer:{claim:wallet.claim,sign:(bytes)=>wallet.signBytes(bytes)},listing,
    anchors:tracedAnchors,
    observeDemosTransfer:async()=>({status:'unavailable',reason:'legacy claims not configured'}),agreementAnchor:agreementReader(),durableDirectory,nativePaymentEvidence:consumer(),demDeliveryContext,nativeDemDelivery});
  const store=createSellerTransportStore({path:join(dir,'transport.sqlite')});
  let agent=await build();
  const serverAuth=createSellerTransportServerAuth({sellerSigner:{claim:wallet.claim,sign:(bytes)=>wallet.signBytes(bytes)},listingPin:agent.listingPin,store,requireDelegation,now});
  const clientAuth=createSellerTransportClientAuth({buyerSigner,seller:wallet.claim,resolveJob:(jobId)=>jobContexts.get(jobId)});
  authenticationRegistry.set(wallet.claim,clientAuth);
  const handle=()=>createSellerHttpHandler({...agent,submitPayment:async(input)=>{try{return await agent.submitPayment(input);}catch(error){functionalErrors.push({code:error.code,message:error.message});throw error;}}},{authentication:serverAuth});
  let dropPaymentResponse=false;
  let handler=handle();const server=http.createServer((req,res)=>{if(dropPaymentResponse&&req.url==='/dacs/v1/payments'){dropPaymentResponse=false;res.end=()=>{res.destroy();return res;};}const path=new URL(req.url,'http://seller').pathname;requests.push(path);res.once('finish',()=>responses.push({path,status:res.statusCode,signed:Boolean(res.getHeader('x-dacs-seller-peer'))}));return handler(req,res);});
  const origin=`http://127.0.0.1:${await listen(server)}`;h.endpoints.set(wallet.claim,origin);
  h.onClose(async()=>{authenticationRegistry.delete(wallet.claim);await close(server);agent.close();store.close();walletJournal.close();actor.close();rmSync(dir,{recursive:true});});
  return{wallet,listing,origin,durableDirectory,requests,dropNextPaymentResponse:()=>{dropPaymentResponse=true;},responses,anchorWrites,evidenceAttempts,evidenceAnswers,functionalErrors,deliveryContextProvider,nativeDeliveryProvider,packagedWallet:actor.wallet,sellerApprovals:actor.approvals,authority:actor.authority,publicProjection,get walletJournal(){return walletJournal;},get agent(){return agent;},
    async restart(){agent.close();walletJournal.close();walletJournal=openDurableWalletJournal({path:walletJournalPath,mode:'open',expectedJournalId:walletJournalId});bridge=createDemosSr2WalletBridge({rpcUrl:h.expected.endpoint,network:h.expected.network,journal:walletJournal,walletFactory:actor.walletFactory,sourceCapability:h.capability});agent=await build();handler=handle();}};
}
