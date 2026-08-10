import { describe, expect, test } from "vitest";

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
  test("verified: binding resolves and the artifact-specific verifier authorizes the record", async () => {
    const index = createInMemoryBindingIndex([binding()]);
    const r = await resolveAndRead(index, LOGICAL, SELLER, depsWith(
      { "stor-real": RECORD },
      { verifySignature: (rec) => rec.signature === "sig-real" },
    ));
    expect(r.status).toBe("verified");
    if (r.status === "verified") expect(r.record).toEqual(RECORD);
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
});
