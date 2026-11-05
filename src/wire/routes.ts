// dacs-seller-http/v1 route table.
//
// The seven routes, commit-on-signature and the context route are the buyer
// plugins' (taken from the plugin implementation; test/wire/wire.test.ts pins
// them here); discovery is new.
// Paths are matched exactly against the raw request target: no query string,
// alternate spelling or encoded alias reaches a handler.

export const DACS_SELLER_HTTP_V1 = "dacs-seller-http/v1";
/** Header carrying the base64url signed envelope (the plugin's header name). */
export const DACS_SELLER_HTTP_HEADER = "x-dacs-seller-peer";
export const DACS_SELLER_DISCOVERY_PATH = "/.well-known/dacs-seller.json";

/**
 * Signing domains: the signed bytes are the domain followed by the canonical
 * payload. These are new SDK wire domains, not DACS-Standard artifact domains
 * (CORE §B.7's registry), and they replace the plugin's
 * `dacs-chatgpt-plugin:loopback-seller-peer:v1:` and
 * `dacs-chatgpt-plugin:seller-session-delegation:v1:` with no compatibility arm.
 */
export const DACS_SELLER_HTTP_DOMAINS = Object.freeze({
  request: "dacs-seller-http:v1:request:",
  response: "dacs-seller-http:v1:response:",
  delegation: "dacs-seller-http:v1:delegation:",
  discovery: "dacs-seller-http:v1:discovery:",
});

export const DACS_SELLER_HTTP_PATHS = Object.freeze({
  proposals: "/dacs/v1/agreements/proposals",
  state: "/dacs/v1/agreements/state",
  context: "/dacs/v1/agreements/context",
  commitments: "/dacs/v1/commitments",
  commitmentSignature: "/dacs/v1/commitments/signature",
  payments: "/dacs/v1/payments",
  bundleRequest: "/dacs/v1/bundles/request",
  bundleCountersignature: "/dacs/v1/bundles/countersignature",
  bundleBuyerCopy: "/dacs/v1/bundles/buyer-copy",
} as const);

export type DacsSellerHttpPath = (typeof DACS_SELLER_HTTP_PATHS)[keyof typeof DACS_SELLER_HTTP_PATHS];

export interface DacsSellerHttpRoute {
  readonly path: DacsSellerHttpPath | typeof DACS_SELLER_DISCOVERY_PATH;
  readonly method: "POST" | "GET";
  /** `signed`: request and response carry signed envelopes. `discovery`: the body is a signed document. */
  readonly auth: "signed" | "discovery";
  /** `read` routes never start a seller effect (as in the plugin). */
  readonly effect: "effect" | "read";
  /** A seller option the route is mounted under; `null` means always mounted. */
  readonly option: "commit-on-signature" | "context-route" | null;
}

const route = (
  path: DacsSellerHttpRoute["path"],
  effect: DacsSellerHttpRoute["effect"],
  option: DacsSellerHttpRoute["option"] = null,
): DacsSellerHttpRoute => Object.freeze({ path, method: "POST", auth: "signed", effect, option });

export const DACS_SELLER_HTTP_ROUTES: readonly DacsSellerHttpRoute[] = Object.freeze([
  route(DACS_SELLER_HTTP_PATHS.proposals, "effect"),
  route(DACS_SELLER_HTTP_PATHS.state, "read"),
  route(DACS_SELLER_HTTP_PATHS.commitments, "effect"),
  route(DACS_SELLER_HTTP_PATHS.payments, "effect"),
  route(DACS_SELLER_HTTP_PATHS.bundleRequest, "effect"),
  route(DACS_SELLER_HTTP_PATHS.bundleCountersignature, "effect"),
  route(DACS_SELLER_HTTP_PATHS.bundleBuyerCopy, "read"),
  route(DACS_SELLER_HTTP_PATHS.commitmentSignature, "effect", "commit-on-signature"),
  route(DACS_SELLER_HTTP_PATHS.context, "effect", "context-route"),
  Object.freeze({ path: DACS_SELLER_DISCOVERY_PATH, method: "GET", auth: "discovery", effect: "read", option: null }),
]);

/** Find the route for an exact method and raw request target, or null. */
export function findDacsSellerHttpRoute(method: string, target: string): DacsSellerHttpRoute | null {
  return DACS_SELLER_HTTP_ROUTES.find((r) => r.method === method && r.path === target) ?? null;
}

export const isReadRoute = (path: string): boolean =>
  DACS_SELLER_HTTP_ROUTES.some((r) => r.path === path && r.auth === "signed" && r.effect === "read");

/** Limits kept from the plugin (pinned by test/wire/wire.test.ts). */
export const DACS_SELLER_HTTP_LIMITS = Object.freeze({
  maxRequestBodyBytes: 64 * 1024,
  maxResponseBodyBytes: 512 * 1024,
  /** Widest window a receiver accepts: expiresAt at most this after its own clock. */
  maxMessageLifetimeMs: 60_000,
  /**
   * Clock difference tolerated between two parties (signer and receiver, a
   * worker and its journal). Every limit below that compares one party's
   * timestamp with another party's clock leaves this much room. A
   * delegation's expiry leaves none on purpose: no effect starts after it by
   * the seller's clock. A read route there is answered as readback by either
   * party's clock (checkWireRequest).
   */
  maxClockSkewMs: 30_000,
  /**
   * Longest lifetime a signer gives a request or response (expiresAt - its
   * own now): the receiver's window less the skew, so a signer clock up to
   * maxClockSkewMs ahead of or behind the receiver's still passes.
   */
  maxSignedLifetimeMs: 30_000,
  /** Longest base64url envelope header (the plugin's limit). */
  maxHeaderLength: 4096,
  /** Longest seller session delegation (the plugin's limit). */
  maxDelegationLifetimeMs: 24 * 60 * 60 * 1000,
  /** Longest signed discovery document, and its longest validity. */
  maxDiscoveryBytes: 16 * 1024,
  maxDiscoveryLifetimeMs: 10 * 60 * 1000,
});
