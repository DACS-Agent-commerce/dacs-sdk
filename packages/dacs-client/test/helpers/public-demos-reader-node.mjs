// An in-process Demos node for the public reader's tests. Each request is
// answered by `answer` or, for the genesis block, by the node's own identity;
// every request is recorded. Nothing leaves the process.
import { createDemosPublicChainReader } from '../../src/substrate/demos.mjs';

export const TESTNET_IDENTITY = 'e'.repeat(64);
export const OTHER_IDENTITY = '9'.repeat(64);
export const RPC_URL = 'https://rpc.testnet.invalid';

/** A 200 JSON response; `headers` adds to the content type. */
export const jsonResponse = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
/** A node's successful nodeCall answer. */
export const nodeAnswer = (response, headers) => jsonResponse({ result: 200, response }, headers);

/**
 * Returns { fetchImpl, requests, reader(options) }. `answer({message, data, path, signal})`
 * returns a Response, a nodeCall `response` value, or undefined for the default
 * (block 0 carries `genesis`; anything else throws). `requests` lists each
 * nodeCall message, or `GET <path>` for a storage read.
 */
export function fakeNode({ genesis = TESTNET_IDENTITY, answer = () => undefined } = {}) {
  const requests = [];
  async function fetchImpl(url, init = {}) {
    init.signal?.throwIfAborted();
    const path = new URL(url).pathname;
    if (init.method !== 'POST') {
      requests.push(`GET ${path}`);
      const custom = await answer({ path, signal: init.signal });
      if (custom instanceof Response) return custom;
      throw new Error(`TEST-unexpected GET ${path}`);
    }
    const { message, data } = JSON.parse(init.body).params[0];
    requests.push(message);
    const custom = await answer({ message, data, signal: init.signal });
    if (custom instanceof Response) return custom;
    if (custom !== undefined) return nodeAnswer(custom);
    if (message === 'getBlockByNumber' && data.blockNumber === 0) return nodeAnswer({ number: 0, status: 'confirmed', hash: genesis });
    throw new Error(`TEST-unexpected ${message}`);
  }
  const reader = (options = {}) => createDemosPublicChainReader({ rpcUrl: RPC_URL, network: 'testnet', pinnedIdentity: TESTNET_IDENTITY, fetchImpl, ...options });
  return { fetchImpl, requests, reader };
}
