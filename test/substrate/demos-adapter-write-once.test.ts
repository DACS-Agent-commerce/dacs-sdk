import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnchorWaitError,
  DemosAdapter,
  createInMemoryDemosWriteJournal,
  type DemosWriteJournal,
  type DemosWriteJournalRecord,
} from "../../src/substrate/index.js";

const WALLET = `0x${"ab".repeat(32)}`;
const servers: Server[] = [];

type Failure = 502 | "reset";

interface NodePost {
  key: string;
  body: string;
}

/**
 * A Demos node on loopback. Each POST is keyed by its RPC method and the
 * `execute` extra or `nodeCall` message; the first answers for a key follow
 * `failures`, later ones succeed.
 */
async function startNode(failures: Record<string, Failure[]>) {
  const posts: NodePost[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method !== "POST") {
        res.writeHead(200).end("ok");
        return;
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const request = JSON.parse(body) as {
        method: string;
        params: Array<{ message: string; data: any; extra: string }>;
      };
      const content = request.params[0]!;
      const key = request.method === "execute"
        ? `execute:${content.extra}`
        : `${request.method}:${content.message}`;
      const index = posts.filter((post) => post.key === key).length;
      posts.push({ key, body });
      const failure = failures[key]?.[index];
      if (failure === "reset") {
        req.socket.destroy();
        return;
      }
      if (failure === 502) {
        res.writeHead(502).end();
        return;
      }
      const reply = key === "execute:confirmTx"
        ? {
            result: 200,
            response: {
              data: { valid: true, transaction: { hash: content.data.hash } },
            },
          }
        : key === "nodeCall:getTransactionStatus"
          ? { result: 200, response: { state: "included", blockNumber: 42 } }
          : key === "nodeCall:getChainIdentity"
            ? {
                result: 200,
                response: {
                  chainId: null,
                  genesisHash: "test-chain",
                  genesisDataHash: "test-data",
                },
              }
            : key === "nodeCall:getBlockByNumber"
              ? { result: 200, response: { hash: "test-chain", number: 0 } }
              : { result: 200, response: {} };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  servers.push(server);
  return {
    url: `http://127.0.0.1:${port}`,
    posts,
    count: (key: string) => posts.filter((post) => post.key === key).length,
  };
}

/**
 * An adapter whose transaction confirm and broadcast reach the node through
 * demosdk's own transport. Signing and the inclusion reads are stubbed; the
 * node never reports the transaction, so a lost broadcast stays unknown.
 */
async function makeAdapter(rpc: string) {
  const journal = createInMemoryDemosWriteJournal();
  const puts: DemosWriteJournalRecord[] = [];
  const writeJournal: DemosWriteJournal = {
    async acquire(input) {
      const lease = await journal.acquire(input);
      const put = lease.put.bind(lease);
      lease.put = async (record) => {
        puts.push(structuredClone(record));
        await put(record);
      };
      return lease;
    },
  };
  const adapter = new DemosAdapter({
    rpc,
    chainIdentity: "test-chain",
    writeJournal,
  });
  const raw = adapter.raw as any;
  await adapter.connect();
  raw.crypto = {
    ed25519KeyPair: { publicKey: new Uint8Array(32) },
    sign: vi.fn(async () => ({ signature: new Uint8Array(64) })),
  };
  raw.getAddress = vi.fn(() => WALLET);
  raw.getAddressNonce = vi.fn(async () => 0);
  vi.spyOn(adapter, "resolveAnchorByName").mockResolvedValue({
    status: "absent",
  });
  raw.storagePrograms.sign = vi.fn(
    async (payload: Record<string, unknown>, options?: { nonce?: number }) => ({
      hash: "tx-write-once",
      content: {
        type: "storageProgram",
        from: WALLET,
        to: payload.storageAddress,
        nonce: options?.nonce,
        data: ["storageProgram", payload],
      },
    }),
  );
  raw.nodeCall = vi.fn(async () => ({ state: "pending" }));
  raw.getTxByHash = vi.fn(async () => null);
  return { adapter, puts };
}

async function anchorError(adapter: DemosAdapter, name: string) {
  const error = await adapter
    .anchorAndWait(name, { value: 1 }, {
      completion: "included",
      timeoutMs: 1_500,
      pollMs: 5,
    })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AnchorWaitError);
  return error as AnchorWaitError;
}

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

describe("DemosAdapter transaction posts", () => {
  it.each<Failure>([502, "reset"])(
    "sends a broadcast once when the node answers %s, then leaves the outcome unknown",
    async (failure) => {
      const node = await startNode({ "execute:broadcastTx": [failure] });
      const { adapter, puts } = await makeAdapter(node.url);

      const error = await anchorError(adapter, `broadcast-${failure}`);

      expect(node.count("execute:confirmTx")).toBe(1);
      expect(node.count("execute:broadcastTx")).toBe(1);
      expect(error).toMatchObject({
        code: "timeout",
        receipt: { state: "broadcast-unknown", txRef: "tx-write-once" },
      });
      expect(puts.map((record) => record.stage)).toEqual(
        expect.arrayContaining(["signed", "broadcast-intent"]),
      );
      expect(puts.find((record) => record.stage === "signed")).toMatchObject({
        txRef: "tx-write-once",
        signedTransaction: expect.any(String),
      });
    },
  );

  it.each<Failure>([502, "reset"])(
    "sends a confirmation once when the node answers %s and does not broadcast",
    async (failure) => {
      const node = await startNode({ "execute:confirmTx": [failure] });
      const { adapter, puts } = await makeAdapter(node.url);

      const error = await anchorError(adapter, `confirm-${failure}`);

      expect(node.count("execute:confirmTx")).toBe(1);
      expect(node.count("execute:broadcastTx")).toBe(0);
      expect(error).toMatchObject({
        code: "prepare-failed",
        receipt: { state: "not-broadcast" },
      });
      expect(puts.map((record) => record.stage)).not.toContain(
        "broadcast-intent",
      );
    },
  );

  it.each<Failure>([502, "reset"])(
    "still retries a status read when the node answers %s",
    async (failure) => {
      const node = await startNode({
        "nodeCall:getTransactionStatus": [failure],
      });
      const adapter = new DemosAdapter({
        rpc: node.url,
        chainIdentity: "test-chain",
        writeJournal: createInMemoryDemosWriteJournal(),
      });
      await adapter.connect();

      await expect(
        (adapter.raw as any).nodeCall("getTransactionStatus", {
          hash: "tx-write-once",
        }),
      ).resolves.toEqual({ state: "included", blockNumber: 42 });
      expect(node.count("nodeCall:getTransactionStatus")).toBe(2);
    },
  );
});
