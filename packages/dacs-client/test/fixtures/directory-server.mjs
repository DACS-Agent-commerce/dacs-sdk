// SIMULATED Community DACS Directory for local tests (x-dacs-simulation: fixture).
// Serves the public read endpoints the plugin uses and records registrations.
import http from 'node:http';
import { contentHash } from '@kynesyslabs/dacs';

export async function startDirectoryFixture() {
  const entries = new Map(); // key -> { summary, detail }
  const registrations = [];
  const faults = { unavailable: false, alterDetail: new Map() };
  const key = (seller, id, v) => `${seller}\0${id}\0${v}`;

  function send(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json', 'x-dacs-simulation': 'fixture' });
    res.end(JSON.stringify(body));
  }

  const server = http.createServer(async (req, res) => {
    if (faults.unavailable) return send(res, 503, { error: 'unavailable' });
    const url = new URL(req.url, 'http://fixture');
    if (req.method === 'GET' && url.pathname === '/api/dacs/listings') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const seller = url.searchParams.get('primaryClaim');
      const category = url.searchParams.get('category');
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const cursor = Number(url.searchParams.get('cursor') ?? 0);
      const all = [...entries.values()].map((e) => e.summary).filter((s) =>
        (!seller || s.seller.primaryClaim === seller) && (!category || s.offering.category === category) &&
        (!q || `${s.offering.title} ${s.offering.description}`.toLowerCase().includes(q)));
      const page = all.slice(cursor, cursor + limit);
      return send(res, 200, { listings: page, cursor: cursor + limit < all.length ? String(cursor + limit) : undefined, total: all.length });
    }
    const detail = /^\/api\/dacs\/listings\/([^/]+)\/(\d+)$/.exec(url.pathname);
    if (req.method === 'GET' && detail) {
      const seller = url.searchParams.get('seller');
      const k = key(seller, decodeURIComponent(detail[1]), Number(detail[2]));
      const entry = entries.get(k);
      if (!entry) return send(res, 404, { error: 'not found' });
      return send(res, 200, faults.alterDetail.get(k) ?? entry.detail);
    }
    if (req.method === 'POST' && url.pathname === '/api/dacs/register') {
      let body = '';
      for await (const chunk of req) body += chunk;
      registrations.push(JSON.parse(body));
      return send(res, 200, { ok: true, ownerVerified: true, queued: true, note: 'fixture: recorded only' });
    }
    send(res, 404, { error: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    faults,
    registrations,
    add(summary, detailListing) {
      entries.set(key(summary.seller.primaryClaim, summary.listingId, summary.version), { summary, detail: structuredClone(detailListing) });
    },
    keyFor: (listing) => key(listing.seller.identity.presentedBy, listing.listingId, listing.listingVersion),
    hashOf: contentHash,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
