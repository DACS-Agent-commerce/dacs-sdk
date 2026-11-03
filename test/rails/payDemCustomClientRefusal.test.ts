import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DemosNativeClient,
  PayDemPreparedTransfer,
} from "../../src/rails/payDem.js";

// #338: a node record shows that a transfer with these terms executed, not that
// this call made it after its journal and fence, nor at what fee. Only the
// client createPayDemRail builds signs, journals, fences and broadcasts the
// transfer itself, so payDemSettleCore refuses every other client before its
// transfer runs. These are the three ways a custom client that signed and
// broadcast by itself could still mint a final success while the rails module
// exported a record reader for it to carry: each test hands the client
// whatever reader the module offers, so it fails against such a module.

const PAYER_HEX = "ab".repeat(32);
const WALLET = `0x${PAYER_HEX}`;
const PAYEE_HEX = "cd".repeat(32);
const RECIPIENT = `0x${PAYEE_HEX}`;
const NONCE = 9;
const BLOCK = 480_877;
const AMOUNT_OS = "9500000000";
const FAST = {
  inclusionTimeoutMs: 40,
  inclusionPollIntervalMs: 1,
  statusRequestTimeoutMs: 5,
  transactionRecordTimeoutMs: 30,
};

let txHash = "";
let transfers = 0;
/** The record's signed `content.timestamp`; 0 means the time of the read. */
let signedAtMs = 0;

const sdk = vi.hoisted(() => ({
  connect: vi.fn(),
  getNetworkInfo: vi.fn(),
  getTxByHash: vi.fn(),
  nodeCall: vi.fn(),
}));

vi.mock("@kynesyslabs/demosdk/websdk", () => ({
  Demos: class MockDemos {
    readonly connect = sdk.connect;
    readonly getNetworkInfo = sdk.getNetworkInfo;
    readonly getTxByHash = sdk.getTxByHash;
    readonly nodeCall = sdk.nodeCall;
  },
}));

/** A node that has executed the client's transfer, at a 1 DEM fee. */
beforeEach(() => {
  vi.clearAllMocks();
  transfers += 1;
  txHash = `${String(transfers).padStart(4, "0")}${"85".repeat(30)}`;
  signedAtMs = 0;
  sdk.connect.mockResolvedValue(true);
  sdk.getNetworkInfo.mockResolvedValue({ forks: { osDenomination: { activated: true } } });
  sdk.nodeCall.mockImplementation(async (message: string) =>
    message === "getAddressNonce" ? NONCE - 1 : { state: "included", blockNumber: BLOCK });
  sdk.getTxByHash.mockImplementation(async () => ({
    hash: txHash,
    status: "confirmed",
    blockNumber: BLOCK,
    content: {
      type: "native",
      from: PAYER_HEX,
      from_ed25519_address: PAYER_HEX,
      to: PAYEE_HEX,
      amount: Number(AMOUNT_OS),
      nonce: String(NONCE),
      timestamp: String(signedAtMs || Date.now()),
      transaction_fee: { network_fee: 400000000, rpc_fee: 500000000, additional_fee: 100000000 },
      data: ["native", { nativeOperation: "send", args: [PAYEE_HEX, AMOUNT_OS] }],
    },
  }));
});

type PayDemModule = typeof import("../../src/rails/payDem.js");

/** The record reader the module offers a custom client, or a look-alike. */
async function offeredReader(payDem: PayDemModule): Promise<unknown> {
  const factory = (payDem as unknown as Record<string, unknown>).createPayDemRecordReader;
  return typeof factory === "function"
    ? (factory as (config: object) => Promise<unknown>)({ rpc: "https://node.test", ...FAST })
    : Object.freeze({ rpc: "https://node.test" });
}

const prepared = (over: Partial<PayDemPreparedTransfer> = {}) => ({
  txHash,
  nonce: NONCE,
  payer: PAYER_HEX,
  payee: PAYEE_HEX,
  amountOs: AMOUNT_OS,
  denomination: "os",
  network: "demos",
  ...over,
}) as PayDemPreparedTransfer;

type TransferArgs = Parameters<DemosNativeClient["transfer"]>[0];

/** A custom client that signs and broadcasts itself (`broadcast` records it). */
async function customClient(
  payDem: PayDemModule,
  transfer: (args: TransferArgs, broadcast: () => void) => Promise<void>,
) {
  const effects: string[] = [];
  const client = {
    address: WALLET,
    recordReader: await offeredReader(payDem),
    transfer: vi.fn(async (args: TransferArgs) => {
      await transfer(args, () => effects.push("broadcast"));
      return { ok: true, hash: txHash, nonce: NONCE };
    }),
  } as unknown as DemosNativeClient & { transfer: ReturnType<typeof vi.fn> };
  return { client, effects };
}

async function expectRefusedBeforeTransfer(
  settlement: Promise<unknown>,
  client: { transfer: ReturnType<typeof vi.fn> },
  effects: string[],
) {
  await expect(settlement).rejects.toThrow(
    /not the one createPayDemRail built.*refusing transfer/,
  );
  expect(client.transfer).not.toHaveBeenCalled();
  expect(effects).toEqual([]);
  // The SDK read nothing from the node either: nothing it could read would
  // make this client's transfer the call's own.
  expect(sdk.nodeCall).not.toHaveBeenCalled();
  expect(sdk.getTxByHash).not.toHaveBeenCalled();
}

describe("payDemSettleCore refuses a custom client that signs and broadcasts itself (#338)", () => {
  it("before a transfer whose journaled debit understates the executed record's fee under the ceiling", async () => {
    const payDem = await import("../../src/rails/payDem.js");
    const { client, effects } = await customClient(payDem, async (args, broadcast) => {
      // The record pays 1 DEM in fees; the client journals none, which an
      // equal ceiling would otherwise accept as the whole debit.
      await args.journalPreparedTransfer?.(prepared({ confirmedTotalDebitOs: AMOUNT_OS }));
      broadcast();
    });

    await expectRefusedBeforeTransfer(
      payDem.payDemSettleCore(
        { recipient: RECIPIENT, amount: AMOUNT_OS, maxTotalDebitOs: AMOUNT_OS },
        client,
      ),
      client,
      effects,
    );
  });

  it("before replaying, after a restart, an earlier transfer signed with a clock ahead of the SDK's", async () => {
    // The transfer executed before this call, but its signer's clock ran a
    // minute ahead, and the payer's account nonce still lags it.
    signedAtMs = Date.now() + 60_000;
    vi.resetModules();
    const payDem = await import("../../src/rails/payDem.js");
    const { client, effects } = await customClient(payDem, async (args) => {
      // No new signing or broadcast: the old transfer's hash is handed back.
      await args.journalPreparedTransfer?.(prepared());
    });

    await expectRefusedBeforeTransfer(
      payDem.payDemSettleCore({ recipient: RECIPIENT, amount: AMOUNT_OS }, client),
      client,
      effects,
    );
  });

  it("before a transfer that would broadcast ahead of its journal and its fence", async () => {
    const payDem = await import("../../src/rails/payDem.js");
    const order: string[] = [];
    const { client, effects } = await customClient(payDem, async (args, broadcast) => {
      broadcast();
      await args.journalPreparedTransfer?.(prepared());
      await args.assertCurrentBeforeBroadcast?.();
    });

    await expectRefusedBeforeTransfer(
      payDem.payDemSettleCore({
        recipient: RECIPIENT,
        amount: AMOUNT_OS,
        journalPreparedTransfer: async () => {
          order.push("journal");
        },
        assertCurrentBeforeBroadcast: async () => {
          order.push("fence");
        },
      }, client),
      client,
      effects,
    );
    expect(order).toEqual([]);
  });

  it("offers no record reader or client rail a custom client could carry", async () => {
    const surfaces = await Promise.all([
      import("../../src/rails/payDem.js"),
      import("../../src/rails/index.js"),
      import("../../src/index.js"),
    ]);
    for (const surface of surfaces) {
      expect(Object.keys(surface)).not.toContain("createPayDemRecordReader");
      expect(Object.keys(surface)).not.toContain("createPayDemClientRail");
    }
  });
});
