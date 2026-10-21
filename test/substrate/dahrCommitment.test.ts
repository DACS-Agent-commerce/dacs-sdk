import { describe, expect, it } from "vitest";

import { sha256Hex } from "../../src/canonical/index.js";
import { SubstrateError } from "../../src/errors.js";
import { assertDahrCommitment } from "../../src/substrate/dahrCommitment.js";

const URL = "https://example.com/data";
const COMMITMENT = /DAHR canonical web2Request commitment does not match/;
const CONTENT_TYPE = /unsupported response content-type/;

type Loose = Record<string, any>;

interface Options {
  /** Committed and returned headers; both carry the same object. */
  headers?: Record<string, unknown>;
  /** Exact text that the node hashes for those headers. */
  canonical?: string;
  status?: number;
  data?: string;
  method?: string;
  body?: string;
}

/** A self-consistent GET (or body-carrying) commitment; every field matches every other. */
function fixture(options: Options = {}) {
  const headers = options.headers ?? { "content-type": "application/json" };
  const canonical = options.canonical ?? "content-type:application/json";
  const data = options.data ?? "ok";
  const status = options.status ?? 200;
  const method = options.method ?? "GET";
  const requestHash = options.body === undefined ? undefined : sha256Hex(options.body);
  const responseHash = sha256Hex(data);
  const responseHeadersHash = sha256Hex(canonical);
  const transaction: Loose = {
    content: {
      type: "web2Request",
      data: ["web2Request", {
        message: {
          web2Request: {
            raw: { action: "startProxy", url: URL, method, headers: {} },
            result: {
              targetUrl: URL, status, responseHash, responseHeadersHash, headers, requestHash,
            },
          },
        },
      }],
    },
  };
  const response: Loose = { data, status, responseHash, responseHeadersHash, headers, requestHash };
  const request = { url: URL, method, headers: {}, ...(options.body === undefined ? {} : { body: options.body }) };
  const result = () => transaction.content.data[1].message.web2Request.result as Loose;
  return { transaction, response, request, result };
}

function run(f: ReturnType<typeof fixture>) {
  assertDahrCommitment(f.transaction, f.request, f.response);
}

describe("assertDahrCommitment", () => {
  it("accepts the self-consistent control", () => {
    expect(() => run(fixture())).not.toThrow();
    expect(() => run(fixture({ method: "POST", body: "payload" }))).not.toThrow();
  });

  describe("payload shape", () => {
    it.each([
      ["a third data entry", (d: unknown[]) => { d.push("extra"); }],
      ["a missing payload", (d: unknown[]) => { d.pop(); }],
      ["another discriminator", (d: unknown[]) => { d[0] = "web2Response"; }],
    ])("refuses %s while the control succeeds", (_label, change) => {
      const f = fixture();
      expect(() => run(f)).not.toThrow();
      change(f.transaction.content.data);
      expect(() => run(f)).toThrow(COMMITMENT);
    });
  });

  describe("status range", () => {
    it.each([100, 200, 599])("accepts a committed and returned status of %s", (status) => {
      expect(() => run(fixture({ status }))).not.toThrow();
    });

    it.each([99, 600, 0, -1, 200.5])("refuses a committed and returned status of %s", (status) => {
      expect(() => run(fixture({ status }))).toThrow(COMMITMENT);
    });

    it("refuses a returned status that differs from the committed one", () => {
      const f = fixture();
      f.response["status"] = 201;
      expect(() => run(f)).toThrow(COMMITMENT);
    });
  });

  describe("declared header digest", () => {
    it("refuses a transaction whose declared digest differs while both header hashes are valid", () => {
      const f = fixture();
      f.result()["responseHeadersHash"] = sha256Hex("content-type:text/plain");
      // The response digest still matches the returned and committed headers.
      expect(f.response["responseHeadersHash"]).toBe(sha256Hex("content-type:application/json"));
      expect(() => run(f)).toThrow(COMMITMENT);
    });

    it("refuses a returned digest that the committed headers do not produce", () => {
      const f = fixture();
      f.response["responseHeadersHash"] = sha256Hex("content-type:text/plain");
      f.result()["responseHeadersHash"] = f.response["responseHeadersHash"];
      expect(() => run(f)).toThrow(COMMITMENT);
    });
  });

  describe("response media type", () => {
    const withType = (type: string, extra: Record<string, unknown> = {}) =>
      fixture({ headers: { "Content-Type": type, ...extra }, canonical: `content-type:${type.trim()}` });

    it.each([
      "application/json",
      "Application/JSON; Charset=UTF-8",
      "text/plain;charset=utf-8",
      "text/plain; charset=\"utf-8\"",
      "text/html; charset=UTF-8; q=1",
      "application/vnd.api+json",
      "image/svg+xml",
    ])("accepts %s", (type) => {
      expect(() => run(withType(type))).not.toThrow();
    });

    it.each([
      "garbageapplication/json",
      "xtext/plain",
      "application/json garbage",
      "application/jsonx",
      "text/plain; @charset=utf-8",
      "text/plain; charset=\"utf-8\"junk",
      "text/plain; junk charset=utf-8",
      "text/plain; charset=utf-8 junk",
      "text/plain; charset=latin1",
      "text/plain; charset=utf-8; charset=utf-8",
      "application/octet-stream",
      "",
    ])("refuses %s even though every digest matches", (type) => {
      expect(() => run(withType(type))).toThrow(CONTENT_TYPE);
    });

    it("refuses repeated or missing content-type headers", () => {
      expect(() => run(fixture({
        headers: { "content-type": "text/plain", "Content-Type": "text/plain" },
        canonical: "content-type:text/plain\ncontent-type:text/plain",
      }))).toThrow(CONTENT_TYPE);
      expect(() => run(fixture({ headers: {}, canonical: "" }))).toThrow(CONTENT_TYPE);
    });
  });

  describe("header canonicalization", () => {
    it("omits null headers and volatile ones, lowercases, trims and sorts by name", () => {
      expect(() => run(fixture({
        headers: {
          "X-Null": null, Date: "today", Server: "s", "Content-Length": "2",
          "X-B": " 2 ", "content-type": "text/plain", "x-a": ["1", "2"],
        },
        canonical: "content-type:text/plain\nx-a:1, 2\nx-b:2",
      }))).not.toThrow();
    });

    it("refuses an unsorted digest", () => {
      expect(() => run(fixture({
        headers: { "x-b": "2", "content-type": "text/plain" },
        canonical: "x-b:2\ncontent-type:text/plain",
      }))).toThrow(COMMITMENT);
    });

    it("refuses a header array that mixes strings with other values", () => {
      expect(() => run(fixture({
        headers: { "content-type": "text/plain", "x-a": ["1", 2] },
        canonical: "content-type:text/plain\nx-a:1, 2",
      }))).toThrow(COMMITMENT);
    });

    it("refuses a non-string non-array header value", () => {
      expect(() => run(fixture({
        headers: { "content-type": "text/plain", "x-a": 1 },
        canonical: "content-type:text/plain\nx-a:1",
      }))).toThrow(COMMITMENT);
    });

    it("orders two values of the same header name by the stable sort", () => {
      expect(() => run(fixture({
        headers: { "content-type": "text/plain", "X-A": "first", "x-a": "second" },
        canonical: "content-type:text/plain\nx-a:first\nx-a:second",
      }))).not.toThrow();
    });
  });

  it("throws SubstrateError for a refusal", () => {
    const f = fixture();
    f.response["status"] = 99;
    expect(() => run(f)).toThrow(SubstrateError);
  });
});
