// the source change, purchase level, commit-on-signature on: the same node junk as
// commitment-node-junk-purchase.test.mjs leaves the purchase agreement_pending.
// Review findings: PR the source change an earlier review, code P2-1 / a review P2.
import { nodeJunkPurchaseTests } from './helpers/commitment-node-junk-purchase.mjs';

nodeJunkPurchaseTests(true);
