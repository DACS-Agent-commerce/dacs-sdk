import { createRequire } from "node:module";

/** The part of axios doctor's read-only probes use; `signal` cancels the request. */
export interface DemosHttpClient {
  get(url: string, config: { signal?: AbortSignal }): Promise<unknown>;
  post(
    url: string,
    body: unknown,
    config: { headers: Record<string, string>; signal?: AbortSignal },
  ): Promise<{ data: unknown }>;
}

/**
 * demosdk's own HTTP client, resolved from demosdk's install location, so doctor
 * reaches the node as the SDK does (proxy environment included) but can pass the
 * signal that demosdk's `connect()` and `nodeCall()` do not take.
 */
export function demosHttpClient(): DemosHttpClient {
  const sdkEntry = createRequire(import.meta.url).resolve("@kynesyslabs/demosdk/websdk");
  return createRequire(sdkEntry)("axios") as DemosHttpClient;
}
