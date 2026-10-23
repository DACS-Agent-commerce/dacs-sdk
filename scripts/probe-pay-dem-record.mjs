import { pathToFileURL } from "node:url";
import { observeDemosExecutionByHash } from "../dist/rails/payDem.js";
import { payDemReadEndpoint, payDemRecoveryRpc } from "../dist/rails/payDemRecoveryRpc.js";

/** Read-only deployment check. The expected transfer and clean build are operator-held inputs. */
export async function probePayDemRecord(node, expected, version, approvedCommit) {
  const info = await node.nodeCall("getNetworkInfo", {});
  if (typeof approvedCommit !== "string" || !/^[0-9a-f]{40}$/.test(approvedCommit) ||
      info?.nodeVersion?.commit !== approvedCommit || info?.nodeVersion?.dirty !== false ||
      typeof version?.commit !== "string" ||
      !new RegExp(`^(?:<[^>]+>)?${approvedCommit}$`).test(version.commit) || version.dirty === true) {
    throw new Error("deployment probe requires an approved clean node build matching both version responses");
  }
  const postFork = info?.forks?.osDenomination?.activated;
  console.log(JSON.stringify({ version, nodeVersion: info.nodeVersion, postFork }));
  if (typeof postFork !== "boolean") throw new Error("missing denomination fork state");
  const result = await observeDemosExecutionByHash(expected.hash,
    (hash) => node.getTxByHash(hash), {
      blockNumber: expected.blockNumber,
      transfer: { payer: expected.payer, payee: expected.payee,
        amountOs: BigInt(expected.amountOs), nonce: expected.nonce,
        postFork: expected.denomination === "os" },
    }, { transactionRecordTimeoutMs: 1000, inclusionPollIntervalMs: 50, statusRequestTimeoutMs: 1000 });
  console.log(JSON.stringify({ hash: expected.hash, observation: result }));
  if (result.state !== expected.state) throw new Error(`expected ${expected.state}, got ${result.state}`);
  return result;
}

/** Bound decompressed version bytes and the entire read before decoding. */
export async function readProbeVersion(rpc) {
  const { endpoint, headers } = payDemReadEndpoint(new URL("/version", rpc).href);
  const response = await fetch(endpoint, {
    headers,
    signal: AbortSignal.timeout(6000), redirect: "error",
  });
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`version HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw new Error("version response exceeds byte limit");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A chain reset invalidates historical tuples; require a current tuple together.
  if (!process.env.DACS_RECORD_PROBE_CONFIRMED_JSON) {
    throw new Error("DACS_RECORD_PROBE_CONFIRMED_JSON is required; configure a current operator-held transfer tuple");
  }
  const approvedCommit = process.env.DACS_RECORD_PROBE_NODE_COMMIT;
  if (!approvedCommit || !/^[0-9a-f]{40}$/.test(approvedCommit)) {
    throw new Error("DACS_RECORD_PROBE_NODE_COMMIT must identify an approved clean node build");
  }
  const expected = JSON.parse(process.env.DACS_RECORD_PROBE_CONFIRMED_JSON);
  const rpc = process.env.DACS_RECORD_PROBE_RPC ?? "https://node2.demos.sh";
  const version = await readProbeVersion(rpc);
  // No wallet or demosdk connection: every RPC read uses the bounded transport.
  const call = payDemRecoveryRpc(rpc, 1000);
  const node = { nodeCall: call, getTxByHash: (hash) => call("getTxByHash", { hash }) };
  await probePayDemRecord(node, { ...expected, state: "executed" }, version, approvedCommit);
  if (process.env.DACS_RECORD_PROBE_FAILED_JSON) {
    await probePayDemRecord(node,
      { ...JSON.parse(process.env.DACS_RECORD_PROBE_FAILED_JSON), state: "failed" }, version, approvedCommit);
  } else console.log("No operator-held failed-record tuple configured");
}
