import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMPLETED_SESSION_MODULE_VERSIONS,
  DACS_STANDARD_PIN,
  DACS_STANDARD_PROFILE_STATUS,
  DacsError,
  authenticateSessionProfile,
  requireAuthenticatedSessionProfile,
} from "../../src/index.js";

// Explicitly non-live harness: a test may stand in a released profile record.
// Without it the real record at the pin applies.
const release = vi.hoisted(() => ({ status: undefined as "released" | undefined }));
vi.mock("../../src/discovery/standardProfileRelease.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/discovery/standardProfileRelease.js")>();
  return { get DACS_STANDARD_PROFILE_STATUS() { return release.status ?? actual.DACS_STANDARD_PROFILE_STATUS; } };
});
afterEach(() => { release.status = undefined; });

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = "did:web:buyer.example";
const SELLER = "did:web:seller.example";
const EXPECTED = { jobId: JOB_ID, buyer: BUYER, seller: SELLER };

function admission(): Record<string, unknown> {
  return {
    status: "valid", releasePin: DACS_STANDARD_PIN, profileStatus: DACS_STANDARD_PROFILE_STATUS,
    moduleVersions: { ...COMPLETED_SESSION_MODULE_VERSIONS },
    roles: [{ jobId: JOB_ID, role: "buyer", participant: BUYER },
      { jobId: JOB_ID, role: "seller", participant: SELLER }],
  };
}

describe("session profile admission release status", () => {
  it("refuses every admission while the pinned profile is an unreleased candidate", async () => {
    expect(DACS_STANDARD_PROFILE_STATUS).toBe("unreleased-candidate");
    const unreleased = /unreleased candidate and is not an admissible live session profile/;
    const { profileStatus: _status, ...pinOnly } = admission();
    // A complete authority reply that states the candidate status opens nothing,
    // nor does the pin alone or a reply claiming the release.
    for (const source of [admission(), pinOnly, { ...admission(), profileStatus: "released" }]) {
      expect(() => requireAuthenticatedSessionProfile(source, EXPECTED)).toThrow(unreleased);
      expect(() => requireAuthenticatedSessionProfile(source, EXPECTED)).toThrow(DacsError);
    }
    // The authority is not even asked.
    const authority = vi.fn(() => admission());
    await expect(authenticateSessionProfile(authority, EXPECTED)).rejects.toThrow(unreleased);
    expect(authority).not.toHaveBeenCalled();
  });

  it("admits a released profile only from an authority that states the released status", async () => {
    release.status = "released";
    const { profileStatus: _status, ...pinOnly } = admission();
    expect(() => requireAuthenticatedSessionProfile(pinOnly, EXPECTED))
      .toThrow(/does not state the pinned Standard profile status "released"/);
    for (const profileStatus of ["unreleased-candidate", "", null]) {
      expect(() => requireAuthenticatedSessionProfile({ ...admission(), profileStatus }, EXPECTED))
        .toThrow(/profile status/);
    }
    expect(() => requireAuthenticatedSessionProfile({ ...admission(), status: "invalid" }, EXPECTED))
      .toThrow(/lacks authenticated role authority/);
    expect(requireAuthenticatedSessionProfile(admission(), EXPECTED)).toEqual({ buyer: BUYER, seller: SELLER });
    await expect(authenticateSessionProfile(() => admission(), EXPECTED)).resolves.toEqual({ buyer: BUYER, seller: SELLER });
  });

  it("refuses a malformed admission shape", () => {
    release.status = "released";
    const lacks = /lacks authenticated role authority/;
    expect(() => requireAuthenticatedSessionProfile(null, EXPECTED)).toThrow(DacsError);
    expect(() => requireAuthenticatedSessionProfile({ ...admission(), extra: true }, EXPECTED)).toThrow(lacks);
    const roles = admission().roles as Record<string, unknown>[];
    expect(() => requireAuthenticatedSessionProfile({ ...admission(), roles: [roles[0], { ...roles[1], extra: true }] },
      EXPECTED)).toThrow(lacks);
    // The requested role must be among the admitted roles.
    expect(() => requireAuthenticatedSessionProfile({ ...admission(), roles: [roles[0]] }, { jobId: JOB_ID }, "seller"))
      .toThrow(lacks);
    expect(requireAuthenticatedSessionProfile({ ...admission(), roles: [roles[0]] }, { jobId: JOB_ID }, "buyer"))
      .toEqual({ buyer: BUYER });
    const orchestrator = { jobId: JOB_ID, role: "orchestrator", participant: "did:web:orchestrator.example" };
    expect(() => requireAuthenticatedSessionProfile({ ...admission(), roles: [orchestrator] }, { jobId: JOB_ID }, "buyer"))
      .toThrow(lacks);
    expect(requireAuthenticatedSessionProfile({ ...admission(), roles: [orchestrator] }, { jobId: JOB_ID }, "orchestrator"))
      .toEqual({ orchestrator: "did:web:orchestrator.example" });
  });
});

const VENDOR = join(dirname(fileURLToPath(import.meta.url)), "../../vendor/DACS-Standard");
const PROFILE = join(VENDOR, "spec/PROFILE.md");

// CORE §11.1.2 mirrored table: the copied tuple and its release status must
// match PROFILE.md at the pin `npm run conformance:sync` checks out.
// The suite body runs at collection even when skipped, so read inside the tests.
describe.skipIf(!existsSync(PROFILE))("COMPLETED_SESSION_MODULE_VERSIONS against PROFILE.md", () => {
  const heading = "## Unreleased JID-1 corrective candidate";

  it("states the release status PROFILE.md gives the tuple", () => {
    const text = readFileSync(PROFILE, "utf8");
    expect(text.includes(heading)).toBe(DACS_STANDARD_PROFILE_STATUS === "unreleased-candidate");
  });

  it("copies the tuple PROFILE.md lists", () => {
    const text = readFileSync(PROFILE, "utf8");
    const start = text.indexOf(heading);
    expect(start).toBeGreaterThanOrEqual(0);
    const section = text.slice(start + heading.length).split(/\n## /)[0]!;
    const keys: Record<string, keyof typeof COMPLETED_SESSION_MODULE_VERSIONS> = {
      CORE: "core", "DACS-1-IDENTIFY": "dacs1", "DACS-2-VET": "dacs2",
      "DACS-3-NEGOTIATE": "dacs3", "DACS-4-SETTLE": "dacs4", "DACS-5-VERIFY": "dacs5",
    };
    const tuple: Record<string, string> = {};
    for (const match of section.matchAll(/^\| \[([A-Z0-9-]+)\]\([^)]+\) \| ([0-9.]+) \|/gm)) {
      const key = keys[match[1]!];
      expect(key, match[1]).toBeDefined();
      tuple[key!] = match[2]!;
    }
    expect(tuple).toEqual({ ...COMPLETED_SESSION_MODULE_VERSIONS });
  });
});
