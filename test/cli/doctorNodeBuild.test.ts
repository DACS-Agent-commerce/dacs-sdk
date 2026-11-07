import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatDoctorText, runDoctor, type DoctorCheck, type DoctorReport } from "../../src/cli/index.js";
import nodeBuildPin from "../../src/substrate/demosNodeBuild.json" with { type: "json" };

const RPC = "https://node2.demos.sh";
const NODE_BUILD_CHECK = "node.build";
const UNKNOWN_SUMMARY = "node build unknown (no build RPC)";
const OTHER_SHA = "0123456789abcdef0123456789abcdef01234567";
const REPORT_EXIT_WITH_BLOCKED_CHECKS = 5;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

const recordedVersionReply = JSON.parse(readFileSync(
  new URL("../substrate/fixtures/demos-node-replies/node-version.json", import.meta.url),
  "utf8",
)) as { body: { version: string; commit: string } };

type FetchStub = ReturnType<typeof vi.fn<typeof fetch>>;

function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(reply: () => Promise<Response>): FetchStub {
  return vi.fn<typeof fetch>(reply);
}

async function doctorWith(fetchImpl: FetchStub, rpc = RPC): Promise<DoctorReport> {
  return runDoctor({
    rpc,
    fetchImpl,
    adapterFactory: () => ({ connect: async () => {}, getAddress: () => "unused" }),
  });
}

function nodeBuildCheck(report: DoctorReport): DoctorCheck {
  const found = report.checks.find((c) => c.id === NODE_BUILD_CHECK);
  if (!found) throw new Error("doctor report has no node.build check");
  return found;
}

describe("dacs doctor node build check", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes when the node commit equals the pin", async () => {
    const report = await doctorWith(stubFetch(async () => jsonReply(recordedVersionReply.body)));

    const check = nodeBuildCheck(report);
    expect(check.status).toBe("pass");
    expect(check.data).toMatchObject({
      version: nodeBuildPin.version,
      commit: nodeBuildPin.commitSha,
      pinned: nodeBuildPin.commitSha,
    });
    expect(report.exitCode).toBe(REPORT_EXIT_WITH_BLOCKED_CHECKS);
  });

  it("matches on the bare sha whatever branch label the node prefixes", async () => {
    const report = await doctorWith(stubFetch(async () => jsonReply({
      version: nodeBuildPin.version,
      commit: `<another-branch>${nodeBuildPin.commitSha.toUpperCase()}`,
    })));

    expect(nodeBuildCheck(report).status).toBe("pass");
  });

  it("warns, never fails, and keeps the exit code when the node commit differs from the pin", async () => {
    const report = await doctorWith(stubFetch(async () => jsonReply({
      version: "1.0.0",
      commit: `<stabilisation>${OTHER_SHA}`,
    })));

    const check = nodeBuildCheck(report);
    expect(check.status).toBe("warn");
    expect(check.data).toMatchObject({ commit: OTHER_SHA, pinned: nodeBuildPin.commitSha });
    expect(check.remediation).toContain(nodeBuildPin.repository);
    expect(report.exitCode).toBe(REPORT_EXIT_WITH_BLOCKED_CHECKS);
  });

  it("reports an unknown build when the node cannot be reached", async () => {
    const report = await doctorWith(stubFetch(async () => {
      throw new TypeError("fetch failed");
    }));

    const check = nodeBuildCheck(report);
    expect(check.status).toBe("skip");
    expect(check.summary).toBe(UNKNOWN_SUMMARY);
    expect(check.detail).toContain("fetch failed");
    expect(report.exitCode).toBe(REPORT_EXIT_WITH_BLOCKED_CHECKS);
  });

  it("keeps the underlying cause of a failed fetch in the detail", async () => {
    const report = await doctorWith(stubFetch(async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:9") });
    }));

    expect(nodeBuildCheck(report).detail).toContain("ECONNREFUSED");
  });

  it("reports an unknown build when the node has no /version endpoint", async () => {
    const report = await doctorWith(stubFetch(async () => jsonReply({ error: "not found" }, 404)));

    const check = nodeBuildCheck(report);
    expect(check.status).toBe("skip");
    expect(check.summary).toBe(UNKNOWN_SUMMARY);
    expect(check.detail).toContain("HTTP 404");
    expect(report.exitCode).toBe(REPORT_EXIT_WITH_BLOCKED_CHECKS);
  });

  it("reports an unknown build, not a match, when the reply has no usable commit", async () => {
    for (const body of [{ version: "0.9.9 RC" }, { commit: "<stabilisation>not-a-sha" }, ["e6af"], null]) {
      const check = nodeBuildCheck(await doctorWith(stubFetch(async () => jsonReply(body))));
      expect(check.status, JSON.stringify(body)).toBe("skip");
      expect(check.summary).toBe(UNKNOWN_SUMMARY);
    }
  });

  it("reports an unknown build when the reply is not JSON", async () => {
    const check = nodeBuildCheck(await doctorWith(stubFetch(async () => new Response("<html>"))));

    expect(check.status).toBe("skip");
    expect(check.summary).toBe(UNKNOWN_SUMMARY);
  });

  it("keeps reply bytes out of the detail and the output when the reply is not JSON", async () => {
    const hostile = "\u001b[2J\u001b[1;1H\u009b31m\u0007\u0000 forged line";
    const report = await doctorWith(stubFetch(async () => new Response(hostile)));

    const check = nodeBuildCheck(report);
    expect(check.status).toBe("skip");
    expect(check.detail).toBe("version reply is not JSON");
    expect(formatDoctorText(report).replace(/\n/g, "")).not.toMatch(CONTROL_CHARS);
    expect(JSON.parse(JSON.stringify(report)).checks.find((c: DoctorCheck) => c.id === NODE_BUILD_CHECK).detail)
      .not.toMatch(CONTROL_CHARS);
  });

  it("strips control characters from reply-derived text in the check and the output", async () => {
    const withControls = await doctorWith(stubFetch(async () => jsonReply({
      version: "1.2\u001b[2J.3\u0085",
      commit: `<x>${OTHER_SHA}`,
    })));
    const failed = await doctorWith(stubFetch(async () => {
      throw new TypeError("fetch failed\u001b[2J", { cause: new Error("bad\u009b31m\r\ncause") });
    }));

    expect(nodeBuildCheck(withControls).data).toMatchObject({ version: "1.2[2J.3", commit: OTHER_SHA });
    expect(nodeBuildCheck(failed).detail).toBe("fetch failed[2J: bad31mcause");
    for (const report of [withControls, failed]) {
      expect(formatDoctorText(report).replace(/\n/g, "")).not.toMatch(CONTROL_CHARS);
      expect(JSON.stringify(nodeBuildCheck(report))).not.toMatch(CONTROL_CHARS);
    }
  });

  it("reports a timeout, not a JSON error, when the deadline fires mid-body", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"version":"1.'));
      },
    })));

    const pending = doctorWith(fetchImpl);
    await vi.advanceTimersByTimeAsync(60_000);
    const check = nodeBuildCheck(await pending);

    expect(check.status).toBe("skip");
    expect(check.detail).toContain("timed out");
    expect(check.detail).not.toContain("JSON");
  });

  it("refuses an oversized reply by bytes before decoding it", async () => {
    const oversized = "x".repeat(1024 * 1024);
    const check = nodeBuildCheck(await doctorWith(stubFetch(async () => new Response(oversized))));

    expect(check.status).toBe("skip");
    expect(check.summary).toBe(UNKNOWN_SUMMARY);
    expect(check.detail).toContain("exceeds maxResponseBytes");
  });

  it("reads GET /version on the node origin with an abort signal and without credentials", async () => {
    const fetchImpl = stubFetch(async () => jsonReply(recordedVersionReply.body));

    const report = await doctorWith(fetchImpl, "https://user:pass@node.example/");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://node.example/version");
    expect(init.method ?? "GET").toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(nodeBuildCheck(report).status).toBe("pass");
    expect(JSON.stringify(report)).not.toContain("pass@");
  });

  it("skips without a /version request when the RPC URL is routed", async () => {
    for (const rpc of [
      "https://node.example/tenant/rpc",
      "https://user:pass@node.example/v2/path-secret?token=query-secret",
      "https://node.example/?tenant=a",
    ]) {
      const fetchImpl = stubFetch(async () => jsonReply(recordedVersionReply.body));

      const report = await doctorWith(fetchImpl, rpc);

      const check = nodeBuildCheck(report);
      expect(check.status, rpc).toBe("skip");
      expect(check.summary).toBe(UNKNOWN_SUMMARY);
      expect(check.detail).toContain("routed");
      expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/version")), rpc).toHaveLength(0);
      expect(JSON.stringify(report)).not.toContain("query-secret");
    }
  });

  it("skips when /version redirects instead of following it", async () => {
    const fetchImpl = stubFetch(async () => new Response(null, {
      status: 302,
      headers: { location: "https://other.example/version" },
    }));

    const check = nodeBuildCheck(await doctorWith(fetchImpl));

    expect(check.status).toBe("skip");
    expect(check.summary).toBe(UNKNOWN_SUMMARY);
    expect(check.detail).toContain("redirected");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up at the deadline and reports an unknown build", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));

    const pending = doctorWith(fetchImpl);
    await vi.advanceTimersByTimeAsync(60_000);
    const check = nodeBuildCheck(await pending);

    expect(check.status).toBe("skip");
    expect(check.summary).toBe(UNKNOWN_SUMMARY);
    expect(check.detail).toContain("timed out");
  });

  it("does not read the node build offline or without an RPC URL", async () => {
    const fetchImpl = stubFetch(async () => jsonReply(recordedVersionReply.body));

    const offline = await runDoctor({ offline: true, rpc: RPC, fetchImpl });
    const noRpc = await runDoctor({ fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(offline.checks.some((c) => c.id === NODE_BUILD_CHECK)).toBe(false);
    expect(noRpc.checks.some((c) => c.id === NODE_BUILD_CHECK)).toBe(false);
  });
});
