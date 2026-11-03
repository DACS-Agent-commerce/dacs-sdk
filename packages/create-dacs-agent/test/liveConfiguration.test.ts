import { parseEnv } from "node:util";
import { parseDocument } from "yaml";
import { expect, test } from "vitest";

import { projectTemplates } from "../src/index.js";

const selections = ["both", "x402", "pay-dem"] as const;
const roles = ["buyer", "seller"] as const;

test.each(selections)("%s wires each role's Listing draft to its matching read-only Compose mount", (rails) => {
  for (const role of roles) {
    const files = projectTemplates({ packageName: "agent", mode: "live-demos", role,
      deployment: "docker", rails });
    const document = parseDocument(files["compose.yaml"]!, { merge: true, uniqueKeys: true });
    expect(document.errors).toEqual([]);
    const compose = document.toJS();
    const env = parseEnv(files[".env.example"]!);
    const asset = rails === "pay-dem" ? "DEM" : "USDC";
    expect(env.DACS_MAX_SERVICE_ASSET).toBe(asset);
    expect(env.DACS_MAX_SERVICE_AMOUNT).toBe("1");
    expect(env.DACS_MAX_SETUP_SPEND_DEM).toBe("10");
    expect(env.DACS_MAX_DEMOS_NETWORK_FEE_DEM).toBe("2");
    if (rails === "pay-dem") {
      expect(env).not.toHaveProperty("DACS_X402_NETWORK");
    } else {
      expect(env.DACS_X402_NETWORK).toBe("eip155:84532");
      expect(env.DACS_MAX_EVM_NETWORK_FEE_ETH).toBe("0.001");
    }
    // parseEnv allows repeated assignments; reject them so concatenated or
    // duplicated settings cannot silently shadow the intended rail defaults.
    const settings = files[".env.example"]!.split("\n").filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line));
    expect(new Set(settings.map((line) => line.split("=", 1)[0])).size).toBe(settings.length);
    expect(env).not.toHaveProperty("DACS_LISTING_DRAFT_FILE");
    expect(Object.keys(compose.services).sort()).toEqual(["buyer", "seller"]);
    for (const generatedRole of roles) {
      const service = compose.services[generatedRole];
      expect(service.environment.DACS_ROLE).toBe(generatedRole);
      expect(service.environment.DACS_MAX_SERVICE_ASSET).toBe(`\${DACS_MAX_SERVICE_ASSET:-${asset}}`);
      expect(service.environment).not.toHaveProperty("DACS_LISTING_DRAFT_FILE");
      for (const [rail, key, file] of [
        ["x402", "DACS_X402_LISTING_DRAFT_FILE", "listing-draft-x402.json"],
        ["pay-dem", "DACS_PAY_DEM_LISTING_DRAFT_FILE", "listing-draft-pay-dem.json"],
      ] as const) {
        const enabled = rails === "both" || rails === rail;
        const target = `/run/dacs/${file}`;
        const mount = `\${${key}:?set ${key}}:${target}:ro`;
        if (enabled) {
          expect(env[key]).toBe(`./${file}`);
          expect(service.environment[key]).toBe(target);
          expect(service.volumes.filter((volume: string) => volume === mount)).toHaveLength(1);
        } else {
          expect(env).not.toHaveProperty(key);
          expect(service.environment).not.toHaveProperty(key);
          expect(service.volumes.some((volume: string) => volume.includes(key) || volume.includes(file))).toBe(false);
        }
      }
      const listingMounts = service.volumes.filter((volume: string) => volume.includes("/run/dacs/listing-draft"));
      expect(listingMounts).toHaveLength(rails === "both" ? 2 : 1);
    }
  }
});
