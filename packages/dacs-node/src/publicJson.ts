import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

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

const ipv4Number = (address: string): number | null => {
  if (isIP(address) !== 4) return null;
  return address.split(".").map(Number)
    .reduce((value, part) => value * 256 + part, 0) >>> 0;
};

const ipv4InCidr = (value: number, base: string, prefix: number): boolean => {
  const baseValue = ipv4Number(base);
  if (baseValue === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseValue & mask);
};

function ipv6Number(address: string): bigint | null {
  if (address.includes("%")) return null;
  let value = address.toLowerCase();
  const ipv4Tail = value.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail) {
    const encoded = ipv4Number(ipv4Tail);
    if (encoded === null) return null;
    value = `${value.slice(0, -ipv4Tail.length)}${(encoded >>> 16).toString(16)}:${(
      encoded & 0xffff
    ).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }
  return groups.reduce(
    (result, group) => (result << 16n) | BigInt(parseInt(group, 16)),
    0n,
  );
}

const ipv6InCidr = (value: bigint, base: string, prefix: number): boolean => {
  const baseValue = ipv6Number(base);
  if (baseValue === null) return false;
  const shift = BigInt(128 - prefix);
  return value >> shift === baseValue >> shift;
};

function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address)!;
    return ![
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
      ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
      ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.31.196.0", 24],
      ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
      ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24],
      ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
    ].some(([base, prefix]) => ipv4InCidr(value, base as string, prefix as number));
  }
  if (family === 6) {
    const value = ipv6Number(address);
    if (value === null) return false;
    return ![
      ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96],
      ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23],
      ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7],
      ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
    ].some(([base, prefix]) => ipv6InCidr(value, base as string, prefix as number));
  }
  return false;
}

async function resolvePublicHost(hostname: string): Promise<readonly string[]> {
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
      lookup: (_hostname, _options, callback) => callback(null, address, family),
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
  resolveHost: resolvePublicHost,
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
  if (!addresses.every(publicAddress)) {
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
