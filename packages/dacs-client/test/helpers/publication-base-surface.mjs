import * as z from 'zod/v4';
import { createMcpServerFactory } from '../../src/mcp/server.mjs';

export async function publicationBaseSurface(config = {}) {
  const statuses = ['awaiting_identity_signature', 'awaiting_listing_signature', 'listing_signed', 'publication_handoff', 'broadcast_reported', 'publication_uncertain', 'publication_mismatch', 'chain_verified', 'directory_submitted', 'directory_visible', 'cancelled'];
  let status = statuses[0];
  const record = () => ({ agent: { id: 'agt_BASE', listingId: 'base-listing', status: 'onboarding' }, operation: { id: 'pub_BASE', status }, coordinates: null, history: [], portalUrl: 'https://plugin.example/portal/publish/pub_BASE#t=EXAMPLE', next: 'Base next.' });
  const services = {
    accounts: { resolveFromToken: () => ({ id: 'account_BASE' }) },
    agents: { get: record, register: () => ({ ...record(), created: true }), verifyPublication: async () => ({ operation: record().operation, verification: { outcome: 'awaiting_readback' } }) },
  };
  const server = createMcpServerFactory({ config: { publicOrigin: 'https://plugin.example', ...config }, services, logger: { info() {}, error() {} } })();
  const tools = Object.entries(server._registeredTools).map(([name, t]) => ({ name, title: t.title, description: t.description, inputSchema: z.toJSONSchema(t.inputSchema, { io: 'input' }), outputSchema: t.outputSchemaJson, annotations: t.annotations, _meta: t._meta }));
  const results = [];
  for (status of statuses) for (const scopes of [['dacs.account.read', 'dacs.agents.write'], ['dacs.account.read']]) {
    const ctx = { http: { authInfo: { scopes, extra: { issuer: 'issuer_BASE', subject: 'subject_BASE' } } } };
    for (const name of ['register_agent', 'get_agent_status', 'verify_agent_publication']) results.push(await server._registeredTools[name].handler({ agentId: 'agt_BASE' }, ctx));
  }
  const html = [];
  for (const [uri, resource] of Object.entries(server._registeredResources)) {
    const result = await resource.readCallback(new URL(uri), {});
    html.push({ uri, html: result.contents[0].text });
  }
  await server.close();
  return { tools: JSON.stringify(tools), results: JSON.stringify(results), html };
}
