import assert from 'node:assert/strict';
import { gateWorld } from './effect-gate-world.mjs';
import { recordingApproval } from './payment-evidence-approval-double.mjs';

/** The journal key prefix of signer reservation records. */
export const RECORD_KEY_PREFIX = 'devnet/signer-reservation/';

/**
 * The seller gate world with the recording approval ledger as its `paymentEvidenceApproval` (the same double across restarts)
 * and `w.adapter`, the current composition's payment-evidence adapter. `stopped`, when given, replaces the fixture's stop check.
 */
export async function adapterWorld(t, { approval = recordingApproval(), stopped, ...options } = {}) {
  const w = await gateWorld(t, { ...options, sessionOptions: { paymentEvidenceApproval: approval, ...(stopped ? { stopped } : {}), ...options.sessionOptions } });
  Object.defineProperty(w, 'adapter', { get: () => w.session.paymentEvidenceAdapter });
  return Object.assign(w, { approval });
}

/** A payment-evidence input of the world's seller; `label` names its job and evidence address. */
export const evidenceInput = (w, label = 'a', extra = {}) => ({ logicalAddress: `dacs4:payment:TEST-job-${label}:demos-native:DEM:2`, artifact: { TEST: `evidence-${label}` },
  writer: `did:demos:agent:${w.session.wallet.getPublicAccount().address.slice(2)}`, artifactKind: 'SettlementEvidence', jobId: `TEST-job-${label}`, receiptContentHash: 'e1'.repeat(32), ...extra });
/** The signer reservation record in the world's journal, or null. */
export const recordOf = async w => (await w.journal().entries()).find(([key]) => key.startsWith(RECORD_KEY_PREFIX))?.[1] ?? null;
/** The ledger ids the double settled `released`, in order. */
export const releasedIds = w => w.approval.settlements.filter(call => call.outcome === 'released').map(call => call.ledgerId);
/** Asserts that the node saw no confirmation and no broadcast. */
export const assertNothingSent = w => { assert.equal(w.node.confirms.length, 0, 'no confirmation'); assert.equal(w.node.broadcasts.length, 0, 'no broadcast'); };
/** The seller's wallet address. */
export const signerOf = w => w.session.wallet.getPublicAccount().address;
