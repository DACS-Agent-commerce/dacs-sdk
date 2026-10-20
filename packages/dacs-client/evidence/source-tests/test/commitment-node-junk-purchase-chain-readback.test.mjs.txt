// the source change, purchase level, commit-on-signature off, DACS_BUYER_CHAIN_READBACK=on:
// the same node junk as commitment-node-junk-purchase.test.mjs, read by the
// buyer's chain reader, leaves the purchase agreement_pending (never
// agreement_rejected) and readback alone completes it.
// Review findings: PR the source change an earlier review, code P2-1 / a review P2-1 and code P3-2.
import { nodeJunkPurchaseTests } from './helpers/commitment-node-junk-purchase.mjs';

// The live-composition harness reads the switch when each purchase starts.
process.env.DACS_BUYER_CHAIN_READBACK = 'on';
nodeJunkPurchaseTests(false, { chainReadback: true });
