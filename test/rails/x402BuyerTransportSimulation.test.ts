import assert from "node:assert/strict";
import dns from "node:dns/promises";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

import { describe, test } from "vitest";

import { sha256Hex } from "../../src/canonical/index.js";
import type { DacsPublicHttpsDependenciesV1 } from "../../src/rails/x402Outbound.js";
import {
  createX402BuyerSettlementIntent,
  type X402BuyerEffectFence,
  type X402BuyerSettlementIntent,
} from "../../src/rails/x402BuyerSettlement.js";
import {
  createX402BuyerPaidRequestTransport,
  createX402BuyerRetainedDisclosureRecovery,
  type X402BuyerPaidRequestTransportOptions,
} from "../../src/rails/x402BuyerTransport.js";

const SIMULATION = { executionMode: "simulation" } as const;
const RESOURCE = "https://seller.example/simulation";
const TRANSACTION_HASH = `0x${"ab".repeat(32)}`;
const DISCLOSURE = {
  protocolVersion: "2",
  headerName: "PAYMENT-RESPONSE",
  encodedSettlementHeader: "local-settlement-response",
  httpResource: RESOURCE,
};

function retainedIntent(): Readonly<X402BuyerSettlementIntent> {
  const jobId = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
  const phaseIndex = 2;
  const payer = `0x${"11".repeat(20)}`;
  const payee = `0x${"22".repeat(20)}`;
  const asset = `0x${"33".repeat(20)}`;
  const network = "eip155:84532" as const;
  const nonce = `0x${sha256Hex(`dacs-sb3:v1:${jobId}:${phaseIndex}`)}` as const;
  const chosenRequirements = {
    scheme: "exact", network, asset, amount: "1000", payTo: payee,
    maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" },
  };
  const signedPaymentPayload = {
    x402Version: 2,
    resource: { url: RESOURCE },
    accepted: chosenRequirements,
    payload: {
      authorization: {
        from: payer, to: payee, value: "1000", validAfter: "0",
        validBefore: "4102444800", nonce,
      },
      signature: `0x${"44".repeat(65)}`,
    },
  };
  return createX402BuyerSettlementIntent({
    jobId, phaseIndex, railId: "x402:base-sepolia", railVersion: "2",
    railDescriptorHash: "a".repeat(64), agreementHash: "b".repeat(64),
    termsHash: "c".repeat(64), sessionBindingHash: "d".repeat(64),
    network, payer, payee, asset, amount: "1000", httpResource: RESOURCE,
    method: "GET", chosenRequirements, signedPaymentPayload,
    paymentHeader: {
      name: "PAYMENT-SIGNATURE",
      value: Buffer.from(JSON.stringify(signedPaymentPayload)).toString("base64"),
    },
    authorizationNonce: nonce,
  });
}

const factories = [
  {
    name: "paid request",
    create(options?: X402BuyerPaidRequestTransportOptions) {
      const transport = createX402BuyerPaidRequestTransport(options, SIMULATION);
      return (intent: Readonly<X402BuyerSettlementIntent>, fence: X402BuyerEffectFence) =>
        transport.submitRetained(intent, fence);
    },
  },
  {
    name: "retained disclosure recovery",
    create(options?: X402BuyerPaidRequestTransportOptions) {
      const recover = createX402BuyerRetainedDisclosureRecovery(options ?? {}, SIMULATION);
      return (intent: Readonly<X402BuyerSettlementIntent>, fence: X402BuyerEffectFence) =>
        recover({ intent, fence, transactionHash: TRANSACTION_HASH });
    },
  },
];

const incompleteHttpsDependencies: Array<Partial<DacsPublicHttpsDependenciesV1>> = [
  {},
  { resolveHost: async () => ["8.8.8.8"] },
  { request: async () => new Response(null, { status: 200 }) },
];

// Intercept the same built-in effect boundaries as the cold review probe.
// No test in this file may perform a real lookup, connection, or fetch.
async function withBlockedNetwork(run: () => void | Promise<void>) {
  const originalLookup = dns.lookup;
  const originalRequest = https.request;
  const originalFetch = globalThis.fetch;
  const attempts: string[] = [];
  dns.lookup = () => { attempts.push("dns"); throw new Error("real DNS disabled"); };
  https.request = () => { attempts.push("https"); throw new Error("real HTTPS disabled"); };
  globalThis.fetch = async () => { attempts.push("fetch"); throw new Error("real fetch disabled"); };
  syncBuiltinESMExports();
  try {
    await run();
    assert.deepEqual(attempts, []);
  } finally {
    dns.lookup = originalLookup;
    https.request = originalRequest;
    globalThis.fetch = originalFetch;
    syncBuiltinESMExports();
  }
}

describe("x402 simulation transport isolation", () => {
  for (const factory of factories) {
    const missingTransports: Array<[string, X402BuyerPaidRequestTransportOptions | undefined]> = [
      ["omitted options", undefined],
      ["empty options", {}],
      ["undefined dependencies", { fetchImpl: undefined, publicHttpsDependencies: undefined }],
      ["production policy", { transportPolicy: { mode: "production" } }],
      ["timeout policy", { transportPolicy: { timeoutMs: 100 } }],
      ["Accept header", { headers: { accept: "application/json" } }],
    ];
    for (const [name, options] of missingTransports) {
      test(`${factory.name} refuses ${name} at construction`, async () => {
        await withBlockedNetwork(() => {
          assert.throws(() => factory.create(options), /simulation requires an injected local transport/);
        });
      });
    }

    for (const dependencies of incompleteHttpsDependencies) {
      test(`${factory.name} refuses incomplete HTTPS dependencies (${Object.keys(dependencies)})`, async () => {
        await withBlockedNetwork(() => {
          assert.throws(() => factory.create({
            // @ts-expect-error Exercise runtime rejection of missing required methods.
            publicHttpsDependencies: dependencies,
          }), /stable method/);
        });
      });
    }

    for (const kind of ["fetch", "https"] as const) {
      test(`${factory.name} accepts a complete injected local ${kind} transport`, async () => {
        await withBlockedNetwork(async () => {
          const intent = retainedIntent();
          const events: string[] = [];
          const fence: X402BuyerEffectFence = {
            owner: "local-test", generation: 1,
            settlementKey: intent.settlementKey, bindingHash: intent.bindingHash,
            idempotencyKey: intent.settlementKey,
            assertCurrent: async () => { events.push("fence"); },
          };
          const respond = (headers: Headers) => {
            events.push("send");
            assert.equal(headers.get("PAYMENT-SIGNATURE"), intent.paymentHeader.value);
            return new Response(null, {
              status: 200,
              headers: { "PAYMENT-RESPONSE": DISCLOSURE.encodedSettlementHeader },
            });
          };
          const options: X402BuyerPaidRequestTransportOptions = kind === "fetch"
            ? {
                transportPolicy: { mode: "insecure-test" },
                fetchImpl: async (url, init) => {
                  assert.equal(url, RESOURCE);
                  return respond(new Headers(init?.headers));
                },
              }
            : {
                publicHttpsDependencies: {
                  resolveHost: async () => { events.push("dns"); return ["8.8.8.8"]; },
                  request: async (input) => {
                    assert.equal(input.url, RESOURCE);
                    await input.beforeConnect?.();
                    return respond(input.headers);
                  },
                },
              };
          const invoke = factory.create(options);
          // The factory owns its dependencies; removing caller options cannot
          // make submission or recovery fall back to production defaults.
          options.fetchImpl = undefined;
          options.publicHttpsDependencies = undefined;
          const result = await invoke(intent, fence);
          assert.deepEqual(result, factory.name === "paid request"
            ? { disposition: "response", disclosure: DISCLOSURE }
            : DISCLOSURE);
          assert.deepEqual(events, kind === "fetch" ? ["fence", "send"] : ["dns", "fence", "send"]);
        });
      });
    }
  }
});
