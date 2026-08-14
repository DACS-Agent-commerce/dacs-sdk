# Funded delivery-ready profiling

This report preserves a funded campaign run against historical PR #153 feature
head `d663f4518a8d220ab41f3d1efb3a9bf5eae59c0c`. It is evidence for review, not
a current-head latency claim or authorization to merge the supplier stack.

## Finish lines

- `delivery-ready`: payment is authenticated and final, seller intake passed,
  the signed content-bound deliverable is independently verifiable, and the
  remaining work has a durable restartable handoff.
- `commerce-complete`: settlement and delivery evidence are published and
  verified.
- `audit-complete`: both role-owned DACS-5 bundles are anchored and
  reconciled.

The delivery-ready timer includes listing discovery, the two session-bound
DACS-2 Vet records, signed agreement, pre-payment commitment, one x402
payment, seller payment intake, and the deliverable anchor. The reusable
Listing is published before the timer. The non-normative Standard #331
provenance write and DACS-5 closure stay outside the user-visible timer.

Every latency run reopens the finalizer's filesystem stores after
`delivery-ready`, publishes the retained signed evidence, and requires two
independent Base Sepolia RPCs to agree on the exact finalized nonce and
transfer. No background JavaScript promise owns finalization.

## Exact-head funded result

Ten successful isolated runs used fresh run IDs and one atomic USDC unit each:

| Run | Delivery-ready |
|---|---:|
| `crossrpc-02` | 74.606 s |
| `crossrpc-03` | 83.217 s |
| `crossrpc-04` | 58.347 s |
| `crossrpc-05` | 68.776 s |
| `crossrpc-06` | 60.262 s |
| `crossrpc-07` | 45.245 s |
| `crossrpc-09` | 52.011 s |
| `crossrpc-10` | 61.902 s |
| `crossrpc-11` | 49.269 s |
| `crossrpc-12` | 70.221 s |

Summary:

- mean: **62.386 s**;
- p50: **61.082 s** (acceptance: at most 70 s);
- nearest-rank p90: **74.606 s** (acceptance: at most 90 s);
- range: **45.245–83.217 s**;
- cross-RPC agreement: **10/10** successful runs;
- duplicate payment submissions: **0**;
- duplicate fulfilments: **0**;
- duplicate logical writes: **0**.

The latency gates pass for the successful sample.

## Fresh exhaustive recovery proof

A separate funded run on that historical feature head completed the default
exhaustive profile in **349.94 s** with all 12 assertions passing. It proved:

- authenticated x402 settlement on both RPCs;
- recovery from the injected buyer post-payment chain-read loss;
- recovery from seller response-rendering loss using newly opened filesystem
  stores and a fresh seller runtime;
- exactly one application callback, delivery, evidence publication, and final
  receipt across process A and process B;
- settlement-evidence publication and verification;
- WAL-derived terminal phase-history projection;
- buyer and seller process-A/process-B bundle recovery; and
- final role-owned DACS-5 bundle verification.

The measured stages were Listing 17.532 s, Vet 14.938 s, agreement 38.399 s,
commitment 23.350 s (overlapped with agreement), settlement/recovery 47.433 s,
settlement publication 22.400 s, and bundle finalization 218.928 s.

## Retained safe failures

The campaign also retained failures instead of silently replacing them:

- `crossrpc-08` received the facilitator's explicit
  `invalid_exact_evm_transaction_failed` response before payment.
- `audit-recovery-crossrpc-01` received the same explicit response before
  payment.
- `audit-recovery-crossrpc-02` lost the facilitator call and reached the
  authenticated `expired-unused` terminal state.

For every failed authorization, both independent RPCs later agreed that the
exact nonce was expired and unused, no matching authorization event or
receipt existed, the buyer still owned the one unit, and no delivery ran.
These are safe failures and caused no payment or delivery. They remain relevant
to facilitator availability and should not be erased from the reliability
record, even though the subsequent fresh exhaustive run succeeded.

The strict campaign plan also asks for `audit-complete` after every one of the
ten latency samples. Those samples deliberately stopped after the restarted
evidence finalizer and cross-RPC proof, so they establish delivery-ready
performance and durable post-delivery evidence, not ten DACS-5 closures. The
fresh exhaustive run establishes one closure for that historical feature head.
Later #153 repairs have separate funded evidence in #153; this report does not
silently relabel the old ten-run sample as current-head data. Keep the PR draft
if ten independent full closures remains a release gate.

## Running the guarded profile

The complete funded environment and `LIVE_E2E_CONFIRM=1` are required. Use a
fresh `LIVE_E2E_RUN_ID`; set `PAY_RPC_SECONDARY` to an independent Base
Sepolia RPC for cross-RPC proof.

```sh
LIVE_E2E_PROFILE=production-latency \
LIVE_E2E_DELIVERY_ONLY=1 \
PAY_RPC_SECONDARY=https://independent.example \
npx vitest run test/integration/funded-two-agent.e2e.test.ts
```

For repository-local exploratory analysis, concatenate retained logs and run:

```sh
node scripts/summarize-funded-timing.mjs < funded-runs.log
```

This legacy text summarizer is heuristic: it counts markers globally and does
not establish per-run provenance. It must not be used for a release-grade
latency claim without the structured, per-run records described in the PR
review. It is repository tooling and is not included in the published package.

Omit `LIVE_E2E_PROFILE` and `LIVE_E2E_DELIVERY_ONLY` for the exhaustive
response-loss, buyer reconciliation, cold seller restart, settlement
publication, two-sided bundle, and audit-projection profile.

Timing output contains operation names and durations only. It intentionally
omits credentials, payment headers, wallet identities, complete addresses,
transaction identifiers, artifact bodies, and private endpoint values.
