import { sha256Hex, canonicalize } from "../canonical/index.js";
import { SubstrateError } from "../errors.js";

const VOLATILE_HEADERS = new Set([
  "date", "set-cookie", "connection", "keep-alive", "transfer-encoding", "upgrade",
  "proxy-authenticate", "proxy-authorization", "te", "trailer", "via", "warning",
  "server", "content-length",
]);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Pinned node 61b8e75, Proxy.canonicalizeHeaders: omit volatile headers,
// lowercase names, trim values, join arrays and sort by name before hashing.
function headersHash(headers: unknown): string | null {
  if (!record(headers)) return null;
  const entries: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (VOLATILE_HEADERS.has(key) || value == null) continue;
    if (typeof value !== "string" &&
        !(Array.isArray(value) && value.every((part) => typeof part === "string"))) return null;
    entries.push([key, (Array.isArray(value) ? value.join(", ") : value).trim()]);
  }
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return sha256Hex(entries.map(([key, value]) => `${key}:${value}`).join("\n"));
}

/** Bind the included SDK web2Request payload to exact returned UTF-8 data. */
export function assertDahrCommitment(
  transaction: Record<string, unknown>,
  request: { url: string; method: string; headers: Record<string, string>; body?: string },
  response: unknown,
): asserts response is Record<string, unknown> & {
  data: string; status: number; responseHash: string; responseHeadersHash: string;
} {
  const content = transaction.content;
  const data = record(content) ? content.data : undefined;
  const payload = Array.isArray(data) && data.length === 2 && data[0] === "web2Request" ? data[1] : undefined;
  const message = record(payload) ? payload.message : undefined;
  const web2 = record(message) ? message.web2Request : undefined;
  const raw = record(web2) ? web2.raw : undefined;
  const result = record(web2) ? web2.result : undefined;
  const requestHash = request.body === undefined ? undefined : sha256Hex(request.body);
  if (!record(content) || content.type !== "web2Request" || !record(raw) || !record(result) ||
      !record(response) || typeof response.data !== "string" ||
      !Number.isInteger(response.status) || (response.status as number) < 100 || (response.status as number) > 599 ||
      raw.action !== "startProxy" || raw.url !== request.url || result.targetUrl !== request.url || raw.method !== request.method ||
      canonicalize(raw.headers ?? {}) !== canonicalize(request.headers) ||
      result.status !== response.status ||
      typeof response.responseHash !== "string" || !/^[0-9a-f]{64}$/.test(response.responseHash) ||
      response.responseHash !== sha256Hex(response.data) || result.responseHash !== response.responseHash ||
      typeof response.responseHeadersHash !== "string" || !/^[0-9a-f]{64}$/.test(response.responseHeadersHash) ||
      result.responseHeadersHash !== response.responseHeadersHash ||
      headersHash(response.headers) !== response.responseHeadersHash ||
      headersHash(result.headers) !== response.responseHeadersHash ||
      result.requestHash !== requestHash || response.requestHash !== requestHash) {
    throw new SubstrateError("DAHR canonical web2Request commitment does not match the request and response");
  }
  // The pinned node decodes bytes as UTF-8 before hashing. An authenticated
  // hash therefore cannot make an arbitrary binary response byte-preserving.
  // Inspect the committed headers only after authenticating their hash.
  const contentTypes = Object.entries(result.headers as Record<string, unknown>)
    .filter(([name]) => name.toLowerCase() === "content-type");
  const contentType = contentTypes.length === 1 && typeof contentTypes[0]![1] === "string"
    ? contentTypes[0]![1].split(";", 1)[0]!.trim().toLowerCase()
    : "";
  if (!/^(?:text\/[a-z0-9!#$&^_.+-]+|application\/(?:json|xml)|[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+\+(?:json|xml))$/.test(contentType)) {
    throw new SubstrateError("DAHR body is not byte-preserving: unsupported response content-type");
  }
}
