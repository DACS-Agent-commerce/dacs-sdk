import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExactOperatorApproval } from '../src/devnet-demo/operator-approval.mjs';
import { bootstrapTestWalletCustody } from '../src/devnet-demo/operator-custody.mjs';
import { admitObservedNode2Identity, createNode2TransportOwner, observeNode2Identity, readNode2Admission } from '../src/devnet-demo/operator-network.mjs';

const temp=async(t,prefix)=>{const path=await mkdtemp(join(tmpdir(),prefix));t.after(()=>rm(path,{recursive:true,force:true}));return path;};

test('single-node observation needs an exact reviewed identity and tampered admission is refused before use',async t=>{
  const endpoint='https://node2.test.invalid/',chainIdentity='a'.repeat(64);
  const observation=await observeNode2Identity({endpoint,network:'demos-devnet',now:()=>1000,fetchImpl:async()=>new Response(JSON.stringify({result:200,response:{number:0,status:'confirmed',hash:chainIdentity}}),{status:200,headers:{'content-type':'application/json'}})});
  assert.throws(()=>admitObservedNode2Identity({observation,authority:'TEST-RUN-controls-001',transportAuthority:'TEST-owner',pinVersion:'TEST-pin-v1',reviewedChainIdentity:'b'.repeat(64)}),/differs/);
  const admission=admitObservedNode2Identity({observation,authority:'TEST-RUN-controls-001',transportAuthority:'TEST-owner',pinVersion:'TEST-pin-v1',reviewedChainIdentity:chainIdentity,reviewedAt:1001});
  const dir=await temp(t,'operator-controls-'),path=join(dir,'admission.json');await writeFile(path,JSON.stringify({...admission,chainIdentity:'b'.repeat(64)}),{mode:0o600});
  await assert.rejects(readNode2Admission(path),/exact reviewed TEST record/);
});

test('fee ceiling refuses before authority callback and accepted evidence is public-only',async t=>{
  const dir=await temp(t,'operator-approval-'),evidencePath=join(dir,'evidence','approvals.jsonl');let calls=0;
  const approve=createExactOperatorApproval({maxTotalOs:'10',evidencePath,now:()=>7,authorize:()=>{calls++;return true;}});
  assert.equal(await approve({method:'sendTransaction',address:`0x${'a'.repeat(64)}`,content:{debit:{totalOs:'11'}}}),false);assert.equal(calls,0);
  assert.equal(await approve({method:'sendTransaction',address:`0x${'a'.repeat(64)}`,content:{debit:{totalOs:'10'}}}),true);assert.equal(calls,1);
  const row=JSON.parse((await readFile(evidencePath,'utf8')).trim());assert.deepEqual(Object.keys(row).sort(),['address','approvalHash','decision','format','method','recordedAt','requestBytes','totalOs']);assert.equal(row.decision,'approved');
});

test('wallet bootstrap separates roles, retains private modes and never returns a phrase',async t=>{
  const dir=await temp(t,'operator-custody-'),custody=join(dir,'wallets');const made=await bootstrapTestWalletCustody({directory:custody,publicOrigin:'http://127.0.0.1:8787'});
  assert.equal((await stat(custody)).mode&0o077,0);assert.equal(made.wallets.length,2);assert.notEqual(made.wallets[0].claim,made.wallets[1].claim);
  for(const wallet of made.wallets){assert.equal((await stat(wallet.path)).mode&0o077,0);assert.equal(Object.hasOwn(wallet,'mnemonic'),false);}
});

test('transport owner serializes the admitted run fence and refuses other origins',async()=>{
  const admission={network:'demos-devnet',endpoint:'https://node2.test.invalid/',transportAuthority:'TEST-owner'};
  const owner=createNode2TransportOwner({admission,fetchImpl:async()=>new Response('{}',{status:200})});
  const first=await owner.acquireConnectionFence();await assert.rejects(owner.acquireConnectionFence(),/already fenced/);first.release();const second=await owner.acquireConnectionFence();second.release();
  await assert.rejects(owner.fetchImpl('https://other.invalid/'),/outside its admitted endpoint/);owner.close();assert.throws(()=>owner.getContext(),/closed/);
});
