import { expect, test } from "vitest";
import { projectTemplates } from "../src/index.js";

// npm package names can contain separator sequences Docker repository names
// reject. The generated default and documented build command must agree.
test("generates a usable Docker image reference for repeated package-name separators", () => {
  for (const packageName of ["a..b", "a__b", "a---b", "a._-b"]) {
    const files = projectTemplates({ packageName, mode: "live-demos", role: "buyer",
      deployment: "docker", rails: "both" });
    expect(files[".env.example"], packageName).toContain("DACS_IMAGE=a-b:local\n");
    expect(files["README.md"], packageName).toContain("docker build -t a-b:local .\n");
  }
});

test("documents setup and purchase bounds for exactly the selected payment rails", () => {
  for (const rails of ["both", "x402", "pay-dem"] as const) {
    const files = projectTemplates({ packageName: "agent", mode: "live-demos", role: "buyer",
      deployment: "docker", rails });
    const readme = files["README.md"]!;
    const setup = readme.split("\n").filter((line) => line.startsWith("npm run dacs:setup --"));
    const buy = readme.split("\n").filter((line) => line.startsWith("npm run dacs:buy --"));
    if (rails === "both") {
      expect(setup).toEqual([
        "npm run dacs:setup -- --rail x402 --max-spend-dem 10",
        "npm run dacs:setup -- --rail pay-dem --max-spend-dem 10",
      ]);
      expect(buy).toEqual([
        "npm run dacs:buy -- --rail x402 --listing-ref stor-... --request-file ./request.json --max-service-amount 1 --max-network-fee-eth 0.001",
        "npm run dacs:buy -- --rail pay-dem --listing-ref stor-... --request-file ./request.json --max-service-amount 1 --max-total-debit-dem 3",
      ]);
    } else {
      expect(setup).toEqual(["npm run dacs:setup -- --max-spend-dem 10"]);
      expect(buy).toEqual([
        "npm run dacs:buy -- --listing-ref stor-... --request-file ./request.json --max-service-amount 1 " +
        (rails === "x402" ? "--max-network-fee-eth 0.001" : "--max-total-debit-dem 3"),
      ]);
    }
    const secrets = files["secrets/README.md"]!;
    if (rails === "pay-dem") {
      expect(secrets).toContain("does not require or accept EVM wallet files");
      expect(secrets).not.toContain("two additional role-owned files");
    } else {
      expect(secrets).toContain("two additional role-owned files");
      expect(secrets).not.toContain("does not require or accept EVM wallet files");
    }
  }
});
