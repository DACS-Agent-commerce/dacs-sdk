// closed-access-19-resend on the operator buyer driver's path. While access is
// open, a purchase's seller pay-dem SettlementEvidence CREATE is answered as
// relayed but never applied (lost), and its status reads are unavailable, so
// #19 has not resent it yet. The operator restarts closed with a different
// custody buyer, which makes that retained job foreign. The custody buyer
// driver's evidence-lane check (operator.mjs reconcileSellerEvidenceLane) then
// resends the foreign bytes once, unchanged, and the operator logs that one
// resend under the foreign job. Before the purchase store is attached the
// job's closed access is reported as unknown, never as outside.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';
import { bootstrapTestWalletCustody } from '../src/devnet-demo/operator-custody.mjs';

const reply=(value)=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
const captureStderr=(t)=>{
  const lines=[],write=process.stderr.write;
  process.stderr.write=function(chunk,...rest){if(String(chunk).startsWith('closed-access-19-resend'))lines.push(String(chunk));return write.call(this,chunk,...rest);};
  t.after(()=>{process.stderr.write=write;});return lines;
};

test('closed-access-19-resend: the buyer driver resends a lost foreign evidence write once and logs it under that job',{timeout:600000},async t=>{
  const lines=captureStderr(t),broadcasts=[],sellerApprovals=[],access=[];
  let h=null,lostHash=null,closed=false,foreignJob=null;
  const applied=()=>h?.node2.chain.wire.record.accepted.some((tx)=>tx.hash===lostHash);
  const rpcFault=async({url,body,headers:authHeaders})=>{
    const call=body?.params?.[0],sellerAddress=h?`0x${h.prepared.operatorEvidence.seller.slice('did:demos:agent:'.length)}`:null;
    // #19's strict recovery reads exact node envelopes and confirmation shapes;
    // like its own lost-once fixtures, this stub's answers are given them.
    const forward=async(headers={})=>(await h.node2.fetchImpl(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)})).json();
    if(closed&&lostHash&&!applied()){
      if(call?.message==='getBlockByNumber'&&call.data?.blockNumber===0)return reply({...await forward(),extra:''});
      if(call?.message==='getAddressNonce'&&call.data?.address===sellerAddress){const answer=await forward();return reply({result:200,response:answer.response,require_reply:false,extra:null});}
      if(call?.extra==='confirmTx'&&call.data?.hash===lostHash){
        const answer=await forward(authHeaders);
        return reply({result:200,response:{data:{reference_block:0,message:'[Tx Validation] Transaction signature verified\n',...answer.response.data},signature:{type:'ed25519',data:'0x'+'11'.repeat(64)},rpc_public_key:{type:'ed25519',data:'0x'+'22'.repeat(32)}},require_reply:false,extra:null});
      }
    }
    if(call?.extra==='broadcastTx'){
      const tx=call.data?.response?.data?.transaction,op=tx?.content?.data?.[1];broadcasts.push(tx?.hash);
      if(!lostHash&&op?.metadata?.artifactKind==='SettlementEvidence'&&op?.data?.phase==='pay-dem'){lostHash=tx.hash;foreignJob=op.data.jobId;return reply({result:200,response:{message:'Transaction relayed to validators'},require_reply:false,extra:{confirmationBlock:2}});}
    }
    if(!lostHash||applied()||call?.data?.hash!==lostHash)return null;
    // Open: the lost write's status is unavailable, so nothing proves it absent.
    if(!closed&&call?.message==='getTransactionStatus')return reply({result:500,response:'error',require_reply:false,extra:null});
    if(closed&&call?.message==='getTransactionStatus')return reply({result:200,response:{state:'unknown'},require_reply:false,extra:''});
    if(closed&&call?.message==='getTxByHash')return reply({result:400,response:'error',require_reply:false,extra:null});
    return null;
  };
  h=await startOperatorPurchaseNode2({openBuyerAccess:true,rpcFault,authorizeSellerApproval:(input)=>{sellerApprovals.push({closed,jobId:input.request?.content?.jobId});return true;},
    authorizeBuyerApproval:()=>!closed,beforeAttach:({composition})=>{if(foreignJob)access.push(['before attach',composition.dacsProtocol.buyerAccess.jobAccess?.(foreignJob)??'no jobAccess']);}});
  t.after(()=>h.close());
  const first=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'foreign-evidence-lost'}).catch((error)=>({status:'error',error:error.message}));
  assert.ok(lostHash,`a seller pay-dem evidence write was issued and lost (${JSON.stringify(first)})`);
  assert.equal(first.jobId??foreignJob,foreignJob);
  const record=()=>h.prepared.composition.sourceCapability.journal.get(`devnet/native-transfer/${lostHash}`);
  assert.equal((await record()).storageWriteSubmission,'accepted');assert.equal((await record()).storageWriteResends,undefined,'not resent while open');
  assert.equal(broadcasts.filter((hash)=>hash===lostHash).length,1);assert.deepEqual(lines,[]);
  // A different configured custody buyer after restart makes the retained job foreign.
  const replacement=join(h.root,'replacement-custody');
  await bootstrapTestWalletCustody({directory:replacement,publicOrigin:h.config.publicOrigin});
  await copyFile(join(replacement,'buyer-wallet.json'),join(h.config.custodyDirectory,'buyer-wallet.json'));
  h.config.openBuyerAccess=false;await writeFile(h.configPath,JSON.stringify(h.config));
  closed=true;await h.restart();
  access.push(['attached',h.composition.dacsProtocol.buyerAccess.jobAccess?.(foreignJob)??'no jobAccess']);
  const approvalsBefore=sellerApprovals.length;
  // The lane check runs first; the new custody buyer then declines its own
  // sign-in (this test approves no buyer request after closure).
  const second=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'custody-after-closure'}).catch((error)=>({status:'buyer-declined',code:error.code}));
  assert.deepEqual(second,{status:'buyer-declined',code:'user_rejected'},'the seller evidence lane was ready, not held');
  assert.equal(broadcasts.filter((hash)=>hash===lostHash).length,2,'the foreign bytes were resent once, unchanged');
  assert.equal((await record()).storageWriteResends,1);assert.ok(applied());
  assert.equal(sellerApprovals.slice(approvalsBefore).filter((entry)=>entry.jobId===foreignJob).length,0,'no new seller approval for the foreign job');
  assert.equal(lines.length,1,JSON.stringify(lines));
  assert.deepEqual(access,[['before attach','unknown'],['attached','outside']]);
  assert.equal(lines[0],`closed-access-19-resend: job ${foreignJob} tx ${lostHash}: one unchanged resend of an accepted but missing seller write for a job outside closed access; no new transaction signature, approval or nonce\n`);
});
