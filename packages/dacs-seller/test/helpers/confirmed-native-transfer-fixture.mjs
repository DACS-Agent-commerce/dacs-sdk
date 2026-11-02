// A confirmed native DEM transfer served by a fake node and read back through the real pay-DEM observer,
// so the observation has the shape the stack under test produces for a transaction that carries a signed nonce.
import { observePayDemTransferCore } from '@kynesyslabs/dacs';

export const FIXTURE_SIGNED_NONCE = 1;

export function confirmedNativeTransferNode({ txHash, payer, payee, amountOs, blockNumber, includedAt, nonce = FIXTURE_SIGNED_NONCE }) {
  const transaction = { hash: txHash, status: 'confirmed', blockNumber,
    content: { type: 'native', from: payer, to: payee, amount: amountOs, nonce,
      data: ['native', { nativeOperation: 'send', args: [payee, amountOs] }] } };
  const block = { number: blockNumber, status: 'confirmed', content: { timestamp: includedAt, ordered_transactions: [txHash] } };
  return {
    getTransactionStatus: async () => ({ result: 200, response: { state: 'included', blockNumber } }),
    getTxByHash: async () => ({ result: 200, response: transaction }),
    getBlockByNumber: async () => ({ result: 200, response: block }),
  };
}

export const observeConfirmedNativeTransfer = transfer => observePayDemTransferCore(transfer.txHash, confirmedNativeTransferNode(transfer));
