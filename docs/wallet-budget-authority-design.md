# SDK #301: backend direction for D1 review

Status: recommendation for steward/Hayk consideration, not D1 ratification, backend acceptance, implementation or deployment approval. This note does not amend the existing D1 digest. It accompanies the [existing decision worksheet](https://github.com/DACS-Agent-commerce/dacs-sdk/pull/301#issuecomment-5608486446).

## Recommended direction

Evaluate a small protected wallet-budget authority service backed by a separately operated PostgreSQL database. Keep it outside the agent host's backup/restore lifecycle. This is an architectural recommendation, not a claim that any existing deployment meets D1. Hosting provider, durable failover policy and operating owner remain to be named.

Agents receive access only to the budget service's narrow operations; they do not receive database administration, arbitrary table-write, lineage-provisioning or restore permissions. The service must enforce stable wallet/chain lineage, allowed accounting transitions and policy migration itself. Caller-supplied revision numbers, commitments or a capability label alone cannot establish authority.

The authoritative service retains complete immutable state candidates and the current revision/commitment. Atomically provision a lineage only through an authorized operation. Persist each candidate durably before comparing and advancing the exact previous authoritative revision. Return spending authority only after that transition is durably confirmed. On an uncertain response, reconcile the original operation identity and exact candidate; never infer unused budget or repeat payment to reconstruct accounting. This preserves D1's ordering rather than replacing it with a weaker remote hash file.

PostgreSQL provides serializable transactions and requires retry handling for serialization failures. That supports an implementation of the budget transition contract, but is not itself anti-rollback protection. A concrete design must bind retries to the original intent and keep payment effects outside transaction retry callbacks. [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

## Restore and failure boundary

An agent restore must not restore or replace the authoritative database. Service identity, lineage admission and endpoint changes must be controlled independently of restorable agent configuration. A missing lineage is nonauthorizing, not automatic first use.

Database restore, failover to a stale replica, account compromise and administrative replacement are separate risks. A PostgreSQL server on the same restorable VM is insufficient. Before accepting a provider, document which acknowledged writes survive its failover mode, how endpoint replacement is controlled, and how authority stays disabled after a restore until independent continuity evidence establishes the latest revision and unresolved obligations. If that cannot be established, remain nonauthorizing. Backups alone do not prove freshness.

Durability settings must be explicit and verified: asynchronous commit can acknowledge transactions before durable WAL persistence, so a default product label cannot supply D1's guarantee. [PostgreSQL WAL configuration](https://www.postgresql.org/docs/current/runtime-config-wal.html).

## Alternative if the team already operates AWS

DynamoDB is a candidate only if the design preserves D1's two-phase ordering: first conditionally create the immutable candidate and receive durable success; then conditionally advance the authoritative head from the exact prior revision and commitment. A single transaction that makes candidate and head visible together does not by itself demonstrate WA-D09. Unknown outcomes require reconciliation by durable operation identity. Restored or exported tables remain nonauthorizing until the exact candidate/head pair, lineage, revision, commitment and unresolved obligations are independently reconciled to the latest accepted authority; AWS documents that backups can capture only part of a recent transaction during propagation. Resource identity, IAM, endpoint selection, read consistency and failover topology remain review requirements. [DynamoDB transaction and restore behavior](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html).

A point-in-time restore creates a new table. That helps make restoration explicit, but does not prevent an operator or restorable configuration from selecting the restored table as authority. Its resource identity, permissions and read/transaction consistency must therefore be part of the provider review. [DynamoDB restore behavior](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/pointintimerecovery_restores.html).

## Concrete decision before implementation

The steward and Hayk should approve or amend the service boundary, then name the provider/topology and owner who can supply durability, authorization and restore evidence. Prefer an existing separately operated service if one can meet the contract; do not provision new infrastructure from this recommendation.

Acceptance remains WA-D01 through WA-D09 in D1: stable lineage, every-mutation revision, unavailable/stale authority refusal, concurrency, interrupted-commit recovery, migration/rekey continuity, funded-consumer capability enforcement, non-mutating doctor/status and durable-candidate-before-anchor ordering. Preserve signed DACS formats and separately resolve the existing operational notice compatibility item under WA-D07. No new Standard change is proposed.
