type DemosPost = (
  url: string,
  request: unknown,
  headers: unknown,
  opts?: { retries?: number; baseSleepMs?: number },
) => Promise<{ data: unknown }>;

/**
 * Connection errors raised before a connection exists, so before any byte of
 * the request is written: the connect was refused, or the host name did not
 * resolve to an address.
 */
const NOT_CONNECTED_CODES: ReadonlySet<unknown> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
]);

/**
 * Cloudflare edge answers that say the edge never connected to the origin:
 * 521 (the origin refused the connection) and 523 (the origin is
 * unreachable). 520, 522 and 524 can follow a connection, so they do not count.
 */
const NOT_FORWARDED_EDGE_STATUSES: ReadonlySet<unknown> = new Set([521, 523]);

/** The header Cloudflare's edge sets on every answer, error pages included. */
const CLOUDFLARE_EDGE_HEADER = "cf-ray";

/**
 * Thrown by a {@link createDemosClient} client instead of demosdk's transport
 * error when a transaction post provably never reached the node, so the
 * signed transaction was not submitted. `cause` is the transport error.
 */
export class TransactionPostNotSentError extends Error {
  override readonly name = "TransactionPostNotSentError";
}

/**
 * A post that submits a transaction: `execute` (confirmTx and broadcastTx) or
 * the `broadcastNativeTransaction` node call.
 */
function isTransactionPost(request: unknown): boolean {
  const { method, params } = (request ?? {}) as {
    method?: unknown;
    params?: unknown;
  };
  if (method === "execute") return true;
  const content: unknown = Array.isArray(params) ? params[0] : undefined;
  return method === "nodeCall" &&
    typeof content === "object" && content !== null &&
    (content as { message?: unknown }).message === "broadcastNativeTransaction";
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

/**
 * How many redirects axios followed. axios posts through follow-redirects,
 * which re-posts the body on a 307 or 308; a connection error carries its
 * request, and an HTTP answer carries the native request that links back to
 * it. Undefined when the count is not there.
 */
function redirectsFollowed(axiosError: unknown): unknown {
  const request = field(axiosError, "request");
  return field(field(request, "_redirectable") ?? request, "_redirectCount");
}

/**
 * True only when demosdk's transport error proves the one attempt never
 * reached the node: one attempt, no redirect, and either a connection that
 * never opened or a Cloudflare edge answer saying it did not forward.
 * Everything else, including a reset or timeout after connect and any other
 * 5xx answer, may have been received and stays unknown.
 */
function provesNotSent(error: unknown): boolean {
  if (field(error, "attempts") !== 1) return false;
  const axiosError = field(error, "cause");
  if (redirectsFollowed(axiosError) !== 0) return false;
  const response = field(axiosError, "response");
  if (response === undefined) {
    return NOT_CONNECTED_CODES.has(field(axiosError, "code"));
  }
  return NOT_FORWARDED_EDGE_STATUSES.has(field(response, "status")) &&
    typeof field(field(response, "headers"), CLOUDFLARE_EDGE_HEADER) === "string";
}

/**
 * A Demos client that sends each transaction post exactly once. demosdk
 * resends a post after a 502/503/504 or a dropped connection, which would
 * submit the same signed transaction again; a failed attempt instead takes the
 * caller's unknown-outcome path. When the failure proves the post never
 * reached the node, the client throws {@link TransactionPostNotSentError}
 * instead, and demosdk's `call` hands it back as the answer's `response`.
 * Reads keep demosdk's retries.
 *
 * Takes the `Demos` class so callers that load demosdk lazily keep doing so.
 */
export function createDemosClient<C extends new () => object>(
  Demos: C,
): InstanceType<C> {
  const demos = new Demos() as InstanceType<C>;
  const client = demos as unknown as { _doPost: DemosPost };
  const post = client._doPost.bind(demos);
  client._doPost = async (url, request, headers, opts = {}) => {
    if (!isTransactionPost(request)) return post(url, request, headers, opts);
    try {
      return await post(url, request, headers, { ...opts, retries: 0 });
    } catch (error) {
      if (!provesNotSent(error)) throw error;
      throw new TransactionPostNotSentError(
        `Demos transaction post to ${url} never reached the node`,
        { cause: error },
      );
    }
  };
  return demos;
}
