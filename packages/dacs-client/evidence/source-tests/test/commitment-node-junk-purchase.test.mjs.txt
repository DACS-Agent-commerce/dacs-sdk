// the source change, purchase level, commit-on-signature off: node answers that parse but do
// not authenticate, at the buyer's first commitment read, the SDK's receipt
// re-read and the Agreement receipt check, leave the purchase agreement_pending
// and readback alone completes it; a seller-signed contradiction (another
// Agreement, Listing pin or parties) still ends it.
// Review findings: PR the source change an earlier review, code P2-1 / a review P2; an earlier review, a review P2-2.
import { nodeJunkPurchaseTests } from './helpers/commitment-node-junk-purchase.mjs';

nodeJunkPurchaseTests(false);
