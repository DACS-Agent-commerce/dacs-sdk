import { describe, expect, test, vi } from "vitest";

import type { IdentityBundle } from "../../src/artifacts/types.js";
import type { VerifyNativeCciTlsnInput } from "../../src/identity/demosCci.js";
import {
  buildAgent,
  type AgentNativeCciTlsnInput,
} from "../../src/agent/Agent.js";
import type { SubstrateAdapter } from "../../src/substrate/SubstrateAdapter.js";

const PRIMARY =
  "did:demos:agent:1111111111111111111111111111111111111111111111111111111111111111";
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const PROOF_HASH = "ab".repeat(32);
const SESSION_NONCE = "vet-session-0123456789abcdef";
const OBSERVED_AT = 1_700_000_040_000;
const EVALUATED_AT = 1_700_000_050_000;

const rawGcr = {
  result: 200,
  response: {
    web2: {
      github: [{
        username: "alice",
        userId: "42",
        proofType: "tlsn",
        proofHash: PROOF_HASH,
        timestamp: OBSERVED_AT,
      }],
    },
  },
};

function input(subject = PRIMARY): AgentNativeCciTlsnInput {
  const bundle: IdentityBundle = {
    bundleVersion: "1",
    presentedBy: subject,
    presentedAt: EVALUATED_AT,
    sessionNonce: SESSION_NONCE,
    claims: [{ ref: subject }, { ref: `cci-tlsn:${PROOF_HASH}` }],
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: subject, signature: "test-signature" }],
    },
  };
  return {
    subject,
    bundle,
    proofHash: PROOF_HASH,
    context: {
      jobId: JOB_ID,
      expectedPresenter: subject,
      sessionNonce: SESSION_NONCE,
      expectedServer: "github.com",
      maxResolutionAgeSec: 60,
      maxProofAgeSec: 60,
      maxPresentationAgeSec: 60,
    },
  };
}

describe("Agent authenticated Demos CCI", () => {
  test("qualifies native TLSN through the captured public Agent path", async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolveIdentity = vi.fn(async (ref: string) => {
      await paused;
      return { ref, boundTo: ref, raw: rawGcr };
    });
    const verifyIdentityPresentation = vi.fn(() => true);
    const verifyNativeTlsn = vi.fn((candidate: VerifyNativeCciTlsnInput) => ({
      status: "verified" as const,
      verifiedAt: EVALUATED_AT,
      authority: "native-tlsn:testnet",
      binding: {
        subject: candidate.subject,
        jobId: candidate.jobId,
        sessionNonce: candidate.sessionNonce,
        expectedServer: candidate.expectedServer,
        bundleHash: candidate.bundleHash,
        proofHash: candidate.proofHash,
        resolutionObservedAt: candidate.resolution.observedAt,
      },
    }));
    const adapter = { resolveIdentity } as unknown as SubstrateAdapter;
    const agent = buildAgent(adapter, {
      demosRpc: "https://node.example",
      demosCci: {
        authenticateResolution: ({ subject }) => ({
          status: "authenticated",
          subject,
          observedAt: OBSERVED_AT,
          authority: "demos:testnet",
        }),
        verifyIdentityPresentation,
        verifyNativeTlsn,
        nowMs: () => EVALUATED_AT,
      },
    });

    const request = input();
    const qualification = agent.qualifyNativeCciTlsn(request);
    request.context.sessionNonce = "mutated-after-capture";
    request.bundle.sessionNonce = "mutated-after-capture";
    release();

    await expect(qualification).resolves.toMatchObject({
      status: "native-cci",
      jobId: JOB_ID,
      sessionNonce: SESSION_NONCE,
      evaluatedAt: EVALUATED_AT,
      verification: {
        authority: "native-tlsn:testnet",
        binding: {
          subject: PRIMARY,
          jobId: JOB_ID,
          sessionNonce: SESSION_NONCE,
          expectedServer: "github.com",
          proofHash: PROOF_HASH,
          resolutionObservedAt: OBSERVED_AT,
        },
      },
    });
    expect(resolveIdentity).toHaveBeenCalledWith("11".repeat(32));
    expect(verifyIdentityPresentation).toHaveBeenCalledTimes(1);
    expect(verifyNativeTlsn).toHaveBeenCalledTimes(1);
  });

  test("accepts a qualified presenter against parameter-free resolver evidence", async () => {
    const qualified = `${PRIMARY}?network=testnet`;
    const resolveIdentity = vi.fn(async (ref: string) => ({
      ref,
      boundTo: ref,
      raw: rawGcr,
    }));
    const verifyNativeTlsn = vi.fn((candidate: VerifyNativeCciTlsnInput) => ({
      status: "verified" as const,
      verifiedAt: EVALUATED_AT,
      authority: "native-tlsn:testnet",
      binding: {
        subject: candidate.subject,
        jobId: candidate.jobId,
        sessionNonce: candidate.sessionNonce,
        expectedServer: candidate.expectedServer,
        bundleHash: candidate.bundleHash,
        proofHash: candidate.proofHash,
        resolutionObservedAt: candidate.resolution.observedAt,
      },
    }));
    const agent = buildAgent(
      { resolveIdentity } as unknown as SubstrateAdapter,
      {
        demosRpc: "https://node.example",
        demosCci: {
          authenticateResolution: ({ subject }) => ({
            status: "authenticated",
            subject,
            observedAt: OBSERVED_AT,
            authority: "demos:testnet",
          }),
          verifyIdentityPresentation: () => true,
          verifyNativeTlsn,
          nowMs: () => EVALUATED_AT,
        },
      },
    );
    const request = input(qualified);

    await expect(agent.qualifyNativeCciTlsn(request)).resolves.toMatchObject({
      status: "native-cci",
      verification: { binding: { subject: PRIMARY } },
    });
    expect(resolveIdentity).toHaveBeenCalledWith("11".repeat(32));
    expect(verifyNativeTlsn).toHaveBeenCalledWith(
      expect.objectContaining({ subject: PRIMARY }),
    );
  });

  test("fails before RPC for a non-canonical authenticated subject", async () => {
    const resolveIdentity = vi.fn();
    const agent = buildAgent(
      { resolveIdentity } as unknown as SubstrateAdapter,
      {
        demosRpc: "https://node.example",
        demosCci: {
          authenticateResolution: () => ({
            status: "error",
            reason: "must not run",
          }),
        },
      },
    );

    await expect(agent.resolveAuthenticatedIdentity("0x1234")).resolves.toEqual({
      status: "error",
      reason: "CCI subject is malformed",
    });
    expect(resolveIdentity).not.toHaveBeenCalled();
  });
});
