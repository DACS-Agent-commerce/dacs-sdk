import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  buildComponentSignature,
  contentHash,
  ed25519Sign,
  ed25519Verify,
  isComponentSignature,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  signComponentArtifact,
  verifyComponentSignature,
  type BuildComponentSignatureOptions,
  type ComponentSignature,
  type DomainSeparator,
  type VerifyComponentSignatureDeps,
} from "../../src/index.js";

const seed = new Uint8Array(32).fill(11);
const privateKey = privateKeyFromSeed(seed);
const publicKey = rawPublicKey(publicKeyFromSeed(seed));
const seller = "did:demos:agent:seller";
const outsider = "did:demos:agent:outsider";

const listing = {
  listingVersion: "1",
  seller,
  service: "market-data",
};

const sign = (bytes: Uint8Array) => ed25519Sign(bytes, privateKey);

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function deps(
  overrides: Partial<VerifyComponentSignatureDeps<Uint8Array>> = {},
): VerifyComponentSignatureDeps<Uint8Array> {
  return {
    isSignerAuthorized: (artifact, signature) =>
      signature.signer === artifact["seller"],
    resolvePublicKey: () => publicKey,
    verify: ({ signedBytes, signature, publicKey: key }) =>
      ed25519Verify(
        signedBytes,
        Buffer.from(signature.value, "base64url"),
        publicKeyFromRaw(key),
      ),
    ...overrides,
  };
}

describe("ComponentSignature foundation", () => {
  it("builds the normative algorithm/signer/value envelope", async () => {
    const signature = await buildComponentSignature(
      listing,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );

    expect(signature).toEqual({
      algorithm: "ed25519",
      signer: seller,
      value: expect.any(String),
    });
    expect(isComponentSignature(signature)).toBe(true);
  });

  it("signs and returns one exact nested artifact snapshot across an async wallet", async () => {
    const entered = deferred();
    const release = deferred();
    const artifact = {
      ...listing,
      service: {
        name: "market-data",
        regions: ["eu-west"],
      },
    };
    const pending = signComponentArtifact(artifact, "dacs-listing:v1:", {
      algorithm: "ed25519",
      signer: seller,
      sign: async (bytes) => {
        entered.resolve();
        await release.promise;
        return sign(bytes);
      },
    });

    await entered.promise;
    artifact.service.name = "caller-mutated";
    artifact.service.regions[0] = "caller-mutated";
    artifact.service.regions.push("new-region");
    release.resolve();

    const signed = await pending;
    expect(signed.service).toEqual({
      name: "market-data",
      regions: ["eu-west"],
    });
    expect(signed.service).not.toBe(artifact.service);
    await expect(
      verifyComponentSignature(signed, "dacs-listing:v1:", deps()),
    ).resolves.toMatchObject({ status: "valid" });
  });

  it("builds against a nested snapshot when the caller mutates during await", async () => {
    const entered = deferred();
    const release = deferred();
    const artifact = {
      ...listing,
      terms: { currencies: ["USDC"] },
    };
    const original = structuredClone(artifact);
    const pending = buildComponentSignature(artifact, "dacs-listing:v1:", {
      algorithm: "ed25519",
      signer: seller,
      sign: async (bytes) => {
        entered.resolve();
        await release.promise;
        return sign(bytes);
      },
    });

    await entered.promise;
    artifact.terms.currencies[0] = "ETH";
    release.resolve();
    const signature = await pending;

    await expect(
      verifyComponentSignature(
        { ...original, signature },
        "dacs-listing:v1:",
        deps(),
      ),
    ).resolves.toMatchObject({ status: "valid" });
    await expect(
      verifyComponentSignature(
        { ...artifact, signature },
        "dacs-listing:v1:",
        deps(),
      ),
    ).resolves.toMatchObject({
      status: "invalid",
      reason: "cryptographic-verification-failed",
    });
  });

  it("captures signer options before awaiting the wallet", async () => {
    const entered = deferred();
    const release = deferred();
    const options: BuildComponentSignatureOptions = {
      algorithm: "ed25519",
      signer: seller,
      sign: async (bytes: Uint8Array) => {
        entered.resolve();
        await release.promise;
        return sign(bytes);
      },
    };
    const pending = buildComponentSignature(
      listing,
      "dacs-listing:v1:",
      options,
    );

    await entered.promise;
    options.signer = outsider;
    options.sign = async () => "different-wallet-output";
    release.resolve();

    const signature = await pending;
    expect(signature.signer).toBe(seller);
    await expect(
      verifyComponentSignature(
        { ...listing, signature },
        "dacs-listing:v1:",
        deps(),
      ),
    ).resolves.toMatchObject({ status: "valid" });
  });

  it("captures build options before rejecting accessor-backed artifacts", async () => {
    const options: BuildComponentSignatureOptions = {
      algorithm: "ed25519",
      signer: seller,
      sign,
    };
    const artifact = {
      listingVersion: "1",
      seller,
      get service() {
        options.signer = outsider;
        options.sign = () => "changed-wallet-output";
        return "market-data";
      },
    };

    await expect(
      buildComponentSignature(artifact, "dacs-listing:v1:", options),
    ).rejects.toThrow("not stable canonical JSON");
    expect(options.signer).toBe(seller);
    expect(options.sign).toBe(sign);
  });

  it("captures attach options before rejecting accessor-backed artifacts", async () => {
    const options: BuildComponentSignatureOptions = {
      algorithm: "ed25519",
      signer: seller,
      sign,
    };
    const artifact = {
      listingVersion: "1",
      seller,
      get service() {
        options.signer = outsider;
        options.sign = () => "changed-wallet-output";
        return "market-data";
      },
    };

    await expect(
      signComponentArtifact(artifact, "dacs-listing:v1:", options),
    ).rejects.toThrow("not stable canonical JSON");
    expect(options.signer).toBe(seller);
    expect(options.sign).toBe(sign);
  });

  it("rejects non-wire JCS aliases before invoking a signer", async () => {
    const wallet = vi.fn(sign);
    for (const artifact of [
      { ...listing, optional: undefined },
      { ...listing, generatedAt: -0 },
    ]) {
      await expect(
        buildComponentSignature(artifact, "dacs-listing:v1:", {
          algorithm: "ed25519",
          signer: seller,
          sign: wallet,
        }),
      ).rejects.toThrow("not stable canonical JSON");
    }
    expect(wallet).not.toHaveBeenCalled();
  });

  it("expands repeated object identities into independent wire values", async () => {
    const shared = { regions: ["eu-west"] };
    const signed = await signComponentArtifact(
      { ...listing, service: shared, terms: shared },
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );

    expect(signed.service).toEqual(signed.terms);
    expect(signed.service).not.toBe(signed.terms);
    signed.service.regions[0] = "caller-mutated";
    expect(signed.terms.regions).toEqual(["eu-west"]);
  });

  it("rejects cycles and exotic property descriptors", async () => {
    const cyclic: Record<string, unknown> = { ...listing };
    cyclic["cycle"] = cyclic;
    const frozen = Object.freeze({ ...listing });

    for (const artifact of [cyclic, frozen]) {
      await expect(
        buildComponentSignature(artifact, "dacs-listing:v1:", {
          algorithm: "ed25519",
          signer: seller,
          sign,
        }),
      ).rejects.toThrow("not stable canonical JSON");
    }
  });

  it("preserves the normative CF-1 NFC normalization alias", async () => {
    const nfd = { ...listing, service: "cafe\u0301" };
    const nfc = { ...listing, service: "caf\u00e9" };
    const signature = await buildComponentSignature(
      nfd,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );
    await expect(
      verifyComponentSignature(
        { ...nfc, signature },
        "dacs-listing:v1:",
        deps(),
      ),
    ).resolves.toMatchObject({ status: "valid" });
  });

  it("normalizes an NFD signer identifier and round-trips it as CF-1 JSON", async () => {
    const nfdSigner = "did:demos:agent:cafe\u0301";
    const nfcSigner = "did:demos:agent:caf\u00e9";
    const signed = await signComponentArtifact(
      { ...listing, seller: nfdSigner },
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: nfdSigner, sign },
    );

    expect(signed.seller).toBe(nfcSigner);
    expect(signed.signature.signer).toBe(nfcSigner);
    await expect(
      verifyComponentSignature(signed, "dacs-listing:v1:", deps()),
    ).resolves.toMatchObject({ status: "valid" });
  });

  it("rejects a lone-surrogate signer before invoking its wallet", async () => {
    const wallet = vi.fn(sign);
    await expect(
      buildComponentSignature(listing, "dacs-listing:v1:", {
        algorithm: "ed25519",
        signer: "did:demos:agent:\ud800",
        sign: wallet,
      }),
    ).rejects.toThrow("valid JSON string");
    expect(wallet).not.toHaveBeenCalled();
  });

  it("accepts data-only JSON objects and arrays from another realm", async () => {
    const artifact = runInNewContext(
      'JSON.parse("{\\"listingVersion\\":\\"1\\",\\"seller\\":\\"did:demos:agent:seller\\",\\"regions\\":[\\"eu-west\\"]}")',
    ) as typeof listing & { regions: string[] };
    const signed = await signComponentArtifact(
      artifact,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );

    expect(signed.regions).toEqual(["eu-west"]);
    await expect(
      verifyComponentSignature(signed, "dacs-listing:v1:", deps()),
    ).resolves.toMatchObject({ status: "valid" });
  });

  it("rejects root arrays on both component signing APIs", async () => {
    const artifact = [listing];
    const options = { algorithm: "ed25519", signer: seller, sign } as const;

    await expect(
      buildComponentSignature(artifact, "dacs-listing:v1:", options),
    ).rejects.toThrow("must be a JSON object");
    await expect(
      signComponentArtifact(artifact, "dacs-listing:v1:", options),
    ).rejects.toThrow("must be a JSON object");
  });

  it("rejects primitive roots before invoking either component wallet API", async () => {
    const wallet = vi.fn(sign);
    const options = {
      algorithm: "ed25519",
      signer: seller,
      sign: wallet,
    } as const;

    for (const artifact of [null, 42, "listing", true]) {
      await expect(
        buildComponentSignature(
          artifact as never,
          "dacs-listing:v1:",
          options,
        ),
      ).rejects.toThrow("must be a JSON object");
      await expect(
        signComponentArtifact(
          artifact as never,
          "dacs-listing:v1:",
          options,
        ),
      ).rejects.toThrow("must be a JSON object");
    }
    expect(wallet).not.toHaveBeenCalled();
  });

  it("rejects proxies without invoking their reflective traps", async () => {
    const ownKeys = vi.fn(() => Reflect.ownKeys(listing));
    const artifact = new Proxy(listing, { ownKeys });
    await expect(
      buildComponentSignature(artifact, "dacs-listing:v1:", {
        algorithm: "ed25519",
        signer: seller,
        sign,
      }),
    ).rejects.toThrow("not stable canonical JSON");
    expect(ownKeys).not.toHaveBeenCalled();
  });

  it("rejects proxy prototypes without invoking their reflective traps", async () => {
    const getOwnPropertyDescriptor = vi.fn(() => undefined);
    const proxyPrototype = new Proxy(Object.prototype, {
      getOwnPropertyDescriptor,
    });
    const artifact = { ...listing };
    Object.setPrototypeOf(artifact, proxyPrototype);

    await expect(
      buildComponentSignature(artifact, "dacs-listing:v1:", {
        algorithm: "ed25519",
        signer: seller,
        sign,
      }),
    ).rejects.toThrow("not stable canonical JSON");
    expect(getOwnPropertyDescriptor).not.toHaveBeenCalled();
  });

  it("preserves method-style this binding for signer and verifier callbacks", async () => {
    const signerOptions: BuildComponentSignatureOptions & {
      expectedSigner: string;
    } = {
      algorithm: "ed25519",
      signer: seller,
      expectedSigner: seller,
      sign(bytes) {
        expect(this.expectedSigner).toBe(seller);
        return sign(bytes);
      },
    };
    const signed = await signComponentArtifact(
      listing,
      "dacs-listing:v1:",
      signerOptions,
    );
    const verificationDeps: VerifyComponentSignatureDeps<Uint8Array> & {
      expectedSigner: string;
    } = {
      expectedSigner: seller,
      isSignerAuthorized(artifact, signature) {
        expect(this.expectedSigner).toBe(seller);
        return signature.signer === artifact["seller"];
      },
      resolvePublicKey() {
        expect(this.expectedSigner).toBe(seller);
        return publicKey;
      },
      verify({ signedBytes, signature, publicKey: key }) {
        expect(this.expectedSigner).toBe(seller);
        return ed25519Verify(
          signedBytes,
          Buffer.from(signature.value, "base64url"),
          publicKeyFromRaw(key),
        );
      },
    };

    await expect(
      verifyComponentSignature(
        signed,
        "dacs-listing:v1:",
        verificationDeps,
      ),
    ).resolves.toMatchObject({ status: "valid" });
  });

  it("rejects a wallet that mutates its signing bytes or context", async () => {
    await expect(
      buildComponentSignature(listing, "dacs-listing:v1:", {
        algorithm: "ed25519",
        signer: seller,
        sign: (bytes, context) => {
          bytes.fill(0);
          context.signer = outsider;
          return "wallet-output";
        },
      }),
    ).rejects.toThrow("must not mutate its signing inputs");
  });

  it("runtime-rejects a signer output outside the declared bytes/string contract", async () => {
    await expect(
      buildComponentSignature(listing, "dacs-listing:v1:", {
        algorithm: "ed25519",
        signer: seller,
        sign: (() => ({ value: "not-wire-bytes" })) as never,
      }),
    ).rejects.toThrow("must return signature bytes");
  });

  it("encodes byte-returning signers as unpadded base64url", async () => {
    const signature = await buildComponentSignature(
      listing,
      "dacs-listing:v1:",
      {
        algorithm: "ed25519",
        signer: seller,
        sign: () => Uint8Array.from([251, 255]),
      },
    );

    expect(signature.value).toBe("-_8");
  });

  it("accepts genuine Uint8Array signature bytes from another realm", async () => {
    const signatureBytes = runInNewContext(
      "new Uint8Array([251, 255])",
    ) as Uint8Array;
    const signature = await buildComponentSignature(
      listing,
      "dacs-listing:v1:",
      {
        algorithm: "ed25519",
        signer: seller,
        sign: () => signatureBytes,
      },
    );

    expect(signature.value).toBe("-_8");
  });

  it("contains proxy-wrapped signature bytes as a typed wallet error", async () => {
    const proxyBytes = new Proxy(new Uint8Array([251, 255]), {});
    await expect(
      buildComponentSignature(listing, "dacs-listing:v1:", {
        algorithm: "ed25519",
        signer: seller,
        sign: () => proxyBytes,
      }),
    ).rejects.toThrow(
      "component signer must return signature bytes or a canonical unpadded base64url string",
    );
  });

  it("accepts canonical base64url values from string-returning wallets", async () => {
    const signature = await buildComponentSignature(
      listing,
      "dacs-listing:v1:",
      {
        algorithm: "ed25519",
        signer: seller,
        sign: () => "-_8",
      },
    );

    expect(signature.value).toBe("-_8");
  });

  it("rejects non-canonical or padded wallet signature strings", async () => {
    await expect(
      buildComponentSignature(listing, "dacs-listing:v1:", {
        algorithm: "ed25519",
        signer: seller,
        sign: () => "YWJjZA==",
      }),
    ).rejects.toThrow("canonical unpadded base64url");
  });

  it("signs then verifies a standalone artifact", async () => {
    const signed = await signComponentArtifact(
      listing,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );

    await expect(
      verifyComponentSignature(signed, "dacs-listing:v1:", deps()),
    ).resolves.toMatchObject({ status: "valid" });
  });

  it("verifies one stable snapshot while the caller mutates during authorization", async () => {
    const signed = await signComponentArtifact(
      { ...listing, metadata: { regions: ["eu-west"] } },
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );
    const originalSignature = structuredClone(signed.signature);
    const entered = deferred();
    const release = deferred();
    const pending = verifyComponentSignature(
      signed,
      "dacs-listing:v1:",
      deps({
        isSignerAuthorized: async (artifact, signature) => {
          entered.resolve();
          await release.promise;
          return signature.signer === artifact["seller"];
        },
      }),
    );

    await entered.promise;
    signed.metadata.regions[0] = "caller-mutated";
    signed.signature.value = "caller-mutated";
    release.resolve();

    await expect(pending).resolves.toEqual({
      status: "valid",
      signature: originalSignature,
    });
  });

  it("captures verification dependencies before the first await", async () => {
    const signed = await signComponentArtifact(
      listing,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );
    const entered = deferred();
    const release = deferred();
    const verificationDeps = deps({
      isSignerAuthorized: async (artifact, signature) => {
        entered.resolve();
        await release.promise;
        return signature.signer === artifact["seller"];
      },
    });
    const pending = verifyComponentSignature(
      signed,
      "dacs-listing:v1:",
      verificationDeps,
    );

    await entered.promise;
    verificationDeps.isSignerAuthorized = () => false;
    verificationDeps.resolvePublicKey = () => null;
    verificationDeps.verify = () => false;
    release.resolve();

    await expect(pending).resolves.toMatchObject({ status: "valid" });
  });

  it("isolates verification callback inputs from the stable signed scope", async () => {
    const signed = await signComponentArtifact(
      { ...listing, metadata: { regions: ["eu-west"] } },
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );
    const originalSignature = structuredClone(signed.signature);
    const verificationDeps = deps({
      isSignerAuthorized: (artifact, signature) => {
        (artifact["metadata"] as { regions: string[] }).regions[0] =
          "policy-mutated";
        (signature as ComponentSignature).value = "policy-mutated";
        return signature.signer === seller;
      },
      resolvePublicKey: (signature) => {
        (signature as ComponentSignature).signer = outsider;
        return publicKey;
      },
      verify: (input) => {
        const valid = ed25519Verify(
          input.signedBytes,
          Buffer.from(input.signature.value, "base64url"),
          publicKeyFromRaw(input.publicKey),
        );
        input.signedBytes.fill(0);
        input.signature.value = "verifier-mutated";
        return valid;
      },
    });

    await expect(
      verifyComponentSignature(
        signed,
        "dacs-listing:v1:",
        verificationDeps,
      ),
    ).resolves.toEqual({
      status: "valid",
      signature: originalSignature,
    });
  });

  it("preserves unknown fields in the signed scope (SIG-5)", async () => {
    const signed = await signComponentArtifact(
      { ...listing, futureMinorField: "hash-bound" },
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );

    await expect(
      verifyComponentSignature(signed, "dacs-listing:v1:", deps()),
    ).resolves.toMatchObject({ status: "valid" });
    await expect(
      verifyComponentSignature(
        { ...signed, futureMinorField: "tampered" },
        "dacs-listing:v1:",
        deps(),
      ),
    ).resolves.toEqual({
      status: "invalid",
      reason: "cryptographic-verification-failed",
      signature: signed.signature,
    });
  });

  it("cryptographically binds dangerous own keys while omitting only root signature fields", async () => {
    const artifact = JSON.parse(
      JSON.stringify({
        ...listing,
        __proto__: undefined,
        constructor: { policy: "constructor-bound" },
        prototype: { policy: "prototype-bound" },
        metadata: { signature: "nested-signature-bound" },
      }),
    ) as Record<string, unknown>;
    // Object-literal `__proto__` syntax is special, so install the adversarial
    // wire member through JSON parsing exactly as a registry/network reader
    // would receive it.
    Object.defineProperty(artifact, "__proto__", {
      configurable: true,
      enumerable: true,
      value: { policy: "proto-bound" },
      writable: true,
    });

    const signed = await signComponentArtifact(
      artifact,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );
    const originalHash = contentHash(signed);

    expect(Object.getPrototypeOf(signed)).toBe(Object.prototype);
    expect(Object.hasOwn(signed, "__proto__")).toBe(true);
    await expect(
      verifyComponentSignature(signed, "dacs-listing:v1:", deps()),
    ).resolves.toMatchObject({ status: "valid" });

    for (const key of ["__proto__", "constructor", "prototype"] as const) {
      const tampered = JSON.parse(JSON.stringify(signed)) as Record<
        string,
        unknown
      >;
      (tampered[key] as { policy: string }).policy = "tampered";
      expect(contentHash(tampered)).not.toBe(originalHash);
      await expect(
        verifyComponentSignature(tampered, "dacs-listing:v1:", deps()),
      ).resolves.toMatchObject({
        status: "invalid",
        reason: "cryptographic-verification-failed",
      });
    }

    const nestedTampered = JSON.parse(JSON.stringify(signed)) as Record<
      string,
      unknown
    >;
    (nestedTampered["metadata"] as { signature: string }).signature =
      "tampered";
    expect(contentHash(nestedTampered)).not.toBe(originalHash);

    const rootSignatureChanged = {
      ...signed,
      signature: { ...signed.signature, value: "AQ" },
    };
    expect(contentHash(rootSignatureChanged)).toBe(originalHash);
    const withPluralSignature = { ...signed, signatures: [{ value: "AQ" }] };
    expect(contentHash(withPluralSignature)).toBe(originalHash);
    await expect(
      verifyComponentSignature(
        withPluralSignature,
        "dacs-listing:v1:",
        deps(),
      ),
    ).resolves.toEqual({
      status: "malformed",
      reason: "ambiguous-signature-fields",
    });
  });

  it("rejects cross-domain signature reuse", async () => {
    const signed = await signComponentArtifact(
      listing,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );

    await expect(
      verifyComponentSignature(signed, "dacs-evidence:v1:", deps()),
    ).resolves.toMatchObject({
      status: "invalid",
      reason: "cryptographic-verification-failed",
    });
  });

  it("reports missing and malformed envelopes explicitly", async () => {
    await expect(
      verifyComponentSignature(listing, "dacs-listing:v1:", deps()),
    ).resolves.toEqual({ status: "missing" });

    await expect(
      verifyComponentSignature(
        {
          ...listing,
          signature: { algorithm: "rsa", signer: seller, value: "sig" },
        },
        "dacs-listing:v1:",
        deps(),
      ),
    ).resolves.toEqual({
      status: "malformed",
      reason: "unsupported-algorithm",
    });
  });

  it("rejects mutable fields outside the exact ComponentSignature envelope", async () => {
    const signed = await signComponentArtifact(
      listing,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );
    const signatureWithExtra = signed.signature as ComponentSignature & {
      unsignedRole: string;
    };
    signatureWithExtra.unsignedRole = "admin";

    expect(isComponentSignature(signatureWithExtra)).toBe(false);
    await expect(
      verifyComponentSignature(signed, "dacs-listing:v1:", deps()),
    ).resolves.toEqual({
      status: "malformed",
      reason: "unexpected-signature-fields",
    });

    signatureWithExtra.unsignedRole = "guest";
    await expect(
      verifyComponentSignature(signed, "dacs-listing:v1:", deps()),
    ).resolves.toEqual({
      status: "malformed",
      reason: "unexpected-signature-fields",
    });
  });

  it("contains artifact snapshot traps as a malformed signed scope", async () => {
    const signed = await signComponentArtifact(
      listing,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );
    const trappedArtifact = new Proxy(signed, {
      ownKeys() {
        throw new Error("caller-owned object became unreadable");
      },
    });

    await expect(
      verifyComponentSignature(
        trappedArtifact,
        "dacs-listing:v1:",
        deps(),
      ),
    ).resolves.toEqual({
      status: "malformed",
      reason: "signed-scope-not-canonicalizable",
    });
  });

  it("rejects ambiguous singular and plural signature fields", async () => {
    const signed = await signComponentArtifact(
      listing,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );

    await expect(
      verifyComponentSignature(
        { ...signed, signatures: [] },
        "dacs-listing:v1:",
        deps(),
      ),
    ).resolves.toEqual({
      status: "malformed",
      reason: "ambiguous-signature-fields",
    });
  });

  it("runtime-rejects unregistered separators for JS callers", async () => {
    const unregistered = "dacs-typo:v1:" as DomainSeparator;

    await expect(
      buildComponentSignature(listing, unregistered, {
        algorithm: "ed25519",
        signer: seller,
        sign,
      }),
    ).rejects.toThrow("unregistered domain separator");

    const signed = await signComponentArtifact(
      listing,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );
    await expect(
      verifyComponentSignature(signed, unregistered, deps()),
    ).resolves.toEqual({
      status: "malformed",
      reason: "unregistered-domain-separator",
    });
  });

  it("requires artifact-specific signer authorisation", async () => {
    const signed = await signComponentArtifact(
      listing,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: outsider, sign },
    );
    const resolvePublicKey = vi.fn(() => publicKey);

    await expect(
      verifyComponentSignature(
        signed,
        "dacs-listing:v1:",
        deps({ resolvePublicKey }),
      ),
    ).resolves.toEqual({
      status: "invalid",
      reason: "signer-not-authorized",
      signature: signed.signature,
    });
    expect(resolvePublicKey).not.toHaveBeenCalled();
  });

  it("does not collapse an unresolvable signer into invalid", async () => {
    const signed = await signComponentArtifact(
      listing,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );

    await expect(
      verifyComponentSignature(
        signed,
        "dacs-listing:v1:",
        deps({ resolvePublicKey: () => null }),
      ),
    ).resolves.toEqual({
      status: "unresolved",
      reason: "signer-key-not-found",
      signature: signed.signature,
    });
  });

  it("reports an authorization policy error as unresolved", async () => {
    const signed = await signComponentArtifact(
      listing,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );

    await expect(
      verifyComponentSignature(
        signed,
        "dacs-listing:v1:",
        deps({
          isSignerAuthorized: () => {
            throw new Error("policy dependency unavailable");
          },
        }),
      ),
    ).resolves.toEqual({
      status: "unresolved",
      reason: "authorization-unresolved",
      signature: signed.signature,
    });
  });

  it("does not authorize a truthy non-boolean policy result", async () => {
    const signed = await signComponentArtifact(
      listing,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );

    await expect(
      verifyComponentSignature(
        signed,
        "dacs-listing:v1:",
        deps({ isSignerAuthorized: (() => "authorized") as never }),
      ),
    ).resolves.toEqual({
      status: "unresolved",
      reason: "authorization-unresolved",
      signature: signed.signature,
    });
  });

  it("contains dependency getter failures in their explicit unresolved stage", async () => {
    const signed = await signComponentArtifact(
      listing,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );
    const verificationDeps = deps();
    Object.defineProperty(verificationDeps, "resolvePublicKey", {
      configurable: true,
      get() {
        throw new Error("key resolver configuration unavailable");
      },
    });

    await expect(
      verifyComponentSignature(
        signed,
        "dacs-listing:v1:",
        verificationDeps,
      ),
    ).resolves.toEqual({
      status: "unresolved",
      reason: "signer-key-resolution-failed",
      signature: signed.signature,
    });
  });

  it("contains a non-callable verifier dependency as a verification error", async () => {
    const signed = await signComponentArtifact(
      listing,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );
    const verificationDeps = deps();
    (verificationDeps as unknown as { verify: unknown }).verify = null;

    await expect(
      verifyComponentSignature(
        signed,
        "dacs-listing:v1:",
        verificationDeps,
      ),
    ).resolves.toEqual({
      status: "unresolved",
      reason: "verification-error",
      signature: signed.signature,
    });
  });

  it("reports a verifier exception as unresolved, not invalid", async () => {
    const signed = await signComponentArtifact(
      listing,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );

    await expect(
      verifyComponentSignature(
        signed,
        "dacs-listing:v1:",
        deps({
          verify: () => {
            throw new Error("algorithm backend unavailable");
          },
        }),
      ),
    ).resolves.toEqual({
      status: "unresolved",
      reason: "verification-error",
      signature: signed.signature,
    });
  });

  it("does not accept a truthy non-boolean verifier result", async () => {
    const signed = await signComponentArtifact(
      listing,
      "dacs-listing:v1:",
      { algorithm: "ed25519", signer: seller, sign },
    );

    await expect(
      verifyComponentSignature(
        signed,
        "dacs-listing:v1:",
        deps({ verify: (() => "valid") as never }),
      ),
    ).resolves.toEqual({
      status: "unresolved",
      reason: "verification-error",
      signature: signed.signature,
    });
  });

  it("rejects an empty signer output", async () => {
    await expect(
      buildComponentSignature(listing, "dacs-listing:v1:", {
        algorithm: "ed25519",
        signer: seller,
        sign: () => new Uint8Array(),
      }),
    ).rejects.toThrow("canonical unpadded base64url");
  });

  it("rejects signing an artifact that already carries signature material", async () => {
    const existing: ComponentSignature = {
      algorithm: "ed25519",
      signer: seller,
      value: "already-signed",
    };

    await expect(
      signComponentArtifact(
        { ...listing, signature: existing },
        "dacs-listing:v1:",
        { algorithm: "ed25519", signer: seller, sign },
      ),
    ).rejects.toThrow("requires an unsigned artifact");
  });
});
