import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import {
  createDacsHttpMessageRequestHandlerV1,
  type DacsHttpMessageEndpointOptionsV1,
} from "../../src/transport/http.js";

/** Runs the real HTTP endpoint with byte streams, without opening a socket. */
export function inProcessHttpFetch(options: DacsHttpMessageEndpointOptionsV1): typeof fetch {
  const handler = createDacsHttpMessageRequestHandlerV1(options);
  return async (input, init) => new Promise<Response>((resolve) => {
    if (typeof init?.body !== "string") throw new TypeError("fixture requires a serialized request body");
    const bytes = Buffer.from(init.body);
    const request = Readable.from([bytes]) as IncomingMessage;
    request.url = new URL(input instanceof Request ? input.url : String(input)).pathname;
    request.method = init.method ?? "GET";
    request.headers = {};
    new Headers(init.headers).forEach((value, key) => { request.headers[key] = value; });
    request.headers["content-length"] = String(bytes.byteLength);
    Object.defineProperty(request, "socket", { value: { remoteAddress: "127.0.0.1" } });
    const headers = new Headers();
    const response = {
      statusCode: 200,
      headersSent: false,
      writableEnded: false,
      setHeader(name: string, value: string) { headers.set(name, value); },
      end(this: { statusCode: number }, body: Buffer) {
        resolve(new Response(body.toString("utf8"), { status: this.statusCode, headers }));
      },
    } as unknown as ServerResponse;
    handler(request, response);
  });
}
