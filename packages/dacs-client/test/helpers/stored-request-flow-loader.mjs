// Replace unrelated coordinator/source boundaries only for the isolated protocol entry. The seller client
// reaches the flow's `connector` when one is set, and otherwise a stand-in that answers from the flow's `fetch`.
const source = name => new URL('../../src/dacs/' + name + '.mjs', import.meta.url).href;
const parent = source('protocol-purchases') + '?stored-flow';
const state = "globalThis[Symbol.for('TEST-stored-request-flows')]";
const fake = text => ({ url: 'data:text/javascript,' + encodeURIComponent(text), shortCircuit: true });
export function resolve(specifier, context, next) {
  if (context.parentURL !== parent) return next(specifier, context);
  for (const [name, replacement] of [
    ['purchase-protocol', `export const exchangeAgreement = input => ${state}.exchange(input);`],
    ['buyer-chain-readback', `export const createBuyerChainReadback = () => ${state}.chain;`],
    ['native-agreement-payment-consumer', `export const nativeAgreementPaymentConfig = () => ${state}.payment;`],
    ['native-payment-evidence-consumer', `export const nativePaymentEvidenceConfig = () => ${state}.evidence;`],
    ['seller-http', `import { createSellerHttpsClient as actual } from ${JSON.stringify(source('seller-http'))};
      import { connectorFromFetch } from ${JSON.stringify(new URL('./seller-https-rig.mjs', import.meta.url).href)};
      export const createSellerHttpsClient = options => {
        const client = actual({ ...options, connector: ${state}.connector ?? connectorFromFetch(${state}.fetch) });
        if (client.commitOnSignature) {
          const send = client.commitOnSignature;
          client.commitOnSignature = (...args) => (${state}.signature = send(...args));
        }
        return client;
      };`],
  ]) if (specifier.endsWith('/' + name + '.mjs')) return fake(`export * from ${JSON.stringify(source(name))}; ${replacement}`);
  return next(specifier, context);
}
