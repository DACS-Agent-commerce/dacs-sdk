import { describe, expect, test, vi } from "vitest";

import {
  createInMemoryBindingIndex,
  resolveAndRead,
  type AnchorBinding,
  type VerifiedReadDeps,
} from "../../src/discovery/index.js";

const SELLER = "0xseller";
const LOGICAL = "dacs1:0xseller:market-data:v1";

// A trivial deterministic "content hash" for tests: JSON of the record sans signature.
const contentHashOf = (r: Record<string, unknown>) => {
  const { signature: _sig, ...scope } = r;
  return `h:${JSON.stringify(scope)}`;
};

const RECORD = { serviceId: "market-data", price: "5", signature: "sig-real" };
const HASH = contentHashOf(RECORD);

const binding = (over: Partial<AnchorBinding> = {}): AnchorBinding => ({
  logicalAddress: LOGICAL,
  nativeAddress: "stor-real",
  owner: SELLER,
  contentHash: HASH,
  ...over,
});

/** Deps whose store maps native address → record. */
function depsWith(
  store: Record<string, Record<string, unknown>>,
  over: Partial<VerifiedReadDeps> = {},
): VerifiedReadDeps {
  return {
    read: async (addr) => store[addr] ?? null,
    contentHashOf,
    ...over,
  };
}

describe("resolveAndRead (#54 typed read-with-verification)", () => {
  test.each(["status", "reason", "code"] as const)(
    "indeterminate: a throwing %s accessor returns an owned diagnostic",
    async (field) => {
      for (const proxy of [false, true]) {
        const resolution = { status: "indeterminate", reason: "unavailable" };
        const getter = vi.fn(() => { throw new Error(`hostile ${field} getter`); });
        const hostile = proxy
          ? new Proxy(resolution, {
              get(target, key, receiver) {
                return key === field ? getter() : Reflect.get(target, key, receiver);
              },
            })
          : Object.defineProperty(resolution, field, { get: getter });
        const read = vi.fn(async () => RECORD);
        const verifySignature = vi.fn(() => true);
        await expect(resolveAndRead(
          { resolve: async () => hostile as never }, LOGICAL, SELLER,
          depsWith({}, { read, verifySignature }),
        )).resolves.toEqual({
          status: "indeterminate",
          reason: `binding resolution failed: hostile ${field} getter`,
        });
        expect(getter).toHaveBeenCalledOnce();
        expect(read).not.toHaveBeenCalled();
        expect(verifySignature).not.toHaveBeenCalled();
      }
    },
  );

  test.each([undefined, null, 7, {}, ["disagree"]])(
    "indeterminate: a malformed reason (%j) cannot claim a binding conflict",
    async (reason) => {
      const read = vi.fn(async () => RECORD);
      const verifySignature = vi.fn(() => true);
      await expect(resolveAndRead(
        { resolve: async () => ({ status: "indeterminate", reason, code: "binding-conflict" }) as never },
        LOGICAL, SELLER, depsWith({}, { read, verifySignature }),
      )).resolves.toEqual({
        status: "indeterminate",
        reason: "binding resolution failed: binding index returned an invalid reason",
      });
      expect(read).not.toHaveBeenCalled();
      expect(verifySignature).not.toHaveBeenCalled();
    },
  );

  test("indeterminate: an unknown index status cannot authorize a valid binding", async () => {
    const read = vi.fn(async () => RECORD);
    await expect(resolveAndRead(
      { resolve: async () => ({ status: "attacker-status", binding: binding() }) as never },
      LOGICAL, SELLER, depsWith({}, { read, verifySignature: () => true }),
    )).resolves.toEqual({
      status: "indeterminate",
      reason: "binding resolution failed: binding index returned an unknown status",
    });
    expect(read).not.toHaveBeenCalled();
  });

  // Values whose formatting throws: string coercion, a message getter, instanceof.
  const hostileErrors = (): [string, () => unknown][] => [
    ["a null-prototype object", () => Object.create(null)],
    ["an Error with a throwing message getter", () =>
      Object.defineProperty(new Error("hidden"), "message", {
        get() { throw new Error("message trap"); },
      })],
    ["a Proxy whose prototype lookup throws", () =>
      new Proxy(new Error("hidden"), {
        getPrototypeOf() { throw new Error("prototype trap"); },
      })],
  ];
  const throwing = (value: unknown) => () => { throw value; };

  test.each(hostileErrors())(
    "hostile thrown value (%s) never makes resolveAndRead reject",
    async (_name, make) => {
      const statusTrap = (value: unknown) => new Proxy({}, {
        get(_target, key) { return key === "status" ? throwing(value)() : undefined; },
      });
      const cases: [string, VerifiedReadDeps, Parameters<typeof resolveAndRead>[0]][] = [
        ["binding resolution failed",
          depsWith({ "stor-real": RECORD }),
          { resolve: async () => { throw make(); } }],
        ["binding resolution failed",
          depsWith({ "stor-real": RECORD }),
          { resolve: async () => statusTrap(make()) as never }],
        ["binding snapshot failed",
          depsWith({ "stor-real": RECORD }),
          { resolve: async () => ({ status: "present", get binding() { return throwing(make())(); } }) as never }],
        ["read of stor-real failed",
          depsWith({}, { read: async () => { throw make(); } }),
          createInMemoryBindingIndex([binding()])],
        ["read record snapshot failed",
          depsWith({}, { read: async () => ({ get field() { return throwing(make())(); } }) }),
          createInMemoryBindingIndex([binding()])],
        ["content hash computation failed",
          depsWith({ "stor-real": RECORD }, { contentHashOf: throwing(make()) as never }),
          createInMemoryBindingIndex([binding()])],
        ["signature verification threw",
          depsWith({ "stor-real": RECORD }, { verifySignature: throwing(make()) as never }),
          createInMemoryBindingIndex([binding()])],
      ];
      for (const [prefix, deps, index] of cases) {
        // Hash and verifier failures keep the record; earlier failures are retryable.
        const status = /^(content|signature)/.test(prefix) ? "unverifiable" : "indeterminate";
        await expect(resolveAndRead(index, LOGICAL, SELLER, deps))
          .resolves.toMatchObject({ status, reason: `${prefix}: unknown error` });
      }
    },
  );

  test("verified: binding resolves and the artifact-specific verifier authorizes the record", async () => {
    const index = createInMemoryBindingIndex([binding()]);
    const r = await resolveAndRead(index, LOGICAL, SELLER, depsWith(
      { "stor-real": RECORD },
      { verifySignature: (rec) => rec.signature === "sig-real" },
    ));
    expect(r.status).toBe("verified");
    if (r.status === "verified") expect(r.record).toEqual(RECORD);
  });

  test("preserves the catalog anchor kind through dereference", async () => {
    let observed: readonly [string, string | undefined] | undefined;
    const index = createInMemoryBindingIndex([
      binding({ anchorKind: "ipfs", nativeAddress: "same-locator" }),
    ]);
    const result = await resolveAndRead(index, LOGICAL, SELLER, {
      read: async (nativeAddress, anchorKind) => {
        observed = [nativeAddress, anchorKind];
        return RECORD;
      },
      contentHashOf,
      verifySignature: () => true,
    });

    expect(result.status).toBe("verified");
    expect(observed).toEqual(["same-locator", "ipfs"]);
  });

  test("FORGERY DEFENSE: a forged same-owner entry pointing at wrong bytes → hash-mismatch", async () => {
    // The forger copies the real owner (so the binding resolves) but points at
    // attacker-chosen bytes. The content-hash binding catches it — this is why
    // resolution is discovery, not trust.
    const forged = binding({ nativeAddress: "stor-forged" }); // still claims HASH
    const index = createInMemoryBindingIndex([forged]);
    const r = await resolveAndRead(index, LOGICAL, SELLER, depsWith({ "stor-forged": { evil: true } }));
    expect(r.status).toBe("hash-mismatch");
  });

  test("FORGERY DEFENSE: attacker-selected pointer, hash and bytes remain unverifiable", async () => {
    const evil = { owner: SELLER, payload: "attacker-controlled" };
    const forged = binding({
      nativeAddress: "stor-forged",
      contentHash: contentHashOf(evil),
    });
    const index = createInMemoryBindingIndex([forged]);
    const r = await resolveAndRead(index, LOGICAL, SELLER, depsWith({ "stor-forged": evil }));
    expect(r.status).toBe("unverifiable");
  });

  test("absent: no binding for this owner", async () => {
    const index = createInMemoryBindingIndex([binding({ owner: "0xother" })]);
    expect(await resolveAndRead(index, LOGICAL, SELLER, depsWith({}))).toEqual({ status: "absent" });
  });

  test("indeterminate: a conflicting binding is not silently picked", async () => {
    const index = createInMemoryBindingIndex([
      binding({ nativeAddress: "stor-a" }),
      binding({ nativeAddress: "stor-b" }),
    ]);
    const r = await resolveAndRead(index, LOGICAL, SELLER, depsWith({}));
    expect(r.status).toBe("indeterminate");
    expect(r).toMatchObject({ code: "binding-conflict" });
  });

  test("indeterminate: an index status getter cannot turn into a verified result", async () => {
    let statusReads = 0;
    const forged = {
      get status() {
        return statusReads++ === 0 ? "indeterminate" : "verified";
      },
      reason: "index unavailable",
      nativeAddress: "stor-attacker",
      record: { forged: true },
    };
    let reads = 0;
    let verifications = 0;
    const r = await resolveAndRead(
      { resolve: async () => forged as never },
      LOGICAL,
      SELLER,
      depsWith({}, {
        read: async () => { reads++; return null; },
        verifySignature: () => { verifications++; return true; },
      }),
    );
    expect(r).toEqual({ status: "indeterminate", reason: "index unavailable" });
    expect(reads).toBe(0);
    expect(verifications).toBe(0);
  });

  test("indeterminate: only a known conflict code is copied from the index", async () => {
    const resolveWith = (result: unknown) => resolveAndRead(
      { resolve: async () => result as never },
      LOGICAL,
      SELLER,
      depsWith({}),
    );
    expect(await resolveWith({
      status: "indeterminate", reason: "disagree", code: "binding-conflict",
    })).toEqual({ status: "indeterminate", reason: "disagree", code: "binding-conflict" });
    expect(await resolveWith({
      status: "indeterminate", reason: "busy", code: "other", nativeAddress: "stor-x",
    })).toEqual({ status: "indeterminate", reason: "busy" });
  });

  test("indeterminate: a conflict-code getter is read once with status and reason", async () => {
    const fieldReads = { status: 0, reason: 0, code: 0 };
    const resolution = {
      get status() { return fieldReads.status++ === 0 ? "indeterminate" : "verified"; },
      get reason() { return fieldReads.reason++ === 0 ? "disagree" : "attacker-reason"; },
      get code() { return fieldReads.code++ === 0 ? "binding-conflict" : "attacker-value"; },
    };
    let reads = 0;
    let verifications = 0;
    const result = await resolveAndRead(
      { resolve: async () => resolution as never },
      LOGICAL,
      SELLER,
      depsWith({}, {
        read: async () => { reads++; return null; },
        verifySignature: () => { verifications++; return true; },
      }),
    );
    expect(result).toEqual({ status: "indeterminate", reason: "disagree", code: "binding-conflict" });
    expect(fieldReads).toEqual({ status: 1, reason: 1, code: 1 });
    expect(reads).toBe(0);
    expect(verifications).toBe(0);
  });

  test("unreadable: the resolved native address holds no record", async () => {
    const index = createInMemoryBindingIndex([binding()]);
    const r = await resolveAndRead(index, LOGICAL, SELLER, depsWith({})); // empty store
    expect(r).toEqual({ status: "unreadable", nativeAddress: "stor-real" });
  });

  test("indeterminate: a read that THROWS is not an absence", async () => {
    const index = createInMemoryBindingIndex([binding()]);
    const r = await resolveAndRead(index, LOGICAL, SELLER, {
      read: async () => {
        throw new Error("rpc down");
      },
      contentHashOf,
    });
    expect(r.status).toBe("indeterminate");
  });

  test("indeterminate: an index that THROWS is not an absence", async () => {
    const r = await resolveAndRead(
      {
        resolve: async () => {
          throw new Error("catalog unavailable");
        },
      },
      LOGICAL,
      SELLER,
      depsWith({}),
    );
    expect(r).toMatchObject({
      status: "indeterminate",
      reason: expect.stringContaining("catalog unavailable"),
    });
  });

  test("binding-mismatch: a custom index cannot substitute another logical address or owner", async () => {
    for (const substituted of [
      binding({ logicalAddress: "dacs1:other" }),
      binding({ owner: "0xother" }),
      binding({ revoked: true }),
    ]) {
      const r = await resolveAndRead(
        {
          resolve: async () => ({ status: "present", binding: substituted }),
        },
        LOGICAL,
        SELLER,
        depsWith({ "stor-real": RECORD }),
      );
      expect(r.status).toBe("binding-mismatch");
    }
  });

  test("signature verifier: a valid signature keeps the read verified", async () => {
    const index = createInMemoryBindingIndex([binding()]);
    const r = await resolveAndRead(index, LOGICAL, SELLER, {
      read: async () => RECORD,
      contentHashOf,
      verifySignature: (rec) => rec.signature === "sig-real",
    });
    expect(r.status).toBe("verified");
  });

  test("signature verifier: an invalid signature → signature-invalid (even with a matching hash)", async () => {
    const tampered = { ...RECORD, signature: "sig-forged" };
    // Hash is over the scope sans signature, so it still matches — but the sig check fails.
    const index = createInMemoryBindingIndex([binding()]);
    const r = await resolveAndRead(index, LOGICAL, SELLER, {
      read: async () => tampered,
      contentHashOf,
      verifySignature: (rec) => rec.signature === "sig-real",
    });
    expect(r.status).toBe("signature-invalid");
  });

  test("signature verifier: a truthy non-boolean result cannot verify a record", async () => {
    const index = createInMemoryBindingIndex([binding()]);
    const r = await resolveAndRead(index, LOGICAL, SELLER, depsWith(
      { "stor-real": RECORD },
      { verifySignature: () => ({}) as unknown as boolean },
    ));
    expect(r.status).toBe("signature-invalid");
  });

  test("unverifiable: no binding hash AND no signature verifier → returned but not trusted", async () => {
    const index = createInMemoryBindingIndex([binding({ contentHash: undefined })]);
    const r = await resolveAndRead(index, LOGICAL, SELLER, depsWith({ "stor-real": RECORD }));
    expect(r.status).toBe("unverifiable");
  });

  test("unverifiable: a signature verifier cannot compensate for a missing binding hash", async () => {
    let verifierCalled = false;
    const index = createInMemoryBindingIndex([
      binding({ contentHash: undefined }),
    ]);
    const r = await resolveAndRead(
      index,
      LOGICAL,
      SELLER,
      depsWith(
        { "stor-real": RECORD },
        {
          verifySignature: () => {
            verifierCalled = true;
            return true;
          },
        },
      ),
    );
    expect(r).toMatchObject({
      status: "unverifiable",
      reason: expect.stringContaining("does not carry a content hash"),
    });
    expect(verifierCalled).toBe(false);
  });

  test("unverifiable: malformed bytes that cannot be hashed return a diagnostic", async () => {
    const index = createInMemoryBindingIndex([binding()]);
    const r = await resolveAndRead(index, LOGICAL, SELLER, {
      read: async () => RECORD,
      contentHashOf: () => {
        throw new Error("non-canonical number");
      },
      verifySignature: () => true,
    });

    expect(r).toMatchObject({
      status: "unverifiable",
      nativeAddress: "stor-real",
      record: RECORD,
      reason: expect.stringContaining("non-canonical number"),
    });
  });

  test("snapshots binding and record before asynchronous artifact verification", async () => {
    const mutableBinding = binding();
    const mutableRecord = { ...RECORD };
    let entered!: () => void;
    const verifierEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = resolveAndRead(
      {
        resolve: async () => ({
          status: "present",
          binding: mutableBinding,
        }),
      },
      LOGICAL,
      SELLER,
      {
        read: async () => mutableRecord,
        contentHashOf,
        verifySignature: async (record, resolvedBinding) => {
          entered();
          await gate;
          return (
            record.serviceId === "market-data" &&
            resolvedBinding.nativeAddress === "stor-real"
          );
        },
      },
    );
    await verifierEntered;
    mutableBinding.nativeAddress = "stor-mutated";
    mutableRecord.serviceId = "mutated";
    release();

    await expect(pending).resolves.toMatchObject({
      status: "verified",
      nativeAddress: "stor-real",
      record: { serviceId: "market-data" },
    });
  });
});
