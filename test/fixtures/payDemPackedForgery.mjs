// A package consumer trying to mint a final native-DEM verdict without the SDK
// reading the node record. Run as `node payDemPackedForgery.mjs <package-root>`
// against an extracted `npm pack` tarball; prints one JSON report on stdout.
//
// It imports every JavaScript file the package ships (by path, so the package
// `exports` map does not hide any of them), calls every exported function whose
// name looks like a brand, vouch, mark or registrar with the forged rail and
// client, then asks the shipped entry points for a verdict.
import { readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
if (!root) throw new Error("usage: node payDemPackedForgery.mjs <package-root>");

const PAYER = "c3".repeat(32);
const SELLER = "a1".repeat(32);
const TX_HASH = "12".repeat(32);
const AMOUNT_OS = "5000000000";
const BRAND_NAME = /vouch|brand|mark|regist|trust|verif|attest|record/i;

async function shippedFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await shippedFiles(path));
    else if (entry.name.endsWith(".js")) files.push(path);
  }
  return files.sort();
}

const modules = new Map();
const importErrors = [];
for (const file of await shippedFiles(join(root, "dist"))) {
  try {
    modules.set(file.slice(root.length + 1), await import(pathToFileURL(file).href));
  } catch (error) {
    importErrors.push({ file: file.slice(root.length + 1), error: String(error).slice(0, 200) });
  }
}

const failedRecord = () => ({
  ok: false,
  txHash: TX_HASH,
  chainId: "demos",
  payer: PAYER,
  payee: SELLER,
  errorClass: "permanent",
  failureProof: {
    kind: "demos-failed-record",
    txHash: TX_HASH,
    nonce: 7,
    blockNumber: 42,
    payer: PAYER,
    payee: SELLER,
    amountOs: AMOUNT_OS,
  },
  blockNumber: 42,
  txRefKind: "demos",
});
let railCalls = 0;
const forgedSettle = async () => {
  railCalls += 1;
  return failedRecord();
};
const forgedRail = { address: PAYER, settle: forgedSettle };
const forgedTransfer = async () => ({
  ok: true,
  state: "included",
  execution: "executed",
  hash: TX_HASH,
  blockNumber: 42,
});
const forgedClient = { address: PAYER, transfer: forgedTransfer };
const forgedResult = Object.freeze({
  ok: true,
  execution: "executed",
  txHash: TX_HASH,
  chainId: "demos",
  payer: PAYER,
  payee: SELLER,
  finality: Object.freeze({ model: "bft-final" }),
  blockNumber: 42,
  txRefKind: "demos",
  networkFeeOs: "0",
});

// Offer every brand-shaped export the forged capabilities.
const brandExports = [];
for (const [file, namespace] of modules) {
  for (const [name, value] of Object.entries(namespace)) {
    if (typeof value !== "function" || !BRAND_NAME.test(name)) continue;
    brandExports.push(`${file}#${name}`);
    for (const target of [
      forgedSettle, forgedRail, forgedTransfer, forgedClient, forgedResult,
    ]) {
      try {
        const out = value(target);
        if (out && typeof out.then === "function") await out.catch(() => undefined);
      } catch {
        // A refusal is the expected answer.
      }
    }
  }
}
const vouchExports = brandExports.filter((entry) => /vouch/i.test(entry));

const sdk = modules.get("dist/index.js");
const request = {
  rail: "pay-dem",
  phase: "pay-dem",
  amount: "5",
  asset: "DEM",
  payee: `did:demos:agent:${SELLER}`,
  expectedPayee: SELLER,
  jobId: "forged-job",
  phaseIndex: 0,
};
const outcome = async (run) => {
  try {
    const value = await run();
    return {
      ok: value.ok,
      errorClass: value.errorClass ?? null,
      failureProof: value.failureProof !== undefined,
      finality: value.finality?.model ?? null,
      txHash: value.txHash,
    };
  } catch (error) {
    return { threw: String(error?.message ?? error).slice(0, 200) };
  }
};

// Forgery 1: a custom rail's bound failed record must not become a definitive
// (persisted, reused) permanent failure. The rail is refused before it runs.
const failureFirst = await outcome(() =>
  sdk.payDemSettle(forgedRail, { network: "demos" })(request));
const failureSecond = await outcome(() =>
  sdk.payDemSettle(forgedRail, { network: "demos" })(request));

// Forgery 2: a custom client's `execution: "executed"` statement must not mint
// a final payment, directly or through the runSession bridge. Without an SDK
// reader the client, and a custom rail, are refused before they run.
const coreSuccess = await outcome(() => sdk.payDemSettleCore(
  { recipient: SELLER, amount: AMOUNT_OS, network: "demos" },
  forgedClient,
));
const bridgeSuccess = await outcome(() => sdk.payDemSettle(
  { address: PAYER, settle: (params) => sdk.payDemSettleCore(params, forgedClient) },
  { network: "demos" },
)({ ...request, jobId: "forged-success" }));
const railSuccess = await outcome(() => sdk.payDemSettle(
  {
    address: PAYER,
    settle: async () => ({
      ok: true,
      execution: "executed",
      txHash: TX_HASH,
      chainId: "demos",
      payer: PAYER,
      payee: SELLER,
      finality: { model: "bft-final" },
      blockNumber: 42,
      txRefKind: "demos",
    }),
  },
  { network: "demos" },
)({ ...request, jobId: "forged-rail-success" }));

// Forgery 3: a host that accepts any rail asks the SDK whether a success came
// from its own record read. No forged or custom-client object may say yes.
let coreResult;
try {
  coreResult = await sdk.payDemSettleCore(
    { recipient: SELLER, amount: AMOUNT_OS, network: "demos" },
    forgedClient,
  );
} catch {
  coreResult = undefined;
}
const verifiedForgeries = [forgedResult, { ...forgedResult }, coreResult]
  .map((value) => sdk.payDemRecordVerifiedTransfer(value) ?? null);

// The legitimate custom-client path: the shipped reader reads a local node
// (the real demosdk transport, over loopback) and binds the record itself.
// One hash's record is confirmed, the other's failed though included.
const FAILED_HASH = "34".repeat(32);
const nodeRecord = (hash, status) => ({
  hash,
  status,
  blockNumber: 42,
  content: {
    type: "native",
    from: PAYER,
    from_ed25519_address: PAYER,
    to: SELLER,
    amount: Number(AMOUNT_OS),
    nonce: "7",
    data: ["native", { nativeOperation: "send", args: [SELLER, AMOUNT_OS] }],
  },
});
const nodeReads = [];
const node = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let response = null;
    if (req.method === "POST") {
      const { message, data } = JSON.parse(body).params[0];
      nodeReads.push(message);
      // The payer had used nonce 6, so the client's transfer carries 7.
      if (message === "getAddressNonce") response = 6;
      if (message === "getTransactionStatus") response = { state: "included", blockNumber: 42 };
      if (message === "getNetworkInfo") response = { forks: { osDenomination: { activated: true } } };
      if (message === "getTxByHash") {
        response = nodeRecord(data.hash, data.hash === FAILED_HASH ? "failed" : "confirmed");
      }
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ result: 200, response }));
  });
});
await new Promise((ready) => node.listen(0, "127.0.0.1", ready));
// The locked demosdk 4.0.16 build cannot be imported by plain Node ESM (a
// directory import); CI runs this file again against 4.0.18, which can. The
// reader's own lazy import reports which one the package resolved.
let readerUnavailable = null;
let recordReader;
try {
  recordReader = await sdk.createPayDemRecordReader({
    rpc: `http://127.0.0.1:${node.address().port}`,
    inclusionPollIntervalMs: 1,
    transactionRecordTimeoutMs: 5_000,
  });
} catch (error) {
  readerUnavailable = String(error?.code ?? error?.message ?? error).slice(0, 200);
}
// A client that journals its signed transfer through the journal the SDK
// hands it, then returns the hash and nonce it signed.
const readerClient = (hash) => ({
  address: PAYER,
  recordReader,
  transfer: async (args) => {
    await args.journalPreparedTransfer?.({
      txHash: hash, nonce: 7, payer: PAYER, payee: SELLER, amountOs: AMOUNT_OS,
      network: "demos",
      ...(args.recovery === undefined ? {} : { recovery: args.recovery }),
    });
    return { ok: false, state: "timeout", hash, nonce: 7 };
  },
});
const BRIDGE_HASH = "56".repeat(32);
let readerSuccess = null;
let readerReplay = null;
let readerFailure = null;
let forgedReader = null;
if (recordReader !== undefined) {
  const readerCore = await sdk.payDemSettleCore(
    { recipient: SELLER, amount: AMOUNT_OS, network: "demos" },
    readerClient(TX_HASH),
  );
  readerSuccess = {
    core: await outcome(async () => readerCore),
    verified: sdk.payDemRecordVerifiedTransfer(readerCore) ?? null,
    bridge: await outcome(() => sdk.payDemSettle(
      sdk.createPayDemClientRail(readerClient(BRIDGE_HASH)),
      { network: "demos" },
    )({ ...request, jobId: "reader-success" })),
  };
  // The same confirmed transfer handed back for another payment.
  readerReplay = await outcome(() => sdk.payDemSettleCore(
    { recipient: SELLER, amount: AMOUNT_OS, network: "demos" },
    readerClient(TX_HASH),
  ));
  readerFailure = await outcome(() => sdk.payDemSettleCore(
    { recipient: SELLER, amount: AMOUNT_OS, network: "demos" },
    readerClient(FAILED_HASH),
  ));
  forgedReader = await outcome(() => sdk.payDemSettleCore(
    { recipient: SELLER, amount: AMOUNT_OS, network: "demos" },
    { ...readerClient(TX_HASH), recordReader: { ...recordReader } },
  ));
}
node.close();

process.stdout.write(`${JSON.stringify({
  readerUnavailable,
  readerSuccess,
  readerReplay,
  readerFailure,
  forgedReader,
  nodeReads: [...new Set(nodeReads)].sort(),
  shippedFiles: modules.size,
  importErrors,
  brandExports,
  vouchExports,
  failure: { first: failureFirst, second: failureSecond, railCalls },
  coreSuccess,
  bridgeSuccess,
  railSuccess,
  verifiedForgeries,
})}\n`);
