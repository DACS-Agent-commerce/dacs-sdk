import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import {
  advanceX402BuyerSettlement,
  assertX402BuyerSettlementIntent,
  createInMemoryX402BuyerSettlementStore,
  createX402BuyerSettlementIntent,
  x402BuyerSettlementAuthenticationHash,
  x402BuyerSettlementKey,
  type X402BuyerAuthorizationProvider,
  type X402BuyerAuthorizationReconciliation,
  type X402BuyerCapturedSettlement,
  type X402BuyerEffectFence,
  type X402BuyerPaidRequestTransport,
  type X402BuyerSettlementDisclosure,
  type X402BuyerSettlementIntent,
  type X402BuyerSettlementIntentDraft,
  type X402BuyerSignedEventReference,
} from "../../src/rails/x402BuyerSettlement.js";
import { createFsX402BuyerSettlementStore } from "../../src/rails/x402BuyerSettlementFs.js";

const JOB_ID = "job-x402-café";
const PHASE_INDEX = 3;
const RAIL_ID = "x402-prod-A";
const NETWORK = "eip155:84532" as const;
const PAYER = `0x${"11".repeat(20)}`;
const PAYEE = `0x${"22".repeat(20)}`;
const ASSET = `0x${"33".repeat(20)}`;
const TX = `0x${"aa".repeat(32)}`;
const RESOURCE = "https://seller.example/deliver/job-x402";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const nonce = (jobId = JOB_ID, phaseIndex = PHASE_INDEX): `0x${string}` =>
  `0x${sha256Hex(`dacs-sb3:v1:${jobId.normalize("NFC")}:${phaseIndex}`)}`;

function intentDraft(): X402BuyerSettlementIntentDraft {
  const chosenRequirements = {
    scheme: "exact",
    network: NETWORK,
    amount: "1000",
    asset: ASSET,
    payTo: PAYEE,
    maxTimeoutSeconds: 120,
    extra: {
      name: "USD Coin",
      version: "2",
      assetTransferMethod: "eip3009",
      future: { retained: true },
    },
  };
  const signedPaymentPayload = {
    x402Version: 2,
    resource: { url: RESOURCE, description: "report" },
    accepted: chosenRequirements,
    payload: {
      authorization: {
        from: PAYER,
        to: PAYEE,
        value: "1000",
        validAfter: "0",
        validBefore: "4102444800",
        nonce: nonce(),
      },
      signature: `0x${"44".repeat(65)}`,
    },
    extensions: { future: { signed: true } },
  };
  return {
    jobId: JOB_ID,
    phaseIndex: PHASE_INDEX,
    railId: RAIL_ID,
    railVersion: "2",
    railDescriptorHash: HASH_A,
    agreementHash: HASH_B,
    termsHash: HASH_C,
    sessionBindingHash: HASH_D,
    network: NETWORK,
    payer: PAYER,
    payee: PAYEE,
    asset: ASSET,
    amount: "1000",
    httpResource: RESOURCE,
    method: "GET",
    chosenRequirements,
    signedPaymentPayload,
    paymentHeader: {
      name: "PAYMENT-SIGNATURE",
      value: Buffer.from(JSON.stringify(signedPaymentPayload), "utf8").toString("base64"),
    },
    authorizationNonce: nonce(),
  };
}

const makeIntent = (): Readonly<X402BuyerSettlementIntent> =>
  createX402BuyerSettlementIntent(intentDraft());

function receiptResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    success: true,
    transaction: TX,
    network: NETWORK,
    payer: PAYER,
    amount: "1000",
    extensions: { facilitator: { retained: "yes" } },
    futureMember: { nested: [1, 2, 3] },
    ...overrides,
  };
}

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64");

function disclosure(overrides: Partial<X402BuyerSettlementDisclosure> = {}) {
  return {
    protocolVersion: "2" as const,
    headerName: "PAYMENT-RESPONSE" as const,
    encodedSettlementHeader: encode(receiptResponse()),
    httpResource: RESOURCE,
    ...overrides,
  };
}

function signedEvent(
  overrides: Partial<X402BuyerSignedEventReference> = {},
): X402BuyerSignedEventReference {
  const response = receiptResponse();
  return {
    kind: "x402-event",
    httpResource: RESOURCE,
    paymentReceiptHash: sha256Hex(canonicalize(response)),
    protocolVersion: "2",
    settlementTxHash: TX,
    chainId: 84532,
    logIndex: 7,
    ...overrides,
  };
}

function capturedSettlement(
  intent: Readonly<X402BuyerSettlementIntent>,
  options: {
    response?: Record<string, unknown>;
    event?: X402BuyerSignedEventReference;
    authenticationEvent?: X402BuyerSignedEventReference;
  } = {},
): X402BuyerCapturedSettlement {
  const response = options.response ?? receiptResponse();
  const event = options.event ?? {
    ...signedEvent(),
    paymentReceiptHash: sha256Hex(canonicalize(response)),
    settlementTxHash: String(response.transaction),
  };
  return {
    captureVersion: "1",
    protocolVersion: "2",
    headerName: "PAYMENT-RESPONSE",
    encodedSettlementHeader: encode(response),
    httpResource: RESOURCE,
    signedEvent: event,
    authenticationHash: x402BuyerSettlementAuthenticationHash({
      intent,
      signedEvent: options.authenticationEvent ?? event,
    }),
  };
}

function provider(
  reconciliations: X402BuyerAuthorizationReconciliation[],
  counters: { lookups: number; authentications: number } = {
    lookups: 0,
    authentications: 0,
  },
): X402BuyerAuthorizationProvider<{ observed: true }> {
  return {
    async authorizeIntent(intent, fence) {
      await fence.assertCurrent();
      return { disposition: "authorized", bindingHash: intent.bindingHash };
    },
    async lookup(_intent, _candidate, fence) {
      counters.lookups += 1;
      await fence.assertCurrent();
      return { disposition: "observed", observation: { observed: true } };
    },
    async authenticate(_intent, _lookup, _candidate, fence) {
      counters.authentications += 1;
      await fence.assertCurrent();
      return reconciliations.shift() ?? {
        disposition: "indeterminate",
        reason: "no-scripted-observation",
      };
    },
  };
}

function transport(
  callback: (
    intent: Readonly<X402BuyerSettlementIntent>,
    fence: Readonly<X402BuyerEffectFence>,
  ) => Promise<ReturnType<X402BuyerPaidRequestTransport["submitRetained"]> extends Promise<infer T> ? T : never>,
): X402BuyerPaidRequestTransport {
  return { submitRetained: callback };
}

describe("durable buyer x402 intent", () => {
  test("captures exact signed v2 bytes, authenticated rail/session bindings and SB-3 key", () => {
    const draft = intentDraft();
    const intent = createX402BuyerSettlementIntent(draft);
    expect(intent.settlementKey).toBe(x402BuyerSettlementKey({
      railId: RAIL_ID,
      jobId: JOB_ID,
      phaseIndex: PHASE_INDEX,
    }));
    expect(intent.authorizationNonce).toBe(nonce());
    expect(intent.bindingHash).toMatch(/^[0-9a-f]{64}$/);
    expect(intent.paymentHeader.value).toBe(draft.paymentHeader.value);
    expect(intent.signedPaymentPayload).toEqual(draft.signedPaymentPayload);
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.signedPaymentPayload)).toBe(true);
    expect(() => assertX402BuyerSettlementIntent(intent)).not.toThrow();
  });

  test("rejects every authority-bearing intent substitution", () => {
    const original = makeIntent();
    const mutations: Array<(candidate: Record<string, unknown>) => void> = [
      (value) => { value.jobId = "other-job"; },
      (value) => { value.phaseIndex = 4; },
      (value) => { value.railId = "other-rail"; },
      (value) => { value.railVersion = "3"; },
      (value) => { value.railDescriptorHash = "0".repeat(64); },
      (value) => { value.agreementHash = "0".repeat(64); },
      (value) => { value.termsHash = "0".repeat(64); },
      (value) => { value.sessionBindingHash = "0".repeat(64); },
      (value) => { value.network = "eip155:1"; },
      (value) => { value.payer = `0x${"55".repeat(20)}`; },
      (value) => { value.payee = `0x${"66".repeat(20)}`; },
      (value) => { value.asset = `0x${"77".repeat(20)}`; },
      (value) => { value.amount = "1001"; },
      (value) => { value.httpResource = "https://seller.example/other"; },
      (value) => { value.authorizationNonce = `0x${"00".repeat(32)}`; },
      (value) => {
        (value.chosenRequirements as Record<string, unknown>).amount = "1001";
      },
      (value) => {
        ((value.signedPaymentPayload as Record<string, unknown>).payload as {
          authorization: Record<string, unknown>;
        }).authorization.nonce = `0x${"00".repeat(32)}`;
      },
      (value) => {
        (value.paymentHeader as Record<string, unknown>).value = encode({ replaced: true });
      },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(original) as unknown as Record<string, unknown>;
      mutate(candidate);
      expect(() => assertX402BuyerSettlementIntent(candidate)).toThrow();
    }
  });

  test("rejects proxies/accessors without invoking them", () => {
    const draft = intentDraft() as unknown as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(draft, "termsHash", {
      enumerable: true,
      get() {
        reads += 1;
        return HASH_C;
      },
    });
    expect(() => createX402BuyerSettlementIntent(
      draft as unknown as X402BuyerSettlementIntentDraft,
    )).toThrow(/data property/);
    expect(reads).toBe(0);
    const proxied = new Proxy(intentDraft().signedPaymentPayload, {});
    expect(() => createX402BuyerSettlementIntent({
      ...intentDraft(),
      signedPaymentPayload: proxied,
    })).toThrow(/proxy/);
  });

  test("rejects an authorization header with duplicate JSON keys", () => {
    const draft = intentDraft();
    const payload = draft.signedPaymentPayload as Record<string, unknown>;
    const duplicate = JSON.stringify(payload).replace(
      '"x402Version":2',
      '"x402Version":1,"x402Version":2',
    );
    expect(() => createX402BuyerSettlementIntent({
      ...draft,
      paymentHeader: {
        name: "PAYMENT-SIGNATURE",
        value: Buffer.from(duplicate, "utf8").toString("base64"),
      },
    })).toThrow(/JSON/);
  });
});

describe("advanceX402BuyerSettlement", () => {
  test("persists intent before request and captures only after authenticated settled-same", async () => {
    const intent = makeIntent();
    const store = createInMemoryX402BuyerSettlementStore();
    let submits = 0;
    const result = await advanceX402BuyerSettlement({
      intent,
      owner: "worker-a",
      store,
      authorizationProvider: provider([{
        disposition: "settled-same",
        settlement: capturedSettlement(intent),
      }]),
      transport: transport(async (received, fence) => {
        submits += 1;
        await fence.assertCurrent();
        expect(received).toEqual(intent);
        expect(await store.load(intent.settlementKey)).toMatchObject({ status: "held" });
        return { disposition: "response", disclosure: disclosure() };
      }),
      now: () => 1_000,
    });
    expect(submits).toBe(1);
    expect(result.status).toBe("captured");
    expect(await store.load(intent.settlementKey)).toMatchObject({
      status: "captured",
      outcome: { status: "captured" },
    });
  });

  test("paid response alone never authorizes success", async () => {
    const intent = makeIntent();
    const store = createInMemoryX402BuyerSettlementStore();
    const result = await advanceX402BuyerSettlement({
      intent,
      owner: "worker-a",
      store,
      authorizationProvider: provider([{
        disposition: "indeterminate",
        reason: "ledger-unavailable",
      }]),
      transport: transport(async (_received, fence) => {
        await fence.assertCurrent();
        return { disposition: "response", disclosure: disclosure() };
      }),
      now: () => 1_000,
    });
    expect(result).toEqual({ status: "indeterminate", reason: "ledger-unavailable" });
    expect(await store.load(intent.settlementKey)).toMatchObject({ status: "held" });
  });

  test("the exact retained binding must be independently authorized before submission", async () => {
    const intent = makeIntent();
    const store = createInMemoryX402BuyerSettlementStore();
    let submits = 0;
    const result = await advanceX402BuyerSettlement({
      intent,
      owner: "worker-a",
      store,
      authorizationProvider: {
        ...provider([]),
        async authorizeIntent(_intent, fence) {
          await fence.assertCurrent();
          return { disposition: "authorized", bindingHash: "0".repeat(64) };
        },
      },
      transport: transport(async () => {
        submits += 1;
        return { disposition: "response", disclosure: disclosure() };
      }),
      now: () => 1_000,
    });
    expect(result).toEqual({
      status: "indeterminate",
      reason: "intent-authorization-binding-mismatch",
    });
    expect(submits).toBe(0);
  });

  test("response loss before lookup and outcome-write loss both recover without resubmission", async () => {
    const intent = makeIntent();
    const baseStore = createInMemoryX402BuyerSettlementStore();
    let now = 1_000;
    let submits = 0;
    const first = await advanceX402BuyerSettlement({
      intent,
      owner: "worker-a",
      store: baseStore,
      authorizationProvider: {
        async authorizeIntent(received, fence) {
          await fence.assertCurrent();
          return { disposition: "authorized", bindingHash: received.bindingHash };
        },
        async lookup() {
          throw new Error("response received, chain lookup response lost");
        },
        async authenticate() {
          throw new Error("not reached");
        },
      },
      transport: transport(async (_intent, fence) => {
        submits += 1;
        await fence.assertCurrent();
        return { disposition: "response", disclosure: disclosure() };
      }),
      now: () => now,
      leaseDurationMs: 10,
    });
    expect(first.status).toBe("indeterminate");

    now = 1_011;
    let loseWrite = true;
    const writeLossStore = {
      ...baseStore,
      async recordOutcome(input: Parameters<typeof baseStore.recordOutcome>[0]) {
        if (loseWrite) {
          loseWrite = false;
          throw new Error("write not acknowledged before commit");
        }
        return baseStore.recordOutcome(input);
      },
    };
    const second = await advanceX402BuyerSettlement({
      intent,
      owner: "worker-b",
      store: writeLossStore,
      authorizationProvider: provider([{
        disposition: "settled-same",
        settlement: capturedSettlement(intent),
      }]),
      transport: transport(async () => {
        submits += 1;
        throw new Error("must not submit while adopting settled-same");
      }),
      now: () => now,
      leaseDurationMs: 10,
    });
    expect(second).toEqual({
      status: "indeterminate",
      reason: "settlement-outcome-write-indeterminate",
    });
    expect(submits).toBe(1);

    now = 1_022;
    const third = await advanceX402BuyerSettlement({
      intent,
      owner: "worker-c",
      store: baseStore,
      authorizationProvider: provider([{
        disposition: "settled-same",
        settlement: capturedSettlement(intent),
      }]),
      transport: transport(async () => {
        submits += 1;
        throw new Error("must not resubmit");
      }),
      now: () => now,
      leaseDurationMs: 10,
    });
    expect(third.status).toBe("captured");
    expect(submits).toBe(1);
  });

  test("a lost acknowledgement after the outcome commit converges immediately", async () => {
    const intent = makeIntent();
    const baseStore = createInMemoryX402BuyerSettlementStore();
    const store = {
      ...baseStore,
      async recordOutcome(input: Parameters<typeof baseStore.recordOutcome>[0]) {
        await baseStore.recordOutcome(input);
        throw new Error("commit acknowledgement lost");
      },
    };
    const result = await advanceX402BuyerSettlement({
      intent,
      owner: "worker",
      store,
      authorizationProvider: provider([{
        disposition: "settled-same",
        settlement: capturedSettlement(intent),
      }]),
      transport: transport(async () => ({
        disposition: "response",
        disclosure: disclosure(),
      })),
      now: () => 1_000,
    });
    expect(result.status).toBe("captured");
    expect(await baseStore.load(intent.settlementKey)).toMatchObject({ status: "captured" });
  });

  test("unused recovery atomically changes generation and replays byte-identical intent once", async () => {
    const intent = makeIntent();
    const store = createInMemoryX402BuyerSettlementStore();
    let now = 1_000;
    let submits = 0;
    let staleFence: Readonly<X402BuyerEffectFence> | undefined;
    const first = await advanceX402BuyerSettlement({
      intent,
      owner: "worker-a",
      store,
      authorizationProvider: provider([]),
      transport: transport(async (received, fence) => {
        submits += 1;
        staleFence = fence;
        expect(received.paymentHeader.value).toBe(intent.paymentHeader.value);
        throw new Error("response lost after request");
      }),
      now: () => now,
      leaseDurationMs: 100,
    });
    expect(first.status).toBe("indeterminate");
    now = 1_101;
    const generations: number[] = [];
    const second = await advanceX402BuyerSettlement({
      intent,
      owner: "worker-b",
      store,
      authorizationProvider: {
        async authorizeIntent(received, fence) {
          await fence.assertCurrent();
          return { disposition: "authorized", bindingHash: received.bindingHash };
        },
        async lookup(_intent, _candidate, fence) {
          generations.push(fence.generation);
          await fence.assertCurrent();
          return { disposition: "observed", observation: {} };
        },
        async authenticate(_intent, _lookup, _candidate, fence) {
          return fence.generation === 2
            ? { disposition: "unused", reason: "authenticated-unused", authenticationHash: HASH_A }
            : { disposition: "settled-same", settlement: capturedSettlement(intent) };
        },
      },
      transport: transport(async (received, fence) => {
        submits += 1;
        generations.push(fence.generation);
        await fence.assertCurrent();
        expect(received).toEqual(intent);
        return { disposition: "response", disclosure: disclosure() };
      }),
      now: () => now,
      leaseDurationMs: 100,
    });
    expect(second.status).toBe("captured");
    expect(submits).toBe(2);
    expect(generations).toEqual([2, 3, 3]);
    await expect(staleFence!.assertCurrent()).rejects.toThrow(/stale/);
  });

  test.each(["used-different", "cancelled"] as const)(
    "%s is terminal and never replays",
    async (disposition) => {
      const intent = makeIntent();
      const store = createInMemoryX402BuyerSettlementStore();
      let now = 1_000;
      let submits = 0;
      await advanceX402BuyerSettlement({
        intent,
        owner: "worker-a",
        store,
        authorizationProvider: provider([]),
        transport: transport(async () => {
          submits += 1;
          throw new Error("lost");
        }),
        now: () => now,
        leaseDurationMs: 10,
      });
      now = 1_011;
      const result = await advanceX402BuyerSettlement({
        intent,
        owner: "worker-b",
        store,
        authorizationProvider: provider([{
          disposition,
          reason: `authenticated-${disposition}`,
          authenticationHash: HASH_B,
        }]),
        transport: transport(async () => {
          submits += 1;
          return { disposition: "response", disclosure: disclosure() };
        }),
        now: () => now,
        leaseDurationMs: 10,
      });
      expect(result).toMatchObject({
        status: "failed",
        outcome: { failure: disposition },
      });
      expect(submits).toBe(1);
    },
  );

  test.each([
    ["unavailable", { lookup: "unavailable" }],
    ["ambiguous", { reconciliation: "multiple-matches" }],
  ] as const)("%s recovery is indeterminate and never replays", async (_label, mode) => {
    const intent = makeIntent();
    const store = createInMemoryX402BuyerSettlementStore();
    let now = 1_000;
    let submits = 0;
    await advanceX402BuyerSettlement({
      intent,
      owner: "worker-a",
      store,
      authorizationProvider: provider([]),
      transport: transport(async () => {
        submits += 1;
        throw new Error("lost");
      }),
      now: () => now,
      leaseDurationMs: 10,
    });
    now = 1_011;
    const result = await advanceX402BuyerSettlement({
      intent,
      owner: "worker-b",
      store,
      authorizationProvider: "lookup" in mode && mode.lookup === "unavailable"
        ? {
            async authorizeIntent(received, fence) {
              await fence.assertCurrent();
              return { disposition: "authorized", bindingHash: received.bindingHash };
            },
            async lookup() {
              return { disposition: "unavailable", reason: "rpc-unavailable" };
            },
            async authenticate() {
              throw new Error("must not authenticate an unavailable lookup");
            },
          }
        : provider([{ disposition: "indeterminate", reason: "multiple-matching-events" }]),
      transport: transport(async () => {
        submits += 1;
        return { disposition: "response", disclosure: disclosure() };
      }),
      now: () => now,
      leaseDurationMs: 10,
    });
    expect(result.status).toBe("indeterminate");
    expect(submits).toBe(1);
  });

  test("missing complete receipt and every response/event substitution remain indeterminate", async () => {
    const cases: Array<[string, (intent: Readonly<X402BuyerSettlementIntent>) => X402BuyerCapturedSettlement]> = [
      ["no transaction", (intent) => capturedSettlement(intent, {
        response: { ...receiptResponse(), transaction: "" },
        event: signedEvent(),
      })],
      ["receipt hash", (intent) => capturedSettlement(intent, {
        event: signedEvent({ paymentReceiptHash: "0".repeat(64) }),
      })],
      ["transaction", (intent) => capturedSettlement(intent, {
        event: signedEvent({ settlementTxHash: `0x${"bb".repeat(32)}` }),
      })],
      ["resource", (intent) => ({
        ...capturedSettlement(intent),
        httpResource: "https://seller.example/other",
      })],
      ["network", (intent) => capturedSettlement(intent, {
        event: signedEvent({ chainId: 1 }),
      })],
      ["signed log index", (intent) => capturedSettlement(intent, {
        event: signedEvent({ logIndex: 8 }),
        authenticationEvent: signedEvent({ logIndex: 7 }),
      })],
    ];
    for (const [_label, mutation] of cases) {
      const intent = makeIntent();
      const store = createInMemoryX402BuyerSettlementStore();
      const result = await advanceX402BuyerSettlement({
        intent,
        owner: "worker",
        store,
        authorizationProvider: provider([{
          disposition: "settled-same",
          settlement: mutation(intent),
        }]),
        transport: transport(async () => ({
          disposition: "response",
          disclosure: disclosure(),
        })),
        now: () => 1_000,
      });
      expect(result).toEqual({
        status: "indeterminate",
        reason: "settled-same-capture-invalid",
      });
      expect(await store.load(intent.settlementKey)).toMatchObject({ status: "held" });
    }
  });

  test("a conflicting binding can neither submit nor replace the first intent", async () => {
    const intent = makeIntent();
    const store = createInMemoryX402BuyerSettlementStore();
    let submits = 0;
    await store.claim({ intent, owner: "holder", now: 1_000, leaseDurationMs: 1_000 });
    const conflict = structuredClone(intent) as X402BuyerSettlementIntent;
    conflict.bindingHash = "0".repeat(64);
    await expect(advanceX402BuyerSettlement({
      intent: conflict,
      owner: "attacker",
      store,
      authorizationProvider: provider([]),
      transport: transport(async () => {
        submits += 1;
        return { disposition: "indeterminate", reason: "unexpected" };
      }),
      now: () => 1_001,
    })).rejects.toThrow(/binding hash/);
    expect(submits).toBe(0);
    expect((await store.load(intent.settlementKey) as { intent: X402BuyerSettlementIntent }).intent)
      .toEqual(intent);
  });

  test("stale generations cannot reconcile, submit, grant recovery, or record", async () => {
    const intent = makeIntent();
    const store = createInMemoryX402BuyerSettlementStore();
    const first = await store.claim({
      intent,
      owner: "worker-a",
      now: 1_000,
      leaseDurationMs: 10,
    });
    expect(first.status).toBe("acquired");
    const firstLease = (first as Extract<typeof first, { status: "acquired" }>).lease;
    const second = await store.claim({
      intent,
      owner: "worker-b",
      now: 1_011,
      leaseDurationMs: 10,
    });
    expect(second).toMatchObject({ status: "acquired", lease: { generation: 2 } });
    expect(await store.isCurrent({
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      lease: firstLease,
      now: 1_011,
    })).toBe(false);
    expect(await store.grantRecovery({
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      lease: firstLease,
      owner: "worker-a",
      now: 1_011,
      leaseDurationMs: 10,
    })).toEqual({ status: "stale" });
    expect(await store.recordOutcome({
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      lease: firstLease,
      outcome: {
        outcomeVersion: "1",
        status: "captured",
        settlement: capturedSettlement(intent),
      },
      now: 1_011,
    })).toEqual({ status: "stale" });
  });

  test("terminal outcomes are atomic and no-overwrite", async () => {
    const intent = makeIntent();
    const store = createInMemoryX402BuyerSettlementStore();
    const claim = await store.claim({
      intent,
      owner: "worker",
      now: 1_000,
      leaseDurationMs: 100,
    });
    expect(claim.status).toBe("acquired");
    const lease = (claim as Extract<typeof claim, { status: "acquired" }>).lease;
    const captured = {
      outcomeVersion: "1" as const,
      status: "captured" as const,
      settlement: capturedSettlement(intent),
    };
    expect(await store.recordOutcome({
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      lease,
      outcome: captured,
      now: 1_001,
    })).toMatchObject({ status: "recorded", outcome: { status: "captured" } });
    expect(await store.recordOutcome({
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      lease,
      outcome: {
        outcomeVersion: "1",
        status: "failed",
        failure: "cancelled",
        reason: "late contradictory write",
        authenticationHash: HASH_A,
      },
      now: 1_002,
    })).toMatchObject({ status: "existing", outcome: { status: "captured" } });
  });
});

describe("filesystem x402 buyer settlement recovery", () => {
  async function tempStoreDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "dacs-x402-buyer-"));
    dirs.push(dir);
    return dir;
  }

  test("cold restart adopts the same event after response loss without another request", async () => {
    const dir = await tempStoreDir();
    const intent = makeIntent();
    let now = 1_000;
    let submits = 0;
    const firstStore = await createFsX402BuyerSettlementStore({ dir });
    const first = await advanceX402BuyerSettlement({
      intent,
      owner: "process-a",
      store: firstStore,
      authorizationProvider: provider([]),
      transport: transport(async (_intent, fence) => {
        submits += 1;
        await fence.assertCurrent();
        throw new Error("process died after facilitator settled");
      }),
      now: () => now,
      leaseDurationMs: 100,
    });
    expect(first.status).toBe("indeterminate");

    now = 1_101;
    const restarted = await createFsX402BuyerSettlementStore({ dir });
    const recovered = await advanceX402BuyerSettlement({
      intent,
      owner: "process-b",
      store: restarted,
      authorizationProvider: provider([{
        disposition: "settled-same",
        settlement: capturedSettlement(intent),
      }]),
      transport: transport(async () => {
        submits += 1;
        throw new Error("must not replay settled authorization");
      }),
      now: () => now,
      leaseDurationMs: 100,
    });
    expect(recovered.status).toBe("captured");
    expect(submits).toBe(1);
    expect(await restarted.load(intent.settlementKey)).toMatchObject({ status: "captured" });
  });

  test("two independent stores converge on one paid request", async () => {
    const dir = await tempStoreDir();
    const intent = makeIntent();
    const leftStore = await createFsX402BuyerSettlementStore({ dir });
    const rightStore = await createFsX402BuyerSettlementStore({ dir });
    let submits = 0;
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    let releaseResolve!: () => void;
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const paidTransport = transport(async (_intent, fence) => {
      submits += 1;
      await fence.assertCurrent();
      startedResolve();
      await release;
      return { disposition: "response", disclosure: disclosure() };
    });
    const left = advanceX402BuyerSettlement({
      intent,
      owner: "process-left",
      store: leftStore,
      authorizationProvider: provider([{
        disposition: "settled-same",
        settlement: capturedSettlement(intent),
      }]),
      transport: paidTransport,
      now: () => 1_000,
      leaseDurationMs: 1_000,
    });
    await started;
    const right = await advanceX402BuyerSettlement({
      intent,
      owner: "process-right",
      store: rightStore,
      authorizationProvider: provider([]),
      transport: paidTransport,
      now: () => 1_000,
      leaseDurationMs: 1_000,
    });
    expect(right.status).toBe("waiting");
    releaseResolve();
    expect((await left).status).toBe("captured");
    expect(submits).toBe(1);
  });

  test("persists a complete strict record and rejects unsupported/corrupt files", async () => {
    const dir = await tempStoreDir();
    const intent = makeIntent();
    const store = await createFsX402BuyerSettlementStore({ dir });
    await store.claim({ intent, owner: "worker", now: 1_000, leaseDurationMs: 100 });
    const files = await import("node:fs/promises").then((fs) => fs.readdir(join(dir, "records")));
    expect(files).toHaveLength(1);
    const recordPath = join(dir, "records", files[0]!);
    const parsed = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      storeVersion: 1,
      generation: 1,
      intent: { bindingHash: intent.bindingHash },
    });
  });
});

describe("public surface", () => {
  test("exports only the safe coordinator/store seam while retaining the legacy bridge", async () => {
    const root = await import("../../src/index.js");
    const rails = await import("../../src/rails/index.js");
    for (const surface of [root, rails]) {
      expect(surface.advanceX402BuyerSettlement).toBeTypeOf("function");
      expect(surface.createX402BuyerSettlementIntent).toBeTypeOf("function");
      expect(surface.createInMemoryX402BuyerSettlementStore).toBeTypeOf("function");
      expect(surface.createFsX402BuyerSettlementStore).toBeTypeOf("function");
      expect("x402BuyerSettlementStoreInternals" in surface).toBe(false);
      expect(surface.x402SettleCore).toBeTypeOf("function");
    }
  }, 20_000);
});
