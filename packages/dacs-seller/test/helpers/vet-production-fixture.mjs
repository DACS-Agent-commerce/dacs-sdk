import ts from 'typescript';
import { contentHash } from '@kynesyslabs/dacs';
import { privateModule } from './private-module.mjs';
import { buyer, seller, JOB, NOW } from './protocol-fixture.mjs';
import { fixtureIdentityBundle, fixtureListing } from '../fixtures/listings.mjs';
import { localAnchor } from './local-anchor-fixture.mjs';
import { signAnchorWrite, verifyFixtureReceipt } from '../../src/dacs/fixture-anchors.mjs';
import { createInMemoryPartyVetStore } from '../../src/devnet-demo/party-vet-store.mjs';
import { listingPin } from '../../src/dacs/purchase-protocol.mjs';
const url=new URL('../../src/devnet-demo/agreement-context.mjs',import.meta.url);
export async function stagedProvider(config){
 const module=await privateModule(url,[],source=>{
  source=source.replace('  throw new Error("Vet context is not assembled");\n','');
  const file=ts.createSourceFile('vet.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const factory=file.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='createDevnetDemoAgreementContextProvider');
  if(!factory?.body)throw new Error('TEST staged factory missing');
  const returned=factory.body.statements.filter(ts.isReturnStatement).at(-1),members='jobVet,state';
  return returned?source.slice(0,returned.getStart(file))+`return {...(${returned.expression.getText(file)}),${members}};`+source.slice(returned.end)
   :source.slice(0,factory.body.end-1)+`return {${members}};\n`+source.slice(factory.body.end-1);
 });
 return module.createDevnetDemoAgreementContextProvider(config);
}
export function productionFixture(){
 const base=createInMemoryPartyVetStore(),local=localAnchor({now:()=>NOW});
 const controls={receiptState:'finalized',receiptVerdict:null,relayOnly:false,signs:0};
 const listing=fixtureListing(seller,{now:NOW}),pin=listingPin(listing);
 const anchor={writer:seller.claim,hasIntent:async address=>local.rows.has(address),readRetained:async({logicalAddress})=>{const row=await local.read(logicalAddress);return row.status==='present'?{...row,receipt:{...row.receipt,state:controls.receiptStateFor?.(logicalAddress)??controls.receiptState}}:row;},read:input=>anchor.readRetained(input),
  verifyReceipt:async({receipt,logicalAddress,artifact})=>controls.receiptVerdict??verifyFixtureReceipt({receipt,logicalAddress,hash:contentHash(artifact),expectedWriter:seller.claim}),
  publish:async({logicalAddress,artifact})=>{if(controls.relayOnly)return{status:'indeterminate',reason:'TEST relay only'};if(!local.rows.has(logicalAddress))await local.write({logicalAddress,artifact,writer:seller.claim,writerSignature:signAnchorWrite(seller.signBytes,logicalAddress,contentHash(artifact))});return anchor.readRetained({logicalAddress});}};
 const config={anchor,wallet:{claim:seller.claim,signBytes:bytes=>{controls.signs++;return seller.signBytes(bytes);}},listing,store:base,now:()=>NOW,log:()=>{}};
 const input=(jobId=JOB)=>({scope:{jobId,buyer:buyer.claim,seller:seller.claim,generatedAt:NOW,payee:seller.address,listingPin:pin,price:listing.pricing.price},buyerIdentityBundle:fixtureIdentityBundle(buyer,NOW)});
 return{base,local,anchor,controls,listing,pin,input,config,provider:()=>stagedProvider(config),run:async(value=input())=>(await stagedProvider(config)).jobVet(value.scope,value.buyerIdentityBundle,()=>true)};
}
