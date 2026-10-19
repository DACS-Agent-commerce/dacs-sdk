import { DACS_STANDARD_PIN, DACS_STANDARD_PROFILE_STATUS, COMPLETED_SESSION_MODULE_VERSIONS } from "@kynesyslabs/dacs";

/** Independent deployment fixture; never inferred from artifacts under test. */
export function trustedSessionProfile(jobId: string, buyer: string, seller: string) {
  return { status: "valid", releasePin: DACS_STANDARD_PIN, profileStatus: DACS_STANDARD_PROFILE_STATUS,
    moduleVersions: { ...COMPLETED_SESSION_MODULE_VERSIONS },
    roles: [{ jobId, role: "buyer", participant: buyer }, { jobId, role: "seller", participant: seller }],
  };
}
