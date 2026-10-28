import test from 'node:test';
import assert from 'node:assert/strict';
import {proposalAdmissionFixture} from './helpers/proposal-admission-fixture.mjs';
import {JOB} from './helpers/protocol-fixture.mjs';

test('a contribution and its exact restart replay do not complete negotiation before Agreement anchoring',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),request=await f.proposal(agent);
 const first=await agent.receiveProposal(request);assert.equal(first.disposition,'complete');assert.ok(first.contribution);
 assert.deepEqual(agent.durableSessionOf(JOB).phaseResults??[],[]);agent.close();
 const restarted=await f.open(),again=await restarted.receiveProposal(request);
 assert.deepEqual(again.contribution,first.contribution);assert.deepEqual(restarted.durableSessionOf(JOB).phaseResults??[],[]);
});
