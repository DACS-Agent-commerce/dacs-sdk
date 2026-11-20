// A scripted node's getNetworkInfo answer: the signature domain fork inactive, or active for `chainId`.
export const networkInfo = (active = false, chainId = 1) => ({
  forks: { signatureDomain: { activated: active, activationHeight: active ? 0 : null, currentHeight: 3 } },
  chainId,
});
