# SDK #301: PostgreSQL wallet authority direction

Status: decided SDK implementation direction. This is not provider/topology
approval, deployment evidence, D1 ratification or a Standard change.

## SDK direction

Funded generated buyers use a narrow wallet-budget authority client. The
authority is a separately operated service backed by PostgreSQL and is outside
the generated actor host's backup/restore lifecycle. Hosting provider, durable
failover policy and operating owner remain to be named and approved.

Agents receive access only to the budget service's narrow operations; they do not receive database administration, arbitrary table-write, lineage-provisioning or restore permissions. The service must enforce stable wallet/chain lineage, allowed accounting transitions and policy migration itself. Caller-supplied revision numbers, commitments or a capability label alone cannot establish authority.

The authoritative service retains complete immutable state candidates and the current revision/commitment. Atomically provision a lineage only through an authorized operation. Persist each candidate durably before comparing and advancing the exact previous authoritative revision. Return spending authority only after that transition is durably confirmed. On an uncertain response, reconcile the original operation identity and exact candidate; never infer unused budget or repeat payment to reconstruct accounting. This preserves D1's ordering rather than replacing it with a weaker remote hash file.

PostgreSQL provides serializable transactions and requires retry handling for serialization failures. That supports an implementation of the budget transition contract, but is not itself anti-rollback protection. A concrete design must bind retries to the original intent and keep payment effects outside transaction retry callbacks. [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

## Restore and failure boundary

An agent restore must not restore or replace the authoritative database. Service identity, lineage admission and endpoint changes must be controlled independently of restorable agent configuration. A missing lineage is nonauthorizing, not automatic first use.

Database restore, failover to a stale replica, account compromise and administrative replacement are separate risks. A PostgreSQL server on the same restorable VM is insufficient. Before accepting a provider, document which acknowledged writes survive its failover mode, how endpoint replacement is controlled, and how authority stays disabled after a restore until independent continuity evidence establishes the latest revision and unresolved obligations. If that cannot be established, remain nonauthorizing. Backups alone do not prove freshness.

Durability settings must be explicit and verified: asynchronous commit can acknowledge transactions before durable WAL persistence, so a default product label cannot supply D1's guarantee. [PostgreSQL WAL configuration](https://www.postgresql.org/docs/current/runtime-config-wal.html).

## Implemented boundary

The SDK supplies a PostgreSQL state-store/schema library, explicit operator-only
lineage provisioning and policy migration, and an authenticated remote
`WalletSpendAuthorityV1` client/service protocol. The agent protocol exposes
only reserve/current/begin/settle/reconcile/inspect. PostgreSQL credentials,
lineage creation, migration, balance authentication, recovery authentication
and authoritative state transitions remain server-side. Missing or unavailable
lineage is nonauthorizing. Generated funded wiring has no filesystem fallback.

Lineage is the canonical wallet plus chain, never a policy id, actor path or
deployment. Every state mutation advances a revision. PostgreSQL server time is
used for windows and leases. Each changed state is committed first as an
immutable operation-bound candidate and then applied in a separate serializable,
row-locked exact-head transaction. Inspect is read-only. The service operation
log binds an authenticated role, immutable operation id, and request hash so an
uncertain response is resolved without retrying a payment effect or assuming
budget is unused. The authenticated role and lineage resolver is re-run before
any retained or reconstructed response is disclosed. If a reserve head advance
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
endpoint and role-scoped token secret; explicit insecure HTTP is limited to
loopback test/local use.

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

Upgrading from the initial PR head is a quiesced migration, not a rolling
upgrade. Stop and retire every old authority process and database writer, run
the schema migration to completion, verify that no candidate role is null and
that PostgreSQL enforces the non-null constraint, and only then start the new
service. A candidate that cannot be mapped to exactly one operation-log role
makes migration fail closed and requires explicit operator investigation and
resolution. The exclusive operation/candidate migration locks plus the final
non-null constraint also ensure that a concurrent or accidentally restarted old
writer blocks and then fails rather than inserting a newly unbound candidate.

## Claim boundary

This PR governs generated service-payment debits and the rail network-fee debits
attached to those payments. Setup and funded-doctor disposable-wallet actions,
plus unrelated Demos storage/anchor fees, are outside this authority claim.
They retain their existing explicit consent and limit controls.

Acceptance remains WA-D01 through WA-D09 in D1: stable lineage, every-mutation revision, unavailable/stale authority refusal, concurrency, interrupted-commit recovery, migration/rekey continuity, funded-consumer capability enforcement, non-mutating doctor/status and durable-candidate-before-anchor ordering. Pay-DEM v1 keeps its original wire settlement shape; network-fee accounting remains an internal funded-authority requirement. No new Standard or signed wire-format change is proposed.
