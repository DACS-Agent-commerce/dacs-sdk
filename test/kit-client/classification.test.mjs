// K12-H5: how the client's seller POST classifies a signed answer. The seller side signs with the kit's real server auth;
// the exchange is an in-process fetch, so no socket is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSellerAgentClient, SellerRefusedError, SellerUnavailableError } from '../../packages/dacs-client/src/dacs/seller-http.mjs';
import { JOB, sellerTransportPair } from './fixtures.mjs';

const SELLER_URL = 'http://127.0.0.1:9';
const PEER_HEADER = 'x-dacs-seller-peer';

/** A client whose one exchange is answered, signed by the kit's server auth, with `status` and `answer`. */
async function clientAnswered(t, status, answer) {
  const { serverAuth, clientAuth } = await sellerTransportPair(t);
  const fetchImpl = async (_url, { headers }) => {
    const text = JSON.stringify(answer);
    const signed = await serverAuth.responseHeader(serverAuth.readRequest(headers[PEER_HEADER]), status, text);
    return new Response(text, { status, headers: { 'content-type': 'application/json', [PEER_HEADER]: signed } });
  };
  return createSellerAgentClient({ url: SELLER_URL, authentication: clientAuth, fetchImpl });
}

test('K12-H5 today: the client classifies a signed 409 peer_request_replayed as an unknown answer, not retried yet', async (t) => {
  const client = await clientAnswered(t, 409, { error: 'peer_request_replayed' });
  await assert.rejects(client.agreementState({ jobId: JOB }), (error) => {
    assert.ok(error instanceof SellerUnavailableError);
    assert.ok(!(error instanceof SellerRefusedError));
    assert.equal(error.answerClass, 'unknown');
    assert.equal(error.answerCode, 'peer_request_replayed');
    return true;
  });
});

test('K12-H5 control: the client returns a signed 200 answer as a result', async (t) => {
  const client = await clientAnswered(t, 200, { status: 'agreed' });
  assert.deepEqual(await client.agreementState({ jobId: JOB }), { status: 'agreed' });
});
