import { afterEach, expect, it, vi } from "vitest";
vi.mock("../../src/wire/journalRestart.js", async (original) => ({ ...await original<typeof import("../../src/wire/journalRestart.js")>() }));
import * as restart from "../../src/wire/journalRestart.js";
import { openWireRequestJournal } from "../../src/wire/journal.js";
import { journalDirectory } from "./requestJournalFixture.js";

afterEach(() => vi.restoreAllMocks());
it("issues no journal handle until restart publication is qualified on every open", () => {
  const directory = journalDirectory(), cause = new Error("restart publication refused");
  const qualification = vi.spyOn(restart, "qualifyJournalRestart").mockImplementation(() => { throw cause; });
  expect(() => openWireRequestJournal(directory)).toThrow(cause);
  expect(qualification).toHaveBeenCalledExactlyOnceWith(directory);
  qualification.mockRestore();
  expect(openWireRequestJournal(directory)).toEqual({ directory });
  vi.spyOn(restart, "qualifyJournalRestart").mockImplementation(() => { throw cause; });
  expect(() => openWireRequestJournal(directory)).toThrow(cause);
});
