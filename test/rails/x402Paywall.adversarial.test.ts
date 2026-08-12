import { describe, expect, it, vi } from "vitest";

import { canonicalize } from "../../src/canonical/index.js";
import { dacsX402AuthorizationNonce } from "../../src/rails/x402.js";
import {
  createX402Paywall,
  x402PaywallCore,
  x402PaywallSettlementKey,
  type X402PaywallConfig,
  type X402PaywallCoreDeps,
  type X402PaywallHttpAdapter,
  type X402PaywallHttpContext,
  type X402PaywallPaymentPayload,
  type X402PaywallPaymentRequirements,
  type X402PaywallProcessResult,
  type X402PaywallServerLike,
  type X402PaywallSettlementIntent,
  type X402PaywallSettlementOutcome,
  type X402PaywallSettlementResult,
  type X402PaywallSettlementStore,
} from "../../src/rails/x402Paywall.js";
import { x402Eip3009Nonce } from "../../src/seller/paymentIntake.js";

const NETWORK = "eip155:84532" as const;
const PAYER = `0x${"11".repeat(20)}`;
const PAY_TO = `0x${"22".repeat(20)}`;
const ASSET = `0x${"33".repeat(20)}`;
const TX_HASH = `0x${"ab".repeat(32)}`;
const JOB_ID = "seller-paywall-adversarial-job";
const PHASE_INDEX = 7;
const AMOUNT = "250000";

const expected = {
  network: NETWORK,
  payTo: PAY_TO,
  amount: AMOUNT,
  asset: ASSET,
  eip712: { name: "USDC", version: "2" },
};

function request(headers: Record<string, string> = {}): X402PaywallHttpAdapter {
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    getHeader: (name) => normalized.get(name.toLowerCase()),
    getMethod: () => "GET",
    getPath: () => `/deliver/${JOB_ID}`,
    getUrl: () => `https://seller.example/deliver/${JOB_ID}`,
    getAcceptHeader: () => "application/json",
    getUserAgent: () => "dacs-adversarial-test",
  };
}

function paymentFixture(): {
  requirements: X402PaywallPaymentRequirements;
  payload: X402PaywallPaymentPayload;
} {
  const requirements: X402PaywallPaymentRequirements = {
    scheme: "exact",
    network: NETWORK,
    asset: ASSET,
    amount: AMOUNT,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
  };
  return {
    requirements,
    payload: {
      x402Version: 2,
      accepted: structuredClone(requirements),
      payload: {
        authorization: {
          from: PAYER,
          to: PAY_TO,
          value: AMOUNT,
          validAfter: "0",
          validBefore: "9999999999",
          nonce: x402Eip3009Nonce(JOB_ID, PHASE_INDEX),
        },
        signature: `0x${"44".repeat(65)}`,
      },
    },
  };
}

function encodePayment(payload: X402PaywallPaymentPayload, pretty = false): string {
  return Buffer.from(JSON.stringify(payload, null, pretty ? 2 : undefined), "utf8")
    .toString("base64");
}

function paidRequest(payload: X402PaywallPaymentPayload): X402PaywallHttpAdapter {
  return request({ "PAYMENT-SIGNATURE": encodePayment(payload) });
}

function responseHeader(receipt: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(receipt), "utf8").toString("base64");
}

function successfulSettlement(
  requirements: X402PaywallPaymentRequirements,
  overrides: Partial<X402PaywallSettlementResult & { success: true }> = {},
): X402PaywallSettlementResult & { success: true } {
  const receipt = {
    success: true as const,
    transaction: TX_HASH,
    network: NETWORK,
    payer: PAYER,
    amount: AMOUNT,
    extensions: { facilitator: { trace: "retained" } },
  };
  return {
    ...receipt,
    headers: { "PAYMENT-RESPONSE": responseHeader(receipt) },
    requirements: structuredClone(requirements),
    ...overrides,
    success: true,
  };
}

function failedSettlement(): X402PaywallSettlementResult & { success: false } {
  return {
    success: false,
    transaction: "",
    network: NETWORK,
    errorReason: "authoritative-failure",
    headers: {},
    response: {
      status: 402,
      headers: { "content-type": "application/json" },
      body: { error: "authoritative-failure" },
    },
  };
}

type TestStore = X402PaywallSettlementStore & {
  retained: Map<string, {
    intent: X402PaywallSettlementIntent;
    outcome?: X402PaywallSettlementOutcome;
  }>;
};

function settlementStore(): TestStore {
  const retained: TestStore["retained"] = new Map();
  return {
    retained,
    async load(settlementKey) {
      const existing = retained.get(settlementKey);
      if (!existing) return { status: "absent" };
      if (!existing.outcome) {
        return { status: "held", intent: structuredClone(existing.intent) };
      }
      return {
        status: existing.outcome.status,
        intent: structuredClone(existing.intent),
        outcome: structuredClone(existing.outcome),
      };
    },
    async claim(input) {
      const intent = structuredClone(input);
      const existing = retained.get(intent.settlementKey);
      if (!existing) {
        retained.set(intent.settlementKey, { intent });
        return { status: "claimed", intent: structuredClone(intent) };
      }
      if (existing.intent.bindingHash !== intent.bindingHash) {
        return { status: "conflict" };
      }
      if (!existing.outcome) {
        return { status: "held", intent: structuredClone(existing.intent) };
      }
      return {
        status: existing.outcome.status,
        intent: structuredClone(existing.intent),
        outcome: structuredClone(existing.outcome),
      };
    },
    async recordOutcome(input) {
      const existing = retained.get(input.settlementKey);
      if (!existing || existing.intent.bindingHash !== input.bindingHash) {
        return { status: "conflict" };
      }
      const outcome = structuredClone(input.outcome);
      if (existing.outcome && canonicalize(existing.outcome) !== canonicalize(outcome)) {
        return { status: "conflict" };
      }
      existing.outcome ??= outcome;
      return {
        status: existing.outcome.status,
        intent: structuredClone(existing.intent),
        outcome: structuredClone(existing.outcome),
      };
    },
  };
}

function mockServer(options: {
  process: X402PaywallProcessResult |
    ((context: X402PaywallHttpContext) => Promise<X402PaywallProcessResult>);
  settlement?: X402PaywallSettlementResult |
    ((
      payload: X402PaywallPaymentPayload,
      requirements: X402PaywallPaymentRequirements,
    ) => Promise<X402PaywallSettlementResult>);
}): X402PaywallServerLike & {
  processHTTPRequest: ReturnType<typeof vi.fn>;
  processSettlement: ReturnType<typeof vi.fn>;
} {
  return {
    initialize: vi.fn(async () => undefined),
    processHTTPRequest: vi.fn(async (context: X402PaywallHttpContext) =>
      typeof options.process === "function"
        ? options.process(context)
        : options.process),
    processSettlement: vi.fn(async (
      payload: X402PaywallPaymentPayload,
      requirements: X402PaywallPaymentRequirements,
    ) => {
      if (typeof options.settlement === "function") {
        return options.settlement(payload, requirements);
      }
      if (!options.settlement) throw new Error("unexpected settlement");
      return options.settlement;
    }),
  };
}

function verifiedProcess(
  payload: X402PaywallPaymentPayload,
  requirements: X402PaywallPaymentRequirements,
  cancel = vi.fn(async () => undefined),
): X402PaywallProcessResult {
  return {
    type: "payment-verified",
    paymentPayload: payload,
    paymentRequirements: requirements,
    cancellationDispatcher: { cancel },
  };
}

function coreDeps<T = unknown>(
  server: X402PaywallServerLike,
  overrides: Partial<X402PaywallCoreDeps<{ permitId: string }, T>> = {},
): X402PaywallCoreDeps<{ permitId: string }, T> {
  return {
    server,
    expected,
    settlementStore: settlementStore(),
    authorizeSettlement: async () => ({
      disposition: "authorized",
      authorization: { scopeVersion: "test-1", finalized: true },
    }),
    reconcileSettlement: async () => ({ status: "pending", reason: "pending" }),
    authorizePayment: async () => ({
      disposition: "authorized",
      authorization: { permitId: "permit-1" },
    }),
    fulfil: async () => ({ disposition: "fulfilled" }),
    ...overrides,
  };
}

function invocation(inputRequest: X402PaywallHttpAdapter) {
  return { jobId: JOB_ID, phaseIndex: PHASE_INDEX, request: inputRequest };
}

function poisonOwnBind<T extends Function>(fn: T): T {
  Object.defineProperty(fn, "bind", {
    configurable: true,
    get() {
      throw new Error("an own .bind accessor must never be consulted");
    },
  });
  return fn;
}

describe("x402PaywallCore adversarial settlement authorization", () => {
  it("fails closed before claim or settlement for rejected, indeterminate, thrown, and invalid preflight results", async () => {
    const cases: Array<{
      name: string;
      run: () => Promise<unknown>;
      expected: Record<string, unknown>;
    }> = [
      {
        name: "rejected",
        run: async () => ({ disposition: "rejected", reason: "session-not-finalized" }),
        expected: {
          disposition: "rejected",
          settled: false,
          reason: "session-not-finalized",
          response: { status: 403 },
        },
      },
      {
        name: "indeterminate",
        run: async () => ({ disposition: "indeterminate", reason: "session-store-down" }),
        expected: {
          disposition: "indeterminate",
          settled: false,
          reason: "session-store-down",
          response: { status: 503 },
        },
      },
      {
        name: "throw",
        run: async () => {
          throw new Error("session resolver unavailable");
        },
        expected: {
          disposition: "indeterminate",
          settled: false,
          reason: "pre-settlement-authorization-unavailable",
          response: { status: 503 },
        },
      },
      {
        name: "invalid",
        run: async () => ({ disposition: "authorized" }),
        expected: {
          disposition: "indeterminate",
          settled: false,
          reason: "pre-settlement-authorization-invalid-result",
          response: { status: 503 },
        },
      },
    ];

    for (const scenario of cases) {
      const { payload, requirements } = paymentFixture();
      const store = settlementStore();
      const cancel = vi.fn(async () => undefined);
      const server = mockServer({
        process: verifiedProcess(payload, requirements, cancel),
        settlement: successfulSettlement(requirements),
      });
      const claim = vi.spyOn(store, "claim");
      const authorizeSettlement = vi.fn(scenario.run);
      const authorizePayment = vi.fn();
      const fulfil = vi.fn();

      const result = await x402PaywallCore(
        invocation(paidRequest(payload)),
        coreDeps(server, {
          settlementStore: store,
          authorizeSettlement: authorizeSettlement as X402PaywallCoreDeps["authorizeSettlement"],
          authorizePayment,
          fulfil,
        }),
      );

      expect(result, scenario.name).toMatchObject(scenario.expected);
      expect(authorizeSettlement, scenario.name).toHaveBeenCalledTimes(1);
      expect(claim, scenario.name).not.toHaveBeenCalled();
      expect(store.retained.size, scenario.name).toBe(0);
      expect(server.processSettlement, scenario.name).not.toHaveBeenCalled();
      expect(authorizePayment, scenario.name).not.toHaveBeenCalled();
      expect(fulfil, scenario.name).not.toHaveBeenCalled();
    }
  });

  it("retains the exact authenticated session scope and reuses it without rerunning preflight", async () => {
    const { payload, requirements } = paymentFixture();
    const store = settlementStore();
    const server = mockServer({
      process: verifiedProcess(payload, requirements),
      settlement: successfulSettlement(requirements),
    });
    const returnedAuthorization = {
      scopeVersion: "seller-x402-spine:v1",
      finalized: { agreementHash: "a".repeat(64), phase: PHASE_INDEX },
      roles: ["supplier", "payer"],
    };
    const authorizeSettlement = vi.fn(async () => ({
      disposition: "authorized" as const,
      authorization: returnedAuthorization,
    }));
    const observedScopes: unknown[] = [];
    const authorizePayment = vi.fn(async (context) => {
      observedScopes.push(context.sessionAuthorization);
      expect(Object.isFrozen(context.sessionAuthorization)).toBe(true);
      expect(Object.isFrozen(
        (context.sessionAuthorization as typeof returnedAuthorization).finalized,
      )).toBe(true);
      return observedScopes.length === 1
        ? { disposition: "indeterminate" as const, reason: "permit-write-pending" }
        : {
            disposition: "authorized" as const,
            authorization: { permitId: "permit-recovered" },
          };
    });
    const fulfil = vi.fn(async () => ({ disposition: "fulfilled" as const }));
    const deps = coreDeps(server, {
      settlementStore: store,
      authorizeSettlement,
      authorizePayment,
      fulfil,
    });

    const first = await x402PaywallCore(invocation(paidRequest(payload)), deps);
    expect(first).toMatchObject({ disposition: "authorization-indeterminate", settled: true });
    returnedAuthorization.finalized.agreementHash = "mutated-after-retention";
    returnedAuthorization.roles.push("attacker");

    const replay = await x402PaywallCore(invocation(paidRequest(payload)), deps);
    expect(replay).toMatchObject({ disposition: "settled", settled: true });
    expect(authorizeSettlement).toHaveBeenCalledTimes(1);
    expect(server.processHTTPRequest).toHaveBeenCalledTimes(1);
    expect(server.processSettlement).toHaveBeenCalledTimes(1);
    expect(authorizePayment).toHaveBeenCalledTimes(2);
    expect(fulfil).toHaveBeenCalledTimes(1);
    expect(observedScopes).toEqual([
      {
        scopeVersion: "seller-x402-spine:v1",
        finalized: { agreementHash: "a".repeat(64), phase: PHASE_INDEX },
        roles: ["supplier", "payer"],
      },
      {
        scopeVersion: "seller-x402-spine:v1",
        finalized: { agreementHash: "a".repeat(64), phase: PHASE_INDEX },
        roles: ["supplier", "payer"],
      },
    ]);
    expect(observedScopes[1]).not.toBe(observedScopes[0]);
  });
});

describe("x402PaywallCore adversarial replay and recovery", () => {
  it.each(["held", "settled", "failed"] as const)(
    "treats every non-exact bearer against a %s phase as unknown conflict without provider retry",
    async (terminalState) => {
      const { payload, requirements } = paymentFixture();
      const store = settlementStore();
      const settlement = terminalState === "settled"
        ? successfulSettlement(requirements)
        : terminalState === "failed"
          ? failedSettlement()
          : undefined;
      const server = mockServer({
        process: verifiedProcess(payload, requirements),
        settlement: settlement ?? (async () => {
          throw new Error("submitted but no response");
        }),
      });
      const reconcileSettlement = vi.fn(async () => {
        if (terminalState === "failed") {
          return {
            status: "failed" as const,
            reason: "authoritative-failure",
            settlement: failedSettlement(),
          };
        }
        return { status: "pending" as const, reason: "still-pending" };
      });
      const deps = coreDeps(server, {
        settlementStore: store,
        reconcileSettlement,
      });

      await x402PaywallCore(invocation(paidRequest(payload)), deps);
      const processCalls = server.processHTTPRequest.mock.calls.length;
      const settlementCalls = server.processSettlement.mock.calls.length;

      const differentPayload = structuredClone(payload);
      differentPayload.payload.signature = `0x${"55".repeat(65)}`;
      const variants: Array<[string, X402PaywallHttpAdapter]> = [
        ["missing", request()],
        [
          "re-encoded",
          request({ "PAYMENT-SIGNATURE": encodePayment(payload, true) }),
        ],
        ["different", paidRequest(differentPayload)],
      ];
      for (const [name, inputRequest] of variants) {
        const conflict = await x402PaywallCore(invocation(inputRequest), deps);
        expect(conflict, `${terminalState}/${name}`).toMatchObject({
          disposition: "indeterminate",
          settled: "unknown",
          reason: "settlement-authorization-conflict",
          response: { status: 409 },
        });
      }
      expect(server.processHTTPRequest).toHaveBeenCalledTimes(processCalls);
      expect(server.processSettlement).toHaveBeenCalledTimes(settlementCalls);
    },
  );

  it.each(["held", "settled", "failed"] as const)(
    "never reports an exact %s replay as unpaid after configured terms drift",
    async (terminalState) => {
      const { payload, requirements } = paymentFixture();
      const store = settlementStore();
      const server = mockServer({
        process: verifiedProcess(payload, requirements),
        settlement: terminalState === "settled"
          ? successfulSettlement(requirements)
          : terminalState === "failed"
            ? failedSettlement()
            : async () => {
                throw new Error("settlement response unavailable");
              },
      });
      const reconcileSettlement = vi.fn(async () => terminalState === "failed"
        ? {
            status: "failed" as const,
            reason: "authoritative-failure",
            settlement: failedSettlement(),
          }
        : { status: "pending" as const, reason: "still-pending" });
      const initialDeps = coreDeps(server, {
        settlementStore: store,
        reconcileSettlement,
      });
      await x402PaywallCore(invocation(paidRequest(payload)), initialDeps);
      const processCalls = server.processHTTPRequest.mock.calls.length;
      const settlementCalls = server.processSettlement.mock.calls.length;

      const replay = await x402PaywallCore(invocation(paidRequest(payload)), {
        ...initialDeps,
        expected: { ...expected, amount: "250001" },
      });
      expect(replay).toMatchObject({
        disposition: "indeterminate",
        settled: "unknown",
        reason: "settlement-recovery-context-mismatch",
        response: { status: 503 },
      });
      expect(server.processHTTPRequest).toHaveBeenCalledTimes(processCalls);
      expect(server.processSettlement).toHaveBeenCalledTimes(settlementCalls);
    },
  );

  const malformedSuccesses: Array<[
    string,
    (
      requirements: X402PaywallPaymentRequirements,
    ) => X402PaywallSettlementResult & { success: true },
  ]> = [
    [
      "missing PAYMENT-RESPONSE",
      (requirements) => successfulSettlement(requirements, { headers: {} }),
    ],
    [
      "case-insensitive duplicate PAYMENT-RESPONSE",
      (requirements) => {
        const valid = successfulSettlement(requirements);
        return {
          ...valid,
          headers: {
            ...valid.headers,
            "payment-response": valid.headers["PAYMENT-RESPONSE"]!,
          },
        };
      },
    ],
    [
      "wrong transaction",
      (requirements) => successfulSettlement(requirements, {
        transaction: `0x${"cd".repeat(32)}`,
      }),
    ],
    [
      "wrong network",
      (requirements) => successfulSettlement(requirements, { network: "eip155:1" }),
    ],
    [
      "wrong payer",
      (requirements) => successfulSettlement(requirements, {
        payer: `0x${"99".repeat(20)}`,
      }),
    ],
    [
      "wrong requirements",
      (requirements) => successfulSettlement(requirements, {
        requirements: { ...requirements, amount: "250001" },
      }),
    ],
  ];

  it.each(malformedSuccesses)(
    "does not poison durable terminal state for %s and can recover exact replay from valid evidence",
    async (_name, malformed) => {
      const { payload, requirements } = paymentFixture();
      const valid = successfulSettlement(requirements);
      const store = settlementStore();
      const server = mockServer({
        process: verifiedProcess(payload, requirements),
        settlement: malformed(requirements),
      });
      const reconcileSettlement = vi.fn()
        .mockResolvedValueOnce({ status: "pending", reason: "index-lag" })
        .mockResolvedValueOnce({ status: "settled", settlement: valid });
      const authorizePayment = vi.fn(async () => ({
        disposition: "authorized" as const,
        authorization: { permitId: "permit-after-recovery" },
      }));
      const fulfil = vi.fn(async () => ({ disposition: "fulfilled" as const }));
      const deps = coreDeps(server, {
        settlementStore: store,
        reconcileSettlement,
        authorizePayment,
        fulfil,
      });

      const first = await x402PaywallCore(invocation(paidRequest(payload)), deps);
      expect(first).toMatchObject({
        disposition: "settlement-evidence-indeterminate",
        settled: true,
        response: { status: 503 },
      });
      const key = x402PaywallSettlementKey({ jobId: JOB_ID, phaseIndex: PHASE_INDEX });
      expect(store.retained.get(key)?.outcome).toBeUndefined();
      expect(authorizePayment).not.toHaveBeenCalled();
      expect(fulfil).not.toHaveBeenCalled();

      const recovered = await x402PaywallCore(invocation(paidRequest(payload)), deps);
      expect(recovered).toMatchObject({ disposition: "settled", settled: true });
      expect(store.retained.get(key)?.outcome?.status).toBe("settled");
      expect(server.processHTTPRequest).toHaveBeenCalledTimes(1);
      expect(server.processSettlement).toHaveBeenCalledTimes(1);
      expect(reconcileSettlement).toHaveBeenCalledTimes(2);
      expect(authorizePayment).toHaveBeenCalledTimes(1);
      expect(fulfil).toHaveBeenCalledTimes(1);
    },
  );

  it("uses an authoritative-absence grant for one exact-nonce recovery drive after claim response loss", async () => {
    const { payload, requirements } = paymentFixture();
    const backing = settlementStore();
    let loseClaimResponse = true;
    const claim = vi.fn(async (intent: Readonly<X402PaywallSettlementIntent>) => {
      const result = await backing.claim(intent);
      if (loseClaimResponse) {
        loseClaimResponse = false;
        throw new Error("claim committed before acknowledgement was lost");
      }
      return result;
    });
    const store: X402PaywallSettlementStore = {
      load: (key) => backing.load(key),
      claim,
      recordOutcome: (input) => backing.recordOutcome(input),
    };
    const valid = successfulSettlement(requirements);
    const server = mockServer({
      process: verifiedProcess(payload, requirements),
      settlement: valid,
    });
    const reconcileSettlement = vi.fn(async () => ({
      status: "authoritatively-absent" as const,
      reason: "atomic-recovery-lease-granted",
    }));
    const fulfil = vi.fn(async () => ({ disposition: "fulfilled" as const }));
    const authorizeSettlement = vi.fn(async () => ({
      disposition: "authorized" as const,
      authorization: { scopeVersion: "seller-x402-spine:v1", finalized: true },
    }));
    const deps = coreDeps(server, {
      settlementStore: store,
      reconcileSettlement,
      authorizeSettlement,
      fulfil,
    });

    const first = await x402PaywallCore(invocation(paidRequest(payload)), deps);
    expect(first).toMatchObject({
      disposition: "indeterminate",
      settled: "unknown",
      reason: "settlement-store-result-indeterminate",
    });
    expect(server.processSettlement).not.toHaveBeenCalled();

    const recovered = await x402PaywallCore(invocation(paidRequest(payload)), deps);
    expect(recovered).toMatchObject({ disposition: "settled", settled: true });
    expect(server.processSettlement).toHaveBeenCalledTimes(1);
    const submittedPayload = server.processSettlement.mock.calls[0]?.[0] as
      X402PaywallPaymentPayload;
    expect(submittedPayload).toEqual(payload);
    expect((submittedPayload.payload.authorization as { nonce: string }).nonce).toBe(
      x402Eip3009Nonce(JOB_ID, PHASE_INDEX),
    );
    expect(claim).toHaveBeenCalledTimes(1);
    expect(reconcileSettlement).toHaveBeenCalledTimes(1);
    expect(authorizeSettlement).toHaveBeenCalledTimes(1);

    const terminalReplay = await x402PaywallCore(invocation(paidRequest(payload)), deps);
    expect(terminalReplay).toMatchObject({ disposition: "settled", settled: true });
    expect(server.processSettlement).toHaveBeenCalledTimes(1);
    expect(reconcileSettlement).toHaveBeenCalledTimes(1);
  });
});

describe("x402PaywallCore adversarial snapshots and transport output", () => {
  it("captures mutable request getters before the first await and bypasses poisoned own bind accessors", async () => {
    const { payload, requirements } = paymentFixture();
    const originalHeader = encodePayment(payload);
    const state = {
      headers: new Map([
        ["payment-signature", originalHeader],
        ["x-secret", "must-not-be-forwarded"],
      ]),
      query: { sku: "original", multi: ["a", "b"] } as Record<
        string,
        string | string[]
      >,
      body: { delivery: { token: "original" } },
    };
    const propertyReads = new Map<string, number>();
    const invocations = new Map<string, number>();
    const mark = (map: Map<string, number>, name: string) =>
      map.set(name, (map.get(name) ?? 0) + 1);
    let source!: X402PaywallHttpAdapter;
    const withReceiver = <T extends (...args: never[]) => unknown>(name: string, fn: T): T =>
      poisonOwnBind(function (this: unknown, ...args: Parameters<T>) {
        expect(this, `${name} receiver`).toBe(source);
        mark(invocations, name);
        return fn(...args);
      } as T);
    const methods = {
      getHeader: withReceiver("getHeader", ((name: string) =>
        state.headers.get(name.toLowerCase())) as never),
      getMethod: withReceiver("getMethod", (() => "GET") as never),
      getPath: withReceiver("getPath", (() => `/deliver/${JOB_ID}`) as never),
      getUrl: withReceiver(
        "getUrl",
        (() => `https://seller.example/deliver/${JOB_ID}?sku=original&multi=a&multi=b`) as never,
      ),
      getAcceptHeader: withReceiver("getAcceptHeader", (() => "application/json") as never),
      getUserAgent: withReceiver("getUserAgent", (() => "snapshot-client") as never),
      getQueryParams: withReceiver("getQueryParams", (() => state.query) as never),
      getQueryParam: withReceiver(
        "getQueryParam",
        ((name: string) => state.query[name]) as never,
      ),
      getBody: withReceiver("getBody", (() => state.body) as never),
    };
    const descriptorEntries = Object.fromEntries(Object.entries(methods).map(
      ([name, method]) => [name, {
        enumerable: true,
        configurable: true,
        get() {
          mark(propertyReads, name);
          return method;
        },
      }],
    ));
    source = Object.defineProperties({}, descriptorEntries) as X402PaywallHttpAdapter;

    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const backing = settlementStore();
    const store: X402PaywallSettlementStore = {
      async load(key) {
        await loadGate;
        return backing.load(key);
      },
      claim: (intent) => backing.claim(intent),
      recordOutcome: (input) => backing.recordOutcome(input),
    };
    const assertSnapshot = (adapter: X402PaywallHttpAdapter) => {
      expect(adapter.getHeader("PAYMENT-SIGNATURE")).toBe(originalHeader);
      expect(adapter.getHeader("x-secret")).toBeUndefined();
      expect(adapter.getQueryParam?.("sku")).toBe("original");
      expect(adapter.getQueryParam?.("multi")).toEqual(["a", "b"]);
      expect(adapter.getQueryParams?.()).toEqual({ sku: "original", multi: ["a", "b"] });
      expect(adapter.getBody?.()).toEqual({ delivery: { token: "original" } });
    };
    const server = mockServer({
      process: async (context) => {
        assertSnapshot(context.adapter);
        return verifiedProcess(payload, requirements);
      },
      settlement: successfulSettlement(requirements),
    });
    const authorizeSettlement = vi.fn(async (context) => {
      assertSnapshot(context.request);
      return {
        disposition: "authorized" as const,
        authorization: { scopeVersion: "snapshot:v1", finalized: true },
      };
    });
    const fulfil = vi.fn(async (context) => {
      assertSnapshot(context.request);
      return { disposition: "fulfilled" as const };
    });

    const running = x402PaywallCore(invocation(source), coreDeps(server, {
      settlementStore: store,
      authorizeSettlement,
      fulfil,
    }));
    state.headers.set("payment-signature", "attacker-swapped-after-entry");
    state.headers.set("x-secret", "attacker-mutated");
    state.query.sku = "attacker";
    state.query.multi = ["attacker"];
    state.body.delivery.token = "attacker";
    releaseLoad();

    await expect(running).resolves.toMatchObject({ disposition: "settled", settled: true });
    for (const name of Object.keys(methods)) {
      expect(propertyReads.get(name), `${name} property read count`).toBe(1);
    }
    expect(invocations.get("getHeader")).toBe(2);
    expect(invocations.get("getQueryParams")).toBe(1);
    expect(invocations.get("getQueryParam")).toBeUndefined();
    expect(invocations.get("getBody")).toBe(1);
    for (const name of [
      "getMethod",
      "getPath",
      "getUrl",
      "getAcceptHeader",
      "getUserAgent",
    ]) {
      expect(invocations.get(name), `${name} invocation count`).toBe(1);
    }
  });

  it("returns an owned Uint8Array fulfilment body without treating V8's typed-array freeze rule as failure", async () => {
    const { payload, requirements } = paymentFixture();
    const server = mockServer({
      process: verifiedProcess(payload, requirements),
      settlement: successfulSettlement(requirements),
    });
    const sourceBytes = new Uint8Array([0, 1, 127, 255]);
    const result = await x402PaywallCore(
      invocation(paidRequest(payload)),
      coreDeps<Uint8Array>(server, {
        fulfil: async () => ({ disposition: "fulfilled", body: sourceBytes }),
      }),
    );

    expect(result).toMatchObject({ disposition: "settled", settled: true });
    expect(result.response.body).toBeInstanceOf(Uint8Array);
    expect([...result.response.body as Uint8Array]).toEqual([0, 1, 127, 255]);
    expect(result.response.body).not.toBe(sourceBytes);
    sourceBytes[0] = 99;
    expect([...result.response.body as Uint8Array]).toEqual([0, 1, 127, 255]);
  });

  it("rejects HTTP control-character injection before release", async () => {
    const protocolServer = mockServer({
      process: {
        type: "payment-error",
        response: {
          status: 402,
          headers: { "PAYMENT-REQUIRED": "valid\r\nx-injected: yes" },
        },
      },
    });
    const invalidProtocol = await x402PaywallCore(
      invocation(request()),
      coreDeps(protocolServer),
    );
    expect(invalidProtocol).toMatchObject({
      disposition: "indeterminate",
      settled: false,
      reason: "invalid-payment-protocol-response",
    });

    const { payload, requirements } = paymentFixture();
    const fulfilServer = mockServer({
      process: verifiedProcess(payload, requirements),
      settlement: successfulSettlement(requirements),
    });
    const invalidFulfilment = await x402PaywallCore(
      invocation(paidRequest(payload)),
      coreDeps(fulfilServer, {
        fulfil: async () => ({
          disposition: "fulfilled",
          // NUL is not CR/LF, but host HTTP writers reject it just as firmly.
          headers: { "x-delivery": "ready\u0000injected" },
          body: "must-not-be-released",
        }),
      }),
    );
    expect(invalidFulfilment).toMatchObject({
      disposition: "fulfilment-indeterminate",
      settled: true,
      reason: "invalid-fulfilment-response",
    });
    expect(invalidFulfilment.response.headers["x-delivery"]).toBeUndefined();
    expect(invalidFulfilment.response.body).not.toBe("must-not-be-released");
  });

  it("rejects DEL and non-octet Unicode header values before release", async () => {
    for (const value of ["ready\u007finjected", "ready\u0100injected"]) {
      const server = mockServer({
        process: {
          type: "payment-error",
          response: {
            status: 402,
            headers: { "PAYMENT-REQUIRED": value },
          },
        },
      });
      const result = await x402PaywallCore(invocation(request()), coreDeps(server));
      expect(result).toMatchObject({
        disposition: "indeterminate",
        settled: false,
        reason: "invalid-payment-protocol-response",
      });
      expect(result.response.headers["PAYMENT-REQUIRED"]).toBeUndefined();
    }
  });
});

describe("createX402Paywall adversarial capture", () => {
  it("binds URL facilitator auth-header factories without consulting poisoned own bind", async () => {
    let urlReads = 0;
    let authFactoryReads = 0;
    let authFactoryCalls = 0;
    let facilitatorSource!: {
      url: string;
      createAuthHeaders: () => Promise<{
        verify: Record<string, string>;
        settle: Record<string, string>;
        supported: Record<string, string>;
      }>;
    };
    const createAuthHeaders = poisonOwnBind(async function (this: unknown) {
      expect(this).toBe(facilitatorSource);
      authFactoryCalls += 1;
      return {
        verify: { authorization: "verify-token" },
        settle: { authorization: "settle-token" },
        supported: { authorization: "supported-token" },
      };
    });
    facilitatorSource = Object.defineProperties({}, {
      url: {
        enumerable: true,
        get() {
          urlReads += 1;
          return "https://facilitator.example";
        },
      },
      createAuthHeaders: {
        enumerable: true,
        get() {
          authFactoryReads += 1;
          return createAuthHeaders;
        },
      },
    }) as typeof facilitatorSource;

    const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://facilitator.example/supported");
      expect(new Headers(init?.headers).get("authorization")).toBe("supported-token");
      return new Response(JSON.stringify({
        kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
        extensions: [],
        signers: {},
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchStub);
    try {
      const paywall = await createX402Paywall({
        route: `GET /deliver/${JOB_ID}`,
        network: NETWORK,
        payTo: PAY_TO,
        amount: AMOUNT,
        asset: ASSET,
        eip712: { name: "USDC", version: "2" },
        facilitator: facilitatorSource,
      }, {
        settlementStore: settlementStore(),
        authorizeSettlement: async () => ({
          disposition: "authorized",
          authorization: { scopeVersion: "factory:v1", finalized: true },
        }),
        reconcileSettlement: async () => ({ status: "pending", reason: "pending" }),
        authorizePayment: async () => ({
          disposition: "authorized",
          authorization: { permitId: "factory-permit" },
        }),
        fulfil: async () => ({ disposition: "fulfilled" }),
      });
      expect(paywall.terms).toEqual(expected);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(urlReads).toBe(1);
    expect(authFactoryReads).toBe(1);
    expect(authFactoryCalls).toBe(1);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("reads mutable config/facilitator getters once and binds poisoned methods to the original owner", async () => {
    const configReads = new Map<string, number>();
    const facilitatorReads = new Map<string, number>();
    const mark = (map: Map<string, number>, name: string) =>
      map.set(name, (map.get(name) ?? 0) + 1);
    let facilitatorSource!: Record<string, unknown>;
    const verify = poisonOwnBind(async function (this: unknown) {
      expect(this).toBe(facilitatorSource);
      return { isValid: true, payer: PAYER };
    });
    const settle = poisonOwnBind(async function (this: unknown) {
      expect(this).toBe(facilitatorSource);
      return {
        success: true,
        transaction: TX_HASH,
        network: NETWORK,
        payer: PAYER,
        amount: AMOUNT,
      };
    });
    const getSupported = poisonOwnBind(async function (this: unknown) {
      expect(this).toBe(facilitatorSource);
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
        extensions: [],
        signers: {},
      };
    });
    facilitatorSource = Object.defineProperties({}, Object.fromEntries(
      Object.entries({ verify, settle, getSupported }).map(([name, method]) => [name, {
        enumerable: true,
        get() {
          mark(facilitatorReads, name);
          return method;
        },
      }]),
    ));

    const values: Record<string, unknown> = {
      route: `GET /deliver/${JOB_ID}`,
      network: NETWORK,
      payTo: PAY_TO,
      amount: AMOUNT,
      asset: ASSET,
      facilitator: facilitatorSource,
      maxTimeoutSeconds: 300,
      description: "adversarial snapshot",
      mimeType: "application/json",
      serviceName: "seller",
      extra: { listing: "original" },
    };
    const eipValues = { name: "USDC", version: "2" };
    const eip712 = Object.defineProperties({}, {
      name: {
        enumerable: true,
        get() {
          mark(configReads, "eip712.name");
          return eipValues.name;
        },
      },
      version: {
        enumerable: true,
        get() {
          mark(configReads, "eip712.version");
          return eipValues.version;
        },
      },
    });
    values.eip712 = eip712;
    const config = Object.defineProperties({}, Object.fromEntries(
      Object.keys(values).map((name) => [name, {
        enumerable: true,
        get() {
          mark(configReads, name);
          return values[name];
        },
      }]),
    )) as X402PaywallConfig;
    const store = settlementStore();
    const fulfil = vi.fn(async () => ({
      disposition: "fulfilled" as const,
      body: { delivered: true },
    }));
    const creating = createX402Paywall(config, {
      settlementStore: store,
      authorizeSettlement: async () => ({
        disposition: "authorized",
        authorization: { scopeVersion: "factory:v1", finalized: true },
      }),
      reconcileSettlement: async () => ({ status: "pending", reason: "pending" }),
      authorizePayment: async () => ({
        disposition: "authorized",
        authorization: { permitId: "factory-permit" },
      }),
      fulfil,
    });
    values.route = "GET /attacker-mutated";
    values.payTo = `0x${"99".repeat(20)}`;
    values.extra = { listing: "attacker" };
    eipValues.name = "ATTACKER";

    const paywall = await creating;
    expect(paywall.terms).toEqual(expected);
    for (const name of Object.keys(values)) {
      expect(configReads.get(name), `${name} config getter`).toBe(1);
    }
    expect(configReads.get("eip712.name")).toBe(1);
    expect(configReads.get("eip712.version")).toBe(1);
    expect(facilitatorReads).toEqual(new Map([
      ["verify", 1],
      ["settle", 1],
      ["getSupported", 1],
    ]));

    const unpaid = await paywall.handle(invocation(request()));
    expect(unpaid).toMatchObject({ disposition: "payment-required", settled: false });
    const required = Object.entries(unpaid.response.headers).find(
      ([name]) => name.toUpperCase() === "PAYMENT-REQUIRED",
    )?.[1];
    expect(required).toBeTruthy();
    const challenge = JSON.parse(Buffer.from(required!, "base64").toString("utf8")) as {
      x402Version: number;
      resource: Record<string, unknown>;
      accepts: X402PaywallPaymentRequirements[];
    };
    const accepted = challenge.accepts[0]!;
    expect(accepted.extra).toMatchObject({
      listing: "original",
      name: "USDC",
      version: "2",
    });
    const paidPayload: X402PaywallPaymentPayload = {
      x402Version: challenge.x402Version,
      resource: challenge.resource,
      accepted,
      payload: {
        authorization: {
          from: PAYER,
          to: PAY_TO,
          value: AMOUNT,
          validAfter: "0",
          validBefore: "9999999999",
          nonce: x402Eip3009Nonce(JOB_ID, PHASE_INDEX),
        },
        signature: `0x${"44".repeat(65)}`,
      },
    };
    const paid = await paywall.handle(invocation(paidRequest(paidPayload)));
    expect(paid).toMatchObject({
      disposition: "settled",
      settled: true,
      response: { body: { delivered: true } },
    });
    expect(fulfil).toHaveBeenCalledTimes(1);
    expect(facilitatorReads).toEqual(new Map([
      ["verify", 1],
      ["settle", 1],
      ["getSupported", 1],
    ]));
  });
});

describe("buyer/seller SB-3 nonce agreement", () => {
  it("keeps the buyer async and seller sync derivations byte-identical for Unicode and phase boundaries", async () => {
    const vectors = [
      { jobId: "plain-job", phaseIndex: 0 },
      { jobId: "caf\u00e9-job", phaseIndex: 3 },
      { jobId: "\ud83e\udd16-\u4f9b\u7d66-\ud83d\ude80", phaseIndex: 42 },
      { jobId: "max-safe-phase", phaseIndex: Number.MAX_SAFE_INTEGER },
    ];
    for (const vector of vectors) {
      expect(await dacsX402AuthorizationNonce(vector)).toBe(
        x402Eip3009Nonce(vector.jobId, vector.phaseIndex),
      );
    }
    await expect(dacsX402AuthorizationNonce({
      jobId: "cafe\u0301-job",
      phaseIndex: 3,
    })).rejects.toThrow("exact NFC jobId");
    expect(() => x402Eip3009Nonce("cafe\u0301-job", 3)).toThrow("exact NFC");
  });

  it("rejects negative zero consistently and keeps the paywall fail-closed", async () => {
    await expect(dacsX402AuthorizationNonce({
      jobId: JOB_ID,
      phaseIndex: -0,
    })).rejects.toThrow("non-negative phaseIndex");
    expect(() => x402Eip3009Nonce(JOB_ID, -0)).toThrow("safe unsigned integer");

    const server = mockServer({ process: { type: "no-payment-required" } });
    await expect(x402PaywallCore({
      jobId: JOB_ID,
      phaseIndex: -0,
      request: request(),
    }, coreDeps(server))).resolves.toMatchObject({
      disposition: "rejected",
      settled: false,
      reason: "invalid-phaseIndex",
    });
    expect(server.processHTTPRequest).not.toHaveBeenCalled();
  });

  it("rejects an empty job identifier consistently", async () => {
    await expect(dacsX402AuthorizationNonce({
      jobId: "",
      phaseIndex: PHASE_INDEX,
    })).rejects.toThrow("jobId");
    expect(() => x402Eip3009Nonce("", PHASE_INDEX)).toThrow("jobId");
  });
});
