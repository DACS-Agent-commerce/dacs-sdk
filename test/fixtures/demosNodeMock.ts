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
  recordStatus: "confirmed" | "failed";
}

let script: DemosNodeScript = {
  payer: "", txHash: "", laterTxHashes: [], nonce: 0, blockNumber: 0, recordStatus: "confirmed",
};
let signed: string[] = [];

export function demosSdkModule() {
  return {
    Demos: class MockDemos {
      readonly tx = { confirm: demosNode.confirm };
      readonly broadcast = demosNode.broadcast;
      readonly connect = demosNode.connect;
      readonly connectWallet = demosNode.connectWallet;
      readonly getNetworkInfo = demosNode.getNetworkInfo;
      readonly getTxByHash = demosNode.getTxByHash;
      readonly nodeCall = demosNode.nodeCall;
      readonly transfer = demosNode.transfer;
      readonly waitForNonce = demosNode.waitForNonce;

      getAddress(): string {
        return `0x${script.payer}`;
      }
    },
  };
}

/** Reset the mocked node: it signs `txHash` at `nonce`, includes it at `blockNumber` and records it as `recordStatus`. */
export function resetDemosNode(over: Pick<DemosNodeScript, "payer" | "txHash"> & Partial<DemosNodeScript>): void {
  script = { laterTxHashes: [], nonce: 9, blockNumber: 42, recordStatus: "confirmed", ...over };
  signed = [];
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
  demosNode.getTxByHash.mockImplementation(async () => {
    const transaction = (demosNode.broadcast.mock.calls.at(-1)?.[0] as {
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

/** Native transfers the SDK rail signed over the mocked node. */
export const sdkTransfers = () => demosNode.transfer.mock.calls.length;

/**
 * The SDK rail over a node that accepts the broadcast but never includes the
 * transaction: once `inclusionTimeoutMs` passes it returns the signed hash as
 * indeterminate, the way a rail whose answer was lost does.
 */
export const heldRail = (over: Partial<PayDemRailConfig> = {}) => {
  demosNode.nodeCall.mockResolvedValue({ state: "pending" });
  return sdkRail({ inclusionTimeoutMs: 1, ...over });
};
