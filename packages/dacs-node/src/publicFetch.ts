import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import {
  isDacsPublicAddressV1,
  resolveDacsPublicHostV1,
} from "./publicJson.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 1_048_576;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 64 * 1_048_576;
const ALLOWED_CALLER_HEADERS = new Set([
  "accept",
  "payment-signature",
]);
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface DacsPublicHttpsFetchRequestV1 {
  url: string;
  approvedAddresses: readonly string[];
  headers: Headers;
  timeoutMs: number;
  maxBytes: number;
  /** Absolute whole-request deadline signal, starting before DNS resolution. */
  signal: AbortSignal;
}

export interface DacsPublicHttpsFetchDependenciesV1 {
  /**
   * Trusted platform/test seam. Custom implementations must honor every
   * approved address, bound, header, and abort signal supplied below; only the
   * built-in dependencies provide those transport guarantees automatically.
   */
  resolveHost(hostname: string): Promise<readonly string[]>;
  request(input: Readonly<DacsPublicHttpsFetchRequestV1>): Promise<Response>;
}

export interface DacsPublicHttpsFetchOptionsV1 {
  timeoutMs?: number;
  maxBytes?: number;
  dependencies?: Readonly<DacsPublicHttpsFetchDependenciesV1>;
}

export class DacsPublicHttpsFetchError extends Error {
  override readonly name = "DacsPublicHttpsFetchError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function captureHeaders(value: RequestInit["headers"]): Headers {
  const captured = new Headers(value);
  for (const name of captured.keys()) {
    if (FORBIDDEN_HEADERS.has(name) || !ALLOWED_CALLER_HEADERS.has(name)) {
      throw new DacsPublicHttpsFetchError("public-fetch-ambient-header-refused");
    }
  }
  captured.set("accept-encoding", "identity");
  captured.set("user-agent", "dacs-node-public-fetch/v1");
  return captured;
}

function pinnedRequest(
  input: Readonly<DacsPublicHttpsFetchRequestV1>,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const url = new URL(input.url);
    const address = input.approvedAddresses[0];
    if (address === undefined) {
      reject(new DacsPublicHttpsFetchError("public-fetch-dns-empty"));
      return;
    }
    const family = isIP(address);
    const request = httpsRequest({
      protocol: "https:",
      hostname: url.hostname,
      port: url.port === "" ? 443 : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      // A shared agent may reuse a hostname/port socket and bypass this call's
      // pinned lookup. One fresh connection per validated request is required.
      agent: false,
      servername: isIP(url.hostname) === 0 ? url.hostname : undefined,
      headers: Object.fromEntries(input.headers.entries()),
      lookup: (_hostname, options, callback) => {
        if (typeof options === "object" && options.all === true) {
          (callback as unknown as (
            error: null,
            addresses: readonly Readonly<{ address: string; family: number }>[],
          ) => void)(null, [Object.freeze({ address, family })]);
          return;
        }
        (callback as unknown as (
          error: null,
          resolvedAddress: string,
          resolvedFamily: number,
        ) => void)(null, address, family);
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.once("aborted", () => reject(
        new DacsPublicHttpsFetchError("public-fetch-response-aborted"),
      ));
      response.once("error", reject);
      response.on("data", (chunk: Buffer | string) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
        total += bytes.byteLength;
        if (total > input.maxBytes) {
          request.destroy(new DacsPublicHttpsFetchError("public-fetch-response-too-large"));
          return;
        }
        chunks.push(bytes);
      });
      response.once("end", () => {
        const headers = new Headers();
        for (const [name, raw] of Object.entries(response.headers)) {
          if (typeof raw === "string") headers.set(name, raw);
          else if (Array.isArray(raw)) raw.forEach((value) => headers.append(name, value));
        }
        if (!/^\s*(?:identity)?\s*$/iu.test(headers.get("content-encoding") ?? "")) {
          reject(new DacsPublicHttpsFetchError("public-fetch-content-encoding-refused"));
          return;
        }
        const status = response.statusCode ?? 0;
        if (status < 200 || status > 599) {
          reject(new DacsPublicHttpsFetchError("public-fetch-http-status-invalid"));
          return;
        }
        const body = status === 204 || status === 205 || status === 304
          ? null : Uint8Array.from(Buffer.concat(chunks, total));
        resolve(new Response(body, { status, headers }));
      });
    });
    request.setTimeout(input.timeoutMs, () => {
      request.destroy(new DacsPublicHttpsFetchError("public-fetch-timeout"));
    });
    const abort = () => request.destroy(
      input.signal.reason instanceof Error
        ? input.signal.reason
        : new DacsPublicHttpsFetchError("public-fetch-timeout"),
    );
    if (input.signal.aborted) abort();
    else input.signal.addEventListener("abort", abort, { once: true });
    request.once("close", () => input.signal.removeEventListener("abort", abort));
    request.once("error", reject);
    request.end();
  });
}

const defaultDependencies: Readonly<DacsPublicHttpsFetchDependenciesV1> = Object.freeze({
  resolveHost: resolveDacsPublicHostV1,
  request: pinnedRequest,
});

/**
 * Create a public HTTPS fetch for counterparty-selected targets. With the
 * built-in dependencies, each call is bounded, resolves and validates every
 * address, and connects only to one validated address. Redirects are refused.
 * Only caller-provided `Accept` and `Payment-Signature` headers are accepted;
 * the transport adds `Accept-Encoding` and `User-Agent`. Injected dependencies
 * are trusted platform/test policy and must enforce the supplied addresses, bounds,
 * headers, and abort signal themselves.
 */
export function createDacsPublicHttpsFetchV1(
  options: Readonly<DacsPublicHttpsFetchOptionsV1> = {},
): typeof fetch {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_RESPONSE_BYTES) {
    throw new TypeError("public fetch bounds are invalid");
  }
  const dependencies = options.dependencies ?? defaultDependencies;
  if (typeof dependencies.resolveHost !== "function" ||
      typeof dependencies.request !== "function") {
    throw new TypeError("public fetch dependencies are invalid");
  }
  const fetchImpl = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      throw new DacsPublicHttpsFetchError("public-fetch-request-object-refused");
    }
    if ((init?.method ?? "GET").toUpperCase() !== "GET" || init?.body !== undefined &&
        init.body !== null || init?.redirect !== undefined && init.redirect !== "error") {
      throw new DacsPublicHttpsFetchError("public-fetch-request-shape-refused");
    }
    const controller = new AbortController();
    const timeoutError = new DacsPublicHttpsFetchError("public-fetch-timeout");
    let rejectDeadline: ((reason: DacsPublicHttpsFetchError) => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const timer = setTimeout(() => {
      controller.abort(timeoutError);
      rejectDeadline?.(timeoutError);
    }, timeoutMs);
    try {
      const operation = async (): Promise<Response> => {
        const value = input.toString();
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          throw new DacsPublicHttpsFetchError("public-fetch-url-invalid");
        }
        if (url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
            url.hash !== "" || value.length > 2_048 ||
            url.hostname.toLowerCase() === "localhost") {
          throw new DacsPublicHttpsFetchError("public-fetch-url-unsafe");
        }
        const literal = url.hostname.startsWith("[") && url.hostname.endsWith("]")
          ? url.hostname.slice(1, -1) : url.hostname;
        let addresses: readonly string[];
        try {
          addresses = [...new Set(await dependencies.resolveHost(literal))];
        } catch (error) {
          if (controller.signal.aborted) throw timeoutError;
          throw new DacsPublicHttpsFetchError("public-fetch-dns-unavailable");
        }
        if (controller.signal.aborted) throw timeoutError;
        if (addresses.length === 0) {
          throw new DacsPublicHttpsFetchError("public-fetch-dns-empty");
        }
        if (!addresses.every(isDacsPublicAddressV1)) {
          throw new DacsPublicHttpsFetchError("public-fetch-address-unsafe");
        }
        const response = await dependencies.request({
          url: url.toString(),
          approvedAddresses: addresses,
          headers: captureHeaders(init?.headers),
          timeoutMs,
          maxBytes,
          signal: controller.signal,
        });
        if (controller.signal.aborted) throw timeoutError;
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => undefined);
          throw new DacsPublicHttpsFetchError("public-fetch-redirect-refused");
        }
        return response;
      };
      return await Promise.race([operation(), deadline]);
    } finally {
      clearTimeout(timer);
      rejectDeadline = undefined;
    }
  };
  return fetchImpl as typeof fetch;
}
