import { pathToFileURL } from "node:url";
import { observeDemosExecutionByHash } from "../dist/rails/payDem.js";

/** Read-only deployment check. The expected transfer is operator-held input. */
export async function probePayDemRecord(node, expected, version) {
  const info = await node.nodeCall("getNetworkInfo", {});
  const postFork = info?.forks?.osDenomination?.activated;
  console.log(JSON.stringify({ version, nodeVersion: info?.nodeVersion, postFork }));
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rpc = process.env.DACS_RECORD_PROBE_RPC ?? "https://node2.demos.sh";
  const confirmed = {
    hash: "6ab2b6008fe99e3b6e6ffc36502f44a280ffc55c4c523b8c19a4339250882a2c",
    blockNumber: 12148, payer: "0ba3102de26ce54078294c5924a2f208693d3b512bd276cd731b722c0056ca7a",
    payee: "01e836295780008f15d4658e657c93de52ea374219a469420d8222f59503400e",
    amountOs: "2400000000000", nonce: 5, denomination: "os", state: "executed",
  };
  // After a network reset, replace the entire operator-held tuple together.
  const expected = process.env.DACS_RECORD_PROBE_CONFIRMED_JSON
    ? JSON.parse(process.env.DACS_RECORD_PROBE_CONFIRMED_JSON) : confirmed;
  const response = await fetch(new URL("/version", rpc), { signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error(`version HTTP ${response.status}`);
  const version = await response.json();
  const { Demos } = await import("@kynesyslabs/demosdk/websdk");
  const node = new Demos();
  await node.connect(rpc);
  await probePayDemRecord(node, { ...expected, state: "executed" }, version);
  if (process.env.DACS_RECORD_PROBE_FAILED_JSON) {
    await probePayDemRecord(node,
      { ...JSON.parse(process.env.DACS_RECORD_PROBE_FAILED_JSON), state: "failed" }, version);
  } else console.log("No operator-held failed-record tuple configured");
}
