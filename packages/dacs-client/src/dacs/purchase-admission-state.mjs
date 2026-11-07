// The one purchase hold (K6, K11): 'held' refuses every purchase action and
// 'testnet-tp1' admits the actions that pass the wrapper's per-call checks.
// Only a reviewed source change sets it; no option or environment variable can.
export const PURCHASE_ADMISSION = 'held';
