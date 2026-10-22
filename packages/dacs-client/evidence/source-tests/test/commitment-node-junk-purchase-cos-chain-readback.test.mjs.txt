// the source change, purchase level, commit-on-signature on, DACS_BUYER_CHAIN_READBACK=on:
// the same node junk as commitment-node-junk-purchase-cos.test.mjs, read by the
// buyer's chain reader, leaves the purchase agreement_pending.
// Review findings: PR the source change an earlier review, code P2-1 / a review P2-1.
import { nodeJunkPurchaseTests } from './helpers/commitment-node-junk-purchase.mjs';

// The live-composition harness reads the switch when each purchase starts.
process.env.DACS_BUYER_CHAIN_READBACK = 'on';
nodeJunkPurchaseTests(true, { chainReadback: true });
