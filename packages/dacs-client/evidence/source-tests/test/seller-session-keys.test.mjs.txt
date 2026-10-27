import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, generateCanonicalJobId } from '@kynesyslabs/dacs';
import { createOperatorSellerSessions } from '../src/devnet-demo/operator-sessions.mjs';
import { sellerSessionDelegationSigningBytes, verifySellerSessionDelegation } from '../src/dacs/seller-transport-auth.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

function setup(t){
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'seller-session-keys-')));t.after(()=>rmSync(directory,{recursive:true}));
  const buyer=createEphemeralWallet(),seller=createEphemeralWallet(),time=Date.now();
  const operation={id:'purchase-a',accountId:'acct_a',expiresAt:new Date(time+600000).toISOString(),terms:{buyer:{wallet:buyer.address},seller:{claim:seller.claim},listing:{listingId:'listing',version:1,contentHash:'a'.repeat(64),anchor:{kind:'storage-program',locator:'fixture'}},protocol:{jobId:generateCanonicalJobId()}},state:{protocol:{listing:{terms:{deadlineSecAfterCommit:3600}}}}};
  return{directory,buyer,seller,time,operation,store:createOperatorSellerSessions({directory,now:()=>time})};
}

test('each purchase has one private session key; repeats and reconstruction retain it and only its public delegation leaves the store',t=>{
  const w=setup(t),request=w.store.request(w.operation);
  assert.equal(request.payload.expiresAt,w.time+3600000);
  assert.equal(request.payload.notBefore,w.time);
  assert.deepEqual(request.payload.listingPin,{listingId:'listing',version:1,contentHash:'a'.repeat(64)});
  assert.deepEqual(w.store.request(w.operation),request);
  w.operation.state.protocol.sessionDelegation={payload:request.payload};
  const signature=w.buyer.signHex(request.message),delegation=w.store.accept(w.operation,signature);
  w.operation.state.protocol.sessionDelegation=delegation;w.operation.state.protocol.planned={draft:{terms:{deadline:w.time+3600000}}};
  const signer=w.store.signerFor(w.operation),bytes=Buffer.from('fixture request');
  const restarted=createOperatorSellerSessions({directory:w.directory,now:()=>w.time});
  assert.deepEqual(restarted.request(w.operation),request);assert.deepEqual(restarted.signerFor(w.operation).sign(bytes),signer.sign(bytes));
  assert.equal(Object.hasOwn(delegation,'privateKey'),false);assert.equal(Object.hasOwn(request,'privateKey'),false);
  assert.equal(statSync(join(w.directory,readdirSync(w.directory)[0])).mode&0o777,0o600);
  const other=structuredClone(w.operation);other.id='purchase-b';other.terms.protocol.jobId=generateCanonicalJobId();delete other.state.protocol.sessionDelegation;
  assert.notEqual(w.store.request(other).payload.sessionPublicKey,request.payload.sessionPublicKey);
  const wrong=structuredClone(w.operation);wrong.terms.buyer.wallet=createEphemeralWallet().address;
  assert.throws(()=>w.store.signerFor(wrong),/scope/);
  // An expired delegation still yields the signer, for readback of journaled
  // seller effects only (the seller refuses new effects); a delegation that is
  // not yet valid does not.
  const expired=createOperatorSellerSessions({directory:w.directory,now:()=>request.payload.expiresAt});
  assert.deepEqual(expired.signerFor(w.operation).sign(bytes),signer.sign(bytes));
  const early=createOperatorSellerSessions({directory:w.directory,now:()=>request.payload.notBefore-1});
  assert.throws(()=>early.signerFor(w.operation),/peer_delegation_expired/);
  assert.equal(readdirSync(w.directory).length,2);
});

test('a missing or substituted retained session key fails closed without generating a replacement',t=>{
  const w=setup(t),request=w.store.request(w.operation);
  w.operation.state.protocol.sessionDelegation={payload:request.payload};
  const path=join(w.directory,readdirSync(w.directory)[0]),record=JSON.parse(readFileSync(path,'utf8'));
  record.payload.sessionPublicKey='b'.repeat(64);writeFileSync(path,JSON.stringify(record));
  assert.throws(()=>w.store.request(w.operation),/differs/);
  rmSync(path);
  assert.throws(()=>w.store.request(w.operation),/no replacement/);
  assert.equal(readdirSync(w.directory).length,0);
});

test('delegation encoding rejects unknown fields and unsigned lifetime or scope substitutions',t=>{
  const w=setup(t),request=w.store.request(w.operation),signed={payload:request.payload,signature:w.buyer.signHex(request.message)};
  assert.throws(()=>sellerSessionDelegationSigningBytes({...request.payload,extra:true}),/peer_delegation_invalid/);
  assert.throws(()=>verifySellerSessionDelegation({...signed,extra:true}),/peer_delegation_invalid/);
  for(const patch of [{buyer:[request.payload.buyer]},{seller:[request.payload.seller]},{sessionPublicKey:[request.payload.sessionPublicKey]},{listingPin:{...request.payload.listingPin,contentHash:[request.payload.listingPin.contentHash]}}])assert.throws(()=>sellerSessionDelegationSigningBytes({...request.payload,...patch}),/peer_delegation_invalid/);
  for(const patch of [{expiresAt:request.payload.expiresAt+1},{jobId:generateCanonicalJobId()},{buyer:createEphemeralWallet().claim},{sessionPublicKey:createEphemeralWallet().publicKeyRaw.toString('hex')}]){
    assert.throws(()=>verifySellerSessionDelegation({...signed,payload:{...request.payload,...patch}}),/peer_delegation_signature_invalid/);
  }
});

test('a wallet delegation signature with a repeated 0x prefix verifies as identity signatures do; malformed ones fail closed',t=>{
  const w=setup(t),request=w.store.request(w.operation),hex=w.buyer.signHex(request.message).slice(2);
  assert.equal(verifySellerSessionDelegation({payload:request.payload,signature:`0x0x${hex}`}).sessionPublicKey,request.payload.sessionPublicKey);
  assert.ok(verifySellerSessionDelegation({payload:request.payload,signature:`0X${hex.toUpperCase()}`}));
  w.operation.state.protocol.sessionDelegation={payload:request.payload};
  const delegation=w.store.accept(w.operation,`0x0x${hex}`);
  assert.equal(delegation.signature,Buffer.from(hex,'hex').toString('base64url'),'retained in canonical base64url form');
  for(const signature of ['zz',`0x0x${hex.slice(2)}`,`${hex}00`,'',`0x0x${'0'.repeat(128)}`])assert.throws(()=>verifySellerSessionDelegation({payload:request.payload,signature}),/peer_delegation_signature_invalid/,signature.slice(0,12));
  assert.throws(()=>w.store.accept(w.operation,'0x0xzz'),/peer_delegation_signature_invalid/);
});

test('issuance refuses more than 24 hours before creating a private key',t=>{
  const w=setup(t);
  for(const seconds of [86401,Number.MAX_SAFE_INTEGER,0,-1,1.5,'3600']){
    w.operation.state.protocol.listing.terms.deadlineSecAfterCommit=seconds;
    assert.throws(()=>w.store.request(w.operation),/24 hours/);assert.deepEqual(readdirSync(w.directory),[]);
  }
  w.operation.state.protocol.listing.terms.deadlineSecAfterCommit=86400;
  assert.equal(w.store.request(w.operation).payload.expiresAt-w.time,86400000);
});

test('seller verification rejects a correctly buyer-signed overlong delegation',t=>{
  const w=setup(t),request=w.store.request(w.operation),payload={...request.payload,expiresAt:request.payload.notBefore+86400001};
  const message=`dacs-chatgpt-plugin:seller-session-delegation:v1:${canonicalize(payload)}`;
  // Use SDK canonical bytes without the validator, as an arbitrary buyer can.
  const delegation={payload,signature:w.buyer.signHex(message)};
  assert.throws(()=>verifySellerSessionDelegation(delegation),/peer_delegation_invalid/);

});

test('operator acceptance refuses an overlong delegation even with a matching retained key and buyer signature',t=>{
  const w=setup(t),request=w.store.request(w.operation),payload={...request.payload,expiresAt:request.payload.notBefore+86400001};
  const message=`dacs-chatgpt-plugin:seller-session-delegation:v1:${canonicalize(payload)}`;
  const path=join(w.directory,readdirSync(w.directory)[0]),record=JSON.parse(readFileSync(path,'utf8'));
  record.payload=payload;writeFileSync(path,canonicalize(record));
  w.operation.state.protocol.sessionDelegation={payload};
  assert.throws(()=>w.store.accept(w.operation,w.buyer.signHex(message)),/peer_delegation_invalid/);
});
