import { afterEach, expect, it, vi } from "vitest";

// Explicitly non-live harness: these cases run against a released profile
// record; a case that sets `release.real` gets the real record at the pin.
const release = vi.hoisted(() => ({ real: false }));
vi.mock("../../../src/discovery/standardProfileRelease.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/discovery/standardProfileRelease.js")>();
  return { get DACS_STANDARD_PROFILE_STATUS() { return release.real ? actual.DACS_STANDARD_PROFILE_STATUS : "released"; } };
});
afterEach(() => { release.real = false; });
import { DacsError, IndeterminateSubstrateError, SubstrateError, TransientError } from "@kynesyslabs/dacs";
import { admitDacsNativeLiveGraph, admitDacsX402LiveGraph } from "../src/sessionProfileAdmission.js";
import { trustedSessionProfile } from "./helpers/sessionProfile.js";

const JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = "did:demos:agent:" + "1".repeat(64);
const SELLER = "did:demos:agent:" + "2".repeat(64);

for (const rail of ["native", "x402"] as const) {
  for (const role of ["buyer", "seller"] as const) {
    it(`${rail} ${role}: keeps admission outages retryable at every payload validator`, async () => {
      const validate = vi.fn(async (_input: { jobId: string }) => ({ status: "valid" }));
      const authenticate = vi.fn((): unknown => trustedSessionProfile(JOB, BUYER, SELLER));
      const context = { role, authority: role === "buyer" ? BUYER : SELLER,
        peerAuthority: role === "buyer" ? SELLER : BUYER, authenticateSessionProfile: authenticate };
      const source = { role, router: {}, validatePayload: validate,
        terminalBundles: { validatePayload: validate, transport: {} },
        ...(rail === "native" ? { payDemOperations: {} } : { operations: {} }) };
      const graph = rail === "native" ? admitDacsNativeLiveGraph(source as never, context as never)
        : admitDacsX402LiveGraph(source as never, context as never);
      const validators = [(graph as typeof source).validatePayload,
        (graph as unknown as { router: { validatePayload: typeof validate } }).router.validatePayload,
        (graph as typeof source).terminalBundles.validatePayload];
      for (const failure of [new Error("authority read timed out"), new TransientError("try again"),
        new SubstrateError("authority node unavailable"), new IndeterminateSubstrateError("not yet observed")]) {
        authenticate.mockImplementation(() => { throw failure; });
        for (const validator of validators) {
          await expect(validator({ jobId: JOB } as never)).resolves.toEqual({
            status: "unavailable", reasonCode: "session-profile-admission-unavailable",
          });
        }
        expect(validate).not.toHaveBeenCalled();
      }
      // The real record at the pin refuses before the authority is asked; that
      // refusal is permanent, never an outage.
      release.real = true;
      authenticate.mockClear();
      authenticate.mockImplementation(() => trustedSessionProfile(JOB, BUYER, SELLER));
      for (const validator of validators) {
        await expect(validator({ jobId: JOB } as never)).rejects.toThrow(/unreleased candidate/);
      }
      expect(authenticate).not.toHaveBeenCalled();
      expect(validate).not.toHaveBeenCalled();
      release.real = false;
      // Permanent policy refusals still reject, rather than authenticating a
      // message or disguising a known refusal as a transient observation.
      const refused = new DacsError("session revoked");
      authenticate.mockImplementation(() => { throw refused; });
      for (const validator of validators) await expect(validator({ jobId: JOB } as never)).rejects.toBe(refused);
      expect(validate).not.toHaveBeenCalled();
      authenticate.mockImplementation(() => trustedSessionProfile(JOB, BUYER, SELLER));
      for (const validator of validators) await expect(validator({ jobId: JOB } as never)).resolves.toEqual({ status: "valid" });
      expect(validate).toHaveBeenCalledTimes(validators.length);
      expect(authenticate).toHaveBeenLastCalledWith(JOB);
    });
  }
}
