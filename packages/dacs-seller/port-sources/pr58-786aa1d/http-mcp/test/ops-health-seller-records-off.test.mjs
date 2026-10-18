import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalize, fixedPriceAgreementLogicalAddress } from '@kynesyslabs/dacs';
import { openDatabase } from '../src/store/database.mjs';
import { createAccountService } from '../src/accounts.mjs';
import { createOperationStore } from '../src/operations.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { formatOpsHealth, opsHealth } from '../src/ops/health.mjs';

// With seller records off, ops health is main's (a review). Every
// assertion here also holds on main: this file runs unchanged against main's
// tree, so the two are shown to agree. The seller-records cases are in
// test/ops-health.test.mjs.
const NOW=Date.now(),address=`0x${'a'.repeat(64)}`,wallet=`0x${'b'.repeat(64)}`;
const sha=(value)=>createHash('sha256').update(value).digest('hex');
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'ops-health-off-')),path=join(root,'app','dacs-chatgpt.sqlite');
  const db=openDatabase(path),accounts=createAccountService({db,builtinIssuer:'test',now:()=>NOW});
  const account=accounts.resolveFromToken({issuer:'test-external',subject:'fixture'}),ops=createOperationStore({db,handoffSecret:'TEST ONLY '.repeat(4),now:()=>NOW});
  const journals=[];
  t.after(()=>{for(const journal of journals)journal.close();db.close();rmSync(root,{recursive:true,force:true});});
  const operation=ops.createIdempotent({accountId:account.id,kind:'purchase',idempotencyKey:'1',request:{n:1},status:'awaiting_approval',terms:{buyer:{wallet},seller:{payee:address}},termsHash:'c'.repeat(64),expiresAt:new Date(NOW+3600000).toISOString(),state:{}}).operation;
  const transport=openDurableWalletJournal({path:join(root,'node2-transport.sqlite'),mode:'create'});journals.push(transport);
  return{root,operation,transport,report:(sellerApproval)=>opsHealth({databasePath:path,now:NOW,operatorState:root,sellerApproval})};
}
// The buyer's browser CREATE handoff as its producer writes it at each stage
// (src/portal/devnet-agreement-transport-broker.mjs).
function browserHandoff(operation,stage){
  const job='01ARZ3NDEKTSV4RRFFQ69G5FAV',agreementHash='e'.repeat(64);
  const binding={account:'acct_fixture',operation:operation.id,wallet,'terms-hash':'c'.repeat(64),job,'agreement-hash':agreementHash,network:'demos-devnet',authorization:'one immutable Agreement CREATE; no payment or completion'};
  const request={method:'sendTransaction',params:[{kind:'devnet-agreement-storage-create',profile:'devnet-agreement',network:binding.network,owner:`did:demos:agent:${wallet.slice(2)}`,artifactKind:'Agreement',jobId:job,
    logicalAddress:fixedPriceAgreementLogicalAddress(job),contentHash:agreementHash,transaction:{content:{from:wallet}}}]};
  return{version:1,binding,correlation:'x'.repeat(32),request,requestHash:sha(canonicalize(request)),expiresAt:NOW+120000,stage,
    ...(['completed','uncertain'].includes(stage)?{transactionHash:'f'.repeat(64)}:{}),...(['uncertain','denied'].includes(stage)?{errorCode:'TEST_wallet_error'}:{})};
}
// Seller records off: no operator config, or one without purchaseSource "seller" (main has no purchaseSource).
const OFF=[undefined,{mode:'manual'},{mode:'policy'}];

test('seller records off: a buyer browser CREATE handoff in the source journal exits 2 at every stage but denied, which no seller owns, as on main',async t=>{
  for(const sellerApproval of OFF){
    const h=fixture(t),key=`devnet-browser-agreement/create/${h.operation.id}`;
    for(const stage of ['queued','issued-to-browser','expired','completed','uncertain']){
      await h.transport.put(key,browserHandoff(h.operation,stage));
      assert.throws(()=>h.report(sellerApproval),/could not read valid state/,`${JSON.stringify(sellerApproval)} ${stage}`);
    }
    await h.transport.put(key,browserHandoff(h.operation,'denied'));
    const report=h.report(sellerApproval);
    assert.deepEqual(report.seller.unconfirmed,[]);assert.equal(report.healthy,true);
  }
});

test('seller records off: the seller budget of an app-mode policy ledger has main\'s fields and line',async t=>{
  const h=fixture(t),evidence=join(h.root,'evidence');mkdirSync(evidence);
  const request={method:'sendTransaction',address,content:{artifactKind:'SettlementEvidence',jobId:'01ARZ3NDEKTSV4RRFFQ69G5FAV',wallet:address,nonce:1,timestamp:1,exactCreate:'{}',debit:{totalOs:'4000000000'}}};
  const requestBytes=JSON.stringify(request),approvalHash=sha(requestBytes),reservationId='TEST-app-reservation';
  writeFileSync(join(evidence,'seller-approvals.jsonl'),`${JSON.stringify({format:'dacs-node2-operator-approval-evidence/v1',approvalHash,requestBytes,method:'sendTransaction',address,totalOs:'4000000000',decision:'approved',approvalMode:'policy',policyReason:null,reservationId,recordedAt:NOW-1000})}\n`
    +`${JSON.stringify({format:'dacs-node2-seller-policy-attempt/v1',reservationId,approvalHash,outcome:'spent',recordedAt:NOW-500})}\n`);
  for(const sellerApproval of OFF){
    const report=h.report(sellerApproval),budget=report.seller.budget;
    assert.deepEqual(Object.keys(report.seller),['policyMode','limitsSource','budget','journals','unconfirmed']);
    assert.deepEqual(Object.keys(budget),['window','writes','maxWrites','totalOs','totalDem','maxTotalOs','maxTotalDem','status','inFlightPreparation']);
    assert.deepEqual([budget.writes,budget.totalOs,budget.inFlightPreparation.counted],[1,'4000000000',false]);
    assert.match(formatOpsHealth(report),/^seller budget rolling-hour writes=1\/24 DEM=4\.000000000\/96\.000000000 ok \(approvals; excludes ≤1 in-flight preparation\)$/m);
    assert.doesNotMatch(formatOpsHealth(report),/seller held /);
  }
});
