import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { createPayDemExecutionAuthority } from "../../src/rails/payDemExecutionAuthority.js";
import { payDemSettle, payDemSettleCore } from "../../src/rails/payDem.js";

import type { SettleResult } from "../../src/agent/runSessionCore.js";
import {
  hasDefinitiveDemosFailure,
  type DemosFailedRecordProof,
} from "../../src/agent/settlementFailure.js";
import {
  demosAddressFromClaim,
  normalizeDemosNativeAddress,
} from "../../src/rails/demosAddress.js";

interface NodeRecord {
  content: {
    type: string;
    from: string;
    to: string;
    amount: number;
    nonce: string;
    data: [string, { nativeOperation: string; args: [string, string] }];
  };
  hash: string;
  status: string;
  blockNumber: number;
}

interface Fixture {
  source: {
    reportedVersion: string;
    reportedCommit: string;
    sourcePin: string;
    buildMetadataRead: string;
    versionEnvelope: { version: string; commit: string };
    networkInfoEnvelope: {
      response: {
        nodeVersion: {
          version: string; commit: string; branch: string; dirty: boolean; builtAt: string;
        };
      };
    };
  };
  getTxByHash: Record<string, { result: number; response: NodeRecord }>;
  getTransactionStatus: Record<
    string,
    { result: number; response: { state: string; blockNumber?: number } }
  >;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/demos-node2-records.json", import.meta.url),
  ).toString("utf8"),
) as Fixture;

const FAILED = "85b8fcdcee48822742a39e1b9877f5e2f8dde36430e8e486e3a8b0c9a7744cbd";
const CONFIRMED = "330dcf1dac0839ebc138d5e2a0db6db7b9567d769c8d4bd987b0d72d7d905918";
const NETWORK = "demos:testnet";
const AMOUNT = "9500000000";

type Result = Parameters<typeof hasDefinitiveDemosFailure>[0];

/** The explicit mapping a rail must apply from a node record to the proof. */
function proofFromFailedRecord(record: NodeRecord): DemosFailedRecordProof {
  const [kind, body] = record.content.data;
  if (record.status !== "failed" || record.content.type !== "native" ||
      kind !== "native" || body.nativeOperation !== "send") {
    throw new Error("not a failed native send record");
  }
  if (!/^(0|[1-9][0-9]*)$/.test(record.content.nonce)) {
    throw new Error("node nonce is not a canonical decimal string");
  }
  const payer = normalizeDemosNativeAddress(record.content.from);
  const payee = normalizeDemosNativeAddress(record.content.to);
  if (payer === null || payee === null) throw new Error("record keys are not Demos keys");
  return {
    kind: "demos-failed-record",
    txHash: record.hash,
    nonce: Number(record.content.nonce),
    blockNumber: record.blockNumber,
    payer,
    payee,
    amountOs: body.args[1],
  };
}

const failedRecord = fixture.getTxByHash[FAILED]!.response;
const PROOF = proofFromFailedRecord(failedRecord);

function failedResult(): Result & Record<string, unknown> {
  return {
    ok: false,
    errorClass: "permanent",
    failureProof: { ...PROOF },
    txHash: PROOF.txHash,
    chainId: NETWORK,
    payer: PROOF.payer,
    payee: PROOF.payee,
    blockNumber: PROOF.blockNumber,
    txRefKind: "demos",
  };
}

function check(
  patch: Record<string, unknown>,
  amountOs = AMOUNT,
  expectedNetwork = NETWORK,
): boolean {
  return hasDefinitiveDemosFailure(
    { ...failedResult(), ...patch } as Result,
    amountOs,
    expectedNetwork,
  );
}

function withProof(patch: Record<string, unknown>): Record<string, unknown> {
  return { failureProof: { ...PROOF, ...patch } };
}

describe("node2 failed-record fixture", () => {
  it("records one reported build identity and claims no source pin for a dirty build", () => {
    const { source } = fixture;
    const { nodeVersion } = source.networkInfoEnvelope.response;
    const commit = "61b8e75aa8db5e408c49e1c3a89db4d673f45578";
    expect(nodeVersion).toMatchObject({ commit, branch: "stabilisation", dirty: true });
    expect(source.versionEnvelope).toEqual({
      version: source.reportedVersion,
      commit: `<${nodeVersion.branch}>${commit}`,
    });
    expect(source.reportedCommit).toBe(`kynesyslabs/node ${nodeVersion.branch}@${commit}`);
    // A recapture from a clean build records its commit as the pin and updates
    // this test; while the build is dirty the fixture must say it has none.
    expect(source.sourcePin).toMatch(/^none: node2 reports a dirty build/);
    // The label dates the envelopes by the build that served them.
    expect(source.buildMetadataRead).toContain(`builtAt ${nodeVersion.builtAt}`);
  });

  it("records the encodings the proof is projected from", () => {
    const { content } = failedRecord;
    expect(failedRecord.status).toBe("failed");
    expect(failedRecord.hash).toBe(FAILED);
    // The node serves the nonce as a decimal string and keys with `0x`.
    expect(content.nonce).toBe("9");
    expect(content.from).toBe(`0x${PROOF.payer}`);
    expect(content.to).toBe(`0x${PROOF.payee}`);
    expect(content.data[1].args).toEqual([PROOF.payee, AMOUNT]);
    expect(String(content.amount)).toBe(AMOUNT);
    expect(PROOF).toEqual({
      kind: "demos-failed-record",
      txHash: FAILED,
      nonce: 9,
      blockNumber: 480877,
      payer: "c0a58599ceaeba18f9c450133631cce4c45f4dc7a59c8026331504da3a913c2a",
      payee: "706b89f5e2d56498a90bc3a209842b0bd0e22ce06bb4df7c27805e655614e5f1",
      amountOs: AMOUNT,
    });
  });

  it("shows inclusion is not execution: the failed hash reports included", () => {
    expect(fixture.getTransactionStatus[FAILED]!.response).toEqual({
      state: "included",
      blockNumber: failedRecord.blockNumber,
    });
    const confirmed = fixture.getTxByHash[CONFIRMED]!.response;
    expect(confirmed.status).toBe("confirmed");
    expect(fixture.getTransactionStatus[CONFIRMED]!.response).toEqual({
      state: "included",
      blockNumber: confirmed.blockNumber,
    });
    expect(() => proofFromFailedRecord(confirmed)).toThrow(/not a failed native send/);
  });

  it("resolves the record's keys through the native-address and claim helpers", () => {
    expect(normalizeDemosNativeAddress(failedRecord.content.from)).toBe(PROOF.payer);
    expect(demosAddressFromClaim(`did:demos:agent:${PROOF.payee}`)).toBe(PROOF.payee);
    expect(
      demosAddressFromClaim(`cci-xm:demos:testnet:0x${PROOF.payee.toUpperCase()}`),
    ).toBe(PROOF.payee);
  });
});

describe("hasDefinitiveDemosFailure", () => {
  it("accepts the node2 failed record bound to its amount and network", () => {
    expect(check({})).toBe(true);
  });

  it("requires the amount and network bindings", () => {
    // @ts-expect-error both bindings are required parameters
    expect(hasDefinitiveDemosFailure(failedResult())).toBe(false);
  });

  // Type-level only. Session result validation is covered by runSession.test.ts.
  it("carries a failure proof in the public result type", () => {
    const result: SettleResult = {
      ok: false,
      txHash: PROOF.txHash,
      chainId: NETWORK,
      payer: PROOF.payer,
      payee: PROOF.payee,
      failureProof: PROOF,
    };
    expect(result.ok).toBe(false);
  });

  it("accepts payer and payee given as 0x keys or Demos claims", () => {
    expect(check({ payer: `0x${PROOF.payer}`, payee: `0x${PROOF.payee}` })).toBe(true);
    expect(check({
      payer: `did:demos:agent:${PROOF.payer}`,
      payee: `cci-xm:demos:testnet:0x${PROOF.payee}`,
    })).toBe(true);
  });

  it("accepts a zero nonce and block", () => {
    expect(check({ blockNumber: 0, ...withProof({ nonce: 0, blockNumber: 0 }) })).toBe(true);
  });

  it("accepts a canonical non-ASCII network that equals the binding", () => {
    expect(check({ chainId: "demos:café" }, AMOUNT, "demos:café")).toBe(true);
  });

  it("refuses the node record's raw string nonce", () => {
    expect(check(withProof({ nonce: failedRecord.content.nonce }))).toBe(false);
  });

  it("refuses an amount or network other than the bound one", () => {
    expect(check({}, "9500000001")).toBe(false);
    expect(check({}, AMOUNT, "demos:mainnet")).toBe(false);
    expect(check({ chainId: "demos:mainnet" })).toBe(false);
  });

  it.each([
    ["ok result", { ok: true }],
    ["undefined ok", { ok: undefined }],
    ["null ok", { ok: null }],
    ["zero ok", { ok: 0 }],
    ["string ok", { ok: "false" }],
    ["missing errorClass", { errorClass: undefined }],
    ["transient errorClass", { errorClass: "transient" }],
    ["substrate errorClass", { errorClass: "substrate" }],
    ["non-string chainId", { chainId: 5 }],
    ["uppercase txHash", { txHash: FAILED.toUpperCase(), ...withProof({ txHash: FAILED.toUpperCase() }) }],
    ["0x txHash", { txHash: `0x${FAILED}`, ...withProof({ txHash: `0x${FAILED}` }) }],
    ["63-char txHash", { txHash: FAILED.slice(1), ...withProof({ txHash: FAILED.slice(1) }) }],
    ["65-char txHash", { txHash: `${FAILED}0`, ...withProof({ txHash: `${FAILED}0` }) }],
    ["non-Demos payer", { payer: `did:ethr:0x${PROOF.payer}` }],
    ["non-Demos payee", { payee: `cci-xm:evm:mainnet:0x${PROOF.payee}` }],
    ["unparseable payee", { payee: "nobody" }],
    ["unparseable payer with null proof payer", { payer: "nobody", ...withProof({ payer: null }) }],
    ["unparseable payee with null proof payee", { payee: "nobody", ...withProof({ payee: null }) }],
    ["undefined payer", { payer: undefined }],
    ["undefined payee", { payee: undefined }],
    ["numeric payer", { payer: 5 }],
    ["numeric payee", { payee: 5 }],
    ["padded payer", { payer: ` ${PROOF.payer}\n` }],
    ["padded payee", { payee: ` 0x${PROOF.payee}` }],
    ["unknown result key", { status: "failed" }],
    ["x402 txRefKind", { txRefKind: "x402" }],
    ["missing txRefKind", { txRefKind: undefined }],
    ["finality present", { finality: "bft-final" }],
    ["txRef present", { txRef: FAILED }],
    ["finalityObservedAt present", { finalityObservedAt: 1 }],
    ["x402Receipt present", { x402Receipt: {} }],
    ["missing proof", { failureProof: undefined }],
    ["null proof", { failureProof: null }],
    ["array proof", { failureProof: [] }],
    ["string proof", { failureProof: "demos-failed-record" }],
  ])("refuses a result with %s", (_name, patch) => {
    expect(check(patch)).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["space-padded", ` ${NETWORK}`],
    ["NFD", "demos:café"],
  ])("refuses a %s chainId even when the binding matches it", (_name, network) => {
    expect(check({ chainId: network }, AMOUNT, network)).toBe(false);
  });

  it.each([
    ["other kind", { kind: "demos-confirmed-record" }],
    ["other txHash", { txHash: CONFIRMED }],
    ["negative nonce", { nonce: -1 }],
    ["fractional nonce", { nonce: 1.5 }],
    ["unsafe nonce", { nonce: 2 ** 53 }],
    ["NaN nonce", { nonce: Number.NaN }],
    ["block mismatch", { blockNumber: 480878 }],
    ["string block", { blockNumber: "480877" }],
    ["swapped payer", { payer: PROOF.payee }],
    ["swapped payee", { payee: PROOF.payer }],
    ["0x payer", { payer: `0x${PROOF.payer}` }],
    ["uppercase payee", { payee: PROOF.payee.toUpperCase() }],
    ["zero amount", { amountOs: "0" }],
    ["leading-zero amount", { amountOs: `0${AMOUNT}` }],
    ["numeric amount", { amountOs: Number(AMOUNT) }],
    ["other amount", { amountOs: "9500000001" }],
    ["extra key", { status: "failed" }],
  ])("refuses a proof with %s", (_name, patch) => {
    expect(check(withProof(patch))).toBe(false);
  });

  it("refuses a negative or fractional block even when the result matches it", () => {
    expect(check({ blockNumber: -1, ...withProof({ blockNumber: -1 }) })).toBe(false);
    expect(check({ blockNumber: 1.5, ...withProof({ blockNumber: 1.5 }) })).toBe(false);
  });

  it("refuses a result without a blockNumber", () => {
    expect(check({ blockNumber: undefined })).toBe(false);
  });

  it("refuses the bound amount when it is not canonical", () => {
    expect(check(withProof({ amountOs: `0${AMOUNT}` }), `0${AMOUNT}`)).toBe(false);
    expect(check(withProof({ amountOs: "0" }), "0")).toBe(false);
    expect(check(withProof({ amountOs: `${AMOUNT}.5` }), `${AMOUNT}.5`)).toBe(false);
  });

  it("refuses a numeric amount even when an untyped caller binds the same number", () => {
    const amount = Number(AMOUNT) as unknown as string;
    expect(check(withProof({ amountOs: amount }), amount)).toBe(false);
  });

  it("refuses a String-object txHash even when the proof repeats the same object", () => {
    const txHash = new String(FAILED);
    expect(check({ txHash, ...withProof({ txHash }) })).toBe(false);
  });

  it.each([
    "ok", "txHash", "chainId", "payer", "payee", "errorClass", "failureProof",
    "blockNumber", "txRefKind",
  ])("refuses a result whose %s is inherited, not owned", (key) => {
    const own: Record<string, unknown> = failedResult();
    const inherited = own[key];
    delete own[key];
    const result = Object.assign(Object.create({ [key]: inherited }), own) as Result;
    expect(hasDefinitiveDemosFailure(result, AMOUNT, NETWORK)).toBe(false);
  });

  it("refuses a result without an ok key", () => {
    const result: Record<string, unknown> = failedResult();
    delete result.ok;
    expect(hasDefinitiveDemosFailure(result as Result, AMOUNT, NETWORK)).toBe(false);
  });

  it("refuses a result that is not a plain object, without throwing", () => {
    const fields = failedResult();
    const asArray = Object.assign([], fields);
    const asFunction = Object.assign(() => undefined, fields);
    for (const result of [null, undefined, "result", 5, asArray, asFunction]) {
      expect(hasDefinitiveDemosFailure(result as unknown as Result, AMOUNT, NETWORK)).toBe(false);
    }
  });

  it.each(Object.keys(PROOF))("refuses a proof missing %s", (key) => {
    const proof: Record<string, unknown> = { ...PROOF };
    delete proof[key];
    expect(check({ failureProof: proof })).toBe(false);
  });

  it("refuses a proof whose field is inherited, not owned", () => {
    const { amountOs, ...own } = PROOF;
    const proof = Object.assign(Object.create({ amountOs }), own, { extra: 1 });
    expect(check({ failureProof: proof })).toBe(false);
  });

  // The snapshot drops a plain object's prototype, so only a polluted
  // Object.prototype can still supply a missing key; the owned-key checks
  // must refuse it.
  it.each([
    ["result ok", "ok", false, (): Record<string, unknown> => {
      const result: Record<string, unknown> = failedResult();
      delete result.ok;
      return result;
    }],
    ["proof amountOs", "amountOs", AMOUNT, (): Record<string, unknown> => {
      const { amountOs: _amount, ...proof } = PROOF;
      return { ...failedResult(), failureProof: { ...proof, extra: 1 } };
    }],
  ])("refuses a %s that resolves only through Object.prototype", (_name, key, value, build) => {
    Object.defineProperty(Object.prototype, key, { value, configurable: true });
    try {
      expect(hasDefinitiveDemosFailure(build() as Result, AMOUNT, NETWORK)).toBe(false);
    } finally {
      delete (Object.prototype as Record<string, unknown>)[key];
    }
  });

  it.each([
    ["Date result", () => Object.assign(new Date(0), failedResult())],
    ["class-instance result", () => Object.assign(new (class Result {})(), failedResult())],
    ["Date proof", () => ({ ...failedResult(), failureProof: Object.assign(new Date(0), PROOF) })],
    ["class-instance proof", () => ({
      ...failedResult(), failureProof: Object.assign(new (class Proof {})(), PROOF),
    })],
    ["throwing accessor in the result", () => Object.defineProperty(failedResult(), "payer", {
      get() { throw new Error("accessor ran"); }, enumerable: true,
    })],
    ["result accessor returning the bound payer", () => Object.defineProperty(failedResult(), "payer", {
      get: () => PROOF.payer, enumerable: true,
    })],
    ["throwing accessor in the proof", () => ({
      ...failedResult(),
      failureProof: Object.defineProperty({ ...PROOF }, "nonce", {
        get() { throw new Error("accessor ran"); }, enumerable: true,
      }),
    })],
    ["pass-through proxy result", () => new Proxy(failedResult(), {})],
    ["proxy result whose ownKeys throws", () => new Proxy(failedResult(), {
      ownKeys() { throw new Error("trap ran"); },
    })],
    ["pass-through proxy proof", () => ({ ...failedResult(), failureProof: new Proxy({ ...PROOF }, {}) })],
    ["proxy proof whose ownKeys throws", () => ({
      ...failedResult(),
      failureProof: new Proxy({ ...PROOF }, { ownKeys() { throw new Error("trap ran"); } }),
    })],
    ["revoked proxy result", () => {
      const { proxy, revoke } = Proxy.revocable(failedResult(), {});
      revoke();
      return proxy;
    }],
    ["revoked proxy proof", () => {
      const { proxy, revoke } = Proxy.revocable({ ...PROOF }, {});
      revoke();
      return { ...failedResult(), failureProof: proxy };
    }],
    ["symbol key in the result", () => ({ ...failedResult(), [Symbol("extra")]: 1 })],
    ["symbol key in the proof", () => ({
      ...failedResult(), failureProof: { ...PROOF, [Symbol("extra")]: 1 },
    })],
    ["non-enumerable extra key in the result", () => Object.defineProperty(failedResult(), "extra", {
      value: 1,
    })],
    ["non-enumerable extra key in the proof", () => ({
      ...failedResult(),
      failureProof: Object.defineProperty({ ...PROOF }, "extra", { value: 1 }),
    })],
    ["non-enumerable finality", () => Object.defineProperty(failedResult(), "finality", {
      value: "bft-final",
    })],
  ])("refuses a %s without throwing", (_name, build) => {
    expect(hasDefinitiveDemosFailure(build() as unknown as Result, AMOUNT, NETWORK)).toBe(false);
  });

  it("accepts a deeply frozen or null-prototype result, as a rail may return", () => {
    const frozen = failedResult();
    Object.freeze(frozen.failureProof);
    expect(hasDefinitiveDemosFailure(Object.freeze(frozen), AMOUNT, NETWORK)).toBe(true);
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, failedResult(), {
      failureProof: Object.assign(Object.create(null) as Record<string, unknown>, PROOF),
    });
    expect(hasDefinitiveDemosFailure(bare as Result, AMOUNT, NETWORK)).toBe(true);
  });
});

describe("hasDefinitiveDemosFailure contract limits", () => {
  // Shape and bindings remain insufficient authority for a native effect.
  it("accepts an invented, self-consistent shape without authenticating it", () => {
    const invented = { ...PROOF, txHash: "ab".repeat(32), nonce: 1, blockNumber: 2 };
    expect(check({ txHash: invented.txHash, blockNumber: 2, failureProof: invented })).toBe(true);
  });

  it.each([true, false])("refuses a custom client before transfer (ok=%s)", async (ok) => {
    const transfer = vi.fn(async () => ({ ok, hash: PROOF.txHash,
      state: ok ? "included" : "failed", execution: "executed" as const,
      blockNumber: PROOF.blockNumber, failureProof: PROOF }));
    await expect(payDemSettleCore({ recipient: PROOF.payee, amount: AMOUNT },
      { address: PROOF.payer, transfer })).rejects.toThrow(/SDK.*record-verifying/);
    expect(transfer).not.toHaveBeenCalled();
  });

  it("refuses a verdict issued by a separate authority", async () => {
    const authority = createPayDemExecutionAuthority();
    const transfer = vi.fn(async () => authority.attest({ ok: false,
      hash: PROOF.txHash, state: "failed", failureProof: PROOF,
      blockNumber: PROOF.blockNumber }));
    const client = authority.register({ address: PROOF.payer, transfer });
    await expect(payDemSettleCore({ recipient: PROOF.payee, amount: AMOUNT }, client))
      .rejects.toThrow(/SDK.*record-verifying/);
    expect(transfer).not.toHaveBeenCalled();
  });

  it.each([true, false])("refuses a custom rail before a settlement claim (ok=%s)", async (ok) => {
    const settle = vi.fn(async () => ok
      ? { ok: true as const, execution: "executed" as const, txHash: PROOF.txHash,
          chainId: NETWORK, payer: PROOF.payer, payee: PROOF.payee }
      : { ok: false as const, txHash: PROOF.txHash, chainId: NETWORK,
          payer: PROOF.payer, payee: PROOF.payee, errorClass: "permanent" as const,
          failureProof: PROOF, blockNumber: PROOF.blockNumber, txRefKind: "demos" as const });
    const once = vi.fn(async () => ({ ok: false, txHash: PROOF.txHash,
      chainId: NETWORK, payer: PROOF.payer, payee: PROOF.payee }));
    const execute = payDemSettle({ address: PROOF.payer, settle },
      { network: NETWORK }, { store: { once } });
    await expect(execute({ rail: "pay-dem", phase: "pay-dem", amount: "1",
      asset: "DEM", payee: `did:demos:agent:${PROOF.payee}`,
      expectedPayee: PROOF.payee, jobId: "private-verdict", phaseIndex: 0,
    })).rejects.toThrow(/SDK.*record-verifying/);
    expect(once).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
});
