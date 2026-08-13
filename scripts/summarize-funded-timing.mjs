let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

const samples = [...input.matchAll(/funded-e2e-fast:delivery-ready-elapsed-ms:(\d+)/gu)]
  .map((match) => Number(match[1]) / 1_000)
  .filter(Number.isFinite)
  .sort((left, right) => left - right);

if (samples.length === 0) {
  process.stderr.write("No delivery-ready timing records found on stdin.\n");
  process.exitCode = 1;
} else {
  const round = (value) => Number(value.toFixed(3));
  const nearestRank = (quantile) =>
    samples[Math.max(0, Math.ceil(quantile * samples.length) - 1)];
  const midpoint = samples.length % 2 === 0
    ? (samples[samples.length / 2 - 1] + samples[samples.length / 2]) / 2
    : samples[Math.floor(samples.length / 2)];
  const count = (pattern) => [...input.matchAll(pattern)].length;
  const result = {
    deliveryReadySeconds: samples,
    sampleCount: samples.length,
    meanSeconds: round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
    p50Seconds: round(midpoint),
    p90Seconds: round(nearestRank(0.9)),
    minSeconds: samples[0],
    maxSeconds: samples.at(-1),
    completedRuns: count(/funded-e2e-fast:delivery-only-complete/gu),
    crossRpcAgreements: count(/funded-e2e-step:settlement-rpc-proof:all-2-of-2/gu),
    explicitFacilitatorFailures: count(
      /funded-e2e-step:facilitator-settle-outcome:failure-/gu,
    ),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
