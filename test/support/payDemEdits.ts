// The balance and nonce edits (`content.gcr_edits`) a Demos node records for a
// confirmed native send, in the shape of test/fixtures/demos-node2-records.json:
// the payer's removal of the amount, the payee's credit of it, a gas burn
// removed from the payer, and the nonce edit. A string amount is post-fork OS;
// a number amount is pre-fork DEM, and the gas burn follows the same unit.
export interface NativeSendEditInput {
  payer: string;
  payee: string;
  amount: string | number;
  /** Gas burn removed from the payer; defaults to 1 DEM in the amount's unit. */
  gas?: string | number;
}

export type NativeSendEdit = Record<string, unknown>;

export function nativeSendEdits(input: NativeSendEditInput): NativeSendEdit[] {
  const gas = input.gas ?? (typeof input.amount === "string" ? "1000000000" : 1);
  return [
    { type: "balance", operation: "remove", isRollback: false, account: input.payer, txhash: "", amount: input.amount },
    { type: "balance", operation: "add", isRollback: false, account: input.payee, txhash: "", amount: input.amount },
    { type: "balance", operation: "remove", isRollback: false, account: input.payer, txhash: "", amount: gas },
    { type: "nonce", operation: "add", isRollback: false, account: input.payer, txhash: "", amount: 1 },
  ];
}
