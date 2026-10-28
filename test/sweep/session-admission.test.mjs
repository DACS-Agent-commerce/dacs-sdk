// DACS_SWEEP_NO_PARSER=1 node --loader ./test/sweep/source-loader.mjs --test test/sweep/session-admission.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = pathToFileURL(resolve(process.env.DACS_SWEEP_REPO ?? '.') + '/');
const { runSessionCore } = await import(new URL('src/agent/runSessionCore.ts', root));
const buyerId = 'did:demos:buyer';
const terms = { price:{amount:'1',asset:'USDC',decimals:6,rail:'pay-x402'}, deliveryPhase:'deliver-attested-payload', deliveryFormat:'application/json' };
function dependencies(jobId, calls) {
  return {
    buyerId,
    buyerIdentityBundle: {bundleVersion:'1',presentedBy:buyerId,presentedAt:1780000000000,claims:[{ref:buyerId}],presentation:{kind:'per-claim',signatures:[{ref:buyerId,signature:'test-presentation'}]}},
    authenticateBuyerIdentityBundle: () => true,
    readListing: async () => {calls.push('readListing');throw Error('admitted listing read');},
    sign: async a => {calls.push('sign');return {...a,signature:'sig'};},
    signBytes: async () => {calls.push('signBytes');return new Uint8Array(64);},
    anchor: async () => {calls.push('anchor');return 'unused';},
    resolveAnchor: async () => {calls.push('resolve');return {status:'absent'};},
    expectedSettlementPayee:'seller', settle:async () => {calls.push('settle');throw Error('must remain inert');},
    newJobId:()=>jobId, now:()=> '2026-01-01T00:00:00Z', nowMs:()=>1780000000000, trustListing:true,
  };
}
test('new and resumed malformed job IDs reach no resolver, signer or protocol effect', async () => {
  for (const jobId of ['job-legacy','01jz0000000000000000000360','81JZ0000000000000000000360','01JZ0000000000000000000360\n','01JZ000000000000000000036K']) {
    for (const resume of [false,true]) {
      const calls=[];
      await assert.rejects(runSessionCore('listing',terms,dependencies(jobId,calls),resume?jobId:undefined), /canonical uppercase ULID/);
      assert.deepEqual(calls,[]);
    }
  }
});
test('every canonical boundary case is admitted as generated or resumed without repair', async () => {
  for (const jobId of ['01JZ0000000000000000000360','00000000000000000000000000','7ZZZZZZZZZZZZZZZZZZZZZZZZZ']) {
    for (const resume of [false,true]) {
      const calls=[];
      await assert.rejects(runSessionCore('listing',terms,dependencies(jobId,calls),resume?jobId:undefined), /admitted listing read/);
      assert.deepEqual(calls,['readListing']);
    }
  }
});
