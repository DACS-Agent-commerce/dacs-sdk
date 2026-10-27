import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize,contentHash,compositeVerificationAddress } from '@kynesyslabs/dacs';
import { policyRefusal,confirmedWriteOs,stillOpenBeforePayment,stillAuthorizedToSign,SELLER_POLICY_DEFAULTS } from '../src/devnet-demo/operator-approval.mjs';
import { sellerRecordsPurchaseResolver } from '../src/devnet-demo/seller-purchase-source.mjs';
import { address,seller,buyer,pin,agreementHash,sourceBinding,artifactAuthority,JOBS,PAYMENT_TX_REF,deliveredHashFor,requestFor,confirmationFor,realPurchaseResolver,draftPurchaseResolver } from './helpers/d5-policy-fixtures.mjs';

const outsider=`did:demos:agent:${'2'.repeat(64)}`;
const projection=(change={})=>({jobId:JOBS[0],seller,buyer,listingPin:pin,sourceBinding,agreementHash,amountOs:'1000000000',paymentObserved:false,paymentTxRef:null,prePaymentOpen:true,...change});
const paidProjection=(change={})=>projection({paymentObserved:true,paymentTxRef:{...PAYMENT_TX_REF},prePaymentOpen:null,...change});
// Purchase resolver answers, one per purchase state.
const STATES={
  none:()=>null,
  'buyer-access-closed':()=>false,
  draft:()=>projection({agreementHash:null,sourceBinding:null,paymentObserved:null,prePaymentOpen:null}),
  'agreed-open':()=>projection(),
  'agreed-cancellation-unknown':()=>projection({prePaymentOpen:null}),
  paid:()=>paidProjection(),
  ended:()=>projection({prePaymentOpen:false}),
  indeterminate:()=>projection({paymentObserved:null,prePaymentOpen:null}),
};
const policy=(resolvePurchase=STATES['agreed-open'],change={})=>({address,seller,sourceBinding,artifactAuthority,listingPin:()=>pin,resolvePurchase,paymentPhaseIndex:()=>2,deliveryPhaseIndex:()=>3,
  deliveredPayloadHash:deliveredHashFor,...change});
const refusal=(r,p=policy(),options)=>policyRefusal(r,p,SELLER_POLICY_DEFAULTS,options);
// Each row of the write-kind table, and whether it is written before payment.
const WRITES=[
  ['a Vet record',{artifactKind:'CompositeVerificationRecord'},true],
  ['a finality record',{artifactKind:'FinalityCommitmentRecord'},true],
  ['a Deliverable',{artifactKind:'Deliverable'},false],
  ['payment evidence',{artifactKind:'SettlementEvidence',phase:'pay-dem'},false],
  ['delivery evidence',{artifactKind:'SettlementEvidence',phase:'deliver-storage-program'},false],
];
const approvable=(before)=>policy(before?STATES['agreed-open']:STATES.paid);
const payment={artifactKind:'SettlementEvidence',phase:'pay-dem'};

for(const [label,write,before] of WRITES)test(`policy approves exact ${label} and counts its executed CREATE in each wire form`,async()=>{
  const r=requestFor(write);
  assert.equal(await refusal(r,approvable(before)),null);
  for(const form of [{},{legacy:true},{executed:true}])assert.equal(confirmedWriteOs(confirmationFor(r,form),r),2000000000n,JSON.stringify(form));
});

// Mutation sweep: every member changed, every member deleted and a sibling
// added to every object and array must refuse, except the named free fields.
function* paths(value,path=[]){
  if(value===null||typeof value!=='object')return;
  for(const key of Object.keys(value)){const next=[...path,Array.isArray(value)?Number(key):key];yield next;yield* paths(value[key],next);}
}
const at=(root,path)=>path.reduce((node,key)=>node[key],root);
const changed=(value)=>typeof value==='string'?`${value}0`:typeof value==='number'?value+1:typeof value==='boolean'?!value:'TEST';
function* variants(value,free=[]){
  for(const path of [[],...paths(value)]){
    const node=at(value,path),name=path.join('.');
    if(node!==null&&typeof node==='object'){const copy=structuredClone(value),target=at(copy,path);if(Array.isArray(target))target.push('TEST');else target.TEST='TEST';yield [`a sibling in ${name||'the root'}`,copy];}
    if(!path.length)continue;
    const remove=structuredClone(value),parent=at(remove,path.slice(0,-1));
    if(Array.isArray(parent))parent.splice(path.at(-1),1);else delete parent[path.at(-1)];
    yield [`no ${name}`,remove];
    if(!free.includes(name)){const change=structuredClone(value);at(change,path.slice(0,-1))[path.at(-1)]=changed(node);yield [`another ${name}`,change];}
  }
}
const replaceWith=(copy)=>(target)=>{for(const key of Object.keys(target))delete target[key];Object.assign(target,structuredClone(copy));};
// Display text and the wallet's own timestamp. Artifact members the seller itself
// produces, which no purchase authority decides: its Vet evaluation and signature
// values, record times, the report's title and text, the settlement id it bound at
// handoff and its own handoff audit hash. Payment transactions and delivered
// payload hashes are not free: the purchase's paymentTxRef and
// policy.deliveredPayloadHash decide them.
const FREE_REQUEST=['purpose','content.evidence','content.sending','content.debit.note','content.timestamp'];
const FREE_ARTIFACT={CompositeVerificationRecord:['bundleHash','requirementHash','overallDecision','generatedAt','signature.value'],FinalityCommitmentRecord:['createdAt','signature.value'],
  Deliverable:['title','settlementId','content.text'],'pay-dem':['signature.value'],
  'deliver-storage-program':['dacsSdkAuditSourceHash','observedAt','signature.value']};
for(const [label,write,before] of WRITES){
  test(`the sweep refuses every changed, missing or extra request member of ${label}`,async()=>{
    for(const [name,r] of variants(requestFor(write),FREE_REQUEST))assert.notEqual(await refusal(r,approvable(before)),null,name);
  });
  test(`the sweep refuses every changed, missing or extra CREATE and metadata member of ${label}`,async()=>{
    const base=requestFor(write);
    for(const [name,op] of variants(JSON.parse(base.content.exactCreate))){
      const r=structuredClone(base);r.content.exactCreate=canonicalize(op);assert.notEqual(await refusal(r,approvable(before)),null,name);
    }
  });
  test(`the sweep refuses every changed, missing or extra artifact member of ${label}, rebuilt consistently`,async()=>{
    const base=requestFor(write),artifact=JSON.parse(base.content.exactStorageBytes);
    for(const [name,copy] of variants(artifact,FREE_ARTIFACT[write.phase??write.artifactKind])){
      const r=requestFor({...write,logicalAddress:base.content.logicalAddress,editArtifact:replaceWith(copy)});assert.notEqual(await refusal(r,approvable(before)),null,name);
    }
  });
  for(const form of [{},{legacy:true},{executed:true}])test(`the sweep counts nothing for a changed, missing or extra confirmation member of ${label} (${JSON.stringify(form)})`,()=>{
    const r=requestFor(write),base=confirmationFor(r,form);
    for(const [name,content] of variants(base.response.data.transaction.content)){
      const v=structuredClone(base);v.response.data.transaction.content=content;assert.equal(confirmedWriteOs(v,r),null,name);
    }
  });
}
test('the sweep refuses every changed, missing or extra delivery binding member but its fulfilment id',async()=>{
  const binding=JSON.parse(requestFor().content.exactCreate).metadata.deliveryBinding;
  for(const [name,copy] of variants(binding,['fulfilmentId']))assert.notEqual(await refusal(requestFor({editDeliveryBinding:replaceWith(copy)}),approvable(false)),null,name);
});
test('free display fields, the timestamp, the fulfilment id and the report text do not change the decision',async()=>{
  const r=requestFor();Object.assign(r,{purpose:'other'});Object.assign(r.content,{evidence:'other',sending:'other',timestamp:8});r.content.debit.note='other';
  assert.equal(await refusal(r,approvable(false)),null);
  assert.equal(await refusal(requestFor({editDeliveryBinding:b=>{b.fulfilmentId='TEST-other';},artifact:{title:'Other',content:{mediaType:'text/plain; charset=utf-8',text:'Other bytes'}}}),approvable(false)),null);
});

// Purchase state x write kind: [state, Vet, finality, after payment, held Vet, held finality].
const MATRIX=[
  ['none','seller-record-missing','purchase','purchase',null,'purchase'],
  ['buyer-access-closed','purchase-closed','purchase-closed','purchase-closed','purchase-closed','purchase-closed'],
  ['draft','seller-record-missing','purchase','purchase',null,'purchase'],
  ['agreed-open',null,null,'payment-not-observed',null,null],
  ['agreed-cancellation-unknown','cancellation-unknown','cancellation-unknown','payment-not-observed',null,null],
  ['paid','payment-already-observed','payment-already-observed',null,'payment-already-observed','payment-already-observed'],
  ['ended','purchase-closed','purchase-closed','purchase-closed','purchase-closed','purchase-closed'],
  ['indeterminate','purchase','purchase','purchase','purchase','purchase'],
];
for(const [state,vet,finality,after,vetHeld,finalityHeld] of MATRIX)for(const [label,write,before] of WRITES)test(`${label} under a ${state} purchase is decided the same by every check`,async()=>{
  const r=requestFor(write),p=policy(STATES[state]);
  const [unheld,held]=write.artifactKind==='CompositeVerificationRecord'?[vet,vetHeld]:write.artifactKind==='FinalityCommitmentRecord'?[finality,finalityHeld]:[after,after];
  assert.equal(await refusal(r,p),unheld);assert.equal(await refusal(r,p,{held:true}),held);
  assert.equal(await stillOpenBeforePayment(r,p),before?unheld:null);assert.equal(await stillOpenBeforePayment(r,p,true),before?held:null);
  assert.equal(await stillAuthorizedToSign(r,p),unheld);assert.equal(await stillAuthorizedToSign(r,p,true),held);
});
test('only held:true waives a hold',async()=>{
  const r=requestFor({artifactKind:'FinalityCommitmentRecord'}),p=policy(STATES['agreed-cancellation-unknown']);
  for(const held of ['cancellation-unknown',1,null])assert.equal(await stillOpenBeforePayment(r,p,held),'cancellation-unknown');
});
test('the real seller projection holds a finality record while buyer cancellation is unknown',async()=>{
  const resolve=realPurchaseResolver(),found=await resolve(JOBS[0]),r=requestFor({artifactKind:'FinalityCommitmentRecord',artifact:{agreementHash:found.agreementHash}});
  assert.equal(await refusal(r,policy(resolve)),'cancellation-unknown');
  assert.equal(await stillOpenBeforePayment(r,policy(resolve),true),null);
});
test('the real seller projection of a proposal draft holds a Vet record and refuses a finality record',async()=>{
  const p=policy(draftPurchaseResolver());
  assert.equal(await refusal(requestFor({artifactKind:'CompositeVerificationRecord'}),p),'seller-record-missing');
  assert.equal(await stillOpenBeforePayment(requestFor({artifactKind:'CompositeVerificationRecord'}),p,true),null);
  assert.equal(await refusal(requestFor({artifactKind:'CompositeVerificationRecord',party:outsider}),p),'evaluated-party');
  assert.equal(await stillOpenBeforePayment(requestFor({artifactKind:'FinalityCommitmentRecord'}),p,true),'purchase');
});
test('a Vet record with no seller record of its job is held',async()=>{
  const p=policy(sellerRecordsPurchaseResolver({sessionOf:()=>null}));
  assert.equal(await refusal(requestFor({artifactKind:'CompositeVerificationRecord'}),p),'seller-record-missing');
  assert.equal(await stillOpenBeforePayment(requestFor({artifactKind:'CompositeVerificationRecord'}),p,true),null);
});

// Named regressions of earlier review findings.
test('there is no manual approval option or caller total: an over-cap or malformed request refuses with them (D-1, D-2)',async()=>{
  const options={manualApproved:true,countedTotal:0n,confirmedTotal:0n},malformed=requestFor();malformed.content.exactCreate='{';
  assert.equal(await refusal(requestFor({rpcFeeDem:'10'}),approvable(false),options),'write-fee-cap');
  assert.equal(await refusal(malformed,approvable(false),options),'create-bytes');
});
for(const [label,mutate] of [
  ['stored bytes with whitespace',r=>{r.content.exactStorageBytes=` ${r.content.exactStorageBytes}`;r.content.storageBytes++;}],
  ['stored bytes in another member order (D-3)',r=>{const text=JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(r.content.exactStorageBytes)).reverse()));r.content.exactStorageBytes=text;}],
  ['a storage address not derived from the wallet, name and nonce (D-5)',r=>{const other=`stor-${'f'.repeat(40)}`;r.content.exactCreate=r.content.exactCreate.replace(r.content.storageAddress,other);r.content.storageAddress=other;}],
  ['a storage address derived for another nonce (D-5)',r=>{r.content.nonce=2;}],
  ['an extra CREATE metadata member',r=>{const op=JSON.parse(r.content.exactCreate);op.metadata.TEST='extra';r.content.exactCreate=canonicalize(op);}],
  ['a CREATE in builder member order',r=>{const op=JSON.parse(r.content.exactCreate);r.content.exactCreate=JSON.stringify({operation:op.operation,...op});}],
  ['a storage fee other than its byte count',r=>{Object.assign(r.content.debit,{storageFeeDem:'2',rpcFeeDem:'0',totalDem:'4',totalOs:'4000000000'});}],
])test(`request validation refuses ${label} as create-bytes`,async()=>{
  const r=requestFor(payment);mutate(r);assert.equal(await refusal(r,approvable(false)),'create-bytes');
});
test('the CREATE names the demo artifact authority the policy supplies',async()=>{
  assert.equal(await refusal(requestFor(),policy(STATES.paid,{artifactAuthority:'TEST-RUN-another-authority'})),'create-bytes');
  assert.equal(await refusal(requestFor(),policy(STATES.paid,{artifactAuthority:undefined})),'create-bytes');
  assert.equal(await refusal(requestFor({editCreate:op=>{delete op.metadata.artifactBinding;}}),approvable(false)),'create-bytes');
  assert.equal(await refusal(requestFor({...payment,editCreate:op=>{op.metadata.artifactBinding={};}}),approvable(false)),'create-bytes');
});
for(const value of [null,7,{}])test(`a ${JSON.stringify(value)} logical address refuses without throwing (D-4)`,async()=>{
  const r=requestFor();r.content.logicalAddress=value;assert.equal(await refusal(r,approvable(false)),'request-shape');
});
for(const [label,request] of [['no request',null],['no content',{method:'sendTransaction',address,purpose:'',content:null}]])test(`request validation refuses ${label}`,async()=>{
  assert.equal(await refusal(request,approvable(false)),'request-shape');
});
for(const [label,debit] of [['a non-canonical total',{totalOs:'04'}],['a non-canonical fee',{networkFeeDem:'1.0'}],['SDK gas other than its fixed 1 DEM',{sdkGasDem:'2',totalDem:'5',totalOs:'5000000000'}],
  ['an additional fee',{additionalFeeDem:'1',totalDem:'5',totalOs:'5000000000'}],['a seller amount',{sellerAmountDem:'1'}],['no debit',null]])test(`request validation refuses ${label} as debit`,async()=>{
  const r=requestFor();if(debit===null)r.content.debit=null;else Object.assign(r.content.debit,debit);
  assert.equal(await refusal(r,approvable(false)),'debit');
});
for(const [label,write] of WRITES)test(`${label} under the other request kind refuses (D-14)`,async()=>{
  const r=requestFor(write);r.content.kind=r.content.kind==='devnet-demo-artifact-storage-create'?'devnet-settlement-evidence-storage-create':'devnet-demo-artifact-storage-create';
  assert.equal(await refusal(r,approvable(true)),'request-shape');
});
for(const [label,write,artifact] of [
  ['a finality record with no listing (D-6, C-2)',{artifactKind:'FinalityCommitmentRecord'},{listingRef:undefined}],
  ['a finality record with no Agreement hash (D-7, C-2)',{artifactKind:'FinalityCommitmentRecord'},{agreementHash:undefined}],
  ['a Deliverable with a null listing (D-6)',{artifactKind:'Deliverable'},{listing:null}],
  ['a Deliverable with no Agreement hash (D-7)',{artifactKind:'Deliverable'},{agreementHash:undefined}],
  ['a Deliverable produced by the buyer (D-8)',{artifactKind:'Deliverable'},{producer:buyer}],
  ['a Deliverable with an extra member (A-1)',{artifactKind:'Deliverable'},{TEST:'extra'}],
  ['payment evidence naming a payee (A-1)',payment,{payee:buyer}],
  ['failed payment evidence (A-1)',payment,{outcome:'failure'}],
  ['delivery evidence for another deliverable',{artifactKind:'SettlementEvidence',phase:'deliver-storage-program'},{deliverableAnchor:{kind:'storage-program',locator:`dacs4:deliverable:${JOBS[1]}`}}],
  ['a Vet record signed by the buyer (A-2)',{artifactKind:'CompositeVerificationRecord'},{signature:{algorithm:'ed25519',signer:buyer,value:'A'.repeat(86)}}],
  ['a Vet record with no signature (A-2)',{artifactKind:'CompositeVerificationRecord'},{signature:undefined}],
  ['a Vet record naming a verifier member (A-2)',{artifactKind:'CompositeVerificationRecord'},{verifier:seller}],
  ['a Vet record with a listing member',{artifactKind:'CompositeVerificationRecord'},{listingRef:null}],
])test(`request validation refuses ${label}`,async()=>{
  assert.equal(await refusal(requestFor({...write,artifact}),approvable(write.artifactKind==='CompositeVerificationRecord'||write.artifactKind==='FinalityCommitmentRecord')),'artifact');
});
for(const [label,write,purchase,reason] of [
  ['a Vet record evaluating a third party',{artifactKind:'CompositeVerificationRecord',party:outsider},STATES['agreed-open'],'evaluated-party'],
  ['a finality record for another Agreement',{artifactKind:'FinalityCommitmentRecord'},()=>projection({agreementHash:'f'.repeat(64)}),'agreement'],
  ['a finality record naming another party',{artifactKind:'FinalityCommitmentRecord',artifact:{parties:[outsider,seller]}},STATES['agreed-open'],'parties'],
  ['payment evidence for another amount',payment,()=>paidProjection({amountOs:'2000000000'}),'payment-amount'],
  ['a Deliverable for another amount',{artifactKind:'Deliverable'},()=>paidProjection({amountOs:'2000000000'}),'delivery-binding'],
  ['a Deliverable for another Agreement',{artifactKind:'Deliverable'},()=>paidProjection({agreementHash:'f'.repeat(64)}),'agreement'],
  ['a purchase of another listing',{artifactKind:'FinalityCommitmentRecord'},()=>projection({listingPin:{...pin,version:2}}),'purchase'],
  ['a purchase on another network',{artifactKind:'FinalityCommitmentRecord'},()=>projection({sourceBinding:{...sourceBinding,chainIdentity:'f'.repeat(64)}}),'purchase'],
  ['a purchase from another seller',{artifactKind:'FinalityCommitmentRecord'},()=>projection({seller:outsider}),'purchase'],
])test(`fresh purchase authority refuses ${label} at preparation and before signing`,async()=>{
  const r=requestFor(write),p=policy(purchase);
  assert.equal(await refusal(r,p),reason);assert.equal(await stillAuthorizedToSign(r,p),reason);
});
for(const [label,mutate,p] of [
  ['another phase index in the request and CREATE (D-9)',{editDeliveryBinding:b=>{b.phaseIndex=999;}},approvable(false)],
  ['no delivery phase from the Listing (D-9)',{},policy(STATES.paid,{deliveryPhaseIndex:undefined})],
  ['an unreadable delivery phase from the Listing (D-9)',{},policy(STATES.paid,{deliveryPhaseIndex:()=>-1})],
])test(`request validation refuses a Deliverable with ${label}`,async()=>{
  assert.equal(await refusal(requestFor(mutate),p),'delivery-binding');
});
test('payment evidence at another phase index refuses',async()=>{
  assert.equal(await refusal(requestFor(payment),policy(STATES.paid,{paymentPhaseIndex:()=>3})),'logical-address');
  assert.equal(await refusal(requestFor({artifactKind:'CompositeVerificationRecord',logicalAddress:compositeVerificationAddress(JOBS[0],seller)}),approvable(true)),'logical-address');
});

// CORE CF-5: the exact JSON a request stores or signs is admitted as raw JSON, not leniently parsed.
const intoMetadata=(r,member)=>{r.content.exactCreate=r.content.exactCreate.replace('"metadata":{',`"metadata":{${member},`);};
for(const [label,mutate] of [
  ['a duplicate member in the stored artifact',r=>{r.content.exactStorageBytes=r.content.exactStorageBytes.replace('{',`{"jobId":"${JOBS[1]}",`);r.content.storageBytes=Buffer.byteLength(r.content.exactStorageBytes);}],
  ['a duplicate member in the CREATE',r=>{r.content.exactCreate=r.content.exactCreate.replace('{','{"salt":"TEST",');}],
  ['a duplicate member in the CREATE metadata',r=>intoMetadata(r,'"logicalAddress":"dacs4:TEST-other"')],
  ['a lone surrogate escape in the CREATE metadata',r=>intoMetadata(r,'"TEST":"\\ud800"')],
  ['an unsafe number in the CREATE metadata',r=>intoMetadata(r,'"TEST":9007199254740993')],
  ['nesting deeper than 128 in the CREATE metadata',r=>intoMetadata(r,`"TEST":${'['.repeat(130)}${']'.repeat(130)}`)],
  ['an unpaired surrogate in the CREATE text',r=>intoMetadata(r,`"TEST":"${String.fromCharCode(0xd800)}"`)],
  ['a CREATE that is not JSON',r=>{r.content.exactCreate='{';}],
  ['a stored artifact that is not an object',r=>{r.content.exactStorageBytes='null';r.content.storageBytes=4;}],
])test(`request validation refuses ${label} as create-bytes`,async()=>{
  const r=requestFor(payment);mutate(r);assert.equal(await refusal(r,approvable(false)),'create-bytes');
});

// The confirmation is the node's executed CREATE of this exact request (the diagnose list).
const editsOf=(content)=>content.gcr_edits;
for(const [label,mutate] of [
  ['another data discriminator',c=>{c.data[0]='different';}],
  ['an extra data element',c=>{c.data.push('TEST');}],
  ['no data array',c=>{c.data={0:c.data[0],1:c.data[1]};}],
  ['no storage CREATE edit',c=>editsOf(c).splice(1,1)],
  ['no nonce edit',c=>editsOf(c).pop()],
  ['a doubled nonce edit',c=>editsOf(c).push(structuredClone(editsOf(c)[3]))],
  ['an extra storage CREATE edit',c=>editsOf(c).push(structuredClone(editsOf(c)[1]))],
  ['reordered edits',c=>editsOf(c).reverse()],
  ['a rolled-back edit',c=>{editsOf(c)[0].isRollback=true;}],
  ['a CREATE edit at another storage address',c=>{editsOf(c)[1].target=`stor-${'f'.repeat(40)}`;}],
  ['another destination',c=>{c.to=`0x${'f'.repeat(64)}`;}],
  ['an extra content key',c=>{c.TEST='extra';}],
  ['gas other than the declared SDK gas',c=>{editsOf(c)[2].amount=c.amount===0?2:'2000000000';}],
  ['a network fee other than declared',c=>{c.transaction_fee.network_fee=c.amount===0?9:'9000000000';}],
  ['an RPC fee other than declared',c=>{c.transaction_fee.rpc_fee=0;}],
  ['an additional fee',c=>{c.transaction_fee.additional_fee=c.amount===0?1:'1';}],
  ['an RPC address',c=>{c.transaction_fee.rpc_address='TEST';}],
  ['an edit carrying another transaction hash',c=>{editsOf(c)[0].txhash='f'.repeat(64);}],
])test(`a confirmation with ${label} counts nothing`,()=>{
  for(const legacy of [false,true]){
    const r=requestFor(payment),v=confirmationFor(r,{legacy});
    mutate(v.response.data.transaction.content);assert.equal(confirmedWriteOs(v,r),null,legacy?'legacy':'native');
  }
});
for(const [label,mutate] of [
  ['a node fee view other than the declared fees',data=>{data.gas_operation.fees.rpc_fee='2000000000';}],
  ['a node fee view with an extra fee',data=>{data.gas_operation.fees.TEST='1';}],
  ['decimal-string integers not bound to a transaction hash',data=>{data.transaction.hash='';}],
  ['custom charges',data=>{data.custom_charges={};}],
  ['an invalid answer',data=>{data.valid=false;}],
])test(`an executed confirmation with ${label} counts nothing`,()=>{
  const r=requestFor(payment),v=confirmationFor(r,{executed:true});mutate(v.response.data);assert.equal(confirmedWriteOs(v,r),null);
});
test('a numeric post-fork confirmation stays refused without fork authority',()=>{
  const r=requestFor(payment),v=confirmationFor(r),c=v.response.data.transaction.content,number=(value)=>Number(value);
  c.amount=0;for(const key of ['network_fee','rpc_fee','additional_fee'])c.transaction_fee[key]=number(c.transaction_fee[key]);
  for(const index of [0,2])c.gcr_edits[index].amount=number(c.gcr_edits[index].amount);
  assert.equal(confirmedWriteOs(v,r),null);
});
test('a confirmation of a request with no exact debit counts nothing',()=>{
  const r=requestFor(payment),v=confirmationFor(r);r.content.debit.totalOs='04';assert.equal(confirmedWriteOs(v,r),null);
  assert.equal(confirmedWriteOs(v,null),null);
});
test('the fixture artifacts carry the hashes their requests name',()=>{
  for(const [,write] of WRITES){const r=requestFor(write);assert.equal(contentHash(JSON.parse(r.content.exactStorageBytes)),r.content.contentHash);}
});

// The purchase parties are the Agreement's own claims, compared as the SDK compares them (D-1).
const qualifiedBuyer=`${buyer}?network=demos`,qualifiedSeller=`${seller}?network=demos`;
const vet=(party)=>({artifactKind:'CompositeVerificationRecord',party}),finality=(parties)=>({artifactKind:'FinalityCommitmentRecord',artifact:{parties}});
for(const [label,write,purchase] of [
  ['a Deliverable',{artifactKind:'Deliverable'},()=>paidProjection({buyer:qualifiedBuyer})],
  ['payment evidence',payment,()=>paidProjection({buyer:qualifiedBuyer})],
  ['delivery evidence',{artifactKind:'SettlementEvidence',phase:'deliver-storage-program'},()=>paidProjection({buyer:qualifiedBuyer})],
  ['a Vet record of the buyer',vet(qualifiedBuyer),()=>projection({buyer:qualifiedBuyer})],
  ['a finality record',finality([qualifiedBuyer,seller]),()=>projection({buyer:qualifiedBuyer})],
  ['a finality record under a qualified seller claim',finality([buyer,qualifiedSeller]),()=>projection({seller:qualifiedSeller})],
  ['a Vet record of a qualified seller claim',vet(qualifiedSeller),()=>projection({seller:qualifiedSeller})],
  ['a Deliverable under a qualified seller claim',{artifactKind:'Deliverable'},()=>paidProjection({seller:qualifiedSeller})],
])test(`${label} for an Agreement with a qualified party claim is approved (D-1)`,async()=>{
  const r=requestFor(write),p=policy(purchase);
  assert.equal(await refusal(r,p),null);assert.equal(await stillAuthorizedToSign(r,p),null);
});
test('artifacts name the parties in the Agreement\'s own spelling, not another spelling of the same identity (D-1)',async()=>{
  const p=policy(()=>projection({buyer:qualifiedBuyer}));
  assert.equal(await refusal(requestFor(vet(`${buyer}?network=x`)),p),'evaluated-party');
  assert.equal(await refusal(requestFor(finality([buyer,seller])),p),'parties');
  assert.equal(await refusal(requestFor(finality([buyer,seller])),policy(()=>projection({seller:qualifiedSeller}))),'parties');
});
for(const [label,change] of [
  ['a non-canonical buyer key',{buyer:`did:demos:agent:${'A'.repeat(64)}`}],
  ['a non-canonical buyer scheme',{buyer:`DID:demos:agent:${'1'.repeat(64)}`}],
  ['a buyer with the seller\'s identity',{buyer:qualifiedSeller}],
  ['a buyer outside the Demos agent profile',{buyer:'did:web:x'}],
  ['a buyer that is not text',{buyer:7}],
  ['another seller identity',{seller:outsider}],
  ['a seller that is not a claim',{seller:'TEST seller'}],
])for(const [kind,write,purchase] of [['finality',{artifactKind:'FinalityCommitmentRecord'},projection],['Deliverable',{artifactKind:'Deliverable'},paidProjection]])
  test(`a purchase with ${label} refuses a ${kind} write at every check (D-1)`,async()=>{
    const r=requestFor(write),p=policy(()=>purchase(change));
    assert.equal(await refusal(r,p),'purchase');assert.equal(await stillAuthorizedToSign(r,p),'purchase');
    assert.equal(await stillOpenBeforePayment(r,p),kind==='finality'?'purchase':null);
  });
test('the real seller projection of a qualified Agreement buyer holds a finality record naming it (D-1)',async()=>{
  const resolve=realPurchaseResolver({buyerClaim:qualifiedBuyer}),found=await resolve(JOBS[0]);
  assert.equal(found.buyer,qualifiedBuyer);
  const r=requestFor({artifactKind:'FinalityCommitmentRecord',artifact:{parties:[qualifiedBuyer,seller],agreementHash:found.agreementHash}});
  assert.equal(await refusal(r,policy(resolve)),'cancellation-unknown');
});

// The Agreement's transport binding is the policy's, every member (D-2).
for(const key of [...Object.keys(sourceBinding),'TEST'])test(`a purchase whose transport binding has ${key==='TEST'?'an extra member':`another ${key}`} refuses at every check (D-2)`,async()=>{
  const binding={...sourceBinding,[key]:`${sourceBinding[key]??''}0`};
  const before=requestFor({artifactKind:'FinalityCommitmentRecord'}),after=requestFor(),open=policy(()=>projection({sourceBinding:binding})),paid=policy(()=>paidProjection({sourceBinding:binding}));
  assert.equal(await refusal(before,open),'purchase');assert.equal(await stillOpenBeforePayment(before,open),'purchase');
  assert.equal(await refusal(after,paid),'purchase');assert.equal(await stillAuthorizedToSign(after,paid),'purchase');
});

// Payment evidence names the transaction the observer verified (D-3).
for(const [label,ref] of [['another transaction hash',{txHash:'f'.repeat(64)}],['another block',{blockNumber:123456}]])test(`payment evidence naming ${label} refuses at preparation and before signing (D-3)`,async()=>{
  const r=requestFor({...payment,artifact:{paymentTxRefs:[{...PAYMENT_TX_REF,...ref}]}}),p=approvable(false);
  assert.equal(await refusal(r,p),'payment-tx');assert.equal(await stillAuthorizedToSign(r,p),'payment-tx');
});
test('payment evidence naming the verified transaction at block 0 is approved (D-3)',async()=>{
  const ref={...PAYMENT_TX_REF,blockNumber:0},r=requestFor({...payment,artifact:{paymentTxRefs:[ref]}}),p=policy(()=>paidProjection({paymentTxRef:ref}));
  assert.equal(await refusal(r,p),null);assert.equal(await stillAuthorizedToSign(r,p),null);
});
test('payment evidence approved at preparation refuses at signing once the verified transaction changes (D-3)',async()=>{
  let ref=PAYMENT_TX_REF;const r=requestFor(payment),p=policy(()=>paidProjection({paymentTxRef:{...ref}}));
  assert.equal(await refusal(r,p),null);ref={...PAYMENT_TX_REF,txHash:'f'.repeat(64)};assert.equal(await stillAuthorizedToSign(r,p),'payment-tx');
});
for(const [label,change] of [
  ['paid with no payment transaction',{paymentTxRef:null}],
  ['paid with an upper-case transaction hash',{paymentTxRef:{...PAYMENT_TX_REF,txHash:'A'.repeat(64)}}],
  ['paid with a negative block',{paymentTxRef:{...PAYMENT_TX_REF,blockNumber:-1}}],
  ['paid with a fractional block',{paymentTxRef:{...PAYMENT_TX_REF,blockNumber:1.5}}],
  ['paid with an extra transaction member',{paymentTxRef:{...PAYMENT_TX_REF,TEST:'extra'}}],
  ['paid with another transaction kind',{paymentTxRef:{...PAYMENT_TX_REF,kind:'TEST'}}],
  ['unpaid naming a payment transaction',{paymentObserved:false,prePaymentOpen:true}],
  ['with no payment transaction member',{paymentTxRef:undefined}],
])test(`a purchase ${label} is indeterminate (D-3)`,async()=>{
  const p=policy(()=>JSON.parse(JSON.stringify(paidProjection(change))));
  assert.equal(await refusal(requestFor(payment),p),'purchase');assert.equal(await refusal(requestFor({artifactKind:'FinalityCommitmentRecord'}),p),'purchase');
});
test('a draft naming a payment transaction is indeterminate (D-3)',async()=>{
  const p=policy(()=>projection({agreementHash:null,sourceBinding:null,paymentObserved:null,paymentTxRef:{...PAYMENT_TX_REF},prePaymentOpen:null}));
  assert.equal(await refusal(requestFor({artifactKind:'CompositeVerificationRecord'}),p),'purchase');
});

// Delivery evidence commits to the seller's verified, retained Deliverable (D-4).
const delivery={artifactKind:'SettlementEvidence',phase:'deliver-storage-program'};
for(const [label,r,p] of [
  ['another payload hash',()=>requestFor({...delivery,artifact:{deliverableContentHash:'f'.repeat(64)}}),()=>approvable(false)],
  ['no retained Deliverable',()=>requestFor(delivery),()=>policy(STATES.paid,{deliveredPayloadHash:()=>null})],
  ['no delivered payload input',()=>requestFor(delivery),()=>policy(STATES.paid,{deliveredPayloadHash:undefined})],
  ['a malformed delivered payload hash',()=>requestFor(delivery),()=>policy(STATES.paid,{deliveredPayloadHash:()=>'TEST'})],
])test(`delivery evidence with ${label} refuses at preparation and before signing (D-4)`,async()=>{
  assert.equal(await refusal(r(),p()),'deliverable');assert.equal(await stillAuthorizedToSign(r(),p()),'deliverable');
});
test('delivery evidence approved at preparation refuses at signing once the retained Deliverable changes (D-4)',async()=>{
  let hash=deliveredHashFor(JOBS[0]);const r=requestFor(delivery),p=policy(STATES.paid,{deliveredPayloadHash:()=>hash});
  assert.equal(await refusal(r,p),null);hash='f'.repeat(64);assert.equal(await stillAuthorizedToSign(r,p),'deliverable');
});
