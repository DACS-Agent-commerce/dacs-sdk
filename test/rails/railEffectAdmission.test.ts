import { afterEach, describe, expect, test, vi } from "vitest";

// Admit the release only here, so the JID-3 check that runs after admission is
// reached. Every rail entry point shares this gate (CORE JID-3).
const admission = vi.hoisted(() => ({ admit: false }));
vi.mock("../../src/version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/version.js")>();
  return {
    ...actual,
    assertCurrentDacsProfileAdmission: () => {
      if (!admission.admit) throw new Error(actual.DACS_CURRENT_PROFILE_ADMISSION_ERROR);
    },
  };
});

import { assertDacsRailEffectAdmission } from "../../src/rails/currentProfileAdmission.js";
import { DACS_CURRENT_PROFILE_ADMISSION_ERROR } from "../../src/version.js";

const JOB = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
afterEach(() => { admission.admit = false; });

describe("assertDacsRailEffectAdmission", () => {
  test("reads no caller job data while the release is unadmitted", () => {
    const readJobId = vi.fn(() => JOB);
    expect(() => assertDacsRailEffectAdmission(readJobId)).toThrow(DACS_CURRENT_PROFILE_ADMISSION_ERROR);
    expect(readJobId).not.toHaveBeenCalled();
  });

  test.each(["legacy-job", JOB.toLowerCase(), `${JOB}\n`, undefined, 7])(
    "after admission, refuses non-JID-1 job id %j", (jobId) => {
      admission.admit = true;
      const readJobId = vi.fn(() => jobId);
      expect(() => assertDacsRailEffectAdmission(readJobId)).toThrow("jobId must be a JID-1 canonical ULID");
      expect(readJobId).toHaveBeenCalledOnce();
    });

  test("after admission, accepts a JID-1 job id and a gate without job data", () => {
    admission.admit = true;
    expect(() => assertDacsRailEffectAdmission(() => JOB)).not.toThrow();
    expect(() => assertDacsRailEffectAdmission()).not.toThrow();
  });
});
