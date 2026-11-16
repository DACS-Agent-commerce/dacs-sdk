import { TransportError } from "@kynesyslabs/demosdk/websdk";
import { describe, expect, it } from "vitest";

import {
  createDemosClient,
  TransactionPostNotSentError,
} from "../../src/rails/demosClient.js";

const BROADCAST = { method: "execute", params: [{ extra: "broadcastTx" }] };
const NONCE_READ = { method: "nodeCall", params: [{ message: "getAddressNonce" }] };
const CLOUDFLARE = { "cf-ray": "test-ray" };

type PostOptions = { retries?: number };

/** The error demosdk's `_doPost` throws once axios has failed `attempts` times. */
function transportError(cause: Error, attempts = 1): TransportError {
  return new TransportError(
    `Demos RPC POST failed after ${attempts} attempt(s)`,
    { cause, attempts },
  );
}

/**
 * An axios connection error: no response, and `request` is the
 * follow-redirects request that counts the redirects it followed.
 */
function connectionError(code: string, redirects = 0): Error {
  return Object.assign(new Error(`connect ${code}`), {
    code,
    request: { _redirectCount: redirects },
  });
}

/**
 * An axios HTTP status error: `request` is the native request, linked back to
 * the follow-redirects request that counts the redirects it followed.
 */
function statusError(
  status: number,
  headers: Record<string, string> = {},
  redirects = 0,
): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    code: "ERR_BAD_RESPONSE",
    request: { _redirectable: { _redirectCount: redirects } },
    response: { status, headers },
  });
}

/** A Demos client whose every post throws `error`; records each post's options. */
function clientFailingWith(error: Error) {
  const options: PostOptions[] = [];
  class FailingDemos {
    async _doPost(
      _url: string,
      _request: unknown,
      _headers: unknown,
      opts: PostOptions = {},
    ): Promise<{ data: unknown }> {
      options.push(opts);
      throw error;
    }
  }
  return { client: createDemosClient(FailingDemos), options };
}

async function postError(error: Error, request: unknown): Promise<unknown> {
  const { client } = clientFailingWith(error);
  return client._doPost("http://node.test", request, {}).catch(
    (caught: unknown) => caught,
  );
}

describe("createDemosClient transaction posts that never reached the node", () => {
  it.each([
    ["refused connection", connectionError("ECONNREFUSED")],
    ["failed name lookup", connectionError("ENOTFOUND")],
    ["Cloudflare 521 answer (origin refused the connection)", statusError(521, CLOUDFLARE)],
    ["Cloudflare 523 answer (origin unreachable)", statusError(523, CLOUDFLARE)],
  ])("treats a %s as never sent and keeps the transport error as its cause", async (_label, cause) => {
    const sent = transportError(cause);
    const { client, options } = clientFailingWith(sent);

    const error = await client
      ._doPost("http://node.test", BROADCAST, {})
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TransactionPostNotSentError);
    expect((error as Error).cause).toBe(sent);
    expect(options).toEqual([{ retries: 0 }]);
  });

  it.each([
    ["connection reset after connect", transportError(connectionError("ECONNRESET"))],
    ["connect timeout", transportError(connectionError("ETIMEDOUT"))],
    ["request timeout", transportError(connectionError("ECONNABORTED"))],
    ["502 answer", transportError(statusError(502))],
    ["503 answer", transportError(statusError(503))],
    ["504 answer", transportError(statusError(504))],
    ["Cloudflare 520 answer", transportError(statusError(520, CLOUDFLARE))],
    ["Cloudflare 522 answer", transportError(statusError(522, CLOUDFLARE))],
    ["Cloudflare 524 answer", transportError(statusError(524, CLOUDFLARE))],
    ["521 answer without a cf-ray header", transportError(statusError(521))],
    ["refused connection after a redirect", transportError(connectionError("ECONNREFUSED", 1))],
    ["Cloudflare 521 answer after a redirect", transportError(statusError(521, CLOUDFLARE, 1))],
    [
      "refused connection with no redirect count",
      transportError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
    ],
    ["refused connection on a second attempt", transportError(connectionError("ECONNREFUSED"), 2)],
    ["error that is not a transport error", connectionError("ECONNREFUSED")],
  ])("keeps the transport error for a %s", async (_label, thrown) => {
    const error = await postError(thrown, BROADCAST);

    expect(error).toBe(thrown);
  });

  it("keeps a read post's retries and error when it is refused", async () => {
    const thrown = transportError(connectionError("ECONNREFUSED"), 5);
    const { client, options } = clientFailingWith(thrown);

    const error = await client
      ._doPost("http://node.test", NONCE_READ, {})
      .catch((caught: unknown) => caught);

    expect(error).toBe(thrown);
    expect(options).toEqual([{}]);
  });
});
