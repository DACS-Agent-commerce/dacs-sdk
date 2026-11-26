// The node RPC endpoint check on its own: this entry loads the wire's endpoint rule and nothing that holds a wallet, signs or sends.
export { assertNodeRpcEndpoint } from './dacs/network-binding.mjs';
