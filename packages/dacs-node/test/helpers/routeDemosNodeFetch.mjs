// Preload for child processes in tests: requests for the https Demos node name the tests configure go
// to the loopback stub named by DACS_TEST_DEMOS_NODE_TARGET. Keep the name in step with DEMOS_NODE_URL
// in walletSpendDemosNode.ts.
const DEMOS_NODE_URL = "https://demos-node.test/";
const target = process.env.DACS_TEST_DEMOS_NODE_TARGET;
const loopbackFetch = globalThis.fetch;

if (target !== undefined) {
  globalThis.fetch = (input, init) => loopbackFetch(String(input) === DEMOS_NODE_URL ? target : input, init);
}
