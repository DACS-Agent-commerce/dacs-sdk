// A package consumer trying to mint a final native-DEM verdict without the SDK
// reading the node record. Run as `node payDemPackedForgery.mjs <package-root>`
// against an extracted `npm pack` tarball; prints one JSON report on stdout.
//
// It imports every JavaScript file the package ships (by path, so the package
// `exports` map does not hide any of them), calls every exported function whose
// name looks like a brand, vouch, mark or registrar with the forged rail and
// client, then asks the shipped entry points for a verdict.
import { readdir } from "node:fs/promises";
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

// Offer every brand-shaped export the forged capabilities.
const brandExports = [];
for (const [file, namespace] of modules) {
  for (const [name, value] of Object.entries(namespace)) {
    if (typeof value !== "function" || !BRAND_NAME.test(name)) continue;
    brandExports.push(`${file}#${name}`);
    for (const target of [forgedSettle, forgedRail, forgedTransfer, forgedClient]) {
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
// (persisted, reused) permanent failure.
const failureSettle = sdk.payDemSettle(forgedRail, { network: "demos" });
const failureFirst = await outcome(() => failureSettle(request));
const failureSecond = await outcome(() => failureSettle(request));

// Forgery 2: a custom client's `execution: "executed"` statement must not mint
// a final payment, directly or through the runSession bridge.
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

process.stdout.write(`${JSON.stringify({
  shippedFiles: modules.size,
  importErrors,
  brandExports,
  vouchExports,
  failure: { first: failureFirst, second: failureSecond, railCalls },
  coreSuccess,
  bridgeSuccess,
  railSuccess,
})}\n`);
