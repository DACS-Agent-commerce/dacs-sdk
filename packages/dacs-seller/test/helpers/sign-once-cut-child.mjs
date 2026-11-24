// Offline child: a durable fixture-profile seller answers one proposal and kills itself (SIGKILL) inside its
// Agreement signature. `before-signature` dies after signOnce kept its intent and before the cryptographic call;
// `after-signature` dies after the cryptographic call returned and before signOnce wrote its completion.
// Arguments: the seller's data directory, the job id, the cut, the file that logs how far the child got.
import { appendFileSync } from 'node:fs';
import { seller as sellerKey, NOW } from './protocol-fixture.mjs';
import { fixtureListing } from '../fixtures/listings.mjs';
import { fixtureProposal } from './seller-agent-isolated-fixture.mjs';
import { localAnchor } from './local-anchor-fixture.mjs';
import { createSellerAgent } from '../../src/dacs/seller-agent.mjs';
import { agentSigning } from './agent-signing.mjs';

const [directory, jobId, cut, progressLog] = process.argv.slice(2);
const listing = fixtureListing(sellerKey, { now: NOW });
const { body } = await fixtureProposal(listing, jobId);
const agreementBytes = Buffer.from(body.proposal.plan.signedBytes).toString();
const signer = { claim: sellerKey.claim, sign: (bytes) => {
  if (Buffer.from(bytes).toString() !== agreementBytes) return sellerKey.signBytes(bytes);
  appendFileSync(progressLog, 'signing\n');
  if (cut === 'before-signature') process.kill(process.pid, 'SIGKILL');
  const signature = sellerKey.signBytes(bytes);
  appendFileSync(progressLog, 'signed\n');
  process.kill(process.pid, 'SIGKILL');
  return signature;
} };
const agent = await createSellerAgent({ ...agentSigning(signer, { historyDirectory: `${directory}-effects` }), listing, anchors: localAnchor({ now: () => NOW + 2000 }),
  durableDirectory: directory, now: () => NOW + 2000, simulatedFixture: true });
await agent.receiveProposal(body);
