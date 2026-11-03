import { describe, expect, test } from "vitest";
import { liveProjectTemplates } from "../src/liveTemplates.js";

describe("generated operator contracts", () => {
  test.each(["pay-dem", "x402", "both"] as const)("keeps %s artifacts coherent", (rails) => {
    const files = liveProjectTemplates({
      packageName: "operator-contract", deployment: "docker", role: "buyer",
      rails, runtimeUid: 10001, runtimeGid: 10001,
    });
    const pkg = JSON.parse(files["package.json"]!);
    expect(pkg).toMatchObject({
      name: "operator-contract", version: "0.1.0", private: true, type: "module",
      engines: { node: "^20.19.0 || >=22.12.0" },
      devDependencies: { "@types/node": "20.19.1", typescript: "5.9.2" },
    });
    const runtime = "node --import @kynesyslabs/dacs-node/demos-loader";
    const cli = `npm run build --silent && ${runtime} dist/src/cli.js`;
    expect(pkg.scripts).toEqual({
      build: "tsc -p tsconfig.json", typecheck: "tsc --noEmit -p tsconfig.json",
      test: `npm run build && ${runtime} --test dist/test/live-bootstrap.test.js`,
      "dacs:doctor": `${cli} doctor`, "dacs:doctor:funded": `${cli} doctor-funded`,
      "dacs:up": `${cli} up`, "dacs:setup": `${cli} setup`,
      "dacs:buy": `${cli} buy`, "dacs:status": `${cli} status`,
      "dacs:metrics": `${cli} metrics`, "dacs:down": `${cli} down`,
      "dacs:backup": `${cli} backup`, "dacs:restore": `${cli} restore`,
      "dacs:uninstall": `${cli} uninstall`, "dacs:upgrade": `${cli} upgrade`,
      "dacs:service": `npm run build --silent && ${runtime} dist/src/service.js`,
      "dacs:smoke:offline": `npm run build --silent && ${runtime} dist/src/offline-smoke.js`,
    });

    const nativeOnly = rails === "pay-dem";
    const asset = nativeOnly ? "DEM" : "USDC";
    expect(files["dacs.config.ts"]).toContain(nativeOnly
      ? 'requestedNetwork: "demos"'
      : 'requestedNetwork: process.env.DACS_X402_NETWORK ?? "eip155:84532"');
    expect(files["dacs.config.ts"]).toContain(`asset: process.env.DACS_MAX_SERVICE_ASSET ?? "${asset}"`);
    expect(files["compose.yaml"]).toContain(`DACS_MAX_SERVICE_ASSET: \${DACS_MAX_SERVICE_ASSET:-${asset}}`);
    expect(files[".env.example"]).toContain(`DACS_MAX_SERVICE_ASSET=${asset}`);
    if (rails !== "both") {
      const unrelated = nativeOnly
        ? ["DACS_BUYER_EVM_SECRET_FILE", "DACS_SELLER_EVM_SECRET_FILE",
            "DACS_SELLER_EVM_PAYEE", "DACS_X402_", "DACS_EVM_",
            "DACS_FIXED_PRICE_AMOUNT", "DACS_MAX_EVM_"]
        : ["DACS_PAY_DEM_", "DACS_MAX_PAY_DEM_"];
      for (const name of unrelated) {
        expect(files["compose.yaml"]).not.toContain(name);
        expect(files[".env.example"]).not.toContain(name);
      }
    }

    const roles = files["compose.yaml"]!.split("services:\n")[1]!;
    const [buyer, seller] = roles.split("  seller:\n");
    for (const [role, section] of [["buyer", buyer!], ["seller", seller!]] as const) {
      expect(section).toContain(`DACS_ROLE: ${role}`);
      expect(section).toContain(`DACS_${role.toUpperCase()}_DEMOS_SECRET_FILE: /run/secrets/demos-identity`);
      for (const rail of ["x402", "pay-dem"] as const) {
        const name = rail === "x402" ? "X402" : "PAY_DEM";
        const selected = rails === "both" || rails === rail;
        const locator = `/run/dacs/listing-draft-${rail}.json`;
        if (selected) {
          expect(section).toContain(`DACS_${name}_LISTING_DRAFT_FILE: ${locator}`);
          expect(section).toContain(`\${DACS_${name}_LISTING_DRAFT_FILE:?set DACS_${name}_LISTING_DRAFT_FILE}:${locator}:ro`);
          expect(files[".env.example"]).toContain(`DACS_${name}_LISTING_DRAFT_FILE=./listing-draft-${rail}.json`);
        } else {
          expect(section).not.toContain(`DACS_${name}_`);
          expect(files[".env.example"]).not.toContain(`DACS_${name}_`);
        }
      }
    }
    const secrets = files["secrets/README.md"]!;
    expect(secrets).toContain(nativeOnly
      ? "This native DEM profile does not require or accept EVM wallet files."
      : "Keep their EVM wallets in two additional role-owned files");
    if (nativeOnly) {
      expect(files["compose.yaml"]).not.toContain("EVM_SECRET_FILE");
      expect(files[".env.example"]).not.toContain("EVM_SECRET_FILE");
    }
    const readme = files["README.md"]!;
    if (rails === "both") {
      for (const rail of ["x402", "pay-dem"]) {
        expect(readme).toContain(`npm run dacs:setup -- --rail ${rail} --max-spend-dem 10`);
        expect(readme).toContain(`npm run dacs:buy -- --rail ${rail} --listing-ref`);
      }
    } else {
      expect(readme).toContain("npm run dacs:setup -- --max-spend-dem 10");
      expect(readme).toContain("npm run dacs:buy -- --listing-ref");
    }
    if (rails !== "x402") expect(readme).toContain("--max-total-debit-dem 3");
    if (!nativeOnly) expect(readme).toContain("--max-network-fee-eth 0.001");
    expect(readme).toContain("Restore requires the exact creating\nSDK release");
    expect(readme).toContain("Cross-release actor-data migration is unsupported.");
    expect(readme).not.toContain("this or an earlier SDK release");
    // Self-reported node build metadata is a reported fact, never a gate.
    expect(files["src/doctor.ts"]).toContain(
      "buyerNodeBuild: inspectDacsDemosNodeCompatibilityV1(infos[0]).reasonCode",
    );
    expect(files["src/doctor.ts"]).not.toContain("blocked(compatibility.reasonCode)");
    expect(readme).toContain("(`demos-node-build-dirty`)");
    expect(readme).toContain("not block start, setup or purchase");
  });
});
