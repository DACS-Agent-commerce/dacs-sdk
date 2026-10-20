/**
 * A scripted Demos node behind `@kynesyslabs/demosdk/websdk`, so tests can run
 * the SDK's own rail (`createPayDemRail`): the only rail whose verdicts, fresh
 * or recovered, are final, because it reads the node's transaction record
 * itself (#338). A test file wires it with
 *
 *   vi.mock("@kynesyslabs/demosdk/websdk", async () =>
 *     (await import("../fixtures/demosNodeMock.js")).demosWebsdkMock);
 *
 * and scripts the wallet, the next signed transfer and the records the node
 * serves through `demosNode`.
 */
import { createPayDemRail, type PayDemRail } from "../../src/rails/payDem.js";

type NodeRecord = Record<string, unknown>;

export const demosNode = {
  /** The wallet `getAddress` reports: the payer of every transfer. */
  address: "ab".repeat(32),
  /** The hash, nonce and block the next signed transfer gets. */
  nextHash: "cd".repeat(32),
  nonce: 9,
  blockNumber: 42,
  /** The `transaction_fee.network_fee` (OS) of a signed transfer, if any. */
  feeOs: undefined as string | undefined,
  /** The record status a broadcast transfer ends with. */
  recordStatus: "confirmed",
  postFork: true,
  /** `getTxByHash` replies by hash; a missing hash is not found (`null`). */
  records: new Map<string, unknown>(),
  /** Replaces the `getTxByHash` reply for every hash when set. */
  reply: undefined as ((hash: string) => unknown) | undefined,
  /** Awaited before each transfer is signed (a spy, or a gate). */
  onTransfer: undefined as (() => unknown) | undefined,
  transfers: 0,
  broadcasts: 0,
  reads: [] as string[],
  reset(): void {
    this.address = "ab".repeat(32);
    this.nextHash = "cd".repeat(32);
    this.nonce = 9;
    this.blockNumber = 42;
    this.feeOs = undefined;
    this.recordStatus = "confirmed";
    this.postFork = true;
    this.records = new Map();
    this.reply = undefined;
    this.onTransfer = undefined;
    this.transfers = 0;
    this.broadcasts = 0;
    this.reads = [];
  },
};

/** A native transfer body as the node serves it (nonce as a decimal string). */
export function nodeRecord(input: {
  txHash: string;
  payer: string;
  payee: string;
  amountOs: string;
  nonce?: number;
  blockNumber?: number;
  status?: string;
  feeOs?: string;
}): NodeRecord {
  return {
    hash: input.txHash,
    content: {
      ...transferContent(input.payer, input.payee, input.amountOs, input.nonce ?? 9, input.feeOs),
      nonce: String(input.nonce ?? 9),
    },
    status: input.status ?? "confirmed",
    blockNumber: input.blockNumber ?? 42,
  };
}

function transferContent(
  payer: string,
  payee: string,
  amountOs: string,
  nonce: number,
  feeOs: string | undefined,
): NodeRecord {
  return {
    type: "native",
    from: payer,
    to: payee,
    amount: amountOs,
    nonce,
    data: ["native", { nativeOperation: "send", args: [payee, amountOs] }],
    ...(feeOs === undefined
      ? {}
      : { transaction_fee: { network_fee: feeOs, rpc_fee: "0", additional_fee: "0" } }),
  };
}

class MockDemos {
  readonly tx = {
    confirm: async (signed: { hash: string; content: NodeRecord }) => ({
      response: { data: { transaction: { hash: signed.hash, content: { ...signed.content } } } },
    }),
  };

  async connect(): Promise<void> {}
  async connectWallet(): Promise<void> {}
  getAddress(): string {
    return demosNode.address;
  }
  async getNetworkInfo(): Promise<unknown> {
    return { forks: { osDenomination: { activated: demosNode.postFork } } };
  }
  async transfer(to: string, amountOs: bigint): Promise<unknown> {
    demosNode.transfers += 1;
    await demosNode.onTransfer?.();
    return {
      hash: demosNode.nextHash,
      content: transferContent(
        demosNode.address, to, amountOs.toString(), demosNode.nonce, demosNode.feeOs,
      ),
    };
  }
  async broadcast(validity: {
    response: { data: { transaction: { hash: string; content: NodeRecord } } };
  }): Promise<unknown> {
    demosNode.broadcasts += 1;
    const { hash, content } = validity.response.data.transaction;
    demosNode.records.set(hash, {
      hash,
      content: { ...content, nonce: String(content.nonce) },
      status: demosNode.recordStatus,
      blockNumber: demosNode.blockNumber,
    });
    return { result: 200, response: { hash } };
  }
  async nodeCall(message: string, args: { hash: string }): Promise<unknown> {
    if (message !== "getTransactionStatus") throw new Error(`unexpected nodeCall ${message}`);
    return demosNode.records.has(args.hash)
      ? { state: "included", blockNumber: demosNode.blockNumber }
      : { result: 404, response: null };
  }
  async getTxByHash(hash: string): Promise<unknown> {
    demosNode.reads.push(hash);
    if (demosNode.reply !== undefined) return demosNode.reply(hash);
    return demosNode.records.get(hash) ?? null;
  }
  async waitForNonce(): Promise<void> {}
}

export const demosWebsdkMock = { Demos: MockDemos };

/** The SDK's own rail over the scripted node, with test-sized timeouts. */
export function sdkPayDemRail(
  network?: string,
  config: Partial<Parameters<typeof createPayDemRail>[0]> = {},
): Promise<PayDemRail> {
  return createPayDemRail({
    rpc: "https://node.test",
    secret: "test-wallet",
    ...(network === undefined ? {} : { network }),
    inclusionTimeoutMs: 500,
    inclusionPollIntervalMs: 1,
    statusRequestTimeoutMs: 50,
    transactionRecordTimeoutMs: 200,
    nonceVisibilityTimeoutMs: 10,
    ...config,
  });
}
