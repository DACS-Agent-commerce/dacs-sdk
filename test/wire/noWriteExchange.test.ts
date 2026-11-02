// A host that answers from its own retained state (for example a completed outcome it re-signs) still authenticates the request, current authority
// and the exchange's bytes, without reserving or publishing anything in the journal.
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as wire from "../../src/wire/index.js";
import { journalDirectory } from "./requestJournalFixture.js";
import { NOW, P, world, type World } from "./reservationFixture.js";

const RESPONSE_BODY = '{"answer":"stored"}';
const OBSERVED = [P.payments, P.bundleRequest, P.proposals, P.state];

function journalWithFiles() {
  const directory = journalDirectory();
  return { journal: wire.openWireRequestJournal(directory), files: () => readdirSync(directory).sort() };
}
const checkFor = (x: World, path: string, journal: wire.WireRequestJournal, overrides: Partial<wire.RequestCheck> = {}) => ({ ...x.check(path), requestJournal: journal, ...overrides }) as wire.RequestCheck;

describe("no-write authorization and exchange", { timeout: 60_000 }, () => {
  it("CAP H-6/H-10 authorization and exchange helpers authenticate without reserving", async () => {
    const x = await world();
    const j = journalWithFiles();
    for (const path of OBSERVED) {
      expect(await wire.authorizeWireRequest(await x.open(path), checkFor(x, path, j.journal)), path).toEqual({ body: {}, readbackOnly: false });
      expect(await wire.authorizeWireRequest(await x.delegated(x.request(path)), checkFor(x, path, j.journal, { requireDelegation: true, artifacts: [x.artifact] })), `${path} delegated`)
        .toEqual({ body: {}, readbackOnly: false });
    }
    expect(j.files()).toEqual([]);
    // The exchange: the seller signs an answer to the authenticated request, and the buyer verifies request and answer bytes together; nothing is journaled.
    const request = x.request(P.payments);
    const answer = await wire.signWireResponse(request, 200, RESPONSE_BODY, { signer: x.seller, binding: x.binding, local: x.context.local, purchaseProfile: x.binding.profile, now: NOW });
    const received = { header: answer, status: 200, body: Buffer.from(RESPONSE_BODY), now: NOW, binding: x.binding, local: x.context.local };
    await expect(wire.verifyWireResponse(request, received)).resolves.toMatchObject({ principal: request.seller, audience: request.buyer, body: { answer: "stored" } });
    await expect(wire.verifyWireResponse(request, { ...received, body: Buffer.from('{"answer":"altered"}') })).rejects.toMatchObject({ code: "peer_response_mismatch" });
    expect(j.files()).toEqual([]);
  });

  it("CAP H-6/H-10 authorization refuses a wrong binding, altered authenticated bytes and a withdrawn authority with the original code and cause, writing nothing", async () => {
    const failure = new Error("authority withdrawn");
    let withdrawn = false;
    const x = await world({ readAuthority: (scope) => {
      if (withdrawn) throw failure;
      return { local: { ...scope.local }, chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity, provenance: "test-only-independent-authority/v1",
        sessionId: scope.sessionId, participants: scope.participants.map((claim) => ({ claim, profile: x.binding.profile, modules: wire.TESTNET_PROFILE_TP1.tuple })) };
    } });
    const other = await world();
    const j = journalWithFiles();
    for (const path of OBSERVED) {
      const opened = await x.open(path);
      await expect(wire.authorizeWireRequest(opened, checkFor(x, path, j.journal, { binding: other.binding, local: other.context.local })), `${path} binding`).rejects.toMatchObject({ code: "peer_request_unverified" });
      await expect(wire.authorizeWireRequest(opened, checkFor(x, path, j.journal, { rawBody: Buffer.from('{"a":1}') })), `${path} bytes`).rejects.toMatchObject({ code: "peer_request_mismatch" });
      await expect(wire.authorizeWireRequest(opened, checkFor(x, path, j.journal, { path: P.proposals === path ? P.commitments : P.proposals })), `${path} route`).rejects.toMatchObject({ code: "peer_request_mismatch" });
      withdrawn = true;
      await expect(wire.authorizeWireRequest(opened, checkFor(x, path, j.journal)), `${path} authority`).rejects.toBe(failure);
      withdrawn = false;
    }
    expect(j.files()).toEqual([]);
  });
});
