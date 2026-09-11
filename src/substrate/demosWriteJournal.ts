/** Durable authority for Demos wallet nonce and write recovery. */

export const DEMOS_WRITE_JOURNAL_VERSION = 1;

export type DemosWriteKind = "mutable" | "immutable" | "native-transfer";
export type DemosWriteOperation = "create" | "update";
export type DemosWriteJournalOperation = DemosWriteOperation | "transfer";

export type DemosWriteStage =
  | "prepared"
  | "signed"
  | "broadcast-intent"
  | "canonical-confirmed"
  | "canonical-failed"
  | "native-visible"
  | "index-visible";

export interface DemosWriteJournalKey {
  /** Hash of the chain's genesis block, obtained from the connected node. */
  chainIdentity: string;
  /** Lower-case Demos wallet address. */
  wallet: string;
}

export interface DemosNativeReadObservation {
  owner: string;
  programName: string;
  valueHash: string;
  metadataHash?: string;
  observedAt: number;
}

export interface DemosIndexObservation {
  address: string;
  observedAt: number;
}

export interface DemosNativeTransferJournalBinding {
  payer: string;
  payee: string;
  amountOs: string;
  denomination: "os" | "dem";
  network: string;
  maxTotalDebitOs?: string;
  settlementKey?: string;
}

/** Per-write and aggregate fee reservation retained before an anchor broadcast. */
export interface DemosWriteFeeBudgetReservation {
  budgetId: string;
  maximumPerWriteFeeOs: string;
  maximumTotalFeeOs: string;
  reservedFeeOs: string;
}

export interface DemosWriteJournalRecord {
  writeId: string;
  generation: number;
  kind: DemosWriteKind;
  operation: DemosWriteJournalOperation;
  stage: DemosWriteStage;
  logicalName: string;
  programName: string;
  owner: string;
  nativeAddress: string;
  valueHash: string;
  metadataHash?: string;
  nonce: number;
  txRef?: string;
  /** Canonical portable encoding of the signed Demos transaction envelope. */
  signedTransaction?: string;
  signedTransactionHash?: string;
  blockNumber?: number;
  blockHash?: string;
  blockTimestamp?: number;
  finalityProof?: string;
  finalityProofHash?: string;
  nativeRead?: DemosNativeReadObservation;
  indexRead?: DemosIndexObservation;
  /** Present only for a wallet-serialized native DEM transfer. */
  transfer?: DemosNativeTransferJournalBinding;
  /** Present when this broadcast consumes an explicit retained fee budget. */
  feeBudget?: DemosWriteFeeBudgetReservation;
  updatedAt: number;
}

export interface DemosWriteJournalSnapshot extends DemosWriteJournalKey {
  version: typeof DEMOS_WRITE_JOURNAL_VERSION;
  generation: number;
  records: readonly DemosWriteJournalRecord[];
}

/**
 * Exclusive, generation-fenced wallet lease. Implementations must serialize
 * leases across processes that share the same journal backend.
 */
export interface DemosWriteJournalLease {
  readonly key: Readonly<DemosWriteJournalKey>;
  readonly generation: number;
  readonly snapshot: Readonly<DemosWriteJournalSnapshot>;
  /** Replace or append one record while retaining the wallet fence. */
  put(record: DemosWriteJournalRecord): Promise<void>;
  /** Fail if another generation has superseded this worker. */
  assertCurrent(): Promise<void>;
  /** Idempotently release the exclusive wallet lease. */
  release(): Promise<void>;
}

export interface DemosWriteJournal {
  acquire(key: DemosWriteJournalKey): Promise<DemosWriteJournalLease>;
}

function journalKey(key: DemosWriteJournalKey): string {
  return `${key.chainIdentity}\0${key.wallet}`;
}

function cloneRecord(record: DemosWriteJournalRecord): DemosWriteJournalRecord {
  return structuredClone(record);
}

/** In-memory implementation for deterministic tests and ephemeral tooling. */
export function createInMemoryDemosWriteJournal(): DemosWriteJournal {
  const states = new Map<string, DemosWriteJournalSnapshot>();
  const tails = new Map<string, Promise<void>>();

  return {
    async acquire(input) {
      const key = Object.freeze({
        chainIdentity: input.chainIdentity,
        wallet: input.wallet,
      });
      const encoded = journalKey(key);
      const previous = tails.get(encoded) ?? Promise.resolve();
      let unlock!: () => void;
      const held = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const tail = previous.catch(() => undefined).then(() => held);
      tails.set(encoded, tail);
      await previous.catch(() => undefined);

      const prior = states.get(encoded);
      const generation = (prior?.generation ?? 0) + 1;
      let current: DemosWriteJournalSnapshot = {
        version: DEMOS_WRITE_JOURNAL_VERSION,
        ...key,
        generation,
        records: (prior?.records ?? []).map(cloneRecord),
      };
      states.set(encoded, current);
      let released = false;
      let putTail = Promise.resolve();

      const assertCurrent = async (): Promise<void> => {
        if (released || states.get(encoded)?.generation !== generation) {
          throw new Error(
            `Demos write journal fence ${generation} is no longer current`,
          );
        }
      };

      return {
        key,
        generation,
        get snapshot() {
          return structuredClone(current);
        },
        async put(record) {
          const operation = putTail.then(async () => {
            await assertCurrent();
            if (record.generation !== generation) {
              throw new Error(
                `Demos write record generation ${record.generation} does not match lease ${generation}`,
              );
            }
            const records = current.records
              .filter((candidate) => candidate.writeId !== record.writeId)
              .map(cloneRecord);
            records.push(cloneRecord(record));
            current = { ...current, records };
            states.set(encoded, current);
          });
          putTail = operation.catch(() => undefined);
          await operation;
        },
        assertCurrent,
        async release() {
          if (released) return;
          await putTail;
          released = true;
          unlock();
          if (tails.get(encoded) === tail) {
            void tail.finally(() => {
              if (tails.get(encoded) === tail) tails.delete(encoded);
            });
          }
        },
      };
    },
  };
}
