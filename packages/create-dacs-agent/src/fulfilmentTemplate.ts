export const FULFILMENT_EXAMPLES_SOURCE = `import type {
  DacsPublicStorageDeliverableInputV1,
} from "@kynesyslabs/dacs-node";

const MAX_STATIC_JSON_BYTES = 1_048_576;

function boundedJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_STATIC_JSON_BYTES) {
    throw new Error("fulfilment JSON is unavailable or exceeds 1 MiB");
  }
  return encoded;
}

function identifiers(input: Readonly<DacsPublicStorageDeliverableInputV1>) {
  return Object.freeze({
    jobId: input.jobId,
    fulfilmentId: input.fulfilmentId,
  });
}

/**
 * Safe default: the same retained input always produces the same JSON value.
 * The host, rather than this callback, persists and publishes the result.
 */
export async function echoRequestFulfilment(
  input: Readonly<DacsPublicStorageDeliverableInputV1>,
) {
  return Object.freeze({
    ...identifiers(input),
    request: JSON.parse(boundedJson(input.request)) as unknown,
    status: "completed" as const,
  });
}

/**
 * Build a replay-safe fulfilment callback from bounded static JSON. The value is
 * encoded once and parsed for every invocation, so callers cannot mutate shared
 * state between a first attempt and recovery replay.
 */
export function createStaticJsonFulfilment(document: unknown) {
  const encoded = boundedJson(document);
  return async (input: Readonly<DacsPublicStorageDeliverableInputV1>) => Object.freeze({
    ...identifiers(input),
    deliverable: JSON.parse(encoded) as unknown,
    status: "completed" as const,
  });
}

/**
 * Do not put an unjournalled email, API mutation, subprocess, model charge or
 * external job creation directly in either example. The host may call a
 * fulfilment callback again after a crash. Integrate an external effect only
 * through a durable idempotency/reconciliation adapter keyed by fulfilmentId,
 * and require lookup of that exact effect before any retry.
 */
export const EXTERNAL_EFFECT_INTEGRATION_RULES = Object.freeze({
  idempotencyKey: "fulfilmentId",
  durableIntentBeforeEffect: true,
  reconcileExactEffectBeforeRetry: true,
  blindRetryPermitted: false,
});
`;
