// The installed `./wallet/effect-history` entry: readers of the wallet's dispatch history, the native wallet lane key and the
// dispatch classifier. It exports no appender.
export { createEffectHistoryReader, withCheckedOperationHistory, nativeWalletLaneKey, isNativeWalletLaneKey } from './effect-history.mjs';
export { classifyDispatchHistory } from './native-dispatch-history.mjs';
