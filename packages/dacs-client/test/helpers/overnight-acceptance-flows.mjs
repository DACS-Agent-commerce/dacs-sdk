// Overnight ordinary functional acceptance helpers (SIMULATED fixtures only).
// Source-aware, NOT a security review, NOT live/testnet/ChatGPT evidence.
//
// Expected values here are derived from the public tool contract (MCP input
// schemas and tool descriptions) and from the DEM denomination rule
// (1 DEM = 10^9 OS), independently of the plugin's own builders. Chain
// readback goes straight to the fixture chain's recorded transactions, which
// is a separate consumer from the plugin's verification answer.
import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { linkedUser, portal, tokenFrom } from './flows.mjs';
import { summaryFor } from '../fixtures/listings.mjs';

export const IDENTITY_WRITE_SCOPE = 'dacs.account.read dacs.identities.write';

export const unique = (label) => `${label}-${randomBytes(5).toString('hex')}`;

// Independent DEM -> OS conversion (decimal string, at most 9 fraction digits).
export function demToOs(dem) {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(dem);
  if (!m) throw new Error(`not a DEM decimal: ${dem}`);
  return (BigInt(m[1]) * 1_000_000_000n + BigInt((m[2] ?? '').padEnd(9, '0') || '0')).toString();
}

// One MCP tool call, classifying the three distinct outcomes so a test can
// never mistake a parsed error object for success:
//   { kind: 'ok', data }                       structuredContent of a success
//   { kind: 'tool_error', code, message }      isError result (domain or input validation)
//   { kind: 'protocol_error', message }        the client threw (JSON-RPC error)
export async function call(h, user, name, args = {}) {
  const client = new Client({ name: 'overnight-acceptance', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(h.mcpUrl), user ? { authProvider: user.provider } : {}));
  try {
    const result = await client.callTool({ name, arguments: args });
    if (!result.isError) return { kind: 'ok', data: result.structuredContent, text: result.content?.[0]?.text ?? '' };
    const raw = result.content?.[0]?.text ?? '';
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    return { kind: 'tool_error', code: parsed?.error ?? null, message: parsed?.message ?? raw };
  } catch (error) {
    return { kind: 'protocol_error', message: String(error?.message ?? error) };
  } finally {
    await client.close().catch(() => {});
  }
}

// Success or a descriptive throw (never returns an error object as data).
export async function ok(h, user, name, args = {}) {
  const r = await call(h, user, name, args);
  if (r.kind !== 'ok') throw new Error(`${name} expected success, got ${r.kind} ${r.code ?? ''}: ${String(r.message).slice(0, 300)}`);
  return r.data;
}

// A rejected user input: either a schema rejection (tool_error whose text
// names input validation, or a protocol error) or the named domain code.
export function isInputRejection(r) {
  if (r.kind === 'protocol_error') return true;
  return r.kind === 'tool_error' && (r.code === null || r.code === undefined) && /validation|invalid/i.test(r.message);
}

export async function seller(h) {
  return linkedUser(h);
}

export function agentInput(overrides = {}) {
  return {
    idempotencyKey: unique('oa-reg'),
    listingId: unique('oa-agent'),
    displayName: 'Overnight Seller',
    endpointUrl: 'https://overnight-seller.example/dacs',
    title: 'Overnight acceptance service',
    description: 'SIMULATED overnight acceptance listing.',
    category: 'services.translation',
    tags: ['overnight'],
    priceDem: '1.5',
    validDays: 30,
    ...overrides,
  };
}

// Seller publication through the documented portal steps with the seller's
// SIMULATED wallet, then directory registration and (simulated) indexing.
// Returns the public coordinates a buyer needs plus the evidence seen.
export async function publishListing(h, sellerUser, input) {
  const reg = await ok(h, sellerUser, 'register_agent', input);
  if (reg.status !== 'awaiting_identity_signature') throw new Error(`register_agent status ${reg.status}`);
  const token = tokenFrom(reg.portalUrl);
  const id = reg.operationId;
  const view = await portal(h, `/portal/api/publish/${id}/view`, { token });
  const identity = await portal(h, `/portal/api/publish/${id}/identity`, { token, address: sellerUser.wallet.address, signature: sellerUser.wallet.signHex(view.signRequest.message) });
  if (identity.status !== 'awaiting_listing_signature') throw new Error(`identity step ${identity.status ?? identity.error}`);
  const listed = await portal(h, `/portal/api/publish/${id}/listing`, { token, signature: sellerUser.wallet.signHex(identity.signRequest.message) });
  if (listed.status !== 'publication_handoff') throw new Error(`listing step ${listed.status ?? listed.error}`);
  const stages = { prepared: reg.status };
  const statusBefore = await ok(h, sellerUser, 'get_agent_status', { agentId: reg.agentId });
  stages.beforeBroadcast = { publicationStatus: statusBefore.publicationStatus, onChainVerified: statusBefore.onChainVerified };
  const txHash = h.chain.walletBroadcast(listed.payload); // SIMULATED wallet broadcast
  const report = await portal(h, `/portal/api/publish/${id}/report`, { token, txHash });
  stages.reported = report.status;
  const op = listed.payload.content.data[1];
  const req = await portal(h, `/portal/api/publish/${id}/registration`, { token });
  const registered = await portal(h, `/portal/api/publish/${id}/register`, { token, signedAt: req.signedAt, signature: sellerUser.wallet.signHex(req.message) });
  stages.directory = registered.status;
  // Before the directory indexes it, the new listing is not discoverable.
  const searchBefore = await ok(h, null, 'search_agents', { query: input.title });
  stages.discoverableBeforeIndex = searchBefore.results.some((r) => r.listingId === input.listingId);
  h.directory.add(summaryFor(op.data, op.storageAddress), op.data); // SIMULATED directory indexing
  const verified = await ok(h, sellerUser, 'verify_agent_publication', { agentId: reg.agentId });
  stages.afterIndex = verified.publicationStatus;
  return { reg, token, txHash, storageAddress: op.storageAddress, signedListing: op.data, stages, claim: sellerUser.wallet.claim };
}

// Buyer fixed-price purchase through the documented portal approval, with the
// buyer's SIMULATED wallet broadcasting the exact handed-off payload.
export async function approveAndPay(h, buyerUser, prepared) {
  const token = tokenFrom(prepared.approvalUrl);
  const id = prepared.operationId;
  const challenge = await portal(h, `/portal/api/purchase/${id}/challenge`, { token, address: buyerUser.wallet.address });
  if (challenge.status !== 200) return { stage: 'challenge', challenge, token };
  const approved = await portal(h, `/portal/api/purchase/${id}/approve`, { token, challengeId: challenge.challengeId, signature: buyerUser.wallet.signHex(challenge.message) });
  if (approved.status !== 'payment_handoff') return { stage: 'approve', approved, token };
  const txHash = h.chain.walletBroadcast(approved.payload);
  const reported = await portal(h, `/portal/api/purchase/${id}/report`, { token, txHash });
  return { stage: 'reported', approved, txHash, reported, token };
}

// Independent consumer of the fixture chain record (not the plugin's answer).
export function chainTransfer(h, txHash) {
  const tx = h.chain.txs.get(String(txHash).toLowerCase().replace(/^0x/, ''));
  if (!tx) return null;
  const c = tx.content;
  return { type: c.type, from: String(c.from).toLowerCase(), to: String(c.to).toLowerCase(), amount: String(c.amount), nonce: c.nonce, failed: tx.failed };
}

// Identity portal driver (documented /portal/api/identity/<id>/<step> calls).
export function identityPortal(h, start) {
  const url = new URL(start.portalUrl);
  const id = url.pathname.split('/').pop();
  const token = new URLSearchParams(url.hash.slice(1)).get('t');
  return {
    id,
    async step(name, body = {}) {
      const res = await fetch(`${h.origin}/portal/api/identity/${id}/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, ...body }) });
      return { http: res.status, body: await res.json() };
    },
  };
}

// Handles observed by get_identities for one wallet and platform.
export function observedHandles(identities, address, platform) {
  const w = (identities.wallets ?? []).find((x) => x.address === address);
  return (w?.claims ?? []).filter((c) => c.kind === 'web2' && c.platform === platform).map((c) => c.handle).sort();
}
