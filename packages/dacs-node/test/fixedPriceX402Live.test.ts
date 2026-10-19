import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Explicitly non-live harness: these cases run against a released profile
// record; a case that sets `release.real` gets the real record at the pin.
const release = vi.hoisted(() => ({ real: false }));
vi.mock("../../../src/discovery/standardProfileRelease.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/discovery/standardProfileRelease.js")>();
  return { get DACS_STANDARD_PROFILE_STATUS() { return release.real ? actual.DACS_STANDARD_PROFILE_STATUS : "released"; } };
});
afterEach(() => { release.real = false; });
import { trustedSessionProfile } from "./helpers/sessionProfile.js";

const mocks = vi.hoisted(() => ({ buyer: vi.fn(), seller: vi.fn(), resolveHttp: vi.fn() }));
vi.mock("../src/fixedPriceX402Profile.js", () => ({
  createDacsFixedPriceX402BuyerAgreementPolicyV1: () => ({}),
  createDacsFixedPriceX402BuyerPaymentPolicyV1: () => ({}),
  createDacsFixedPriceX402SellerSessionPolicyV1: () => ({}),
  createDacsFixedPriceX402SellerAgreementPolicyV1: () => ({}),
}));
vi.mock("../src/fixedPriceX402BuyerCommerce.js", () => ({
  createDacsFixedPriceX402BuyerCommerceV1: () => ({ paymentEvidence: {} }),
}));
vi.mock("../src/fixedPriceX402BuyerAudit.js", () => ({
  createDacsFixedPriceX402BuyerAuditV1: () => ({ audit: {}, bundleTransport: {} }),
}));
vi.mock("../src/fixedPriceX402SellerRuntime.js", () => ({
  createDacsFixedPriceX402SellerX402CompositionV1: () => ({
    x402: { resolveHttpRequest: mocks.resolveHttp }, settlement: {}, fulfilment: {},
  }),
}));
vi.mock("../src/fixedPriceX402SellerPaymentEvidence.js", () => ({
  createDacsFixedPriceX402SellerPaymentEvidenceV1: () => ({}),
}));
vi.mock("../src/fixedPriceX402SellerAudit.js", () => ({
  createDacsFixedPriceX402SellerAuditV1: () => ({}),
}));
vi.mock("../src/liveCommerceAssembly.js", () => ({
  createDacsBuyerLiveCommerceAssemblyV1: mocks.buyer,
  createDacsSellerLiveCommerceAssemblyV1: mocks.seller,
}));

import { createDacsFixedPriceX402BuyerLiveV1 } from "../src/fixedPriceX402BuyerLive.js";
import { createDacsFixedPriceX402SellerLiveV1 } from "../src/fixedPriceX402SellerLive.js";

const JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = "did:demos:agent:" + "1".repeat(64);
const SELLER = "did:demos:agent:" + "2".repeat(64);

beforeEach(() => vi.clearAllMocks());

for (const role of ["buyer", "seller"] as const) {
  const factory = role === "buyer" ? createDacsFixedPriceX402BuyerLiveV1 : createDacsFixedPriceX402SellerLiveV1;
  const assembly = role === "buyer" ? mocks.buyer : mocks.seller;
  const options = (context: unknown) => ({ context, rail: { asset: { kind: "erc20", decimals: 6 } },
    maximumServiceAmount: "1" }) as never;

  it(`${role}: refuses missing independent authority before constructing a usable graph`, async () => {
    assembly.mockResolvedValue({ operations: {}, router: {} });
    await expect(factory(options({ role }))).rejects.toThrow(/independent session profile admission/);
    expect(assembly).not.toHaveBeenCalled();
  });

  it(`${role}: bounds an unanswered admission without starting payment`, async () => {
    const payment = vi.fn();
    assembly.mockResolvedValue({ operations: { payment }, router: {} });
    const context = { role, authority: role === "buyer" ? BUYER : SELLER,
      peerAuthority: role === "buyer" ? SELLER : BUYER,
      authenticateSessionProfile: () => new Promise(() => {}) };
    const live = await factory(options(context));
    vi.useFakeTimers();
    try {
      const rejected = expect(live.operations.payment!({ order: { jobId: JOB } } as never))
        .rejects.toThrow("session profile admission timed out");
      await vi.advanceTimersByTimeAsync(60_000);
      await rejected;
      expect(payment).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it(`${role}: re-admits every operation, inbound and terminal entry, including paid recovery`, async () => {
    const effect = vi.fn(async () => ({ state: "audit-complete" }));
    const operations = Object.fromEntries((role === "buyer"
      ? ["agreement", "payment", "payment-evidence", "buyer-received", "audit"]
      : ["agreement", "payment", "payment-evidence", "delivery", "delivery-evidence", "audit"])
      .map(name => [name, effect]));
    const terminal = { transport: { propose: effect, contribute: effect, advance: effect },
      validatePayload: effect, handleMessage: effect, registerLocalTerminal: effect,
      registerLocalVetPass: effect, advanceRegisteredTerminal: effect };
    const graph = { role, operations, router: { validatePayload: effect, handleMessage: effect },
      validatePayload: effect, handleMessage: effect, terminalBundles: terminal };
    assembly.mockResolvedValue(graph);
    const good = trustedSessionProfile(JOB, BUYER, SELLER);
    let admission: unknown = good;
    const context = { role, authority: role === "buyer" ? BUYER : SELLER,
      peerAuthority: role === "buyer" ? SELLER : BUYER,
      authenticateSessionProfile: vi.fn(() => admission) };
    const live = await factory(options(context));
    const operation = { order: { jobId: JOB, tracks: { payment: { state: "final" } } } };
    const message = { envelope: { jobId: JOB } };
    const calls = [
      ...Object.values(live.operations).map(action => () => action(operation as never)),
      () => live.validatePayload({ jobId: JOB } as never),
      () => live.router.validatePayload({ jobId: JOB } as never),
      () => live.handleMessage(message as never, {} as never),
      () => live.router.handleMessage(message as never, {} as never),
      ...Object.values(live.terminalBundles!.transport).map(action =>
        () => Reflect.apply(action, live.terminalBundles!.transport, [{ identity: { jobId: JOB } }])),
      () => live.terminalBundles!.validatePayload({ jobId: JOB } as never),
      () => live.terminalBundles!.handleMessage(message as never, {} as never),
      () => live.terminalBundles!.registerLocalTerminal({ jobId: JOB } as never),
      () => live.terminalBundles!.registerLocalVetPass!({ jobId: JOB } as never),
      () => live.terminalBundles!.advanceRegisteredTerminal(JOB),
    ];
    // The real record at the pin refuses a complete authority reply that
    // states the candidate status, at every entry point.
    release.real = true;
    admission = trustedSessionProfile(JOB, BUYER, SELLER);
    for (const call of calls) await expect(call()).rejects.toThrow(/unreleased candidate/);
    expect(effect).not.toHaveBeenCalled();
    release.real = false;
    for (const bad of [undefined, { ...good, releasePin: "historical" },
      (({ profileStatus: _status, ...pinOnly }) => pinOnly)(good),
      { ...good, profileStatus: "unreleased-candidate" },
      { ...good, moduleVersions: { core: "0.3" } },
      { ...good, roles: [good.roles[0], good.roles[0]] },
      { ...good, roles: good.roles.map(entry => ({ ...entry, jobId: JOB.slice(0, -1) + "E" })) },
      { ...good, roles: good.roles.map(entry => ({ ...entry, participant: BUYER })) }]) {
      admission = bad;
      for (const call of calls) await expect(call()).rejects.toThrow();
      expect(effect).not.toHaveBeenCalled();
    }
    admission = good;
    for (const call of calls) await call();
    expect(effect).toHaveBeenCalledTimes(calls.length);
    expect(context.authenticateSessionProfile).toHaveBeenLastCalledWith(JOB);
    // A restarted graph uses the supplied authority again; a previous success
    // never authorizes another effect or the paid order's next audit attempt.
    const restarted = await factory(options(context));
    admission = undefined;
    await expect(restarted.operations.audit!(operation as never)).rejects.toThrow();
    const unavailable = new Error("authority read timed out");
    context.authenticateSessionProfile.mockImplementationOnce(() => { throw unavailable; });
    await expect(restarted.operations.audit!(operation as never)).rejects.toBe(unavailable);
    expect(effect).toHaveBeenCalledTimes(calls.length);
    admission = good;
    await expect(restarted.operations.audit!(operation as never)).resolves.toEqual({ state: "audit-complete" });
    expect(effect).toHaveBeenCalledTimes(calls.length + 1);
  });
}

it("seller: authenticates matched HTTP resources before the paywall can settle or replay delivery", async () => {
  const good = trustedSessionProfile(JOB, BUYER, SELLER);
  const authenticateSessionProfile = vi.fn((): unknown => good);
  mocks.seller.mockResolvedValue({ operations: {}, router: {} });
  mocks.resolveHttp.mockResolvedValue({ status: "matched", jobId: JOB, phaseIndex: 2 });
  await createDacsFixedPriceX402SellerLiveV1({ context: { role: "seller", authority: SELLER,
    peerAuthority: BUYER, authenticateSessionProfile } } as never);
  const resolve = mocks.seller.mock.calls[0]![0].x402.resolveHttpRequest;
  authenticateSessionProfile.mockReturnValueOnce(undefined);
  await expect(resolve({ pathname: "/resource" }, {})).rejects.toThrow();
  await expect(resolve({ pathname: "/resource" }, {})).resolves.toMatchObject({ status: "matched", jobId: JOB });
  expect(authenticateSessionProfile).toHaveBeenLastCalledWith(JOB);
  mocks.resolveHttp.mockResolvedValueOnce({ status: "not-matched" });
  authenticateSessionProfile.mockClear();
  await expect(resolve({ pathname: "/health" }, {})).resolves.toEqual({ status: "not-matched" });
  expect(authenticateSessionProfile).not.toHaveBeenCalled();
});
