/**
 * Binds a settlement to a job once no signing gate holds that settlement.
 *
 * A gate is a promise in `gates`, kept from a Deliverable's last signing check until its submission
 * returns. The wait loop ends on a synchronous `has` that finds no gate, and `bind` runs in that same
 * step: nothing is awaited between the check and the bind, so a gate cannot be registered in between.
 *
 * @param {Map<string, Promise<void>>} gates settlement id -> promise settled when that submission returns
 * @param {string} settlementId the settlement to bind
 * @param {() => boolean} bind binds the settlement; returns false when another job also claims it
 * @returns {Promise<boolean>} what `bind` returned
 * @throws whatever `bind` throws
 */
export async function bindWhenNoSigningGate(gates, settlementId, bind) {
  while (gates.has(settlementId)) await gates.get(settlementId);
  return bind();
}
