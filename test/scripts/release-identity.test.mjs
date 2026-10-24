import assert from "node:assert/strict";
import { test } from "node:test";
import { validateReleaseIdentity } from "../../scripts/release-identity.mjs";

test("each published identity requires every release and publish-policy field", () => {
  for (const name of ["@kynesyslabs/dacs", "@kynesyslabs/dacs-node", "create-dacs-agent"]) {
    const valid = {
      name, license: "MIT",
      repository: { url: "git+https://github.com/DACS-Agent-commerce/dacs-sdk.git" },
      publishConfig: { access: "public", provenance: true },
    };
    assert.doesNotThrow(() => validateReleaseIdentity(valid, name));
    for (const [path, wrong] of [
      [["name"], "other"], [["license"], "UNLICENSED"],
      [["repository", "url"], "https://example.invalid/repo"],
      [["publishConfig", "access"], "restricted"], [["publishConfig", "provenance"], false],
    ]) {
      for (const missing of [false, true]) {
        const damaged = structuredClone(valid);
        const parent = path.length === 1 ? damaged : damaged[path[0]];
        const field = path.at(-1);
        if (missing) delete parent[field]; else parent[field] = wrong;
        assert.throws(() => validateReleaseIdentity(damaged, name),
          error => error.message === `${name}: release identity or publish policy is invalid`);
      }
    }
    for (const field of ["repository", "publishConfig"]) {
      const damaged = { ...valid }; delete damaged[field];
      assert.throws(() => validateReleaseIdentity(damaged, name), /identity or publish policy/);
    }
  }
});
