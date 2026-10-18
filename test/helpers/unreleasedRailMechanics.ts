import { vi } from "vitest";

// These offline suites exercise mechanics below release admission. Production
// admission and zero-effect refusal are covered without this mock in
// rails/currentProfileEffects.test.ts. This stub is never shipped by the SDK.
vi.mock("../../src/rails/currentProfileAdmission.js", () => ({
  assertDacsRailEffectAdmission: vi.fn(),
}));
