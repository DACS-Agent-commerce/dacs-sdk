import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isAttestationRef } from "@kynesyslabs/dacs/artifacts";
import {
  FIXED_PRICE_OFFLINE_COMMERCE_PROFILE,
  FIXED_PRICE_OFFLINE_STANDARD_REVISION,
} from "@kynesyslabs/dacs/commerce";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  runOfflineVerifierSimulation,
  simulationBundleGraphVerificationPassed,
} from "../src/offlineLifecycle.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

async function outputDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dacs-node-offline-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("offline verifier simulation", () => {
  test("does not treat a partial recursive bundle result as verified", () => {
    expect(simulationBundleGraphVerificationPassed({
      ok: true,
      fullyVerified: false,
    })).toBe(false);
    expect(simulationBundleGraphVerificationPassed({
      ok: true,
      fullyVerified: true,
    })).toBe(true);
    expect(simulationBundleGraphVerificationPassed({
      ok: false,
      fullyVerified: true,
    })).toBe(false);
  });

  test("exercises recursive checks without asserting normative or commercial success", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("offline lifecycle attempted network access"));
    const directory = await outputDirectory();

    const report = await runOfflineVerifierSimulation({
      outputDirectory: directory,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      reportKind: "dacs-sdk-offline-verifier-simulation",
      reportVersion: "2",
      normativeConformance: false,
      commercialSuccess: false,
      simulationPassed: true,
      profile: FIXED_PRICE_OFFLINE_COMMERCE_PROFILE,
      standardRevision: FIXED_PRICE_OFFLINE_STANDARD_REVISION,
      mode: "offline",
      payment: {
        railId: "x-simulation-ap2",
        availability: "mocked",
        disposition: "simulation-only",
      },
      assurance: {
        purpose: "internal-verifier-exercise",
        persistedArtifacts: "wrapped-simulation-fixtures",
        substrateAuthority: "mocked-local-not-sr2",
        providerAuthority: "mocked-self-signed-not-sr3",
        railAuthority: "mocked-local-not-rav-r5",
        jobIdDiscipline: "fresh-csprng-ulid-per-run",
        sessionNonceDiscipline:
          "fresh-per-run-no-normative-challenge-ledger",
        paymentValueMoved: false,
        fixtureKeys: "public-deterministic-test-keys",
      },
      internalChecks: {
        listing: true,
        buyerVet: true,
        sellerVet: true,
        commitment: true,
        paymentEvidence: true,
        deliveryEvidence: true,
        providerFixtureSignature: true,
        buyerBundle: true,
        sellerBundle: true,
        bundleConsistency: "unified",
      },
    });
    expect(report.phases.map(({ stage }) => stage)).toEqual([
      "DACS-1",
      "DACS-2",
      "DACS-3",
      "DACS-4",
      "DACS-5",
    ]);
    expect(
      report.phases.every(({ outcome }) => outcome === "simulated-pass"),
    ).toBe(true);

    const artifactDirectory = join(directory, "simulation-artifacts");
    const artifactFiles = await readdir(artifactDirectory);
    expect(artifactFiles).toEqual(
      expect.arrayContaining([
        "dacs-1-listing.simulation.json",
        "dacs-2-buyer-vet.simulation.json",
        "dacs-2-buyer-self-signed-assertion.simulation.json",
        "dacs-2-buyer-verify-result.simulation.json",
        "dacs-2-seller-vet.simulation.json",
        "dacs-2-seller-self-signed-assertion.simulation.json",
        "dacs-2-seller-verify-result.simulation.json",
        "dacs-2-self-signed-recipe.simulation.json",
        "dacs-3-agreement.simulation.json",
        "dacs-3-finality-commitment.simulation.json",
        "dacs-4-simulation-provider-fixture.simulation.json",
        "dacs-4-payment-evidence.simulation.json",
        "dacs-4-delivery-evidence.simulation.json",
        "dacs-5-buyer-bundle.simulation.json",
        "dacs-5-seller-bundle.simulation.json",
      ]),
    );
    expect(report.artifacts).toHaveLength(20);

    const persisted = JSON.parse(
      await readFile(report.reportPath, "utf8"),
    ) as Record<string, unknown>;
    expect(persisted).toEqual(report);
    const buyerVetEnvelope = JSON.parse(
      await readFile(
        join(artifactDirectory, "dacs-2-buyer-vet.simulation.json"),
        "utf8",
      ),
    ) as {
      normativeConformance: boolean;
      commercialAuthority: string;
      anchorAuthority: string;
      portableAttestationRef: boolean;
      value: { dealSpecific: unknown[]; overallDecision: string };
    };
    const recipeEnvelope = JSON.parse(
      await readFile(
        join(
          artifactDirectory,
          "dacs-2-self-signed-recipe.simulation.json",
        ),
        "utf8",
      ),
    ) as {
      normativeConformance: boolean;
      value: { defaultMethod: { kind: string }; availability: string };
    };
    expect(buyerVetEnvelope).toMatchObject({
      normativeConformance: false,
      commercialAuthority: "none",
      anchorAuthority: "none",
      portableAttestationRef: false,
    });
    expect(buyerVetEnvelope.value).toMatchObject({
      dealSpecific: [expect.any(Object)],
      overallDecision: "pass",
    });
    expect(recipeEnvelope.value).toMatchObject({
      defaultMethod: { kind: "self-signed" },
      availability: "bilateral",
    });
    const parsedArtifacts = await Promise.all(
      artifactFiles.map(async (file) =>
        JSON.parse(await readFile(join(artifactDirectory, file), "utf8"))),
    );
    expect(
      parsedArtifacts.every(
        (artifact) =>
          artifact.simulationArtifactVersion === "1" &&
          artifact.normativeConformance === false &&
          artifact.commercialAuthority === "none" &&
          artifact.anchorAuthority === "none" &&
          artifact.portableAttestationRef === false &&
          !isAttestationRef(artifact),
      ),
    ).toBe(true);
    const allOutput = JSON.stringify(parsedArtifacts);
    expect(allOutput).not.toContain('"phase":"pay-x402"');
    expect(allOutput).not.toContain('"availability":"live"');
    expect(allOutput).not.toContain('"receiptVersion":"offline-ap2-v1"');
  });

  test("creates fresh job and session identifiers for every simulation", async () => {
    const firstDirectory = await outputDirectory();
    const secondDirectory = await outputDirectory();
    const [first, second] = await Promise.all([
      runOfflineVerifierSimulation({ outputDirectory: firstDirectory }),
      runOfflineVerifierSimulation({ outputDirectory: secondDirectory }),
    ]);
    expect(first.jobId).not.toBe(second.jobId);

    const readNonce = async (directory: string): Promise<string> => {
      const envelope = JSON.parse(
        await readFile(
          join(
            directory,
            "simulation-artifacts",
            "dacs-1-buyer-identity.simulation.json",
          ),
          "utf8",
        ),
      ) as { value: { sessionNonce: string } };
      return envelope.value.sessionNonce;
    };
    const [firstNonce, secondNonce] = await Promise.all([
      readNonce(firstDirectory),
      readNonce(secondDirectory),
    ]);
    expect(firstNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(secondNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(firstNonce).not.toBe(secondNonce);
  });
});
