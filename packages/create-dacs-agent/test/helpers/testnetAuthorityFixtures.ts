import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalize } from "../../../../src/canonical/index.js";
import {
  captureWalletSpendPolicyV1,
  type WalletSpendPolicyV1,
} from "../../../../src/rails/walletSpendAuthority.js";
import { createDacsAgentProject } from "../../src/index.js";

/** A bearer token of the length the service accepts, with no secret-looking entropy. */
export const TESTNET_TOKEN = "testnet-authority-bearer-".padEnd(48, "k");
/** A witness seed of 64 hexadecimal characters. */
export const TESTNET_SEED_HEX = "11".repeat(32);
export const TESTNET_AUTHORITY_ID = "testnet-authority";
export const TESTNET_EPOCH = "epoch-one";

const BASE_SEPOLIA_CHAIN_ID_HEX = "0x14a34";
const WORKSPACE_NODE_MODULES = fileURLToPath(new URL("../../../../node_modules", import.meta.url));

/** Generates a live buyer project in a new temporary directory, linked to the workspace's packages. */
export async function generatedProject(
  rails: "x402" | "pay-dem" | "both",
  deployment: "local" | "docker" = "local",
): Promise<Readonly<{ root: string; project: string }>> {
  const root = await mkdtemp(join(tmpdir(), "create-dacs-agent-authority-"));
  const project = join(root, `${rails}-agent`);
  await createDacsAgentProject({
    targetDirectory: project,
    mode: "live-demos",
    profile: "dacs-sdk:fixed-price-x402:v1",
    role: "buyer",
    deployment,
    rails,
    install: false,
  });
  await symlink(WORKSPACE_NODE_MODULES, join(project, "node_modules"), "dir");
  return { root, project };
}

/** Writes a file with the given mode, whatever the process umask. */
export async function writeModeFile(path: string, content: string, mode = 0o600): Promise<void> {
  await writeFile(path, content, { mode });
  await chmod(path, mode);
}

/** A Base Sepolia x402 policy for one wallet and one ERC-20 asset, both lowercase. */
export function testnetPolicy(wallet: string, asset: string): Readonly<WalletSpendPolicyV1> {
  return captureWalletSpendPolicyV1({
    policyVersion: "1",
    policyId: "generated-fixed-price-x402-v1",
    wallet,
    chainId: "eip155:84532",
    maximumConcurrentEffects: 1,
    maximumRetainedReservations: 10000,
    assets: [{
      asset,
      maximumPerOrderDebit: "1000000",
      maximumNetworkFeeDebit: "0",
      minimumReserve: "0",
      rollingWindowMs: 86400000,
      maximumRollingEffects: 10,
      maximumRollingDebit: "10000000",
      maximumCumulativeDebit: "100000000",
      maximumCounterpartyDebit: "25000000",
    }],
  });
}

/** The policy file content the service reads: the canonical JSON of one policy. */
export function policyFileText(policy: Readonly<WalletSpendPolicyV1>): string {
  return canonicalize(policy);
}

export interface ChainStub {
  url: string;
  methods: string[];
  close(): Promise<void>;
}

/**
 * A loopback JSON-RPC stub for Base Sepolia that answers the chain id and every
 * `eth_call` with the given token balance; any other method gets an error.
 */
export async function startChainStub(balance: bigint): Promise<ChainStub> {
  const methods: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const call = JSON.parse(body) as { id: number; method: string };
      methods.push(call.method);
      const result = call.method === "eth_chainId" ? BASE_SEPOLIA_CHAIN_ID_HEX
        : call.method === "eth_call" ? "0x" + balance.toString(16).padStart(64, "0")
          : undefined;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(result === undefined
        ? { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "method not found" } }
        : { jsonrpc: "2.0", id: call.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    methods,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** A loopback port that nothing listens on when this returns. */
export async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** True when a TCP connection to the loopback port is refused. */
export function portRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(port, "127.0.0.1");
    probe.once("connect", () => {
      probe.destroy();
      resolve(false);
    });
    probe.once("error", () => resolve(true));
  });
}
