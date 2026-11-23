import { afterEach, describe, expect, it, vi } from "vitest";

const rails = vi.hoisted(() => new WeakSet<object>());

vi.mock("@kynesyslabs/dacs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kynesyslabs/dacs")>()),
  isAuthenticatedRailDefinition: (value: unknown) =>
    typeof value === "object" && value !== null && rails.has(value),
}));

import {
  assertX402BuyerSettlementIntent,
  captureWalletSpendPolicyV1,
  createInMemoryWalletSpendStateStore,
  createWalletSpendAuthorityV1,
  createX402BuyerSettlementIntent,
  x402BuyerSettlementKey,
  type WalletSpendRecoveryObservationV1,
  type WalletSpendReservationV1,
  type WalletSpendSettlementObservationV1,
  type WalletSpendStateV1,
} from "@kynesyslabs/dacs";

import { createDacsFixedPriceX402BuyerPaymentPolicyV1 } from "../src/fixedPriceX402Profile.js";
import { createDacsWalletSpendEvmReaderV1 } from "../src/walletSpendEvmReader.js";
import {
  DACS_WALLET_SPEND_TESTNET_HOLD_EXPIRY_SECONDS,
  createDacsWalletSpendTestnetRecoveryV1,
} from "../src/walletSpendTestnetRecovery.js";
import {
  FINAL_NUMBER,
  LATEST_NUMBER,
  SEARCH_FLOOR,
  TESTNET_AMOUNT,
  TESTNET_ASSET,
  TESTNET_PAYEE,
  TESTNET_WALLET,
  chainBlocks,
  chainState,
  chainStub,
  closeChainStubs,
  defaultChain,
  nonceOf,
  recordAuthorization,
  stateWithHold,
  testnetPolicy,
  testnetReservation,
  timeWithFinalAt,
  type ChainState,
  type ChainStub,
  type RpcCall,
  type StubBlock,
} from "./helpers/walletSpendTestnetChain.js";

afterEach(closeChainStubs);

/** The bound validBefore: the hook's answer for a 120 s window when the latest block's time is the row's createdAt. */
const VALID_BEFORE = Math.floor(1_700_000_000_000 / 1000) + 120;
const RESERVATION = testnetReservation();
const NONCE = nonceOf("job-one", 0);
const PAYMENT_NUMBER = FINAL_NUMBER - 5;
const POLICY = captureWalletSpendPolicyV1(testnetPolicy());

const settledClaim = (amount = TESTNET_AMOUNT): WalletSpendSettlementObservationV1 => ({
  disposition: "settled",
  evidenceHash: "d".repeat(64),
  debits: [{ asset: TESTNET_ASSET, purpose: "service", amount }],
});
const absentClaim: WalletSpendRecoveryObservationV1 = { disposition: "terminal-absent", evidenceHash: "e".repeat(64) };

const SECOND_RAIL = "x402-exact-evm-second";

/** The same job phase's hold on a second configured rail: another reservation id, the same nonce. */
function otherRailHold(item: WalletSpendReservationV1): WalletSpendReservationV1 {
  const key = x402BuyerSettlementKey({ railId: SECOND_RAIL, jobId: item.jobId, phaseIndex: item.phaseIndex });
  return { ...item, railId: SECOND_RAIL, reservationId: `x402:${key}` };
}

type StoredStage = WalletSpendStateV1["reservations"][number]["stage"];

/** The fixture state with a second rail's hold for the same job phase stored first, at `stage`. */
function stateWithOtherRail(stage: StoredStage): WalletSpendStateV1 {
  const state = stateWithHold(RESERVATION, VALID_BEFORE);
  const [row] = state.reservations;
  if (row === undefined) throw new Error("the fixture state has one row");
  const other = otherRailHold(RESERVATION);
  return {
    ...state,
    reservations: [{ ...row, reservationId: other.reservationId, reservation: other, stage, generation: 1 }, row],
  };
}

function blockAt(state: ChainState, number: number): StubBlock {
  const block = state.byNumber.get(number);
  if (block === undefined) throw new Error(`no block ${number}`);
  return block;
}

function blockIn(blocks: readonly StubBlock[], number: number): StubBlock {
  const block = blocks.find((candidate) => candidate.number === number);
  if (block === undefined) throw new Error(`no block ${number}`);
  return block;
}

const [DEBIT] = RESERVATION.debits;
if (DEBIT === undefined) throw new Error("the fixture hold has one debit");

function rule(
  stub: Readonly<{ url: string }>,
  state: WalletSpendStateV1 = stateWithHold(RESERVATION, VALID_BEFORE),
  searchFloor = SEARCH_FLOOR,
  readState: () => Promise<WalletSpendStateV1> = async () => state,
) {
  const reports: Record<string, string>[] = [];
  const recovery = createDacsWalletSpendTestnetRecoveryV1({
    policy: POLICY,
    reader: createDacsWalletSpendEvmReaderV1({
      rpcUrl: stub.url, policy: POLICY, authorizationSearchFromBlock: searchFloor,
    }),
    readState,
    report: (line) => reports.push(line),
  });
  /** Checks as the core does: with the stored row's generation and expiry. */
  const check = (reservation: WalletSpendReservationV1, observation: WalletSpendRecoveryObservationV1) => {
    const row = state.reservations.find((stored) => stored.reservationId === reservation.reservationId);
    return recovery.check(reservation, observation, row === undefined ? undefined : {
      generation: row.generation,
      ...(row.authorizationValidBefore === undefined ? {} : { authorizationValidBefore: row.authorizationValidBefore }),
    });
  };
  return { ...recovery, check, raw: recovery, reports };
}

function payment(state: ChainState, overrides: Partial<Parameters<typeof recordAuthorization>[1]> = {}) {
  return recordAuthorization(state, {
    block: blockAt(state, PAYMENT_NUMBER),
    nonce: NONCE,
    transfers: [{ payee: TESTNET_PAYEE, amount: TESTNET_AMOUNT }],
    ...overrides,
  });
}

const callsOf = (stub: ChainStub, method: string): RpcCall[] => stub.calls.filter((call) => call.method === method);
const hashReads = (stub: ChainStub): unknown[] => callsOf(stub, "eth_getBlockByHash").map((call) => call.params[0]);

async function closedUrl(): Promise<string> {
  const stub = await chainStub(defaultChain());
  await stub.close();
  return stub.url;
}

describe("testnet wallet-spend recovery rule", () => {
  it("accepts settled when the chain shows the exact payment final", async () => {
    const state = defaultChain();
    payment(state);
    const stub = await chainStub(state);

    await expect(rule(stub).check(RESERVATION, settledClaim()))
      .resolves.toEqual({ accepted: true, reasonCode: "wallet-spend-chain-paid" });
    const expected = [];
    for (let number = LATEST_NUMBER; number >= PAYMENT_NUMBER; number -= 1) expected.push(blockAt(state, number).hash);
    expect(hashReads(stub)).toEqual(expected);
  });

  it("refuses settled for another nonce, payee or amount", async () => {
    const otherNonce = defaultChain();
    payment(otherNonce, { nonce: nonceOf("job-two", 0) });
    await expect(rule(await chainStub(otherNonce)).check(RESERVATION, settledClaim()))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-pending" });

    for (const transfer of [
      { payee: `0x${"7b".repeat(20)}`, amount: TESTNET_AMOUNT },
      { payee: TESTNET_PAYEE, amount: "250001" },
    ]) {
      const state = defaultChain();
      payment(state, { transfers: [transfer] });
      await expect(rule(await chainStub(state)).check(RESERVATION, settledClaim()))
        .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-nonce-used-unmatched" });
    }
  });

  it("keeps a hold whose nonce was used without the agreed transfer and reports it once", async () => {
    const state = defaultChain();
    const transactionHash = payment(state, { transfers: [] });
    const recovery = rule(await chainStub(state));

    await expect(recovery.check(RESERVATION, settledClaim()))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-nonce-used-unmatched" });
    await expect(recovery.authenticateRecovery(RESERVATION, absentClaim)).resolves.toBe(false);
    expect(recovery.reports).toEqual([{
      status: "hold-needs-operator",
      reasonCode: "wallet-spend-chain-nonce-used-unmatched",
      reservationId: RESERVATION.reservationId,
      transactionHash,
    }]);
  });

  it("keeps a hold whose payment is not final", async () => {
    const state = chainState(chainBlocks({ high: LATEST_NUMBER + 1, time: timeWithFinalAt(1_800_000_000) }));
    state.latest = LATEST_NUMBER;
    payment(state, { block: blockAt(state, FINAL_NUMBER + 1) });
    const recovery = rule(await chainStub(state));
    await expect(recovery.check(RESERVATION, settledClaim()))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-pending" });
    state.latest = LATEST_NUMBER + 1;
    await expect(recovery.check(RESERVATION, settledClaim()))
      .resolves.toEqual({ accepted: true, reasonCode: "wallet-spend-chain-paid" });

    const reverted = defaultChain();
    payment(reverted, { status: "0x0" });
    await expect(rule(await chainStub(reverted)).check(RESERVATION, settledClaim()))
      .resolves.toMatchObject({ accepted: false, reasonCode: "wallet-spend-chain-unavailable" });

    const skipped = defaultChain();
    payment(skipped);
    const parentOfLatest = blockAt(skipped, LATEST_NUMBER - 1);
    skipped.byHash.set(parentOfLatest.hash, { ...parentOfLatest, number: LATEST_NUMBER - 2 });
    await expect(rule(await chainStub(skipped)).check(RESERVATION, settledClaim()))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-ancestry-unproven" });

    const moving = defaultChain();
    payment(moving);
    const final = blockAt(moving, FINAL_NUMBER);
    moving.byNumber.set(FINAL_NUMBER, { ...final, hash: `0x${"9f".repeat(32)}` });
    await expect(rule(await chainStub(moving)).check(RESERVATION, settledClaim()))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-unavailable" });
  });

  it("releases on a final cancel and refuses settled for it", async () => {
    const state = defaultChain();
    payment(state, { event: "canceled", transfers: [] });
    const recovery = rule(await chainStub(state));

    await expect(recovery.check(RESERVATION, absentClaim))
      .resolves.toEqual({ accepted: true, reasonCode: "wallet-spend-chain-cancelled" });
    await expect(recovery.check(RESERVATION, settledClaim()))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-cancelled" });
  });

  it("keeps an unused hold until chain time is past its bound validBefore", async () => {
    for (const finalTime of [VALID_BEFORE - 1, VALID_BEFORE]) {
      const stub = await chainStub(defaultChain(finalTime));
      await expect(rule(stub).check(RESERVATION, absentClaim))
        .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-authorization-still-valid" });
      expect(callsOf(stub, "eth_getLogs")).toEqual([]);
    }
  });

  it("releases an unused hold once chain time is past its bound validBefore", async () => {
    const stub = await chainStub(defaultChain(VALID_BEFORE + 1));
    await expect(rule(stub).check(RESERVATION, absentClaim))
      .resolves.toEqual({ accepted: true, reasonCode: "wallet-spend-chain-expired-unused" });

    const logged = defaultChain(VALID_BEFORE + 1);
    payment(logged, { marksUsed: false });
    await expect(rule(await chainStub(logged)).check(RESERVATION, absentClaim))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-unavailable" });
  });

  it("refuses every claim when the chain cannot be read", async () => {
    const oversized = JSON.stringify({ padding: "x".repeat(1_100 * 1024) });
    const failures: readonly Readonly<{
      url?: string;
      chainId?: string;
      answer?: (call: RpcCall) => Readonly<{ status: number; body: unknown }> | undefined;
    }>[] = [
      { url: await closedUrl() },
      { answer: (call) => call.method === "eth_getBlockByHash" ? { status: 500, body: "{}" } : undefined },
      { answer: (call) => call.method === "eth_getTransactionReceipt" ? { status: 200, body: oversized } : undefined },
      { chainId: "0x2105" },
      {
        answer: (call) => call.method === "eth_getLogs"
          ? { status: 200, body: { jsonrpc: "2.0", id: call.id, result: [{ topics: "none" }] } }
          : undefined,
      },
    ];
    for (const failure of failures) {
      for (const [claim, event] of [[settledClaim(), "used"], [absentClaim, "canceled"]] as const) {
        const state = defaultChain();
        payment(state, { event });
        if (failure.chainId !== undefined) state.chainId = failure.chainId;
        const stub = await chainStub(state, failure.answer === undefined ? {} : { answer: failure.answer });
        await expect(rule({ url: failure.url ?? stub.url }).check(RESERVATION, claim))
          .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-unavailable" });
      }
    }
  });

  it("refuses every claim when the final head is below the log search floor", async () => {
    const expired = await chainStub(defaultChain(VALID_BEFORE + 1));
    await expect(rule(expired, undefined, FINAL_NUMBER + 1).check(RESERVATION, absentClaim))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-unavailable" });
    expect(callsOf(expired, "eth_getLogs")).toEqual([]);

    for (const [claim, event] of [[settledClaim(), "used"], [absentClaim, "canceled"]] as const) {
      const state = defaultChain();
      payment(state, { event });
      const stub = await chainStub(state);
      await expect(rule(stub, undefined, FINAL_NUMBER + 1).check(RESERVATION, claim))
        .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-unavailable" });
      expect(callsOf(stub, "eth_getLogs")).toEqual([]);
    }
  });

  it("refuses holds the rule cannot bind", async () => {
    const state = defaultChain();
    payment(state);
    const stub = await chainStub(state);
    const unbound: WalletSpendReservationV1[] = [
      { ...RESERVATION, reservationId: "x402:dacs:x402-buyer:other" },
      { ...RESERVATION, debits: [DEBIT, { ...DEBIT, purpose: "network-fee" }] },
      { ...RESERVATION, debits: [{ ...DEBIT, asset: `0x${"04".repeat(20)}` }] },
      { ...RESERVATION, finality: { model: "confirmation-depth" } },
    ];
    for (const reservation of unbound) {
      await expect(rule(stub, stateWithHold(reservation, VALID_BEFORE)).check(reservation, settledClaim()))
        .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-hold-unbound" });
    }
    await expect(rule(stub, stateWithHold(testnetReservation("job-two"))).check(RESERVATION, absentClaim))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-hold-missing" });
    await expect(rule(stub).raw.check(RESERVATION, absentClaim))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-hold-missing" });
    await expect(rule(stub).check(RESERVATION, { disposition: "not-invoked", evidenceHash: "e".repeat(64) }))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-absence-kind-refused" });
    expect(stub.calls).toEqual([]);

    const doubled = defaultChain();
    payment(doubled, { transfers: [{ payee: TESTNET_PAYEE, amount: TESTNET_AMOUNT }, { payee: TESTNET_PAYEE, amount: TESTNET_AMOUNT }] });
    await expect(rule(await chainStub(doubled)).check(RESERVATION, settledClaim()))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-unavailable" });
  });

  it("uses the SDK's nonce rule and an expiry bound that covers every SDK buyer", async () => {
    const stub = await chainStub(defaultChain());
    await rule(stub).check(RESERVATION, settledClaim());
    const stateCall = callsOf(stub, "eth_call")[0]?.params[0] as { data: string };
    const ruleNonce = `0x${stateCall.data.slice(-64)}` as const;

    const intentFor = (nonce: `0x${string}`) => {
      const chosenRequirements = {
        scheme: "exact", network: "eip155:84532" as const, amount: TESTNET_AMOUNT, asset: TESTNET_ASSET,
        payTo: TESTNET_PAYEE, maxTimeoutSeconds: 120,
        extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
      };
      const signedPaymentPayload = {
        x402Version: 2,
        resource: { url: "https://seller.example/deliver" },
        accepted: chosenRequirements,
        payload: {
          authorization: {
            from: TESTNET_WALLET, to: TESTNET_PAYEE, value: TESTNET_AMOUNT,
            validAfter: "0", validBefore: "4102444800", nonce,
          },
          signature: `0x${"44".repeat(65)}`,
        },
      };
      return createX402BuyerSettlementIntent({
        jobId: RESERVATION.jobId, phaseIndex: RESERVATION.phaseIndex, railId: RESERVATION.railId,
        railVersion: "1", railDescriptorHash: "c".repeat(64), agreementHash: "d".repeat(64),
        termsHash: "e".repeat(64), sessionBindingHash: "f".repeat(64), network: "eip155:84532",
        payer: TESTNET_WALLET, payee: TESTNET_PAYEE, asset: TESTNET_ASSET, amount: TESTNET_AMOUNT,
        httpResource: "https://seller.example/deliver", method: "GET", chosenRequirements, signedPaymentPayload,
        paymentHeader: {
          name: "PAYMENT-SIGNATURE",
          value: Buffer.from(JSON.stringify(signedPaymentPayload), "utf8").toString("base64"),
        },
        authorizationNonce: nonce,
      });
    };
    expect(() => assertX402BuyerSettlementIntent(intentFor(ruleNonce))).not.toThrow();
    expect(() => assertX402BuyerSettlementIntent(intentFor(nonceOf(RESERVATION.jobId, 1)))).toThrow();

    const rail = Object.freeze({ railId: "x402:test", railType: "x402" });
    rails.add(rail);
    const options = (maxTimeoutSeconds: number) => ({
      context: { role: "buyer", evm: { role: "buyer" } } as never,
      rail: rail as never,
      tokenDomain: { name: "USD Coin", version: "2" },
      maxTimeoutSeconds,
    });
    expect(() => createDacsFixedPriceX402BuyerPaymentPolicyV1(options(DACS_WALLET_SPEND_TESTNET_HOLD_EXPIRY_SECONDS)))
      .not.toThrow();
    expect(() => createDacsFixedPriceX402BuyerPaymentPolicyV1(options(DACS_WALLET_SPEND_TESTNET_HOLD_EXPIRY_SECONDS + 1)))
      .toThrow("fixed-price buyer payment policy options are invalid");
  });

  it("gives neither paid nor cancelled when the receipt is not on the final chain", async () => {
    const time = timeWithFinalAt(1_800_000_000);
    const forkB = chainBlocks({ fork: "b", split: PAYMENT_NUMBER - 3, time });
    const mixed = (event: "used" | "canceled", fromB: readonly number[]) => {
      const state = chainState(chainBlocks({ time }), forkB);
      for (const number of fromB) state.byNumber.set(number, blockIn(forkB, number));
      recordAuthorization(state, {
        block: blockIn(forkB, PAYMENT_NUMBER), nonce: NONCE, event,
        transfers: event === "used" ? [{ payee: TESTNET_PAYEE, amount: TESTNET_AMOUNT }] : [],
      });
      return state;
    };
    const unproven = { accepted: false, reasonCode: "wallet-spend-chain-ancestry-unproven" };
    await expect(rule(await chainStub(mixed("used", [PAYMENT_NUMBER]))).check(RESERVATION, settledClaim()))
      .resolves.toEqual(unproven);
    await expect(rule(await chainStub(mixed("canceled", [PAYMENT_NUMBER]))).check(RESERVATION, absentClaim))
      .resolves.toEqual(unproven);
    await expect(rule(await chainStub(mixed("used", [FINAL_NUMBER, PAYMENT_NUMBER]))).check(RESERVATION, settledClaim()))
      .resolves.toEqual(unproven);

    const deep = chainState(chainBlocks({ low: LATEST_NUMBER - 4_200, time }));
    payment(deep, { block: blockAt(deep, LATEST_NUMBER - 4_097) });
    const deepStub = await chainStub(deep);
    await expect(rule(deepStub).check(RESERVATION, settledClaim())).resolves.toEqual(unproven);
    expect(hashReads(deepStub)).toHaveLength(3);

    const relinked = defaultChain();
    payment(relinked);
    const linked = blockAt(relinked, LATEST_NUMBER - 1).hash;
    const stub = await chainStub(relinked, {
      answer: (call) => call.method === "eth_getBlockByHash" && call.params[0] === linked
        ? { status: 200, body: { jsonrpc: "2.0", id: call.id, result: {
          number: `0x${(LATEST_NUMBER - 1).toString(16)}`, hash: `0x${"9e".repeat(32)}`,
          parentHash: blockAt(relinked, LATEST_NUMBER - 2).hash, timestamp: "0x1",
        } } }
        : undefined,
    });
    await expect(rule(stub).check(RESERVATION, settledClaim()))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-unavailable" });
  });

  it("never releases by time a hold that has no bound validBefore", async () => {
    const unbound = stateWithHold(RESERVATION);
    const stub = await chainStub(defaultChain(1_700_000_000 + 10 * 86_400));
    await expect(rule(stub, unbound).check(RESERVATION, absentClaim))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-authorization-valid-before-missing" });
    expect(callsOf(stub, "eth_getLogs")).toEqual([]);

    const cancelled = defaultChain(1_700_000_000 + 10 * 86_400);
    payment(cancelled, { event: "canceled", transfers: [] });
    await expect(rule(await chainStub(cancelled), unbound).check(RESERVATION, absentClaim))
      .resolves.toEqual({ accepted: true, reasonCode: "wallet-spend-chain-cancelled" });
  });

  it("binds validBefore from the latest block at most 86,400 seconds ahead", async () => {
    const state = defaultChain();
    const latestTime = blockAt(state, LATEST_NUMBER).timestamp;
    const stub = await chainStub(state);
    const { bindAuthorizationValidBefore: bind } = rule(stub);

    await expect(bind({ reservation: RESERVATION, authorizationWindowSeconds: 120 })).resolves.toBe(latestTime + 120);
    expect(stub.calls.map((call) => [call.method, call.params[0] ?? null]).sort()).toEqual([
      ["eth_chainId", null], ["eth_getBlockByNumber", "latest"],
    ]);
    await expect(bind({ reservation: RESERVATION, authorizationWindowSeconds: 86_400 }))
      .resolves.toBe(latestTime + 86_400);

    const sent = stub.calls.length;
    for (const window of [86_401, 0, 1.5, "120"]) {
      await expect(bind({ reservation: RESERVATION, authorizationWindowSeconds: window as number }))
        .rejects.toThrow("wallet-spend-chain-authorization-window-invalid");
    }
    await expect(bind({ reservation: RESERVATION })).rejects.toThrow("wallet-spend-chain-authorization-window-missing");
    await expect(bind({
      reservation: { ...RESERVATION, debits: [DEBIT, { ...DEBIT, purpose: "network-fee" }] },
      authorizationWindowSeconds: 120,
    })).rejects.toThrow("wallet-spend-chain-hold-unbound");
    expect(stub.calls).toHaveLength(sent);

    await expect(rule({ url: await closedUrl() }).bindAuthorizationValidBefore({
      reservation: RESERVATION, authorizationWindowSeconds: 120,
    })).rejects.toThrow("wallet-spend-chain-unavailable");
  });

  it("judges the expiry of the hold it is given, and a settlement needs no hold", async () => {
    const finalTime = 1_800_000_000;
    const hold = (authorizationValidBefore: number) => ({ generation: 2, authorizationValidBefore });
    const stub = await chainStub(defaultChain(finalTime));
    const { raw } = rule(stub, stateWithHold(RESERVATION, finalTime - 1));
    await expect(raw.check(RESERVATION, absentClaim, hold(finalTime)))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-authorization-still-valid" });
    await expect(raw.check(RESERVATION, absentClaim, hold(finalTime - 1)))
      .resolves.toEqual({ accepted: true, reasonCode: "wallet-spend-chain-expired-unused" });
    await expect(raw.check(RESERVATION, absentClaim, { generation: 2 }))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-authorization-valid-before-missing" });

    const paid = defaultChain();
    payment(paid);
    await expect(rule(await chainStub(paid)).raw.check(RESERVATION, settledClaim()))
      .resolves.toEqual({ accepted: true, reasonCode: "wallet-spend-chain-paid" });
  });

  for (const stage of ["reserved", "effect-pending", "settled"] as const) {
    it(`refuses a payment for a hold when another rail's ${stage} hold uses the same job phase`, async () => {
      const state = defaultChain();
      payment(state);
      const recovery = rule(await chainStub(state), stateWithOtherRail(stage));

      await expect(recovery.check(RESERVATION, settledClaim()))
        .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-nonce-claimed" });
      await recovery.check(RESERVATION, settledClaim());
      expect(recovery.reports).toEqual([{
        status: "hold-needs-operator",
        reasonCode: "wallet-spend-chain-nonce-claimed",
        reservationId: RESERVATION.reservationId,
      }]);
    });
  }

  it("counts a payment when the other rail's hold for the job phase was released", async () => {
    const state = defaultChain();
    payment(state);

    await expect(rule(await chainStub(state), stateWithOtherRail("released")).check(RESERVATION, settledClaim()))
      .resolves.toEqual({ accepted: true, reasonCode: "wallet-spend-chain-paid" });
  });

  it("refuses a decision when the state cannot be read after the chain walk", async () => {
    const unreadable = async (): Promise<WalletSpendStateV1> => {
      throw new Error("state store offline");
    };
    const paid = defaultChain();
    payment(paid);
    await expect(rule(await chainStub(paid), undefined, SEARCH_FLOOR, unreadable).check(RESERVATION, settledClaim()))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-unavailable" });

    const finalTime = 1_800_000_000;
    const expired = rule(await chainStub(defaultChain(finalTime)), stateWithHold(RESERVATION, finalTime - 1),
      SEARCH_FLOOR, unreadable);
    await expect(expired.check(RESERVATION, absentClaim))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-unavailable" });
  });

  for (const change of [
    { name: "the hold was released and reserved again", generation: 3, validBefore: 1_800_000_120 },
    { name: "only the hold's expiry changed", generation: 2, validBefore: 1_800_000_120 },
    { name: "only the hold's generation changed", generation: 3, validBefore: 1_799_999_990 },
  ]) {
    it(`refuses a release when ${change.name} during a slow check`, async () => {
      const finalTime = 1_800_000_000;
      const checkedExpiry = finalTime - 10;
      const stub = await chainStub(defaultChain(finalTime));
      const real = createDacsWalletSpendEvmReaderV1({
        rpcUrl: stub.url, policy: POLICY, authorizationSearchFromBlock: SEARCH_FLOOR,
      });
      const replacement = stateWithHold(RESERVATION, change.validBefore);
      const current = { state: stateWithHold(RESERVATION, checkedExpiry) };
      const recovery = createDacsWalletSpendTestnetRecoveryV1({
        policy: POLICY,
        reader: {
          readBlock: (block) => real.readBlock(block),
          readBlockByHash: (hash) => real.readBlockByHash(hash),
          readAuthorizationState: (request) => real.readAuthorizationState(request),
          readReceipt: (hash) => real.readReceipt(hash),
          async readAuthorizationLogs(request) {
            current.state = {
              ...replacement,
              generation: change.generation,
              reservations: replacement.reservations.map((row) => ({ ...row, generation: change.generation })),
            };
            return real.readAuthorizationLogs(request);
          },
        },
        readState: async () => current.state,
        report: () => undefined,
      });

      await expect(recovery.check(RESERVATION, absentClaim, { generation: 2, authorizationValidBefore: checkedExpiry }))
        .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-chain-hold-changed" });
    });
  }
});

describe("testnet wallet-spend recovery rule inside the authority, with the hold reserved again", () => {
  const FINAL_TIME = 1_800_000_000;
  /** Past at the chain's final head: the first hold's signed authorization has expired. */
  const FIRST_EXPIRY = FINAL_TIME - 10;
  /** Still ahead of the final head: the replacement hold's signed authorization is valid. */
  const SECOND_EXPIRY = FINAL_TIME + 120;
  const LEASE_MS = 100_000;
  const ITEM = testnetReservation("01J9ZQ6X3F8K2M5N7P4R1T0VWA");
  const LINEAGE = "testnet-lineage";

  async function authority(chain = defaultChain(FINAL_TIME)) {
    const stub = await chainStub(chain);
    const memory = createInMemoryWalletSpendStateStore();
    const real = createDacsWalletSpendEvmReaderV1({
      rpcUrl: stub.url, policy: POLICY, authorizationSearchFromBlock: SEARCH_FLOOR,
    });
    let armed = false;
    let reached: () => void = () => undefined;
    let open: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const recovery = createDacsWalletSpendTestnetRecoveryV1({
      policy: POLICY,
      reader: {
        readBlock: (block) => real.readBlock(block),
        readBlockByHash: (hash) => real.readBlockByHash(hash),
        readAuthorizationState: (request) => real.readAuthorizationState(request),
        readReceipt: (hash) => real.readReceipt(hash),
        async readAuthorizationLogs(request) {
          if (armed) {
            armed = false;
            reached();
            await opened;
          }
          return real.readAuthorizationLogs(request);
        },
      },
      async readState() {
        const state = await memory.read?.(LINEAGE);
        if (state === undefined || state === null) throw new Error("no state yet");
        return state;
      },
      report: () => undefined,
    });
    const expiries = [FIRST_EXPIRY, SECOND_EXPIRY];
    const clock = { value: 1_000_000 };
    const wallet = createWalletSpendAuthorityV1(POLICY, {
      store: { ...memory, lineageScope: () => LINEAGE },
      readBalance: async () => "100000000",
      authenticateRecovery: recovery.authenticateRecovery,
      bindAuthorizationValidBefore: async () => expiries.shift() ?? SECOND_EXPIRY,
      now: () => clock.value,
      owner: "testnet-authority",
      leaseDurationMs: LEASE_MS,
    });
    const reserve = async (item = ITEM) => {
      const claim = await wallet.reserve(item, { authorizationWindowSeconds: 120 });
      if (claim.status !== "reserved") throw new Error(`expected a hold, got ${claim.status}`);
      return claim.permit;
    };
    return {
      wallet,
      reserve,
      /** Moves the wall clock past the current lease. */
      lapse: () => {
        clock.value += LEASE_MS + 1;
      },
      /** The next log search stops until `resume()`. */
      pauseNextCheck: () => {
        armed = true;
        return arrived;
      },
      resume: open,
    };
  }

  for (const scenario of [
    { name: "a hold the slow check read as reserved", stalledOnReleased: false, effect: false },
    { name: "an effect-pending replacement of a hold the slow check read as reserved", stalledOnReleased: false, effect: true },
    { name: "a hold the slow check read as already released", stalledOnReleased: true, effect: false },
  ]) {
    it(`does not release a replacement hold on the proof of an older one: ${scenario.name}`, async () => {
      const harness = await authority();
      await harness.reserve();
      harness.lapse();
      let stalled: Promise<unknown>;
      if (scenario.stalledOnReleased) {
        await expect(harness.wallet.reconcile(ITEM, absentClaim)).resolves.toBe("released");
        const reached = harness.pauseNextCheck();
        stalled = harness.wallet.reconcile(ITEM, absentClaim).then(() => "released", (error: unknown) => error);
        await reached;
      } else {
        const reached = harness.pauseNextCheck();
        stalled = harness.wallet.reconcile(ITEM, absentClaim).then(() => "released", (error: unknown) => error);
        await reached;
        await expect(harness.wallet.reconcile(ITEM, absentClaim)).resolves.toBe("released");
      }
      const replacement = await harness.reserve();
      if (scenario.effect) await replacement.beginEffect();
      harness.lapse();
      harness.resume();

      await expect(stalled).resolves.toMatchObject({
        message: "wallet spend recovery authentication failed",
      });
      expect(await harness.wallet.reserve(ITEM)).toMatchObject({
        status: "held", stage: scenario.effect ? "effect-pending" : "reserved",
      });
      expect((await harness.wallet.inspect()).activeEffects).toBe(1);
    });
  }

  it("refuses a check that starts after the hold was reserved again, on the replacement's own expiry", async () => {
    const harness = await authority();
    await harness.reserve();
    harness.lapse();
    await harness.wallet.reconcile(ITEM, absentClaim);
    await harness.reserve();
    harness.lapse();
    await expect(harness.wallet.reconcile(ITEM, absentClaim)).rejects.toThrow("recovery authentication failed");
    expect((await harness.wallet.inspect()).activeEffects).toBe(1);
  });

  it("two rails for one job phase and one payment settle exactly one hold and release neither", async () => {
    const chain = defaultChain(FINAL_TIME);
    payment(chain, { nonce: nonceOf(ITEM.jobId, ITEM.phaseIndex) });
    const harness = await authority(chain);
    const first = await harness.reserve();
    await first.beginEffect();
    await first.settle(settledClaim());

    const secondItem = otherRailHold(ITEM);
    const second = await harness.reserve(secondItem);
    await second.beginEffect();
    await expect(second.settle(settledClaim())).rejects.toThrow("wallet spend settlement authentication failed");
    harness.lapse();
    await expect(harness.wallet.reconcile(secondItem, settledClaim()))
      .rejects.toThrow("wallet spend recovery authentication failed");
    await expect(harness.wallet.reconcile(secondItem, absentClaim))
      .rejects.toThrow("wallet spend recovery authentication failed");

    expect(await harness.wallet.reconcile(ITEM, settledClaim())).toBe("existing");
    const view = await harness.wallet.inspect();
    expect(view.activeEffects).toBe(1);
    expect(view.assets[0]).toMatchObject({ cumulativeSettledDebit: TESTNET_AMOUNT });
  });

  it("two simultaneous checks of one hold release it once", async () => {
    const harness = await authority();
    await harness.reserve();
    harness.lapse();
    const results = await Promise.all([
      harness.wallet.reconcile(ITEM, absentClaim),
      harness.wallet.reconcile(ITEM, absentClaim),
    ]);
    expect([...results].sort()).toEqual(["existing", "released"]);
  });
});
