import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  COMPLETED_SESSION_MODULE_VERSIONS,
  DACS_STANDARD_PIN,
  DACS_STANDARD_PROFILE_STATUS,
  requireAuthenticatedSessionProfile,
} from "../../src/index.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = "did:web:buyer.example";
const SELLER = "did:web:seller.example";

function admission(): Record<string, unknown> {
  return {
    status: "valid", releasePin: DACS_STANDARD_PIN, profileStatus: DACS_STANDARD_PROFILE_STATUS,
    moduleVersions: { ...COMPLETED_SESSION_MODULE_VERSIONS },
    roles: [{ jobId: JOB_ID, role: "buyer", participant: BUYER },
      { jobId: JOB_ID, role: "seller", participant: SELLER }],
  };
}

describe("session profile admission release status", () => {
  it("never admits the candidate pin and tuple alone", () => {
    const { profileStatus: _status, ...pinOnly } = admission();
    expect(() => requireAuthenticatedSessionProfile(pinOnly, { jobId: JOB_ID, buyer: BUYER, seller: SELLER }))
      .toThrow(/does not acknowledge the pinned Standard profile status "unreleased-candidate"/);
    for (const profileStatus of ["released", "", null]) {
      expect(() => requireAuthenticatedSessionProfile({ ...admission(), profileStatus },
        { jobId: JOB_ID, buyer: BUYER, seller: SELLER })).toThrow(/profile status/);
    }
    expect(() => requireAuthenticatedSessionProfile({ ...admission(), status: "invalid" },
      { jobId: JOB_ID, buyer: BUYER, seller: SELLER })).toThrow(/lacks authenticated role authority/);
  });

  it("admits only an authority that states the pinned status", () => {
    expect(requireAuthenticatedSessionProfile(admission(), { jobId: JOB_ID, buyer: BUYER, seller: SELLER }))
      .toEqual({ buyer: BUYER, seller: SELLER });
  });
});

const VENDOR = join(dirname(fileURLToPath(import.meta.url)), "../../vendor/DACS-Standard");
const PROFILE = join(VENDOR, "spec/PROFILE.md");

// CORE §11.1.2 mirrored table: the copied tuple and its release status must
// match PROFILE.md at the pin `npm run conformance:sync` checks out.
describe.skipIf(!existsSync(PROFILE))("COMPLETED_SESSION_MODULE_VERSIONS against PROFILE.md", () => {
  const text = readFileSync(PROFILE, "utf8");
  const heading = "## Unreleased JID-1 corrective candidate";

  it("states the release status PROFILE.md gives the tuple", () => {
    expect(text.includes(heading)).toBe(DACS_STANDARD_PROFILE_STATUS === "unreleased-candidate");
  });

  it("copies the tuple PROFILE.md lists", () => {
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
