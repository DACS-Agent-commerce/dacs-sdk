// Offline child: a durable fixture-profile seller answers one proposal and kills itself (SIGKILL) at its first
// transport check after the Agreement signature was recorded, which is before the contribution is saved.
// Arguments: the seller's data directory, the job id, the file that logs each Agreement signature made.
import { appendFileSync } from 'node:fs';
import { seller as sellerKey, NOW } from './protocol-fixture.mjs';
import { fixtureListing } from '../fixtures/listings.mjs';
import { fixtureProposal } from './seller-agent-isolated-fixture.mjs';
import { localAnchor } from './local-anchor-fixture.mjs';
import { createSellerAgent } from '../../src/dacs/seller-agent.mjs';

const [directory, jobId, signatureLog] = process.argv.slice(2);
const listing = fixtureListing(sellerKey, { now: NOW });
const { body } = await fixtureProposal(listing, jobId);
const agreementBytes = Buffer.from(body.proposal.plan.signedBytes).toString();
let signed = false;
// The signer also authenticates the durable state; only the Agreement signature is logged.
const signer = { claim: sellerKey.claim, sign: (bytes) => {
  if (Buffer.from(bytes).toString() === agreementBytes) { signed = true; appendFileSync(signatureLog, 'signed\n'); }
  return sellerKey.signBytes(bytes);
} };
const agent = await createSellerAgent({ signer, listing, anchors: localAnchor({ now: () => NOW + 2000 }), durableDirectory: directory, now: () => NOW + 2000, simulatedFixture: true });
const transport = { path: '/dacs/v1/agreements/proposals', check: () => { if (signed) process.kill(process.pid, 'SIGKILL'); }, settle: () => {} };
await agent.receiveProposal(body, { transport });
