# SDK #301: PostgreSQL wallet authority direction

Status: decided SDK implementation direction. This is not provider/topology
approval, deployment evidence, D1 ratification or a Standard change.

## SDK direction

Funded generated buyers use a narrow wallet-budget authority client. The
authority is a separately operated service backed by PostgreSQL and is outside
the generated actor host's backup/restore lifecycle. Hosting provider, durable
failover policy and operating owner remain to be named and approved.

Agents receive access only to the budget service's narrow operations; they do not receive database administration, arbitrary table-write, lineage-provisioning or restore permissions. The service must enforce stable wallet/chain lineage, allowed accounting transitions and policy migration itself. Caller-supplied revision numbers, commitments or a capability label alone cannot establish authority.

The authoritative service retains complete immutable state candidates and the current revision/commitment. A separately administered, rollback-resistant continuity witness owns a stable authority identity and epoch and provides linearizable compare-and-set over each wallet/chain lineage. Its authenticated Ed25519 receipts bind the lineage, exact predecessor and next `{revision,stateHash}`, candidate, role, operation, request hash, and nonce. PostgreSQL signatures stored only in PostgreSQL, an endpoint signature over an old head, and process-local revision watermarks are not continuity witnesses.

Atomically provision a lineage only through an authenticated operator operation. Persist each candidate durably, compare the selected database head with the witness current head, CAS the witness from the exact prior commitment to the exact candidate, apply that same candidate to PostgreSQL, and re-read both before returning authority. An ambiguous CAS is resolved only by exact candidate lookup. If the witness is ahead, unrelated operations remain nonauthorizing; only the original operation may finish its retained candidate. If restore lost that candidate, operator recovery is required. Never infer unused budget or repeat payment to reconstruct accounting.

PostgreSQL provides serializable transactions and requires retry handling for serialization failures. That supports an implementation of the budget transition contract, but is not itself anti-rollback protection. A concrete design must bind retries to the original intent and keep payment effects outside transaction retry callbacks. [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

## Restore and failure boundary

An agent restore must not restore or replace the authoritative database. Service identity, lineage admission and endpoint changes must be controlled independently of restorable agent configuration. A missing lineage is nonauthorizing, not automatic first use.

Database restore, failover to a stale replica, account compromise and administrative replacement are separate risks. PostgreSQL or a witness on the same restorable VM, backup domain, administrative restore domain, or asynchronously failed-over database is insufficient. Every read, mutation, current-effect fence, reconciliation, status response, and retained-response disclosure compares the selected PostgreSQL head with the witness. Any missing proof, stale replica, restored database, wrong authority/epoch/lineage, ambiguous lookup, or lost witnessed candidate is nonauthorizing. Provider acceptance must document acknowledged-write durability, the independent linearizable CAS and exact-operation lookup implementation, witness signing-key and namespace controls, endpoint replacement, recovery and monitoring. Backups and SDK tests alone do not prove those deployment properties.

Durability settings must be explicit and verified: asynchronous commit can acknowledge transactions before durable WAL persistence, so a default product label cannot supply D1's guarantee. [PostgreSQL WAL configuration](https://www.postgresql.org/docs/current/runtime-config-wal.html).

## Implemented boundary

The SDK supplies a PostgreSQL state-store/schema library, an external continuity
witness contract and deterministic offline reference witness, explicit operator-only
lineage provisioning and policy migration, and authenticated legacy/manual V1 plus
continuity-capable V2 `WalletSpendAuthorityV1` client/service protocols. The agent protocol exposes
only reserve/current/begin/settle/reconcile/inspect. PostgreSQL credentials,
lineage creation, migration, balance authentication, recovery authentication
and authoritative state transitions remain server-side. Missing or unavailable
lineage or witness proof is nonauthorizing. Generated funded wiring requires V2,
pins the witness public key, authority id and epoch through operator-controlled
configuration, and has no V1 or filesystem fallback. Each V2 proof is bound to
the operation id, request hash and a fresh client nonce.

The V2 service accepts only the opaque binding created by
`createDacsWalletSpendContinuityAuthorityV2()`. That factory constructs the
authority and current-head attester over the same PostgreSQL state store; an
independently paired authority and attester is rejected even if both report the
same revision. This makes the signed `stateHash`, rather than revision alone,
the commitment to the state that produced the authorization.

Lineage is the canonical wallet plus chain, never a policy id, actor path or
deployment. Every state mutation advances a revision. PostgreSQL server time is
used for windows and leases. Each changed state is committed first as an
immutable operation-bound candidate, selected by witness CAS, and then applied
with its receipt in a separate serializable, row-locked exact-head transaction.
A second witness read must match before returning. Inspect is read-only but
witness-fenced. The service operation
log binds an authenticated role, immutable operation id, and request hash so an
uncertain response is resolved without retrying a payment effect or assuming
budget is unused. The authenticated role and lineage resolver plus current
witness proof are re-run before any retained or reconstructed response is
disclosed. If a reserve head advance
commits but its acknowledgement or response-log write is lost, the PostgreSQL
operation store reconstructs only that exact role-bound reserved response from
the applied operation-bound candidate and verifies that the authoritative head
has not fallen behind it. The schema upgrade backfills a legacy candidate role
only where the operation log makes the binding unambiguous. It aborts if any
candidate remains unbound and makes the role column non-null before releasing
its exclusive migration locks. Candidate decoding accepts the strict legacy
raw-value format (where JSON null represented undefined) for candidates prepared
by the initial PR head. Serializable/deadlock conflicts retry only the database
transition, never a rail effect.

Generated backup/restore rejects legacy `wallet-spend*` actor paths and never
selects the authority database. The generated client receives only an HTTPS
endpoint, role-scoped token secret, and operator-managed witness identity pins;
explicit insecure HTTP is limited to loopback test/local use.

## Existing-agent upgrade

Do not freshly provision PostgreSQL for a wallet/chain that has an existing
filesystem/custom authority journal. An operator must first authenticate that
journal using its existing integrity mechanism, then call the operator-only
legacy-state import with the complete state and authenticated source identity
and evidence. Import validates the full state against the selected policy and
preserves its revision, totals, rolling events and unresolved reservations; it
refuses an existing lineage. Empty provisioning likewise requires authenticated
operator evidence that the wallet/chain is demonstrably new. Neither operation
is present on the agent HTTP API. Rotating role authentication does not change
lineage.

Fresh provisioning and authenticated legacy import retain a pending candidate
before initializing a previously absent witness lineage. An existing witness
head with a missing/restored database rejects fresh reprovisioning. Policy migration
advances the same witness and preserves all accounting. Authority-id, epoch,
witness-key or endpoint replacement is an authenticated operator migration,
never an inference from agent-restorable configuration.

Upgrading from the initial PR head is a quiesced migration, not a rolling
upgrade. Stop and retire every old authority process and database writer, run
`DACS_WALLET_SPEND_POSTGRES_CONTINUITY_ADOPTION_SCHEMA_V1`, authenticate the
complete current database snapshot, run
`adoptDacsWalletSpendPostgresContinuityV1()` against a previously absent witness
lineage, then apply `DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1`. Verify that no
candidate role or continuity identity is null and that PostgreSQL enforces the
writer-contract/non-null constraints, and only then start the new
service. A candidate that cannot be mapped to exactly one operation-log role
makes migration fail closed and requires explicit operator investigation and
resolution. Existing rows are not silently declared continuity-proven: schema
application raises `wallet-spend-continuity-migration-required` until the exact
head and retained candidates are bound to the selected authority id, epoch,
verification key and witness receipt. The lineage trigger requires writer
contract V2; non-null contract and identity columns fence old candidate and
operation writers. A generated V2 token must never be accepted by a V1 endpoint.

## Claim boundary

This PR governs generated service-payment debits and the rail network-fee debits
attached to those payments. Setup and funded-doctor disposable-wallet actions,
plus unrelated Demos storage/anchor fees, are outside this authority claim.
They retain their existing explicit consent and limit controls.

Acceptance remains WA-D01 through WA-D09 in D1: stable lineage, every-mutation revision, unavailable/stale authority refusal, concurrency, interrupted-commit recovery, migration/rekey continuity, funded-consumer capability enforcement, non-mutating doctor/status and durable-candidate-before-anchor ordering. Pay-DEM v1 keeps its original wire settlement shape; network-fee accounting remains an internal funded-authority requirement. No new Standard or signed wire-format change is proposed.
