import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// #338: a package consumer must not be able to mint a final native-DEM verdict
// the SDK did not read from the node. This builds the current sources, packs
// them with `npm pack`, installs the tarball as a dependency (its own
// dependencies resolve from this checkout, so no network), and runs
// test/fixtures/payDemPackedForgery.mjs in a separate Node process. The script
// imports every JavaScript file the package ships, offers the forged rail and
// client to every brand-like export, then asks the shipped entry points for a
// verdict. It also checks the legitimate path: a custom client carrying the
// shipped record reader settles on the SDK's own read of a local node.

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
// The package resolves demosdk from this checkout. Plain Node ESM cannot import
// the locked 4.0.16 build (a directory import), so the reader cases run where
// a consumer resolves 4.0.18: CI's "Typecheck and test against demosdk 4.0.18".
const demosdkVersion = (JSON.parse(readFileSync(
  join(repo, "node_modules", "@kynesyslabs", "demosdk", "package.json"),
  "utf8",
)) as { version: string }).version;
const HELD = {
  ok: false,
  errorClass: null,
  failureProof: false,
  finality: null,
  txHash: "12".repeat(32),
};

interface ForgeryReport {
  shippedFiles: number;
  importErrors: Array<{ file: string; error: string }>;
  brandExports: string[];
  vouchExports: string[];
  verifiedForgeries: unknown[];
  failure: { first: unknown; second: unknown; railCalls: number };
  coreSuccess: unknown;
  bridgeSuccess: unknown;
  railSuccess: unknown;
  readerUnavailable: string | null;
  readerSuccess: { core: unknown; verified: unknown; bridge: unknown } | null;
  readerReplay: unknown;
  readerFailure: unknown;
  forgedReader: unknown;
  nodeReads: string[];
}

describe("the packed package cannot forge a native-DEM verdict (#338)", () => {
  let scratch: string;
  let report: ForgeryReport;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "dacs-paydem-packed-"));
    const stage = join(scratch, "stage");
    const scope = join(scratch, "consumer", "node_modules", "@kynesyslabs");
    mkdirSync(stage);
    mkdirSync(scope, { recursive: true });
    execFileSync(process.execPath, [
      join(repo, "node_modules", "typescript", "bin", "tsc"),
      "-p", join(repo, "tsconfig.build.json"),
      "--outDir", join(stage, "dist"),
    ], { stdio: "pipe" });
    for (const file of ["package.json", "README.md", "LICENSE"]) {
      copyFileSync(join(repo, file), join(stage, file));
    }
    execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", scratch], {
      cwd: stage,
      env: { ...process.env, npm_config_cache: join(scratch, "npm-cache"), npm_config_update_notifier: "false" },
      stdio: "pipe",
    });
    const tarball = readdirSync(scratch).find((file) => file.endsWith(".tgz"));
    if (tarball === undefined) throw new Error("npm pack produced no tarball");
    execFileSync("tar", ["-xzf", join(scratch, tarball), "-C", scope]);
    renameSync(join(scope, "package"), join(scope, "dacs"));
    symlinkSync(join(repo, "node_modules"), join(scratch, "node_modules"), "dir");
    report = JSON.parse(execFileSync(process.execPath, [
      join(repo, "test", "fixtures", "payDemPackedForgery.mjs"),
      join(scope, "dacs"),
    ], { cwd: scratch, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as ForgeryReport;
  }, 240_000);

  afterAll(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  });

  it("imports every shipped settlement module and finds no vouch helper", () => {
    expect(report.shippedFiles).toBeGreaterThan(100);
    expect(report.importErrors.map(({ file }) => file)
      .filter((file) => /^dist\/(?:index|agent\/|rails\/)/.test(file))).toEqual([]);
    expect(report.vouchExports).toEqual([]);
    // Exactly the three read-only checks and the reader factory, whatever the
    // export syntax.
    expect(report.brandExports.filter((entry) => entry.startsWith("dist/rails/payDem.js#")).sort())
      .toEqual([
        "dist/rails/payDem.js#createPayDemRecordReader",
        "dist/rails/payDem.js#isPayDemRecordVerifyingRail",
        "dist/rails/payDem.js#isRecordVerifiedSource",
        "dist/rails/payDem.js#payDemRecordVerifiedTransfer",
      ]);
  });

  it("refuses a custom rail before it runs, so its failure proof is never kept", () => {
    const refused = { threw: expect.stringMatching(/createPayDemClientRail.*refusing/) };
    expect(report.failure.first).toEqual(refused);
    expect(report.failure.second).toEqual(refused);
    expect(report.failure.railCalls).toBe(0);
  });

  it("refuses a custom client or rail before it runs, so it mints no final payment", () => {
    expect(report.coreSuccess).toEqual({
      threw: expect.stringMatching(/no createPayDemRecordReader reader.*refusing transfer/),
    });
    expect(report.bridgeSuccess).toEqual({
      threw: expect.stringMatching(/createPayDemClientRail.*refusing/),
    });
    expect(report.railSuccess).toEqual({
      threw: expect.stringMatching(/createPayDemClientRail.*refusing/),
    });
  });

  it("reports no forged, copied or custom-client success as SDK record-verified", () => {
    expect(report.verifiedForgeries).toEqual([null, null, null]);
  });

  it("can build the shipped record reader unless demosdk is the locked 4.0.16", () => {
    expect(report.readerUnavailable).toBe(
      demosdkVersion === "4.0.16" ? "ERR_UNSUPPORTED_DIR_IMPORT" : null,
    );
  });

  it.skipIf(demosdkVersion === "4.0.16")("settles a custom client's payment on the shipped reader's own read of a confirmed record", () => {
    const settled = {
      ok: true,
      errorClass: null,
      failureProof: false,
      finality: "bft-final",
      txHash: "12".repeat(32),
    };
    expect(report.readerSuccess).toEqual({
      core: settled,
      verified: {
        payer: "c3".repeat(32),
        payee: "a1".repeat(32),
        amountOs: "5000000000",
        network: "demos",
      },
      bridge: { ...settled, txHash: "56".repeat(32) },
    });
    expect(report.nodeReads).toEqual([
      "getAddressNonce", "getNetworkInfo", "getTransactionStatus", "getTxByHash",
    ]);
  });

  it.skipIf(demosdkVersion === "4.0.16")("holds a confirmed transfer handed back again for another payment", () => {
    expect(report.readerReplay).toEqual(HELD);
  });

  it.skipIf(demosdkVersion === "4.0.16")("denies success for an included transfer whose record failed, and refuses a copied reader", () => {
    expect(report.readerFailure).toEqual({
      ok: false,
      errorClass: "permanent",
      failureProof: true,
      finality: null,
      txHash: "34".repeat(32),
    });
    expect(report.forgedReader).toEqual({
      threw: expect.stringMatching(/createPayDemRecordReader/),
    });
  });
});
