import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createDacsHttpMessageRequestHandlerV1 } from "../src/transport/http.js";

describe("exact-byte admission at the HTTP handler before authentication", () => {
  it.each([
    '{"payload":1,"payload":2}',
    '{"payload":1,"\\u0070ayload":2}',
    '{"observedAt":9007199254740991.1}',
  ])("rejects inadmissible raw JSON %s without touching dependencies", async (raw) => {
    const touched = vi.fn(async () => { throw new Error("must not be reached"); });
    const inbox = new Proxy({}, { get: () => touched });
    const handler = createDacsHttpMessageRequestHandlerV1({
      authority: `did:demos:agent:${"11".repeat(32)}`,
      inbox,
      resolveIdentity: touched,
      validatePayload: touched,
      handleMessage: touched,
      signAcknowledgement: touched,
    } as never);
    const bytes = Buffer.from(raw);
    const request = Object.assign(Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]), {
      method: "POST", url: "/dacs-transport/v1/messages",
      headers: { "content-type": "application/json", "content-length": String(bytes.length) },
      socket: { remoteAddress: "offline-fixture" },
    });
    const result = await new Promise<{ status: number; body: unknown }>((resolve) => {
      const response = {
        statusCode: 0, headersSent: false, writableEnded: false,
        setHeader: vi.fn(),
        end(body: Buffer) { resolve({ status: this.statusCode, body: JSON.parse(body.toString()) }); },
      };
      handler(request as never, response as never);
    });
    expect(result).toEqual({ status: 400, body: { error: "request-json-invalid" } });
    expect(touched).not.toHaveBeenCalled();
  });
});
