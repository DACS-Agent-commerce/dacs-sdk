// The seller's default fee limits: 50 DEM per write, 1,200 DEM per hour, 24 writes per hour. A context start holds two writes at the
// per-write limit, so each start holds 100 DEM and twelve starts fill the hour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { address, seller, buyer, pin, agreementHash, sourceBinding, artifactAuthority, T0, JOBS, PAYMENT_TX_REF, deliveredHashFor, requestFor, confirmationFor } from './helpers/d5-policy-fixtures.mjs';

const { composeSellerApproval, createExactOperatorApproval, createSellerContextAdmission, heldPolicyBudget, parsePolicyLedger, policyRefusal, sellerApprovalSettings, SELLER_POLICY_DEFAULTS, withContextHolds } = await import('../src/devnet-demo/operator-approval.mjs');

const DEM = 1_000_000_000n;
const ULID_DIGITS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const jobNumber = (index) => `01ARZ3NDEKTSV4RRFFQ69G5F${ULID_DIGITS[Math.floor(index / 32)]}${ULID_DIGITS[index % 32]}`;
const EFFECT = 'a'.repeat(64);

async function ledgerPath(t) {
  const root = await mkdtemp(join(tmpdir(), 'fee-defaults-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'approvals.jsonl');
}
const startOf = (admission, index) => admission.reserve({ jobId: jobNumber(index), effect: EFFECT, writes: 2, hold: `start-${index}` });
const heldAfterRestart = async (evidencePath) => heldPolicyBudget(withContextHolds(parsePolicyLedger(await readFile(evidencePath, 'utf8')).rows), T0);
const paidJob = () => ({ jobId: JOBS[0], seller, buyer, listingPin: pin, sourceBinding, agreementHash, amountOs: '1000000000', paymentObserved: true,
  paymentTxRef: { ...PAYMENT_TX_REF }, prePaymentOpen: null });
const policyInputs = (resolvePurchase) => ({ address, seller, sourceBinding, artifactAuthority, listingPin: () => pin, resolvePurchase, paymentPhaseIndex: () => 2,
  deliveryPhaseIndex: () => 3, deliveredPayloadHash: deliveredHashFor });

test('the per-write default is 50 DEM and the hourly default 1,200 DEM; a 50 DEM write passes and 50 DEM plus 1 OS refuses write-fee-cap', async () => {
  assert.deepEqual({ ...SELLER_POLICY_DEFAULTS }, { maxWriteTotalOs: '50000000000', maxWritesPerHour: 24, maxTotalOsPerHour: '1200000000000' });
  const { mode, ...limits } = sellerApprovalSettings({ mode: 'policy' });
  assert.equal(mode, 'policy');
  assert.deepEqual(limits, { ...SELLER_POLICY_DEFAULTS }, 'a policy that names no limit takes the defaults');
  const refusal = (rpcFeeDem) => policyRefusal(requestFor({ rpcFeeDem }), policyInputs(paidJob), SELLER_POLICY_DEFAULTS);
  assert.equal(await refusal('47'), null, 'a write whose whole debit is 50 DEM passes');
  assert.equal(await refusal('47.000000001'), 'write-fee-cap', 'one OS more is refused');
});

test('the 1,200 DEM hourly default admits a 100 DEM two-Vet hold that 96 DEM would refuse; the 13th hold in an hour refuses', async (t) => {
  const narrow = createSellerContextAdmission({ evidencePath: await ledgerPath(t), sellerApproval: { mode: 'policy', maxTotalOsPerHour: '96000000000' }, now: () => T0 });
  assert.equal(await startOf(narrow, 0), 'hourly-dem-limit', 'a 96 DEM hour cannot hold 100 DEM');
  const evidencePath = await ledgerPath(t);
  const admission = createSellerContextAdmission({ evidencePath, sellerApproval: { mode: 'policy' }, now: () => T0 });
  assert.equal(await startOf(admission, 0), null, 'the default hour holds 100 DEM');
  assert.equal((await heldAfterRestart(evidencePath)).totalOs, 100n * DEM);
  for (let index = 1; index < 12; index++) assert.equal(await startOf(admission, index), null, `start ${index + 1} fits`);
  assert.deepEqual(await heldAfterRestart(evidencePath), { writes: 24, totalOs: 1200n * DEM }, 'twelve starts fill the hour');
  assert.match(await startOf(admission, 12), /^hourly-/, 'the 13th start in the hour refuses');
});

test('ADMISSION.md states the 50 DEM and 1,200 DEM defaults', async () => {
  const text = await readFile(new URL('../ADMISSION.md', import.meta.url), 'utf8');
  const dem = (os) => (BigInt(os) / DEM).toLocaleString('en-US');
  assert.ok(text.includes(`${dem(SELLER_POLICY_DEFAULTS.maxTotalOsPerHour)} DEM`), 'the hourly default');
  assert.ok(text.includes(`${dem(SELLER_POLICY_DEFAULTS.maxWriteTotalOs)} DEM`), 'the per-write default');
  assert.ok(!text.includes('96 DEM'), 'the earlier hourly figure is gone');
});

test('a restart between the two-Vet hold and either write keeps the outstanding debit charged under the new defaults; an unknown write frees no budget and admits no second hold', async (t) => {
  const evidencePath = await ledgerPath(t);
  assert.equal(await startOf(createSellerContextAdmission({ evidencePath, sellerApproval: { mode: 'policy' }, now: () => T0 }), 0), null);
  assert.deepEqual(await heldAfterRestart(evidencePath), { writes: 2, totalOs: 100n * DEM }, 'the restart still charges both writes at the new per-write limit');
  const vetRequest = requestFor({ artifactKind: 'CompositeVerificationRecord', job: jobNumber(0) });
  const reopened = createExactOperatorApproval({ maxTotalOs: '10000000000', evidencePath, now: () => T0, sellerApproval: { mode: 'policy' },
    policy: policyInputs(() => ({ ...paidJob(), jobId: jobNumber(0), paymentObserved: false, paymentTxRef: null, prePaymentOpen: true })) });
  const approval = composeSellerApproval({ mode: 'policy', policy: reopened, manual: async () => true });
  assert.equal(await approval(vetRequest), true);
  assert.equal(await approval.confirm(confirmationFor(vetRequest)), true);
  await approval.settle(vetRequest, 'unknown');
  assert.equal((await heldAfterRestart(evidencePath)).writes, 2, 'after a restart the unknown write and the unused slot are both still counted');
  const admission = createSellerContextAdmission({ evidencePath, sellerApproval: { mode: 'policy' }, now: () => T0 });
  let admitted = 0;
  while (await startOf(admission, admitted + 1) === null) admitted++;
  assert.equal(admitted, 11, 'eleven more starts fit beside the first; an unknown write freed nothing');
});
