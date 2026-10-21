/**
 * A scripted Demos node behind `@kynesyslabs/demosdk/websdk`, so tests can run
 * the SDK's own rail (`createPayDemRail`): the only rail whose verdicts, fresh
 * or recovered, are final, because it reads the node's transaction record
 * itself (#338). A test file wires it with
 *
 *   vi.mock("@kynesyslabs/demosdk/websdk", async () =>
 *     (await import("../fixtures/demosNodeScript.js")).demosWebsdkMock);
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
  /** The payer's account nonce `getAddressNonce` reports: the last one it used. */
  accountNonce: 0,
  /** The `transaction_fee.network_fee` (OS) of a signed transfer, if any. */
  feeOs: undefined as string | undefined,
  /**
   * The `gas_operation.fees.network_fee` (OS) the confirmation reports, if
   * any: demosdk's authoritative debit view, which the signed record need not
   * carry (the record keeps `feeOs`).
   */
  confirmFeeOs: undefined as string | undefined,
  /** The record status a broadcast transfer ends with. */
  recordStatus: "confirmed",
  /**
   * The node's fork state, and the form transfers are signed in. Like demosdk
   * 4.0.16, a `Demos` instance's `getNetworkInfo` keeps the first state it
   * read; `nodeCall("getNetworkInfo")` reads it afresh.
   */
  postFork: true,
  /** Every uncached `nodeCall("getNetworkInfo")`, as the fork state it served. */
  networkInfoReads: [] as boolean[],
  /** `getTxByHash` replies by hash; a missing hash is not found (`null`). */
  records: new Map<string, unknown>(),
  /**
   * Replaces the `getTxByHash` reply for every hash when set; `rpc` is the
   * node the reading `Demos` instance connected to.
   */
  reply: undefined as ((hash: string, rpc: string | undefined) => unknown) | undefined,
  /** Awaited before each transfer is signed (a spy, or a gate). */
  onTransfer: undefined as (() => unknown) | undefined,
  transfers: 0,
  broadcasts: 0,
  reads: [] as string[],
  /** The node each `getTxByHash` read went to, in order. */
  readNodes: [] as (string | undefined)[],
  reset(): void {
    this.address = "ab".repeat(32);
    this.nextHash = "cd".repeat(32);
    this.nonce = 9;
    this.blockNumber = 42;
    this.accountNonce = 0;
    this.feeOs = undefined;
    this.confirmFeeOs = undefined;
    this.recordStatus = "confirmed";
    this.postFork = true;
    this.networkInfoReads = [];
    this.records = new Map();
    this.reply = undefined;
    this.onTransfer = undefined;
    this.transfers = 0;
    this.broadcasts = 0;
    this.reads = [];
    this.readNodes = [];
  },
};

/**
 * A native transfer record as the node serves it (nonce as a decimal string,
 * amount and fee components projected as numbers; see {@link servedContent}).
 */
export function nodeRecord(input: {
  txHash: string;
  payer: string;
  payee: string;
  amountOs: string;
  nonce?: number;
  blockNumber?: number;
  status?: string;
  feeOs?: string;
  /** How the transfer was signed: OS strings after the fork, DEM numbers before. */
  denomination?: "os" | "dem";
}): NodeRecord {
  return {
    hash: input.txHash,
    content: servedContent(
      transferContent(input.payer, input.payee, input.amountOs, input.nonce ?? 9, input.feeOs,
        input.denomination ?? "os"),
    ),
    status: input.status ?? "confirmed",
    blockNumber: input.blockNumber ?? 42,
  };
}

/**
 * A signed post-fork body as the pinned node's transaction query serves it
 * (kynesyslabs/node@61b8e75 `transaction.ts` `fromEntityToWireNumber`, and
 * node2's recorded `getTxByHash` envelopes): `amount` and each
 * `transaction_fee` component are OS numbers up to `Number.MAX_SAFE_INTEGER`
 * and decimal strings above it, and the nonce is a decimal string. The signed
 * payload in `data` keeps its decimal-string amount.
 */
function servedContent(content: NodeRecord): NodeRecord {
  const projected = (value: unknown) =>
    typeof value === "string" && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value;
  const fee = content.transaction_fee as Record<string, unknown> | undefined;
  return {
    ...content,
    amount: projected(content.amount),
    nonce: String(content.nonce),
    ...(fee === undefined ? {} : {
      transaction_fee: Object.fromEntries(
        Object.entries(fee).map(([name, value]) => [name, projected(value)]),
      ),
    }),
  };
}

/**
 * A signed native transfer body. demosdk 4.0.16 (`DemosTransactions.pay`) signs
 * the amount as a decimal-string OS amount after the denomination fork and as
 * a DEM number before it; the node stores either as signed.
 */
function transferContent(
  payer: string,
  payee: string,
  amountOs: string,
  nonce: number,
  feeOs: string | undefined,
  denomination: "os" | "dem",
): NodeRecord {
  const wire = (os: string): string | number => {
    if (denomination === "os") return os;
    if (BigInt(os) % 1_000_000_000n !== 0n) throw new Error(`pre-fork amount ${os} OS is not whole DEM`);
    return Number(BigInt(os) / 1_000_000_000n);
  };
  return {
    type: "native",
    from: payer,
    to: payee,
    amount: wire(amountOs),
    nonce,
    // demosdk signs the timestamp; reader-carrying clients bind it to this call.
    timestamp: String(Date.now()),
    data: ["native", { nativeOperation: "send", args: [payee, wire(amountOs)] }],
    ...(feeOs === undefined
      ? {}
      : { transaction_fee: { network_fee: wire(feeOs), rpc_fee: wire("0"), additional_fee: wire("0") } }),
  };
}

class MockDemos {
  readonly tx = {
    confirm: async (signed: { hash: string; content: NodeRecord }) => ({
      response: { data: {
        ...(demosNode.confirmFeeOs === undefined ? {} : { gas_operation: {
          fees: { network_fee: demosNode.confirmFeeOs, rpc_fee: "0", additional_fee: "0" },
        } }),
        transaction: { hash: signed.hash, content: { ...signed.content } },
      } },
    }),
  };

  private rpc: string | undefined;
  async connect(rpc?: string): Promise<void> {
    this.rpc = rpc;
  }
  async connectWallet(): Promise<void> {}
  getAddress(): string {
    return demosNode.address;
  }
  // demosdk 4.0.16 (`demosclass.js` getNetworkInfo) returns its first
  // successful reply for the life of the instance.
  private cachedNetworkInfo: unknown;
  async getNetworkInfo(): Promise<unknown> {
    this.cachedNetworkInfo ??= { forks: { osDenomination: { activated: demosNode.postFork } } };
    return this.cachedNetworkInfo;
  }
  async transfer(to: string, amountOs: bigint): Promise<unknown> {
    demosNode.transfers += 1;
    await demosNode.onTransfer?.();
    return {
      hash: demosNode.nextHash,
      content: transferContent(
        demosNode.address, to, amountOs.toString(), demosNode.nonce, demosNode.feeOs,
        demosNode.postFork ? "os" : "dem",
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
      content: servedContent(content),
      status: demosNode.recordStatus,
      blockNumber: demosNode.blockNumber,
    });
    return { result: 200, response: { hash } };
  }
  async nodeCall(message: string, args: { hash: string }): Promise<unknown> {
    if (message === "getNetworkInfo") {
      demosNode.networkInfoReads.push(demosNode.postFork);
      return { forks: { osDenomination: { activated: demosNode.postFork } } };
    }
    // `createPayDemRecordReader` reads it before a reader-carrying client's transfer.
    if (message === "getAddressNonce") return demosNode.accountNonce;
    if (message !== "getTransactionStatus") throw new Error(`unexpected nodeCall ${message}`);
    return demosNode.records.has(args.hash)
      ? { state: "included", blockNumber: demosNode.blockNumber }
      : { result: 404, response: null };
  }
  async getTxByHash(hash: string): Promise<unknown> {
    demosNode.reads.push(hash);
    demosNode.readNodes.push(this.rpc);
    if (demosNode.reply !== undefined) return demosNode.reply(hash, this.rpc);
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
