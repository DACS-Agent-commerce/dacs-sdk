import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { D402Client } from "@kynesyslabs/demosdk/d402/client";
import { Demos } from "@kynesyslabs/demosdk/websdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPayD402Rail,
  type D402PaymentRequirement,
} from "../../src/rails/payD402.js";
import { createPayDemRail } from "../../src/rails/payDem.js";

const SECRET = new Demos().newMnemonic();
const PAYEE_HEX = "cd".repeat(32);
const RECIPIENT = `0x${PAYEE_HEX}`;
const servers: Server[] = [];

function confirmation(transaction: { hash: string; content: Record<string, unknown> }) {
  const { content } = transaction;
  // A D402 payment carries its amount in the signed payload, not in `amount`.
  const payload = Array.isArray(content.data) ? (content.data[1] as { amount?: string } | undefined) : undefined;
  const amount = payload?.amount ?? content.amount;
  return {
    data: {
      valid: true,
      transaction: {
        hash: transaction.hash,
        content: {
          ...content,
          transaction_fee: {
            network_fee: "400000000",
            rpc_fee: "500000000",
            additional_fee: "100000000",
          },
          gcr_edits: [
            { type: "balance", operation: "remove", isRollback: false, account: content.from, txhash: "", amount },
            { type: "balance", operation: "add", isRollback: false, account: content.to, txhash: "", amount },
            { type: "balance", operation: "remove", isRollback: false, account: content.from, txhash: "", amount: "1000000000" },
          ],
        },
      },
    },
  };
}

/**
 * A Demos node on loopback. Each POST is keyed by its RPC method and the
 * `execute` extra or `nodeCall` message; the first answers for a key are 502
 * as many times as `failures` says, later ones succeed. The hash lookup
 * returns the broadcast transaction as confirmed only when `recordsTransfers`
 * is set, and returns nothing otherwise.
 */
async function startNode(failures: Record<string, number>, recordsTransfers = false) {
  const keys: string[] = [];
  const txByHashRequests: string[] = [];
  let broadcast: { hash: string; content: Record<string, unknown> } | undefined;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method !== "POST") {
        res.writeHead(200).end("ok");
        return;
      }
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        method: string;
        params: Array<{ message: string; data: any; extra: string }>;
      };
      const content = request.params[0]!;
      const key = request.method === "execute"
        ? `execute:${content.extra}`
        : `${request.method}:${content.message}`;
      const index = keys.filter((seen) => seen === key).length;
      keys.push(key);
      if (key === "nodeCall:getTxByHash") {
        txByHashRequests.push(content.data.hash);
      }
      if (key === "execute:broadcastTx") {
        // The node has the transaction even when its answer to the buyer is a 502.
        broadcast = content.data?.response?.data?.transaction;
      }
      if (index < (failures[key] ?? 0)) {
        res.writeHead(502).end();
        return;
      }
      const replies: Record<string, () => unknown> = {
        "execute:confirmTx": () => confirmation(content.data),
        "nodeCall:getNetworkInfo": () => ({ forks: { osDenomination: { activated: true } } }),
        "nodeCall:getAddressNonce": () => 0,
        "nodeCall:getTransactionStatus": () => ({ state: "pending" }),
        "nodeCall:broadcastNativeTransaction": () => ({ success: true, blockNumber: 7 }),
        "nodeCall:getTxByHash": () =>
          recordsTransfers && broadcast ? { ...broadcast, blockNumber: 7, status: "confirmed" } : null,
      };
      const response = replies[key]?.() ?? {};
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: 200, response }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  servers.push(server);
  return {
    url: `http://127.0.0.1:${port}`,
    count: (key: string) => keys.filter((seen) => seen === key).length,
    txByHashRequests,
    broadcastHash: () => broadcast?.hash,
  };
}

beforeEach(() => {
  // demosdk logs each failed post; the counts below are what matters.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((server) =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })),
  );
});

/** One 1000-unit payment through the real pay-d402 rail against `node`. */
async function settleThroughD402Rail(node: { url: string }) {
  // demosdk waits up to a minute for inclusion after a broadcast; the rail
  // keeps that default, so shorten it here.
  const settle = D402Client.prototype.settle;
  vi.spyOn(D402Client.prototype, "settle").mockImplementation(
    async function (this: D402Client, payment, options) {
      return settle.call(this, payment, { ...options, timeoutMs: 300, pollIntervalMs: 20 });
    },
  );
  // demosdk's D402 payment leaves `to` empty, which its own signer refuses;
  // set it so the payment reaches the broadcast.
  const createPayment = D402Client.prototype.createPayment;
  vi.spyOn(D402Client.prototype, "createPayment").mockImplementation(
    async function (
      this: D402Client,
      requirement: D402PaymentRequirement,
      options?: { nonce?: number },
    ) {
      const payment = await createPayment.call(this, requirement, options);
      payment.content.to = requirement.recipient;
      return payment;
    },
  );
  const rail = await createPayD402Rail({
    rpc: node.url,
    secret: SECRET,
    acknowledgeExperimental: true,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ recipient: RECIPIENT, amount: "1000", resourceId: "res-1" }),
        { status: 402 },
      ),
  });
  const result = await rail.settle({
    paywallUrl: "http://127.0.0.1/paywalled",
    recipient: RECIPIENT,
    amount: "1000",
    network: "demos",
  });
  return { rail, result };
}

describe("Demos payment rails send a transfer once", () => {
  it("pay-dem broadcasts once when the node answers 502 and reports no inclusion", async () => {
    const node = await startNode({ "execute:broadcastTx": 1 });
    const rail = await createPayDemRail({
      rpc: node.url,
      secret: SECRET,
      inclusionTimeoutMs: 1_000,
      inclusionPollIntervalMs: 20,
      statusRequestTimeoutMs: 200,
    });

    const result = await rail.settle({ recipient: RECIPIENT, amount: "9500000000" });

    expect(node.count("execute:confirmTx")).toBe(1);
    expect(node.count("execute:broadcastTx")).toBe(1);
    expect(result).toEqual({
      ok: false,
      txHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      chainId: "demos",
      payer: rail.address,
      payee: PAYEE_HEX,
    });
  });

  it("pay-d402 broadcasts once when the node answers 502 and reports not ok", async () => {
    const node = await startNode({ "execute:broadcastTx": 1 });

    const { rail, result } = await settleThroughD402Rail(node);

    expect(node.count("execute:confirmTx")).toBe(1);
    expect(node.count("execute:broadcastTx")).toBe(1);
    expect(result).toEqual({
      ok: false,
      txHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      chainId: "demos",
      payer: rail.address,
      payee: RECIPIENT,
      pending: true,
    });
  });

  it("pay-d402 broadcasts once when the node answers 502 and the node's record then shows the transfer", async () => {
    const node = await startNode({ "execute:broadcastTx": 1 }, true);

    const { rail, result } = await settleThroughD402Rail(node);

    expect(node.count("execute:confirmTx")).toBe(1);
    expect(node.count("execute:broadcastTx")).toBe(1);
    expect(node.count("nodeCall:getTxByHash")).toBeGreaterThanOrEqual(1);
    expect(result.txHash).toBe(node.broadcastHash());
    for (const hash of node.txByHashRequests) {
      expect(hash).toBe(result.txHash);
    }
    expect(result).toEqual({
      ok: true,
      txHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      chainId: "demos",
      payer: rail.address,
      payee: RECIPIENT,
    });
  });

  it("pay-d402 reports ok when the node's record shows the transfer", async () => {
    const node = await startNode({}, true);

    const { rail, result } = await settleThroughD402Rail(node);

    expect(node.count("execute:broadcastTx")).toBe(1);
    expect(node.count("nodeCall:getTxByHash")).toBeGreaterThanOrEqual(1);
    expect(result.txHash).toBe(node.broadcastHash());
    for (const hash of node.txByHashRequests) {
      expect(hash).toBe(result.txHash);
    }
    expect(result).toEqual({
      ok: true,
      txHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      chainId: "demos",
      payer: rail.address,
      payee: RECIPIENT,
    });
  });

  it("pay-d402 is not ok when the node acknowledges the broadcast but records no transfer", async () => {
    const node = await startNode({});

    const { result } = await settleThroughD402Rail(node);

    expect(node.count("execute:broadcastTx")).toBe(1);
    expect(node.count("nodeCall:getTxByHash")).toBeGreaterThanOrEqual(1);
    expect(result.txHash).toBe(node.broadcastHash());
    for (const hash of node.txByHashRequests) {
      expect(hash).toBe(result.txHash);
    }
    expect(result.ok).toBe(false);
    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
