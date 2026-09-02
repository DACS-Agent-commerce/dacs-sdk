import { describe, expect, it, vi } from "vitest";

import { buildAgent } from "../../src/agent/Agent.js";

describe("Agent.resolveIdentity ClaimReference normalization", () => {
  const key = "ab".repeat(32);
  const did = `did:demos:agent:${key}`;

  function agent() {
    const resolveIdentity = vi.fn(async () => ({ raw: {} }));
    return {
      resolveIdentity,
      agent: buildAgent({ resolveIdentity } as never, { demosRpc: "mem" }),
    };
  }

  it.each([
    [`0x${key}`, key],
    [key, key],
    [`DID:demos:agent:${key}`, key],
    [`DID:demos:agent:${key}?a=left%3Aright&unknown=value`, key],
  ])("uses %s as a lookup convenience without leaking it into protocol data", async (
    input,
    expectedAddress,
  ) => {
    const fixture = agent();
    await expect(fixture.agent.resolveIdentity(input)).resolves.toMatchObject({
      primaryClaim: did,
    });
    expect(fixture.resolveIdentity).toHaveBeenCalledWith(expectedAddress);
  });

  it("preserves only a canonical parameter-free identity for other methods", async () => {
    const fixture = agent();
    await expect(fixture.agent.resolveIdentity(
      "did:example:alice?jurisdiction=GB",
    )).resolves.toMatchObject({ primaryClaim: "did:example:alice" });
    expect(fixture.resolveIdentity).toHaveBeenCalledWith(
      "did:example:alice?jurisdiction=GB",
    );

    const substrateNotation = `demos:0x${key}`;
    const separate = agent();
    await expect(separate.agent.resolveIdentity(substrateNotation))
      .resolves.toMatchObject({ primaryClaim: substrateNotation });
    expect(separate.resolveIdentity).toHaveBeenCalledWith(substrateNotation);
  });

  it.each([
    ` demos:0x${key}`,
    `demos:0x${key} `,
    "not-a-claim-reference",
  ])("rejects a non-ClaimReference alias instead of retaining it: %s", async (input) => {
    const fixture = agent();
    await expect(fixture.agent.resolveIdentity(input)).rejects.toThrow(/CF-2/);
    expect(fixture.resolveIdentity).not.toHaveBeenCalled();
  });
});
