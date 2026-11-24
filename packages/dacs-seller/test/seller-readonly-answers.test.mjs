// The seller key's closed read-only role signs read answers and refusals, so a re-held host still answers them verifiably; effect
// answers and the co-signature stay behind the guard, and a refusal's cause travels inside its message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DACS_SELLER_DISCOVERY_PATH, DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';
import { agentFixture } from './helpers/seller-agent-isolated-fixture.mjs';
import { JOBS } from './helpers/bilateral-vet-fixture.mjs';
import { fetchAsHost } from './helpers/listener-host.mjs';
import { countedKeyRoles } from './helpers/counted-key-roles.mjs';
import { proposalWireWorld } from './helpers/proposal-wire-world.mjs';
import { PATHS } from './helpers/wire-routes-world.mjs';
import { challengeWorld } from './helpers/challenge-route-fixture.mjs';
import { contextWireWorld } from './helpers/context-wire-world.mjs';
import { contextHostFixture } from './helpers/host-context-client.mjs';
import { causeOf } from './helpers/refusal-body.mjs';
import { TEST_CONNECTION } from './helpers/wire-authority-fixture.mjs';
import { JOB } from './helpers/protocol-fixture.mjs';
import { SELLER_STATE_SIGNING_DOMAIN } from '../src/dacs/seller-durable-state.mjs';

const guard = await import('../src/kit-operation-guard.mjs');
// The challenge and context worlds' seller is the test wallet of seed byte 2.
const CHALLENGE_SELLER_SEED = 2;
const REFUSAL_MEMBERS = ['error', 'message'];

// The opened key's roles as the host and the wire take them.
const keyRolesOf = (roles) => ({ claim: roles.key.claim, sign: roles.effectSigner.sign, integritySigner: roles.integritySigner, readOnlyAnswerSigner: roles.readOnlyAnswerSigner });
const readState = async (w) => w.send(PATHS.state, await w.buyerWire.signRequest(PATHS.state, { transportIdentity: w.body.transportIdentity },
  { jobId: w.jobId, agreementHash: w.body.transportIdentity.agreementHash }));
const counted = (roles) => ({ ...roles.counts });

test('open custody and start the composed host while admitted, then re-hold it: through the actual custody and wire paths, readback (its integrity-signed completion record included), a read-only answer, a signed refusal, a context-route refusal and discovery with ready:false remain verifiable under the valid binding; effect signatures and co-signature answers stay blocked; a read route never carries a signed-held signature; a state read that carries the co-signature is signed by the read-only role while admitted, and after the re-hold answers a refusal without the co-signature, also signed by the read-only role; the read-only role used for each effect domain, an altered body or an invalid binding produces zero signatures; every role refuses after close', async (t) => {
  t.after(() => guard.setKitOperationGuardForTest('testnet-tp1'));
  const custody = await countedKeyRoles(t);
  const host = await contextHostFixture(t);
  const started = await host.start({ signer: keyRolesOf(custody) });
  const buyer = await host.buyerFor(started);
  const discovery = async () => {
    const served = await fetchAsHost()(started.url + DACS_SELLER_DISCOVERY_PATH);
    return { status: served.status, proof: await buyer.verifyDiscovery(Buffer.from(await served.arrayBuffer())) };
  };
  const challenge = await buyer.post(DACS_SELLER_HTTP_PATHS.contextChallenge, await buyer.signChallenge());
  assert.deepEqual([challenge.status, challenge.signed], [200, true], 'while admitted the composed host answers the challenge, signed');
  await buyer.verify(challenge);
  assert.ok(custody.counts.effect >= 1 && custody.counts.integrity >= 1, 'the effect role signed the answer and the integrity role the journal');
  const admittedDiscovery = await discovery();
  assert.deepEqual([admittedDiscovery.status, admittedDiscovery.proof.ready], [200, true], 'while admitted the host serves a verifiable ready:true discovery document');
  guard.setKitOperationGuardForTest('off');
  const heldAt = counted(custody);
  const refused = await buyer.post(DACS_SELLER_HTTP_PATHS.contextChallenge, await buyer.signChallenge());
  assert.deepEqual([refused.status, refused.body.error, Object.keys(refused.body).sort(), refused.signed], [503, 'kit_operation_guard_off', REFUSAL_MEMBERS, true], 'a signed refusal');
  await buyer.verify(refused);
  const contextRefusal = await buyer.post(DACS_SELLER_HTTP_PATHS.context, await buyer.signContext(JOB, challenge.body.sessionNonce));
  assert.deepEqual([contextRefusal.status >= 400, Object.keys(contextRefusal.body).sort(), contextRefusal.signed], [true, REFUSAL_MEMBERS, true], 'a signed context-route refusal');
  await buyer.verify(contextRefusal);
  const heldDiscovery = await discovery();
  assert.deepEqual([heldDiscovery.status, heldDiscovery.proof.ready], [200, false], 'the re-held host serves a verifiable ready:false discovery document');
  assert.equal(custody.counts.effect, heldAt.effect, 'the re-held host made no effect signature');
  assert.equal(custody.counts.readOnly, heldAt.readOnly + 3, 'both refusals and the discovery document were signed by the read-only role');
  guard.setKitOperationGuardForTest('testnet-tp1');

  // Readback through the agent the custody roles sign for: the commitment's anchor is written and read back while admitted; after the
  // re-hold the same readback authenticates it again and records its completion with the integrity role alone, and that record verifies.
  const records = await countedKeyRoles(t);
  const a = await agentFixture({ lifecycle: true, roles: { effectSigner: records.effectSigner, integritySigner: records.integritySigner } });
  t.after(() => a.close());
  await a.agent.commit({ jobId: JOBS[0] });
  guard.setKitOperationGuardForTest('off');
  const readbackAt = counted(records);
  const readback = await a.agent.reconcile({ jobId: JOBS[0] });
  guard.setKitOperationGuardForTest('testnet-tp1');
  assert.equal(readback.status, 'reconciled', JSON.stringify(readback));
  assert.ok(readback.outcomes.length >= 1 && readback.outcomes.every(({ status }) => status === 'present-authenticated'), 'every anchor of the job read back authenticated');
  assert.deepEqual([records.counts.integrity - readbackAt.integrity, records.counts.effect - readbackAt.effect, records.counts.readOnly - readbackAt.readOnly],
    [readback.outcomes.length, 0, 0], 'each completion record was signed by the integrity role, and nothing else signed');
  for (const { address } of readback.outcomes) {
    const receipt = await a.store.reconcileAnchor(`anchor:${address}`, a.anchors, { record: false });
    assert.equal(typeof receipt, 'object', `the integrity-signed completion record of ${address} verifies when read`);
  }

  const reads = await countedKeyRoles(t);
  const w = await proposalWireWorld(t);
  let readAnswerBytes = null;
  const roles = { ...keyRolesOf(reads), readOnlyAnswerSigner: async (request) => {
    const signer = await reads.readOnlyAnswerSigner(request);
    return { claim: signer.claim, sign: (bytes) => { if (request.purpose === 'read-answer') readAnswerBytes = Buffer.from(bytes); return signer.sign(bytes); } };
  } };
  await w.withWire({ signer: roles }, async () => {
    assert.equal((await w.post()).status, 200, 'the proposal is answered with its co-signature');
    const before = counted(reads);
    const read = await readState(w);
    assert.deepEqual([read.status, typeof read.body.contribution?.signature?.value], [200, 'string'], 'the state read carries the co-signature');
    assert.ok(await w.verified(read), 'and verifies under the binding');
    assert.deepEqual([reads.counts.readOnly - before.readOnly, reads.counts.effect - before.effect], [1, 0], 'signed by the read-only role');
    guard.setKitOperationGuardForTest('off');
    const heldRead = await readState(w), repeated = await w.post();
    guard.setKitOperationGuardForTest('testnet-tp1');
    assert.deepEqual([heldRead.status >= 400, heldRead.body.contribution, Object.keys(heldRead.body).sort()], [true, undefined, REFUSAL_MEMBERS], `the re-held read answers a refusal without the co-signature: ${heldRead.text}`);
    assert.ok(await w.verified(heldRead), 'the refusal verifies under the binding');
    assert.equal(repeated.body.contribution, undefined, 'a repeated proposal carries no co-signature while re-held');
    assert.equal(reads.counts.effect - before.effect, 0, 'no effect signature after the re-hold');
    assert.ok(reads.counts.readOnly - before.readOnly >= 3, 'the read, the held read and the held proposal\'s refusal were signed by the read-only role');
  });

  const binding = w.buyerWire.binding, local = { ...TEST_CONNECTION }, before = counted(reads);
  const role = (body, overrides = {}) => reads.readOnlyAnswerSigner({ purpose: 'read-answer', binding, local, body, ...overrides });
  for (const [domain, bytes] of [['an Agreement', Buffer.from('dacs-payee-bound-agreement:v1:TEST')], ['a wire request', Buffer.from(`${DACS_SELLER_HTTP_DOMAINS.request}{}`)],
    ['a journal record', Buffer.from(`${SELLER_STATE_SIGNING_DOMAIN}TEST`)]]) {
    await assert.rejects((await role('{}')).sign(bytes), { code: 'seller_key_role_refused' }, domain);
  }
  assert.ok(readAnswerBytes !== null, 'a read answer\'s signing bytes were seen');
  await assert.rejects((await role('{"altered":true}')).sign(readAnswerBytes), { code: 'seller_key_role_refused' }, 'an altered body');
  await assert.rejects(role('{}', { binding: { ...structuredClone(binding), recordDigest: 'TEST-forged' } }), { code: 'seller_key_role_refused' }, 'an invalid binding');
  assert.deepEqual(counted(reads), before, 'none of them signed');

  reads.key.close();
  assert.throws(() => reads.key.sign(Buffer.from('TEST')), { code: 'seller_key_closed' }, 'the effect role');
  await assert.rejects(reads.key.readOnlyAnswerSigner({ purpose: 'read-answer', binding, local, body: '{}' }), { code: 'seller_key_closed' }, 'the read-only role');
  assert.throws(() => reads.key.integritySigner.sign(Buffer.from(`${SELLER_STATE_SIGNING_DOMAIN}TEST`)), { code: 'seller_key_closed' }, 'the integrity role');
});

test('a refusal whose error has a cause answers it inside message, on the wire routes and on the context route, and the read-only role signs it', async (t) => {
  const wireRoles = await countedKeyRoles(t, { seedByte: CHALLENGE_SELLER_SEED });
  const w = await challengeWorld(t, { sellerRoles: keyRolesOf(wireRoles) });
  w.state.stop = () => { throw new Error('TEST stop predicate failed'); };
  const signed = await w.sign();
  const stopped = await w.post(signed);
  assert.deepEqual([stopped.status, stopped.body.error, Object.keys(stopped.body).sort(), causeOf(stopped.body)], [503, 'seller_stopped', REFUSAL_MEMBERS, 'stop_check_failed']);
  assert.match(stopped.body.message, / \(cause: stop_check_failed\)$/, 'the cause is inside the message');
  await signed.verify(stopped);
  assert.deepEqual([wireRoles.counts.readOnly, wireRoles.counts.effect], [1, 0], 'the read-only role signed the wire refusal');

  const contextRoles = await countedKeyRoles(t, { seedByte: CHALLENGE_SELLER_SEED });
  const c = await contextWireWorld(t, { sellerRoles: keyRolesOf(contextRoles) });
  const request = await c.startContext({ presenter: c.other });
  assert.equal((await c.post(request)).body.error, 'peer_context_mismatch');
  const before = counted(contextRoles);
  const again = await c.post(request);
  assert.deepEqual([again.status, again.body.error, Object.keys(again.body).sort(), causeOf(again.body)], [409, 'context_challenge_failed', REFUSAL_MEMBERS, 'peer_context_mismatch']);
  assert.match(again.body.message, / \(cause: peer_context_mismatch\)$/, 'the cause is inside the message');
  assert.equal(typeof again.signature, 'string', 'the context-route refusal is signed');
  assert.deepEqual([contextRoles.counts.readOnly - before.readOnly, contextRoles.counts.effect - before.effect], [1, 0], 'by the read-only role');
});
