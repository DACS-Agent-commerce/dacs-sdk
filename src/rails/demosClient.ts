type DemosPost = (
  url: string,
  request: unknown,
  headers: unknown,
  opts?: { retries?: number; baseSleepMs?: number },
) => Promise<{ data: unknown }>;

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

/**
 * A Demos client that sends each transaction post exactly once. demosdk
 * resends a post after a 502/503/504 or a dropped connection, which would
 * submit the same signed transaction again; a failed attempt instead takes the
 * caller's unknown-outcome path. Reads keep demosdk's retries.
 *
 * Takes the `Demos` class so callers that load demosdk lazily keep doing so.
 */
export function createDemosClient<C extends new () => object>(
  Demos: C,
): InstanceType<C> {
  const demos = new Demos() as InstanceType<C>;
  const client = demos as unknown as { _doPost: DemosPost };
  const post = client._doPost.bind(demos);
  client._doPost = (url, request, headers, opts = {}) =>
    post(
      url,
      request,
      headers,
      isTransactionPost(request) ? { ...opts, retries: 0 } : opts,
    );
  return demos;
}
