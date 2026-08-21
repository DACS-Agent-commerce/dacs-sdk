import {
  canonicalizeDecimal,
  encodeAddressSegment,
  listingAddress,
} from "../canonical/index.js";
import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import { isRevocationBinding } from "../artifacts/validators.js";
import type { ClaimRef, RevocationBinding } from "../artifacts/types.js";
import {
  resolveBinding,
  type AnchorBinding,
  type BindingIndex,
  type BindingResolution,
} from "./binding.js";

const CONTENT_HASH = /^[0-9a-f]{64}$/;
const CLAIM_REFERENCE = /^[a-z][a-z0-9-]*:.+$/;
const DEMOS_AGENT_CLAIM = /^did:demos:agent:([0-9a-f]{64})$/;
const JSON_CONTENT_TYPE = /^(?:application\/json|application\/[a-z0-9!#$&^_.+-]+\+json)(?:\s*;|$)/i;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_PAGE_LIMIT = 200;
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_RESOLUTION_TIMEOUT_MS = 30_000;

type JsonRecord = Record<string, unknown>;

/** DACS-1 §6.3.6 operational reachability observation. Never a trust signal. */
export interface CatalogReachabilityHint {
  status: "reachable" | "unreachable" | "unknown";
  checkedAt: number;
  surface?: string;
}

/** DACS-1 §6.3.6 category-scoped, non-authoritative reputation pre-filter. */
export interface CatalogReputationHint {
  categoryScope: string;
  completionRate: number | null;
  averageSellerRating: number | null;
  bundleCount: number;
  windowStart: number;
  windowEnd: number;
  computedAt: number;
}

/**
 * DACS-1 §6.3.6 ListingSummary returned by a catalog search.
 *
 * This is candidate metadata, not a verified Listing. Consumers MUST
 * dereference `anchor` and authenticate the canonical Listing before engaging.
 */
export interface CatalogListingSummary {
  listingId: string;
  version: number;
  contentHash: string;
  anchor: { kind: string; locator: string };
  seller: { primaryClaim: ClaimRef; displayName: string };
  offering: { title: string; category: string; tags: string[] };
  pricing: { priceHint?: string; currency?: string };
  status: "active" | "revoked";
  revocation?: RevocationBinding;
  catalogObservedAt: number;
  reachabilityHint?: CatalogReachabilityHint;
  reputationHint?: CatalogReputationHint;
}

/** Standard DACS-1 §6.3.6 catalog filters. */
export interface ListingCatalogQuery {
  category?: string;
  tag?: readonly string[];
  credential?: string;
  primaryClaim?: string;
  rail?: string;
  priceMax?: string;
  minCompletionRate?: number;
  minRating?: number;
  cursor?: string;
  limit?: number;
}

export interface ListingCatalogPage {
  listings: CatalogListingSummary[];
  cursor?: string;
  total?: number;
}

export type ListingCatalogQueryResult =
  | { status: "ok"; page: ListingCatalogPage }
  | { status: "indeterminate"; reason: string };

export interface ListingCatalogClientConfig {
  /** Absolute URL of the DACS-1 §6.3.6 `GET /api/dacs/listings` endpoint. */
  catalogUrl: string;
  fetchImpl?: typeof fetch;
  /** Required to use plain HTTP, for example against an explicitly trusted local test catalog. */
  allowInsecureHttp?: boolean;
  timeoutMs?: number;
  /** Maximum decoded response bytes accepted from one catalog page. */
  maxResponseBytes?: number;
}

export interface ListingCatalogRequestOptions {
  signal?: AbortSignal;
}

export interface CatalogBindingIndexConfig extends ListingCatalogClientConfig {
  /** Page size used while resolving an exact logical address (1..200). */
  pageLimit?: number;
  /** Pagination bound; exhaustion with a remaining cursor is indeterminate. */
  maxPages?: number;
  /** Whole-resolution bound across every paged request. */
  resolutionTimeoutMs?: number;
  /** Anchor kinds the configured `readAnchor` path can dereference. */
  supportedAnchorKinds?: readonly string[];
}

interface NormalizedClientConfig {
  catalogUrl: URL;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  maxResponseBytes: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeUint(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCanonicalString(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value === value.trim() &&
    value === value.normalize("NFC") &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isClaimReference(value: unknown): value is string {
  return isCanonicalString(value) && CLAIM_REFERENCE.test(value);
}

function isAnchor(value: unknown): value is { kind: string; locator: string } {
  return (
    isRecord(value) &&
    isCanonicalString(value.kind) &&
    isCanonicalString(value.locator)
  );
}

function isSeller(
  value: unknown,
): value is { primaryClaim: string; displayName: string } {
  return (
    isRecord(value) &&
    isClaimReference(value.primaryClaim) &&
    isCanonicalString(value.displayName) &&
    value.displayName.length <= 200
  );
}

function isOffering(
  value: unknown,
): value is { title: string; category: string; tags: string[] } {
  return (
    isRecord(value) &&
    isCanonicalString(value.title) &&
    value.title.length <= 200 &&
    isCanonicalString(value.category) &&
    value.category.split(".").every((segment) => segment.length > 0) &&
    Array.isArray(value.tags) &&
    value.tags.length <= 16 &&
    value.tags.every(
      (tag) => isCanonicalString(tag) && tag.length <= 32,
    )
  );
}

function isPricing(
  value: unknown,
): value is { priceHint?: string; currency?: string } {
  if (!isRecord(value)) return false;
  if (
    value.priceHint !== undefined &&
    !isCanonicalString(value.priceHint)
  ) {
    return false;
  }
  return value.currency === undefined || isCanonicalString(value.currency);
}

function isReachabilityHint(value: unknown): value is CatalogReachabilityHint {
  return (
    isRecord(value) &&
    (value.status === "reachable" ||
      value.status === "unreachable" ||
      value.status === "unknown") &&
    isSafeUint(value.checkedAt) &&
    (value.surface === undefined || isCanonicalString(value.surface))
  );
}

function isReputationHint(
  value: unknown,
  category: string,
): value is CatalogReputationHint {
  if (
    !isRecord(value) ||
    !isCanonicalString(value.categoryScope) ||
    !(
      category === value.categoryScope ||
      category.startsWith(`${value.categoryScope}.`)
    ) ||
    !(
      value.completionRate === null ||
      (isFiniteNumber(value.completionRate) &&
        value.completionRate >= 0 &&
        value.completionRate <= 1)
    ) ||
    !(
      value.averageSellerRating === null ||
      (isFiniteNumber(value.averageSellerRating) &&
        value.averageSellerRating >= 0)
    ) ||
    !isSafeUint(value.bundleCount) ||
    !isSafeUint(value.windowStart) ||
    !isSafeUint(value.windowEnd) ||
    value.windowStart > value.windowEnd ||
    !isSafeUint(value.computedAt)
  ) {
    return false;
  }
  return true;
}

function revocationMatchesSummary(
  revocation: RevocationBinding,
  summary: JsonRecord,
): boolean {
  const seller = summary.seller as { primaryClaim: string };
  const expectedLogicalAddress =
    `dacs1-revoked:${encodeAddressSegment(seller.primaryClaim)}:` +
    `${String(summary.listingId)}:v${String(summary.version)}`;
  return (
    revocation.sellerPrimaryClaim === seller.primaryClaim &&
    revocation.listingId === summary.listingId &&
    revocation.listingVersion === summary.version &&
    revocation.listingContentHash === summary.contentHash &&
    revocation.logicalAddress === expectedLogicalAddress
  );
}

function isCatalogListingSummary(value: unknown): value is CatalogListingSummary {
  if (
    !isRecord(value) ||
    !isCanonicalString(value.listingId) ||
    !/^[A-Za-z0-9._~-]{1,128}$/.test(value.listingId) ||
    !isPositiveSafeInt(value.version) ||
    typeof value.contentHash !== "string" ||
    !CONTENT_HASH.test(value.contentHash) ||
    !isAnchor(value.anchor) ||
    !isSeller(value.seller) ||
    !isOffering(value.offering) ||
    !isPricing(value.pricing) ||
    (value.status !== "active" && value.status !== "revoked") ||
    !isSafeUint(value.catalogObservedAt) ||
    (value.reachabilityHint !== undefined &&
      !isReachabilityHint(value.reachabilityHint)) ||
    (value.reputationHint !== undefined &&
      !isReputationHint(value.reputationHint, value.offering.category))
  ) {
    return false;
  }
  if (value.status === "active") return value.revocation === undefined;
  return (
    isRevocationBinding(value.revocation) &&
    revocationMatchesSummary(value.revocation, value)
  );
}

function positiveConfigInt(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function normalizeClientConfig(
  config: ListingCatalogClientConfig,
): NormalizedClientConfig {
  if (!config || typeof config !== "object") {
    throw new TypeError("catalog client configuration is required");
  }
  if (typeof config.catalogUrl !== "string") {
    throw new TypeError("catalogUrl must be an absolute URL string");
  }
  let catalogUrl: URL;
  try {
    catalogUrl = new URL(config.catalogUrl);
  } catch {
    throw new TypeError("catalogUrl must be an absolute URL");
  }
  if (catalogUrl.username || catalogUrl.password) {
    throw new TypeError("catalogUrl must not contain credentials");
  }
  if (catalogUrl.search || catalogUrl.hash) {
    throw new TypeError("catalogUrl must not contain a query or fragment");
  }
  if (
    catalogUrl.protocol !== "https:" &&
    !(config.allowInsecureHttp === true && catalogUrl.protocol === "http:")
  ) {
    throw new TypeError(
      "catalogUrl must use HTTPS unless allowInsecureHttp is explicitly enabled",
    );
  }
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("catalog client requires a fetch implementation");
  }
  return {
    catalogUrl,
    fetchImpl,
    timeoutMs: positiveConfigInt(
      config.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      "timeoutMs",
    ),
    maxResponseBytes: positiveConfigInt(
      config.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    ),
  };
}

function queryString(value: unknown, label: string): string {
  if (!isCanonicalString(value)) {
    throw new TypeError(`${label} must be a non-empty, trimmed NFC string`);
  }
  return value;
}

function buildCatalogUrl(
  base: URL,
  query: ListingCatalogQuery,
): URL {
  const url = new URL(base.href);
  const params = url.searchParams;
  if (query.category !== undefined) {
    params.set("category", queryString(query.category, "category"));
  }
  if (query.tag !== undefined) {
    if (!Array.isArray(query.tag)) throw new TypeError("tag must be an array");
    for (const tag of query.tag) params.append("tag", queryString(tag, "tag"));
  }
  if (query.credential !== undefined) {
    params.set("credential", queryString(query.credential, "credential"));
  }
  if (query.primaryClaim !== undefined) {
    params.set("primaryClaim", queryString(query.primaryClaim, "primaryClaim"));
  }
  if (query.rail !== undefined) {
    params.set("rail", queryString(query.rail, "rail"));
  }
  if (query.priceMax !== undefined) {
    const priceMax = queryString(query.priceMax, "priceMax");
    try {
      canonicalizeDecimal(priceMax);
    } catch {
      throw new TypeError("priceMax must be a plain non-negative decimal");
    }
    params.set("priceMax", priceMax);
  }
  if (query.minCompletionRate !== undefined) {
    if (
      !isFiniteNumber(query.minCompletionRate) ||
      query.minCompletionRate < 0 ||
      query.minCompletionRate > 1
    ) {
      throw new TypeError("minCompletionRate must be between 0 and 1");
    }
    params.set("minCompletionRate", String(query.minCompletionRate));
  }
  if (query.minRating !== undefined) {
    if (!isFiniteNumber(query.minRating) || query.minRating < 0) {
      throw new TypeError("minRating must be a non-negative finite number");
    }
    params.set("minRating", String(query.minRating));
  }
  if (query.cursor !== undefined) {
    params.set("cursor", queryString(query.cursor, "cursor"));
  }
  if (query.limit !== undefined) {
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 200
    ) {
      throw new TypeError("limit must be an integer between 1 and 200");
    }
    params.set("limit", String(query.limit));
  }
  return url;
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (contentType !== null && !JSON_CONTENT_TYPE.test(contentType)) {
    throw new Error("catalog response content type is not JSON");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error("catalog response has an invalid Content-Length");
    }
    if (parsed > maxBytes) throw new Error("catalog response exceeds maxResponseBytes");
  }

  if (response.body === null) throw new Error("catalog response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("catalog response exceeds maxResponseBytes");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("catalog response is not valid UTF-8 JSON");
  }
  return snapshotCanonicalJsonRead(parsed, "catalog response");
}

function validateCatalogPage(value: unknown): ListingCatalogPage | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.listings) ||
    !value.listings.every(isCatalogListingSummary) ||
    (value.cursor !== undefined && !isCanonicalString(value.cursor)) ||
    (value.total !== undefined && !isSafeUint(value.total))
  ) {
    return null;
  }
  return value as unknown as ListingCatalogPage;
}

async function queryCatalogPage(
  config: NormalizedClientConfig,
  query: ListingCatalogQuery,
  options: ListingCatalogRequestOptions,
): Promise<ListingCatalogQueryResult> {
  const url = buildCatalogUrl(config.catalogUrl, query);

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("catalog request timed out"));
  }, config.timeoutMs);
  const externalSignal = options.signal;
  const onAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) onAbort();
  else externalSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await config.fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        status: "indeterminate",
        reason: `catalog returned HTTP ${response.status}`,
      };
    }
    const page = validateCatalogPage(
      await readBoundedJson(response, config.maxResponseBytes),
    );
    return page
      ? { status: "ok", page }
      : {
          status: "indeterminate",
          reason: "catalog returned a malformed DACS-1 §6.3.6 page",
        };
  } catch (error) {
    if (externalSignal?.aborted) {
      return { status: "indeterminate", reason: "catalog request was aborted" };
    }
    if (timedOut) {
      return { status: "indeterminate", reason: "catalog request timed out" };
    }
    return {
      status: "indeterminate",
      reason:
        "catalog request failed: " +
        (error instanceof Error ? error.message : String(error)),
    };
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Query one page of an open DACS-1 §6.3.6 catalog.
 *
 * An `ok` result means only that the catalog response was well formed. Every
 * returned summary remains untrusted candidate metadata until its anchor is
 * dereferenced and the signed Listing is validated.
 */
export async function queryListingCatalog(
  config: ListingCatalogClientConfig,
  query: ListingCatalogQuery = {},
  options: ListingCatalogRequestOptions = {},
): Promise<ListingCatalogQueryResult> {
  return queryCatalogPage(normalizeClientConfig(config), query, options);
}

function bindingOwner(primaryClaim: string): string {
  return DEMOS_AGENT_CLAIM.exec(primaryClaim)?.[1] ?? primaryClaim;
}

function candidateBinding(
  summary: CatalogListingSummary,
  logicalAddress: string,
): AnchorBinding {
  return {
    logicalAddress,
    nativeAddress: summary.anchor.locator,
    owner: bindingOwner(summary.seller.primaryClaim),
    contentHash: summary.contentHash,
    version: summary.version,
    ...(summary.status === "revoked" ? { revoked: true } : {}),
  };
}

function supportedKinds(config: CatalogBindingIndexConfig): Set<string> {
  const values = config.supportedAnchorKinds ?? ["storage-program"];
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("supportedAnchorKinds must be a non-empty array");
  }
  const result = new Set<string>();
  for (const value of values) {
    result.add(queryString(value, "supportedAnchorKinds entry"));
  }
  return result;
}

/**
 * Adapt a DACS-1 §6.3.6 catalog to the SDK's discovery-only BindingIndex.
 *
 * Resolution scans bounded catalog pages for the exact CF-4 logical address.
 * It never guesses through conflicting results, unsupported anchor kinds,
 * transport failure, malformed pages, or incomplete pagination. The resulting
 * binding is still only a pointer: `Agent.readListing` must dereference it and
 * authenticate the anchored Listing before use (§6.3.6, Catalog client).
 */
export function createCatalogBindingIndex(
  config: CatalogBindingIndexConfig,
): BindingIndex {
  const client = normalizeClientConfig(config);
  const pageLimit = positiveConfigInt(
    config.pageLimit,
    DEFAULT_PAGE_LIMIT,
    "pageLimit",
  );
  if (pageLimit > 200) throw new TypeError("pageLimit must not exceed 200");
  const maxPages = positiveConfigInt(
    config.maxPages,
    DEFAULT_MAX_PAGES,
    "maxPages",
  );
  const resolutionTimeoutMs = positiveConfigInt(
    config.resolutionTimeoutMs,
    DEFAULT_RESOLUTION_TIMEOUT_MS,
    "resolutionTimeoutMs",
  );
  const allowedAnchorKinds = supportedKinds(config);

  return {
    async resolve(
      logicalAddress: string,
      expectedOwner: string,
    ): Promise<BindingResolution> {
      const resolutionController = new AbortController();
      const resolutionTimeout = setTimeout(
        () => resolutionController.abort(new Error("catalog resolution timed out")),
        resolutionTimeoutMs,
      );
      const candidates: AnchorBinding[] = [];
      const seenCursors = new Set<string>();
      let expectedTotal: number | undefined;
      let observedCount = 0;
      let cursor: string | undefined;

      try {
        for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
          const result = await queryCatalogPage(
            client,
            { limit: pageLimit, ...(cursor === undefined ? {} : { cursor }) },
            { signal: resolutionController.signal },
          );
          if (resolutionController.signal.aborted) {
            return {
              status: "indeterminate",
              reason: "catalog resolution timed out",
            };
          }
          if (result.status === "indeterminate") return result;

          const pageTotal = result.page.total;
          if (
            pageTotal !== undefined &&
            expectedTotal !== undefined &&
            pageTotal !== expectedTotal
          ) {
            return {
              status: "indeterminate",
              reason: "catalog pagination total changed during resolution",
            };
          }
          if (pageTotal !== undefined) expectedTotal = pageTotal;
          observedCount += result.page.listings.length;
          if (expectedTotal !== undefined && observedCount > expectedTotal) {
            return {
              status: "indeterminate",
              reason: "catalog pagination returned more listings than total",
            };
          }

          for (const summary of result.page.listings) {
            const candidateAddress = listingAddress(
              summary.seller.primaryClaim,
              summary.listingId,
              summary.version,
            );
            if (candidateAddress !== logicalAddress) continue;
            if (!allowedAnchorKinds.has(summary.anchor.kind)) {
              return {
                status: "indeterminate",
                reason:
                  `catalog candidate for ${logicalAddress} uses unsupported ` +
                  `anchor kind ${summary.anchor.kind}`,
              };
            }
            candidates.push(candidateBinding(summary, candidateAddress));
          }

          const nextCursor = result.page.cursor;
          if (nextCursor === undefined) {
            if (expectedTotal !== undefined && observedCount !== expectedTotal) {
              return {
                status: "indeterminate",
                reason: "catalog pagination ended before the advertised total",
              };
            }
            return resolveBinding(candidates, logicalAddress, expectedOwner);
          }
          if (seenCursors.has(nextCursor) || nextCursor === cursor) {
            return {
              status: "indeterminate",
              reason: "catalog pagination cursor did not make progress",
            };
          }
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }

        return {
          status: "indeterminate",
          reason: `catalog pagination exceeded the configured ${maxPages}-page bound`,
        };
      } finally {
        clearTimeout(resolutionTimeout);
      }
    },
  };
}
