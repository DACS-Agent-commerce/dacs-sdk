import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';

// Minimal DOM and provider, no browser, RPC, persisted keys or wallet custody.
export class ProbeNode {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.listeners = new Map(); this.disabled = false; this.checked = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'value') this.value = String(v); }
  addEventListener(k, v) { this.listeners.set(k, v); }
  get value() { return this._value ?? (this.tag === 'select' ? this.children[0]?.value : '') ?? ''; }
  set value(v) { this._value = v; }
  get textContent() { return this._text ?? this.children.map((v) => v.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  async click() { if (!this.disabled) await this.listeners.get('click')?.(); }
  set innerHTML(_) { throw new Error('HTML rendering is forbidden'); }
  set outerHTML(_) { throw new Error('HTML rendering is forbidden'); }
}
export function installProbeDom() {
  const root = new ProbeNode('main');
  const old = { Node: globalThis.Node, document: globalThis.document };
  globalThis.Node = ProbeNode;
  globalThis.document = { getElementById: () => null, createElement: (tag) => new ProbeNode(tag), createTextNode: (value) => Object.assign(new ProbeNode('#text'), { textContent: value }) };
  const nodes = (node = root) => [node, ...node.children.flatMap((child) => nodes(child))];
  return { root, nodes, button: (label) => nodes().find((v) => v.tag === 'button' && v.textContent === label),
    restore() { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; } } };
}
export function fakeExtension({ wallet = createEphemeralWallet(), signMessage, signTransaction, connectResponse, accountsResponse, onRequest } = {}) {
  const calls = [];
  const provider = new Proxy({
    accounts: async () => { calls.push({ method: 'accounts' }); return accountsResponse ?? { code: 200, data: wallet.address }; },
    request: async (request) => {
      assert.ok(['connect', 'sign', 'signTransaction'].includes(request.method), `forbidden provider method ${request.method}`);
      calls.push(structuredClone(request));
      onRequest?.(request);
      if (request.method === 'connect') return connectResponse ?? { success: true, data: { address: wallet.address } };
      if (request.method === 'sign') return signMessage ? signMessage(request.params[0]) : { success: true, data: { type: 'ed25519', data: wallet.signHex(request.params[0]) } };
      return signTransaction ? signTransaction(request.params[0]) : { success: true, data: signedTransaction(wallet, request.params[0]) };
    },
  }, { get(target, key) { assert.ok(['request', 'accounts'].includes(key), `forbidden provider property ${String(key)}`); return target[key]; } });
  return { wallet, calls, provider };
}
export function signedTransaction(wallet, tx, mutate = () => {}) {
  const signed = structuredClone(tx); mutate(signed);
  signed.hash = createHash('sha256').update(JSON.stringify(signed.content)).digest('hex');
  signed.signature = { type: 'ed25519', data: wallet.signHex(signed.hash) };
  return signed;
}
export function fakeWindow(provider, { delay = 0, absent = false } = {}) {
  const win = new EventTarget(); win.requests = 0; win.posts = [];
  win.postMessage = (value, target) => { assert.deepEqual(value, { type: 'openpopup' }); assert.equal(target, '*'); win.posts.push(value); };
  win.announce = () => win.dispatchEvent(new CustomEvent('demosAnnounceProvider', { detail: { provider, info: { name: 'Demos Wallet' } } }));
  win.addEventListener('demosRequestProvider', () => { win.requests++; if (!absent) { if (delay) setTimeout(win.announce, delay); else win.announce(); } });
  return win;
}
