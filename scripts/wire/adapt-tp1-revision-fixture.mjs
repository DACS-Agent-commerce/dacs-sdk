#!/usr/bin/env node
// Derive the TP-1 revision adaptation of the plugin wire capture: every
// message of plugin-wire-82bf8c4.tp1-adapted with the profile revision "TP-1"
// added to its profile member (D6-5), re-signed. Neither input changes; the
// output is written exclusively, never over an existing file.
//
// The pre-revision adaptation's keys were generated at run time and discarded, so
// its messages cannot be re-signed under them. This script generates four new
// run-time keys and substitutes them one for one for that adaptation's buyer,
// seller, session and other keys (K-1), and records the substitution. For each
// signed message it first finds, by verification, which pre-revision key signed
// which bytes (the message under its own domain, or the fixed bytes "x" of the
// two shape negatives) and signs the same bytes of the new message with the
// substituted key; a signature copied from another message is copied from
// that message's substitute. A message it cannot attribute stops the script. Nothing
// else changes: the same cases, members, clock, Listing, job, bodies,
// synthetic identity record and local bindings. The original module is not
// run here, so the output records no original verdicts.
//
// Usage: node scripts/wire/adapt-tp1-revision-fixture.mjs --sdk-dist dist --fixtures test/wire/fixtures --out <file>
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { party, sha256Hex, writeJson } from "./fixture-helpers.mjs";

const ORIGINAL = { fixture: "plugin-wire-82bf8c4.original", sha256: "4be1730d77d9cfdc2d840b876dee6adc0d261b70a7a903add2515751c905121b" };
const ADAPTED = { fixture: "plugin-wire-82bf8c4.tp1-adapted", sha256: "89be02a422d5063281cab8e7b9e9f0dd27650a4da06dd66e6d4927161a988a35" };

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => (i % 2 === 0 ? [...pairs, [value.replace(/^--/, ""), all[i + 1]]] : pairs), []));
for (const key of ["sdk-dist", "fixtures", "out"]) if (!args[key]) throw new Error(`--${key} is required`);
const wire = await import(pathToFileURL(join(resolve(args["sdk-dist"]), "wire/index.js")).href);
const { canonicalize } = await import(pathToFileURL(join(resolve(args["sdk-dist"]), "canonical/index.js")).href);
const read = ({ fixture, sha256 }) => {
  const bytes = readFileSync(join(resolve(args.fixtures), `${fixture}.json`));
  if (sha256Hex(bytes) !== sha256) throw new Error(`${fixture} is not the pinned file ${sha256}`);
  return JSON.parse(bytes.toString("utf8"));
};
const original = read(ORIGINAL);
const adapted = read(ADAPTED);
if (canonicalize(original.parties) !== canonicalize(adapted.parties)) throw new Error("the pre-revision adaptation must use the capture's keys");

const D = wire.DACS_SELLER_HTTP_DOMAINS;
const ROLES = ["buyer", "seller", "session", "other"];
const fresh = Object.fromEntries(ROLES.map((role) => [role, party()]));
const rawOf = (claim) => claim.slice("did:demos:agent:".length);
const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const oldKeys = ROLES.map((role) => [role, createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(rawOf(adapted.parties[role]), "hex")]), format: "der", type: "spki" })]);

// K-1: each pre-revision claim and raw key, wherever a message names it, becomes its substitute.
const substitutes = new Map(ROLES.flatMap((role) => [[adapted.parties[role], fresh[role].claim], [rawOf(adapted.parties[role]), fresh[role].raw]]));
const substitute = (v) => (typeof v === "string" ? substitutes.get(v) ?? v
  : Array.isArray(v) ? v.map(substitute)
  : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x)])) : v);
// D6-5: the revision, after the identifier, in every profile member.
const revise = (p) => {
  const { id, ...rest } = p.profile;
  if ("revision" in rest) throw new Error("the pre-revision adaptation has no revision");
  return { ...p, profile: { id, revision: wire.TP1_PROFILE_REVISION, ...rest } };
};
const requestOf = (p) => revise(substitute(p));
// A response binds the canonical request: its new requestHash is the new request's.
const requestHashes = new Map();
for (const p of [adapted.valid.request.payload, adapted.valid.response.request, adapted.valid.delegatedRequest.payload, ...adapted.requestNegatives.map((c) => c.payload)]) {
  if (p) requestHashes.set(sha256Hex(canonicalize(p)), sha256Hex(canonicalize(requestOf(p))));
}
const payloadOf = (p) => {
  const next = requestOf(p);
  if (p.kind !== "response") return next;
  if (!requestHashes.has(p.requestHash)) throw new Error("a response binds a request this fixture does not hold");
  return { ...next, requestHash: requestHashes.get(p.requestHash) };
};

const signingText = (domain, p) => `${domain}${canonicalize(p)}`;
const decodeSignature = (s) => (s.startsWith("0x") ? Buffer.from(s.slice(2), "hex") : Buffer.from(s, "base64url"));
const encodeLike = (old, bytes) => (old.startsWith("0x") ? `0x${Buffer.from(bytes).toString("hex")}` : Buffer.from(bytes).toString("base64url"));
// Each pre-revision signature already re-signed, and its substitute.
const resigned = new Map();
/**
 * Re-sign: find which pre-revision key signed which bytes of `oldPayload`, and sign
 * the same bytes of `newPayload` with its substitute. A message that carried
 * the signature of another message (delegation/lifetime-over-24h carries the
 * valid delegation's) carries that message's substitute signature.
 */
function resign(oldPayload, newPayload, oldSignature, domain) {
  const candidates = [["message", signingText(domain, oldPayload), () => signingText(domain, newPayload)], ["fixed", "x", () => "x"]];
  for (const [, text, next] of candidates) {
    for (const [role, key] of oldKeys) {
      if (verify(null, Buffer.from(text, "utf8"), key, decodeSignature(oldSignature))) {
        const signature = encodeLike(oldSignature, fresh[role].signer.sign(Buffer.from(next(), "utf8")));
        if (resigned.has(oldSignature) && resigned.get(oldSignature) !== signature) throw new Error("one pre-revision signature, two substitutes");
        resigned.set(oldSignature, signature);
        return signature;
      }
    }
  }
  if (resigned.has(oldSignature)) return resigned.get(oldSignature);
  throw new Error(`no pre-revision key signed ${oldPayload?.kind ?? "this"} message`);
}
const delegationOf = ({ payload, signature }) => {
  const next = revise(substitute(payload));
  return { payload: next, signature: resign(payload, next, signature, D.delegation) };
};
const headerOf = (header) => {
  const envelope = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  if (Buffer.from(canonicalize(envelope)).toString("base64url") !== header) throw new Error("a pre-revision header is not canonical");
  const payload = payloadOf(envelope.payload);
  const next = { payload, signature: resign(envelope.payload, payload, envelope.signature, D[envelope.payload.kind]), ...(envelope.delegation ? { delegation: delegationOf(envelope.delegation) } : {}) };
  return { payload, header: Buffer.from(canonicalize(next)).toString("base64url") };
};
/** One case: the same members, re-made, without the original module's verdict. */
function caseOf(c) {
  const { originalVerdict: _verdict, ...rest } = c;
  const out = { ...rest };
  if (c.header) {
    const { payload, header } = headerOf(c.header);
    out.header = header;
    if ("payload" in c) out.payload = c.payload === null ? null : payload;
  }
  if (c.delegation) out.delegation = delegationOf(c.delegation);
  if (c.request) out.request = requestOf(c.request);
  if (c.signingBytes) out.signingBytes = signingText(D[out.payload.kind === "seller-session-delegation" ? "delegation" : out.payload.kind], out.payload);
  return out;
}
const valid = {
  request: caseOf(adapted.valid.request),
  response: caseOf(adapted.valid.response),
  delegation: (() => {
    const { originalVerdict: _verdict, ...rest } = adapted.valid.delegation;
    const d = delegationOf(rest);
    return { ...d, signingBytes: signingText(D.delegation, d.payload) };
  })(),
  delegatedRequest: caseOf(adapted.valid.delegatedRequest),
};
if (canonicalize(valid.response.request) !== canonicalize(valid.request.payload)) throw new Error("the response must bind the valid request");

const self = fileURLToPath(import.meta.url);
writeJson(resolve(args.out), {
  fixture: "plugin-wire-82bf8c4.tp1-revision-adapted",
  nature: "Second adaptation of plugin-wire-82bf8c4.original for testnet profile TP-1, derived from plugin-wire-82bf8c4.tp1-adapted. NOT verbatim: every message differs from the original by exactly the changes listed and the key substitution K-1, and was re-signed in one run.",
  publicationNote: "Metadata redacted for publication on 2026-10-18; the same cases were re-signed with fresh test keys by the pinned adapter.",
  derivedFrom: [ORIGINAL, ADAPTED],
  generator: { path: "scripts/wire/adapt-tp1-revision-fixture.mjs", sha256: sha256Hex(readFileSync(self)) },
  changes: [
    ...adapted.changes,
    { id: "D6-5", what: "new exact member `revision` (the profile revision, \"TP-1\") in every profile member: {id, revision, base, chainIdentity, pinVersion}", from: null, to: "profile.revision" },
  ],
  keySubstitution: {
    id: "K-1",
    what: "The pre-revision adaptation's run-time keys were discarded. Four new run-time keys replace them one for one; each message is signed by the substitute of the key that signed it there, over the same bytes of the new message, and a message that carried another message's signature carries that message's new signature. Every claim and session key in the messages is substituted the same way.",
    parties: Object.fromEntries(ROLES.map((role) => [role, { from: adapted.parties[role], to: fresh[role].claim }])),
  },
  syntheticIdentityRecord: adapted.syntheticIdentityRecord,
  keys: "Ed25519 keys were generated at run time and discarded; this file holds public keys and signatures only.",
  now: adapted.now,
  parties: Object.fromEntries(ROLES.map((role) => [role, fresh[role].claim])),
  job: adapted.job,
  localBindings: adapted.localBindings,
  note: "No originalVerdict: the original module was not run on these messages. plugin-wire-82bf8c4.tp1-adapted records its verdicts on the pre-revision adaptation; it refuses every profile-bearing message.",
  valid,
  requestNegatives: adapted.requestNegatives.map(caseOf),
  delegationNegatives: adapted.delegationNegatives.map(caseOf),
  responseNegatives: adapted.responseNegatives.map(caseOf),
}, { exclusive: true });
console.log(`wrote ${args.out}`);
