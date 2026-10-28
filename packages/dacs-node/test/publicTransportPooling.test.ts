import { EventEmitter } from "node:events";

import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const httpsRequest = vi.fn();

vi.mock("node:https", () => ({ request: httpsRequest }));

function failingRequest() {
  const request = new EventEmitter() as EventEmitter & {
    setTimeout: ReturnType<typeof vi.fn>;
    destroy: (error: Error) => void;
    end: () => void;
  };
  request.setTimeout = vi.fn();
  request.destroy = (error) => request.emit("error", error);
  request.end = () => queueMicrotask(() => request.emit("error", new Error("stop")));
  return request;
}

// Load both modules once, before the tests and outside their 5 s limit. The first import of publicFetch pulls in the
// core index through the @kynesyslabs/dacs alias, and on a busy host that cold transform alone took 4.4-5.7 s. Inside
// the first test it timed out, and the unfinished request then counted towards the second test's call count.
let publicFetch: typeof import("../src/publicFetch.js");
let publicJson: typeof import("../src/publicJson.js");

beforeAll(async () => {
  publicFetch = await import("../src/publicFetch.js");
  publicJson = await import("../src/publicJson.js");
}, 120_000);

describe("pinned public HTTPS connection isolation", () => {
  beforeEach(() => {
    httpsRequest.mockReset();
    httpsRequest.mockImplementation(() => failingRequest());
  });

  test("x402 public fetch disables shared-agent socket reuse", async () => {
    const fetchImpl = publicFetch.createDacsPublicHttpsFetchV1();
    await expect(fetchImpl("https://8.8.8.8/pay", { redirect: "error" }))
      .rejects.toThrow("stop");
    expect(httpsRequest).toHaveBeenCalledOnce();
    expect(httpsRequest.mock.calls[0]![0]).toMatchObject({ agent: false });
  });

  test("public JSON reader disables shared-agent socket reuse", async () => {
    await expect(publicJson.readDacsPublicJsonV1("https://8.8.8.8/index.json"))
      .rejects.toThrow("public-json-request-unavailable");
    expect(httpsRequest).toHaveBeenCalledOnce();
    expect(httpsRequest.mock.calls[0]![0]).toMatchObject({ agent: false });
  });
});
