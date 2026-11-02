import { checkWireRequest, type OpenedEnvelope, type RequestCheck, type WireEffect, type WireRequestPayload } from "../../src/wire/index.js";

/**
 * checkWireRequest, then the reservation it returns, as a seller host does once its own accounting allows: the admitted body, `readbackOnly`, and
 * the journal's answer as `effect` (null on a read route). A refusal at either step rejects with its own error.
 */
export async function checkAndReserve(opened: OpenedEnvelope<WireRequestPayload>, check: RequestCheck): Promise<{ body: Record<string, unknown>; readbackOnly: boolean; effect: WireEffect | null }> {
  const { reserve, ...admitted } = await checkWireRequest(opened, check);
  return { ...admitted, effect: reserve === null ? null : await reserve() };
}
