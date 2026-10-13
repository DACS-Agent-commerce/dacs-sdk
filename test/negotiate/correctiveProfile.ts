import type { RfqProfileAdmission } from "../../src/index.js";

/**
 * The exact CORE §11.1.2 corrective profile the tests run under: the release
 * pin and complete module tuple of the canonical-channel-message-v0.6 fixture.
 */
export const CORRECTIVE_PROFILE = {
  releasePin: "0d92f6642bdbd96655c8bb9a150b984d6be8bb67",
  moduleVersions: {
    core: "0.3",
    dacs1: "0.8",
    dacs2: "0.6",
    dacs3: "0.6",
    dacs4: "0.8",
    dacs5: "0.7",
  },
};

/** Verifier-owned profile admission whose authority binds one RFQ session. */
export function rfqProfileAdmission(
  channelId: string,
  members: readonly string[],
): RfqProfileAdmission {
  return {
    profile: CORRECTIVE_PROFILE,
    authority: {
      authenticated: true,
      sessionId: channelId,
      participantIdentities: [...members],
      ...CORRECTIVE_PROFILE,
    },
  };
}
