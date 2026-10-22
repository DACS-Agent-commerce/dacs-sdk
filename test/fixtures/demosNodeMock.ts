import { vi } from "vitest";

import { createPayDemRail, type PayDemRailConfig } from "../../src/rails/payDem.js";

/**
 * A mocked Demos node for tests that need `createPayDemRail`'s own settle: the
 * only rail whose success and failure the SDK reports as final, because it
 * reads and binds the node's transaction record itself (#338). A test file
 * installs the module mock with
 * `vi.mock("@kynesyslabs/demosdk/websdk", async () => (await import("../fixtures/demosNodeMock.js")).demosSdkModule())`
 * and calls {@link resetDemosNode} in `beforeEach`.
 */
export const demosNode = {
  broadcast: vi.fn(),
  confirm: vi.fn(),
  connect: vi.fn(),
  connectWallet: vi.fn(),
  getNetworkInfo: vi.fn(),
  getTxByHash: vi.fn(),
  nodeCall: vi.fn(),
  transfer: vi.fn(),
  waitForNonce: vi.fn(),
};

/**
 * What the node serves: the signer, the signed hash and nonce, the inclusion
 * block and the record status. Successive transfers sign `txHash`, then each of
 * `laterTxHashes`, at consecutive nonces from `nonce`.
 */
export interface DemosNodeScript {
  payer: string;
  txHash: string;
  laterTxHashes: readonly string[];
  nonce: number;
  blockNumber: number;
  recordStatus: "confirmed" | "failed" | "pending";
}

/** Change the status the node's record of a signed transfer carries from now on. */
export function setNodeRecordStatus(recordStatus: DemosNodeScript["recordStatus"]): void {
  script = { ...script, recordStatus };
}

let script: DemosNodeScript = {
  payer: "", txHash: "", laterTxHashes: [], nonce: 0, blockNumber: 0, recordStatus: "confirmed",
};
let signed: string[] = [];
let served = new Map<string, unknown>();

export function demosSdkModule() {
  return {
    Demos: class MockDemos {
      readonly tx = { confirm: demosNode.confirm };
      readonly broadcast = demosNode.broadcast;
      readonly connect = demosNode.connect;
      readonly connectWallet = demosNode.connectWallet;
      readonly getNetworkInfo = demosNode.getNetworkInfo;
      readonly getTxByHash = demosNode.getTxByHash;
      readonly transfer = demosNode.transfer;
      readonly waitForNonce = demosNode.waitForNonce;

      getAddress(): string {
        return `0x${script.payer}`;
      }

      // The node serves its fork state to `nodeCall("getNetworkInfo")` too
      // (uncached in demosdk); every other node call is `demosNode.nodeCall`.
      nodeCall(message: string, args: Record<string, unknown>): Promise<unknown> {
        return message === "getNetworkInfo" ? demosNode.getNetworkInfo() : demosNode.nodeCall(message, args);
      }
    },
  };
}

/** Reset the mocked node: it signs `txHash` at `nonce`, includes it at `blockNumber` and records it as `recordStatus`. */
export function resetDemosNode(over: Pick<DemosNodeScript, "payer" | "txHash"> & Partial<DemosNodeScript>): void {
  vi.stubGlobal("fetch", async (_input: unknown, init: RequestInit) => {
    const { message, data } = JSON.parse(init.body as string).params[0];
    const response = message === "getNetworkInfo" ? await demosNode.getNetworkInfo()
      : message === "getTxByHash" ? await demosNode.getTxByHash(data.hash)
      : await demosNode.nodeCall(message, data);
    return new Response(JSON.stringify({ result: 200, response }));
  });
  script = { laterTxHashes: [], nonce: 9, blockNumber: 42, recordStatus: "confirmed", ...over };
  signed = [];
  served = new Map();
  for (const method of Object.values(demosNode)) method.mockReset();
  demosNode.connect.mockResolvedValue(undefined);
  demosNode.connectWallet.mockResolvedValue(undefined);
  demosNode.getNetworkInfo.mockResolvedValue({ forks: { osDenomination: { activated: true } } });
  demosNode.transfer.mockImplementation(async (to: string, amountOs: bigint) => {
    const index = signed.length;
    const hash = index === 0 ? script.txHash : script.laterTxHashes[index - 1] ?? script.txHash;
    signed.push(hash);
    return {
      hash,
      content: {
        type: "native",
        from: `0x${script.payer}`,
        to,
        amount: amountOs.toString(),
        nonce: script.nonce + index,
        data: ["native", { nativeOperation: "send", args: [to, amountOs.toString()] }],
      },
    };
  });
  demosNode.confirm.mockImplementation(async (tx: { hash: string; content: object }) => ({
    response: { data: { transaction: { hash: tx.hash, content: { ...tx.content } } } },
  }));
  demosNode.broadcast.mockImplementation(async () => ({
    result: 200,
    response: { hash: signed.at(-1) ?? script.txHash },
  }));
  // The payer had used the nonce before the one `txHash` is signed at.
  demosNode.nodeCall.mockImplementation(async (message: string) =>
    message === "getAddressNonce" ? script.nonce - 1 : { state: "included", blockNumber: script.blockNumber });
  demosNode.getTxByHash.mockImplementation(async (hash: string) => {
    if (served.has(hash)) return served.get(hash);
    const call = [...demosNode.broadcast.mock.calls].reverse().find((args) =>
      (args[0] as { response: { data: { transaction: { hash: string } } } }).response.data.transaction.hash === hash);
    if (call === undefined) return null;
    const transaction = (call[0] as {
      response: { data: { transaction: { content: { nonce: number } } } };
    }).response.data.transaction;
    return {
      ...transaction,
      content: { ...transaction.content, nonce: String(transaction.content.nonce) },
      status: script.recordStatus,
      blockNumber: script.blockNumber,
    };
  });
  demosNode.waitForNonce.mockResolvedValue(undefined);
}

/** The SDK's own rail over the mocked node. */
export const sdkRail = (over: Partial<PayDemRailConfig> = {}) => createPayDemRail({
  rpc: "https://node.test",
  secret: "test-secret",
  inclusionPollIntervalMs: 1,
  statusRequestTimeoutMs: 50,
  transactionRecordTimeoutMs: 200,
  ...over,
});

/**
 * The SDK's own rail for a process that may only audit or reconcile. Only the
 * SDK rail reads the node's record, so only its bridge finishes a recovered
 * verdict (#338); a transfer it signs calls `submit`, which fails the test.
 */
export async function sdkAuditRail(over: Partial<PayDemRailConfig> = {}) {
  return { rail: await sdkRail(over), submit: forbidTransfers() };
}

/** From now on, a transfer signed over the mocked node calls the returned spy, which fails the test. */
export function forbidTransfers() {
  const submit = vi.fn((): never => { throw new Error("must never submit a retained transfer"); });
  const sign = demosNode.transfer.getMockImplementation()!;
  demosNode.transfer.mockImplementation((...args: unknown[]) => {
    submit();
    return sign(...args);
  });
  return submit;
}

/** Native transfers the SDK rail signed over the mocked node. */
export const sdkTransfers = () => demosNode.transfer.mock.calls.length;

/**
 * Serve the node's record for `txHash` as a native transfer from `payer` to
 * `payee`: for a hash no transfer over this mock signed, such as a retained
 * hash a restarted process audits.
 */
export function serveNodeRecord(txHash: string, over: {
  payer: string;
  payee: string;
  amountOs?: string;
  nonce?: number;
  blockNumber?: number;
  status?: "confirmed" | "failed" | "pending";
  feeOs?: string;
}): void {
  const amountOs = over.amountOs ?? "1000000000";
  served.set(txHash, {
    hash: txHash,
    content: {
      type: "native",
      from: `0x${over.payer}`,
      to: over.payee,
      amount: amountOs,
      nonce: String(over.nonce ?? script.nonce),
      data: ["native", { nativeOperation: "send", args: [over.payee, amountOs] }],
      ...(over.feeOs === undefined
        ? {}
        : { transaction_fee: { network_fee: over.feeOs, rpc_fee: "0", additional_fee: "0" } }),
    },
    status: over.status ?? script.recordStatus,
    blockNumber: over.blockNumber ?? script.blockNumber,
  });
}

/**
 * The SDK rail over a node that accepts the broadcast but never includes the
 * transaction: once `inclusionTimeoutMs` passes it returns the signed hash as
 * indeterminate, the way a rail whose answer was lost does.
 */
export const heldRail = (over: Partial<PayDemRailConfig> = {}) => {
  demosNode.nodeCall.mockResolvedValue({ state: "pending" });
  return sdkRail({ inclusionTimeoutMs: 1, ...over });
};
