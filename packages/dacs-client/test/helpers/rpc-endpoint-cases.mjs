// The raw node RPC URLs a caller may configure, and the label and pin records they are judged under.
// The packed consumer test copies this file into its installed app, so it imports nothing.

/** The eight raw URLs: three canonical roots and five refusals (no trailing slash, path, query, plain-http path, credentials). */
export const RPC_URL_CASES = Object.freeze(['https://h', 'https://h/', 'https://h:8443/', 'http://h/', 'https://h/rpc', 'https://h/?x=1', 'http://h/rpc', 'http://user:pw@h/']);

/**
 * Returns the label and pin records each URL is judged under: the testnet label with the approved identity, and one
 * departure from it at a time. An omitted key is absent from its record, never present as undefined.
 */
export function pinContexts(approved, other) {
  return [
    { network: 'testnet', chainIdentity: approved },
    { network: 'testnet', chainIdentity: other },
    { network: 'testnet' },
    { network: 'mainnet', chainIdentity: approved },
    { network: 'demos-testnet', chainIdentity: approved },
    { chainIdentity: approved },
    {},
  ];
}

/** Returns what the wire's `canonicalNodeEndpoint` answers for a caller's record once only the testnet label passes its pin on. */
export function wireAnswer(canonicalNodeEndpoint, { rpcUrl, network, chainIdentity }) {
  return canonicalNodeEndpoint(rpcUrl, network === 'testnet' ? { chainIdentity } : {});
}
