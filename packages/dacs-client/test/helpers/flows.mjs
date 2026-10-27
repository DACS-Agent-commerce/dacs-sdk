// Shared helpers for workflow tests. The "wallet" here is SIMULATED: an
// ephemeral key that signs locally and "broadcasts" into the fixture chain.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { linkAccount } from './oauth.mjs';
import { advancePastFinalizedCommitment } from './finalized-payment.mjs';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';
import { fixtureListing, fixtureLocator, summaryFor } from '../fixtures/listings.mjs';

export async function linkedUser(h, scope) {
  const wallet = createEphemeralWallet();
  const { provider } = await linkAccount({ harness: h, wallet, ...(scope ? { scope } : {}) });
  return { wallet, provider, token: () => provider.tokens().access_token };
}

// Full CallToolResult (text content included) for assertions on wording.
export async function toolRaw(h, user, name, args = {}) {
  const client = new Client({ name: 'flow-test-raw', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(h.mcpUrl), user ? { authProvider: user.provider } : {}));
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

export async function tool(h, user, name, args = {}) {
  const client = new Client({ name: 'flow-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(h.mcpUrl), user ? { authProvider: user.provider } : {});
  await client.connect(transport);
  try {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) {
      const parsed = (() => {
        try {
          return JSON.parse(result.content[0].text);
        } catch {
          return { error: 'unparsed', message: result.content[0]?.text };
        }
      })();
      return { error: parsed.error, message: parsed.message, details: parsed.details, raw: result };
    }
    return result.structuredContent;
  } finally {
    await client.close();
  }
}

export async function portal(h, path, body) {
  const res = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = await res.json();
  return { status: res.status, ...data };
}

export function tokenFrom(url) {
  return new URLSearchParams(new URL(url).hash.slice(1)).get('t');
}

export function seedSellerListing(h, seller, options = {}) {
  const listing = fixtureListing(seller, options);
  const locator = fixtureLocator(`${seller.address}:${listing.listingId}:${listing.listingVersion}`);
  h.chain.seedStorage(locator, { data: listing, owner: seller.address });
  h.directory.add(summaryFor(listing, locator, options.summary), listing);
  return { listing, locator };
}

// Portal approval with the buyer's wallet; returns the handoff response.
export async function approvePurchase(h, operationId, approvalUrl, wallet) {
  const token = tokenFrom(approvalUrl);
  const challenge = await portal(h, `/portal/api/purchase/${operationId}/challenge`, { token, address: wallet.address });
  if (challenge.status !== 200) return { challenge };
  const approved = await portal(h, `/portal/api/purchase/${operationId}/approve`, { token, challengeId: challenge.challengeId, signature: wallet.signHex(challenge.message) });
  if (approved.status === 'payment_handoff') {
    const accountId = h.app.services.accounts.walletOwner(wallet.address);
    const operation = h.app.services.ops.get(accountId, operationId);
    if (operation.terms.protocol) advancePastFinalizedCommitment(h, operation);
  }
  return { challenge, approved, token };
}

export async function reportPurchase(h, operationId, token, body) {
  return portal(h, `/portal/api/purchase/${operationId}/report`, { token, ...body });
}
