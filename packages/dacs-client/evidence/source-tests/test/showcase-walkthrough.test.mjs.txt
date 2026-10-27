// Showcase 12: read-only walkthrough pages and the two-choice starter tool,
// both behind DACS_SHOWCASE_WALKTHROUGH (default off). The built-in live
// operator's composition is covered by showcase-live-operator.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { loadConfig, ConfigError } from '../src/config.mjs';
import { showcaseChoices } from '../src/mcp/showcase-start.mjs';
import { startHarness } from './helpers/harness.mjs';
import { contractView, runtimeNames } from './helpers/env-contract-view.mjs';

const DIR = new URL('../public/showcase/', import.meta.url);
const PAGES = ['index.html', 'walkthrough.html', 'beyond-fixed-price.html'];
const SCOPE = 'Read-only. Nothing on these pages can sign, pay or buy, and every example is illustrative, not a real transaction.';
const page = (name) => readFileSync(new URL(name, DIR), 'utf8');
const between = (html, open, close) => html.split(open).slice(1).map((chunk) => chunk.split(close)[0]);

async function tools(h) {
  const client = new Client({ name: 'dacs-test', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(h.mcpUrl)));
  return client;
}

// Every row of every table, plus the connection's change counter.
function dbSnapshot(db) {
  const tables = Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  return { tables, changes: db.prepare('SELECT total_changes() AS n').get().n };
}

// Every attribute of every start tag, whatever its quoting.
const ATTRIBUTE = /\s([^\s"'<>\/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
function attributes(html) {
  return [...html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)]
    .flatMap(([, tag, rest]) => [...rest.matchAll(ATTRIBUTE)].map(([, name, value]) => ({ tag: tag.toLowerCase(), name: name.toLowerCase(), value })));
}
const ALLOWED_ATTRIBUTES = new Set(['lang', 'charset', 'name', 'content', 'rel', 'href', 'class', 'id', 'role', 'scope', 'tabindex', 'aria-label', 'aria-labelledby', 'aria-current', 'data-choice', 'data-example', 'data-row']);

test('switch: default off, strict off/on, env contract and example', () => {
  const base = { DACS_PUBLIC_ORIGIN: 'https://plugin.example', DACS_OAUTH_COOKIE_KEYS: 'TEST'.repeat(16) };
  assert.equal(loadConfig(base).showcaseWalkthrough, 'off');
  for (const value of ['off', 'on']) assert.equal(loadConfig({ ...base, DACS_SHOWCASE_WALKTHROUGH: value }).showcaseWalkthrough, value);
  for (const value of ['', 'ON', 'true', '1', 0, false]) assert.throws(() => loadConfig({ ...base, DACS_SHOWCASE_WALKTHROUGH: value }), ConfigError);
  const contract = contractView();
  assert.deepEqual(Object.keys(contract.variables).sort(), runtimeNames());
  assert.deepEqual(contract.variables.DACS_SHOWCASE_WALKTHROUGH, { kind: 'enum', values: ['off', 'on'], default: 'off', deployValue: 'off', operator: true });
  assert.match(readFileSync(new URL('../deploy/dacs-chatgpt.env.example', import.meta.url), 'utf8'), /^DACS_SHOWCASE_WALKTHROUGH=off$/m);
});

test('pages are static, script-free, self-contained and labelled read-only', () => {
  assert.deepEqual(readdirSync(DIR).sort(), [...PAGES, 'showcase.css'].sort());
  for (const name of PAGES) {
    const html = page(name);
    assert.match(html, /^<!doctype html>\n<html lang="en">/, name);
    assert.ok(html.includes(`<p class="scope" role="note">${SCOPE}</p>`), `${name} scope banner`);
    assert.equal(html.match(/<h1[ >]/g)?.length, 1, `${name} one h1`);
    assert.ok(html.includes('<a class="skip" href="#main">') && html.includes('<main id="main">'), `${name} skip link`);
    assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'), `${name} viewport`);
    assert.equal(html.match(/aria-current="page"/g)?.length, 1, `${name} marks itself current`);
    // No behaviour at all: nothing can call the app's API, wallet or MCP.
    assert.doesNotMatch(html, /<script|<form|<iframe|<input|<button|<object|<embed|\son[a-z]+=|\sstyle=|javascript:|fetch\(|\/portal\/api|\/mcp/i, name);
    // Only known attributes, always double-quoted: no src, srcset, formaction,
    // http-equiv, style or handlers, and no link the checks below could miss.
    for (const { tag, name: attr, value } of attributes(html)) {
      assert.ok(ALLOWED_ATTRIBUTES.has(attr), `${name} <${tag} ${attr}>`);
      if (value !== undefined) assert.match(value, /^"[^"]*"$/, `${name} <${tag} ${attr}=${value}> must be double-quoted`);
    }
    // Every link stays inside the showcase.
    const refs = attributes(html).filter((a) => a.name === 'href').map((a) => a.value.slice(1, -1));
    for (const ref of refs) assert.ok(['./', 'showcase.css', ...PAGES].includes(ref) || /^#[a-z-]+$/.test(ref), `${name} link ${ref}`);
    for (const target of PAGES.filter((p) => p !== name)) assert.ok(refs.includes(target === 'index.html' ? './' : target), `${name} links to ${target}`);
    // Examples cannot pass for real records: no hashes, addresses, claims, locators or operation ids.
    assert.doesNotMatch(html, /\b[0-9a-f]{40,}\b|0x[0-9a-fA-F]{8,}|did:demos:|stor-[0-9a-f]|\b(?:pur|pub|agt)_[A-Za-z0-9_-]{16}\b/, `${name} reference-like text`);
    // Every example block carries the label.
    for (const block of between(html, '<section class="example"', '</section>')) assert.ok(block.includes('<p class="example-label">Illustrative example</p>'), `${name} example label`);
  }
  // Every scrolling table region is focusable and labelled.
  const wrappers = PAGES.flatMap((name) => [...page(name).matchAll(/<div class="table-wrap"([^>]*)>/g)].map((m) => [name, m[1]]));
  assert.deepEqual(wrappers.map(([name]) => name), ['walkthrough.html', 'walkthrough.html', 'beyond-fixed-price.html']);
  for (const [name, rest] of wrappers) assert.match(rest, /^ tabindex="0" role="region" aria-label="[^"]+, scrollable"$/, name);
  const css = page('showcase.css');
  // The skip link is off-screen until focused, then on-screen.
  assert.match(css, /\.skip \{\n  position: absolute;\n  left: -9999px;\n\}\n\.skip:focus \{\n  left: 16px;\n  top: 16px;\n/);
  assert.match(css, /:root \{\n  color-scheme: light dark;\n/);
  assert.match(css, /\.table-wrap:focus-visible/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /@media \(max-width: 480px\)/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css, /url\(|@import|@font-face/);
});

test('the start page offers exactly two explicit choices, and only the live one is real', () => {
  const html = page('index.html');
  assert.deepEqual([...html.matchAll(/data-choice="([^"]+)"/g)].map((m) => m[1]), ['walkthrough', 'live-testnet-purchase']);
  const [walkthrough, live] = between(html, '<section class="choice"', '</section>');
  assert.match(walkthrough, /read-only/);
  assert.match(walkthrough, /cannot buy anything/);
  assert.match(walkthrough, /href="walkthrough.html"/);
  assert.match(live, /This page cannot start a purchase/);
  assert.match(live, /Not every server offers this/);
  assert.match(live, /has the live purchase setup, but not whether your account may buy/);
  // The buyer approves only their own side; fees are not promised to be small.
  assert.match(live, /You approve each buyer-side signature and transaction in your wallet\./);
  assert.match(live, /hold enough testnet DEM for the price and transaction fees\./);
  assert.doesNotMatch(live, /each step|small fee/);
  assert.match(live, /may admit only its own test accounts/);
  assert.match(live, /Testnet DEM only; never mainnet/);
  assert.doesNotMatch(live, /href=/);
  assert.match(html, /completion audit pending/);
});

test('the walkthrough covers five stages in order and an honest illustrative receipt', () => {
  const html = page('walkthrough.html');
  assert.deepEqual([...html.matchAll(/<section class="stage" id="([a-z]+)"/g)].map((m) => m[1]), ['identify', 'vet', 'negotiate', 'settle', 'verify']);
  const [receipt] = between(html, '<section class="example" data-example="receipt"', '</section>');
  const rows = [...receipt.split('<details>')[0].matchAll(/<tr><th scope="row">([A-Za-z]+)<\/th><td class="status-[a-z]+">([a-z]+)<\/td>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rows, [['Identify', 'done'], ['Vet', 'pending'], ['Negotiate', 'done'], ['Settle', 'observed'], ['Verify', 'pending']]);
  assert.match(receipt, /Report available; completion audit pending/);
  const slots = [...receipt.split('<details>')[1].matchAll(/<tr><th scope="row">([^<]+)<\/th><td>(recorded|missing)<\/td>/g)];
  assert.equal(slots.length, 11);
  assert.deepEqual(slots.filter((m) => m[2] === 'missing').map((m) => m[1]), ['Delivery evidence', "Buyer's completion copy", "Seller's completion copy"]);
  for (const [, ref] of receipt.matchAll(/<td class="ref">([^<]+)<\/td>/g)) assert.match(ref, /^EXAMPLE-[A-Z-]+$/);
  for (const stop of ['The Listing changed', "The seller's commitment doesn't read back", 'The Agreement binds a different recipient or amount', "A transaction doesn't match", 'A response is lost']) assert.ok(html.includes(stop), stop);
  assert.match(html, /never asks you to pay a second time/);
  // Earlier records are not undone, and no check claims nothing was signed.
  assert.match(html, /stops the payment transaction before it is handed to your wallet, or refuses to count a transaction that doesn't match/);
  assert.match(html, /the payment transaction is not handed to your wallet; prepare a new purchase/);
  assert.doesNotMatch(html, /approve the payment/);
  assert.match(html, /the Agreement you signed and its testnet record, and the seller's commitment are not undone/);
  assert.equal(html.match(/the payment stays held/g)?.length, 2);
  assert.doesNotMatch(html, /nothing is signed or sent|before anything is signed/);
  assert.match(html, /does not read them back itself/);
});

// Verify is deferred in the live testnet flow only (the simulated dacs-pay-dem
// profile completes DACS-5 copies), and the quickstart names the entry points
// that make livePurchaseComposed true without claiming any is the only one.
test('the pages and the quickstart scope Verify to the live flow and name the live entry points', () => {
  const index = page('index.html'), walk = page('walkthrough.html');
  assert.ok(index.includes('The live testnet flow does not implement the last stage, Verify, yet, so a live purchase here ends with the report available and the completion audit pending.'));
  assert.ok(walk.includes("Here is what each stage does in this app's live testnet flow today."));
  assert.ok(walk.includes('<dt>In this live testnet flow today</dt>\n      <dd>Not implemented in this flow yet. A live purchase ends with the report available and the completion audit pending, and the app says so rather than calling the purchase complete.</dd>'));
  assert.ok(walk.includes("The built-in operator's report is configured demonstration content plus a purchase-specific settlement reference."));
  for (const html of [index, walk]) assert.doesNotMatch(html, /not implemented in this app|fixed demonstration text/i);
  const quickstart = readFileSync(new URL('../docs/SHOWCASE-QUICKSTART.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  for (const statement of [
    'The built-in live-testnet operator (`src/devnet-demo/operator.mjs`), started by `scripts/devnet-demo-compose.mjs`, is the shipped composition that offers it in ChatGPT. Equivalent programmatic compositions supplying the same reviewed capabilities can offer it too',
    '`scripts/devnet-demo-compose.mjs` is the built-in ChatGPT entry point that makes this true. The source-owned CLI `scripts/devnet-demo-purchase.mjs` builds the same live composition for a CLI-driven purchase, and equivalent programmatic compositions can also do so. The packaged entry point `bin/dacs-chatgpt-plugin.mjs` never does.',
    '`livePurchaseComposed` says what the app was built with, nothing more.',
    'The live testnet flow does not implement Verify (DACS-5) yet, so a live purchase ends with "Report available; completion audit pending".',
    "The built-in operator's report is configured demonstration content plus a purchase-specific settlement reference.",
  ]) assert.ok(quickstart.includes(statement), statement);
  assert.doesNotMatch(quickstart, /\bonly (shipped )?(entry point|composition)\b|is the only shipped|Verify \(DACS-5\) is not implemented,/);
  for (const file of ['src/devnet-demo/operator.mjs', 'scripts/devnet-demo-compose.mjs', 'scripts/devnet-demo-purchase.mjs', 'bin/dacs-chatgpt-plugin.mjs']) assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), file);
});

test('beyond fixed price keeps Standard, SDK and app support in separate columns', () => {
  const html = page('beyond-fixed-price.html');
  const [head] = between(html, '<thead>', '</thead>');
  assert.deepEqual([...head.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map((m) => m[1]), ['Item', 'DACS Standard (draft)', 'SDK build in this app', 'This app']);
  const rows = [...html.matchAll(/<tr data-row="([a-z0-9-]+)">(.*?)<\/tr>/g)].map(([, id, cells]) => [id, [...cells.matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/g)].map((m) => m[1])]);
  assert.deepEqual(rows.map(([id]) => id), ['fixed-price', 'rfq', 'sealed-envelope', 'pay-dem', 'pay-evm-erc20', 'pay-x402', 'completion-bundle']);
  for (const [id, cells] of rows) {
    assert.equal(cells.length, 4, id);
    assert.match(cells[1], /^Defined \(DACS-[345]/, `${id} standard column`);
  }
  assert.deepEqual(rows.filter(([, cells]) => cells[3].startsWith('Only on servers set up for live purchases')).map(([id]) => id), ['fixed-price', 'pay-dem']);
  assert.deepEqual(rows.filter(([, cells]) => cells[3].startsWith('Yes')), []);
  // v0.1 RFQ is bilateral; multi-quote RFQ is deferred (DACS-3 section 8.8).
  const [rfq] = between(html, '<section class="example" data-example="rfq"', '</section>');
  assert.match(rfq, /asks one translation agent/);
  assert.match(rfq, /runs a separate exchange with each/);
  assert.equal(between(html, '<section class="example"', '</section>').length, 3);
  assert.equal(html.match(/This app cannot run this example/g)?.length, 3);
});

test('the support table states exactly what the Standard, the SDK build and this app support', () => {
  const html = page('beyond-fixed-price.html');
  const rows = [...html.matchAll(/<tr data-row="([a-z0-9-]+)"><th scope="row">(.*?)<\/th><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/g)].map((m) => m.slice(1));
  assert.deepEqual(rows, [
    ['fixed-price', 'Fixed price', 'Defined (DACS-3 §8.4.1)', 'Yes', 'Only on servers set up for live purchases (Demos testnet)'],
    ['rfq', 'Request for quote (bounded offer and counter-offer)', 'Defined (DACS-3 §8.4.2)', 'Experimental profile only; no general RFQ module', 'No'],
    ['sealed-envelope', 'Sealed bids (demand and procurement)', 'Defined (DACS-3 §8.4.3–8.4.4)', 'Core: bid commitment, reveal checks and winner selection', 'No'],
    ['pay-dem', 'Native DEM payment', 'Defined (DACS-4, <code>pay-dem</code>)', 'Yes', 'Only on servers set up for live purchases; testnet DEM only'],
    ['pay-evm-erc20', 'ERC-20 tokens on EVM chains', 'Defined (DACS-4, <code>pay-evm-erc20</code>)', 'Yes', 'No'],
    ['pay-x402', 'x402 (HTTP 402 payments)', 'Defined (DACS-4, <code>pay-x402</code>)', 'Yes', 'No'],
    ['completion-bundle', 'Completion bundle (Verify)', 'Defined (DACS-5)', 'Bundle finalisation helpers', 'Not in live purchases yet: completion audit pending'],
  ]);
  assert.equal((html.match(/<tr data-row=/g) ?? []).length, rows.length, 'no other support rows');
});

test('the starter choices: walkthrough never transacts; live only where live purchase is composed', () => {
  const [walk, off] = showcaseChoices({ publicOrigin: 'https://plugin.example', livePurchase: false });
  assert.deepEqual(walk, { id: 'walkthrough', title: 'Walk through a purchase (read-only)', realTransactions: false, url: 'https://plugin.example/portal/showcase/', startWith: [], needs: [], note: 'Illustrative pages: they cannot sign, pay or buy, and their examples are not real transactions.' });
  assert.deepEqual(off, { id: 'live-testnet-purchase', title: 'Make a live testnet purchase', realTransactions: false, url: null, startWith: [], needs: [], note: 'Live testnet purchases are not set up on this server.' });
  const [, on] = showcaseChoices({ publicOrigin: 'https://plugin.example', livePurchase: true });
  assert.deepEqual(on, {
    id: 'live-testnet-purchase', title: 'Make a live testnet purchase', realTransactions: true, url: null,
    startWith: ['search_agents', 'get_listing', 'prepare_purchase'],
    needs: ['sign in to the DACS app', 'a wallet set up in the DACS portal', 'testnet DEM for the price and transaction fees'],
    note: "This server has the live testnet purchase setup: real Demos testnet transactions, testnet DEM only, and the user approves each buyer-side signature and transaction in their wallet. The operator controls whether its seller is running and which accounts may buy, and may admit only its own test accounts; a purchase can also wait for the seller's approval. This tool cannot tell whether this user can buy.",
  });
});

test('the starter module imports only zod and reaches nothing outside its arguments', () => {
  const source = readFileSync(new URL('../src/mcp/showcase-start.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]), ['zod/v4']);
  assert.equal(source.match(/\bimport\b/g)?.length, 1);
  assert.doesNotMatch(source, /\brequire\b|\bprocess\b|globalThis|\bfetch\b|\beval\b|Function\(|\.db\b|services/);
});

test('switched off: no pages and no starter tool', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  for (const path of ['/portal/showcase/', '/portal/showcase/walkthrough.html', '/portal/showcase/showcase.css', '/portal/assets/showcase/index.html']) {
    const res = await fetch(`${h.origin}${path}`, { redirect: 'manual' });
    assert.equal(res.status, 404, path);
  }
  const client = await tools(h);
  t.after(() => client.close());
  const { tools: list } = await client.listTools();
  assert.ok(!list.some((tool) => tool.name === 'start_showcase'));
});

test('switched on: pages served with the portal headers; starter tool is public, read-only and leaves the database unchanged', async (t) => {
  const h = await startHarness({ env: { DACS_SHOWCASE_WALKTHROUGH: 'on' } });
  t.after(() => h.close());
  const HEADERS = ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'cache-control', 'cross-origin-opener-policy'];
  const portal = await fetch(`${h.origin}/portal/assets/index.html`);
  assert.equal(portal.status, 200);
  const expected = Object.fromEntries(HEADERS.map((name) => [name, portal.headers.get(name)]));
  for (const name of HEADERS) assert.ok(expected[name], name);
  const redirect = await fetch(`${h.origin}/portal/showcase`, { redirect: 'manual' });
  assert.ok([301, 302, 308].includes(redirect.status));
  assert.equal(new URL(redirect.headers.get('location'), h.origin).pathname, '/portal/showcase/');
  for (const [path, file, type] of [['/portal/showcase/', 'index.html', /^text\/html/], ...PAGES.map((p) => [`/portal/showcase/${p}`, p, /^text\/html/]), ['/portal/showcase/showcase.css', 'showcase.css', /^text\/css/]]) {
    const res = await fetch(`${h.origin}${path}`);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), type, path);
    assert.deepEqual(Object.fromEntries(HEADERS.map((name) => [name, res.headers.get(name)])), expected, path);
    assert.equal(await res.text(), page(file), path);
  }
  for (const path of ['/portal/showcase/missing.html', '/portal/showcase/%2e%2e/portal/index.html', '/portal/showcase/..%2fportal%2findex.html', '/portal/showcase/.hidden', '/portal/assets/showcase/index.html']) {
    const res = await fetch(`${h.origin}${path}`, { redirect: 'manual' });
    assert.ok([400, 403, 404].includes(res.status), `${path} ${res.status}`);
  }
  // Showcase misses reach the app's JSON 404, never Express's error page or a
  // redirect: unknown files, traversal and encoded variants, dotfiles, double
  // slashes, and any method other than GET and HEAD.
  const misses = [
    ...['/portal/showcase/missing.html', '/portal/showcase/%2e%2e/portal/index.html', '/portal/showcase/%252e%252e/portal/index.html', '/portal/showcase/.hidden', '/portal/showcase/%2ehidden',
      '/portal/showcase//example.com', '/portal/showcase//example.com/', '/portal/showcase/%2F%2Fexample.com', '/portal/showcase/%5Cexample.com', '/portal/showcase/%E0%A4%A', '/portal/showcase/index.html/'].map((path) => ['GET', path]),
    ...['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].flatMap((method) => [[method, '/portal/showcase/'], [method, '/portal/showcase/index.html']]),
  ];
  for (const [method, path] of misses) {
    const res = await fetch(`${h.origin}${path}`, { method, redirect: 'manual' });
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal(res.headers.get('location'), null, `${method} ${path}`);
    assert.deepEqual(await res.json(), { error: 'not_found' }, `${method} ${path}`);
  }
  for (const name of PAGES) {
    const res = await fetch(`${h.origin}/portal/showcase/${name}`, { method: 'HEAD' });
    assert.equal(res.status, 200, `HEAD ${name}`);
    assert.equal(res.headers.get('content-security-policy'), expected['content-security-policy'], `HEAD ${name}`);
  }

  const client = await tools(h);
  t.after(() => client.close());
  const { tools: list } = await client.listTools();
  const tool = list.find((x) => x.name === 'start_showcase');
  assert.ok(tool);
  assert.deepEqual(tool._meta?.securitySchemes, [{ type: 'noauth' }]);
  assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  // The description's disclaimers are exact: composition says nothing about the seller or the caller.
  assert.equal(tool.description, 'Use this when a first-time user wants to see what DACS does, or has no testnet DEM yet. Returns two explicit choices for the user to pick from: a read-only walkthrough page (illustrative, no purchase capability) or a live Demos testnet purchase. Present both; never present walkthrough examples as a real purchase or status. The top-level livePurchaseComposed says whether this server was built for live purchases, not whether its seller is running or this user can buy. Prepares, signs and sends nothing.');
  const before = dbSnapshot(h.app.db);
  const result = await client.callTool({ name: 'start_showcase', arguments: {} });
  assert.notEqual(result.isError, true);
  assert.deepEqual(dbSnapshot(h.app.db), before);
  const { choices } = result.structuredContent;
  assert.deepEqual(Object.keys(result.structuredContent), ['livePurchaseComposed', 'choices']);
  assert.equal(result.structuredContent.livePurchaseComposed, false, 'the default harness composes no live purchase');
  for (const c of choices) assert.equal('livePurchaseComposed' in c, false, 'the field describes the server, not a choice');
  assert.deepEqual(choices.map((c) => c.id), ['walkthrough', 'live-testnet-purchase']);
  assert.equal(choices[0].url, `${h.origin}/portal/showcase/`);
  assert.equal((await fetch(choices[0].url)).status, 200);
  // The text result carries both choices, each with its note.
  assert.deepEqual(result.content, [{ type: 'text', text: `Two choices. 1) Walk through a purchase (read-only): ${h.origin}/portal/showcase/ (${choices[0].note}) 2) Make a live testnet purchase: Live testnet purchases are not set up on this server.` }]);
});
