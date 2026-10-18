// Identity reads. Every chain here is a SIMULATED local fixture or an
// in-process fake; results are labelled simulated-fixture. Positive vectors
// use the pinned @kynesyslabs/dacs getIdentities envelope
// {result:200, response:{xm, web2, ud, pqc}}; nothing here contacts a node.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.mjs';
import { linkedUser, tool, toolRaw } from './helpers/flows.mjs';
import { createIdentityService, projectIdentities, IDENTITY_READ_LIMITS } from '../src/identities.mjs';
import { createDemosChainReader } from '../src/dacs/chain.mjs';

let h;
before(async () => {
  h = await startHarness();
});
after(async () => h.close());

const ADDR = `0x${'ab'.repeat(32)}`;
const EVM = `0x${'cd'.repeat(20)}`;

test('get_identities: read-only, account-read permission, open-world annotations, honest description', async () => {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'identities-list', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(h.mcpUrl)));
  try {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'get_identities');
    assert.ok(t, 'get_identities is listed');
    assert.deepEqual(t._meta.securitySchemes, [{ type: 'oauth2', scopes: ['dacs.account.read'] }]);
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.destructiveHint, false);
    assert.equal(t.annotations.openWorldHint, true);
    assert.deepEqual(Object.keys(t.inputSchema.properties), ['walletAddress']);
    assert.match(t.description, /not KYC, legal identity or proof of personhood/);
    assert.match(t.description, /not finalized or cross-checked chain state/);
    assert.match(t.description, /reported as unavailable, never as no identities/);
    assert.ok(!('capability' in t.outputSchema.properties), 'success implies configured; not_configured is a tool error');
  } finally {
    await client.close();
  }
});

test('get_identities: one unified getIdentities read per wallet, pinned projection, explicit evidence limits', async () => {
  const user = await linkedUser(h);
  h.chain.seedWeb2Identity(user.wallet.address, 'github', { username: 'octo-tester', userId: '42', proof: 'https://gist.github.com/octo-tester/abc' });
  h.chain.seedWeb2Identity(user.wallet.address, 'twitter', { username: 'tester_x', userId: '7', proof: 'https://x.com/tester_x/status/1' });
  h.chain.seedXmIdentity(user.wallet.address, 'evm', 'sepolia', EVM);
  const before = h.chain.faults.rpcCalls.length;
  const out = await tool(h, user, 'get_identities');
  assert.deepEqual(h.chain.faults.rpcCalls.slice(before), ['gcr_routine:getIdentities'], 'no split getWeb2Identities/getXmIdentities calls');
  assert.equal(out.wallets.length, 1);
  const w = out.wallets[0];
  assert.equal(w.address, user.wallet.address);
  assert.equal(w.status, 'observed');
  assert.deepEqual(w.claims.map((c) => c.ref).sort(), [
    'cci-web2:github:octo-tester',
    'cci-web2:twitter:tester_x',
    `cci-xm:evm:sepolia:${EVM}`,
  ]);
  assert.deepEqual(w.counts, { web2: 2, wallets: 1, ud: 0, pqc: 0, nomis: 0, humanPassport: 0, ethos: 0, tlsn: 0 });
  // Pinned claimProof precedence is proofUrl ?? proofHash ?? signature ?? proof,
  // so the fixture's stored proofHash is the commitment surfaced here.
  const rawGithub = JSON.parse(w.raw.json).response.web2.github[0];
  assert.equal(w.claims.find((c) => c.platform === 'github').proof, rawGithub.proofHash);
  assert.deepEqual(w.evidence.mode, 'simulated-fixture');
  assert.equal(w.evidence.network, 'demos-testnet');
  assert.ok(Date.parse(w.evidence.observedAt) > 0);
  assert.equal(w.error, null);
  assert.match(w.raw.sha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(w.raw.json).result, 200, 'the whole decoded envelope is the raw evidence');
  assert.deepEqual(out.readLimits, IDENTITY_READ_LIMITS);
  assert.match(out.readLimits.authority, /without request authentication or state proofs/);
  assert.match(out.readLimits.freshness, /local clock/);
  assert.match(out.identityActions.scope, /only propose GitHub or Twitter/);
  assert.match(out.note, /not proof of which transaction caused them/);
});

test('get_identities only reads wallets linked to the caller', async () => {
  const accountOwner = await linkedUser(h);
  const anotherAccount = await linkedUser(h);
  const refused = await tool(h, accountOwner, 'get_identities', { walletAddress: anotherAccount.wallet.address });
  assert.equal(refused.error, 'wallet_not_linked');
  const own = await tool(h, accountOwner, 'get_identities', { walletAddress: accountOwner.wallet.address });
  assert.deepEqual(own.wallets.map((w) => w.address), [accountOwner.wallet.address]);
  const anon = await toolRaw(h, null, 'get_identities');
  assert.equal(anon.isError, true);
  assert.ok(anon._meta?.['mcp/www_authenticate'], 'anonymous callers get an OAuth challenge');
});

test('an unavailable chain is a tool error, never a successful empty identity list', async () => {
  const user = await linkedUser(h);
  for (const fault of [() => { h.chain.faults.unavailable = true; }, () => { h.chain.faults.identityEnvelope = { result: 500, response: 'node busy' }; }]) {
    fault();
    try {
      const raw = await toolRaw(h, user, 'get_identities');
      assert.equal(raw.isError, true);
      assert.equal(raw.structuredContent, undefined, 'no structured success');
      const body = JSON.parse(raw.content[0].text);
      assert.equal(body.error, 'identity_reads_unavailable');
      assert.match(body.message, /unknown, not empty/);
      assert.equal(body.details.wallets[0].address, user.wallet.address);
      assert.ok(body.details.wallets[0].error);
    } finally {
      h.chain.faults.unavailable = false;
      delete h.chain.faults.identityEnvelope;
    }
  }
});

test('a partial outage marks only the failed wallet unavailable with claims null', async () => {
  const good = `0x${'1'.repeat(64)}`;
  const bad = `0x${'2'.repeat(64)}`;
  const chain = {
    network: 'demos-testnet',
    rpcOrigin: 'http://127.0.0.1:1',
    evidenceMode: 'simulated-fixture',
    getIdentities: async (address) => {
      if (address === bad) throw new Error('connect ECONNREFUSED');
      return { result: 200, response: { xm: {}, web2: {}, ud: [], pqc: {} } };
    },
  };
  const accounts = { listWallets: () => [{ address: good }, { address: bad }] };
  const service = createIdentityService({ chain, accounts, now: () => Date.parse('2026-10-03T00:00:00Z') });
  const [ok, failed] = await service.observe({ accountId: 'acc_x' });
  assert.equal(ok.status, 'observed');
  assert.deepEqual(ok.claims, [], 'a genuinely empty answer is an empty list');
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.claims, null, 'a failed read is unknown, not empty');
  assert.equal(failed.counts, null);
  assert.equal(failed.raw, null);
  assert.match(failed.error, /ECONNREFUSED/);
  assert.equal(failed.evidence.observedAt, '2026-10-03T00:00:00.000Z');
});

test('an unrecognised response shape is reported as unrecognized with its raw hash, not coerced', async () => {
  const user = await linkedUser(h);
  h.chain.faults.identityResponse = { github: 'not-a-context-object' };
  try {
    const out = await tool(h, user, 'get_identities');
    assert.equal(out.wallets[0].status, 'unrecognized');
    assert.equal(out.wallets[0].claims, null);
    assert.match(out.wallets[0].raw.sha256, /^[0-9a-f]{64}$/);
    assert.match(out.wallets[0].error, /no recognised identity contexts/);
  } finally {
    delete h.chain.faults.identityResponse;
  }
});

test('with no chain RPC configured, identity reads are not_configured and never use fixtures', async () => {
  const bare = await startHarness({ env: { DACS_CHAIN_RPC_URL: '' } });
  try {
    const user = await linkedUser(bare);
    const before = bare.chain.faults.rpcCalls.length;
    const out = await tool(bare, user, 'get_identities');
    assert.equal(out.error, 'not_configured');
    assert.equal(bare.chain.faults.rpcCalls.length, before, 'the fixture chain was not contacted');
  } finally {
    await bare.close();
  }
});

test('pinned positive vectors project through @kynesyslabs/dacs parseCciRecord', () => {
  const full = projectIdentities(ADDR, {
    result: 200,
    response: {
      xm: { evm: { sepolia: [{ address: EVM }] } },
      web2: { github: [{ username: 'octo', userId: '1', proof: 'https://gist.github.com/octo/1' }], twitter: [{ username: 'bird' }] },
      ud: [],
      pqc: {},
    },
  });
  assert.equal(full.status, 'observed');
  assert.deepEqual(full.record.claims.map((c) => c.ref), ['cci-web2:github:octo', 'cci-web2:twitter:bird', `cci-xm:evm:sepolia:${EVM}`]);
  assert.equal(full.record.primaryClaim, ADDR);

  const empty = projectIdentities(ADDR, { result: 200, response: { xm: {}, web2: {}, ud: [], pqc: {} } });
  assert.equal(empty.status, 'observed');
  assert.deepEqual(empty.record.claims, []);

  assert.equal(projectIdentities(ADDR, { result: 200, response: {} }).status, 'unrecognized');
  assert.equal(projectIdentities(ADDR, { result: 200, response: 'text' }).status, 'unrecognized');
});

test('chain reader sends the exact pinned getIdentities request and refuses a non-200 envelope', async () => {
  const seen = [];
  let reply = { result: 200, response: { xm: {}, web2: {}, ud: [], pqc: {} } };
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const reader = createDemosChainReader({ rpcUrl: 'http://127.0.0.1:9/', network: 'demos-testnet', fetchImpl });
  assert.deepEqual(await reader.getIdentities(ADDR.toUpperCase().replace('0X', '0x')), reply);
  assert.deepEqual(seen[0].body, { method: 'gcr_routine', params: [{ method: 'getIdentities', params: [ADDR] }] });
  assert.equal(typeof reader.getWeb2Identities, 'undefined', 'split reads are gone');
  reply = { result: 404, response: 'not found' };
  await assert.rejects(reader.getIdentities(ADDR), (error) => error.kind === 'unavailable');
  reply = { result: 200 };
  await assert.rejects(reader.getIdentities(ADDR), (error) => error.kind === 'unavailable');
});

test('fix 4: all eight context container types follow the pinned parser, with omitted contexts accepted', async () => {
  const arraysAccepted = new Set(['ud', 'pqc', 'humanpassport', 'tlsn']);
  for (const context of ['web2', 'xm', 'ud', 'pqc', 'nomis', 'humanpassport', 'ethos', 'tlsn']) {
    for (const bad of [null, 42, 'RPC temporarily unavailable', ...(arraysAccepted.has(context) ? [] : [[]])]) {
      assert.equal(projectIdentities(ADDR, { result: 200, response: { web2: {}, [context]: bad } }).status, 'unrecognized', context);
    }
    for (const good of [{}, ...(arraysAccepted.has(context) ? [[]] : [])]) {
      assert.equal(projectIdentities(ADDR, { result: 200, response: { [context]: good } }).status, 'observed', context);
    }
  }
  const user = await linkedUser(h);
  try {
    for (const web2 of [null, 42, [], 'RPC temporarily unavailable']) {
      h.chain.faults.identityEnvelope = { result: 200, response: { web2 } };
      const out = await tool(h, user, 'get_identities');
      assert.equal(out.wallets[0].status, 'unrecognized');
      assert.equal(out.wallets[0].claims, null); assert.equal(out.wallets[0].counts, null);
    }
    h.chain.faults.identityEnvelope = {result:200,response:{ud:[],xm:{},pqc:{},web2:{}},require_reply:false,extra:null};
    const out = await tool(h, user, 'get_identities');
    assert.equal(out.wallets[0].status, 'observed'); assert.deepEqual(out.wallets[0].claims, []);
  } finally { delete h.chain.faults.identityEnvelope; }
});

test('an earlier review item 1: nested failure is unrecognized in projection and get_identities; success and live empty remain observed', async () => {
  const failed = { result: 200, response: { result: 500, web2: {} } };
  const successful = { result: 200, response: { result: 200, web2: {} } };
  const liveEmpty = {result:200,response:{ud:[],xm:{},pqc:{},web2:{}},require_reply:false,extra:null};
  const user = await linkedUser(h);
  try {
    for (const [value, status] of [[failed, 'unrecognized'], [successful, 'observed'], [liveEmpty, 'observed']]) {
      const projected = projectIdentities(ADDR, value);
      assert.equal(projected.status, status);
      if (status === 'unrecognized') assert.equal(projected.record, null);
      else assert.deepEqual(projected.record.claims, []);
      h.chain.faults.identityEnvelope = value;
      const out = await tool(h, user, 'get_identities');
      assert.equal(out.wallets[0].status, status);
      assert.deepEqual(out.wallets[0].claims, status === 'observed' ? [] : null);
      if (status === 'unrecognized') assert.equal(out.wallets[0].counts, null);
    }
  } finally { delete h.chain.faults.identityEnvelope; }
});

test('an earlier review item 1: outer contexts cannot hide inner identities in projection or get_identities', async () => {
  const user = await linkedUser(h);
  try {
    for (const outer of [{ web2: [] }, { web2: {} }, { linkedWallets: [] },
      ...['xm', 'ud', 'pqc', 'nomis', 'humanpassport', 'ethos', 'tlsn', 'linkedSocials'].map((k) => ({ [k]: {} }))]) {
      const value = { result: 200, ...outer, response: { web2: { github: ['inner'] } } };
      const projected = projectIdentities(ADDR, value);
      assert.equal(projected.status, 'unrecognized', JSON.stringify(outer));
      assert.equal(projected.record, null);
      h.chain.faults.identityEnvelope = value;
      const out = await tool(h, user, 'get_identities');
      assert.equal(out.wallets[0].status, 'unrecognized', JSON.stringify(outer));
      assert.equal(out.wallets[0].claims, null);
      assert.equal(out.wallets[0].counts, null);
    }
  } finally { delete h.chain.faults.identityEnvelope; }
});

test('an earlier review item 2: linkedSocials still projects and get_identities reports the GitHub claim', async () => {
  const value = { result: 200, response: { web2: {}, linkedSocials: { github: 'inner' } } };
  const projected = projectIdentities(ADDR, value);
  assert.equal(projected.status, 'observed');
  assert.deepEqual(projected.record.claims.map((c) => c.ref), ['cci-web2:github:inner']);
  const user = await linkedUser(h);
  h.chain.faults.identityEnvelope = value;
  try {
    const out = await tool(h, user, 'get_identities');
    assert.equal(out.wallets[0].status, 'observed');
    assert.deepEqual(out.wallets[0].claims.map((c) => c.ref), ['cci-web2:github:inner']);
    assert.equal(out.wallets[0].counts.web2, 1);
  } finally { delete h.chain.faults.identityEnvelope; }
});

test('fix 3: seller per-call RPC deadline aborts a hanging transport and keeps the default for other reads', async () => {
  const signals = [];
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    signals.push(init.signal);
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  const reader = createDemosChainReader({ rpcUrl: 'http://127.0.0.1:9/', network: 'demos-testnet', fetchImpl, timeoutMs: 150 });
  const start = performance.now();
  const keepAlive = setTimeout(() => {}, 500);
  try {
    await assert.rejects(reader.getIdentities(ADDR, { timeoutMs: 25 }), (e)=>e.kind==='unavailable');
    assert.ok(signals[0].aborted);
    assert.ok(performance.now()-start < 100);
    const normalStart = performance.now();
    await assert.rejects(reader.getIdentities(ADDR), (e)=>e.kind==='unavailable');
    assert.ok(performance.now()-normalStart >= 100);
  } finally { clearTimeout(keepAlive); }
});
