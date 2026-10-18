import { assertCurrentDacsProfileAdmission } from "@kynesyslabs/dacs";
import { DacsLiveEffectInputControlError } from "./liveEffects.js";

/** SDK-owned release admission for fresh effects; reconciliation stays readable. */
export function requireDacsCurrentProfileForNewEffectsV1(): void {
  try {
    assertCurrentDacsProfileAdmission();
  } catch {
    throw new DacsLiveEffectInputControlError(
      "operator-action", "current-dacs-profile-unavailable",
    );
  }
}
