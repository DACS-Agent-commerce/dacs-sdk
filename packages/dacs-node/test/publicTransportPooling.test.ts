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

describe("pinned public HTTPS connection isolation", () => {
  // Both modules pull in the SDK graph; the first (cold) import takes ~4-5 s, which is the default 5 s test timeout.
  // Load them (still under the node:https mock) before the tests so the timeout bounds the assertions, not loading.
  let createDacsPublicHttpsFetchV1: typeof import("../src/publicFetch.js").createDacsPublicHttpsFetchV1;
  let readDacsPublicJsonV1: typeof import("../src/publicJson.js").readDacsPublicJsonV1;
  beforeAll(async () => {
    ({ createDacsPublicHttpsFetchV1 } = await import("../src/publicFetch.js"));
    ({ readDacsPublicJsonV1 } = await import("../src/publicJson.js"));
  }, 60_000);

  beforeEach(() => {
    httpsRequest.mockReset();
    httpsRequest.mockImplementation(() => failingRequest());
  });

  test("x402 public fetch disables shared-agent socket reuse", async () => {
    const fetchImpl = createDacsPublicHttpsFetchV1();
    await expect(fetchImpl("https://8.8.8.8/pay", { redirect: "error" }))
      .rejects.toThrow("stop");
    expect(httpsRequest).toHaveBeenCalledOnce();
    expect(httpsRequest.mock.calls[0]![0]).toMatchObject({ agent: false });
  });

  test("public JSON reader disables shared-agent socket reuse", async () => {
    await expect(readDacsPublicJsonV1("https://8.8.8.8/index.json"))
      .rejects.toThrow("public-json-request-unavailable");
    expect(httpsRequest).toHaveBeenCalledOnce();
    expect(httpsRequest.mock.calls[0]![0]).toMatchObject({ agent: false });
  });
});
