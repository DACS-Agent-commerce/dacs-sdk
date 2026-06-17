import { describe, expect, test } from "vitest";

import { vetCore, type VetDeps } from "../../src/agent/vetCore.js";
import type { RecipeDescriptor } from "../../src/registry/types.js";

function recipe(over: Partial<RecipeDescriptor>): RecipeDescriptor {
  return { id: "r", method: "self-signed", availability: "live", params: {}, ...over };
}

const deps = (proxyStatus = 200): VetDeps => ({
  proxyFetch: async () => ({ status: proxyStatus, responseHash: "0xhash" }),
  now: () => "2026-01-01T00:00:00Z",
});

describe("vetCore (DACS-2 Vet stage)", () => {
  test("self-signed records a pass with the subject as its own authority", async () => {
    const cvr = await vetCore(
      { subject: "did:demos:agent:alice", recipe: recipe({ id: "self-signed", method: "self-signed" }) },
      deps(),
    );
    expect(cvr).toMatchObject({
      subject: "did:demos:agent:alice",
      recipeId: "self-signed",
      requiredPassed: true,
    });
    expect(cvr.results).toEqual([
      { claimRef: "did:demos:agent:alice", method: "self-signed", status: "pass", authority: "did:demos:agent:alice" },
    ]);
  });

  test("consensus-backed-proxy passes on a 2xx from the authority", async () => {
    const cvr = await vetCore(
      {
        subject: "domain:alice.example",
        recipe: recipe({
          id: "domain-acme",
          method: "consensus-backed-proxy",
          params: { authorityUrl: "https://alice.example/.well-known/dacs" },
        }),
      },
      deps(200),
    );
    expect(cvr.requiredPassed).toBe(true);
    expect(cvr.results[0]).toMatchObject({
      method: "consensus-backed-proxy",
      status: "pass",
      authority: "https://alice.example/.well-known/dacs",
    });
  });

  test("consensus-backed-proxy fails on a non-2xx", async () => {
    const cvr = await vetCore(
      {
        subject: "domain:alice.example",
        recipe: recipe({ method: "consensus-backed-proxy", params: { authorityUrl: "https://x/y" } }),
      },
      deps(404),
    );
    expect(cvr.requiredPassed).toBe(false);
    expect(cvr.results[0]!.status).toBe("fail");
  });

  test("consensus-backed-proxy without an authorityUrl is rejected", async () => {
    await expect(
      vetCore(
        { subject: "s", recipe: recipe({ method: "consensus-backed-proxy", params: {} }) },
        deps(),
      ),
    ).rejects.toThrow(/authorityUrl/);
  });

  test("an unsupported method is rejected", async () => {
    await expect(
      vetCore({ subject: "s", recipe: recipe({ method: "telepathy" }) }, deps()),
    ).rejects.toThrow(/unsupported verification method/);
  });
});
