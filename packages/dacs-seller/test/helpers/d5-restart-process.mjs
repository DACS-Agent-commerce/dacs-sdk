// Offline child process: real provider, SDK Vet, crypto, SQLite and HTTP handler.
// The anchor is a local fixture file; it sends no transaction or socket request.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {admitFixtureFor} from './challenge-api.mjs';
import {join} from 'node:path';
import {createPrivateKey,sign} from 'node:crypto';
import {contentHash,compositeVerificationAddress,sha256Hex,identityBundleHash,canonicalize} from '@kynesyslabs/dacs';
import {exchange} from './d5-http-fixture.mjs';
import {recordFor} from './bilateral-vet-fixture.mjs';
const {createDevnetDemoAgreementContextProvider}=await import('../../src/devnet-demo/agreement-context.mjs');
const {openPartyVetStore}=await import('../../src/devnet-demo/party-vet-store.mjs');
const {createSellerTransportServerAuth}=await import('../../src/dacs/seller-transport-auth.mjs');
const {createSellerTransportStore}=await import('./bound-transport-store.mjs');
const {createSellerContextRoute}=await import('../../src/dacs/seller-context-route.mjs');
const {createSellerHttpHandler}=await import('../../src/dacs/seller-http.mjs');
const {provenUnsignedAbsence}=await import('../../src/dacs/native-dem-delivery-consumer.mjs');
const [directory,phase]=process.argv.slice(2),config=JSON.parse(readFileSync(join(directory,'config.json'))),file=join(directory,'anchor.json');
const data=existsSync(file)?JSON.parse(readFileSync(file)):{records:{},closing:false,creates:[],signatures:[]},save=()=>writeFileSync(file,JSON.stringify(data));
const privateKey=createPrivateKey(config.seller.privateKey),seller=config.seller.claim;
const signer={claim:seller,sign:bytes=>sign(null,bytes,privateKey)};
const body=JSON.parse(config.input.text),sellerAddress=compositeVerificationAddress(body.scope.jobId,seller),buyerAddress=compositeVerificationAddress(body.scope.jobId,body.scope.buyer);
const read=({logicalAddress,proofOfNoIntent=false})=>data.records[logicalAddress]??(config.vetMode&&proofOfNoIntent&&phase!=='plain'&&phase!=='unknown'?provenUnsignedAbsence('TEST authoritative no-intent proof'):null)??(logicalAddress===sellerAddress&&data.closing?phase==='unknown'?{status:'indeterminate'}:provenUnsignedAbsence('TEST unsigned CREATE'):{status:'absent'});
const anchor={writer:seller,vetMode:config.vetMode,hasIntent:async address=>Boolean(data.records[address])||(address===sellerAddress&&data.closing),readRetained:async input=>read(input),read:async input=>read(input),verifyReceipt:async()=> 'valid',publish:async({logicalAddress,artifact})=>{
 if(config.vetMode&&phase===(logicalAddress===sellerAddress?'seller-publish':'buyer-publish'))emitCut();
 if(logicalAddress===sellerAddress&&phase==='cut'){data.closing=true;save();throw new Error('fixture unsigned CREATE cut');}
 if(data.records[logicalAddress])return data.records[logicalAddress];
 const hash=contentHash(artifact),receipt={receiptVersion:'1',substrate:'fixture',finalityProfile:'fixture',logicalAddress,nativeAddress:logicalAddress,contentHash:hash,transactionRef:{kind:'fixture',value:hash},writer:seller,state:'finalized',observationDisposition:'established',observedAt:config.time,blockRef:{id:'fixture'},evidence:{kind:'fixture',value:'local'}};
 const result={status:'present',artifact,receipt};data.records[logicalAddress]=result;data.creates.push(logicalAddress);data.closing=false;save();return result;
}};
const partyPath=join(directory,'party.sqlite'),partyBase=openPartyVetStore({path:partyPath,mode:existsSync(partyPath)?'open':'create'}),transport=createSellerTransportStore({path:join(directory,'transport.sqlite'),now:()=>config.time});
// Each invocation follows a terminated child, so run the host's lost-owner recovery before readback.
transport.challenges.closeLostValidations();transport.recoverLostContextReservations();
function emitCut(){throw Object.assign(new Error('TEST committed process cut'),{code:'indeterminate'});}
const partyStore={...partyBase,update:async(key,change)=>{
 const row=await partyBase.update(key,change);
 if(config.vetMode)for(const role of ['seller','buyer']){
  const ops=row?.ops?.[role];if(!ops)continue;
  if(phase===role+'-signature'&&Object.values(ops.signing).some(entry=>entry.signature))emitCut();
  if(phase===role+'-bytes'&&Object.values(ops.signing).some(entry=>entry.signedBytes&&!entry.signature))emitCut();
  if(phase===role+'-complete'&&Object.entries(ops.steps).some(([key,entry])=>JSON.parse(key).step==='composite'&&entry.state==='complete'))emitCut();
  if(phase==='between'&&role==='seller'&&Object.values(ops.checkpoints).some(entry=>entry.stage==='complete'))emitCut();
 }
 return row;
}};
const buyerKey=createPrivateKey(config.buyer.privateKey),counterparty={
 issueChallenge:async({jobId})=>({issuer:config.buyer.claim,seller,jobId,sessionNonce:sha256Hex('buyer-issued:'+jobId),expiresAt:config.time+60000}),
 readRecord:async input=>data.counterpartyRecord?{status:'present',record:data.counterpartyRecord}:data.counterpartyAttempt?{status:'indeterminate'}:{status:'unattempted',issuer:config.buyer.claim,jobId:input.jobId,bundleHash:identityBundleHash(input.identityBundle),requirementHash:sha256Hex(canonicalize(input.requirement))},
 evaluate:async input=>{data.counterpartyAttempt=true;save();data.counterpartyRecord=await recordFor(input,{claim:config.buyer.claim,sign:bytes=>sign(null,bytes,buyerKey)});save();return data.counterpartyRecord;}
};
const provider=createDevnetDemoAgreementContextProvider({anchor,counterparty,vetMode:config.vetMode,wallet:{claim:seller,signBytes:bytes=>{data.signatures.push(contentHash({bytes:Buffer.from(bytes).toString('hex')}));save();return signer.sign(bytes)}},listing:config.listing,store:partyStore,now:()=>config.time,log:()=>{}});
const holds=[],releases=[];
const route=createSellerContextRoute({admitPresentation:admitFixtureFor(config.listing),listing:config.listing,resolveBuyer:provider.resolveBuyer,recover:provider.recoverBuyer,resumable:provider.resumableBuyer,assertBuyerAccess:()=>{},writable:()=>true,now:()=>config.time,admitWrites:async value=>{holds.push(value);return null},releaseWrites:async value=>{releases.push(value)}});
const auth=createSellerTransportServerAuth({sellerSigner:signer,listingPin:config.pin,store:transport,now:()=>config.time});
const handler=createSellerHttpHandler({claim:seller,listingPin:config.pin},{authentication:auth,context:route});
let resumeCount=0;const original=transport.resume;transport.resume=(...args)=>{const out=original(...args);if(out.resumed)resumeCount++;return out};
if(phase==='lost')transport.finish=()=>{throw new Error('TEST crash before transport finish');};
try{
 const before=transport.contextAdmission(body.scope.jobId),result=await exchange(handler,config.input),after=transport.contextAdmission(body.scope.jobId);
 const fresh=phase==='lost'||config.vetMode&&phase!=='resume'&&phase!=='plain'?result:await exchange(handler,config.input);
 process.stdout.write(JSON.stringify({status:result.status,answer:JSON.parse(result.text),retryStatus:fresh.status,holds,releases,resumeCount,before,after,creates:data.creates,signatures:data.signatures,buyerAddress,sellerAddress}));
}finally{transport.close();partyStore.close();}
