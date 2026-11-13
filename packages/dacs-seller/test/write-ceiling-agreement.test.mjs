// With the operator approval policy set to the wallet journal's limit, both compare the whole debit of one write
// with it, so a write is kept and sent by the journal exactly when the policy does not refuse it for its cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeliverableWalletJournal } from '../src/index.mjs';
import { WRITE_FEE_CEILING_OS } from '../src/dacs/effect-boundary.mjs';
import { policyRefusal } from '../src/devnet-demo/operator-approval.mjs';
import { address, seller, buyer, pin, agreementHash, sourceBinding, artifactAuthority, JOBS, PAYMENT_TX_REF, deliveredHashFor, requestFor } from './helpers/d5-policy-fixtures.mjs';
import { deliverableInput, walletChain } from './helpers/payment-evidence-wallet-chain.mjs';

const paid = () => ({ jobId: JOBS[0], seller, buyer, listingPin: pin, sourceBinding, agreementHash, amountOs: '1000000000', paymentObserved: true, paymentTxRef: { ...PAYMENT_TX_REF }, prePaymentOpen: null });
const policy = { address, seller, sourceBinding, artifactAuthority, listingPin: () => pin, resolvePurchase: paid, paymentPhaseIndex: () => 2, deliveryPhaseIndex: () => 3, deliveredPayloadHash: deliveredHashFor };
const oneOsMore = (content) => { content.transaction_fee.rpc_fee = String(BigInt(content.transaction_fee.rpc_fee) + 1n); };

// The approval request and the journal's signed CREATE describe one write: 1 DEM storage fee, 1 DEM gas, 1 DEM network fee and the rpc fee.
for (const [label, rpcDem, change] of [
  ['a whole debit of exactly 50 DEM before the denomination fork', '47', { nodeFee: { networkFee: 1, rpcFee: 47 } }],
  ['a whole debit of exactly 50 DEM after the denomination fork', '47', { postFork: true, nodeFee: { networkFee: 1, rpcFee: 47 } }],
  ['a whole debit one DEM above 50 DEM before the denomination fork', '48', { nodeFee: { networkFee: 1, rpcFee: 48 } }],
  ['a whole debit one OS above 50 DEM after the denomination fork', '47.000000001', { postFork: true, nodeFee: { networkFee: 1, rpcFee: 47 }, edit: oneOsMore }],
]) test(`the journal and the approval policy agree on ${label}`, async (t) => {
  const request = requestFor({ rpcFeeDem: rpcDem }), debit = BigInt(request.content.debit.totalOs);
  const refusedByPolicy = await policyRefusal(request, policy, { maxWriteTotalOs: String(WRITE_FEE_CEILING_OS) }) === 'write-fee-cap';
  assert.equal(refusedByPolicy, debit > WRITE_FEE_CEILING_OS);

  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ceiling-agreement-'))), node = walletChain(), broadcast = [];
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const journal = createDeliverableWalletJournal({ path: join(dir, 'journal.sqlite'), readTimeoutMs: 200,
    signCreate: (asked) => node.signCreate(asked, change),
    broadcast: async ({ signedTransaction, txHash }) => { broadcast.push(signedTransaction); node.land(txHash); },
    readAccountNonce: async () => ({ nonce: node.accountNonce(), blockHeight: node.accountNonce() }),
    readTransactionState: async ({ txHash }) => ({ state: node.transactionState(txHash), checkedThroughBlock: node.accountNonce() }) });
  t.after(() => journal.close());
  const submitted = journal.submitAuthorized({ ...deliverableInput(node.claim), expectedJournalId: journal.journalId }, () => true);
  if (refusedByPolicy) await assert.rejects(submitted, { code: 'wallet_sign_invalid' });
  else await submitted;
  assert.equal(broadcast.length, refusedByPolicy ? 0 : 1);
});
