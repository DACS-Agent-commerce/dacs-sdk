/** PROFILE.md release status of a CORE §11.1.2 module tuple. */
export type DacsStandardProfileStatus = "unreleased-candidate" | "released";

/**
 * PROFILE.md release status of the module tuple at `DACS_STANDARD_PIN`. At that
 * pin the tuple is the unreleased JID-1 corrective candidate, which the Standard
 * says is not an admissible live profile and a deployment must refuse. While
 * this is not `"released"`, every session profile admission is refused,
 * whatever the deployment authority returns. Set it to `"released"` together
 * with the pin when the Standard records the release.
 */
export const DACS_STANDARD_PROFILE_STATUS: DacsStandardProfileStatus = "unreleased-candidate";
