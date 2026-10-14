// Seller records (sellerApproval.purchaseSource "seller"): what the bound
// issuance journals show for one unresolved policy reservation. Restart never
// releases a reservation on this answer (operator-approval.mjs: its
// sign-authorized line precedes signing); it only labels what stays held.
// The source journal's 'seller-policy/' keys are reserved: no build writes
// them, and ops health refuses any record there (src/ops/health.mjs).
export const SELLER_POLICY_JOURNAL_PREFIX='seller-policy/';

// 'issued' when a journal retains this reservation's exact signed bytes,
// otherwise 'unknown'. Neither answer is release proof.
export async function sellerJournalIssuance({journals},request){
  const c=request?.content,listed=await Promise.all(journals.map(journal=>journal.entries()));
  const signed=listed.flat().map(([,value])=>value?.signedTransaction?.content).filter(content=>content?.from===c?.wallet);
  return signed.some(s=>s.nonce===c.nonce&&s.timestamp===c.timestamp&&JSON.stringify(s.data?.[1])===c.exactCreate)?'issued':'unknown';
}
