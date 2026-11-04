import assert from "node:assert/strict";
import { test } from "vitest";

const identityModulePath = "../../scripts/release-identity.mjs";
const { validateReleaseIdentity } = await import(identityModulePath);

test("each published identity requires every release and publish-policy field", () => {
  for (const name of ["@kynesyslabs/dacs", "@kynesyslabs/dacs-node", "create-dacs-agent"]) {
    const valid = {
      name, license: "MIT",
      repository: { url: "git+https://github.com/DACS-Agent-commerce/dacs-sdk.git" },
      publishConfig: { access: "public", provenance: true },
    };
    assert.doesNotThrow(() => validateReleaseIdentity(valid, name));
    for (const damage of [
      { name: "other" }, { name: undefined },
      { license: "UNLICENSED" }, { license: undefined },
      { repository: { url: "https://example.invalid/repo" } }, { repository: {} },
      { publishConfig: { access: "restricted", provenance: true } },
      { publishConfig: { provenance: true } },
      { publishConfig: { access: "public", provenance: false } },
      { publishConfig: { access: "public" } },
      { repository: undefined }, { publishConfig: undefined },
    ]) {
      assert.throws(() => validateReleaseIdentity({ ...valid, ...damage }, name),
        error => error instanceof Error && error.message === `${name}: release identity or publish policy is invalid`);
    }
  }
});
