import { vi } from "vitest";
export const { TP1_REFUSED_CHAIN_IDENTITIES } = await vi.importActual<typeof import("../../src/wire/approval.js")>("../../src/wire/approval.js");
// Test-only approval of SYNTHETIC identity records. The SDK's list
// (src/wire/approval.ts) pins the approval from 2026-10-20 and no shipped module takes another.
// A test file that needs a synthetic binding replaces that module with this
// one, before the wire is loaded:
//
//   vi.mock("../../src/wire/approval.js", () => import("./testApproval.js"));
//
// Nothing is approved except inside withTestApproval, so everywhere else
// this test stand-in refuses every record. A binding, once made,
// stays valid after the scope ends. The list is a live binding: inside the
// scope it is a frozen array of the given digests, outside it the frozen empty
// list TESTNET_PROFILE_TP1 captured at load.
const EMPTY: readonly string[] = Object.freeze([]);

export let TP1_APPROVED_IDENTITY_RECORD_DIGESTS: readonly string[] = EMPTY;

export function withTestApproval<T>(digests: readonly string[], bind: () => T): T {
  TP1_APPROVED_IDENTITY_RECORD_DIGESTS = Object.freeze([...digests]);
  try {
    return bind();
  } finally {
    TP1_APPROVED_IDENTITY_RECORD_DIGESTS = EMPTY;
  }
}
