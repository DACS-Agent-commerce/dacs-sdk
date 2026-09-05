import { describe, expect, test, vi } from "vitest";

import type { IdentityBundle } from "../../src/artifacts/types.js";
import {
  authenticateDemosCciRecord,
  classifyCciTlsnProof,
  getAuthenticatedCciProvenance,
  isAuthenticatedCciRecord,
  projectCciSupplementarySignals,
  type AuthenticatedCciRecord,
  type VerifyNativeCciTlsnInput,
} from "../../src/identity/demosCci.js";
import {
  DEMOS_CCI_RESPONSE_LIMITS,
  cciClaimHasProof,
  parseCciRecord,
} from "../../src/identity/cci.js";

const PRIMARY =
  "did:demos:agent:1111111111111111111111111111111111111111111111111111111111111111";
const PROOF_HASH = "ab".repeat(32);
const HP_ADDRESS = `0x${"22".repeat(20)}`;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const SESSION_NONCE = "vet-session-0123456789abcdef";

const GCR = {
  result: 200,
  response: {
    xm: {
      evm: {
        "base-sepolia": [{ address: `0x${"11".repeat(20)}` }],
      },
    },
    web2: {
      twitter: [{ username: "alice", userId: "1", proofHash: "cd".repeat(32) }],
      github: [{
        username: "alice-dev",
        userId: 42,
        proofType: "tlsn",
        proofHash: PROOF_HASH.toUpperCase(),
        timestamp: 1_700_000_020_000,
        proof: { deliberately: "not surfaced" },
      }],
    },
    ud: [{ domain: "Alice.crypto", network: "polygon", signature: "0xsig" }],
    pqc: {
      falcon: [{ address: "falcon-public-key", signature: "sig" }],
      "ml-dsa": [{ address: "mldsa-public-key", signature: "sig" }],
    },
    nomis: {
      evm: {
        mainnet: [{
          address: `0x${"33".repeat(20)}`,
          score: 71,
          scoreType: 2,
          mintedScore: 70,
          lastSyncedAt: "2023-11-14T22:13:20.000Z",
        }],
      },
    },
    humanpassport: [{
      address: HP_ADDRESS.toUpperCase().replace("0X", "0x"),
      score: 38.5,
      passingScore: true,
      threshold: 20,
      stamps: ["Github", "Google"],
      verificationMethod: "api",
      verifiedAt: 1_700_000_010_000,
      expiresAt: 1_700_086_410_000,
    }],
    ethos: {
      evm: {
        mainnet: [{
          address: `0x${"44".repeat(20)}`,
          score: 1_823,
          profileId: 9876,
          lastSyncedAt: "2023-11-14T22:13:30.000Z",
        }],
      },
    },
  },
};

describe("full Demos CCI context projection", () => {
  test("projects the eight production contexts using canonical DACS-1 refs", () => {
    const record = parseCciRecord(PRIMARY, GCR);

    expect(record.wallets[0]).toMatchObject({
      chainType: "evm",
      subchain: "base-sepolia",
      ref: `cci-xm:evm:base-sepolia:0x${"11".repeat(20)}`,
    });
    expect(record.web2.map((claim) => claim.ref)).toEqual([
      "cci-web2:github:alice-dev",
      "cci-web2:twitter:alice",
    ]);
    expect(record.ud[0]?.ref).toBe("cci-ud:alice.crypto");
    expect(record.pqc.map((claim) => claim.ref)).toEqual([
      "cci-pqc:falcon:falcon-public-key",
      "cci-pqc:ml-dsa:mldsa-public-key",
    ]);
    expect(record.nomis[0]).toMatchObject({
      score: 71,
      scoreType: 2,
      observedAt: 1_700_000_000_000,
      ref: `cci-nomis:0x${"33".repeat(20)}`,
    });
    expect(record.humanPassport[0]).toMatchObject({
      id: HP_ADDRESS,
      address: HP_ADDRESS,
      score: 38.5,
      passingScore: true,
      ref: `cci-humanpassport:${HP_ADDRESS}`,
    });
    expect(record.ethos[0]).toMatchObject({
      id: "9876",
      profileId: 9876,
      score: 1_823,
      ref: "cci-ethos:9876",
    });
    expect(record.tlsn[0]).toMatchObject({
      context: "github",
      username: "alice-dev",
      userId: "42",
      proofHash: PROOF_HASH,
      ref: `cci-tlsn:${PROOF_HASH}`,
    });
    expect(cciClaimHasProof(record, `cci-tlsn:${PROOF_HASH}`)).toBe(true);
  });

  test("does not invent identifiers for incomplete score contexts", () => {
    const record = parseCciRecord(PRIMARY, {
      response: {
        nomis: { evm: { mainnet: [{ address: "0x1", score: -1, scoreType: 1 }] } },
        humanpassport: [{
          address: "not-an-evm-address",
          score: 25,
          passingScore: true,
          stamps: [],
          verificationMethod: "api",
          verifiedAt: 1,
          expiresAt: null,
        }],
        ethos: {
          evm: {
            mainnet: [{
              address: `0x${"44".repeat(20)}`,
              score: 1_000,
              lastSyncedAt: "2023-11-14T22:13:30.000Z",
            }],
          },
        },
        web2: {
          github: [{
            username: "alice",
            userId: "1",
            proofType: "tlsn",
            proofHash: "not-a-hash",
          }],
        },
      },
    });

    expect(record.nomis).toEqual([]);
    expect(record.humanPassport).toEqual([]);
    expect(record.ethos).toEqual([]);
    expect(record.tlsn).toEqual([]);
    expect(record.raw).toHaveProperty("response.ethos");
  });

  test("does not parse identity fields from a failed RPC envelope", () => {
    const record = parseCciRecord(PRIMARY, { ...GCR, result: 500 });
    expect(record.claims).toEqual([]);
    expect(record.raw).toHaveProperty("response.nomis");
  });

  test("rejects ambiguous non-ISO freshness timestamps", () => {
    const raw = structuredClone(GCR);
    raw.response.nomis.evm.mainnet[0]!.lastSyncedAt = "11/14/2023";
    expect(parseCciRecord(PRIMARY, raw).nomis).toEqual([]);
  });

  test("rejects active objects rather than executing getters during parsing", () => {
    const getter = vi.fn(() => ({ web2: {} }));
    const raw = Object.defineProperty({}, "response", {
      enumerable: true,
      configurable: true,
      get: getter,
    });
    expect(() => parseCciRecord(PRIMARY, raw)).toThrow(/stable wire JSON/);
    expect(getter).not.toHaveBeenCalled();
  });

  test("rejects conflicting canonical refs instead of selecting by RPC order", () => {
    const nomisConflict = structuredClone(GCR);
    nomisConflict.response.nomis.evm.mainnet.push({
      ...nomisConflict.response.nomis.evm.mainnet[0]!,
      score: 99,
    });
    expect(() => parseCciRecord(PRIMARY, nomisConflict)).toThrow(
      /conflicting claim cci-nomis/,
    );
    nomisConflict.response.nomis.evm.mainnet.reverse();
    expect(() => parseCciRecord(PRIMARY, nomisConflict)).toThrow(
      /conflicting claim cci-nomis/,
    );

    const web2Conflict = structuredClone(GCR);
    web2Conflict.response.web2.twitter.push({
      ...web2Conflict.response.web2.twitter[0]!,
      proofHash: "ef".repeat(32),
    });
    expect(() => parseCciRecord(PRIMARY, web2Conflict)).toThrow(
      /conflicting claim cci-web2/,
    );

    const udConflict = structuredClone(GCR);
    udConflict.response.ud.push({
      ...udConflict.response.ud[0]!,
      network: "ethereum",
    });
    expect(() => parseCciRecord(PRIMARY, udConflict)).toThrow(
      /conflicting claim cci-ud/,
    );

    const passportConflict = structuredClone(GCR);
    passportConflict.response.humanpassport.push({
      ...passportConflict.response.humanpassport[0]!,
      score: 99,
    });
    expect(() => parseCciRecord(PRIMARY, passportConflict)).toThrow(
      /conflicting claim cci-humanpassport/,
    );

    const ethosConflict = structuredClone(GCR);
    ethosConflict.response.ethos.evm.mainnet.push({
      ...ethosConflict.response.ethos.evm.mainnet[0]!,
      score: 99,
    });
    expect(() => parseCciRecord(PRIMARY, ethosConflict)).toThrow(
      /conflicting claim cci-ethos/,
    );

    const tlsnConflict = structuredClone(GCR);
    tlsnConflict.response.web2.github.push({
      ...tlsnConflict.response.web2.github[0]!,
      username: "different-account",
    });
    expect(() => parseCciRecord(PRIMARY, tlsnConflict)).toThrow(
      /conflicting claim cci-tlsn/,
    );
  });

  test("collapses exact duplicates deterministically in every CCI context", () => {
    const exactDuplicate = structuredClone(GCR);
    exactDuplicate.response.xm.evm["base-sepolia"].push(
      structuredClone(exactDuplicate.response.xm.evm["base-sepolia"][0]!),
    );
    exactDuplicate.response.web2.twitter.push(
      structuredClone(exactDuplicate.response.web2.twitter[0]!),
    );
    exactDuplicate.response.web2.github.push(
      structuredClone(exactDuplicate.response.web2.github[0]!),
    );
    exactDuplicate.response.ud.push(
      structuredClone(exactDuplicate.response.ud[0]!),
    );
    exactDuplicate.response.pqc.falcon.push(
      structuredClone(exactDuplicate.response.pqc.falcon[0]!),
    );
    exactDuplicate.response.nomis.evm.mainnet.push(
      structuredClone(exactDuplicate.response.nomis.evm.mainnet[0]!),
    );
    exactDuplicate.response.humanpassport.push(
      structuredClone(exactDuplicate.response.humanpassport[0]!),
    );
    exactDuplicate.response.ethos.evm.mainnet.push(
      structuredClone(exactDuplicate.response.ethos.evm.mainnet[0]!),
    );
    const record = parseCciRecord(PRIMARY, exactDuplicate);
    expect({
      wallets: record.wallets.length,
      web2: record.web2.length,
      ud: record.ud.length,
      pqc: record.pqc.length,
      nomis: record.nomis.length,
      humanPassport: record.humanPassport.length,
      ethos: record.ethos.length,
      tlsn: record.tlsn.length,
    }).toEqual({
      wallets: 1,
      web2: 2,
      ud: 1,
      pqc: 2,
      nomis: 1,
      humanPassport: 1,
      ethos: 1,
      tlsn: 1,
    });

    const permuted = structuredClone(exactDuplicate);
    permuted.response.web2 = {
      github: permuted.response.web2.github.reverse(),
      twitter: permuted.response.web2.twitter.reverse(),
    };
    permuted.response.xm.evm["base-sepolia"].reverse();
    permuted.response.ud.reverse();
    permuted.response.pqc.falcon.reverse();
    permuted.response.nomis.evm.mainnet.reverse();
    permuted.response.humanpassport.reverse();
    permuted.response.ethos.evm.mainnet.reverse();
    expect(parseCciRecord(PRIMARY, permuted).claims).toEqual(record.claims);
  });

  test("bounds broad, deep, and oversized GCR responses before snapshotting", () => {
    expect(() => parseCciRecord(PRIMARY, {
      response: {
        web2: {
          github: new Array(DEMOS_CCI_RESPONSE_LIMITS.maxArrayLength + 1).fill("alice"),
        },
      },
    })).toThrow(/maxArrayLength/);

    let deep: Record<string, unknown> = {};
    for (let index = 0; index <= DEMOS_CCI_RESPONSE_LIMITS.maxDepth; index += 1) {
      deep = { response: deep };
    }
    expect(() => parseCciRecord(PRIMARY, deep)).toThrow(/maxDepth/);

    expect(() => parseCciRecord(PRIMARY, {
      response: { ignored: "x".repeat(DEMOS_CCI_RESPONSE_LIMITS.maxStringBytes + 1) },
    })).toThrow(/maxStringBytes/);

    expect(() => parseCciRecord(PRIMARY, {
      response: Object.fromEntries(
        Array.from(
          { length: DEMOS_CCI_RESPONSE_LIMITS.maxObjectKeys + 1 },
          (_, index) => [`key-${index}`, true],
        ),
      ),
    })).toThrow(/maxObjectKeys/);

    expect(() => parseCciRecord(PRIMARY, {
      response: {
        ignored: Array.from(
          { length: 5 },
          () => new Array(DEMOS_CCI_RESPONSE_LIMITS.maxArrayLength).fill(true),
        ),
      },
    })).toThrow(/maxNodes/);
  });
});

describe("authenticated CCI reputation projection", () => {
  async function authenticated() {
    return authenticateDemosCciRecord(PRIMARY, GCR, {
      authenticateResolution: ({ subject, record }) => {
        expect(subject).toBe(PRIMARY);
        expect(Object.isFrozen(record)).toBe(true);
        expect(Object.isFrozen(record.raw as object)).toBe(true);
        return {
          status: "authenticated",
          subject,
          observedAt: 1_700_000_040_000,
          authority: "demos-testnet:validator-set:42",
          evidence: { blockNumber: 123 },
        };
      },
      authenticateProviderClaim: ({ subject, claim }) => {
        expect(subject).toBe(PRIMARY);
        expect(Object.isFrozen(claim)).toBe(true);
        return {
          status: "verified",
          subject,
          claimRef: claim.ref,
          verifiedAt: 1_700_000_035_000,
          authority: `provider-verifier:${claim.kind}`,
        };
      },
    });
  }

  test("brands the exact record and retains immutable provenance", async () => {
    const result = await authenticated();
    expect(result.status).toBe("authenticated");
    if (result.status !== "authenticated") return;

    expect(isAuthenticatedCciRecord(result.record)).toBe(true);
    expect(result.record.raw).toBeNull();
    expect(getAuthenticatedCciProvenance(result.record)).toEqual({
      subject: PRIMARY,
      observedAt: 1_700_000_040_000,
      authority: "demos-testnet:validator-set:42",
      evidence: { blockNumber: 123 },
    });
    expect(isAuthenticatedCciRecord({ ...result.record })).toBe(false);
  });

  test("emits only fresh native scores and never attaches a synthetic attestation", async () => {
    const result = await authenticated();
    if (result.status !== "authenticated") throw new Error("authentication failed");
    const projection = projectCciSupplementarySignals(result.record, {
      evaluatedAt: 1_700_000_050_000,
      maxAgeSec: { nomis: 60, humanPassport: 60, ethos: 60 },
    });

    expect(projection.omitted).toEqual([]);
    expect(projection.signals).toEqual([
      {
        source: "cci-nomis",
        signalType: `score:cci-nomis:0x${"33".repeat(20)}`,
        value: 71,
        observedAt: 1_700_000_000_000,
      },
      {
        source: "cci-humanpassport",
        signalType: `score:cci-humanpassport:${HP_ADDRESS}`,
        value: 38.5,
        observedAt: 1_700_000_010_000,
      },
      {
        source: "cci-ethos",
        signalType: "score:cci-ethos:9876",
        value: 1_823,
        observedAt: 1_700_000_010_000,
      },
    ]);
    expect(projection.signals.every((signal) => signal.attestation === undefined)).toBe(true);
  });

  test("does not promote GCR inclusion into provider-semantic trust", async () => {
    const result = await authenticateDemosCciRecord(PRIMARY, GCR, {
      authenticateResolution: () => ({
        status: "authenticated",
        subject: PRIMARY,
        observedAt: 1_700_000_040_000,
        authority: "demos-testnet:validator-set:42",
      }),
    });
    if (result.status !== "authenticated") throw new Error("authentication failed");
    const projection = projectCciSupplementarySignals(result.record, {
      evaluatedAt: 1_700_000_050_000,
      maxAgeSec: { nomis: 60, humanPassport: 60, ethos: 60 },
    });
    expect(projection.signals).toEqual([]);
    expect(projection.omitted).toEqual([
      { ref: `cci-nomis:0x${"33".repeat(20)}`, reason: "provider-unverified" },
      { ref: `cci-humanpassport:${HP_ADDRESS}`, reason: "provider-unverified" },
      { ref: "cci-ethos:9876", reason: "provider-unverified" },
    ]);
  });

  test("omits stale, expired, and non-passing values with explicit reasons", async () => {
    const raw = structuredClone(GCR);
    raw.response.humanpassport[0]!.passingScore = false;
    raw.response.humanpassport[0]!.expiresAt = 1_700_000_045_000;
    const result = await authenticateDemosCciRecord(PRIMARY, raw, {
      authenticateResolution: () => ({
        status: "authenticated",
        subject: PRIMARY,
        observedAt: 1_700_000_040_000,
        authority: "demos-testnet:validator-set:42",
      }),
      authenticateProviderClaim: ({ subject, claim }) => ({
        status: "verified",
        subject,
        claimRef: claim.ref,
        verifiedAt: 1_700_000_035_000,
        authority: "provider-verifier:test",
      }),
    });
    if (result.status !== "authenticated") throw new Error("authentication failed");
    const projection = projectCciSupplementarySignals(result.record, {
      evaluatedAt: 1_700_000_050_000,
      maxAgeSec: { nomis: 1, humanPassport: 60, ethos: 1 },
    });

    expect(projection.signals).toEqual([]);
    expect(projection.omitted).toEqual([
      { ref: `cci-nomis:0x${"33".repeat(20)}`, reason: "stale" },
      { ref: `cci-humanpassport:${HP_ADDRESS}`, reason: "not-passing" },
      { ref: "cci-ethos:9876", reason: "stale" },
    ]);
  });

  test("rejects structural records and misbound authenticator results", async () => {
    const plain = parseCciRecord(PRIMARY, GCR);
    expect(() => projectCciSupplementarySignals(
      plain as AuthenticatedCciRecord,
      {
        evaluatedAt: 1_700_000_050_000,
        maxAgeSec: { nomis: 60, humanPassport: 60, ethos: 60 },
      },
    )).toThrow(/authenticated GCR record/);

    await expect(authenticateDemosCciRecord(PRIMARY, GCR, {
      authenticateResolution: () => ({
        status: "authenticated",
        subject: `${PRIMARY}-attacker`,
        observedAt: 1_700_000_040_000,
        authority: "demos-testnet:validator-set:42",
      }),
    })).resolves.toEqual({
      status: "error",
      reason: "CCI resolution authentication is malformed or misbound",
    });

    await expect(authenticateDemosCciRecord(PRIMARY, GCR, {
      authenticateResolution: () => ({
        status: "authenticated",
        subject: PRIMARY,
        observedAt: 1_700_000_040_000,
        authority: "demos-testnet:validator-set:42",
        attackerControlled: true,
      } as never),
    })).resolves.toEqual({
      status: "error",
      reason: "CCI resolution authentication is malformed or misbound",
    });
  });
});

describe("native CCI TLSN disposition", () => {
  test("uses the native path only when authenticated GCR and signed bundle agree", async () => {
    const result = await authenticateDemosCciRecord(PRIMARY, GCR, {
      authenticateResolution: () => ({
        status: "authenticated",
        subject: PRIMARY,
        observedAt: 1_700_000_040_000,
        authority: "demos-testnet:validator-set:42",
      }),
    });
    if (result.status !== "authenticated") throw new Error("authentication failed");
    const bundle: IdentityBundle = {
      bundleVersion: "1",
      presentedBy: PRIMARY,
      presentedAt: 1_700_000_050_000,
      sessionNonce: SESSION_NONCE,
      claims: [{ ref: PRIMARY }, { ref: `cci-tlsn:${PROOF_HASH}` }],
      presentation: {
        kind: "per-claim",
        signatures: [{ ref: PRIMARY, signature: "test-signature" }],
      },
    };

    const verifyIdentityPresentation = vi.fn(() => true);
    const verifyNativeTlsn = vi.fn((input: VerifyNativeCciTlsnInput) => ({
      status: "verified" as const,
      verifiedAt: 1_700_000_050_000,
      authority: "native-tlsn:testnet",
      binding: {
        subject: input.subject,
        jobId: input.jobId,
        sessionNonce: input.sessionNonce,
        expectedServer: input.expectedServer,
        bundleHash: input.bundleHash,
        proofHash: input.proofHash,
        resolutionObservedAt: input.resolution.observedAt,
      },
      evidence: { transcript: PROOF_HASH },
    }));
    const context = {
      jobId: JOB_ID,
      expectedPresenter: PRIMARY,
      sessionNonce: SESSION_NONCE,
      expectedServer: "github.com",
      evaluatedAt: 1_700_000_050_000,
      maxResolutionAgeSec: 60,
      maxProofAgeSec: 60,
      maxPresentationAgeSec: 60,
    };
    await expect(classifyCciTlsnProof(
      result.record,
      bundle,
      PROOF_HASH,
      context,
      { verifyIdentityPresentation, verifyNativeTlsn },
    )).resolves.toMatchObject({
      status: "native-cci",
      claim: { ref: `cci-tlsn:${PROOF_HASH}` },
      jobId: JOB_ID,
      sessionNonce: SESSION_NONCE,
      evaluatedAt: context.evaluatedAt,
      verification: { authority: "native-tlsn:testnet" },
    });
    expect(verifyIdentityPresentation).toHaveBeenCalledWith(expect.objectContaining({
      bundle,
      signedBytes: expect.any(Uint8Array),
    }));
    await expect(classifyCciTlsnProof(
      result.record,
      { ...bundle, claims: [{ ref: PRIMARY }] },
      PROOF_HASH,
      context,
      { verifyIdentityPresentation: () => true, verifyNativeTlsn },
    )).resolves.toEqual({
      status: "invalid",
      reason: "registered TLSN commitment was not presented in the signed IdentityBundle",
    });
    const sessionProofHash = "ef".repeat(32);
    await expect(classifyCciTlsnProof(
      result.record,
      {
        ...bundle,
        claims: [{ ref: PRIMARY }, { ref: `cci-tlsn:${sessionProofHash}` }],
      },
      sessionProofHash,
      context,
      { verifyIdentityPresentation: () => true, verifyNativeTlsn },
    )).resolves.toEqual({
      status: "external-required",
      reason: "TLSN proof is not registered in the authenticated CCI record",
    });
    await expect(classifyCciTlsnProof(
      result.record,
      bundle,
      PROOF_HASH,
      context,
      { verifyIdentityPresentation: () => false, verifyNativeTlsn },
    )).resolves.toEqual({
      status: "invalid",
      reason: "IdentityBundle presentation is not authenticated",
    });
    expect(verifyNativeTlsn).toHaveBeenCalledWith(expect.objectContaining({
      subject: PRIMARY,
      jobId: JOB_ID,
      sessionNonce: SESSION_NONCE,
      expectedServer: "github.com",
      proofHash: PROOF_HASH,
      bundleHash: expect.any(String),
    }));

    await expect(classifyCciTlsnProof(
      result.record,
      { ...bundle, sessionNonce: "old-session-nonce" },
      PROOF_HASH,
      context,
      { verifyIdentityPresentation, verifyNativeTlsn },
    )).resolves.toEqual({
      status: "invalid",
      reason: "IdentityBundle session nonce does not match the active Vet session",
    });

    const wrongBindingVerifier = vi.fn((input: VerifyNativeCciTlsnInput) => ({
      status: "verified" as const,
      verifiedAt: 1_700_000_050_000,
      authority: "native-tlsn:testnet",
      binding: {
        subject: input.subject,
        jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7F",
        sessionNonce: input.sessionNonce,
        expectedServer: input.expectedServer,
        bundleHash: input.bundleHash,
        proofHash: input.proofHash,
        resolutionObservedAt: input.resolution.observedAt,
      },
    }));
    await expect(classifyCciTlsnProof(
      result.record,
      bundle,
      PROOF_HASH,
      context,
      {
        verifyIdentityPresentation: () => true,
        verifyNativeTlsn: wrongBindingVerifier,
      },
    )).resolves.toEqual({
      status: "error",
      reason: "native TLSN authentication is malformed",
    });

    await expect(classifyCciTlsnProof(
      result.record,
      bundle,
      PROOF_HASH,
      { ...context, jobId: "legacy-job" },
      { verifyIdentityPresentation, verifyNativeTlsn },
    )).resolves.toEqual({
      status: "invalid",
      reason: "CCI TLSN request is malformed",
    });
  });
});
