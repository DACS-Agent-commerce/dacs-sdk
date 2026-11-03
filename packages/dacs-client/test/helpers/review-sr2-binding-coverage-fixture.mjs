// Offline-only SR-2 binding interaction helper. Source traffic is served by the
// injected .invalid stubs of the exact-current Node2 coverage fixture. No
// signer, wallet, CREATE submission, payment or broadcast is reachable: plan
// and handoff records stay unsigned in an in-memory adapter journal.
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal } from '../../src/dacs/demos-sr2-adapter.mjs';
import { ENDPOINT, NOW, WRITER, label } from './review-node2-current-coverage-fixture.mjs';

export const NONCE={getAddressNonce:{result:200,response:7}};
export const PLAN_INPUT=Object.freeze({logicalAddress:'dacs4:agreement:review-sr2-binding-coverage',artifact:{kind:'review-sr2-binding-coverage',value:1},writer:WRITER,receiptContentHash:label('sr2-binding-receipt')});
// The adapter's documented acceptance shape for a source observation
// (demos-sr2-adapter.mjs:151-156), written independently for data-pin checks.
export const OBSERVATION_KEYS=['bindingId','bindingVersion','chainIdentity','connectionId','endpoint','expiresAt','network','observedAt','pinVersion','source','transportAuthority'];
export const DECLARED_KEYS=['bindingVersion','bindingId','network','chainIdentity','pinVersion','endpoint','transportAuthority'];

// Writable in-memory adapter journal for unsigned plan/handoff stages only.
export function planningAdapter(sourceCapability){
  const memory=createInMemoryDemosSr2Journal(),stages=[];
  const journal={...memory,put:async(record)=>{stages.push(record.stage);return memory.put(record);}};
  return {stages,journal,adapter:createDemosSr2Adapter({rpcUrl:ENDPOINT,sourceCapability,journal,now:()=>NOW})};
}

// Fixture (no sourceCapability) branch over an injected stub: the literal
// loopback URL is only compared as a string; no socket is opened.
export const FIXTURE_RPC='http://127.0.0.1:9/';
export function fixtureStub(answers){
  const calls=[];
  const fetchImpl=async(input,init={})=>{
    const call=JSON.parse(init.body).params[0];calls.push(call.message==='getBlockByNumber'?`block:${call.data.blockNumber}`:call.message);
    const key=call.message==='getBlockByNumber'?call.data.blockNumber:call.message;
    if(!Object.hasOwn(answers,key))throw new Error('TEST fixture stub refused an unexpected request');
    return new Response(JSON.stringify(answers[key]),{status:200,headers:{'content-type':'application/json','x-dacs-simulation':'fixture'}});
  };
  return {fetchImpl,calls};
}
