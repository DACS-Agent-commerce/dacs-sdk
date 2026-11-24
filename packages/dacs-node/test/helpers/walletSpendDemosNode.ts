import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import {
  settlementKey,
  type WalletSpendAuthorityV1,
  type WalletSpendPolicyV1,
  type WalletSpendReservationV1,
  type WalletSpendSettlementObservationV1,
} from "@kynesyslabs/dacs";

import { createDacsRemoteWalletSpendAuthorityV2 } from "../../src/walletSpendRemote.js";

/** The payer and payee of the recorded node2 transfers, bare lowercase hex. */
export const DEMOS_PAYER = "c0a58599ceaeba18f9c450133631cce4c45f4dc7a59c8026331504da3a913c2a";
export const DEMOS_PAYEE = "706b89f5e2d56498a90bc3a209842b0bd0e22ce06bb4df7c27805e655614e5f1";
export const DEMOS_WALLET = `0x${DEMOS_PAYER}`;
/** The recorded confirmed transfer: 9.5 DEM to the payee, 1 DEM gas burn, nonce 28. */
export const CONFIRMED_HASH = "330dcf1dac0839ebc138d5e2a0db6db7b9567d769c8d4bd987b0d72d7d905918";
export const CONFIRMED_BLOCK = 498_447;
export const CONFIRMED_NONCE = 28;
export const CONFIRMED_AMOUNT = "9500000000";
/** The fee the confirmed record's balance edits remove beyond the amount. */
export const CONFIRMED_FEE = "1000000000";
/** The recorded failed transfer: same parties and amount, nonce 9. */
export const FAILED_HASH = "85b8fcdcee48822742a39e1b9877f5e2f8dde36430e8e486e3a8b0c9a7744cbd";

interface Node2Records {
  source: { networkInfoEnvelope: unknown };
  getTxByHash: Record<string, { response: unknown }>;
  getTransactionStatus: Record<string, unknown>;
}

const node2 = JSON.parse(readFileSync(
  new URL("../../../../test/fixtures/demos-node2-records.json", import.meta.url),
  "utf8",
)) as Node2Records;

/** A fresh copy of a recorded `getTxByHash` record (the envelope's `response`). */
export const recordedTransaction = (hash: string): Record<string, unknown> =>
  structuredClone(node2.getTxByHash[hash]!.response) as Record<string, unknown>;

/** A Demos testnet policy for the recorded payer with one DEM asset. */
export function demosPolicy(overrides: Partial<WalletSpendPolicyV1> = {}): WalletSpendPolicyV1 {
  return {
    policyVersion: "1",
    policyId: "testnet-dem-buyer",
    wallet: DEMOS_WALLET,
    chainId: "demos",
    maximumConcurrentEffects: 1,
    maximumRetainedReservations: 100,
    assets: [{
      asset: "DEM",
      maximumPerOrderDebit: "20000000000",
      maximumNetworkFeeDebit: "2000000000",
      minimumReserve: "0",
      rollingWindowMs: 86_400_000,
      maximumRollingEffects: 10,
      maximumRollingDebit: "100000000000",
      maximumCumulativeDebit: "1000000000000",
      maximumCounterpartyDebit: "100000000000",
    }],
    ...overrides,
  };
}

/**
 * The Demos node address the service tests configure. The start check binds only an https node, so
 * the tests route this name to a loopback stub: `fetchRoutingDemosNodeTo` in process, and
 * `routeDemosNodeFetch.mjs` (target in `DACS_TEST_DEMOS_NODE_TARGET`) in a child process.
 */
export const DEMOS_NODE_URL = "https://demos-node.test/";

/** `base`, except that requests for `DEMOS_NODE_URL` go to `target`. */
export function fetchRoutingDemosNodeTo(target: string, base: typeof fetch = globalThis.fetch): typeof fetch {
  return (input, init) => base(String(input) === DEMOS_NODE_URL ? target : input, init);
}

export const DEMOS_RAIL_ID = "pay-dem-native";
/** The fee ceiling the buyer reserves: the confirmed record's 1 DEM fee fits under it. */
export const DEMOS_FEE_CEILING = "2000000000";

/** A hold shaped as the SDK's pay-dem buyer builds it for one job phase. */
export function demosHold(jobId = "job-dem", options: Readonly<{ fee?: boolean; payee?: string; amount?: string }> = {}):
  WalletSpendReservationV1 {
  const amount = options.amount ?? CONFIRMED_AMOUNT;
  return {
    reservationVersion: "1",
    reservationId: `pay-dem:${settlementKey(DEMOS_RAIL_ID, jobId, 0)}`,
    jobId,
    phaseIndex: 0,
    phase: "pay-dem",
    agreementHash: "a".repeat(64),
    settlementBindingHash: "b".repeat(64),
    railId: DEMOS_RAIL_ID,
    railDefinitionHash: "c".repeat(64),
    wallet: DEMOS_WALLET,
    chainId: "demos",
    payee: options.payee ?? DEMOS_PAYEE,
    finality: { model: "bft-final" },
    debits: [
      { asset: "DEM", purpose: "service", expectedAmount: amount, maximumAmount: amount },
      ...(options.fee === false ? [] : [{
        asset: "DEM", purpose: "network-fee" as const, expectedAmount: "0", maximumAmount: DEMOS_FEE_CEILING,
      }]),
    ],
  };
}

/** A settled claim for the confirmed transfer; `fee` null leaves out the network-fee debit. */
export function demosSettledClaim(hash = CONFIRMED_HASH, fee: string | null = CONFIRMED_FEE): WalletSpendSettlementObservationV1 {
  return {
    disposition: "settled",
    evidenceHash: hash,
    debits: [
      { asset: "DEM", purpose: "service", amount: CONFIRMED_AMOUNT },
      ...(fee === null ? [] : [{ asset: "DEM", purpose: "network-fee" as const, amount: fee }]),
    ],
  };
}

/** The x402 lane's own four settings; without them a service runs the DEM lane alone. */
export const X402_LANE_SETTING_NAMES = Object.freeze([
  "DACS_WALLET_AUTHORITY_DATA_DIRECTORY",
  "DACS_WALLET_AUTHORITY_POLICY_FILE",
  "DACS_EVM_RPC_URL",
  "DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK",
]);

/** The environment without the x402 lane's settings. */
export function withoutX402Lane(environment: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  return { ...environment, ...Object.fromEntries(X402_LANE_SETTING_NAMES.map((name) => [name, undefined])) };
}

/** The DEM lane's three settings: a data directory and a policy file under `root`, and the node URL. */
export async function demosLaneSettings(input: Readonly<{ root: string; rpcUrl: string; policy?: unknown }>):
  Promise<Readonly<{ dataDirectory: string; environment: Record<string, string> }>> {
  const dataDirectory = join(input.root, "dem-data");
  const policyFile = join(input.root, "dem-policy.json");
  await writeFile(policyFile, JSON.stringify(input.policy ?? demosPolicy()), { mode: 0o644 });
  return {
    dataDirectory,
    environment: {
      DACS_PAY_DEM_WALLET_AUTHORITY_DATA_DIRECTORY: dataDirectory,
      DACS_PAY_DEM_WALLET_AUTHORITY_POLICY_FILE: policyFile,
      DACS_DEMOS_RPC_URL: input.rpcUrl,
    },
  };
}

/** The remote V2 client a generated pay-dem buyer builds, for the DEM policy (with overrides). */
export function demosAuthorityClient(input: Readonly<{
  authority: Readonly<{ url: string; authorityId: string; epoch: string; witnessVerificationKey: string }>;
  tokenFile: string;
  policy?: Partial<WalletSpendPolicyV1>;
  fetch?: typeof fetch;
}>): Promise<Readonly<WalletSpendAuthorityV1>> {
  return createDacsRemoteWalletSpendAuthorityV2({
    policy: demosPolicy(input.policy),
    endpoint: input.authority.url,
    tokenFilePath: input.tokenFile,
    authorityId: input.authority.authorityId,
    epoch: input.authority.epoch,
    witnessVerificationKey: input.authority.witnessVerificationKey,
    allowInsecureLoopback: true,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
}

/** One `nodeCall` request as the stub received it. */
export interface DemosNodeCall { message: string; data: Record<string, unknown> }

/** A replaced answer: an HTTP status and a body (a string is sent as is). */
export interface DemosNodeAnswer { status: number; body: unknown; declaredLength?: boolean }

/** What the stub serves; tests change it between requests. */
export interface DemosNodeState {
  /** `getTxByHash` records by hash; each is served as `{result: 200, response}`. */
  records: Map<string, unknown>;
  /** The predecessor hash block 1 reports, which the identity check reads as the genesis hash. */
  genesisHash: string;
  forkActivated: unknown;
  balance: unknown;
}

export interface DemosNodeStub {
  url: string;
  state: DemosNodeState;
  calls: DemosNodeCall[];
  /** Responses the server stopped writing before their end. */
  cutShort: number;
  close(): Promise<void>;
}

const stubs: Server[] = [];

/** Closes every stub the tests opened. */
export async function closeDemosNodeStubs(): Promise<void> {
  await Promise.all(stubs.splice(0).map((server) => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  })));
}

/** The default state: the recorded records, the approved identity and a post-fork balance. */
export function recordedDemosState(genesisHash: string): DemosNodeState {
  return {
    records: new Map(Object.keys(node2.getTxByHash).map((hash) => [hash, recordedTransaction(hash)])),
    genesisHash,
    forkActivated: true,
    balance: "12000000000",
  };
}

const ok = (response: unknown) => ({ status: 200, body: { result: 200, response } });

/** A confirmed block that lists every served record included at that height. */
function blockAnswer(state: DemosNodeState, blockNumber: number): DemosNodeAnswer {
  if (blockNumber === 0) return { status: 200, body: { result: 400, response: "error" } };
  if (blockNumber === 1) {
    return ok({ number: 1, status: "confirmed", hash: "01".repeat(32), content: { previousHash: state.genesisHash } });
  }
  const orderedTransactions = [...state.records.entries()]
    .filter(([, record]) => (record as { blockNumber?: unknown }).blockNumber === blockNumber)
    .map(([hash]) => hash);
  return ok({
    number: blockNumber,
    status: "confirmed",
    hash: "0b".repeat(32),
    content: { ordered_transactions: orderedTransactions, timestamp: 1_791_649_650 },
  });
}

function defaultAnswer(state: DemosNodeState, call: DemosNodeCall): DemosNodeAnswer {
  const hash = String(call.data.hash);
  switch (call.message) {
    case "getChainIdentity":
      return { status: 200, body: { result: 400, response: "Unknown message getChainIdentity" } };
    case "getBlockByNumber":
      return blockAnswer(state, Number(call.data.blockNumber));
    case "getTransactionStatus": {
      const record = state.records.get(hash) as { blockNumber?: unknown } | undefined;
      return record === undefined
        ? { status: 200, body: { result: 404, response: null } }
        : ok({ state: "included", blockNumber: record.blockNumber });
    }
    case "getTxByHash":
      return state.records.has(hash) ? ok(state.records.get(hash)) : { status: 200, body: { result: 400, response: "error" } };
    case "getNetworkInfo":
      return ok({ forks: { osDenomination: { activationHeight: 0, activated: state.forkActivated } } });
    case "getAddressInfo":
      return ok({ balance: state.balance });
    default:
      return { status: 200, body: { result: 400, response: "error" } };
  }
}

/** Writes an answer; a body over 1 MiB is sent in chunks so a reader that stops early cuts it short. */
function reply(stub: DemosNodeStub, response: ServerResponse, answer: DemosNodeAnswer): void {
  const text = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
  const bytes = Buffer.from(text);
  response.writeHead(answer.status, {
    "content-type": "application/json",
    ...(answer.declaredLength === false ? {} : { "content-length": String(bytes.byteLength) }),
  });
  response.on("close", () => {
    if (!response.writableFinished) stub.cutShort += 1;
  });
  const chunk = 16 * 1024;
  let offset = 0;
  const writeNext = (): void => {
    while (offset < bytes.byteLength) {
      const part = bytes.subarray(offset, offset + chunk);
      offset += chunk;
      if (!response.write(part)) {
        response.once("drain", writeNext);
        return;
      }
    }
    response.end();
  };
  writeNext();
}

/**
 * A loopback Demos node stand-in answering `nodeCall` bodies from `state`, and
 * recording each call. `answer` may replace an answer; `hold` may delay one
 * until the promise it returns settles.
 */
export async function demosNodeStub(state: DemosNodeState, options: Readonly<{
  answer?: (call: DemosNodeCall) => DemosNodeAnswer | undefined;
  hold?: (call: DemosNodeCall) => Promise<void> | undefined;
}> = {}): Promise<DemosNodeStub> {
  const calls: DemosNodeCall[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { params: [DemosNodeCall] };
      const call = parsed.params[0];
      calls.push(call);
      const send = () => reply(stub, response, options.answer?.(call) ?? defaultAnswer(state, call));
      const held = options.hold?.(call);
      if (held === undefined) return send();
      void held.then(send);
    });
  });
  stubs.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stub: DemosNodeStub = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    state,
    calls,
    cutShort: 0,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
  return stub;
}

/** The address of a loopback port that nothing listens on. */
export async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}/`;
}
