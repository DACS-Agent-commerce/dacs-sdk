import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, contentHash, demosSignedTransactionProofHash, generateCanonicalJobId, sha256Hex } from '@kynesyslabs/dacs';
import { SELLER_SESSION_KEY_GRACE_MS, createOperatorSellerSessions, sellerSessionKeyRetirement } from '../src/devnet-demo/operator-sessions.mjs';
import { deliveryIsFinal } from '../src/dacs/purchase-protocol.mjs';
import { missingChainPointers } from '../src/dacs/seller-session-lifecycle.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { FIXTURE_LISTING, boundTerms, retainedAnswerFixture } from './helpers/retained-answer-fixture.mjs';

const GRACE=SELLER_SESSION_KEY_GRACE_MS,LIFETIME=3600000,WINDOW=1800000;

// Purchases are plain records in a fake purchase store; the sweep sees them
// only through lookup({operationId,accountId}), as the operator wires it.
function setup(t){
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'seller-session-retire-')));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  let time=Date.parse('2026-10-08T09:00:00.000Z');
  const now=()=>time,purchases=new Map(),wallets=new Map();
  const lookup=({operationId,accountId})=>{const found=purchases.get(operationId);return found&&found.accountId===accountId?found:null;};
  let store=createOperatorSellerSessions({directory,now});
  const w={directory,purchases,lookup,
    get store(){return store;},
    restart(){store=createOperatorSellerSessions({directory,now});},
    advance(ms){time+=ms;},now,
    wallets:(operation)=>wallets.get(operation.id),
    sweep(){return store.sweep(lookup);},
    keyFile:(operation)=>join(directory,`${sha256Hex(operation.id)}.json`),
    retiredFile:(operation)=>join(directory,`${sha256Hex(operation.id)}.retired.json`),
    // A purchase whose buyer wallet delegated its session key.
    delegated(id){
      const buyer=createEphemeralWallet(),seller=createEphemeralWallet();wallets.set(id,{buyer,seller});
      const operation={id,accountId:`acct_${id}`,status:'agreement_pending',expiresAt:new Date(time+WINDOW).toISOString(),updatedAt:new Date(time).toISOString(),
        terms:{buyer:{wallet:buyer.address},...boundTerms({seller}),listing:{...FIXTURE_LISTING},protocol:{jobId:generateCanonicalJobId()}},
        state:{protocol:{stage:'identity',listing:{terms:{deadlineSecAfterCommit:LIFETIME/1000}}}}};
      purchases.set(id,operation);
      const request=store.request(operation);
      operation.state.protocol.sessionDelegation={payload:request.payload};
      operation.state.protocol.sessionDelegation=store.accept(operation,buyer.signHex(request.message));
      operation.state.protocol.planned={draft:{terms:{deadline:request.payload.expiresAt}}};
      return operation;
    },
    // A durable purchase change, as the purchase store records it. Final
    // delivery carries the verified delivery and retained seller answer the
    // reducer records, so a seller-free readback can be derived.
    move(operation,status,stage=operation.state.protocol.stage){
      operation.status=status;operation.state.protocol.stage=stage;operation.updatedAt=new Date(time).toISOString();
      if(status==='settled_verified'&&['delivery-ready','delivered'].includes(stage))Object.assign(operation.state.protocol,retainedAnswerFixture({...wallets.get(operation.id),jobId:operation.terms.protocol.jobId,stage,id:operation.id,time}));
    },
  };
  return w;
}
const ids=(list)=>list.map((item)=>item.operationId).sort();

test('an ended purchase keeps its session key through the grace window and a restart, then the sweep deletes it and the store refuses it',t=>{
  const w=setup(t),ended=[['expired'],['terms_changed'],['superseded'],['agreement_rejected'],['payment_failed'],['payment_mismatch'],['settled_verified','delivery-ready'],['settled_verified','delivered']];
  const purchases=ended.map(([status,stage],index)=>{const operation=w.delegated(`ended-${index}`);w.move(operation,status,stage);return operation;});
  assert.deepEqual(w.sweep().deleted,[],'just ended: inside the grace window');
  w.advance(GRACE-1);w.restart();
  const before=w.sweep();assert.deepEqual(before.deleted,[],'a restart keeps the same durable decision');
  assert.ok(before.kept.every((item)=>/inside the grace window/.test(item.reason)),JSON.stringify(before.kept));
  w.advance(1);
  const swept=w.sweep();
  assert.deepEqual(ids(swept.deleted),ids(purchases.map((operation)=>({operationId:operation.id}))));
  for(const operation of purchases){
    assert.equal(existsSync(w.keyFile(operation)),false,'private key file is deleted');
    const marker=JSON.parse(readFileSync(w.retiredFile(operation),'utf8'));
    assert.deepEqual(Object.keys(marker).sort(),['accountId','format','operationId','reason','retiredAt','sessionPublicKey']);
    assert.equal(marker.sessionPublicKey,operation.state.protocol.sessionDelegation.payload.sessionPublicKey);
    assert.equal(statSync(w.retiredFile(operation)).mode&0o777,0o600);
  }
  assert.equal(readdirSync(w.directory).filter((name)=>/^[0-9a-f]{64}\.json$/.test(name)).length,0);
  // The deleted key is refused, never regenerated, also after another restart.
  w.restart();
  for(const call of [(operation)=>w.store.signerFor(operation),(operation)=>w.store.request(operation),(operation)=>w.store.accept(operation,'00'.repeat(64))])
    assert.throws(()=>call(purchases[0]),(error)=>error.code==='seller_session_retired');
  delete purchases[0].state.protocol.sessionDelegation;
  assert.throws(()=>w.store.request(purchases[0]),(error)=>error.code==='seller_session_retired','no fresh key for a retired purchase');
  assert.equal(existsSync(w.keyFile(purchases[0])),false);
  assert.deepEqual(w.sweep(),{deleted:[],kept:[]});
});

test('a purchase with an unresolved effect keeps its session key long after the delegation expired',t=>{
  const w=setup(t),open=[['approved','seller-committed'],['payment_handoff','seller-committed'],['broadcast_reported','seller-committed'],['payment_uncertain','seller-committed'],
    ['settled_verified','payment-observed'],['settled_verified','native-payment-evidence-held'],['settled_verified','payment-evidenced'],['settled_verified','delivery-rejected']];
  const purchases=open.map(([status,stage],index)=>{const operation=w.delegated(`open-${index}`);w.move(operation,status,stage);return operation;});
  // Delivery evidence still pending or held: the seller may have to be asked again.
  const held=['pending','rejected'].map((status)=>{const operation=w.delegated(`evidence-${status}`);w.move(operation,'settled_verified','delivery-ready');
    operation.state.protocol.delivery={evidenceHold:{status,logicalAddress:`dacs4:evidence:${operation.terms.protocol.jobId}`,reason:'TEST delivery evidence not read back'}};return operation;});
  purchases.push(...held);
  const pending=w.delegated('pending');pending.expiresAt=new Date(w.now()+10*LIFETIME).toISOString();w.move(pending,'agreement_pending','agreement-anchored');
  w.advance(LIFETIME+4*GRACE);w.restart();
  const swept=w.sweep();
  assert.deepEqual(swept.deleted,[]);
  assert.deepEqual(ids(swept.kept),ids([...purchases,pending].map((operation)=>({operationId:operation.id}))));
  for(const operation of [...purchases,pending])assert.equal(existsSync(w.keyFile(operation)),true);
  for(const operation of held)assert.match(swept.kept.find((item)=>item.operationId===operation.id).reason,/delivery evidence is not final/);
  assert.match(swept.kept.find((item)=>item.operationId===purchases[0].id).reason,/approved is not final/);
  assert.match(swept.kept.find((item)=>item.operationId===purchases[2].id).reason,/payment outcome unresolved/);
  assert.match(swept.kept.find((item)=>item.operationId==='pending').reason,/inside its approval window/);
  assert.match(swept.kept.find((item)=>item.operationId===purchases[4].id).reason,/not final/);
  // The retained key still signs readback requests after expiry.
  assert.ok(w.store.signerFor(purchases[4]).sign(Buffer.from('readback')));
});

test('delivery is final only when delivered, or delivery-ready with no delivery evidence pending or held',()=>{
  const hold=(status)=>({evidenceHold:{status,logicalAddress:'dacs4:evidence:job',reason:'TEST'}});
  assert.equal(deliveryIsFinal({stage:'delivered',delivery:{}}),true);
  assert.equal(deliveryIsFinal({stage:'delivery-ready',delivery:{evidencePublication:'deferred-to-explicit-sdk-finaliser'}}),true);
  assert.equal(deliveryIsFinal({stage:'delivery-ready',delivery:hold('pending')}),false);
  assert.equal(deliveryIsFinal({stage:'delivery-ready',delivery:hold('rejected')}),false);
  for(const stage of ['committed','payment-observed','native-payment-evidence-held','payment-evidenced','delivery-rejected'])assert.equal(deliveryIsFinal({stage,delivery:null}),false,stage);
  assert.equal(deliveryIsFinal(undefined),false);
});

// A final stage alone is not enough: without the verified delivery the
// readback pointer comes from, or without the retained signed payment
// projection that authenticates the payment CREATE without the seller, the
// key is kept and the reason reported.
test('malformed final protocol state and a final purchase without a retained payment projection keep the key',t=>{
  // Each case names the first check that must refuse it.
  const w=setup(t),noDelivery=/no verified delivery-ready delivery/,hash=/the Deliverable hash is missing or malformed/,part=/the Deliverable fulfilment or receipt is missing/,
    settlement=/no settlement pointer is recorded/,differs=/the retained seller answer differs from the verified delivery/,malformed={
    'no delivery':[(p)=>{delete p.delivery;},noDelivery],
    'delivery null':[(p)=>{p.delivery=null;},noDelivery],
    'delivered without data':[(p)=>{p.stage='delivered';p.delivery={};},/no verified delivered delivery/],
    'delivered with a delivery-ready record':[(p)=>{p.stage='delivered';},/no verified delivered delivery/],
    'no settlement pointer':[(p)=>{delete p.delivery.report.settlementId;delete p.sellerAnswer.settlementId;},settlement],
    'no report':[(p)=>{delete p.delivery.report;},settlement],
    'non-canonical Deliverable':[(p)=>{const locator='dacs4:deliverable:other';p.delivery.deliverableRef={...p.delivery.deliverableRef,anchor:{kind:'storage-program',locator}};p.sellerAnswer.delivery.logicalAddress=locator;},/the Deliverable reference is not canonical/],
    'malformed Deliverable hash':[(p)=>{const bad='F'.repeat(64);p.delivery.deliverableRef={...p.delivery.deliverableRef,contentHash:bad};p.delivery.payloadHash=bad;p.sellerAnswer.delivery.contentHash=bad;},hash],
    'payload hash differs':[(p)=>{p.delivery.payloadHash='0'.repeat(64);},hash],
    'no fulfilment':[(p)=>{delete p.delivery.fulfilmentId;delete p.sellerAnswer.delivery.fulfilmentId;},part],
    'no receipt':[(p)=>{delete p.delivery.anchorReceipt;},part],
    'answer for another settlement':[(p)=>{p.sellerAnswer={...p.sellerAnswer,settlementId:'TEST-other'};},differs],
    'answer null':[(p)=>{p.sellerAnswer=null;},differs],
    'no session delegation':[(p)=>{delete p.sessionDelegation;},/no retained session delegation/],
  },unprojected={
    'answer without projection':[(p)=>{delete p.sellerAnswer.signedProjection;}],
    'legacy row':[(p)=>{delete p.sellerAnswer;}],
  };
  const make=(cases,prefix)=>Object.entries(cases).map(([name,[edit,expected]],index)=>{const operation=w.delegated(`${prefix}-${index}`);w.move(operation,'settled_verified','delivery-ready');edit(operation.state.protocol);return[name,operation,expected];});
  const bad=make(malformed,'malformed'),legacy=make(unprojected,'unprojected');
  const valid=w.delegated('valid');w.move(valid,'settled_verified','delivery-ready');
  w.advance(LIFETIME+4*GRACE);w.restart();
  const swept=w.sweep(),reason=(operation)=>swept.kept.find((item)=>item.operationId===operation.id)?.reason??'';
  assert.deepEqual(ids(swept.deleted),['valid'],JSON.stringify(swept.deleted));
  for(const [name,operation] of [...bad,...legacy]){
    assert.equal(existsSync(w.keyFile(operation)),true,name);
    assert.equal(existsSync(w.retiredFile(operation)),false,name);
  }
  for(const [name,operation,expected] of bad){assert.match(reason(operation),/^final purchase record is malformed: /,name);assert.match(reason(operation),expected,name);}
  for(const [name,operation] of legacy)assert.match(reason(operation),/^final purchase has no retained signed payment projection/,name);
  // The kept key still signs the seller-backed recheck that can retain a projection.
  assert.ok(w.store.signerFor(legacy[1][1]).sign(Buffer.from('readback')));
});

// a an earlier review (P3), DACS_BUYER_CHAIN_READBACK=on: the same legacy rows
// lack chain material as a missing pointer does, so they are kept only until
// the pointer retention bound and retired exactly at it, with the operator
// action when a pointer is missing too. A projection that is present but not a
// record, a malformed final row and a non-final row keep the key past it.
test('on: a final row without a retained seller answer or payment projection retires exactly at the pointer retention bound; malformed and non-final rows keep the key',t=>{
  const w=setup(t),RETENTION=60000;
  const final=(id,edit)=>{const operation=w.delegated(id);w.move(operation,'settled_verified','delivery-ready');edit(operation.state.protocol);return operation;};
  const noAnswer=final('no-answer',(p)=>{delete p.sellerAnswer;}),noProjection=final('no-projection',(p)=>{delete p.sellerAnswer.signedProjection;});
  const allKept=final('all-kept',(p)=>{delete p.sellerAnswer.signedProjection;});
  allKept.state.protocol.chainReadback=Object.fromEntries(missingChainPointers(allKept).map((address)=>[address,{TEST:'kept signed CREATE'}]));
  const kept={
    'projection null':[final('projection-null',(p)=>{p.sellerAnswer.signedProjection=null;}),/^final purchase has no retained signed payment projection; kept until a seller-backed recheck retains one$/],
    'projection not a record':[final('projection-text',(p)=>{p.sellerAnswer.signedProjection='TEST';}),/^final purchase has no retained signed payment projection; kept until a seller-backed recheck retains one$/],
    'answer null':[final('answer-null',(p)=>{p.sellerAnswer=null;}),/^final purchase record is malformed: the retained seller answer differs/],
    'no delivery, no answer':[final('no-delivery',(p)=>{delete p.sellerAnswer;delete p.delivery;}),/^final purchase record is malformed: no verified delivery-ready delivery/],
  };
  const open=w.delegated('open');w.move(open,'settled_verified','payment-evidenced');kept['not final']=[open,/is not final/];
  const payload=(operation)=>operation.state.protocol.sessionDelegation.payload,bound=payload(noAnswer).expiresAt+RETENTION;
  assert.ok(missingChainPointers(noAnswer).length&&missingChainPointers(noProjection).length&&!missingChainPointers(allKept).length);
  const on=createOperatorSellerSessions({directory:w.directory,now:w.now,requireChainPointers:true,pointerRetentionMs:RETENTION});
  const sweep=()=>{const swept=on.sweep(w.lookup);return{swept,reason:(operation)=>swept.kept.find((item)=>item.operationId===operation.id)?.reason??''};};
  w.advance(bound-1-w.now());
  let {swept,reason}=sweep();
  assert.deepEqual(swept.deleted,[],'one millisecond before the bound every key is kept');
  for(const operation of [noAnswer,noProjection])assert.match(reason(operation),/^final purchase has no retained signed payment projection and lacks kept chain pointers \(.+\); kept until .+ \(pointer retention bound\)$/,operation.id);
  assert.match(reason(allKept),/^final purchase has no retained signed payment projection; kept until .+ \(pointer retention bound\)$/);
  w.advance(1);
  ({swept,reason}=sweep());
  assert.deepEqual(ids(swept.deleted),['all-kept','no-answer','no-projection'],JSON.stringify(swept.kept));
  const deleted=(operation)=>swept.deleted.find((item)=>item.operationId===operation.id);
  for(const operation of [noAnswer,noProjection]){
    assert.deepEqual(deleted(operation).operatorAction,{missing:missingChainPointers(operation)},operation.id);
    assert.equal(deleted(operation).reason,`final purchase has no retained signed payment projection and lacks kept chain pointers (${missingChainPointers(operation).join(', ')}) at the pointer retention bound; retired, operator action required`);
  }
  // Every pointer kept: nothing for the operator to do; the key still waits for the bound.
  assert.equal(deleted(allKept).operatorAction,undefined);
  assert.equal(deleted(allKept).reason,'final purchase has no retained signed payment projection at the pointer retention bound; retired');
  for(const operation of [noAnswer,noProjection,allKept]){
    assert.equal(existsSync(w.keyFile(operation)),false,operation.id);assert.equal(existsSync(w.retiredFile(operation)),true,operation.id);
    assert.throws(()=>w.store.signerFor(operation),(error)=>error.code==='seller_session_retired');
  }
  // Fail-closed rows keep the key, long after the bound too.
  w.advance(400*24*60*60*1000);({swept,reason}=sweep());
  assert.deepEqual(swept.deleted,[]);
  for(const [name,[operation,expected]] of Object.entries(kept)){assert.match(reason(operation),expected,name);assert.equal(existsSync(w.keyFile(operation)),true,name);}
  // Switch off, the legacy row keeps its key as before.
  assert.deepEqual(sellerSessionKeyRetirement(noAnswer,payload(noAnswer),{time:w.now()}),{retire:false,reason:'final purchase has no retained signed payment projection; kept until a seller-backed recheck retains one'});
});

// a an earlier review (P2) and code an earlier review (P3-2), switch on: only a
// structurally valid legacy row waits for the bound. Its own Agreement,
// payment evidence and payment receipt are checked with or without an answer,
// and the answer's delivery and payment-evidence address whenever there is
// one. A row that fails one keeps its key past the bound and is reported,
// whether a pointer is missing (it used to retire with a hold) or every
// pointer is kept (it used to retire with none).
test('on: a legacy final row whose Agreement, payment evidence or payment receipt is absent or malformed, or whose answer differs, keeps its key past the pointer retention bound',t=>{
  const w=setup(t),RETENTION=60000,other=createEphemeralWallet();
  const rehashed=(edit)=>(p)=>{const artifact=structuredClone(p.agreement.artifact);edit(artifact);const hash=contentHash(artifact);p.agreement={...p.agreement,artifact,hash,ref:{...p.agreement.ref,contentHash:hash}};};
  const shapes={
    'no answer':[(p)=>{delete p.sellerAnswer;},'final purchase record is malformed: '],
    'no projection':[(p)=>{delete p.sellerAnswer.signedProjection;},'final purchase\'s retained seller answer cannot authenticate it: '],
  };
  const evidenceElsewhere='the verified payment evidence is not at its canonical address',noReceipt='no verified payment-evidence receipt is retained',unbound='the payment-evidence receipt does not bind the canonical seller write';
  const record={
    'no payment evidence':[(p)=>{delete p.paymentEvidence;},evidenceElsewhere],
    'payment evidence elsewhere':[(p)=>{p.paymentEvidence.ref.anchor.locator=`${p.paymentEvidence.ref.anchor.locator}:other`;},evidenceElsewhere],
    'no Agreement':[(p)=>{delete p.agreement;},'no retained Agreement names the payment-evidence address'],
    'Agreement changed under its verified hash':[(p)=>{p.agreement.artifact.terms.price.amount='2';},'the retained Agreement does not hash to its verified hash'],
    'Agreement reference not canonical':[(p)=>{p.agreement.ref.anchor.locator=`${p.agreement.ref.anchor.locator}:other`;},'the retained Agreement reference is not canonical for its hash'],
    'Agreement for another price':[rehashed((a)=>{a.terms.price.amount='2';}),'the retained Agreement differs from the purchase terms (price)'],
    'no payment receipt':[(p)=>{delete p.paymentEvidence.anchorReceipt;},noReceipt],
    'undecodable payment receipt':[(p)=>{p.paymentEvidence.anchorReceipt.evidence.value='TEST';},noReceipt],
    // The receipt's proof names its writer, so another writer alone does not decode.
    'payment receipt with its writer replaced':[(p)=>{p.paymentEvidence.anchorReceipt.writer=other.claim;},noReceipt],
    'payment receipt for other content':[(p)=>{p.paymentEvidence.ref.contentHash='b'.repeat(64);},unbound],
    'payment receipt written by another seller':[(p,operation)=>{p.paymentEvidence=retainedAnswerFixture({...w.wallets(operation),seller:other,jobId:operation.terms.protocol.jobId,id:operation.id,time:w.now()}).paymentEvidence;},unbound],
  },answer={
    'answer with another delivery status':[(p)=>{p.sellerAnswer.delivery.status='pending';},'its delivery status differs from the verified delivery-ready'],
    'answer with another delivery evidence hash':[(p)=>{p.sellerAnswer.delivery.evidenceHash='d'.repeat(64);},'its delivery evidence hash differs from the verified delivery'],
    'answer with another Deliverable receipt':[(p)=>{p.sellerAnswer.delivery.anchorReceipt={...p.sellerAnswer.delivery.anchorReceipt,TEST:'another receipt'};},'its Deliverable receipt differs from the verified delivery'],
    'answer naming another evidence address':[(p)=>{p.sellerAnswer.evidenceAddress=`${p.sellerAnswer.evidenceAddress}:other`;},'its payment-evidence address differs from the canonical address'],
  };
  // Each row once with its pointers missing and once with every pointer it names kept.
  let index=0;
  const row=(shape,edit,keep)=>{const operation=w.delegated(`legacy-${index++}`);w.move(operation,'settled_verified','delivery-ready');shapes[shape][0](operation.state.protocol);edit?.(operation.state.protocol,operation);
    if(keep)operation.state.protocol.chainReadback=Object.fromEntries(missingChainPointers(operation).map((address)=>[address,{TEST:'kept signed CREATE'}]));return operation;};
  const malformed=[],valid=[];
  for(const keep of [false,true])for(const shape of Object.keys(shapes)){
    valid.push(row(shape,null,keep));
    for(const [name,[edit,why]] of Object.entries(shape==='no projection'?{...record,...answer}:record))malformed.push([`${shape}, ${name}${keep?', every pointer kept':''}`,row(shape,edit,keep),`${shapes[shape][1]}${why}`]);
  }
  assert.ok(malformed.some(([,operation])=>!missingChainPointers(operation).length),'some malformed rows have no missing pointer to hold');
  const payload=(operation)=>operation.state.protocol.sessionDelegation.payload,bound=payload(valid[0]).expiresAt+RETENTION;
  const on=createOperatorSellerSessions({directory:w.directory,now:w.now,requireChainPointers:true,pointerRetentionMs:RETENTION});
  const sweep=()=>{const swept=on.sweep(w.lookup);return{swept,reason:(operation)=>swept.kept.find((item)=>item.operationId===operation.id)?.reason};};
  const keptForever=({swept,reason},when)=>{for(const [name,operation,expected] of malformed){
    assert.equal(reason(operation),expected,`${when}: ${name}`);
    assert.equal(existsSync(w.keyFile(operation)),true,`${when}: ${name}`);assert.equal(existsSync(w.retiredFile(operation)),false,`${when}: ${name}`);
  }assert.equal(swept.kept.length,malformed.length+(when==='before the bound'?valid.length:0));};
  w.advance(bound-1-w.now());
  let swept=sweep();
  assert.deepEqual(swept.swept.deleted,[],'one millisecond before the bound every key is kept');
  for(const operation of valid)assert.match(swept.reason(operation),/^final purchase has no retained signed payment projection.*\(pointer retention bound\)$/,operation.id);
  keptForever(swept,'before the bound');
  // Exactly at the bound the valid legacy rows retire, with the operator action
  // when a pointer is missing; no malformed row does.
  w.advance(1);swept=sweep();
  assert.deepEqual(ids(swept.swept.deleted),ids(valid.map((operation)=>({operationId:operation.id}))),JSON.stringify(swept.swept.deleted));
  for(const operation of valid){const missing=missingChainPointers(operation),deleted=swept.swept.deleted.find((item)=>item.operationId===operation.id);
    assert.deepEqual(deleted.operatorAction,missing.length?{missing}:undefined,operation.id);}
  keptForever(swept,'at the bound');
  w.advance(400*24*60*60*1000);swept=sweep();
  assert.deepEqual(swept.swept.deleted,[]);
  keptForever(swept,'400 days later');
  // Switch off nothing changes: every one keeps main's decision.
  for(const [name,operation] of malformed)assert.deepEqual(sellerSessionKeyRetirement(operation,payload(operation),{time:w.now()}),{retire:false,reason:'final purchase has no retained signed payment projection; kept until a seller-backed recheck retains one'},name);
});

// The retained answer is what a seller-free readback re-reads, so it must
// reproduce exactly what the buyer verified: a foreign or inconsistent answer
// keeps the key, with one case per bound field.
test('a retained answer that would not reproduce the verified purchase keeps the key',t=>{
  const w=setup(t),other=createEphemeralWallet();
  const fixture=(operation,options)=>retainedAnswerFixture({...w.wallets(operation),jobId:operation.terms.protocol.jobId,id:operation.id,time:w.now(),...options});
  const foreign=(operation)=>fixture(operation,{seller:other});
  const unauthorized=(p,operation,options)=>{const f=fixture(operation,options);p.paymentEvidence=f.paymentEvidence;p.sellerAnswer.signedProjection=f.sellerAnswer.signedProjection;};
  // Native Deliverable receipts are compared on the fields the readback compares.
  const nativeReceipt=(jobId,observedAt)=>({receiptVersion:'1',substrate:'demos',finalityProfile:'demos-bft-confirmed-native-read',logicalAddress:`dacs4:deliverable:${jobId}`,nativeAddress:'0xTEST',
    contentHash:'f'.repeat(64),writer:'did:demos:agent:TEST',nonce:'1',state:'finalized',observationDisposition:'established',transactionRef:{kind:'demos-storage-program',value:'7'.repeat(64)},
    blockRef:{id:'8'.repeat(64),height:'1',timestamp:1},observedAt,evidence:{kind:'demos-bft-write-proof-v1',value:`TEST-${observedAt}`}});
  const native=(p,observedAt)=>{const jobId=p.agreement.artifact.jobId;p.delivery.substrate='source-native-one-node-delivery';p.delivery.anchorReceipt=nativeReceipt(jobId,1);p.sellerAnswer.delivery.anchorReceipt=nativeReceipt(jobId,observedAt);};
  const status=/its delivery status differs from the verified delivery-ready/,cases={
    'pending delivery status':[(p)=>{p.sellerAnswer.delivery.status='pending';},status],
    'delivered answer over a delivery-ready purchase':[(p)=>{p.sellerAnswer.delivery.status='delivered';},status],
    'other delivery evidence hash':[(p)=>{p.sellerAnswer.delivery.evidenceHash='d'.repeat(64);},/its delivery evidence hash differs/],
    'other Deliverable receipt':[(p)=>{p.sellerAnswer.delivery.anchorReceipt={...p.sellerAnswer.delivery.anchorReceipt,TEST:'another receipt'};},/its Deliverable receipt differs/],
    'native Deliverable receipt for another transaction':[(p)=>{native(p,1);p.sellerAnswer.delivery.anchorReceipt.transactionRef={kind:'demos-storage-program',value:'6'.repeat(64)};},/its Deliverable receipt differs/],
    'no retained Agreement':[(p)=>{delete p.agreement;},/no retained Agreement names the payment-evidence address/],
    'Agreement for another job':[(p)=>{p.agreement.artifact={...p.agreement.artifact,jobId:generateCanonicalJobId()};},/the retained Agreement does not hash to its verified hash/],
    'payment evidence elsewhere':[(p)=>{p.paymentEvidence.ref.anchor.locator=`${p.paymentEvidence.ref.anchor.locator}:other`;},/the verified payment evidence is not at its canonical address/],
    'answer names another evidence address':[(p)=>{p.sellerAnswer.evidenceAddress=`${p.sellerAnswer.evidenceAddress}:other`;},/its payment-evidence address differs/],
    'no payment receipt':[(p)=>{delete p.paymentEvidence.anchorReceipt;},/no verified payment-evidence receipt is retained/],
    'payment receipt for other content':[(p)=>{p.paymentEvidence.ref.contentHash='b'.repeat(64);},/the payment-evidence receipt does not bind the canonical seller write/],
    'foreign payment receipt and projection':[(p,operation)=>{const f=foreign(operation);p.paymentEvidence=f.paymentEvidence;p.sellerAnswer.signedProjection=f.sellerAnswer.signedProjection;},/the payment-evidence receipt does not bind the canonical seller write/],
    'payment receipt and projection for another job':[(p,operation)=>{const f=fixture(operation,{jobId:generateCanonicalJobId()});p.paymentEvidence.anchorReceipt=f.paymentEvidence.anchorReceipt;p.sellerAnswer.signedProjection=f.sellerAnswer.signedProjection;},/the payment-evidence receipt does not bind the canonical seller write/],
    'foreign signed projection':[(p,operation)=>{p.sellerAnswer.signedProjection=foreign(operation).sellerAnswer.signedProjection;},/its signed projection names another transaction/],
    'projection content changed':[(p)=>{p.sellerAnswer.signedProjection.content.nonce=2;},/its signed projection content does not hash to its transaction/],
    'projection signature not the authenticated one':[(p)=>{p.sellerAnswer.signedProjection.signature={type:'ed25519',data:other.signHex(p.sellerAnswer.signedProjection.hash)};},/its signed projection is not the one the payment-evidence receipt authenticated/],
    'projection signed by another wallet':[(p,operation)=>unauthorized(p,operation,{signer:other}),/its signed projection lacks the seller's authorization/],
    'projection from another address':[(p,operation)=>unauthorized(p,operation,{from:other.address}),/its signed projection lacks the seller's authorization/],
    'projection with another signature type':[(p)=>{const signed=p.sellerAnswer.signedProjection,evidence=p.paymentEvidence.anchorReceipt.evidence;signed.signature={...signed.signature,type:'TEST'};
      const proof=JSON.parse(Buffer.from(evidence.value,'base64url'));proof.signedTransactionHash=demosSignedTransactionProofHash(signed);evidence.value=Buffer.from(canonicalize(proof)).toString('base64url');},/its signed projection lacks the seller's authorization/],
  };
  const bad=Object.entries(cases).map(([name,[edit,expected]],index)=>{const operation=w.delegated(`mismatch-${index}`);w.move(operation,'settled_verified','delivery-ready');edit(operation.state.protocol,operation);return[name,operation,expected];});
  const valid=w.delegated('valid');w.move(valid,'settled_verified','delivery-ready');
  const validNative=w.delegated('valid-native');w.move(validNative,'settled_verified','delivery-ready');native(validNative.state.protocol,2);
  w.advance(LIFETIME+4*GRACE);w.restart();
  const swept=w.sweep(),reason=(operation)=>swept.kept.find((item)=>item.operationId===operation.id)?.reason??'';
  assert.deepEqual(ids(swept.deleted),['valid','valid-native'],JSON.stringify(swept.kept.filter((item)=>!/^mismatch-/.test(item.operationId))));
  for(const [name,operation,expected] of bad){
    assert.equal(existsSync(w.keyFile(operation)),true,name);
    assert.equal(existsSync(w.retiredFile(operation)),false,name);
    assert.match(reason(operation),/^final purchase's retained seller answer cannot authenticate it: /,name);
    assert.match(reason(operation),expected,`${name}: ${reason(operation)}`);
  }
  // The kept key still signs the seller-backed recheck that can retain a corrected answer.
  assert.ok(w.store.signerFor(bad[0][1]).sign(Buffer.from('readback')));
});

// The readback re-reads with the retained Agreement, so it must be the one the
// buyer verified, carrying this purchase's terms: one case per binding. Term
// edits re-hash the Agreement and its reference, so only the term differs.
test('a retained Agreement that is not the verified one, or names other terms, keeps the key',t=>{
  const w=setup(t),other=createEphemeralWallet();
  const rehashed=(edit)=>(p)=>{const artifact=structuredClone(p.agreement.artifact);edit(artifact);const hash=contentHash(artifact);p.agreement={...p.agreement,artifact,hash,ref:{...p.agreement.ref,contentHash:hash}};};
  const payout=(artifact)=>artifact.terms.payoutBindings[0],party=(artifact,role)=>artifact.parties.find((item)=>item.role===role);
  const terms=(name)=>new RegExp(`the retained Agreement differs from the purchase terms \\(${name}\\)`),cases={
    // a review case: only the price changes; the verified hash stays.
    'price changed under the verified hash':[(p)=>{p.agreement.artifact.terms.price.amount='2';},/the retained Agreement does not hash to its verified hash/],
    'another verified hash':[(p)=>{p.agreement.hash='b'.repeat(64);p.agreement.ref.contentHash='b'.repeat(64);},/the retained Agreement does not hash to its verified hash/],
    'no verified hash':[(p)=>{delete p.agreement.hash;},/the retained Agreement does not hash to its verified hash/],
    'reference at another address':[(p)=>{p.agreement.ref.anchor.locator=`${p.agreement.ref.anchor.locator}:other`;},/the retained Agreement reference is not canonical for its hash/],
    'reference to another hash':[(p)=>{p.agreement.ref.contentHash='b'.repeat(64);},/the retained Agreement reference is not canonical for its hash/],
    'reference on another substrate':[(p)=>{p.agreement.ref.anchor.kind='TEST';},/the retained Agreement reference is not canonical for its hash/],
    'no reference':[(p)=>{delete p.agreement.ref;},/the retained Agreement reference is not canonical for its hash/],
    'another job':[rehashed((a)=>{a.jobId=generateCanonicalJobId();}),terms('job')],
    'another buyer':[rehashed((a)=>{party(a,'buyer').primaryClaim=other.claim;}),terms('parties')],
    'another seller':[rehashed((a)=>{party(a,'seller').primaryClaim=other.claim;}),terms('parties')],
    'another Listing':[rehashed((a)=>{a.listingRef.version=2;}),terms('listing')],
    'another payee':[rehashed((a)=>{payout(a).payeeAddress=other.address;}),terms('payee')],
    'another price':[rehashed((a)=>{a.terms.price.amount='2';}),terms('price')],
    // The shared Agreement/operation validator names a rail mismatch "payee".
    'another rail':[rehashed((a)=>{payout(a).railId='TEST:rail';}),terms('payee')],
    'another payment phase':[rehashed((a)=>{payout(a).phaseIndex=1;}),terms('phase')],
  };
  const bad=Object.entries(cases).map(([name,[edit,expected]],index)=>{const operation=w.delegated(`agreement-${index}`);w.move(operation,'settled_verified','delivery-ready');edit(operation.state.protocol,operation);return[name,operation,expected];});
  const valid=w.delegated('valid');w.move(valid,'settled_verified','delivery-ready');
  w.advance(LIFETIME+4*GRACE);w.restart();
  const swept=w.sweep(),reason=(operation)=>swept.kept.find((item)=>item.operationId===operation.id)?.reason??'';
  assert.deepEqual(ids(swept.deleted),['valid'],JSON.stringify(swept.deleted));
  for(const [name,operation,expected] of bad){
    assert.equal(existsSync(w.keyFile(operation)),true,name);
    assert.equal(existsSync(w.retiredFile(operation)),false,name);
    assert.match(reason(operation),/^final purchase's retained seller answer cannot authenticate it: /,name);
    assert.match(reason(operation),expected,`${name}: ${reason(operation)}`);
  }
});

// Delivery evidence can publish after the seller answered delivery-ready; the
// buyer then verifies delivered from the same pointer. Only that promotion is
// accepted, and the evidence and receipt bindings still hold.
test('a delivery-ready answer for a purchase verified delivered retires its key; no other status change does',t=>{
  const w=setup(t);
  const promoted=w.delegated('promoted');w.move(promoted,'settled_verified','delivered');promoted.state.protocol.sellerAnswer.delivery.status='delivery-ready';
  const otherEvidence=w.delegated('other-evidence');w.move(otherEvidence,'settled_verified','delivered');
  Object.assign(otherEvidence.state.protocol.sellerAnswer.delivery,{status:'delivery-ready',evidenceHash:'d'.repeat(64)});
  const pending=w.delegated('pending');w.move(pending,'settled_verified','delivered');pending.state.protocol.sellerAnswer.delivery.status='pending';
  const demoted=w.delegated('demoted');w.move(demoted,'settled_verified','delivery-ready');demoted.state.protocol.sellerAnswer.delivery.status='delivered';
  w.advance(LIFETIME+4*GRACE);
  const swept=w.sweep(),reason=(operation)=>swept.kept.find((item)=>item.operationId===operation.id)?.reason??'';
  assert.deepEqual(ids(swept.deleted),['promoted'],JSON.stringify(swept.kept));
  assert.match(reason(otherEvidence),/its delivery evidence hash differs/);
  assert.match(reason(pending),/its delivery status differs from the verified delivered/);
  assert.match(reason(demoted),/its delivery status differs from the verified delivery-ready/);
  for(const operation of [otherEvidence,pending,demoted])assert.equal(existsSync(w.keyFile(operation)),true,operation.id);
});

test('expired sweep: a cancelled purchase keeps its key while the delegation is live; an abandoned one goes after its approval window',t=>{
  const w=setup(t),cancelled=w.delegated('cancelled'),abandoned=w.delegated('abandoned');
  w.move(cancelled,'cancelled','seller-committed');
  w.advance(WINDOW+GRACE);
  let swept=w.sweep();
  assert.deepEqual(ids(swept.deleted),['abandoned'],'approval window elapsed plus grace, never persisted as expired');
  assert.match(swept.kept.find((item)=>item.operationId==='cancelled').reason,/delegation still live/);
  w.advance(LIFETIME-WINDOW-GRACE);
  swept=w.sweep();assert.deepEqual(swept.deleted,[]);assert.match(swept.kept[0].reason,/inside the grace window/);
  w.advance(GRACE);w.restart();
  swept=w.sweep();assert.deepEqual(ids(swept.deleted),['cancelled']);
  assert.match(swept.deleted[0].reason,/cancelled and delegation expired/);
});

test('finished purchase polling and signer activity do not extend retirement',t=>{
  const w=setup(t),operation=w.delegated('polling');w.move(operation,'settled_verified','delivery-ready');
  operation.state.protocol.sellerSessionFinalAt=w.now();
  const signer=w.store.signerFor(operation);
  for(let n=0;n<8;n++){w.advance(10*60000);w.move(operation,'settled_verified','delivery-ready');signer.sign(Buffer.from('readback'));}
  w.restart();
  assert.deepEqual(ids(w.sweep().deleted),['polling']);
});

test('retirement revokes a signer already handed out, including across store instances',t=>{
  const w=setup(t),operation=w.delegated('handle'),signer=w.store.signerFor(operation);
  w.move(operation,'expired');w.advance(GRACE);w.restart();
  assert.deepEqual(ids(w.sweep().deleted),['handle']);
  assert.throws(()=>signer.sign(Buffer.from('must not sign')),{code:'seller_session_retired'});
});

test('records that cannot be read or matched are kept and the sweep continues',t=>{
  const w=setup(t),ended=w.delegated('ended'),missing=w.delegated('missing'),changed=w.delegated('changed'),failing=w.delegated('failing');
  for(const operation of [ended,missing,changed,failing])w.move(operation,'expired');
  w.purchases.delete('missing');
  w.purchases.set('changed',{...changed,terms:{...changed.terms,buyer:{wallet:createEphemeralWallet().address}}});
  const lookup=w.lookup;
  writeFileSync(join(w.directory,`${'f'.repeat(64)}.json`),'{"not":"a session key"}\n',{mode:0o600});
  w.advance(GRACE);
  const swept=w.store.sweep((input)=>{if(input.operationId==='failing')throw new Error('TEST purchase store unavailable');return lookup(input);});
  assert.deepEqual(ids(swept.deleted),['ended']);
  const reasons=Object.fromEntries(swept.kept.map((item)=>[item.operationId??item.key,item.reason]));
  assert.equal(reasons.missing,'purchase not found');
  assert.equal(reasons.changed,'purchase differs from the session key scope');
  assert.match(reasons.failing,/purchase lookup failed: TEST purchase store unavailable/);
  assert.match(reasons['f'.repeat(64)],/unreadable record/);
  for(const operation of [missing,changed,failing])assert.equal(existsSync(w.keyFile(operation)),true);
});

test('malformed purchase scope is retained before an eligible valid purchase, on every sweep',t=>{
  const w=setup(t),[malformed,valid]=[w.delegated('malformed'),w.delegated('valid')].sort((a,b)=>w.keyFile(a).localeCompare(w.keyFile(b)));
  for(const operation of [malformed,valid])w.move(operation,'expired');
  malformed.terms={};w.advance(GRACE);
  const swept=w.sweep();
  assert.deepEqual(ids(swept.deleted),[valid.id]);
  assert.match(swept.kept[0].reason,/purchase differs from the session key scope/);
  assert.equal(existsSync(w.keyFile(malformed)),true);
  assert.equal(existsSync(w.retiredFile(malformed)),false);
  // Missing/null/nested incomplete terms all fail closed rather than throw.
  for(const terms of [undefined,null,{}, {buyer:{}}, {buyer:{wallet:'invalid'}}, {...valid.terms,listing:{}}, {...valid.terms,protocol:{}}]){
    malformed.terms=terms;
    assert.equal(w.sweep().kept.length,1);
    assert.equal(existsSync(w.keyFile(malformed)),true);
  }
});

test('a failure during a retirement decision retains that record and continues',t=>{
  const w=setup(t),[broken,valid]=[w.delegated('broken-decision'),w.delegated('valid-decision')].sort((a,b)=>w.keyFile(a).localeCompare(w.keyFile(b)));
  for(const operation of [broken,valid])w.move(operation,'expired');
  Object.defineProperty(broken,'updatedAt',{get(){throw new Error('TEST unreadable final state');}});
  w.advance(GRACE);
  const swept=w.sweep();
  assert.deepEqual(ids(swept.deleted),[valid.id]);
  assert.match(swept.kept[0].reason,/record processing failed: TEST unreadable final state/);
  assert.equal(existsSync(w.keyFile(broken)),true);
  assert.equal(existsSync(w.retiredFile(broken)),false);
});

function worker(t,fixture,mode){
  const child=fork(new URL('./helpers/seller-session-lock-worker.mjs',import.meta.url),[fixture,mode],{stdio:['ignore','ignore','pipe','ipc']});
  t.after(()=>child.kill('SIGKILL'));
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  const messages=[],waiters=[];
  child.on('message',message=>{const waiter=waiters.shift();if(waiter)waiter.resolve(message);else messages.push(message);});
  child.on('exit',code=>{for(const waiter of waiters.splice(0))waiter.reject(new Error(`worker exited ${code}: ${stderr}`));});
  return{child,next:()=>messages.length?Promise.resolve(messages.shift()):new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`worker response timeout: ${stderr}`)),15000);
    waiters.push({resolve:message=>{clearTimeout(timer);resolve(message);},reject:error=>{clearTimeout(timer);reject(error);}});
  })};
}

async function signingRace(t,mode,checkpoint){
  const w=setup(t),operation=w.delegated('process-race');
  w.move(operation,'expired');w.advance(GRACE);
  const fixture=join(w.directory,'worker-fixture'),release=join(w.directory,'release-sign');
  writeFileSync(fixture,JSON.stringify({directory:w.directory,operation,time:w.now(),release,retiredFile:w.retiredFile(operation)}),{mode:0o600});
  const signer=worker(t,fixture,mode),sweeper=worker(t,fixture,'sweep');
  assert.deepEqual(await signer.next(),{ready:true});assert.deepEqual(await sweeper.next(),{ready:true});
  signer.child.send('sign');assert.deepEqual(await signer.next(),checkpoint);
  // The other process pauses either at the marker check or at crypto.sign.
  sweeper.child.send('sweep');const during=await sweeper.next();
  const retiredDuringSign=existsSync(w.retiredFile(operation));
  writeFileSync(release,'release',{mode:0o600});const signed=await signer.next();
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(operation.state.protocol.sessionDelegation.payload.sessionPublicKey,'hex')]),type:'spki',format:'der'});
  assert.equal(verify(null,Buffer.from('race request'),key,Buffer.from(signed.signature,'hex')),true);
  assert.equal(retiredDuringSign,false,'retirement must not publish a marker while a signature is in flight');
  assert.deepEqual(during.deleted,[]);assert.match(during.kept[0].reason,/session.*lock/i);
  assert.equal(existsSync(w.keyFile(operation)),true);
  sweeper.child.send('sweep');assert.deepEqual(ids((await sweeper.next()).deleted),[operation.id]);
  signer.child.send('sign');assert.deepEqual(await signer.next(),{error:'seller_session_retired'});
}
test('separate processes serialize signing with retirement from marker check through crypto.sign',{timeout:45000},t=>signingRace(t,'sign',{signEntered:true}));
test('separate processes hold the lock before checking the retired marker',{timeout:45000},t=>signingRace(t,'sign-pause-marker',{markerChecked:true}));

test('an old orphaned lock fails closed for signing and cleanup, without blocking later purchases',t=>{
  const w=setup(t),[locked,valid]=[w.delegated('orphaned-lock'),w.delegated('after-lock')].sort((a,b)=>w.keyFile(a).localeCompare(w.keyFile(b)));
  const signer=w.store.signerFor(locked),lock=join(w.directory,`${sha256Hex(locked.id)}.lock`);
  writeFileSync(lock,'999999999\n',{mode:0o600});utimesSync(lock,new Date(0),new Date(0));
  assert.throws(()=>signer.sign(Buffer.from('must not sign')),{code:'seller_session_locked'});
  for(const operation of [locked,valid])w.move(operation,'expired');w.advance(GRACE);
  const swept=w.sweep();
  assert.deepEqual(ids(swept.deleted),[valid.id]);
  assert.match(swept.kept[0].reason,/record processing failed: seller session lock exists/);
  assert.equal(readFileSync(lock,'utf8'),'999999999\n','a lock is never stolen based on its age or PID');
  assert.equal(existsSync(w.keyFile(locked)),true);assert.equal(existsSync(w.retiredFile(locked)),false);
  // Simulate explicit recovery after confirming the holder stopped.
  rmSync(lock);assert.ok(signer.sign(Buffer.from('readback after recovery')));
  assert.deepEqual(ids(w.sweep().deleted),[locked.id]);
});

test('signing releases its lock on success and exceptions, and sweep looks up eligibility while locked',t=>{
  const previousUmask=process.umask(0o022);t.after(()=>process.umask(previousUmask));
  const w=setup(t),operation=w.delegated('lock-release'),signer=w.store.signerFor(operation),lock=join(w.directory,`${sha256Hex(operation.id)}.lock`);
  assert.throws(()=>signer.sign(undefined));assert.equal(existsSync(lock),false,'crypto.sign errors release the lock');
  assert.ok(signer.sign(Buffer.from('valid')));assert.equal(existsSync(lock),false,'successful signing releases the lock');
  w.move(operation,'expired');w.advance(GRACE);
  const swept=w.store.sweep(input=>{
    assert.equal(existsSync(lock),true,'lookup runs under the interprocess lock');
    assert.equal(statSync(lock).mode&0o777,0o600);
    // The latest purchase may have returned to unresolved seller work.
    operation.status='payment_uncertain';return w.lookup(input);
  });
  assert.deepEqual(swept.deleted,[]);assert.match(swept.kept[0].reason,/payment outcome unresolved/);
  assert.equal(existsSync(w.keyFile(operation)),true);assert.equal(existsSync(w.retiredFile(operation)),false);
  assert.equal(existsSync(lock),false);assert.ok(signer.sign(Buffer.from('readback')));
});

test('retirement in a child process holds the lock until key unlink completes',{timeout:45000},async t=>{
  const w=setup(t),operation=w.delegated('unlink-lock');w.move(operation,'expired');w.advance(GRACE);
  const fixture=join(w.directory,'worker-fixture'),release=join(w.directory,'release-unlink'),lock=join(w.directory,`${sha256Hex(operation.id)}.lock`);
  writeFileSync(fixture,JSON.stringify({directory:w.directory,operation,time:w.now(),release,keyFile:w.keyFile(operation)}),{mode:0o600});
  const signer=worker(t,fixture,'sign'),sweeper=worker(t,fixture,'sweep-pause-unlink');
  assert.deepEqual(await signer.next(),{ready:true});assert.deepEqual(await sweeper.next(),{ready:true});
  sweeper.child.send('sweep');assert.deepEqual(await sweeper.next(),{unlinkEntered:true});
  assert.equal(existsSync(w.retiredFile(operation)),true);assert.equal(existsSync(w.keyFile(operation)),true);
  assert.equal(existsSync(lock),true,'retirement keeps the lock until after unlink');
  signer.child.send('sign');assert.deepEqual(await signer.next(),{error:'seller_session_locked'});
  writeFileSync(release,'release',{mode:0o600});assert.deepEqual(ids((await sweeper.next()).deleted),[operation.id]);
  assert.equal(existsSync(lock),false);assert.equal(existsSync(w.keyFile(operation)),false);
  signer.child.send('sign');assert.deepEqual(await signer.next(),{error:'seller_session_retired'});
});

test('the sweep revokes its own handed-out handles before unlink, even if the marker is subsequently removed',t=>{
  const w=setup(t),operation=w.delegated('same-process'),signer=w.store.signerFor(operation);
  w.move(operation,'expired');w.advance(GRACE);
  assert.deepEqual(ids(w.sweep().deleted),['same-process']);rmSync(w.retiredFile(operation));
  assert.throws(()=>signer.sign(Buffer.from('must not sign')),{code:'seller_session_retired'});
});

test('a failed unlink still revokes existing handles and can be retried as local cleanup',t=>{
  const w=setup(t),operation=w.delegated('unlink-failed'),signer=w.store.signerFor(operation),record=readFileSync(w.keyFile(operation));
  w.move(operation,'expired');w.advance(GRACE);
  const swept=w.store.sweep(input=>{rmSync(w.keyFile(operation));mkdirSync(w.keyFile(operation),{mode:0o700});return w.lookup(input);});
  assert.deepEqual(swept.deleted,[]);assert.match(swept.kept[0].reason,/deletion incomplete/);
  assert.equal(existsSync(w.retiredFile(operation)),true);
  assert.throws(()=>signer.sign(Buffer.from('must not sign')),{code:'seller_session_retired'});
  rmSync(w.keyFile(operation),{recursive:true});writeFileSync(w.keyFile(operation),record,{mode:0o600});
  assert.deepEqual(ids(w.sweep().deleted),['unlink-failed']);
});
