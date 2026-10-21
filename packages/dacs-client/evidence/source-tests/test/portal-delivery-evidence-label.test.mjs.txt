import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PURCHASED_REPORT_SCRIPT } from '../public/portal/purchased-report.mjs';
// portal.js imports the ledger renderer (main the source change); it renders nothing without a ledger.
import { renderShowcaseProgress } from '../public/portal/showcase-progress.mjs';
import { ReportNode, reportDocument, reportProjection } from './helpers/purchased-report-dom.mjs';

// The portal's layer labels and the purchase view that shows them, run from
// the shipped source against a minimal DOM.
const source=readFileSync(new URL('../public/portal/portal.js',import.meta.url),'utf8');
const slice=(from,to)=>{const start=source.indexOf(from),end=source.indexOf(to,start);assert.ok(start>=0&&end>start,from);return source.slice(start,end);};
class Node{constructor(tag){this.tag=tag;this.children=[];this.attributes={};}append(...items){this.children.push(...items);}setAttribute(k,v){this.attributes[k]=v;}addEventListener(){}
  get text(){return this.tag==='#text'?this.value:this.children.map(child=>child.text).join('');}}
const document={createElement:(tag)=>new Node(tag),createTextNode:(value)=>Object.assign(new Node('#text'),{value})};
const {LAYER_TEXT,deliveryEvidenceText,protocolNodes}=vm.runInNewContext(
  `${slice('const el = (tag','const log = (')}${slice('const details = (','// ---------------- wallet provider')}${slice('const LAYER_TEXT = {','async function purchaseFlow(')}; ({LAYER_TEXT,deliveryEvidenceText,protocolNodes})`,{Node,document});
// The rendered layer rows, as [label, text] pairs.
const layers=(p)=>{
  const box=protocolNodes(p).find(node=>node.attributes.id==='dacs-layers'),dl=box.children[0],pairs=[];
  for(let i=0;i<dl.children.length;i+=2)pairs.push([dl.children[i].text,dl.children[i+1].text]);
  return pairs;
};
const purchase=(delivery)=>({jobId:'01ARZ3NDEKTSV4RRFFQ69G5FAV',stage:delivery?.evidencePublication==='native-read-back'?'delivered':'delivery-ready',sellerAgent:'TEST-seller',substrate:'TEST',
  layers:{transfer:'not-observed',dacsPurchase:'payment-evidence-verified',service:'test-report-delivered-and-verified',completedCopies:'not-exchanged',humanAcceptance:'not-recorded'},...(delivery?{delivery}:{})});

test('"Delivered" claims only the verified report, and delivery evidence is shown separately for every server state',()=>{
  assert.doesNotMatch(LAYER_TEXT.service['test-report-delivered-and-verified'],/evidence/);
  // Every evidencePublication value the buyer's delivery readback can report (src/dacs/dem-delivery-consumer.mjs).
  const consumer=readFileSync(new URL('../src/dacs/dem-delivery-consumer.mjs',import.meta.url),'utf8');
  for(const value of ['native-read-back','pending-readback','held-evidence-rejected','deferred-to-explicit-sdk-finaliser']){
    assert.ok(consumer.includes(`'${value}'`),value);
    assert.notEqual(deliveryEvidenceText({evidencePublication:value}),'Unknown',value);
  }
  assert.match(deliveryEvidenceText({evidencePublication:'native-read-back'}),/^Verified/);
  const pending=deliveryEvidenceText({evidencePublication:'pending-readback',evidenceHold:{status:'pending',reason:'TEST no seller-owned demo CREATE intent'}});
  assert.match(pending,/^Not read back yet/);assert.match(pending,/TEST no seller-owned demo CREATE intent/);
  assert.match(deliveryEvidenceText({evidencePublication:'held-evidence-rejected',evidenceHold:{status:'rejected',reason:'differs'}}),/^Did not verify.*\(differs\)$/);
  assert.equal(deliveryEvidenceText({}),'Unknown');
});

test('the purchase view renders a Delivery evidence row after Service for each evidence state, and none before delivery',()=>{
  const cases=[
    [{evidencePublication:'native-read-back'},/^Verified/],
    [{evidencePublication:'pending-readback',evidenceHold:{status:'pending',reason:'TEST pending reason'}},/^Not read back yet.*\(TEST pending reason\)$/],
    [{evidencePublication:'held-evidence-rejected',evidenceHold:{status:'rejected',reason:'TEST differs'}},/^Did not verify.*\(TEST differs\)$/],
    [{evidencePublication:'deferred-to-explicit-sdk-finaliser'},/^Not published in this purchase profile$/]];
  for(const [delivery,expected] of cases){
    const rows=layers(purchase(delivery)),labels=rows.map(([label])=>label);
    assert.equal(labels.indexOf('Delivery evidence'),labels.indexOf('Service')+1,delivery.evidencePublication);
    assert.match(rows.find(([label])=>label==='Delivery evidence')[1],expected,delivery.evidencePublication);
    assert.equal(rows.find(([label])=>label==='Service')[1],'Delivered: the test report verifies on chain');
  }
  assert.deepEqual(layers(purchase(null)).map(([label])=>label),['Transfer','DACS purchase','Service','Completed bundle','Human acceptance']);
});


test('purchase page shows observation, pending confirmation and later delivery as text nodes', () => {
  const p = purchase({ evidencePublication: 'native-read-back' });
  p.deliveryDeadline = { deadlineIso: '2026-10-08T12:00:00.000Z', pastDueMs: 60001, overdue: { obligatedParty: 'seller' },
    message: "Demos can't prove a record is absent; <script>TEST</script> is plain text.", laterDelivery: { verifiedAt: 1 },
    deliveryMessage: 'A Deliverable was verified later. The earlier observation stays recorded.' };
  const nodes = protocolNodes(p), text = nodes.map(node => node.text).join(' ');
  assert.match(text, /Delivery deadline/); assert.match(text, /2026-10-08T12:00:00.000Z/); assert.match(text, /Deadline elapsed/); assert.match(text, /60 seconds/);
  const observation = nodes.find(node => node.attributes.id === 'delivery-deadline-observation');
  assert.equal(observation.text, p.deliveryDeadline.message); assert.equal(observation.children[0].tag, '#text');
  assert.equal(nodes.find(node => node.attributes.id === 'delivery-deadline-later-delivery').text, p.deliveryDeadline.deliveryMessage);
  p.deliveryDeadline = { deadlineIso: p.deliveryDeadline.deadlineIso, pastDueMs: 60001, message: 'Delivery is not confirmed yet; verify_deal checks the chain again.' };
  assert.match(protocolNodes(p).map(n => n.text).join(' '), /Delivery is not confirmed yet/);
  delete p.deliveryDeadline;
  assert.equal(protocolNodes(p).some(node => ['delivery-deadline-observation', 'delivery-deadline-later-delivery'].includes(node.attributes.id)), false);
});

function purchaseRenderer(enabled) {
  const dom = reportDocument();
  const start = source.indexOf('  const render = (view) => {', source.indexOf('async function purchaseFlow('));
  const end = source.indexOf('  async function pay(view)', start);
  const code = source.slice(start, end);
  // lastSellerIdentity: the source change's panel memory, declared just above the render slice (no identity in these views).
  const context = vm.createContext({ Node: ReportNode, document: dom.document, showcaseReportView: enabled, renderShowcaseProgress, lastSellerIdentity: undefined,
    simulatedProfile: false, sim: (s) => s, simLabel: (s) => s, simulatedBanner: () => null,
    compact: (...nodes) => nodes.filter(Boolean), termsRows: () => [], flow: (...nodes) => dom.app.replaceChildren(...nodes),
    modeText: (s) => s ?? 'TEST mode', action: () => new ReportNode('button'), recheckAction: () => new ReportNode('button') });
  vm.runInContext(`${slice('const el = (tag','const log = (')}${slice('const details = (','// ---------------- wallet provider')}${slice('const LAYER_TEXT = {','async function purchaseFlow(')}${PURCHASED_REPORT_SCRIPT}${code}`, context);
  return { ...dom, context, render(view) { context.view = view; vm.runInContext('render(view)', context); return dom.app.innerHTML; } };
}

test('portal purchase hooks show the report in receipt and status branches, with no output change while off', () => {
  const p = reportProjection(); p.layers = { ...purchase().layers, ...p.layers };
  const view = { status: 'settled_verified', terms: { protocol: {}, price: { amount: '1', amountOs: '1000000000' }, seller: { payee: 'TEST seller' }, buyer: { wallet: 'TEST buyer' }, listing: { listingId: 'TEST report', version: 1 } }, evidence: { protocol: p, receipt: { verifiedAt: 1 } } };
  const on = purchaseRenderer(true), off = purchaseRenderer(false);
  assert.match(on.render(view), /TEST signed report text/);
  assert.ok(on.render(view).includes(p.delivery.deliverableRef.contentHash));
  assert.match(on.render(view), /On-chain Deliverable/);
  // Seller text appears in the portal only inside the marked seller-content block, never as a heading.
  assert.match(on.render(view), /<section class="seller-content"><p class="seller-content-label">[^<]*untrusted seller-supplied content[^<]*<\/p>.*&quot;TEST purchased report&quot;.*TEST signed report text.*<\/section>/s);
  assert.doesNotMatch(on.render(view), /<h\d>[^<]*TEST purchased report/);
  assert.match(readFileSync(new URL('../public/portal/portal.css', import.meta.url), 'utf8'), /^\.seller-content \{[^}]*border/m, 'the portal marks the block visibly');
  assert.doesNotMatch(off.render(view), /Purchased report|TEST signed report text/);
  const legacy = off.render(view);
  assert.equal(off.render({ ...view, evidence: { ...view.evidence, protocol: { ...p, delivery: { ...p.delivery, report: { ...p.delivery.report, title: 'TEST other title' } } } } }), legacy);
  const status = { ...view, status: 'broadcast_reported', evidence: { protocol: p } };
  assert.match(on.render(status), /TEST signed report text/);
  const rejected = { ...status, evidence: { protocol: { ...p, stage: 'delivery-rejected', lastAttempt: { reason: 'TEST readback rejected' } } } };
  assert.doesNotMatch(on.render(rejected), /TEST signed report text|[0-9a-f]{64}/);
  assert.match(on.render(rejected), /TEST readback rejected/);
});

test('portal failed status reads clear the shown report for transport, HTTP and JSON errors; successful unavailable projection also clears it', async () => {
  const dom = reportDocument(), context = vm.createContext({ document: dom.document, showcaseReportView: true,
    $: () => dom.app, fetch: async () => { throw new Error('TEST transport unavailable'); } });
  vm.runInContext(`${PURCHASED_REPORT_SCRIPT}${slice('async function api(path, body)', '// Re-check DACS steps')}`, context);
  context.p = reportProjection();
  const fresh = () => vm.runInContext('renderPurchasedReport(document.getElementById("purchased-report"),p)', context);
  for (const fetch of [async () => { throw new Error('TEST transport unavailable'); }, async () => ({ ok: false, status: 503, json: async () => ({ message: 'TEST read unavailable' }) }), async () => ({ ok: true, json: async () => { throw new Error('TEST malformed JSON'); } })]) {
    context.fetch = fetch; fresh();
    await assert.rejects(vm.runInContext('api("/portal/api/purchase/TEST/view",{})', context));
    assert.doesNotMatch(dom.app.innerHTML, /TEST signed report text|[0-9a-f]{64}/);
    assert.match(dom.app.innerHTML, /Fresh purchase status read failed/);
  }
  for (const path of ['view', 'report', 'protocol/recheck']) {
    fresh(); context.fetch = async () => ({ ok: true, json: async () => ({ evidence: { protocol: { stage: 'payment-evidenced', lastAttempt: { reason: 'TEST fresh read absent' } } } }) });
    await vm.runInContext(`api('/portal/api/purchase/TEST/${path}',{})`, context);
    assert.doesNotMatch(dom.app.innerHTML, /TEST signed report text|[0-9a-f]{64}/);
    assert.match(dom.app.innerHTML, /TEST fresh read absent/);
  }
  fresh(); context.showcaseReportView = false; context.fetch = async () => { throw new Error('TEST off'); };
  await assert.rejects(vm.runInContext('api("/portal/api/purchase/TEST/view",{})', context));
  assert.match(dom.app.innerHTML, /TEST signed report text/, 'off switch retains the original API error behavior');
});
