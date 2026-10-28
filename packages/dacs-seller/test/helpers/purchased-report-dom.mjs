import { contentHash } from '@kynesyslabs/dacs';

const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// The status view's purchase card (main's status-v5) writes the amount as text
// into the <span data-amount></span> of its markup: as in a browser,
// querySelector finds that span and innerHTML shows its text.
const AMOUNT_SLOT = '<span data-amount></span>';
const amounts = new WeakMap();
export class ReportNode {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.value = ''; this.html = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.value = ''; this.html = ''; this.children = nodes; amounts.delete(this); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener() {}
  querySelector(selector) {
    if (selector !== '[data-amount]' || !this.html.includes(AMOUNT_SLOT)) return null;
    if (!amounts.has(this)) amounts.set(this, new ReportNode('span'));
    return amounts.get(this);
  }
  set textContent(value) { this.replaceChildren(); this.value = String(value); }
  get textContent() { return this.value + this.children.map((n) => n.textContent ?? n).join(''); }
  set innerHTML(value) { this.replaceChildren(); this.html = String(value); }
  get innerHTML() {
    const amount = amounts.get(this);
    return (amount ? this.html.replace(AMOUNT_SLOT, () => `<span data-amount>${amount.innerHTML}</span>`) : this.html) + esc(this.value) + this.children.map((n) => n.outerHTML ?? esc(n)).join('');
  }
  get outerHTML() { return this.tag === '#text' ? esc(this.value) : `<${this.tag}${this.className ? ` class="${esc(this.className)}"` : ''}>${this.innerHTML}</${this.tag}>`; }
}
export function reportDocument() {
  const app = new ReportNode('div');
  return { app, document: { createElement: (tag) => new ReportNode(tag), createTextNode: (value) => Object.assign(new ReportNode('#text'), { value }), getElementById: () => app } };
}
export function reportProjection() {
  return rehash({ stage: 'delivery-ready', sellerAgent: 'TEST seller', substrate: 'TEST demo',
    layers: { service: 'test-report-delivered-and-verified', completedCopies: 'not-exchanged' },
    delivery: { status: 'delivery-ready', substrate: 'source-native-one-node-delivery', evidencePublication: 'pending-readback',
      evidenceHold: { reason: 'TEST evidence awaiting readback' },
      deliverableRef: { anchor: { kind: 'storage-program', locator: 'dacs4:deliverable:TEST-job:3' }, contentHash: null },
      payloadHash: null, anchorReceipt: { nativeAddress: `stor-${'b'.repeat(40)}`, substrate: 'demos', writer: 'TEST seller' },
      report: { kind: 'dacs-chatgpt-plugin/devnet-purchased-report', title: 'TEST purchased report', producer: 'TEST producer', content: { mediaType: 'text/plain; charset=utf-8', text: 'TEST signed report text\nSecond line.' } } } });
}
// After a test edits the report: the Deliverable hash a real delivery readback would carry.
export function rehash(p) {
  p.delivery.payloadHash = p.delivery.deliverableRef.contentHash = contentHash(p.delivery.report);
  return p;
}
