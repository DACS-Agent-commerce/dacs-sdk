// Public replay and ephemeral test Listings; every request stays on loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { checkDirectory } from '../scripts/check-live-directory.mjs';
import { contentHash } from '../src/dacs/listing.mjs';
import { signedBytes } from '@kynesyslabs/dacs';
import { fixtureListing, fixtureLocator, summaryFor } from './fixtures/listings.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/live-directory-market-report.json', import.meta.url)));
const rfqFixture = JSON.parse(readFileSync(new URL('./fixtures/live-directory-rfq.json', import.meta.url)));
const NOW = Date.parse(fixture.capturedAt);
const DAY = 24 * 60 * 60 * 1000;
const secondSummary = { ...rfqFixture.summary, catalogObservedAt: NOW };

async function replay(t, options = {}) {
  const recorded = options.fixture ?? fixture;
  const calls = [];
  let page = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null });
    res.setHeader('content-type', 'application/json');
    if (options.simulated === true || (options.simulated === 'chain' && req.url.startsWith('/storage-program/'))) res.setHeader('x-dacs-simulation', 'true');
    if (options.redirect || (options.pageRedirectAt === page && req.url.startsWith('/api/dacs/listings?'))) {
      res.writeHead(302, { location: '/must-not-follow' });
      res.end();
      return;
    }
    if (options.oversize || (options.pageOversizeAt === page && req.url.startsWith('/api/dacs/listings?'))) {
      res.setHeader('content-length', '1000001');
      res.end();
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/dacs/listings') {
      const summary = options.summary ?? ((options.paged || options.repeatedCursor) && url.searchParams.has('cursor') ? secondSummary : recorded.summary);
      const cursor = options.repeatedCursor ? '50' : options.paged && !url.searchParams.has('cursor') ? '50' : null;
      const response = options.pages?.[page % options.pages.length] ?? { listings: [summary], cursor, total: options.paged ? 2 : options.repeatedCursor ? 3 : 1 };
      page += 1;
      res.end(JSON.stringify(response));
    } else {
      const entry = [recorded, rfqFixture, ...(options.fixtures ?? [])].find((item) => url.pathname === `/api/dacs/listings/${item.summary.listingId}/${item.summary.version}` && url.searchParams.get('seller') === item.summary.seller.primaryClaim);
      const program = [recorded, rfqFixture, ...(options.fixtures ?? [])].find((item) => url.pathname === `/storage-program/${item.summary.anchor.locator}`);
      if (req.method === 'GET' && entry) res.end(JSON.stringify(options.detail ?? entry.storageProgram.data));
      else if (req.method === 'GET' && program) {
        res.statusCode = options.programStatus ?? 200;
        res.end(JSON.stringify(options.program ?? program.storageProgram));
      } else {
        res.writeHead(400);
        res.end('{}');
      }
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const emitted = [];
  const scans = [];
  return { origin, calls, emitted, scans, run: () => checkDirectory({ directoryOrigin: origin, rpcUrl: origin, now: () => typeof options.now === 'function' ? options.now() : options.now ?? Date.parse(recorded.capturedAt), onResult: (row) => emitted.push(row), onScan: (report) => scans.push(report) }) };
}

async function runCli(world, recorded = fixture) {
  const script = new URL('../scripts/check-live-directory.mjs', import.meta.url);
  const clock = `data:text/javascript,${encodeURIComponent(`Date.now = () => ${Date.parse(recorded.capturedAt)};`)}`;
  const child = spawn(process.execPath, ['--import', clock, script.pathname, `--directory-origin=${world.origin}`, `--rpc-url=${world.origin}`]);
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return { exitCode, stderr, rows: stdout.trim() ? stdout.trim().split('\n').map((line) => JSON.parse(line)) : [] };
}

function freshSummary() {
  return { ...fixture.summary, catalogObservedAt: NOW };
}

test('recorded numeric market report verifies through the server path with read-only requests', async (t) => {
  const world = await replay(t);
  const rows = await world.run();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows, world.emitted);
  const row = rows[0];
  assert.equal(row.listingId, fixture.summary.listingId);
  assert.equal(row.version, 1);
  assert.equal(row.locator, fixture.summary.anchor.locator);
  assert.equal(typeof fixture.summary.catalogObservedAt, 'number');
  assert.ok(NOW >= fixture.summary.catalogObservedAt && NOW - fixture.summary.catalogObservedAt < DAY);
  assert.equal(row.result, 'verified-supported');
  assert.equal(row.validation, 'verified');
  assert.deepEqual(row.purchaseSupport, { supported: true, reasons: [] });
  assert.deepEqual(row.reasons, []);
  assert.ok(row.checks.every((check) => check.ok));
  assert.deepEqual(world.calls.map((call) => call.method), ['GET', 'GET', 'GET', 'GET']);
  assert.deepEqual(world.calls[3], world.calls[0]);
  assert.ok(world.calls[0].path.includes('profile=dacs-v0.1&limit=50'));
  assert.equal(world.calls[2].path, `/storage-program/${fixture.summary.anchor.locator}`);
  assert.ok(world.calls.every((call) => call.body === null));
});

test('the same numeric capture fails when its catalog observation is more than 24 hours old', async (t) => {
  const world = await replay(t, { now: fixture.summary.catalogObservedAt + DAY + 1 });
  const [row] = await world.run();
  assert.equal(row.result, 'validation-failed');
  assert.equal(row.validation, 'indeterminate');
  assert.deepEqual(row.purchaseSupport, { supported: true, reasons: [] });
  assert.deepEqual(row.reasons, [
    'catalog-observation-fresh: catalog observation older than 24h, in the future or missing; revocation absence cannot be established',
    'standard-reader-verified: indeterminate at step 5: catalog-stale',
  ]);
});

test('cursor pagination checks and emits every listing', async (t) => {
  const world = await replay(t, { paged: true });
  assert.equal((await world.run()).length, 2);
  assert.equal(world.emitted.length, 2);
  assert.ok(world.calls[3].path.endsWith('&cursor=50'));
  assert.deepEqual(world.scans, [{ completeness: 'checked', advertisedTotal: 2, observedTotal: 2 }]);
});

test('missing next cursor fails an incomplete advertised total', async (t) => {
  const world = await replay(t, { pages: [{ listings: [fixture.summary], total: 2 }] });
  await assert.rejects(world.run(), (error) => {
    assert.match(error.message, /pagination ended before total was reached; advertised total: 2; observed rows: 1/);
    assert.deepEqual(error.scan, { completeness: 'incomplete', advertisedTotal: 2, observedTotal: 1 });
    return true;
  });
  assert.equal(world.emitted.length, 1);
  assert.deepEqual(world.scans, []);
});

test('changing totals fail even when the final count matches the new total', async (t) => {
  const world = await replay(t, { pages: [
    { listings: [fixture.summary], total: 3, cursor: '50' },
    { listings: [secondSummary], total: 2 },
  ] });
  await assert.rejects(world.run(), (error) => {
    assert.match(error.message, /total changed from 3 to 2/);
    assert.deepEqual(error.scan, { completeness: 'incomplete', advertisedTotal: 3, observedTotal: 2 });
    return true;
  });
});

for (const total of [1.5, '1', null, -1, Number.MAX_SAFE_INTEGER + 1, {}]) {
  test(`invalid advertised total ${JSON.stringify(total)} fails an incomplete scan`, async (t) => {
    const world = await replay(t, { pages: [{ listings: [fixture.summary], total }] });
    await assert.rejects(world.run(), (error) => {
      assert.match(error.message, /total must be a non-negative safe integer/);
      assert.deepEqual(error.scan, { completeness: 'incomplete', advertisedTotal: total, observedTotal: 1 });
      return true;
    });
    assert.equal(world.calls.length, 1);
  });
}

test('more observed rows than advertised total fail before following the cursor', async (t) => {
  const world = await replay(t, { pages: [{ listings: [fixture.summary, fixture.summary], total: 1, cursor: '50' }] });
  await assert.rejects(world.run(), (error) => {
    assert.match(error.message, /observed rows exceed total/);
    assert.deepEqual(error.scan, { completeness: 'incomplete', advertisedTotal: 1, observedTotal: 2 });
    return true;
  });
  assert.equal(world.calls.length, 1);
});

test('pages without totals keep pagination and report unchecked completeness', async (t) => {
  for (const totals of [null, [2, undefined], [undefined, 2]]) {
    const pages = [
      { listings: [fixture.summary], cursor: '50' },
      { listings: [secondSummary] },
    ];
    if (totals) for (let page = 0; page < totals.length; page += 1) {
      if (totals[page] !== undefined) pages[page].total = totals[page];
    }
    const world = await replay(t, { pages });
    assert.equal((await world.run()).length, 2);
    assert.deepEqual(world.scans, [{ completeness: 'unchecked', advertisedTotal: totals ? 2 : null, observedTotal: 2, reason: 'directory omitted total; completeness could not be checked' }]);
  }
});

test('an omitted later total retains the earlier advertised count', async (t) => {
  const world = await replay(t, { pages: [
    { listings: [fixture.summary], total: 3, cursor: '50' },
    { listings: [secondSummary] },
  ] });
  await assert.rejects(world.run(), (error) => {
    assert.deepEqual(error.scan, { completeness: 'incomplete', advertisedTotal: 3, observedTotal: 2 });
    return true;
  });
});

test('an empty catalogue with total zero is complete', async (t) => {
  const world = await replay(t, { pages: [{ listings: [], total: 0 }] });
  assert.deepEqual(await world.run(), []);
  assert.deepEqual(world.scans, [{ completeness: 'checked', advertisedTotal: 0, observedTotal: 0 }]);
});

test('a valid unsupported pipeline remains unsupported', async (t) => {
  const world = await replay(t, { fixture: rfqFixture });
  const [row] = await world.run();
  assert.equal(row.result, 'unsupported');
  assert.equal(row.validation, 'verified');
  assert.deepEqual(row.reasons, []);
  assert.equal(row.purchaseSupport.supported, false);
  assert.ok(row.purchaseSupport.reasons.includes('negotiation is not fixed-price'));
  assert.equal(row.pipelineSupport.supported, false);
});

test('a valid entitlement is unsupported with the runtime protocol reason', async (t) => {
  const wallet = createEphemeralWallet();
  const { signature, ...draft } = fixtureListing(wallet, { now: NOW });
  draft.offering.deliverable = { kind: 'entitlement', durationSec: 3600, renewable: true };
  const listing = { ...draft, signature: { ...signature, value: wallet.signBytes(signedBytes('dacs-listing:v1:', contentHash(draft))).toString('base64url') } };
  const locator = fixtureLocator('live-check-entitlement');
  const recorded = {
    capturedAt: new Date(NOW).toISOString(),
    summary: summaryFor(listing, locator, { observedAt: NOW }),
    storageProgram: { success: true, storageAddress: locator, owner: wallet.address, encoding: 'json', data: listing },
  };
  const world = await replay(t, { fixture: recorded });
  const [row] = await world.run();
  assert.equal(row.validation, 'verified');
  assert.deepEqual(row.reasons, []);
  assert.deepEqual(row.purchaseSupport, { supported: true, reasons: [] });
  assert.deepEqual(row.pipelineSupport, { supported: true, reasons: [] });
  assert.equal(row.result, 'unsupported');
  assert.deepEqual(row.protocolSupport, { supported: false, reasons: ['deliverable is not a storage-program'] });
  const cli = await runCli(world, recorded);
  assert.equal(cli.exitCode, 0);
  assert.equal(cli.stderr, '');
  assert.equal(cli.rows[0].result, 'unsupported');
  assert.deepEqual(cli.rows[0].protocolSupport, row.protocolSupport);
});

test('a duplicate coordinate across pages is incomplete even when raw rows equal total', async (t) => {
  const world = await replay(t, { pages: [
    { listings: [fixture.summary], total: 2, cursor: '50' },
    { listings: [fixture.summary], total: 2 },
  ] });
  await assert.rejects(world.run(), (error) => {
    const coordinates = { seller: fixture.summary.seller.primaryClaim, listingId: fixture.summary.listingId, version: fixture.summary.version };
    assert.ok(error.message.includes(`duplicate listing ${JSON.stringify(coordinates)}`));
    assert.deepEqual(error.scan, { completeness: 'incomplete', advertisedTotal: 2, observedTotal: 2 });
    return true;
  });
  assert.equal(world.emitted.length, 1);
  assert.deepEqual(world.scans, []);
});

test('duplicate coordinates in one page also fail as incomplete', async (t) => {
  const world = await replay(t, { pages: [{ listings: [fixture.summary, fixture.summary], total: 2 }] });
  await assert.rejects(world.run(), (error) => {
    assert.match(error.message, /duplicate listing/);
    assert.deepEqual(error.scan, { completeness: 'incomplete', advertisedTotal: 2, observedTotal: 2 });
    return true;
  });
});

test('unreadable coordinates count as observed rows but cannot establish completeness', async (t) => {
  for (const summary of [null, { ...fixture.summary, seller: null }, { ...fixture.summary, listingId: null }, { ...fixture.summary, version: '1' }]) {
    const world = await replay(t, { pages: [{ listings: [summary], total: 1 }] });
    await assert.rejects(world.run(), (error) => {
      assert.match(error.message, /listing coordinates are unreadable/);
      assert.deepEqual(error.scan, { completeness: 'incomplete', advertisedTotal: 1, observedTotal: 1 });
      return true;
    });
    assert.equal(world.calls.length, 1);
    assert.equal(world.emitted.length, 0);
  }
});

test('coordinates stay distinct by seller, listingId and version even for rejected projections', async (t) => {
  const summary = { ...fixture.summary, contentHash: 'invalid' };
  const listings = [summary, { ...summary, seller: rfqFixture.summary.seller }, { ...summary, version: 2 }, { ...summary, listingId: 'different-id' }];
  const world = await replay(t, { pages: [{ listings, total: listings.length }] });
  const rows = await world.run();
  assert.ok(rows.every((row) => row.validation === 'projection-rejected'));
  assert.deepEqual(world.scans, [{ completeness: 'checked', advertisedTotal: 4, observedTotal: 4 }]);
  assert.equal(world.calls.length, 2);
  assert.deepEqual(world.calls[1], world.calls[0]);
});

test('rejected projections still participate in duplicate detection', async (t) => {
  const summary = { ...fixture.summary, contentHash: 'invalid' };
  const world = await replay(t, { pages: [
    { listings: [summary], total: 2, cursor: '50' },
    { listings: [summary], total: 2 },
  ] });
  await assert.rejects(world.run(), /duplicate listing/);
  assert.equal(world.emitted[0].validation, 'projection-rejected');
  assert.equal(world.calls.length, 2);
});

test('CLI refuses a duplicate coordinate even when raw rows match total', async (t) => {
  const world = await replay(t, { pages: [
    { listings: [fixture.summary], total: 2, cursor: '50' },
    { listings: [fixture.summary], total: 2 },
  ] });
  const { exitCode, stderr, rows } = await runCli(world);
  assert.equal(exitCode, 1);
  assert.equal(rows.length, 1);
  assert.match(JSON.parse(stderr).reason, /duplicate listing/);
  assert.deepEqual(JSON.parse(stderr).scan, { completeness: 'incomplete', advertisedTotal: 2, observedTotal: 2 });
});

test('validation failures take precedence over unsupported purchases and preserve support reasons', async (t) => {
  const world = await replay(t, { fixture: rfqFixture, now: rfqFixture.summary.catalogObservedAt + DAY + 1 });
  const [row] = await world.run();
  assert.equal(row.result, 'validation-failed');
  assert.ok(row.reasons.includes('standard-reader-verified: indeterminate at step 5: catalog-stale'));
  assert.equal(row.purchaseSupport.supported, false);
  assert.ok(row.purchaseSupport.reasons.includes('negotiation is not fixed-price'));
  assert.equal(row.pipelineSupport.supported, false);
  assert.ok(row.pipelineSupport.reasons[0].startsWith('pipeline is not '));
});

test('signature failure takes precedence over an unsupported delivery pipeline', async (t) => {
  const detail = structuredClone(fixture.storageProgram.data);
  detail.pipeline[3].kind = 'deliver-attested-payload';
  const program = structuredClone(fixture.storageProgram);
  program.data = detail;
  const world = await replay(t, { summary: { ...freshSummary(), contentHash: contentHash(detail) }, detail, program });
  const [row] = await world.run();
  assert.equal(row.result, 'validation-failed');
  assert.ok(row.reasons.includes('standard-reader-verified: rejected at step 4: listing-signature-invalid'));
  assert.equal(row.purchaseSupport.supported, true);
  assert.equal(row.pipelineSupport.supported, false);
});

test('simulation markers survive page, detail and chain reads', async (t) => {
  for (const simulated of [true, 'chain']) {
    const world = await replay(t, { simulated });
    const [row] = await world.run();
    assert.equal(row.evidence.directoryMode, simulated === true ? 'simulated-fixture' : 'public-directory-read');
    assert.equal(row.evidence.chainMode, 'simulated-fixture');
    assert.ok(world.calls.every((call) => call.method === 'GET'));
  }
});

test('owner and readback mismatches are reported even when the SDK verifies', async (t) => {
  const program = structuredClone(fixture.storageProgram);
  program.owner = `0x${'a'.repeat(64)}`;
  const detail = structuredClone(program.data);
  detail.offering.title = 'altered directory detail';
  const world = await replay(t, { summary: freshSummary(), program, detail });
  const [row] = await world.run();
  assert.equal(row.validation, 'verified');
  assert.equal(row.result, 'validation-failed');
  assert.ok(row.reasons.includes('chain-readback-equals-directory-detail'));
  assert.ok(row.reasons.includes('chain-anchor-owner-is-seller: anchor owner differs from the seller key'));
  assert.ok(row.reasons.includes('directory-detail-hash-matches-summary: directory detail differs from its own summary'));
});

test('absent, failed and malformed node reads never pass as anchored validation', async (t) => {
  for (const options of [{ programStatus: 404 }, { programStatus: 503 }, { program: { success: false } }, { program: { success: true, data: [] } }]) {
    const world = await replay(t, { summary: freshSummary(), ...options });
    const [row] = await world.run();
    assert.equal(row.result, 'validation-failed');
    assert.equal(row.checks.find((check) => check.name === 'chain-anchor-present').ok, false);
    assert.equal(row.checks.find((check) => check.name === 'chain-readback-equals-directory-detail').ok, false);
  }
});

test('rejected summaries produce a row without detail or RPC requests', async (t) => {
  const world = await replay(t, { summary: { ...fixture.summary, contentHash: 'invalid' } });
  const [row] = await world.run();
  assert.equal(row.validation, 'projection-rejected');
  assert.equal(row.result, 'validation-failed');
  assert.equal(row.purchaseSupport, null);
  assert.equal(world.calls.length, 2);
  assert.deepEqual(world.calls[1], world.calls[0]);
});

test('a repeated cursor refuses an incomplete directory scan', async (t) => {
  const world = await replay(t, { repeatedCursor: true });
  await assert.rejects(world.run(), (error) => {
    assert.match(error.message, /cursor is malformed or repeated/);
    assert.deepEqual(error.scan, { completeness: 'incomplete', advertisedTotal: 3, observedTotal: 2 });
    return true;
  });
  assert.equal(world.emitted.length, 2);
});

test('outbound limits reject redirects and oversized pages', async (t) => {
  for (const options of [{ redirect: true }, { oversize: true }]) {
    const world = await replay(t, options);
    await assert.rejects(world.run(), /unexpected redirect|response exceeds byte limit/);
    assert.equal(world.calls.length, 1);
  }
});

test('endpoint and CLI misuse fail before network access', async () => {
  let fetched = false;
  for (const directoryOrigin of ['http://directory.example', 'https://user:password@directory.example', 'https://directory.example/path']) {
    await assert.rejects(checkDirectory({ directoryOrigin, rpcUrl: 'http://127.0.0.1', fetchImpl: async () => { fetched = true; } }), /endpoints must/);
  }
  assert.equal(fetched, false);
  const script = new URL('../scripts/check-live-directory.mjs', import.meta.url);
  for (const args of [[], ['--write=true'], ['--directory-origin=http://127.0.0.1', '--directory-origin=http://127.0.0.1']]) {
    const result = spawnSync(process.execPath, [script.pathname, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).status, 'failed');
  }
});

test('CLI fails validation even for unsupported purchases and prints rows and totals', async (t) => {
  for (const { recorded, stale, result } of [
    { recorded: fixture, stale: false, result: 'verified-supported' },
    { recorded: rfqFixture, stale: false, result: 'unsupported' },
    { recorded: rfqFixture, stale: true, result: 'validation-failed' },
  ]) {
    const summary = { ...recorded.summary, catalogObservedAt: stale ? 0 : recorded.summary.catalogObservedAt };
    const world = await replay(t, { fixture: recorded, summary });
    const { exitCode, stderr, rows } = await runCli(world, recorded);
    assert.equal(exitCode, result === 'validation-failed' ? 1 : 0);
    assert.equal(stderr, '');
    assert.equal(rows[0].result, result);
    assert.deepEqual(rows[1], { total: 1, counts: { [result]: 1 }, scan: { completeness: 'checked', advertisedTotal: 1, observedTotal: 1 } });
  }
});

test('CLI exits non-zero and reports advertised and observed counts for an incomplete scan', async (t) => {
  const world = await replay(t, { pages: [{ listings: [fixture.summary], total: 2 }] });
  const { exitCode, stderr, rows } = await runCli(world);
  assert.equal(exitCode, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].result, 'verified-supported');
  const report = JSON.parse(stderr);
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.scan, { completeness: 'incomplete', advertisedTotal: 2, observedTotal: 1 });
  assert.match(report.reason, /advertised total: 2; observed rows: 1/);
});

test('CLI reports that completeness could not be checked without total', async (t) => {
  const world = await replay(t, { pages: [{ listings: [fixture.summary] }] });
  const { exitCode, stderr, rows } = await runCli(world);
  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.deepEqual(rows[1].scan, { completeness: 'unchecked', advertisedTotal: null, observedTotal: 1, reason: 'directory omitted total; completeness could not be checked' });
});

for (const field of ['rpcUrl', 'directoryOrigin']) {
  for (const delimiter of ['?', '#']) {
    test(`empty ${delimiter} delimiter in ${field} is rejected before any request`, async () => {
      let requests = 0;
      await assert.rejects(checkDirectory({
        directoryOrigin: 'https://directory.example', rpcUrl: 'https://node.example',
        [field]: `https://example.test/${delimiter}`,
        fetchImpl: async () => { requests += 1; return Response.json({ listings: [], total: 0 }); },
      }), /endpoints must/);
      assert.equal(requests, 0);
      const script = new URL('../scripts/check-live-directory.mjs', import.meta.url);
      const args = ['--directory-origin=http://127.0.0.1', '--rpc-url=http://127.0.0.1'];
      args[field === 'directoryOrigin' ? 0 : 1] += `/${delimiter}`;
      const cli = spawnSync(process.execPath, [script.pathname, ...args], { encoding: 'utf8' });
      assert.equal(cli.status, 1);
      assert.equal(cli.stdout, '');
      assert.match(JSON.parse(cli.stderr).reason, /endpoints must/);
    });
  }
}

test('unchanged catalogue replay checks ordered coordinates without repeating detail or storage reads', async (t) => {
  const world = await replay(t, { paged: true });
  assert.equal((await world.run()).length, 2);
  assert.deepEqual(world.scans, [{ completeness: 'checked', advertisedTotal: 2, observedTotal: 2 }]);
  assert.equal(world.calls.length, 8);
  assert.deepEqual(world.calls.slice(6), [world.calls[0], world.calls[3]]);
  assert.equal(world.calls.filter((call) => call.path.startsWith('/storage-program/')).length, 2);
  assert.equal(world.calls.filter((call) => call.path.startsWith('/api/dacs/listings/')).length, 2);
  assert.ok(world.calls.every((call) => call.method === 'GET' && call.body === null));
});

test('offset deletion and append with unchanged total and unique coordinates fails catalogue replay', async (t) => {
  const wallet = createEphemeralWallet();
  const listing = fixtureListing(wallet, { listingId: 'appended-report', now: NOW });
  const locator = fixtureLocator('live-check-appended-report');
  const appended = {
    capturedAt: new Date(NOW).toISOString(),
    summary: summaryFor(listing, locator, { observedAt: NOW }),
    storageProgram: { success: true, storageAddress: locator, owner: wallet.address, encoding: 'json', data: listing },
  };
  // [A, B] becomes [B, C] after A was read; offset 1 returns C, skipping B.
  const world = await replay(t, { fixtures: [appended], pages: [
    { listings: [fixture.summary], total: 2, cursor: '1' },
    { listings: [appended.summary], total: 2 },
    { listings: [secondSummary], total: 2, cursor: '1' },
    { listings: [appended.summary], total: 2 },
  ] });
  await assert.rejects(world.run(), (error) => {
    assert.match(error.message, /catalogue changed during scan/);
    assert.deepEqual(error.scan, { completeness: 'incomplete', advertisedTotal: 2, observedTotal: 2 });
    return true;
  });
  assert.deepEqual(world.emitted.map((row) => row.listingId), [fixture.summary.listingId, 'appended-report']);
  assert.ok(world.emitted.every((row) => row.result === 'verified-supported'));
  assert.deepEqual(world.scans, []);
  assert.equal(world.calls.length, 7);
  assert.deepEqual(world.calls.slice(6), [world.calls[0]]);
});

test('changed summary content hash with identical coordinates fails catalogue replay', async (t) => {
  const world = await replay(t, { pages: [
    { listings: [fixture.summary], total: 1 },
    { listings: [{ ...fixture.summary, contentHash: '0'.repeat(64) }], total: 1 },
  ] });
  await assert.rejects(world.run(), /catalogue changed during scan/);
  assert.equal(world.calls.length, 4);
  assert.deepEqual(world.calls[3], world.calls[0]);
});

test('replay accepts fresh later unsigned observation timestamps', async (t) => {
  const world = await replay(t, { now: () => world.calls.length >= 4 ? NOW + 2 : NOW, pages: [
    { listings: [fixture.summary], total: 1 },
    { listings: [{ ...fixture.summary, catalogObservedAt: NOW + 1 }], total: 1 },
  ] });
  assert.equal((await world.run())[0].result, 'verified-supported');
  assert.equal(world.scans[0].completeness, 'checked');
  assert.equal(world.calls.length, 4);
  assert.deepEqual(world.calls[3], world.calls[0]);
});

test('replay detects removal of a summary content hash', async (t) => {
  const { contentHash, ...withoutHash } = fixture.summary;
  const world = await replay(t, { pages: [
    { listings: [fixture.summary], total: 1 },
    { listings: [withoutHash], total: 1 },
  ] });
  await assert.rejects(world.run(), /catalogue changed during scan/);
});

test('replay total, row count and cursor inconsistencies fail incomplete', async (t) => {
  for (const page of [
    { listings: [fixture.summary], total: 2 },
    { listings: [fixture.summary], total: -1 },
    { listings: [], total: 1 },
    { listings: [fixture.summary, fixture.summary], total: 1 },
    { listings: [fixture.summary], total: 1, cursor: 'invalid' },
  ]) {
    const world = await replay(t, { pages: [{ listings: [fixture.summary], total: 1 }, page] });
    await assert.rejects(world.run(), (error) => {
      assert.match(error.message, /catalogue changed during scan/);
      assert.deepEqual(error.scan, { completeness: 'incomplete', advertisedTotal: 1, observedTotal: 1 });
      return true;
    });
  }
});

test('missing total on replay leaves completeness unchecked', async (t) => {
  const world = await replay(t, { pages: [
    { listings: [fixture.summary], total: 1 },
    { listings: [fixture.summary] },
  ] });
  await world.run();
  assert.deepEqual(world.scans, [{ completeness: 'unchecked', advertisedTotal: 1, observedTotal: 1, reason: 'directory omitted total; completeness could not be checked' }]);
});

test('replay keeps redirect and byte limits and reports incomplete', async (t) => {
  for (const options of [{ pageRedirectAt: 1 }, { pageOversizeAt: 1 }]) {
    const world = await replay(t, options);
    await assert.rejects(world.run(), (error) => {
      assert.match(error.message, /catalogue replay failed: unexpected redirect|catalogue replay failed: response exceeds byte limit/);
      assert.deepEqual(error.scan, { completeness: 'incomplete', advertisedTotal: 1, observedTotal: 1 });
      return true;
    });
    assert.equal(world.calls.length, 4);
    assert.deepEqual(world.calls[3], world.calls[0]);
  }
});

test('replay keeps the 100-page bound and refuses repeated cursors', async (t) => {
  for (const repeated of [true, false]) {
    const pages = [{ listings: [], total: 0 }];
    for (let page = 1; page <= 100; page += 1) pages.push({ listings: [], total: 0, cursor: repeated ? '1' : String(page) });
    const world = await replay(t, { pages });
    await assert.rejects(world.run(), (error) => {
      assert.match(error.message, repeated ? /replay cursor is malformed or repeated/ : /catalogue replay exceeds the 100-page check limit/);
      assert.deepEqual(error.scan, { completeness: 'incomplete', advertisedTotal: 0, observedTotal: 0 });
      return true;
    });
    assert.equal(world.calls.length, repeated ? 3 : 101);
    assert.ok(world.calls.every((call) => call.method === 'GET' && call.path.startsWith('/api/dacs/listings?')));
  }
});

test('CLI fails catalogue replay with advertised and observed counts', async (t) => {
  const world = await replay(t, { pages: [
    { listings: [fixture.summary, secondSummary], total: 2 },
    { listings: [secondSummary, fixture.summary], total: 2 },
  ] });
  const { exitCode, stderr, rows } = await runCli(world);
  assert.equal(exitCode, 1);
  assert.equal(rows.length, 2);
  assert.match(JSON.parse(stderr).reason, /catalogue changed during scan/);
  assert.deepEqual(JSON.parse(stderr).scan, { completeness: 'incomplete', advertisedTotal: 2, observedTotal: 2 });
  assert.equal(world.calls.length, 6);
  assert.deepEqual(world.calls[5], world.calls[0]);
});

for (const [field, change] of [
  ['status', { status: 'revoked' }],
  ['anchor locator', { anchor: { ...fixture.summary.anchor, locator: fixtureLocator('changed-replay-anchor') } }],
  ['revocation binding', { revocationBinding: { listingId: fixture.summary.listingId, listingVersion: fixture.summary.version, contentHash: fixture.summary.contentHash } }],
]) {
  test(`changed ${field} fails catalogue replay with unchanged coordinates and content hash`, async (t) => {
    const world = await replay(t, { pages: [
      { listings: [fixture.summary], total: 1 },
      { listings: [{ ...fixture.summary, ...change }], total: 1 },
    ] });
    await assert.rejects(world.run(), (error) => {
      assert.match(error.message, /catalogue changed during scan/);
      assert.deepEqual(error.scan, { completeness: 'incomplete', advertisedTotal: 1, observedTotal: 1 });
      return true;
    });
    assert.equal(world.emitted[0].result, 'verified-supported');
    assert.deepEqual(world.scans, []);
    assert.equal(world.calls.length, 4);
    assert.deepEqual(world.calls[3], world.calls[0]);
    assert.ok(world.calls.every((call) => call.method === 'GET' && call.body === null));
  });
}

test('replay compares newly added summary fields by default', async (t) => {
  const world = await replay(t, { pages: [
    { listings: [fixture.summary], total: 1 },
    { listings: [{ ...fixture.summary, futureVerificationInput: { mode: 'changed' } }], total: 1 },
  ] });
  await assert.rejects(world.run(), /catalogue changed during scan/);
  assert.equal(world.calls.length, 4);
  assert.deepEqual(world.calls[3], world.calls[0]);
});

test('replay uses canonical JSON and ignores object key order', async (t) => {
  function reorder(value) {
    if (Array.isArray(value)) return value.map(reorder);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reorder(entry)]));
    return value;
  }
  const world = await replay(t, { pages: [
    { listings: [fixture.summary], total: 1 },
    { listings: [reorder(fixture.summary)], total: 1 },
  ] });
  assert.equal((await world.run())[0].result, 'verified-supported');
  assert.deepEqual(world.scans, [{ completeness: 'checked', advertisedTotal: 1, observedTotal: 1 }]);
  assert.equal(world.calls.length, 4);
  assert.deepEqual(world.calls[3], world.calls[0]);
});

for (const [name, value, reason] of [
  ['epoch zero', 0, /stale/],
  ['future', NOW + 1000, /future/],
  ['stale', NOW - DAY - 1, /stale/],
  ['missing', undefined, /missing/],
  ['earlier', fixture.summary.catalogObservedAt - 1, /earlier/],
]) {
  test(`replay refuses ${name} catalogObservedAt`, async (t) => {
    const summary = { ...fixture.summary, catalogObservedAt: value };
    if (value === undefined) delete summary.catalogObservedAt;
    const world = await replay(t, { pages: [
      { listings: [fixture.summary], total: 1 },
      { listings: [summary], total: 1 },
    ] });
    await assert.rejects(world.run(), (error) => {
      assert.match(error.message, /catalogue changed during scan: catalogObservedAt at row 1/);
      assert.match(error.message, reason);
      assert.deepEqual(error.scan, { completeness: 'incomplete', advertisedTotal: 1, observedTotal: 1 });
      return true;
    });
    assert.equal(world.emitted[0].result, 'verified-supported');
    assert.deepEqual(world.scans, []);
    assert.equal(world.calls.length, 4);
    assert.deepEqual(world.calls[3], world.calls[0]);
    assert.ok(world.calls.every((call) => call.method === 'GET' && call.body === null));
  });
}

test('replay refuses catalogObservedAt added after an absent first-pass field', async (t) => {
  const { catalogObservedAt, ...missingObservation } = fixture.summary;
  const world = await replay(t, { pages: [
    { listings: [missingObservation], total: 1 },
    { listings: [fixture.summary], total: 1 },
  ] });
  await assert.rejects(world.run(), /catalogue changed during scan: catalogObservedAt at row 1.*added/);
  assert.equal(world.emitted[0].result, 'validation-failed');
  assert.equal(world.calls.length, 4);
  assert.deepEqual(world.calls[3], world.calls[0]);
});

test('replay refuses an unchanged initially fresh catalogObservedAt that expires before its read', async (t) => {
  const world = await replay(t, { now: () => world.calls.length >= 4 ? fixture.summary.catalogObservedAt + DAY + 1 : NOW });
  await assert.rejects(world.run(), /catalogue changed during scan: catalogObservedAt at row 1.*stale/);
  assert.equal(world.emitted[0].result, 'verified-supported');
  assert.equal(world.calls.length, 4);
  assert.deepEqual(world.calls[3], world.calls[0]);
});

test('replay accepts equivalent ISO and numeric catalogObservedAt observations', async (t) => {
  const world = await replay(t, { pages: [
    { listings: [fixture.summary], total: 1 },
    { listings: [{ ...fixture.summary, catalogObservedAt: new Date(fixture.summary.catalogObservedAt).toISOString() }], total: 1 },
  ] });
  assert.equal((await world.run())[0].result, 'verified-supported');
  assert.equal(world.scans[0].completeness, 'checked');
  assert.equal(world.calls.length, 4);
  assert.deepEqual(world.calls[3], world.calls[0]);
});

test('replay accepts catalogObservedAt exactly 24 hours old at its read time', async (t) => {
  const world = await replay(t, { now: () => world.calls.length >= 4 ? fixture.summary.catalogObservedAt + DAY : NOW });
  assert.equal((await world.run())[0].result, 'verified-supported');
  assert.equal(world.scans[0].completeness, 'checked');
  assert.equal(world.calls.length, 4);
  assert.deepEqual(world.calls[3], world.calls[0]);
});

test('CLI fails a catalogObservedAt replay change despite a verified first-pass row', async (t) => {
  const world = await replay(t, { pages: [
    { listings: [fixture.summary], total: 1 },
    { listings: [{ ...fixture.summary, catalogObservedAt: 0 }], total: 1 },
  ] });
  const { exitCode, stderr, rows } = await runCli(world);
  assert.equal(exitCode, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].result, 'verified-supported');
  assert.match(JSON.parse(stderr).reason, /catalogue changed during scan: catalogObservedAt at row 1.*stale/);
  assert.deepEqual(JSON.parse(stderr).scan, { completeness: 'incomplete', advertisedTotal: 1, observedTotal: 1 });
  assert.equal(world.calls.length, 4);
  assert.deepEqual(world.calls[3], world.calls[0]);
});
