// The write-attempt guard against demosdk's real call paths: a transport double at Axios's adapter answers
// like a node, so every check below sits at a real demosdk await or adapter boundary. No key fixture.
import { createServer } from "node:http";
import { Demos } from "@kynesyslabs/demosdk/websdk";
import axios, { type AxiosAdapter } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installWriteAttemptGuard, WriteAttemptInstallError, WriteAttemptRefusedError } from "../src/substrate/writeAttemptGuard.js";

const NODE_URL = "http://node.test";
const RECIPIENT = `0x${"ab".repeat(32)}`;
const WALLET_SEED = new Uint8Array(32).fill(7);
const NETWORK_INFO = { forks: { osDenomination: { activated: true }, signatureDomain: { activated: false } }, chainId: 1 };
const stockAdapter = axios.defaults.adapter;

interface Post { method: string; message?: string; extra?: string }
type Reply = (post: Post) => unknown;

function nodeReply(post: Post): unknown {
  if (post.message === "getNetworkParameters") return { result: 200, response: { networkFee: 1, rpcFee: 0 } };
  if (post.message === "getNetworkInfo") return { result: 200, response: NETWORK_INFO };
  if (post.extra === "confirmTx") return { result: 200, response: { data: { valid: true } } };
  if (post.extra === "broadcastTx") return { result: 200, response: "{}" };
  return { result: 200, response: {} };
}

/** Puts a transport double at Axios's default adapter. It records each POST body and answers with `reply`. */
function nodeDouble(reply: Reply = nodeReply): { posts: Post[]; writes: () => Post[] } {
  const posts: Post[] = [];
  const adapter: AxiosAdapter = async (config) => {
    const body = JSON.parse(String(config.data));
    const content = body.params?.[0] ?? {};
    const post = { method: body.method, message: content.message, extra: content.extra };
    posts.push(post);
    return { data: await reply(post), status: 200, statusText: "OK", headers: {}, config };
  };
  axios.defaults.adapter = adapter;
  return { posts, writes: () => posts.filter((post) => post.method !== "nodeCall") };
}

async function connectedWallet(options?: { algorithm: "falcon" }): Promise<Demos> {
  const demos = new Demos();
  Reflect.set(demos, "rpc_url", NODE_URL);
  demos.connected = true;
  await demos.connectWallet(WALLET_SEED, options);
  return demos;
}

/** Counts the wallet's low-level signatures; the guard wraps this counter, so it counts only signatures it allowed. */
function countSignatures(demos: Demos, onSign: () => void = () => undefined): { count: number } {
  const counter = { count: 0 };
  const sign = demos.crypto.sign.bind(demos.crypto);
  demos.crypto.sign = (algorithm, data) => {
    counter.count += 1;
    onSign();
    return sign(algorithm, data);
  };
  return counter;
}

/** demosdk's private transport: one POST of `request`, with its own retries. */
function directPost(demos: Demos, request: unknown, opts: { baseSleepMs?: number } = {}): Promise<unknown> {
  const doPost: unknown = Reflect.get(demos, "_doPost");
  if (typeof doPost !== "function") throw new Error("demosdk has no _doPost");
  return Reflect.apply(doPost, demos, [NODE_URL, request, { "Content-Type": "application/json" }, opts]);
}

const WRITE_REQUEST = { method: "execute", params: [{ type: "execute", message: "", data: {}, extra: "confirmTx" }] };

function nativeSend(demos: Demos) {
  const tx = demos.tx.empty();
  tx.content.to = RECIPIENT;
  tx.content.type = "native";
  tx.content.amount = 1;
  tx.content.nonce = 1;
  tx.content.data = ["native", { nativeOperation: "send", args: [RECIPIENT, 1] }];
  return tx;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Yields to the event loop until `condition` holds; fails after a bounded number of turns. */
async function turnsUntil(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 1000 && !condition(); turn += 1) await new Promise((next) => setImmediate(next));
  if (!condition()) throw new Error("condition never held");
}

/** A guard that throws `stop` on its `refuseOnCall`-th call (or always, from 1), counting calls. */
function guardRefusingAt(refuseOnCall: number, stop: unknown): { guard: () => void; calls: () => number } {
  let calls = 0;
  return {
    guard: () => {
      calls += 1;
      if (calls >= refuseOnCall) throw stop;
    },
    calls: () => calls,
  };
}

const requestHandlers = (): unknown[] => {
  const handlers: unknown = Reflect.get(axios.interceptors.request, "handlers");
  return Array.isArray(handlers) ? [...handlers] : [];
};

function slots(demos: Demos) {
  return {
    own: Object.getOwnPropertyDescriptors(demos),
    crypto: Object.getOwnPropertyDescriptors(demos.crypto),
    tx: Object.getOwnPropertyDescriptors(demos.tx),
    handlers: requestHandlers(),
  };
}

async function installRefusal(run: () => void): Promise<string | undefined> {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WriteAttemptInstallError);
    return error instanceof WriteAttemptInstallError ? error.code : undefined;
  }
  return undefined;
}

beforeEach(() => {
  // demosdk logs fee derivation and its RPC envelope errors; the assertions below check behaviour, not logs.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  axios.defaults.adapter = stockAdapter;
  vi.restoreAllMocks();
});

describe("the late check before each signature", () => {
  it("a guard refusal after the last transaction preparation await prevents the first signature", async () => {
    const networkInfo = deferred<unknown>();
    const node = nodeDouble((post) => (post.message === "getNetworkInfo" ? networkInfo.promise : nodeReply(post)));
    const demos = await connectedWallet();
    const signatures = countSignatures(demos);
    const stop = new Error("stop marker");
    let stopped = false;
    installWriteAttemptGuard(demos, () => {
      if (stopped) throw stop;
    });

    const signing = demos.sign(nativeSend(demos));
    await turnsUntil(() => node.posts.some((post) => post.message === "getNetworkInfo"));
    stopped = true;
    networkInfo.resolve({ result: 200, response: NETWORK_INFO });

    await expect(signing).rejects.toBe(stop);
    expect(signatures.count).toBe(0);
  });

  it("a guard refusal after message preparation prevents the message signature", async () => {
    nodeDouble();
    const demos = await connectedWallet();
    const signatures = countSignatures(demos);
    const identity = deferred<void>();
    let preparing = false;
    const getIdentity = demos.crypto.getIdentity.bind(demos.crypto);
    demos.crypto.getIdentity = async (algorithm) => {
      preparing = true;
      await identity.promise;
      return getIdentity(algorithm);
    };
    const stop = new Error("stop marker");
    let stopped = false;
    installWriteAttemptGuard(demos, () => {
      if (stopped) throw stop;
    });

    const signing = demos.signMessage("hello");
    await turnsUntil(() => preparing);
    stopped = true;
    identity.resolve();

    await expect(signing).rejects.toBe(stop);
    expect(signatures.count).toBe(0);
  });
});

describe("the late check before each POST attempt of a write", () => {
  it("a guard refusal before confirmTx and broadcastTx prevents each network attempt", async () => {
    const node = nodeDouble();
    const stop = new Error("stop marker");
    const confirming = await connectedWallet();
    // Check 1 is the auth signature of confirmTx, check 2 its POST.
    installWriteAttemptGuard(confirming, guardRefusingAt(2, stop).guard);
    await expect(confirming.confirm(nativeSend(confirming))).rejects.toBe(stop);
    expect(node.writes().filter((post) => post.extra === "confirmTx")).toHaveLength(0);

    const broadcasting = await connectedWallet();
    const signatures = countSignatures(broadcasting);
    // Checks 1 and 2 let confirmTx through; check 3 is broadcastTx's auth signature, check 4 its POST.
    installWriteAttemptGuard(broadcasting, guardRefusingAt(4, stop).guard);
    const validity = await broadcasting.confirm(nativeSend(broadcasting));
    expect(node.writes().filter((post) => post.extra === "confirmTx")).toHaveLength(1);
    await expect(broadcasting.broadcast(validity)).rejects.toBe(stop);
    expect(node.writes().filter((post) => post.extra === "broadcastTx")).toHaveLength(0);
    expect(signatures.count).toBe(2);
  });

  it("a guard flip after a failed POST prevents the transport retry", async () => {
    let stopped = false;
    const node = nodeDouble((post) => {
      if (post.method !== "nodeCall") {
        // The first attempt fails with a retryable error; the stop marker appears before demosdk's backoff ends.
        stopped = true;
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      }
      return nodeReply(post);
    });
    const demos = await connectedWallet();
    const stop = new Error("stop marker");
    let guardCalls = 0;
    installWriteAttemptGuard(demos, () => {
      guardCalls += 1;
      if (stopped) throw stop;
    });

    await expect(demos.rpcCall({ method: "execute", params: [] }, false, 0, 1)).rejects.toBe(stop);
    expect(node.writes()).toHaveLength(1);
    expect(guardCalls).toBe(2);
  });

  it("a guard flip after an RPC result prevents the application retry", async () => {
    let stopped = false;
    const node = nodeDouble((post) => {
      if (post.method === "nodeCall") return nodeReply(post);
      stopped = true;
      return { result: 400, response: "not yet" };
    });
    const demos = await connectedWallet();
    const signatures = countSignatures(demos);
    const stop = new Error("stop marker");
    installWriteAttemptGuard(demos, () => {
      if (stopped) throw stop;
    });

    await expect(demos.rpcCall({ method: "execute", params: [] }, true, 1, 1)).rejects.toBe(stop);
    expect(signatures.count).toBe(1);
    expect(node.writes()).toHaveLength(1);
  });

  it("the untouched stock Axios adapter sends after the guarded check", async () => {
    let received = 0;
    const server = createServer((request, response) => {
      received += 1;
      request.resume();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ result: 200, response: {} }));
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    try {
      expect(axios.defaults.adapter).toEqual(["xhr", "http", "fetch"]);
      const address = server.address();
      if (typeof address !== "object" || address === null) throw new Error("the local endpoint has no port");
      const url = `http://127.0.0.1:${address.port}`;
      const passing = await connectedWallet();
      Reflect.set(passing, "rpc_url", url);
      installWriteAttemptGuard(passing, () => undefined);
      await expect(passing.rpcCall({ method: "execute", params: [] })).resolves.toEqual({ result: 200, response: {} });
      expect(received).toBe(1);

      const refusing = await connectedWallet();
      Reflect.set(refusing, "rpc_url", url);
      const stop = new Error("stop marker");
      installWriteAttemptGuard(refusing, () => {
        throw stop;
      });
      await expect(refusing.rpcCall({ method: "execute", params: [] })).rejects.toBe(stop);
      expect(received).toBe(1);
    } finally {
      await new Promise((closed) => server.close(closed));
    }
  });
});

describe("what a refusal looks like to the caller", () => {
  it("guard refusals escape RPC envelopes unchanged and ordinary demosdk errors keep their causes", async () => {
    const node = nodeDouble();
    const refusal = new WriteAttemptRefusedError({ cause: "stop marker unreadable" });
    // Each run's last check is the POST of its write: an auth signature check comes first.
    const runs: Array<{ refuseOnCall: number; run: (demos: Demos) => Promise<unknown> }> = [
      { refuseOnCall: 2, run: (demos) => demos.call("execute", "", {}, "confirmTx") },
      { refuseOnCall: 2, run: (demos) => demos.confirm(nativeSend(demos)) },
      { refuseOnCall: 4, run: async (demos) => demos.broadcast(await demos.confirm(nativeSend(demos))) },
      { refuseOnCall: 2, run: (demos) => demos.rpcCall({ method: "execute", params: [] }, true) },
    ];
    for (const { refuseOnCall, run } of runs) {
      const demos = await connectedWallet();
      installWriteAttemptGuard(demos, guardRefusingAt(refuseOnCall, refusal).guard);
      await expect(run(demos)).rejects.toBe(refusal);
    }
    expect(node.writes()).toEqual([{ method: "execute", message: "", extra: "confirmTx" }]);
    expect(refusal.cause).toBe("stop marker unreadable");

    const badRequest = Object.assign(new Error("bad request"), { response: { status: 400 } });
    nodeDouble((post) => {
      if (post.method === "nodeCall") return nodeReply(post);
      throw badRequest;
    });
    const guarded = await connectedWallet();
    installWriteAttemptGuard(guarded, () => undefined);
    const unguarded = await connectedWallet();
    for (const demos of [guarded, unguarded]) {
      const result = await demos.call("execute", "", {}, "confirmTx");
      expect(result).toMatchObject({ result: 500, response: { name: "TransportError", cause: badRequest } });
    }
  });

  it("callback throws pass unchanged through both RPC wrappers", async () => {
    const node = nodeDouble();
    const sentinel = Symbol("stop marker");
    const typed = new WriteAttemptRefusedError();
    for (const thrown of [sentinel, typed]) {
      const calling = await connectedWallet();
      const callGuard = guardRefusingAt(2, thrown);
      installWriteAttemptGuard(calling, callGuard.guard);
      await expect(calling.call("execute", "", {}, "broadcastTx")).rejects.toBe(thrown);
      expect(callGuard.calls()).toBe(2);

      const rpc = await connectedWallet();
      const rpcGuard = guardRefusingAt(2, thrown);
      installWriteAttemptGuard(rpc, rpcGuard.guard);
      await expect(rpc.rpcCall({ method: "execute", params: [] }, true, 2, 1)).rejects.toBe(thrown);
      expect(rpcGuard.calls()).toBe(2);
    }
    expect(node.writes()).toHaveLength(0);
  });

  it("a retryable-shaped callback throw terminates a direct write POST", async () => {
    const shapes = [Object.assign(new Error("reset"), { code: "ECONNRESET" }), Object.assign(new Error("unavailable"), { response: { status: 503 } })];
    for (const thrown of shapes) {
      const node = nodeDouble();
      const demos = await connectedWallet();
      const signatures = countSignatures(demos);
      let guardCalls = 0;
      installWriteAttemptGuard(demos, () => {
        guardCalls += 1;
        if (guardCalls === 1) throw thrown;
      });
      await expect(directPost(demos, WRITE_REQUEST, { baseSleepMs: 1 })).rejects.toBe(thrown);
      expect(guardCalls).toBe(1);
      expect(node.posts).toHaveLength(0);
      expect(signatures.count).toBe(0);
    }
  });

  it("only a void guard return passes the final attempt check", async () => {
    const node = nodeDouble();
    const passing = await connectedWallet();
    const passed = countSignatures(passing);
    installWriteAttemptGuard(passing, () => undefined);
    await passing.signMessage("hello");
    await directPost(passing, WRITE_REQUEST);
    expect(passed.count).toBe(1);
    expect(node.writes()).toHaveLength(1);

    for (const verdict of [false, true, Promise.resolve(), 0, "", "ok", null, {}]) {
      const demos = await connectedWallet();
      const signatures = countSignatures(demos);
      Reflect.apply(installWriteAttemptGuard, undefined, [demos, () => verdict]);
      await expect(demos.signMessage("hello")).rejects.toMatchObject({ name: "WriteAttemptRefusedError", code: "write_attempt_refused" });
      await expect(directPost(demos, WRITE_REQUEST)).rejects.toBeInstanceOf(WriteAttemptRefusedError);
      expect(signatures.count).toBe(0);
    }
    expect(node.writes()).toHaveLength(1);
  });
});

describe("installation", () => {
  it("installation rejects duplicate, invalid instance and non-function guard before patching", async () => {
    const demos = await connectedWallet();
    const before = slots(demos);
    expect(await installRefusal(() => Reflect.apply(installWriteAttemptGuard, undefined, [demos, "yes"]))).toBe("write_attempt_install_invalid");
    expect(slots(demos)).toEqual(before);

    const lookalike = { ...demos, walletConnected: true, algorithm: "ed25519" };
    expect(await installRefusal(() => Reflect.apply(installWriteAttemptGuard, undefined, [lookalike, () => undefined]))).toBe("write_attempt_install_invalid");
    expect(await installRefusal(() => installWriteAttemptGuard(new Demos(), () => undefined))).toBe("write_attempt_install_invalid");
    expect(slots(demos)).toEqual(before);

    installWriteAttemptGuard(demos, () => undefined);
    const installed = slots(demos);
    expect(await installRefusal(() => installWriteAttemptGuard(demos, () => undefined))).toBe("write_attempt_already_installed");
    expect(slots(demos)).toEqual(installed);
  });

  it("installation rejects a missing method or unreviewed demosdk shape before any write", async () => {
    const node = nodeDouble();
    const missing = await connectedWallet();
    Object.defineProperty(missing, "broadcastAndWait", { value: undefined, writable: true, configurable: true });
    const before = slots(missing);
    expect(await installRefusal(() => installWriteAttemptGuard(missing, () => undefined))).toBe("write_attempt_surface_missing");
    expect(slots(missing)).toEqual(before);

    const aliasless = await connectedWallet();
    Reflect.set(aliasless, "transactions", {});
    const aliaslessBefore = slots(aliasless);
    expect(await installRefusal(() => installWriteAttemptGuard(aliasless, () => undefined))).toBe("write_attempt_surface_missing");
    expect(slots(aliasless)).toEqual(aliaslessBefore);

    const copied = Object.create(null);
    for (const key of ["sign", "signMessage", "call", "rpcCall", "_doPost", "confirm", "broadcast", "broadcastAndWait"]) copied[key] = Reflect.get(missing, key);
    Object.assign(copied, { crypto: missing.crypto, tx: missing.tx, walletConnected: true, algorithm: "ed25519" });
    expect(await installRefusal(() => Reflect.apply(installWriteAttemptGuard, undefined, [copied, () => undefined]))).toBe("write_attempt_install_invalid");
    expect(node.posts).toHaveLength(0);
  });

  it("installation rejects an incompatible Axios ordering without partial installation", async () => {
    const demos = await connectedWallet();
    const before = slots(demos);
    const handlers: unknown = Reflect.get(axios.interceptors.request, "handlers");
    if (!Array.isArray(handlers)) throw new Error("Axios keeps no request handler list");
    // An interceptor registered ahead of the guard's would run after it, so it could swap the guarded adapter back.
    handlers.unshift({ fulfilled: (config: unknown) => config, rejected: undefined, synchronous: true, runWhen: null });
    try {
      const earlier = slots(demos);
      expect(await installRefusal(() => installWriteAttemptGuard(demos, () => undefined))).toBe("write_attempt_install_invalid");
      expect(slots(demos)).toEqual(earlier);
    } finally {
      handlers.shift();
    }
    expect(slots(demos)).toEqual(before);

    for (const layout of [() => (axios.defaults.adapter = "http"), () => (axios.defaults.adapter = ["http"])]) {
      layout();
      expect(await installRefusal(() => installWriteAttemptGuard(demos, () => undefined))).toBe("write_attempt_install_invalid");
      expect(slots(demos)).toEqual(before);
      axios.defaults.adapter = stockAdapter;
    }

    const transitional = axios.defaults.transitional;
    axios.defaults.transitional = { ...transitional, legacyInterceptorReqResOrdering: false };
    try {
      expect(await installRefusal(() => installWriteAttemptGuard(demos, () => undefined))).toBe("write_attempt_install_invalid");
      expect(slots(demos)).toEqual(before);
    } finally {
      axios.defaults.transitional = transitional;
    }
  });

  it("installation rolls back a failed property definition", async () => {
    const node = nodeDouble();
    const demos = await connectedWallet();
    let rejecting = true;
    // `tx` is patched after the instance methods and the signer, so this fails part-way through.
    demos.tx = new Proxy(demos.tx, {
      defineProperty: (target, key, descriptor) => (rejecting ? false : Reflect.defineProperty(target, key, descriptor)),
    });
    const before = slots(demos);
    expect(await installRefusal(() => installWriteAttemptGuard(demos, () => undefined))).toBe("write_attempt_install_invalid");
    expect(slots(demos)).toEqual(before);
    expect(Object.hasOwn(demos, "sign")).toBe(false);
    expect(Object.hasOwn(demos.crypto, "sign")).toBe(false);

    rejecting = false;
    const stop = new Error("stop marker");
    installWriteAttemptGuard(demos, () => {
      throw stop;
    });
    await expect(directPost(demos, WRITE_REQUEST)).rejects.toBe(stop);
    expect(node.posts).toHaveLength(0);
  });
});

describe("what the guard leaves alone and what it refuses outright", () => {
  it("an unguarded instance and unsigned reads are not intercepted", async () => {
    const node = nodeDouble();
    const guarded = await connectedWallet();
    const unguarded = await connectedWallet();
    const stop = new Error("stop marker");
    let guardCalls = 0;
    installWriteAttemptGuard(guarded, () => {
      guardCalls += 1;
      throw stop;
    });

    const [refused, sent] = await Promise.allSettled([directPost(guarded, WRITE_REQUEST), directPost(unguarded, WRITE_REQUEST)]);
    expect(refused).toEqual({ status: "rejected", reason: stop });
    expect(sent).toMatchObject({ status: "fulfilled" });
    expect(node.writes()).toHaveLength(1);
    expect(guardCalls).toBe(1);

    await expect(guarded.nodeCall("getLastBlockNumber")).resolves.toEqual({});
    await expect(directPost(guarded, { method: "nodeCall", params: [{ message: "getPeerlist" }] })).resolves.toEqual({ data: { result: 200, response: {} } });
    expect(node.posts.filter((post) => post.method === "nodeCall")).toHaveLength(2);
    expect(guardCalls).toBe(1);
  });

  it("the guarded instance refuses another signing algorithm at install and at attempt", async () => {
    const node = nodeDouble();
    const falcon = await connectedWallet({ algorithm: "falcon" });
    expect(await installRefusal(() => installWriteAttemptGuard(falcon, () => undefined))).toBe("write_attempt_install_invalid");

    const demos = await connectedWallet();
    let guardCalls = 0;
    let flipped = false;
    // A signer that, if it were ever entered, would flip the guard to refuse during its own await.
    const signatures = countSignatures(demos, () => {
      flipped = true;
    });
    installWriteAttemptGuard(demos, () => {
      guardCalls += 1;
      if (flipped) throw new Error("stop marker");
    });
    const unsupported = { name: "WriteAttemptRefusedError", code: "write_attempt_unsupported_signer" };
    await expect(demos.signMessage("hello", { algorithm: "falcon" })).rejects.toMatchObject(unsupported);
    await expect(demos.crypto.sign("ml-dsa", new Uint8Array([1, 2, 3]))).rejects.toMatchObject(unsupported);

    demos.algorithm = "falcon";
    await expect(demos.crypto.sign("ed25519", new Uint8Array([1, 2, 3]))).rejects.toMatchObject(unsupported);
    await expect(directPost(demos, WRITE_REQUEST)).rejects.toMatchObject(unsupported);
    expect(signatures.count).toBe(0);
    expect(guardCalls).toBe(0);
    expect(node.writes()).toHaveLength(0);
  });

  it("transaction builders and alias signers cannot bypass the installed guard", async () => {
    nodeDouble();
    const demos = await connectedWallet();
    const signatures = countSignatures(demos);
    const sharedTransactions = demos.transactions;
    const sharedSigners = [sharedTransactions.sign, sharedTransactions.signWithAlgorithm];
    const stop = new Error("stop marker");
    let refusing = true;
    installWriteAttemptGuard(demos, () => {
      if (refusing) throw stop;
    });

    await expect(demos.tx.sign(nativeSend(demos))).rejects.toBe(stop);
    await expect(demos.tx.pay(RECIPIENT, 1, demos, { nonce: 1 })).rejects.toBe(stop);
    expect(signatures.count).toBe(0);

    refusing = false;
    const keypair = demos.keypair;
    const unsupported = { name: "WriteAttemptRefusedError", code: "write_attempt_unsupported_signer" };
    const aliases = [
      () => demos.tx.signWithAlgorithm("hello", keypair, { algorithm: "ed25519" }),
      () => demos.transactions.sign(nativeSend(demos), keypair, { algorithm: "ed25519" }),
      () => demos.transactions.signWithAlgorithm("hello", keypair, { algorithm: "ed25519" }),
      () => demos.DemosTransactions.sign(nativeSend(demos), keypair, { algorithm: "ed25519" }),
      () => demos.DemosTransactions.signWithAlgorithm("hello", keypair, { algorithm: "ed25519" }),
    ];
    for (const alias of aliases) await expect(alias()).rejects.toMatchObject(unsupported);
    expect([sharedTransactions.sign, sharedTransactions.signWithAlgorithm]).toEqual(sharedSigners);
    expect(demos.transactions).not.toBe(sharedTransactions);
    await expect(demos.tx.sign(nativeSend(demos))).resolves.toMatchObject({ signature: { type: "ed25519" } });
    expect(signatures.count).toBe(1);
  });
});
