import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import { isDacsPublicAddressV1 } from "@kynesyslabs/dacs";

export { isDacsPublicAddressV1 } from "@kynesyslabs/dacs";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 1_048_576;

export interface DacsPublicJsonResponseV1 {
  status: number;
  contentType: string;
  bytes: Uint8Array;
  redirected?: boolean;
}

export interface DacsPublicJsonReadDependenciesV1 {
  resolveHost(hostname: string): Promise<readonly string[]>;
  request(input: Readonly<{
    url: string;
    approvedAddresses: readonly string[];
    timeoutMs: number;
    maxBytes: number;
  }>): Promise<Readonly<DacsPublicJsonResponseV1>>;
}

export interface DacsPublicJsonReadOptionsV1 {
  timeoutMs?: number;
  maxBytes?: number;
  dependencies?: Readonly<DacsPublicJsonReadDependenciesV1>;
}

export class DacsPublicJsonError extends Error {
  override readonly name = "DacsPublicJsonError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

export async function resolveDacsPublicHostV1(
  hostname: string,
): Promise<readonly string[]> {
  const literal = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1) : hostname;
  if (isIP(literal) !== 0) return [literal];
  const records = await lookup(literal, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function pinnedHttpsRequest(input: Readonly<{
  url: string;
  approvedAddresses: readonly string[];
  timeoutMs: number;
  maxBytes: number;
}>): Promise<Readonly<DacsPublicJsonResponseV1>> {
  return new Promise((resolve, reject) => {
    const url = new URL(input.url);
    const address = input.approvedAddresses[0];
    if (address === undefined) {
      reject(new DacsPublicJsonError("public-json-dns-empty"));
      return;
    }
    const family = isIP(address);
    const request = httpsRequest({
      protocol: "https:",
      hostname: url.hostname,
      port: url.port === "" ? 443 : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      servername: isIP(url.hostname) === 0 ? url.hostname : undefined,
      headers: {
        accept: "application/json",
        "accept-encoding": "identity",
        "user-agent": "dacs-node-public-json/v1",
      },
      lookup: (_hostname, options, callback) => {
        // Node 20.13+ may request every candidate (`all: true`) for its
        // connection-attempt scheduler. Returning the legacy scalar tuple to
        // that overload produces ERR_INVALID_IP_ADDRESS before TLS starts.
        // Preserve DNS pinning while satisfying both lookup callback shapes.
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
      response.on("data", (chunk: Buffer | string) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
        total += bytes.byteLength;
        if (total > input.maxBytes) {
          request.destroy(new DacsPublicJsonError("public-json-response-too-large"));
          return;
        }
        chunks.push(bytes);
      });
      response.once("end", () => resolve(Object.freeze({
        status: response.statusCode ?? 0,
        contentType: typeof response.headers["content-type"] === "string"
          ? response.headers["content-type"] : "",
        bytes: Uint8Array.from(Buffer.concat(chunks, total)),
        redirected: (response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400,
      })));
    });
    request.setTimeout(input.timeoutMs, () => {
      request.destroy(new DacsPublicJsonError("public-json-timeout"));
    });
    request.once("error", reject);
    request.end();
  });
}

const defaultDependencies: Readonly<DacsPublicJsonReadDependenciesV1> = Object.freeze({
  resolveHost: resolveDacsPublicHostV1,
  request: pinnedHttpsRequest,
});

/** Read bounded JSON only from a DNS-pinned public HTTPS endpoint. */
export async function readDacsPublicJsonV1(
  value: string,
  options: Readonly<DacsPublicJsonReadOptionsV1> = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 2_097_152) {
    throw new TypeError("public JSON read bounds are invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DacsPublicJsonError("public-json-url-invalid");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
      url.hash !== "" || value.length > 2_048 || url.hostname.toLowerCase() === "localhost") {
    throw new DacsPublicJsonError("public-json-url-unsafe");
  }
  const dependencies = options.dependencies ?? defaultDependencies;
  let addresses: readonly string[];
  try {
    addresses = [...new Set(await dependencies.resolveHost(url.hostname))];
  } catch {
    throw new DacsPublicJsonError("public-json-dns-unavailable");
  }
  if (addresses.length === 0) throw new DacsPublicJsonError("public-json-dns-empty");
  if (!addresses.every(isDacsPublicAddressV1)) {
    throw new DacsPublicJsonError("public-json-address-unsafe");
  }
  let response: Readonly<DacsPublicJsonResponseV1>;
  try {
    response = await dependencies.request({
      url: url.toString(), approvedAddresses: addresses, timeoutMs, maxBytes,
    });
  } catch (error) {
    if (error instanceof DacsPublicJsonError) throw error;
    throw new DacsPublicJsonError("public-json-request-unavailable");
  }
  if (response.redirected === true || response.status >= 300 && response.status < 400) {
    throw new DacsPublicJsonError("public-json-redirect-refused");
  }
  if (response.status < 200 || response.status >= 300) {
    throw new DacsPublicJsonError("public-json-http-status-invalid");
  }
  if (!/^(?:application\/json|application\/[a-z0-9!#$&^_.+-]+\+json)(?:\s*;|$)/iu
    .test(response.contentType)) {
    throw new DacsPublicJsonError("public-json-content-type-invalid");
  }
  if (!(response.bytes instanceof Uint8Array) || response.bytes.byteLength === 0 ||
      response.bytes.byteLength > maxBytes) {
    throw new DacsPublicJsonError("public-json-response-size-invalid");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(response.bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new DacsPublicJsonError("public-json-body-invalid");
  } finally {
    text = "";
  }
}
