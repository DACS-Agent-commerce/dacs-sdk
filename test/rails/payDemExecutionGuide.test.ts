import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// docs/pay-dem-execution.md ships in the npm package and tells custom native
// clients, reconcilers and observers when they may attest
// `execution: "executed"`. These checks keep its safety rules from drifting.

function text(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\s+/g, " ");
}

const guide = text("../../docs/pay-dem-execution.md");

type Edit = Readonly<{
  type: string;
  operation: string;
  account: string;
  amount: string | number;
}>;

describe("the pay-dem execution guide", () => {
  it("ships in the npm package", async () => {
    const packageJson = await import("../../package.json", { with: { type: "json" } });
    expect(packageJson.default.files).toContain("docs/pay-dem-execution.md");
  });

  it("does not treat a confirmed record without the transfer's edits as execution", () => {
    // The node applies a native transaction with absent or empty gcr_edits as
    // a successful no-op and still records it `confirmed`.
    expect(guide).toContain(
      "The node applies a native transaction whose `gcr_edits` are absent or empty as a successful no-op",
    );
    expect(guide).toContain(
      "a `balance` `remove` of the amount from the payer and a `balance` `add` of the amount to the payee",
    );
    expect(guide).toContain(
      "A `confirmed` record with absent, empty or other edits moved no value, and the rail must leave `execution` out.",
    );
    expect(guide).toContain("with `gcr_edits` that debit the payer and credit the payee that amount");
    expect(guide).toContain("must check the record's `gcr_edits` as described for custom clients");
    for (const path of ["../../README.md", "../../docs/funded-e2e-safety.md"]) {
      expect(text(path)).toMatch(/`confirmed` record with absent or empty (`gcr_edits`|edits)/);
    }
  });

  it("describes edits that node2's confirmed native send actually carries", () => {
    const fixture = JSON.parse(readFileSync(
      new URL("../fixtures/demos-node2-records.json", import.meta.url),
      "utf8",
    )) as { getTxByHash: Record<string, { response: Record<string, unknown> }> };
    const confirmed = Object.values(fixture.getTxByHash)
      .map((envelope) => envelope.response)
      .filter((record) => record.status === "confirmed");
    expect(confirmed).toHaveLength(1);
    const content = confirmed[0]!.content as {
      from: string;
      to: string;
      amount: number;
      gcr_edits: Edit[];
    };
    const amount = String(content.amount);
    const has = (operation: string, account: string) =>
      content.gcr_edits.some((edit) =>
        edit.type === "balance" && edit.operation === operation &&
        edit.account === account && String(edit.amount) === amount);
    expect(has("remove", content.from)).toBe(true);
    expect(has("add", content.to)).toBe(true);
  });

  it("does not fix the size of an unmerged Standard corpus", () => {
    expect(guide).not.toMatch(/\b\d+-vector corpus\b/);
    expect(guide).toContain(
      "run every vector of the `pay-dem-execution-v0.1` and `settlement-finality-verification` sets at that revision, each identified by its `count` and `hash` there",
    );
  });

  it("lists the indeterminate result's missing errorClass as a deviation", () => {
    expect(guide).toContain("**Indeterminate result class.**");
    expect(guide).toContain("An indeterminate pay-dem result is `ok: false` with no `errorClass`.");
  });

  it("names every retried transport error and the summed waits", () => {
    for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"]) {
      expect(guide).toContain(`\`${code}\``);
    }
    expect(guide).toContain("when its waits and the requests' own time add up to 5 seconds or more");
    expect(guide).not.toContain("only in these cases");
  });
});
