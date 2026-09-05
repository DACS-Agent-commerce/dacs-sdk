import { Demos } from "@kynesyslabs/demosdk/websdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAgent,
  buildUnsafeManualAgent,
  createAgent,
} from "../../src/agent/Agent.js";
import type { AuthenticateDemosCciInput } from "../../src/identity/demosCci.js";
import type { SubstrateAdapter } from "../../src/substrate/SubstrateAdapter.js";

const SENTINEL = "wallet-secret-sentinel-never-expose";
const PRIMARY =
  "did:demos:agent:1111111111111111111111111111111111111111111111111111111111111111";
const RAW_GCR = {
  result: 200,
  response: {
    web2: {
      github: [{ username: "alice", userId: "42" }],
    },
  },
};
const FORBIDDEN_AUTHORITY_KEYS = new Set([
  "adapter",
  "raw",
  "secret",
  "sign",
  "broadcast",
  "transfer",
  "connectWallet",
]);

function inspectOwnGraph(root: unknown): {
  keys: Set<string>;
  strings: Set<string>;
} {
  const keys = new Set<string>();
  const strings = new Set<string>();
  const seen = new Set<object>();
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      strings.add(value);
      continue;
    }
    if ((typeof value !== "object" && typeof value !== "function") ||
        value === null || seen.has(value)) {
      continue;
    }
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "string") keys.add(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      // Never invoke accessors while inspecting an untrusted returned object.
      if (descriptor && "value" in descriptor) pending.push(descriptor.value);
    }
  }
  return { keys, strings };
}

function authorityBearingAdapter(identityRaw: unknown = null): SubstrateAdapter {
  return {
    raw: {
      secret: SENTINEL,
      tx: { broadcast: vi.fn() },
      transfer: vi.fn(),
    },
    secret: SENTINEL,
    connect: vi.fn(async () => undefined),
    getAddress: vi.fn(() => "0x" + "11".repeat(32)),
    sign: vi.fn(async () => new Uint8Array(64)),
    getPublicKey: vi.fn(async () => new Uint8Array(32)),
    anchor: vi.fn(),
    anchorAndWait: vi.fn(),
    anchorWriteOnce: vi.fn(),
    scanOwnAnchorsByNamePrefix: vi.fn(),
    anchorAddress: vi.fn(),
    resolveAnchorByName: vi.fn(),
    readAnchor: vi.fn(async () => null),
    proxyFetch: vi.fn(),
    resolveIdentity: vi.fn(async (ref: string) => ({ ref, raw: identityRaw })),
    findSubjectsByClaim: vi.fn(async () => []),
    transfer: vi.fn(),
  } as unknown as SubstrateAdapter;
}

describe("Agent wallet-authority boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not expose a wallet supplied to the default connected factory", async () => {
    vi.spyOn(Demos.prototype, "connect").mockResolvedValue(undefined as never);
    const connectWallet = vi.spyOn(Demos.prototype, "connectWallet")
      .mockResolvedValue("0xwriter" as never);
    const config = {
      demosRpc: "https://rpc.example",
      wallet: SENTINEL,
    };

    const pending = createAgent(config);
    config.wallet = "mutated-after-start";
    const agent = await pending;
    const inspected = inspectOwnGraph(agent);

    expect(connectWallet).toHaveBeenCalledWith(SENTINEL);
    expect(inspected.strings).not.toContain(SENTINEL);
    expect(inspected.strings).not.toContain(config.wallet);
    expect(Reflect.get(agent, "adapter")).toBeUndefined();
    expect(Reflect.get(agent, "raw")).toBeUndefined();
  });

  it("does not reflectively expose the adapter, raw client, or wallet sentinel", () => {
    const adapter = authorityBearingAdapter();
    const agent = buildAgent(adapter, {
      demosRpc: "https://rpc.example",
      wallet: SENTINEL,
    });

    const inspected = inspectOwnGraph(agent);
    expect(Object.isFrozen(agent)).toBe(true);
    expect(inspected.strings).not.toContain(SENTINEL);
    for (const key of FORBIDDEN_AUTHORITY_KEYS) {
      expect(inspected.keys, `unexpected authority key ${key}`).not.toContain(key);
    }
    expect(Reflect.get(agent, "adapter")).toBeUndefined();
    expect(Reflect.get(agent, "raw")).toBeUndefined();
  });

  it("rejects accessor-backed authority configuration without invoking it", () => {
    const adapter = authorityBearingAdapter();
    let walletReads = 0;
    let bindingReads = 0;
    const walletConfig = { demosRpc: "mem" } as Record<string, unknown>;
    Object.defineProperty(walletConfig, "wallet", {
      enumerable: true,
      get() {
        walletReads += 1;
        return SENTINEL;
      },
    });
    expect(() => buildAgent(adapter, walletConfig as never)).toThrow(
      "AgentConfig.wallet must be stable data",
    );
    expect(walletReads).toBe(0);

    const bindingConfig = { demosRpc: "mem" } as Record<string, unknown>;
    Object.defineProperty(bindingConfig, "bindings", {
      enumerable: true,
      get() {
        bindingReads += 1;
        return { adapter, secret: SENTINEL };
      },
    });
    expect(() => buildAgent(adapter, bindingConfig as never)).toThrow(
      "AgentConfig.bindings must be stable data",
    );
    expect(bindingReads).toBe(0);
  });

  it("keeps direct authority only on the explicitly unsafe/manual builder", () => {
    const adapter = authorityBearingAdapter();
    const manual = buildUnsafeManualAgent(adapter, {
      demosRpc: "https://rpc.example",
      wallet: SENTINEL,
    });

    expect(Object.isFrozen(manual)).toBe(true);
    expect(manual.adapter).toBe(adapter);
    expect(Reflect.get(buildAgent(adapter, { demosRpc: "mem" }), "adapter"))
      .toBeUndefined();
  });

  it("passes only owned identity data to the real authentication callback", async () => {
    const adapter = authorityBearingAdapter(RAW_GCR);
    let callbackCount = 0;
    const authenticateResolution = function (
      this: unknown,
      input: Readonly<AuthenticateDemosCciInput>,
    ) {
      callbackCount += 1;
      const receiver = inspectOwnGraph(this);
      const request = inspectOwnGraph(input);
      expect(this).not.toBe(adapter);
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(input.record)).toBe(true);
      expect(Object.isFrozen(input.raw)).toBe(true);
      expect(receiver.strings).not.toContain(SENTINEL);
      expect(request.strings).not.toContain(SENTINEL);
      // `raw` on this callback input is an owned JSON response, not the raw
      // Demos client. It must not carry any callable wallet capability.
      for (const key of [
        "adapter",
        "secret",
        "sign",
        "broadcast",
        "transfer",
        "connectWallet",
      ]) {
        expect(receiver.keys).not.toContain(key);
        expect(request.keys).not.toContain(key);
      }
      return {
        status: "authenticated" as const,
        subject: input.subject,
        observedAt: 1_700_000_040_000,
        authority: "demos:testnet",
      };
    };
    const demosCci = { authenticateResolution };
    const agent = buildAgent(adapter, {
      demosRpc: "https://rpc.example",
      demosCci,
    });
    // Even a post-construction mutation of the caller-owned dependency carrier
    // must not become the callback's implicit receiver.
    Object.assign(demosCci, {
      adapter,
      raw: Reflect.get(adapter, "raw"),
      secret: SENTINEL,
    });

    await expect(agent.resolveAuthenticatedIdentity(PRIMARY)).resolves.toMatchObject({
      status: "authenticated",
      provenance: {
        subject: PRIMARY,
        authority: "demos:testnet",
      },
    });
    expect(callbackCount).toBe(1);
  });
});
