// Offline child process: real provider, SDK Vet, crypto, SQLite and HTTP handler.
// The anchor is a local fixture file; it sends no transaction or socket request.
import './d5-isolated-dependencies.mjs';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createPrivateKey,sign} from 'node:crypto';
import {contentHash,compositeVerificationAddress,sha256Hex} from '@kynesyslabs/dacs';
import {exchange} from './d5-http-fixture.mjs';
import {recordFor} from './bilateral-vet-fixture.mjs';
const {createDevnetDemoAgreementContextProvider}=await import('../../src/devnet-demo/agreement-context.mjs');
const {openPartyVetStore}=await import('../../src/devnet-demo/party-vet-store.mjs');
const {createSellerTransportStore,createSellerTransportServerAuth}=await import('../../src/dacs/seller-transport-auth.mjs');
const {createSellerContextRoute}=await import('../../src/dacs/seller-context-route.mjs');
const {createSellerHttpHandler}=await import('../../src/dacs/seller-http.mjs');
const [directory,phase]=process.argv.slice(2),config=JSON.parse(readFileSync(join(directory,'config.json'))),file=join(directory,'anchor.json');
const data=existsSync(file)?JSON.parse(readFileSync(file)):{records:{},closing:false,creates:[],signatures:[]},save=()=>writeFileSync(file,JSON.stringify(data));
const privateKey=createPrivateKey(config.seller.privateKey),seller=config.seller.claim;
const signer={claim:seller,sign:bytes=>sign(null,bytes,privateKey)};
const body=JSON.parse(config.input.text),sellerAddress=compositeVerificationAddress(body.scope.jobId,seller),buyerAddress=compositeVerificationAddress(body.scope.jobId,body.scope.buyer);
const read=({logicalAddress})=>data.records[logicalAddress]??(logicalAddress===sellerAddress&&data.closing?phase==='unknown'?{status:'indeterminate'}:{status:'absent',provenUnsigned:true}:{status:'absent'});
const anchor={writer:seller,hasIntent:async address=>Boolean(data.records[address])||(address===sellerAddress&&data.closing),readRetained:async input=>read(input),read:async input=>read(input),verifyReceipt:async()=> 'valid',publish:async({logicalAddress,artifact})=>{
 if(logicalAddress===sellerAddress&&phase==='cut'){data.closing=true;save();throw new Error('fixture unsigned CREATE cut');}
 if(data.records[logicalAddress])return data.records[logicalAddress];
 const hash=contentHash(artifact),receipt={receiptVersion:'1',substrate:'fixture',finalityProfile:'fixture',logicalAddress,nativeAddress:logicalAddress,contentHash:hash,transactionRef:{kind:'fixture',value:hash},writer:seller,state:'finalized',observationDisposition:'established',observedAt:config.time,blockRef:{id:'fixture'},evidence:{kind:'fixture',value:'local'}};
 const result={status:'present',artifact,receipt};data.records[logicalAddress]=result;data.creates.push(logicalAddress);data.closing=false;save();return result;
}};
const partyStore=openPartyVetStore({path:join(directory,'party.sqlite')}),transport=createSellerTransportStore({path:join(directory,'transport.sqlite'),now:()=>config.time});
const buyerKey=createPrivateKey(config.buyer.privateKey),counterparty={issueChallenge:async({jobId})=>({issuer:config.buyer.claim,seller,jobId,sessionNonce:sha256Hex('buyer-issued:'+jobId),expiresAt:config.time+60000}),evaluate:input=>recordFor(input,{claim:config.buyer.claim,sign:bytes=>sign(null,bytes,buyerKey)})};
const provider=createDevnetDemoAgreementContextProvider({anchor,counterparty,wallet:{claim:seller,signBytes:bytes=>{data.signatures.push(contentHash({bytes:Buffer.from(bytes).toString('hex')}));save();return signer.sign(bytes)}},listing:config.listing,store:partyStore,now:()=>config.time,log:()=>{}});
const holds=[],releases=[];
const route=createSellerContextRoute({listing:config.listing,resolveBuyer:provider.resolveBuyer,recover:provider.recoverBuyer,resumable:provider.resumableBuyer,assertBuyerAccess:()=>{},now:()=>config.time,admitWrites:async value=>{holds.push(value);return null},releaseWrites:async value=>{releases.push(value)}});
const auth=createSellerTransportServerAuth({sellerSigner:signer,listingPin:config.listing.pin,store:transport,now:()=>config.time});
const handler=createSellerHttpHandler({claim:seller,listingPin:config.listing.pin},{authentication:auth,context:route});
let resumeCount=0;const original=transport.resume;transport.resume=(...args)=>{const out=original(...args);if(out.resumed)resumeCount++;return out};
try{
 const before=transport.contextAdmission(body.scope.jobId),result=await exchange(handler,config.input),after=transport.contextAdmission(body.scope.jobId);
 const fresh=await exchange(handler,config.input);
 process.stdout.write(JSON.stringify({status:result.status,answer:JSON.parse(result.text),retryStatus:fresh.status,holds,releases,resumeCount,before,after,creates:data.creates,signatures:data.signatures,buyerAddress,sellerAddress}));
}finally{transport.close();partyStore.close();}
