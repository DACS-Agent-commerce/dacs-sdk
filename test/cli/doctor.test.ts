import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import { formatDoctorText, redactRpcUrl, runDoctor } from "../../src/cli/index.js";

import {
  RPC_CALL_TIMEOUT_MS,
  runDoctorForCli,
  VERIFIED_DEMOS_NODE_PACKAGE,
  VERIFIED_DEMOS_NODE_REVISION,
} from "../../src/cli/doctor.js";
import type { DoctorSecretFile } from "../../src/cli/secretFile.js";
import { VERSION } from "../../src/version.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

describe("dacs doctor", () => {
  it("recognizes native DEM without claiming availability or funding or making offline effects", async () => {
    const adapter = {
      connect: vi.fn(), getAddress: vi.fn(), write: vi.fn(), transfer: vi.fn(),
      broadcast: vi.fn(), settle: vi.fn(),
    };
    const factory = vi.fn(() => adapter);
    const fetch = vi.fn(() => { throw new Error("unexpected network call"); });
    vi.stubGlobal("fetch", fetch);
    try {
      const report = await runDoctor({
        offline: true, rail: "pay-dem", rpc: "https://node.example",
        walletSecret: randomBytes(32).toString("hex"), adapterFactory: factory,
      });
      expect(report.exitCode).toBe(5);
      expect(report.checks.find((c) => c.id === "rail.availability")).toMatchObject({
        status: "warn", data: { rail: "pay-dem", known: true },
        summary: "Native DEM rail is known; availability and funding were not checked",
      });
      for (const id of ["wallet.balance", "wallet.nonce", "storage.binding-resolution", "anchor.completion",
        "cost.estimate"]) {
        expect(report.checks.find((c) => c.id === id)?.status).toBe("blocked");
      }
      expect(factory).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      for (const method of Object.values(adapter)) expect(method).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  const inspectedFile: DoctorSecretFile = {
    source: "wallet", symlink: false, mode: 0o600, ownerUid: 1000,
    currentUid: 1000, platform: "linux",
  };

  it("ignores fabricated credential metadata supplied to public runDoctor", async () => {
    const untrusted = { offline: true, secretFiles: [inspectedFile] };
    const report = await runDoctor(untrusted);
    expect(report.checks.filter((c) => c.id.startsWith("config.wallet-file"))).toEqual([]);
  });

  it.each([
    { ...inspectedFile, symlink: true },
    { ...inspectedFile, mode: 0o644 },
    { ...inspectedFile, ownerUid: 1001 },
  ])("fails credential admission and prevents adapter use: %j", async (file) => {
    const adapter = { connect: vi.fn(), getAddress: vi.fn() };
    const factory = vi.fn(() => adapter);
    const report = await runDoctorForCli({ rpc: "https://node.example", walletSecret: randomBytes(32).toString("hex"),
      adapterFactory: factory }, [file]);
    expect(report.exitCode).toBe(1);
    expect(factory).not.toHaveBeenCalled();
    expect(adapter.connect).not.toHaveBeenCalled();
    expect(adapter.getAddress).not.toHaveBeenCalled();
  });

  it("reports mismatched credential owners without paths", async () => {
    const report = await runDoctorForCli({ offline: true }, [{ ...inspectedFile, ownerUid: 1001 }]);
    expect(report.checks.find((c) => c.id === "config.wallet-file.owner")).toMatchObject({
      status: "fail", data: { ownerUid: 1001, currentUid: 1000 },
    });
    expect(formatDoctorText(report)).toContain("Credential file owner differs from the current user");
    expect(report.exitCode).toBe(1);
  });

  it("reports exact credential mode and owner wording", async () => {
    const safe = await runDoctorForCli({ offline: true }, [inspectedFile]);
    expect(safe.checks.find((c) => c.id === "config.wallet-file.mode")).toEqual({
      id: "config.wallet-file.mode", status: "pass", summary: "Credential file mode is 0600",
      data: { mode: "0600" }, remediation: undefined,
    });
    expect(safe.checks.find((c) => c.id === "config.wallet-file.owner")).toEqual({
      id: "config.wallet-file.owner", status: "pass", summary: "Credential file belongs to the current user",
      data: { ownerUid: 1000, currentUid: 1000 }, remediation: undefined,
    });
    const unsafe = await runDoctorForCli({ offline: true }, [{ ...inspectedFile, mode: 0o100644, ownerUid: 1001 }]);
    expect(unsafe.checks.find((c) => c.id === "config.wallet-file.mode")).toEqual({
      id: "config.wallet-file.mode", status: "fail", summary: "Credential file mode is unsafe",
      data: { mode: "0644" }, remediation: "Set the credential file mode to 0600.",
    });
    expect(unsafe.checks.find((c) => c.id === "config.wallet-file.owner")).toMatchObject({
      status: "fail", remediation: "Use a credential file owned by the current user.",
    });
    const link = await runDoctorForCli({ offline: true }, [{ ...inspectedFile, symlink: true,
      mode: undefined, ownerUid: undefined }]);
    expect(link.checks.find((c) => c.id === "config.wallet-file.symlink")).toMatchObject({
      status: "fail", summary: "Credential file is a symbolic link",
      remediation: "Use a regular credential file directly.",
    });
    expect(link.checks.find((c) => c.id === "config.wallet-file.mode")).toMatchObject({
      status: "skip", summary: "Credential file mode check is unavailable because the file was not opened",
    });
    // A symlink's owner and mode are never judged, even when metadata is present.
    const linkWithMetadata = await runDoctorForCli({ offline: true }, [{ ...inspectedFile, symlink: true,
      ownerUid: 1001 }]);
    expect(linkWithMetadata.checks.filter((c) => c.id.startsWith("config.wallet-file."))).toEqual([
      { id: "config.wallet-file.symlink", status: "fail", summary: "Credential file is a symbolic link",
        remediation: "Use a regular credential file directly." },
      { id: "config.wallet-file.mode", status: "skip",
        summary: "Credential file mode check is unavailable because the file was not opened" },
      { id: "config.wallet-file.owner", status: "skip", summary: "Credential file owner check is unavailable" },
    ]);
  });

  it("applies the host's mode rule to Windows files instead of skipping it", async () => {
    // Node reports Windows modes as 0666 or 0444, and the host has no platform gate.
    const adapter = { connect: vi.fn(), getAddress: vi.fn() };
    const factory = vi.fn(() => adapter);
    for (const mode of [0o100666, 0o100444]) {
      const report = await runDoctorForCli({ rpc: "https://node.example", adapterFactory: factory },
        [{ ...inspectedFile, platform: "win32", mode, currentUid: undefined }]);
      expect(report.exitCode).toBe(1);
      expect(report.checks.find((c) => c.id === "config.wallet-file.mode")).toEqual({
        id: "config.wallet-file.mode", status: "fail", summary: "Credential file mode is unsafe",
        data: { mode: (mode & 0o777).toString(8).padStart(4, "0") },
        remediation: "Node reports Windows file modes as 0666 or 0444, so the Node host refuses live " +
          "credential files there; pass the credential through stdin (-) or an environment variable instead.",
      });
      expect(report.checks.find((c) => c.id === "config.wallet-file.owner")).toMatchObject({
        status: "skip", summary: "Credential file owner check is unavailable",
      });
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it("reports owner assessment unavailable without a current UID", async () => {
    const report = await runDoctorForCli({ offline: true }, [{ ...inspectedFile, currentUid: undefined }]);
    expect(report.checks.find((c) => c.id === "config.wallet-file.owner")).toMatchObject({
      status: "skip", summary: "Credential file owner check is unavailable",
    });
  });

  it("runs offline without touching the network", async () => {
    const report = await runDoctor({
      offline: true,
      now: () => new Date("2026-07-16T00:00:00.000Z"),
      adapterFactory: () => {
        throw new Error("network should not be touched");
      },
    });

    expect(report.mode).toBe("offline");
    expect(report.exitCode).toBe(5);
    expect(report.checks.find((c) => c.id === "runtime.node")?.status).toBe("pass");
    expect(report.checks.find((c) => c.id === "rpc.reachable")?.status).toBe("skip");
    expect(report.checks.find((c) => c.id === "storage.binding-resolution")?.status).toBe("blocked");
  });

  it("fails unsupported Node versions", async () => {
    const report = await runDoctor({ offline: true, nodeVersion: "v20.10.0" });

    expect(report.exitCode).toBe(1);
    expect(report.checks.find((c) => c.id === "runtime.node")?.status).toBe("fail");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      engines: { node: string };
    };
    expect(report.checks.find((c) => c.id === "runtime.node")?.data?.required).toBe(packageJson.engines.node);
  });

  it("accepts the exact supported Node runtime ranges", async () => {
    expect((await runDoctor({ offline: true, nodeVersion: "v20.19.0" })).checks[0]?.status).toBe(
      "pass",
    );
    expect((await runDoctor({ offline: true, nodeVersion: "v22.12.0" })).checks[0]?.status).toBe(
      "pass",
    );
  });

  it("redacts wallet secrets in report JSON", async () => {
    const secret = "abcd-secret-material-1234";
    const report = await runDoctor({ offline: true, walletSecret: secret });
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("abcd");
    expect(serialized).not.toContain("1234");
    expect(serialized).toContain("[redacted]");
  });

  it("redacts RPC credentials and query tokens in report data", async () => {
    const rpc = "https://user:pass@node.example/rpc?token=secret#frag";
    const report = await runDoctor({
      rpc,
      adapterFactory: () => ({
        connect: async () => {},
        getAddress: () => "unused",
      }),
    });

    const rpcCheck = report.checks.find((c) => c.id === "rpc.reachable");
    expect(rpcCheck?.data?.rpc).toBe("https://node.example/[redacted]?[redacted]#[redacted]");
    expect(JSON.stringify(report)).not.toContain("user:pass");
    expect(JSON.stringify(report)).not.toContain("token=secret");
  });

  it("maps requested RPC failure to exit code 3 without leaking secrets", async () => {
    const secret = "secret-value";
    const rpcUrl = "https://user:pass@node.example/v2/path-secret?token=query-secret#frag-secret";
    const report = await runDoctor({
      rpc: rpcUrl,
      walletSecret: secret,
      adapterFactory: () => ({
        connect: async () => {
          throw new Error(`failed with ${secret} user pass path-secret query-secret frag-secret`);
        },
        getAddress: () => {
          throw new Error("getAddress should not be called after connect failure");
        },
      }),
    });

    expect(report.exitCode).toBe(3);
    const rpc = report.checks.find((c) => c.id === "rpc.reachable");
    expect(rpc?.status).toBe("fail");
    expect(rpc?.detail).toContain("[redacted]");
    expect(rpc?.detail).not.toContain(secret);
    expect(rpc?.detail).not.toContain("path-secret");
    expect(rpc?.detail).not.toContain("query-secret");
    expect(rpc?.detail).not.toContain("frag-secret");
  });

  it("lets non-RPC failures take precedence over RPC failures", async () => {
    const report = await runDoctor({
      nodeVersion: "v20.10.0",
      rpc: "https://example.invalid",
      adapterFactory: () => ({
        connect: async () => {
          throw new Error("network down");
        },
        getAddress: () => "unused",
      }),
    });

    expect(report.exitCode).toBe(1);
    expect(report.checks.find((c) => c.id === "runtime.node")?.status).toBe("fail");
    expect(report.checks.find((c) => c.id === "rpc.reachable")?.status).toBe("fail");
  });

  it("separates adapter load failures from RPC reachability failures", async () => {
    const report = await runDoctor({
      rpc: "https://node.example",
      walletSecret: "secret-value",
      adapterFactory: () => {
        throw new Error("adapter import failed with secret-value");
      },
    });

    expect(report.exitCode).toBe(1);
    const adapterLoad = report.checks.find((c) => c.id === "substrate.adapter-load");
    expect(adapterLoad?.status).toBe("fail");
    expect(adapterLoad?.detail).toContain("[redacted]");
    expect(adapterLoad?.detail).not.toContain("secret-value");
    expect(report.checks.some((c) => c.id === "rpc.reachable" && c.status === "fail")).toBe(false);
  });

  it("derives wallet identity only after RPC connection succeeds", async () => {
    const report = await runDoctor({
      rpc: "https://node.example",
      walletSecret: "secret-value",
      adapterFactory: () => ({
        connect: async () => {},
        getAddress: () => "demos-address",
      }),
    });

    expect(report.exitCode).toBe(5);
    expect(report.checks.find((c) => c.id === "wallet.identity")?.status).toBe("pass");
    expect(report.checks.find((c) => c.id === "wallet.identity")?.data?.address).toBe(
      "demos-address",
    );
  });

  it("passes RPC reachability only for a Demos block height", async () => {
    const getLastBlockNumber = vi.fn(async () => 1234);
    const report = await runDoctor({
      rpc: "https://node.example", walletSecret: "secret-value",
      adapterFactory: () => ({ connect: async () => {}, getAddress: () => "demos-address", getLastBlockNumber }),
    });
    expect(report.exitCode).toBe(5);
    expect(report.checks.find((c) => c.id === "rpc.reachable")).toEqual({
      id: "rpc.reachable", status: "pass", summary: "Demos RPC is reachable and reports a block height",
      data: { rpc: "https://node.example/", lastBlockNumber: 1234 },
    });
    expect(getLastBlockNumber).toHaveBeenCalledOnce();
    expect(report.checks.find((c) => c.id === "wallet.identity")?.status).toBe("pass");
  });

  it.each([
    ["a generic HTTP 200 body", undefined],
    ["a string", "12"],
    ["a negative height", -1],
    ["a fractional height", 1.5],
    ["an unsafe integer", 2 ** 53],
    ["NaN", Number.NaN],
    ["a node error envelope", { result: 500, response: "Error in nodeCall: " }],
    ["a transport error envelope", { result: 500, response: new Error("POST https://user:pass@node.example/path-secret") }],
  ])("fails RPC reachability when the endpoint answers with %s", async (_label, height) => {
    const rpc = "https://user:pass@node.example/path-secret";
    const report = await runDoctor({
      rpc, walletSecret: "secret-value",
      adapterFactory: () => ({ connect: async () => {}, getAddress: () => "unused", getLastBlockNumber: async () => height }),
    });
    expect(report.exitCode).toBe(3);
    expect(report.checks.find((c) => c.id === "rpc.reachable")).toEqual({
      id: "rpc.reachable", status: "fail", summary: "RPC endpoint did not answer the Demos block-height call",
      data: { rpc: "https://node.example/[redacted]" },
      detail: "getLastBlockNumber did not return a non-negative integer",
      remediation: "Check that the RPC URL points at a reachable Demos node.",
    });
    expect(report.checks.find((c) => c.id === "wallet.identity")).toMatchObject({
      status: "skip", summary: "Wallet identity skipped because the Demos RPC check did not pass",
    });
    expect(JSON.stringify(report)).not.toContain("user:pass");
    expect(JSON.stringify(report)).not.toContain("path-secret");
  });

  it("redacts a thrown block-height failure", async () => {
    const report = await runDoctor({
      rpc: "https://node.example", walletSecret: "secret-value",
      adapterFactory: () => ({ connect: async () => {}, getAddress: () => "unused",
        getLastBlockNumber: async () => { throw new Error("rejected secret-value"); } }),
    });
    expect(report.exitCode).toBe(3);
    expect(report.checks.find((c) => c.id === "rpc.reachable")?.detail).toBe("rejected [redacted]");
  });

  it("warns instead of passing when an adapter cannot confirm a Demos node", async () => {
    const report = await runDoctor({
      rpc: "https://node.example",
      adapterFactory: () => ({ connect: async () => {}, getAddress: () => "unused" }),
    });
    expect(report.exitCode).toBe(5);
    expect(report.checks.find((c) => c.id === "rpc.reachable")).toEqual({
      id: "rpc.reachable", status: "warn",
      summary: "RPC endpoint answered; the adapter cannot confirm it is a Demos node",
      data: { rpc: "https://node.example/" },
    });
  });

  it("never runs the height call after a failed connect", async () => {
    const getLastBlockNumber = vi.fn(async () => 1234);
    const getNetworkInfo = vi.fn(async () => ({}));
    const getAddress = vi.fn(() => "unused");
    const report = await runDoctor({
      rpc: "https://node.example", walletSecret: "secret-value",
      adapterFactory: () => ({
        connect: async () => { throw new Error("connect refused"); },
        getAddress, getLastBlockNumber, getNetworkInfo,
      }),
    });
    expect(report.exitCode).toBe(3);
    expect(report.checks.filter((c) => c.id.startsWith("rpc."))).toEqual([{
      id: "rpc.reachable", status: "fail", summary: "Demos RPC check failed",
      data: { rpc: "https://node.example/" },
      detail: "connect refused",
      remediation: "Check the RPC URL and network reachability.",
    }]);
    expect(getLastBlockNumber).not.toHaveBeenCalled();
    expect(getNetworkInfo).not.toHaveBeenCalled();
    expect(getAddress).not.toHaveBeenCalled();
    expect(report.checks.find((c) => c.id === "wallet.identity")?.status).toBe("skip");
  });

  it("passes RPC reachability for block height 0", async () => {
    const report = await runDoctor({
      rpc: "https://node.example",
      adapterFactory: () => ({ connect: async () => {}, getAddress: () => "unused", getLastBlockNumber: async () => 0 }),
    });
    expect(report.checks.find((c) => c.id === "rpc.reachable")).toMatchObject({
      status: "pass", data: { lastBlockNumber: 0 },
    });
  });

  it("tells a loading node apart from a non-Demos endpoint", async () => {
    const report = await runDoctor({
      rpc: "https://node.example", walletSecret: "secret-value",
      adapterFactory: () => ({ connect: async () => {}, getAddress: () => "unused",
        getLastBlockNumber: async () => "STATE_NOT_READY" }),
    });
    expect(report.exitCode).toBe(3);
    expect(report.checks.find((c) => c.id === "rpc.reachable")).toEqual({
      id: "rpc.reachable", status: "fail", summary: "Demos node is not ready",
      data: { rpc: "https://node.example/" },
      detail: "getLastBlockNumber answered STATE_NOT_READY",
      remediation: "Wait for the Demos node to finish loading its state, then retry.",
    });
    expect(report.checks.find((c) => c.id === "wallet.identity")?.status).toBe("skip");
  });

  describe("node build revision", () => {
    const build = (nodeVersion: unknown) => async () => ({ forks: {}, nodeVersion });
    async function revision(getNetworkInfo?: (signal?: AbortSignal) => Promise<unknown>) {
      const report = await runDoctor({
        rpc: "https://node.example",
        adapterFactory: () => ({ connect: async () => {}, getAddress: () => "unused",
          getLastBlockNumber: async () => 7, ...(getNetworkInfo ? { getNetworkInfo } : {}) }),
      });
      // Revision warnings are advisory: the exit code stays that of the blocked checks.
      expect(report.exitCode).toBe(5);
      expect(report.checks.find((c) => c.id === "rpc.reachable")?.status).toBe("pass");
      return report.checks.find((c) => c.id === "rpc.node-revision");
    }
    const remediation =
      "Compare the node's Demos build with the verified revision before relying on this doctor's RPC verdict.";
    const other = "a".repeat(40);
    const NAME = "demos-node-software";
    const verified = { name: NAME, commit: VERIFIED_DEMOS_NODE_REVISION, version: "0.9.8" };

    it("pins the verified node package to kynesyslabs/node at the verified revision", () => {
      expect(VERIFIED_DEMOS_NODE_PACKAGE).toEqual({ name: NAME, version: "0.9.8" });
    });

    it("passes only for the verified commit, name and version with a clean build", async () => {
      expect(await revision(build({ ...verified, dirty: false })))
        .toEqual({
          id: "rpc.node-revision", status: "pass", summary: "Node reports the verified build revision",
          data: { verified: VERIFIED_DEMOS_NODE_REVISION, reported: { ...verified, dirty: false } },
        });
    });

    it.each([
      ["another version", { ...verified, version: "9.9.9", dirty: false }, { ...verified, version: "9.9.9", dirty: false }],
      ["no version", { name: NAME, commit: VERIFIED_DEMOS_NODE_REVISION, dirty: false },
        { ...verified, version: null, dirty: false }],
      ["another package name", { ...verified, name: "other-node", dirty: false },
        { ...verified, name: "other-node", dirty: false }],
      ["no package name", { commit: VERIFIED_DEMOS_NODE_REVISION, version: "0.9.8", dirty: false },
        { ...verified, name: null, dirty: false }],
    ])("warns for the verified commit with %s", async (_label, nodeVersion, reported) => {
      expect(await revision(build(nodeVersion))).toEqual({
        id: "rpc.node-revision", status: "warn",
        summary: "Node reports the verified revision under another package name or version",
        detail: `the verified build is ${NAME} 0.9.8`, remediation,
        data: { verified: VERIFIED_DEMOS_NODE_REVISION, reported },
      });
    });

    it.each([
      ["a different commit", { name: NAME, commit: other, version: "0.9.9", dirty: false },
        "Node reports a different build than the verified revision",
        { name: NAME, commit: other, version: "0.9.9", dirty: false }],
      ["uncommitted changes", { ...verified, dirty: true },
        "Node reports the verified revision with uncommitted changes",
        { ...verified, dirty: true }],
      ["no clean-build flag", { ...verified },
        "Node reports the verified revision but not whether its build is clean",
        { ...verified, dirty: null }],
      ["a short or malformed commit",
        { name: "Bad Name", commit: VERIFIED_DEMOS_NODE_REVISION.slice(0, 7), version: "x y", dirty: "no" },
        "Node build revision could not be compared with the verified revision",
        { name: null, commit: null, version: null, dirty: null }],
    ])("warns for %s and keeps only well-formed fields", async (_label, nodeVersion, summary, reported) => {
      expect(await revision(build(nodeVersion))).toEqual({
        id: "rpc.node-revision", status: "warn", summary, remediation,
        data: { verified: VERIFIED_DEMOS_NODE_REVISION, reported },
      });
    });

    it.each([
      ["no nodeVersion", async () => ({ forks: {} })],
      ["a transport error envelope", async () => ({ result: 500, response: new Error("POST https://node.example") })],
      ["a thrown error", async () => { throw new Error("socket hang up"); }],
    ])("warns when the node reports %s", async (_label, getNetworkInfo) => {
      expect(await revision(getNetworkInfo)).toEqual({
        id: "rpc.node-revision", status: "warn",
        summary: "Node build revision could not be compared with the verified revision", remediation,
        data: { verified: VERIFIED_DEMOS_NODE_REVISION, reported: null },
      });
    });

    it("skips when an injected adapter cannot read the build", async () => {
      expect(await revision()).toEqual({
        id: "rpc.node-revision", status: "skip", summary: "The adapter cannot read the node build revision",
      });
    });

    it.each([
      ["a prefixed commit", { commit: `x${VERIFIED_DEMOS_NODE_REVISION}`, version: "0.9.8", dirty: false }],
      ["a suffixed commit", { commit: `${VERIFIED_DEMOS_NODE_REVISION}\n`, version: "0.9.8", dirty: false }],
      ["an uppercase commit", { commit: VERIFIED_DEMOS_NODE_REVISION.toUpperCase(), version: "0.9.8", dirty: false }],
      ["a commit array", { commit: [VERIFIED_DEMOS_NODE_REVISION], version: "0.9.8", dirty: false }],
    ])("never echoes or accepts %s", async (_label, nodeVersion) => {
      expect(await revision(build(nodeVersion))).toEqual({
        id: "rpc.node-revision", status: "warn",
        summary: "Node build revision could not be compared with the verified revision", remediation,
        data: { verified: VERIFIED_DEMOS_NODE_REVISION, reported: { name: null, commit: null, version: "0.9.8", dirty: false } },
      });
    });

    it.each([
      ["a string", "x"], ["a number", 7], ["null", null],
    ])("reports no build for a nodeVersion that is %s", async (_label, nodeVersion) => {
      expect((await revision(build(nodeVersion)))?.data).toEqual({
        verified: VERIFIED_DEMOS_NODE_REVISION, reported: null,
      });
    });

    it("stops waiting for a node that never answers, cancels the call and still returns the report", async () => {
      vi.useFakeTimers();
      try {
        let settled = false;
        let signal: AbortSignal | undefined;
        const pending = revision((received?: AbortSignal) => {
          signal = received;
          return new Promise<never>(() => {});
        }).finally(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(RPC_CALL_TIMEOUT_MS - 1);
        expect(settled).toBe(false);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toEqual({
          id: "rpc.node-revision", status: "warn", summary: "Node did not report its build revision in time",
          detail: "getNetworkInfo did not answer within 5000 ms", remediation,
          data: { verified: VERIFIED_DEMOS_NODE_REVISION, reported: null },
        });
        expect(signal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears its deadline once the node answers", async () => {
      vi.useFakeTimers();
      try {
        const check = await revision(build({ ...verified, dirty: false }));
        expect(check?.status).toBe("pass");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("RPC call deadline", () => {
    const never = () => new Promise<never>(() => {});
    it.each([
      ["connect", "RPC endpoint did not answer within 5000 ms", "Demos RPC check failed"],
      ["getLastBlockNumber", "getLastBlockNumber did not answer within 5000 ms",
        "RPC endpoint did not answer the Demos block-height call"],
    ] as const)("fails RPC reachability when the node stalls %s, and cancels it", async (stalled, detail, summary) => {
      vi.useFakeTimers();
      try {
        const signals: Record<string, AbortSignal | undefined> = {};
        const getLastBlockNumber = vi.fn(async (signal?: AbortSignal) => {
          signals.getLastBlockNumber = signal;
          return stalled === "getLastBlockNumber" ? never() : 7;
        });
        const getNetworkInfo = vi.fn(async () => ({}));
        let settled = false;
        const pending = runDoctor({
          rpc: "https://node.example", walletSecret: "wallet-secret",
          adapterFactory: () => ({
            connect: async (signal?: AbortSignal) => {
              signals.connect = signal;
              if (stalled === "connect") await never();
            },
            getAddress: () => "unused", getLastBlockNumber, getNetworkInfo,
          }),
        }).finally(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(RPC_CALL_TIMEOUT_MS - 1);
        expect(settled).toBe(false);
        expect(signals[stalled]?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const report = await pending;
        expect(report.checks.find((c) => c.id === "rpc.reachable")).toEqual({
          id: "rpc.reachable", status: "fail", summary, detail,
          data: { rpc: "https://node.example/" },
          remediation: stalled === "connect"
            ? "Check the RPC URL and network reachability."
            : "Check that the RPC URL points at a reachable Demos node.",
        });
        expect(report.exitCode).toBe(3);
        expect(signals[stalled]?.aborted).toBe(true);
        expect(getLastBlockNumber).toHaveBeenCalledTimes(stalled === "connect" ? 0 : 1);
        expect(getNetworkInfo).not.toHaveBeenCalled();
        expect(report.checks.find((c) => c.id === "wallet.identity")?.status).toBe("skip");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("passes each call a live signal and reports a thrown connect failure as before", async () => {
      const received: Array<AbortSignal | undefined> = [];
      const ok = await runDoctor({
        rpc: "https://node.example",
        adapterFactory: () => ({
          connect: async (signal?: AbortSignal) => { received.push(signal); expect(signal?.aborted).toBe(false); },
          getAddress: () => "unused",
          getLastBlockNumber: async (signal?: AbortSignal) => {
            received.push(signal);
            expect(signal?.aborted).toBe(false);
            return 7;
          },
        }),
      });
      expect(ok.checks.find((c) => c.id === "rpc.reachable")?.status).toBe("pass");
      expect(received).toHaveLength(2);
      expect(received.every((signal) => signal instanceof AbortSignal)).toBe(true);
      const failed = await runDoctor({
        rpc: "https://node.example",
        adapterFactory: () => ({ connect: async () => { throw new Error("ECONNREFUSED"); }, getAddress: () => "unused" }),
      });
      expect(failed.checks.find((c) => c.id === "rpc.reachable")).toMatchObject({
        status: "fail", summary: "Demos RPC check failed", detail: "ECONNREFUSED",
      });
    });
  });

  it.each([
    ["v20.19.0", "pass"], ["v20.20.1", "pass"], ["v22.12.0", "pass"], ["v22.23.3", "pass"],
    ["v23.0.0", "pass"], ["v24.1.0", "pass"], ["v26.0.0", "pass"],
    ["v20.18.9", "fail"], ["v21.7.3", "fail"], ["v22.11.9", "fail"], ["v19.9.0", "fail"], ["not-a-version", "fail"],
  ])("classifies Node %s as %s", async (nodeVersion, status) => {
    const report = await runDoctor({ offline: true, nodeVersion });
    expect(report.checks.find((c) => c.id === "runtime.node")?.status).toBe(status);
  });

  it("fails when the compiled SDK version differs from package.json", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const raw = actual.readFileSync("package.json", "utf8");
    expect((JSON.parse(raw) as { version: string }).version).toBe(VERSION);
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => JSON.stringify({ ...JSON.parse(raw), version: "9.9.9" }));
    const report = await runDoctor({ offline: true });
    expect(report.exitCode).toBe(1);
    expect(report.checks.find((c) => c.id === "package.version")).toEqual({
      id: "package.version", status: "fail", summary: "SDK version differs from the installed package",
      data: { version: VERSION, packageVersion: "9.9.9" },
      remediation: "Reinstall the package so the compiled SDK and package.json versions agree.",
    });
    expect((await runDoctor({ offline: true })).checks.find((c) => c.id === "package.version")).toMatchObject({
      status: "pass", summary: "SDK version matches the installed package", data: { version: VERSION },
    });
  });

  it.each([["missing", undefined], ["not a string", 1]])("fails when package.json version is %s", async (_label, version) => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const pkg = JSON.parse(actual.readFileSync("package.json", "utf8")) as Record<string, unknown>;
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => JSON.stringify({ ...pkg, version }));
    const report = await runDoctor({ offline: true });
    expect(report.checks.find((c) => c.id === "package.version")).toMatchObject({
      status: "fail", data: { version: VERSION, packageVersion: null },
    });
  });

  it.each(["x402", "evm-erc20"])("classifies %s as needing external config", async (rail) => {
    const report = await runDoctor({ offline: true, rail });
    expect(report.checks.find((c) => c.id === "rail.availability")).toMatchObject({
      status: "warn", summary: "Rail requires external config to validate", data: { rail },
    });
  });

  it("fails unknown rails", async () => {
    const report = await runDoctor({ offline: true, rail: "mystery" });

    expect(report.exitCode).toBe(1);
    expect(report.checks.find((c) => c.id === "rail.availability")).toMatchObject({
      status: "fail", remediation: "Use pay-dem, x402, evm-erc20, or pay-d402.",
    });
  });

  it("reports pay-d402 as operator_gated (§9.4.4 vocabulary)", async () => {
    const report = await runDoctor({ offline: true, rail: "pay-d402" });

    const rail = report.checks.find((c) => c.id === "rail.availability");
    expect(rail).toEqual({
      id: "rail.availability", status: "warn", summary: "pay-d402 is experimental, not a supported live rail",
      data: { availability: "operator_gated" },
      detail: "demosdk 4.0.17 and later sign and broadcast real d402_payment transactions, so a preview settlement can move real DEM.",
    });
  });

  it("formats compact human output without tables", async () => {
    const report = await runDoctor({ offline: true });
    const text = formatDoctorText(report);

    expect(text).toContain("dacs doctor\n");
    expect(text).toContain("mode: offline\n");
    expect(text).toContain("storage.binding-resolution: blocked");
    expect(text).toContain("remediation: Track dacs-sdk #58");
    expect(text).not.toContain("|");
  });

  it("redacts standalone RPC URLs", () => {
    expect(redactRpcUrl("https://user:pass@example.com/a?token=1#secret")).toBe(
      "https://example.com/[redacted]?[redacted]#[redacted]",
    );
    expect(redactRpcUrl("https://eth-mainnet.g.alchemy.com/v2/API_KEY")).toBe(
      "https://eth-mainnet.g.alchemy.com/[redacted]",
    );
    expect(redactRpcUrl("not a url secret")).toBe("[redacted-invalid-rpc-url]");
  });
});
