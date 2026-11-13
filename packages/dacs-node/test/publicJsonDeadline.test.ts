import { EventEmitter } from "node:events";

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const httpsRequest = vi.fn();

vi.mock("node:https", () => ({ request: httpsRequest }));

const TIMEOUT_MS = 1_000;
const TRICKLE_INTERVAL_MS = 600;
const PUBLIC_URL = "https://8.8.8.8/index.json";

type ResponseCallback = (response: EventEmitter & {
  statusCode: number;
  headers: Record<string, string>;
}) => void;

/** Stands in for a ClientRequest; `onResponse` drives the server side once the request is sent. */
function fakeRequest(onResponse: (respond: ResponseCallback) => void) {
  let respond: ResponseCallback = () => undefined;
  const request = new EventEmitter() as EventEmitter & {
    setTimeout: () => void;
    destroy: (error: Error) => void;
    end: () => void;
  };
  request.setTimeout = () => undefined;
  request.destroy = (error) => request.emit("error", error);
  request.end = () => onResponse(respond);
  return {
    request,
    setCallback: (callback: ResponseCallback) => { respond = callback; },
  };
}

function fakeResponse() {
  return Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: { "content-type": "application/json" },
  });
}

function serveWith(onResponse: (respond: ResponseCallback) => void) {
  httpsRequest.mockImplementation((_options: unknown, callback: ResponseCallback) => {
    const fake = fakeRequest(onResponse);
    fake.setCallback(callback);
    return fake.request;
  });
}

let readDacsPublicJsonV1: typeof import("../src/publicJson.js").readDacsPublicJsonV1;

beforeAll(async () => {
  ({ readDacsPublicJsonV1 } = await import("../src/publicJson.js"));
}, 120_000);

beforeEach(() => {
  httpsRequest.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Starts a read and records how it settled, so a call that never settles fails an assertion instead of hanging. */
function startRead(options: Parameters<typeof readDacsPublicJsonV1>[1]) {
  const outcome: { settled: boolean; value?: unknown; error?: unknown } = { settled: false };
  void readDacsPublicJsonV1(PUBLIC_URL, options).then(
    (value) => Object.assign(outcome, { settled: true, value }),
    (error: unknown) => Object.assign(outcome, { settled: true, error }),
  );
  return outcome;
}

describe("public JSON overall deadline", () => {
  test("rejects with a timeout when host resolution never finishes", async () => {
    const request = vi.fn();
    const outcome = startRead({
      timeoutMs: TIMEOUT_MS,
      dependencies: { resolveHost: () => new Promise<never>(() => undefined), request },
    });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(outcome).toMatchObject({ settled: true, error: { reasonCode: "public-json-timeout" } });
    expect(request).not.toHaveBeenCalled();
  });

  test("gives the request only the time left after host resolution", async () => {
    const resolutionMs = 400;
    const request = vi.fn(async () => ({
      status: 200,
      contentType: "application/json",
      bytes: new TextEncoder().encode("{}"),
    }));
    const outcome = startRead({
      timeoutMs: TIMEOUT_MS,
      dependencies: {
        resolveHost: () => new Promise((resolve) => {
          setTimeout(() => resolve(["8.8.8.8"]), resolutionMs);
        }),
        request,
      },
    });
    await vi.advanceTimersByTimeAsync(resolutionMs);
    expect(outcome).toMatchObject({ settled: true, value: {} });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: TIMEOUT_MS - resolutionMs,
    }));
  });

  test("rejects with a timeout when a body trickles past the deadline", async () => {
    serveWith((respond) => {
      const response = fakeResponse();
      respond(response);
      response.emit("data", Buffer.from("{"));
      setInterval(() => response.emit("data", Buffer.from(" ")), TRICKLE_INTERVAL_MS);
    });
    const outcome = startRead({ timeoutMs: TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(outcome).toMatchObject({ settled: true, error: { reasonCode: "public-json-timeout" } });
  });

  test("rejects when the response closes before the body ends", async () => {
    serveWith((respond) => {
      const response = fakeResponse();
      respond(response);
      response.emit("data", Buffer.from("{\"partial\":"));
      response.emit("close");
    });
    const outcome = startRead({ timeoutMs: TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toMatchObject({
      settled: true,
      error: { reasonCode: "public-json-response-incomplete" },
    });
  });

  test("returns the body when the response ends before the deadline", async () => {
    serveWith((respond) => {
      const response = fakeResponse();
      respond(response);
      response.emit("data", Buffer.from("{\"ok\":true}"));
      response.emit("end");
      response.emit("close");
    });
    const outcome = startRead({ timeoutMs: TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toMatchObject({ settled: true, value: { ok: true } });
  });
});
