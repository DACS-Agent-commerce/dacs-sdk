import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FIXED_PRICE_OFFLINE_COMMERCE_PROFILE,
  FIXED_PRICE_OFFLINE_STANDARD_REVISION,
} from "@kynesyslabs/dacs/commerce";
import { afterEach, describe, expect, test, vi } from "vitest";

import { runDeterministicOfflineLifecycle } from "../src/offlineLifecycle.js";

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

describe("deterministic offline lifecycle", () => {
  test("writes and independently verifies a visibly offline DACS 1-5 graph", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("offline lifecycle attempted network access"));
    const directory = await outputDirectory();

    const report = await runDeterministicOfflineLifecycle({
      outputDirectory: directory,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      profile: FIXED_PRICE_OFFLINE_COMMERCE_PROFILE,
      standardRevision: FIXED_PRICE_OFFLINE_STANDARD_REVISION,
      mode: "offline",
      payment: {
        railId: "ap2:offline-mocked",
        availability: "mocked",
        disposition: "offline",
      },
      verification: {
        listing: true,
        buyerVet: true,
        sellerVet: true,
        commitment: true,
        paymentEvidence: true,
        deliveryEvidence: true,
        providerReceipt: true,
        buyerBundle: true,
        sellerBundle: true,
        bundleConsistency: "unified",
      },
      overallSuccess: true,
    });
    expect(report.phases.map(({ stage }) => stage)).toEqual([
      "DACS-1",
      "DACS-2",
      "DACS-3",
      "DACS-4",
      "DACS-5",
    ]);
    expect(report.phases.every(({ outcome }) => outcome === "ok")).toBe(true);

    const artifactFiles = await readdir(join(directory, "artifacts"));
    expect(artifactFiles).toEqual(
      expect.arrayContaining([
        "dacs-1-listing.json",
        "dacs-2-buyer-vet.json",
        "dacs-2-buyer-self-signed-assertion.json",
        "dacs-2-buyer-verify-result.json",
        "dacs-2-seller-vet.json",
        "dacs-2-seller-self-signed-assertion.json",
        "dacs-2-seller-verify-result.json",
        "dacs-2-self-signed-recipe.json",
        "dacs-3-agreement.json",
        "dacs-3-finality-commitment.json",
        "dacs-4-offline-ap2-provider-receipt.json",
        "dacs-4-payment-evidence.json",
        "dacs-4-delivery-evidence.json",
        "dacs-5-buyer-bundle.json",
        "dacs-5-seller-bundle.json",
      ]),
    );
    expect(report.artifacts).toHaveLength(20);

    const persisted = JSON.parse(
      await readFile(report.reportPath, "utf8"),
    ) as Record<string, unknown>;
    expect(persisted).toEqual(report);
    const buyerVet = JSON.parse(
      await readFile(join(directory, "artifacts", "dacs-2-buyer-vet.json"), "utf8"),
    ) as { dealSpecific: unknown[]; overallDecision: string };
    const recipe = JSON.parse(
      await readFile(
        join(directory, "artifacts", "dacs-2-self-signed-recipe.json"),
        "utf8",
      ),
    ) as { defaultMethod: { kind: string }; availability: string };
    expect(buyerVet).toMatchObject({
      dealSpecific: [expect.any(Object)],
      overallDecision: "pass",
    });
    expect(recipe).toMatchObject({
      defaultMethod: { kind: "self-signed" },
      availability: "bilateral",
    });
    const allOutput = await Promise.all(
      artifactFiles.map((file) => readFile(join(directory, "artifacts", file), "utf8")),
    );
    expect(allOutput.join("\n")).not.toContain('"phase":"pay-x402"');
    expect(allOutput.join("\n")).not.toContain('"availability":"live"');
  });
});
