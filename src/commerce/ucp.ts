import { canonicalize, sha256Hex } from "../canonical/index.js";
import {
  snapshotCanonicalJson,
  snapshotCanonicalJsonRead,
} from "../canonical/snapshot.js";
import { CounterpartyError, DacsError, TransientError } from "../errors.js";

/** UCP release exercised by the experimental DACS composition profile. */
export const UCP_MVP_VERSION = "2026-08-25" as const;
export const UCP_SHOPPING_SERVICE = "dev.ucp.shopping" as const;
export const UCP_CHECKOUT_CAPABILITY = "dev.ucp.shopping.checkout" as const;

/**
 * DACS-owned experimental namespace. This is deliberately not an assertion
 * that x402.org has registered an official UCP payment handler.
 */
export const DACS_UCP_X402_HANDLER =
  "io.github.dacs-agent-commerce.payment.x402" as const;

export type UcpCheckoutStatus =
  | "incomplete"
  | "requires_escalation"
  | "ready_for_complete"
  | "complete_in_progress"
  | "completed"
  | "canceled";

export interface UcpProfileKey {
  kid: string;
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  alg?: string;
  use?: string;
  [key: string]: unknown;
}

export interface UcpBusinessProfile {
  ucp: {
    version: string;
    services: Record<string, Array<Record<string, unknown>>>;
    capabilities?: Record<string, Array<Record<string, unknown>>>;
    payment_handlers: Record<string, Array<Record<string, unknown>>>;
    [key: string]: unknown;
  };
  keys: UcpProfileKey[];
  [key: string]: unknown;
}

export interface UcpX402HandlerConfig {
  railId: string;
  network: `eip155:${number}`;
  /** ISO 4217 Checkout currency; distinct from the settlement token symbol. */
  checkoutCurrency: string;
  checkoutCurrencyDecimals: number;
  /** MVP conversion policy: one asset display unit per checkout currency unit. */
  assetAmountPerCheckoutUnit: "1";
  asset: `0x${string}`;
  assetSymbol: string;
  assetDecimals: number;
  payTo: `0x${string}`;
  resource: string;
  finalityBlocks: number;
}

export interface UcpX402HandlerSnapshot {
  name: typeof DACS_UCP_X402_HANDLER;
  id: string;
  version: string;
  config: Readonly<UcpX402HandlerConfig>;
}

export interface UcpBusinessProfileSnapshot {
  profileUrl: string;
  profileHash: string;
  version: string;
  shoppingEndpoint: string;
  keyIds: readonly string[];
  x402: Readonly<UcpX402HandlerSnapshot>;
  profile: Readonly<UcpBusinessProfile>;
}

export interface UcpLineItemRequest {
  item: { id: string };
  quantity: number;
}

export interface UcpCheckoutRequest {
  line_items: UcpLineItemRequest[];
}

export interface UcpPaymentCredential {
  type: string;
  [key: string]: unknown;
}

export interface UcpPaymentInstrument {
  id: string;
  handler_id: string;
  type: string;
  selected: boolean;
  credential: UcpPaymentCredential;
}

export interface UcpCompleteCheckoutRequest {
  payment: { instruments: UcpPaymentInstrument[] };
}

export interface UcpCheckout {
  ucp: {
    version: string;
    payment_handlers: Record<string, Array<Record<string, unknown>>>;
    [key: string]: unknown;
  };
  id: string;
  line_items: Array<{
    id: string;
    item: { id: string; title: string; price: number; [key: string]: unknown };
    quantity: number;
    totals: Array<{ type: string; amount: number; [key: string]: unknown }>;
    [key: string]: unknown;
  }>;
  status: UcpCheckoutStatus;
  currency: string;
  totals: Array<{ type: string; amount: number; [key: string]: unknown }>;
  links: Array<Record<string, unknown>>;
  expires_at?: string;
  order?: { id: string; permalink_url: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface UcpOrder {
  ucp: { version: string; [key: string]: unknown };
  id: string;
  checkout_id: string;
  permalink_url: string;
  line_items: Array<Record<string, unknown>>;
  fulfillment: {
    expectations?: Array<Record<string, unknown>>;
    events?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  currency: string;
  totals: Array<{ type: string; amount: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface UcpRestClient {
  createCheckout(
    request: Readonly<UcpCheckoutRequest>,
    idempotencyKey: string,
  ): Promise<Readonly<UcpCheckout>>;
  getCheckout(id: string): Promise<Readonly<UcpCheckout>>;
  completeCheckout(
    id: string,
    request: Readonly<UcpCompleteCheckoutRequest>,
    idempotencyKey: string,
  ): Promise<Readonly<UcpCheckout>>;
  getOrder(id: string): Promise<Readonly<UcpOrder>>;
}

const HASH_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;
const EIP155_RE = /^eip155:([1-9][0-9]*)$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ISO_4217_RE = /^[A-Z]{3}$/;
const PRIVATE_JWK_MEMBERS = new Set([
  "d",
  "p",
  "q",
  "dp",
  "dq",
  "qi",
  "oth",
  "k",
]);
const CHECKOUT_STATUSES: ReadonlySet<string> = new Set([
  "incomplete",
  "requires_escalation",
  "ready_for_complete",
  "complete_in_progress",
  "completed",
  "canceled",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;
const safeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0);

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Production URLs require TLS; loopback HTTP is admitted only for the local MVP. */
export function requireUcpHttpUrl(value: unknown, label: string): string {
  if (!nonEmpty(value)) throw new DacsError(`${label} must be a non-empty URL`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DacsError(`${label} must be an absolute URL`);
  }
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new DacsError(`${label} must use HTTPS (or loopback HTTP) without credentials or a fragment`);
  }
  return url.toString();
}

function requireVersion(value: unknown, label: string): string {
  if (!nonEmpty(value) || !VERSION_RE.test(value)) {
    throw new DacsError(`${label} must be a UCP YYYY-MM-DD version`);
  }
  return value;
}

function requireEntryArray(
  registry: unknown,
  name: string,
  label: string,
): Array<Record<string, unknown>> {
  if (!isRecord(registry)) throw new DacsError(`${label} registry is missing`);
  const entries = registry[name];
  if (!Array.isArray(entries) || entries.length === 0 || !entries.every(isRecord)) {
    throw new DacsError(`${label} ${name} declaration is missing or malformed`);
  }
  return entries;
}

function parseX402Config(value: unknown): UcpX402HandlerConfig {
  if (!isRecord(value)) throw new DacsError("UCP x402 handler config is missing");
  const networkMatch = typeof value.network === "string" ? EIP155_RE.exec(value.network) : null;
  const chainId = networkMatch ? Number(networkMatch[1]) : 0;
  if (
    !nonEmpty(value.railId) ||
    !networkMatch ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    !nonEmpty(value.checkoutCurrency) ||
    !ISO_4217_RE.test(value.checkoutCurrency) ||
    !safeInteger(value.checkoutCurrencyDecimals) ||
    value.checkoutCurrencyDecimals !== 2 ||
    value.assetAmountPerCheckoutUnit !== "1" ||
    !nonEmpty(value.asset) ||
    !EVM_ADDRESS_RE.test(value.asset) ||
    !nonEmpty(value.assetSymbol) ||
    !safeInteger(value.assetDecimals) ||
    value.assetDecimals < 0 ||
    value.assetDecimals > 255 ||
    !nonEmpty(value.payTo) ||
    !EVM_ADDRESS_RE.test(value.payTo) ||
    !safeInteger(value.finalityBlocks) ||
    value.finalityBlocks <= 0
  ) {
    throw new DacsError(
      "UCP x402 handler payment coordinates are malformed (the MVP supports two-decimal ISO 4217 presentment)",
    );
  }
  return {
    railId: value.railId,
    network: value.network as `eip155:${number}`,
    checkoutCurrency: value.checkoutCurrency,
    checkoutCurrencyDecimals: value.checkoutCurrencyDecimals,
    assetAmountPerCheckoutUnit: "1",
    asset: value.asset as `0x${string}`,
    assetSymbol: value.assetSymbol,
    assetDecimals: value.assetDecimals,
    payTo: value.payTo as `0x${string}`,
    resource: requireUcpHttpUrl(value.resource, "UCP x402 resource"),
    finalityBlocks: value.finalityBlocks,
  };
}

/** Hash complete JSON data. Unlike DACS artifact contentHash, no field is omitted. */
export function ucpDataHash(value: unknown): string {
  return sha256Hex(canonicalize(snapshotCanonicalJsonRead(value, "UCP hash input")));
}

/**
 * Authenticateable discovery projection for the experimental profile. This is
 * intentionally stricter than generic UCP parsing: one exact release, REST
 * shopping, Checkout, an explicit DACS x402 handler, and public signing keys.
 */
export function parseUcpBusinessProfile(
  profileUrlValue: string,
  value: unknown,
): Readonly<UcpBusinessProfileSnapshot> {
  const profileUrl = requireUcpHttpUrl(profileUrlValue, "UCP profile URL");
  const profile = snapshotCanonicalJsonRead(value, "UCP business profile") as unknown;
  if (!isRecord(profile) || !isRecord(profile.ucp)) {
    throw new DacsError("UCP business profile must contain a ucp object");
  }
  const version = requireVersion(profile.ucp.version, "UCP profile version");
  if (version !== UCP_MVP_VERSION) {
    throw new DacsError(`UCP MVP requires exact release ${UCP_MVP_VERSION}, received ${version}`);
  }

  const shopping = requireEntryArray(
    profile.ucp.services,
    UCP_SHOPPING_SERVICE,
    "UCP service",
  ).find((entry) => entry.transport === "rest" && entry.version === version);
  if (!shopping) throw new DacsError("UCP profile has no matching REST shopping service");
  const shoppingEndpoint = requireUcpHttpUrl(
    shopping.endpoint,
    "UCP REST shopping endpoint",
  );

  const checkout = requireEntryArray(
    profile.ucp.capabilities,
    UCP_CHECKOUT_CAPABILITY,
    "UCP capability",
  ).find((entry) => entry.version === version);
  if (!checkout) throw new DacsError("UCP profile has no matching Checkout capability");

  const rawHandler = requireEntryArray(
    profile.ucp.payment_handlers,
    DACS_UCP_X402_HANDLER,
    "UCP payment handler",
  ).find((entry) => entry.version === version);
  if (!rawHandler || !nonEmpty(rawHandler.id)) {
    throw new DacsError("UCP profile has no matching DACS x402 handler instance");
  }
  const x402: UcpX402HandlerSnapshot = {
    name: DACS_UCP_X402_HANDLER,
    id: rawHandler.id,
    version,
    config: parseX402Config(rawHandler.config),
  };

  if (!Array.isArray(profile.keys) || profile.keys.length === 0) {
    throw new DacsError("UCP identity composition requires at least one public profile key");
  }
  const keyIds: string[] = [];
  for (const rawKey of profile.keys) {
    if (!isRecord(rawKey) || !nonEmpty(rawKey.kid) || !nonEmpty(rawKey.kty)) {
      throw new DacsError("UCP profile contains a malformed public JWK");
    }
    if (Object.keys(rawKey).some((key) => PRIVATE_JWK_MEMBERS.has(key))) {
      throw new DacsError("UCP profile must never expose private JWK material");
    }
    if (keyIds.includes(rawKey.kid)) throw new DacsError("UCP profile key ids must be unique");
    keyIds.push(rawKey.kid);
  }

  return snapshotCanonicalJson({
    profileUrl,
    profileHash: ucpDataHash(profile),
    version,
    shoppingEndpoint,
    keyIds: [...keyIds].sort(),
    x402,
    profile: profile as unknown as UcpBusinessProfile,
  }, "UCP business profile snapshot");
}

function asCheckout(value: unknown): Readonly<UcpCheckout> {
  const checkout = snapshotCanonicalJsonRead(value, "UCP Checkout response") as unknown;
  if (
    !isRecord(checkout) ||
    !isRecord(checkout.ucp) ||
    checkout.ucp.version !== UCP_MVP_VERSION ||
    !isRecord(checkout.ucp.payment_handlers) ||
    !nonEmpty(checkout.id) ||
    !Array.isArray(checkout.line_items) ||
    checkout.line_items.length === 0 ||
    !nonEmpty(checkout.status) ||
    !CHECKOUT_STATUSES.has(checkout.status) ||
    !nonEmpty(checkout.currency) ||
    !Array.isArray(checkout.totals) ||
    !Array.isArray(checkout.links)
  ) {
    throw new CounterpartyError("merchant returned a malformed UCP Checkout");
  }
  for (const line of checkout.line_items) {
    if (
      !isRecord(line) ||
      !nonEmpty(line.id) ||
      !isRecord(line.item) ||
      !nonEmpty(line.item.id) ||
      !nonEmpty(line.item.title) ||
      !safeInteger(line.item.price) ||
      line.item.price < 0 ||
      !safeInteger(line.quantity) ||
      line.quantity <= 0 ||
      !Array.isArray(line.totals)
    ) {
      throw new CounterpartyError("merchant returned a malformed UCP Checkout line item");
    }
  }
  const totalRows = checkout.totals.filter(
    (entry) => isRecord(entry) && entry.type === "total" && safeInteger(entry.amount),
  );
  const subtotalRows = checkout.totals.filter(
    (entry) => isRecord(entry) && entry.type === "subtotal" && safeInteger(entry.amount),
  );
  if (totalRows.length !== 1 || subtotalRows.length !== 1) {
    throw new CounterpartyError("UCP Checkout must contain exactly one subtotal and total");
  }
  if (checkout.expires_at !== undefined) {
    if (!nonEmpty(checkout.expires_at) || !Number.isFinite(Date.parse(checkout.expires_at))) {
      throw new CounterpartyError("UCP Checkout expires_at is malformed");
    }
  }
  if (checkout.status === "completed") {
    if (
      !isRecord(checkout.order) ||
      !nonEmpty(checkout.order.id) ||
      !nonEmpty(checkout.order.permalink_url)
    ) {
      throw new CounterpartyError("completed UCP Checkout must carry an order confirmation");
    }
    requireUcpHttpUrl(checkout.order.permalink_url, "UCP order permalink");
  }
  return checkout as unknown as Readonly<UcpCheckout>;
}

function asOrder(value: unknown): Readonly<UcpOrder> {
  const order = snapshotCanonicalJsonRead(value, "UCP Order response") as unknown;
  if (
    !isRecord(order) ||
    !isRecord(order.ucp) ||
    order.ucp.version !== UCP_MVP_VERSION ||
    !nonEmpty(order.id) ||
    !nonEmpty(order.checkout_id) ||
    !nonEmpty(order.permalink_url) ||
    !Array.isArray(order.line_items) ||
    !isRecord(order.fulfillment) ||
    !nonEmpty(order.currency) ||
    !Array.isArray(order.totals)
  ) {
    throw new CounterpartyError("merchant returned a malformed UCP Order");
  }
  requireUcpHttpUrl(order.permalink_url, "UCP order permalink");
  return order as unknown as Readonly<UcpOrder>;
}

function endpoint(base: string, path: string): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

const MAX_RESPONSE_BYTES = 1_048_576;

async function readJson(response: Response, label: string): Promise<unknown> {
  const mediaType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new CounterpartyError(`${label} must use application/json`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new CounterpartyError(`${label} exceeds the ${MAX_RESPONSE_BYTES}-byte limit`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new CounterpartyError(`${label} exceeds the ${MAX_RESPONSE_BYTES}-byte limit`);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new CounterpartyError(`${label} is not valid UTF-8 JSON`, { cause });
  }
}

function requireIdempotencyKey(value: string): string {
  if (!HASH_RE.test(value)) {
    throw new DacsError("UCP idempotency key must be a 256-bit lowercase hex digest");
  }
  return value;
}

/** Deterministic, high-entropy UCP key scoped to one DACS agreement operation. */
export function dacsUcpIdempotencyKey(input: {
  jobId: string;
  agreementHash: string;
  operation: "create-checkout" | "complete-checkout";
}): string {
  if (!nonEmpty(input.jobId) || !HASH_RE.test(input.agreementHash)) {
    throw new DacsError("UCP idempotency derivation requires a job id and agreement hash");
  }
  return sha256Hex(
    `dacs-ucp-idem:v1:${input.operation}:${input.jobId.normalize("NFC")}:${input.agreementHash}`,
  );
}

/** Minimal strict REST transport for the official UCP Checkout and Order paths. */
export function createUcpRestClient(input: {
  business: Readonly<UcpBusinessProfileSnapshot>;
  platformProfileUrl: string;
  fetchImpl?: typeof fetch;
}): UcpRestClient {
  const business = snapshotCanonicalJsonRead(input.business, "UCP business snapshot");
  const platformProfileUrl = requireUcpHttpUrl(
    input.platformProfileUrl,
    "UCP platform profile URL",
  );
  const fetchImpl = input.fetchImpl ?? fetch;
  if (typeof fetchImpl !== "function") throw new DacsError("UCP fetch transport is unavailable");
  const commonHeaders = {
    Accept: "application/json",
    "UCP-Agent": `profile="${platformProfileUrl}"`,
  };

  const request = async (
    method: "GET" | "POST",
    url: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> => {
    const headers = new Headers(commonHeaders);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (idempotencyKey !== undefined) {
      headers.set("Idempotency-Key", requireIdempotencyKey(idempotencyKey));
    }
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        redirect: "error",
        ...(body === undefined
          ? {}
          : { body: canonicalize(snapshotCanonicalJson(body, "UCP request body")) }),
      });
    } catch (cause) {
      throw new TransientError(`UCP ${method} request failed`, { cause });
    }
    if (!response.ok) {
      throw new CounterpartyError(`UCP ${method} returned HTTP ${response.status}`);
    }
    return readJson(response, `UCP ${method} response`);
  };

  return {
    async createCheckout(body, idempotencyKey) {
      return asCheckout(await request(
        "POST",
        endpoint(business.shoppingEndpoint, "/checkout-sessions"),
        body,
        idempotencyKey,
      ));
    },
    async getCheckout(id) {
      if (!nonEmpty(id)) throw new DacsError("UCP checkout id is required");
      return asCheckout(await request(
        "GET",
        endpoint(business.shoppingEndpoint, `/checkout-sessions/${encodeURIComponent(id)}`),
      ));
    },
    async completeCheckout(id, body, idempotencyKey) {
      if (!nonEmpty(id)) throw new DacsError("UCP checkout id is required");
      return asCheckout(await request(
        "POST",
        endpoint(
          business.shoppingEndpoint,
          `/checkout-sessions/${encodeURIComponent(id)}/complete`,
        ),
        body,
        idempotencyKey,
      ));
    },
    async getOrder(id) {
      if (!nonEmpty(id)) throw new DacsError("UCP order id is required");
      return asOrder(await request(
        "GET",
        endpoint(business.shoppingEndpoint, `/orders/${encodeURIComponent(id)}`),
      ));
    },
  };
}

/** Fetch and parse one exact UCP business profile without following redirects. */
export async function discoverUcpBusiness(input: {
  profileUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<Readonly<UcpBusinessProfileSnapshot>> {
  const profileUrl = requireUcpHttpUrl(input.profileUrl, "UCP profile URL");
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(profileUrl, {
      headers: { Accept: "application/json" },
      redirect: "error",
    });
  } catch (cause) {
    throw new TransientError("UCP profile discovery failed", { cause });
  }
  if (!response.ok) {
    throw new CounterpartyError(`UCP profile discovery returned HTTP ${response.status}`);
  }
  return parseUcpBusinessProfile(
    profileUrl,
    await readJson(response, "UCP profile response"),
  );
}
