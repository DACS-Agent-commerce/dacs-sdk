// Requests the wire refuses when it opens them, before any reservation or agent call: a signature or a buyer key outside
// what an Ed25519 verifier may accept, a body that is not an object, and a payment body naming another job than the signed one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_PATHS as PATHS } from '@kynesyslabs/dacs/wire';
import { CLAIM_PREFIX, continuingWorld, jobFor, proposeJob, world } from './helpers/wire-routes-world.mjs';
import { BAD_KEYS, IDENTITY_SIGNATURE, raisedS } from './helpers/ed25519-edge-cases.mjs';

const header64 = (envelope) => Buffer.from(canonicalize(envelope)).toString('base64url');
const envelopeOf = (header) => JSON.parse(Buffer.from(header, 'base64url'));
const summary = (answer) => ({ status: answer.status, error: answer.body.error, signed: answer.signed });

test('a request signature with S at or above the group order is refused unsigned, and the same request signed normally is admitted', async (t) => {
  const w = await world(t), job = await proposeJob(w, 'raised-s');
  const text = JSON.stringify(job.body), payload = w.payloadFor(PATHS.proposals, text, { jobId: job.jobId, agreementHash: job.agreementHash });
  const envelope = envelopeOf(w.headerFor(payload));
  const refused = await w.send(PATHS.proposals, { text, header: header64({ ...envelope, signature: raisedS(envelope.signature) }) });
  assert.deepEqual(summary(refused), { status: 401, error: 'peer_signature_invalid', signed: false });
  assert.equal(w.effects(), 0, 'nothing reached the agent');
  assert.equal((await w.send(PATHS.proposals, { text, header: header64(envelope) })).status, 200, 'the unchanged signature is admitted');
});

test('a buyer key of small order or with y at or above the field prime never authenticates a request', async (t) => {
  const w = await world(t), job = await proposeJob(w, 'bad-keys'), text = JSON.stringify(job.body);
  for (const [name, key] of Object.entries(BAD_KEYS)) {
    const payload = w.payloadFor(PATHS.proposals, text, { jobId: job.jobId, agreementHash: job.agreementHash, buyerClaim: `${CLAIM_PREFIX}${key}` });
    const refused = await w.send(PATHS.proposals, { text, header: header64({ payload, signature: IDENTITY_SIGNATURE }) });
    assert.deepEqual(summary(refused), { status: 401, error: 'peer_signature_invalid', signed: false }, name);
  }
  assert.equal(w.effects(), 0, 'nothing reached the agent');
});

test('a signed request whose body is not an object is refused bad_request before any agent call, on the proposal and payment routes', async (t) => {
  const w = await continuingWorld(t), calls = w.effects();
  for (const path of [PATHS.proposals, PATHS.payments]) for (const body of [null, [], 4, 'TEST', true]) {
    // The buyer's wire signer refuses such a body, so the request is signed by hand over its exact bytes.
    const text = JSON.stringify(body), payload = w.payloadFor(path, text, { jobId: w.jobId, agreementHash: w.agreementHash });
    const answer = await w.send(path, { text, header: w.headerFor(payload) });
    assert.deepEqual({ status: answer.status, error: answer.body.error }, { status: 400, error: 'bad_request' }, `${path} ${text}`);
  }
  assert.equal(w.effects(), calls, 'nothing reached the agent');
});

test('a payment body naming another job than the signed one is refused peer_job_mismatch before any agent call', async (t) => {
  const w = await continuingWorld(t), calls = w.effects(), body = w.bodyFor(PATHS.payments);
  const refused = await w.post(PATHS.payments, { ...body, jobId: jobFor('another-job') }, { jobId: w.jobId, agreementHash: w.agreementHash });
  assert.deepEqual({ status: refused.status, error: refused.body.error }, { status: 409, error: 'peer_job_mismatch' });
  assert.equal(w.effects(), calls, 'nothing reached the agent');
});
