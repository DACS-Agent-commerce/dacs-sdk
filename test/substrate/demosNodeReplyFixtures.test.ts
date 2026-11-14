import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DemosAdapter } from "../../src/substrate/index.js";
import nodeBuildPin from "../../src/substrate/demosNodeBuild.json" with { type: "json" };

const FIXTURE_DIR = new URL("./fixtures/demos-node-replies/", import.meta.url);
const RPC = "https://node2.demos.sh";
const COMMIT_NAME = "dacs3:commit:01M5Y3MEF9CHTJS67KDBTMB140";
const COMMIT_ADDRESS = "stor-cffaa62d9cef33e5b2257dd1417dc150e624cd78";

interface RecordedReply {
  recording: {
    capturedAt: string;
    node: { version: string; commit: string };
    request: string;
    httpStatus: number;
    scrubbed: string[];
  };
  body: Record<string, unknown>;
}

function loadFixture(name: string): RecordedReply {
  return JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), "utf8")) as RecordedReply;
}

function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".json")).sort();
}

function fetchRecording(fixture: RecordedReply) {
  return vi.fn(async () => new Response(JSON.stringify(fixture.body), {
    status: fixture.recording.httpStatus,
    headers: { "content-type": "application/json" },
  }));
}

function connectedAdapter(address: string): DemosAdapter {
  const adapter = new DemosAdapter({ rpc: RPC, chainIdentity: "test-chain" });
  vi.spyOn(adapter, "getChainIdentityDetails").mockResolvedValue({
    chainId: null, genesisHash: "test-chain", genesisDataHash: null, source: "genesis-read",
  });
  Object.assign(adapter, { connected: true });
  vi.spyOn(adapter.raw, "getAddress").mockReturnValue(address);
  return adapter;
}

function notFoundError(fixture: RecordedReply): Error {
  return Object.assign(new Error("Request failed with status code 404"), {
    response: { status: fixture.recording.httpStatus, data: fixture.body },
  });
}

describe("pinned Demos node build", () => {
  it("names the version, raw commit, bare sha, capture date and source", () => {
    expect(nodeBuildPin.version).toMatch(/\S/);
    expect(nodeBuildPin.commit.endsWith(nodeBuildPin.commitSha)).toBe(true);
    expect(nodeBuildPin.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(nodeBuildPin.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(nodeBuildPin.source).toBe("https://node2.demos.sh/version");
  });

  it("links to the node repository at the pinned commit", () => {
    expect(nodeBuildPin.repository).toBe(
      `https://github.com/kynesyslabs/node/commit/${nodeBuildPin.commitSha}`,
    );
  });
});

describe("recorded Demos node replies", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("records the pinned node build and capture date in every fixture", () => {
    const names = fixtureNames();
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const name of names) {
      const { recording } = loadFixture(name);
      expect(recording.node, name).toEqual({
        version: nodeBuildPin.version,
        commit: nodeBuildPin.commit,
      });
      expect(recording.capturedAt, name).toBe(nodeBuildPin.capturedAt);
    }
  });

  it("holds no secret-like material in any fixture", () => {
    for (const name of fixtureNames()) {
      const text = readFileSync(new URL(name, FIXTURE_DIR), "utf8");
      expect(text, name).not.toMatch(/mnemonic|secret|private|seed|token|password/i);
    }
    const found = loadFixture("storage-program-read-found.json");
    const signature = (found.body.data as { signature: { value: string } }).signature.value;
    expect(signature).toBe("A".repeat(signature.length));
  });

  it("sends the search request in the shape the node was recorded answering", async () => {
    const fetchMock = fetchRecording(loadFixture("search-exact-one-result.json"));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = connectedAdapter("0xWriter");

    await adapter.resolveAnchorByName(COMMIT_NAME, "0xWriter");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RPC);
    const request = JSON.parse(String(init.body)) as {
      method: string;
      params: Array<{ message: string; data: { query: string; options: Record<string, unknown> } }>;
    };
    expect(request.method).toBe("nodeCall");
    expect(request.params[0]?.message).toBe("searchStoragePrograms");
    expect(request.params[0]?.data.query).toBe("dacs3%3Acommit%3A01M5Y3MEF9CHTJS67KDBTMB140");
    expect(request.params[0]?.data.options).toMatchObject({ exactMatch: true, offset: 0 });
  });

  it("resolves a name to the recorded storage address when the recorded owner matches", async () => {
    const found = loadFixture("storage-program-read-found.json");
    vi.stubGlobal("fetch", fetchRecording(loadFixture("search-exact-one-result.json")));
    const adapter = connectedAdapter("0xWriter");
    vi.spyOn(adapter.raw.storagePrograms, "read").mockResolvedValue(found.body as never);

    await expect(
      adapter.resolveAnchorByName(COMMIT_NAME, found.body.owner as string),
    ).resolves.toEqual({ status: "present", address: COMMIT_ADDRESS });
  });

  it("reports a recorded empty search as absent", async () => {
    vi.stubGlobal("fetch", fetchRecording(loadFixture("search-no-results.json")));
    const adapter = connectedAdapter("0xWriter");

    await expect(
      adapter.resolveAnchorByName("dacs-fixture-no-such-program", "0xWriter"),
    ).resolves.toEqual({ status: "absent" });
  });

  it("scans a recorded prefix search and keeps only the anchor the recorded owner holds", async () => {
    const found = loadFixture("storage-program-read-found.json");
    vi.stubGlobal("fetch", fetchRecording(loadFixture("search-prefix-three-results.json")));
    const adapter = connectedAdapter(found.body.owner as string);
    vi.spyOn(adapter.raw.storagePrograms, "read").mockImplementation(async (address: string) =>
      (address === COMMIT_ADDRESS
        ? found.body
        : { success: true, owner: "0xSomeoneElse", programName: "other", data: {} }) as never);

    await expect(adapter.scanOwnAnchorsByNamePrefix("dacs")).resolves.toEqual({
      status: "ok",
      anchors: [
        {
          address: COMMIT_ADDRESS,
          programName: "dacs3%3Acommit%3A01M5Y3MEF9CHTJS67KDBTMB140",
          value: found.body.data,
        },
      ],
    });
  });

  it("treats the recorded not-found read as an absent anchor", async () => {
    const missing = loadFixture("storage-program-read-not-found.json");
    const adapter = connectedAdapter("0xWriter");
    vi.spyOn(adapter.raw.storagePrograms, "read").mockRejectedValue(notFoundError(missing));

    await expect(
      adapter.readAnchor("stor-0000000000000000000000000000000000000000"),
    ).resolves.toBeNull();
  });

  it("refuses a search reply whose response list was renamed", async () => {
    const recorded = loadFixture("search-prefix-three-results.json");
    const { response, ...rest } = recorded.body;
    vi.stubGlobal("fetch", fetchRecording({ ...recorded, body: { ...rest, results: response } as RecordedReply["body"] }));
    const adapter = connectedAdapter("0xWriter");

    await expect(adapter.scanOwnAnchorsByNamePrefix("dacs")).resolves.toEqual({
      status: "indeterminate",
      reason: expect.stringMatching(/invalid RPC response/),
    });
  });

  it("refuses a search row whose program name field was renamed", async () => {
    const recorded = loadFixture("search-exact-one-result.json");
    const rows = (recorded.body.response as Array<Record<string, unknown>>).map(
      ({ programName, ...row }) => ({ ...row, name: programName }),
    );
    vi.stubGlobal("fetch", fetchRecording({ ...recorded, body: { ...recorded.body, response: rows } }));
    const adapter = connectedAdapter("0xWriter");

    await expect(adapter.resolveAnchorByName(COMMIT_NAME, "0xWriter")).resolves.toEqual({
      status: "indeterminate",
      reason: expect.stringMatching(/malformed candidate/),
    });
  });
});
