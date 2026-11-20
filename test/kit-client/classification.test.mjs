// How the client's seller POST classifies a signed answer. The seller side signs each answer under the old transport
// domain (fixtures.mjs `signedAnswerHeader`); the exchange is an in-process fetch, so no socket is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSellerAgentClient } from '../../packages/dacs-client/src/dacs/seller-http.mjs';
import { JOB, sellerTransportPair, signedAnswerHeader } from './fixtures.mjs';

const SELLER_URL = 'http://127.0.0.1:9';
const PEER_HEADER = 'x-dacs-seller-peer';
const NO_DELAY = { now: () => 0, sleep: async () => {} };

/** Stored-request records that keep nothing: the exact text is fixed once and handed to every attempt. */
const fixedRecords = () => ({ start: (_path, body) => ({ text: JSON.stringify(body), stored: true, continuation: false, newPurchase: false, check() {}, finish() {} }), failure() {} });

/** A client whose exchanges are answered, signed by the seller, with each `[status, answer]` in turn. */
async function clientAnswered(t, answers) {
  const { clientAuth } = await sellerTransportPair(t);
  const sent = [];
  const fetchImpl = async (_url, { headers, body }) => {
    sent.push({ body, header: headers[PEER_HEADER] });
    const [status, answer] = answers[Math.min(sent.length, answers.length) - 1];
    const text = JSON.stringify(answer);
    const signed = signedAnswerHeader(headers[PEER_HEADER], status, text);
    return new Response(text, { status, headers: { 'content-type': 'application/json', [PEER_HEADER]: signed } });
  };
  return { sent, client: createSellerAgentClient({ url: SELLER_URL, authentication: clientAuth, fetchImpl, requestRecords: fixedRecords(), clock: NO_DELAY }) };
}

test('K12-H5 target: a signed 409 peer_request_replayed is unknown and retried with the stored bytes', async (t) => {
  const { client, sent } = await clientAnswered(t, [[409, { error: 'peer_request_replayed' }], [200, { status: 'agreed' }]]);
  assert.deepEqual(await client.agreementState({ jobId: JOB }), { status: 'agreed' });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].body, sent[1].body);
});

test('K12-H5 control: the client returns a signed 200 answer as a result', async (t) => {
  const { client, sent } = await clientAnswered(t, [[200, { status: 'agreed' }]]);
  assert.deepEqual(await client.agreementState({ jobId: JOB }), { status: 'agreed' });
  assert.equal(sent.length, 1);
});
