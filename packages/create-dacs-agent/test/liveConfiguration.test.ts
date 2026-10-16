import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

import ts from "typescript";
import { parseDocument } from "yaml";
import { afterEach, expect, test } from "vitest";

import { projectTemplates } from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const selections = ["both", "x402", "pay-dem"] as const;
const roles = ["buyer", "seller"] as const;

test.each(selections)("%s emits executable payment configuration with defaults and explicit overrides", async (rails) => {
  for (const role of roles) {
    const root = await mkdtemp(join(tmpdir(), "dacs-config-contract-"));
    directories.push(root);
    const files = projectTemplates({ packageName: "agent", mode: "live-demos", role,
      deployment: "docker", rails });
    await writeFile(join(root, "config.mjs"), ts.transpileModule(files["dacs.config.ts"]!, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !name.startsWith("DACS_") && name !== "NODE_OPTIONS"));
    const script = `import selected, { generatedRoleConfig } from "./config.mjs";
const defaults = { selected: selected(), buyer: generatedRoleConfig("buyer"), seller: generatedRoleConfig("seller") };
Object.assign(process.env, {
  DACS_ROLE: "seller", DACS_X402_NETWORK: "eip155:1", DACS_MAX_SERVICE_ASSET: "OVERRIDE",
  DACS_MAX_SERVICE_AMOUNT: "0.25", DACS_MAX_SETUP_SPEND_DEM: "4",
  DACS_MAX_DEMOS_NETWORK_FEE_DEM: "0.5", DACS_MAX_EVM_NETWORK_FEE_ETH: "0.0002",
});
console.log(JSON.stringify({ defaults, overrides: {
  selected: selected(), buyer: generatedRoleConfig("buyer"), seller: generatedRoleConfig("seller"),
} }));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: root, env, encoding: "utf8", timeout: 10_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const { defaults, overrides } = JSON.parse(child.stdout);
    expect(defaults.selected.role).toBe(role);
    expect(overrides.selected.role).toBe("seller");
    for (const generatedRole of roles) {
      expect(defaults[generatedRole]).toMatchObject({
        mode: "live-demos", role: generatedRole, dataDirectory: `./data/${generatedRole}`,
        rail: { requestedNetwork: rails === "pay-dem" ? "demos" : "eip155:84532",
          enabledProfiles: rails === "both" ? ["pay-dem", "x402"] : [rails] },
        limits: { maxServiceAmount: { asset: rails === "pay-dem" ? "DEM" : "USDC", amount: "1" },
          maxSetupSpendDem: "10", maxDemosNetworkFeeDem: "2", maxEvmNetworkFeeEth: "0.001" },
      });
      expect(overrides[generatedRole]).toMatchObject({
        role: generatedRole,
        rail: { requestedNetwork: rails === "pay-dem" ? "demos" : "eip155:1",
          enabledProfiles: rails === "both" ? ["pay-dem", "x402"] : [rails] },
        limits: { maxServiceAmount: { asset: "OVERRIDE", amount: "0.25" },
          maxSetupSpendDem: "4", maxDemosNetworkFeeDem: "0.5", maxEvmNetworkFeeEth: "0.0002" },
      });
    }
  }
});

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
