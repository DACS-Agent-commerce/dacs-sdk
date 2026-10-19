import { authenticateAp2ProfileAdmission, type Ap2ParticipantProfile } from "../../src/rails/ap2Admission.js";
export const AP2_TEST_JOB = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const AP2_TEST_PEER = "did:demos:test-peer";
// Synthetic authenticated handshake; this is not deployment compatibility evidence.
export const AP2_TEST_PROFILE = {
  releasePin: "1".repeat(40),
  moduleVersions: { core: "0.3", dacs1: "0.7", dacs2: "0.6", dacs3: "0.5", dacs4: "0.8", dacs5: "0.5" },
};
export const AP2_TEST_RECORD = { ...AP2_TEST_PROFILE, jobId: AP2_TEST_JOB, identity: AP2_TEST_PEER, authenticated: true };
export async function ap2ProfileScope(jobId = AP2_TEST_JOB, records?: readonly Ap2ParticipantProfile[]) {
  return {
    jobId, phaseIndex: 3, peerIdentity: AP2_TEST_PEER,
    profileAdmission: await authenticateAp2ProfileAdmission({
      jobId, peerIdentity: AP2_TEST_PEER, expectedProfile: AP2_TEST_PROFILE,
      authenticateParticipants: async () => records ?? [{ ...AP2_TEST_RECORD, jobId }],
    }),
  };
}
