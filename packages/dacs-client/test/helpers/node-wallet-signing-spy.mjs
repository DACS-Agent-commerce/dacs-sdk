import { world } from './tp1-node-fixture.mjs';

/** Returns every error reachable from `error` through `cause` links, outermost first. */
export function causeChain(error) {
  const chain = [];
  for (let next = error; next instanceof Error && !chain.includes(next); next = next.cause) chain.push(next);
  return chain;
}

/**
 * Builds the scripted TP-1 world and spies on the Node wallet's signing seam: `innerSigns` lists
 * the message of every inner signature, `signsInsideSign` counts those made while the SDK signs a
 * transaction, and `nodeDemosPrototype` is the session's Demos subclass.
 */
export async function spiedWorld(t, options) {
  const { Demos } = await (await import('../../src/wallet/node-demos-loading.mjs')).loadNodeDemos();
  const connectWallet = Demos.prototype.connectWallet;
  let instance;
  t.mock.method(Demos.prototype, 'connectWallet', function spyConnectWallet(...args) {
    instance = this;
    return Reflect.apply(connectWallet, this, args);
  });
  const w = await world(t, options);
  // The session's crypto is a proxy over the SDK's crypto, so its prototype is the SDK's own.
  const sdkCrypto = Object.getPrototypeOf(instance.crypto);
  const innerSign = sdkCrypto.sign;
  w.innerSigns = [];
  t.mock.method(sdkCrypto, 'sign', function spyInnerSign(algorithm, message) {
    w.innerSigns.push(message);
    return Reflect.apply(innerSign, this, [algorithm, message]);
  });
  w.nodeDemosPrototype = Object.getPrototypeOf(instance);
  w.signsInsideSign = 0;
  const sign = w.nodeDemosPrototype.sign;
  t.mock.method(w.nodeDemosPrototype, 'sign', async function spySign(...args) {
    const before = w.innerSigns.length;
    try { return await Reflect.apply(sign, this, args); } finally { w.signsInsideSign += w.innerSigns.length - before; }
  });
  return w;
}
