#!/usr/bin/env node
/**
 * Bounded PR #303 test-effectiveness witnesses.
 *
 * Each case copies the host package (and the core sources it aliases) into a
 * disposable task-owned directory, applies one exact wrong implementation to
 * that copy, and runs only the named Vitest witnesses. A case is "killed" only
 * when every witness fails with the intended assertion while its stated
 * controls still pass; an import, collection or runner failure is "invalid".
 * Unmutated baselines run first. The repository checkout is never written.
 *
 * Offline and shell-free: fixed paths, fixed mutations, process.execPath plus
 * the locally installed Vitest CLI, finite per-run and total budgets.
 *
 * usage: node scripts/verify-pr303-test-effectiveness.mjs
 * Prints one JSON report on stdout; exits 0 only when every case is killed.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = join("packages", "dacs-node");
const CHILD_ENV = "DACS_PR303_EFFECTIVENESS_CHILD";
const READINESS_TEST = "pr303Readiness.test.ts";
const RUN_TIMEOUT_MS = 240_000;
const TOTAL_BUDGET_MS = 900_000;

if (process.env[CHILD_ENV] === "1") {
  throw new Error("refusing a recursive PR303 effectiveness invocation");
}
if (process.argv.length !== 2) {
  throw new Error("usage: node scripts/verify-pr303-test-effectiveness.mjs");
}

const SUITES = Object.freeze({
  sqlite: ["test/sqlite.test.ts", "DACS Node SQLite durability foundation"],
  http: ["test/httpRuntime.test.ts", "authenticated HTTP listener and durable client"],
  service: ["test/service.test.ts", "authority-separated live role services"],
  x402Received: [
    "test/fixedPriceX402BuyerCommerce.test.ts",
    "fixed-price x402 buyer commerce",
  ],
  x402Evidence: [
    "test/fixedPriceX402BuyerCommerce.test.ts",
    "fixed-price x402 buyer payment-evidence verification",
  ],
  x402Audit: [
    "test/fixedPriceX402BuyerAudit.test.ts",
    "fixed-price x402 buyer audit reconstruction",
  ],
  payDemReceived: [
    "test/fixedPricePayDemBuyerCommerce.test.ts",
    "fixed-price native DEM buyer-received authorization",
  ],
  payDemEvidence: [
    "test/fixedPricePayDemBuyerCommerce.test.ts",
    "fixed-price native DEM buyer payment-evidence verification",
  ],
});

function selected(suite, title) {
  const [file, describe] = SUITES[suite];
  return Object.freeze({ file, describe, title });
}

const T = Object.freeze({
  historyAdmission: selected("sqlite",
    "admits versioned files only with the exact DACS application and schema"),
  retainedReplay: selected("http",
    "returns the retained envelope identity for a semantic outbox replay"),
  recordlessStore: selected("http",
    "refuses to report an envelope identity the outbox did not return"),
  serviceCollapse: selected("service",
    "returns and dispatches the retained envelope when distinct keys collapse semantically"),
  serviceMissing: selected("service",
    "fails closed when the outbox cannot produce the retained envelope it reported"),
  x402Accept: selected("x402Received",
    "accepts a valid response matching the independently anchored deliverable"),
  x402SignedScope: selected("x402Received",
    "rejects a response that differs from the anchored deliverable outside its signed scope"),
  x402EvidenceAccept: selected("x402Evidence",
    "accepts seller evidence bound to the captured settlement and unresolved PC-2 address"),
  x402EvidenceHash: selected("x402Evidence",
    "rejects a request whose evidence hash is not the signed-scope hash"),
  x402FinalityOmitted: selected("x402Evidence",
    "accepts seller evidence that omits the optional finality-depth echo"),
  x402FinalitySmaller: selected("x402Evidence",
    "rejects correctly signed evidence echoing a smaller finality depth"),
  x402AuditAccept: selected("x402Audit",
    "independently reconstructs and verifies the exact seller review request"),
  x402AuditFinality: selected("x402Audit",
    "rejects evidence whose finality echo differs from authenticated policy"),
  payDemReceivedAccept: selected("payDemReceived",
    "authorizes the payload bound by the seller's receipt-verified delivery evidence"),
  payDemEvidenceAccept: selected("payDemEvidence",
    "accepts seller evidence bound to the observed transfer and unresolved PC-2 address"),
});

/** Paths are relative to packages/dacs-node. Every anchor must occur exactly once. */
const MUTANTS = Object.freeze([
  {
    id: "sqlite-history-limit-8",
    contract: "C1 a v8 store with an extra ninth migration row is rejected",
    target: "src/sqlite.ts",
    replacements: [["LIMIT 9\n", "LIMIT 8\n"]],
    witnesses: [T.historyAdmission],
    controls: [],
    expectedFailure: /instead of rejecting/,
  },
  {
    id: "http-queue-returns-submitted-identity",
    contract: "C4 queue reports the retained, not the submitted, envelope identity",
    target: "src/transport/http.ts",
    replacements: [[
      "envelopeId: retained.record.envelope.envelopeId,",
      "envelopeId: verified.envelope.envelopeId,",
    ]],
    witnesses: [T.retainedReplay],
    controls: [T.recordlessStore],
    expectedFailure: /to deeply equal/,
  },
  {
    id: "http-queue-invents-identity-without-record",
    contract: "C4 queue fails closed when the outbox returns no retained record",
    target: "src/transport/http.ts",
    replacements: [
      [
        'if (retained.status === "conflict" || retained.record === undefined) {',
        'if (retained.status === "conflict") {',
      ],
      [
        "envelopeId: retained.record.envelope.envelopeId,",
        "envelopeId: retained.record?.envelope.envelopeId ?? verified.envelope.envelopeId,",
      ],
    ],
    witnesses: [T.recordlessStore],
    controls: [T.retainedReplay],
    expectedFailure: /instead of rejecting/,
  },
  {
    id: "service-returns-signed-not-retained",
    contract: "C5 queueMessage/sendMessage use the retained envelope after a semantic collapse",
    target: "src/service.ts",
    replacements: [[
      "return retained as Readonly<DacsHttpEnvelopeFor<typeof input.type>>;",
      "return signed as Readonly<DacsHttpEnvelopeFor<typeof input.type>>;",
    ]],
    witnesses: [T.serviceCollapse],
    controls: [T.serviceMissing],
    expectedFailure: /to deeply equal/,
  },
  {
    id: "service-substitutes-missing-retained-envelope",
    contract: "C5 a reported retained identity that cannot be loaded is rejected",
    target: "src/service.ts",
    replacements: [[
      ": (await outbox.load(queued.envelopeId))?.envelope;",
      ": (await outbox.load(queued.envelopeId))?.envelope ?? signed;",
    ]],
    witnesses: [T.serviceMissing],
    controls: [T.serviceCollapse],
    expectedFailure: /instead of rejecting/,
  },
  {
    id: "x402-received-ignores-anchored-bytes",
    contract: "C6 x402 buyerReceived compares the exact anchored deliverable bytes",
    target: "src/fixedPriceX402BuyerCommerce.ts",
    replacements: [[
      ": canonicalize(delivered.artifact) === canonicalize(payload);",
      ": true;",
    ]],
    witnesses: [T.x402SignedScope],
    controls: [T.x402Accept],
    expectedFailure: /expected true to be false/,
  },
  {
    id: "paydem-received-binds-deliverable-not-evidence",
    contract: "C6 pay-dem buyerReceived verifies the evidence anchor it resolved",
    target: "src/fixedPricePayDemBuyerCommerce.ts",
    replacements: [[
      "attestationRef: evidenceAnchor.attestationRef,",
      "attestationRef: { anchor: { kind: \"storage-program\", locator: record.logicalAddress }, " +
        "contentHash: record.contentHash },",
    ]],
    witnesses: [T.payDemReceivedAccept],
    controls: [T.payDemEvidenceAccept],
    expectedFailure: /expected false to be true/,
  },
  {
    id: "x402-evidence-ignores-request-hash",
    contract: "C6 x402 verifyEvidence binds the requested signed-scope evidence hash",
    target: "src/fixedPriceX402BuyerCommerce.ts",
    replacements: [[
      "contentHash: request.evidenceHash,",
      "contentHash: contentHash(request.evidence),",
    ]],
    witnesses: [T.x402EvidenceHash],
    controls: [T.x402EvidenceAccept],
    expectedFailure: /to deeply equal/,
  },
  {
    id: "x402-evidence-ignores-finality-echo",
    contract: "PC-6 x402 evidence finality echo matches the authenticated rail depth",
    target: "src/fixedPriceX402BuyerCommerce.ts",
    replacements: [[
      "evidenceFinalityBlocks !== finalityBlocks) ||",
      "false) ||",
    ]],
    witnesses: [T.x402FinalitySmaller],
    controls: [T.x402EvidenceAccept, T.x402FinalityOmitted],
    expectedFailure: /to deeply equal/,
  },
  {
    id: "x402-audit-ignores-finality-echo",
    contract: "PC-6 audit refuses evidence whose finality echo differs from authenticated policy",
    target: "src/fixedPriceX402BuyerAudit.ts",
    replacements: [[
      "paymentAnchor.artifact.settlementFinality.finalityBlocks !==\n" +
        "                authenticatedFinalityBlocks) ||",
      "false) ||",
    ], [
      "finalityBlocks: authenticatedFinalityBlocks,",
      "finalityBlocks: capturedPaymentFinality.finalityBlocks,",
    ]],
    witnesses: [T.x402AuditFinality],
    controls: [T.x402AuditAccept],
    expectedFailure: /instead of rejecting/,
  },
  {
    id: "paydem-evidence-claims-resolved-address",
    contract: "C6 pay-dem verifyEvidence binds the unresolved PC-2 payment address",
    target: "src/fixedPricePayDemBuyerCommerce.ts",
    replacements: [["resolved: false,", "resolved: true,"]],
    witnesses: [T.payDemEvidenceAccept],
    controls: [T.payDemReceivedAccept],
    expectedFailure: /to deeply equal/,
  },
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The assertion message before its stack trace (a toEqual diff may span lines). */
function failureHead(messages) {
  const text = Array.isArray(messages) && typeof messages[0] === "string" ? messages[0] : "";
  return text.split(/\n\s+at /, 1)[0].slice(0, 1_500);
}

function childEnvironment() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(VITEST|TINYPOOL|__VITEST)/.test(key) || key === "NODE_V8_COVERAGE") continue;
    env[key] = value;
  }
  return { ...env, [CHILD_ENV]: "1", NO_COLOR: "1", FORCE_COLOR: "0" };
}

async function prepareCopy(root) {
  await symlink(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  for (const file of ["package.json", "tsconfig.json"]) {
    await cp(join(repoRoot, file), join(root, file));
  }
  await cp(join(repoRoot, "src"), join(root, "src"), { recursive: true });
  const host = join(root, HOST);
  await mkdir(host, { recursive: true });
  for (const file of ["package.json", "tsconfig.json", "vitest.config.ts"]) {
    await cp(join(repoRoot, HOST, file), join(host, file));
  }
  await cp(join(repoRoot, HOST, "src"), join(host, "src"), { recursive: true });
  await cp(join(repoRoot, HOST, "test"), join(host, "test"), {
    recursive: true,
    filter: (source) => !source.endsWith(READINESS_TEST),
  });
  const hostModules = join(repoRoot, HOST, "node_modules");
  if (existsSync(hostModules)) {
    await mkdir(join(host, "node_modules"));
    for (const entry of await readdir(hostModules)) {
      if (entry.startsWith(".")) continue;
      await symlink(join(hostModules, entry), join(host, "node_modules", entry));
    }
  }
  return host;
}

async function isSymbolicLink(path) {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function removeCopy(root) {
  // Unlink dependency symlinks first so removal never traverses the checkout.
  if (await isSymbolicLink(join(root, "node_modules"))) await unlink(join(root, "node_modules"));
  const hostModules = join(root, HOST, "node_modules");
  if (existsSync(hostModules)) {
    for (const entry of await readdir(hostModules)) {
      const path = join(hostModules, entry);
      if (await isSymbolicLink(path)) await unlink(path);
    }
  }
  await rm(root, { recursive: true, force: true });
}

function runVitest(host, files, titles, outputFile) {
  const cli = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
  const args = [
    cli, "run", "--config", "vitest.config.ts",
    "--reporter=json", `--outputFile=${outputFile}`,
    "-t", titles.map(escapeRegExp).join("|"),
    ...files,
  ];
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd: host,
      env: childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", () => {});
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8_000) stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: null, timedOut, durationMs: Date.now() - started,
        stderr: String(error) });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, timedOut, durationMs: Date.now() - started,
        stderr: stderr.slice(0, 4_000) });
    });
  });
}

async function readReport(outputFile) {
  try {
    return JSON.parse(await readFile(outputFile, "utf8"));
  } catch {
    return null;
  }
}

/** Locate exactly one discovered result for each expected test. */
function locate(report, expected) {
  const fileResults = (report?.testResults ?? []).filter((result) =>
    typeof result?.name === "string" &&
      result.name.replaceAll("\\", "/").endsWith(`/packages/dacs-node/${expected.file}`));
  if (fileResults.length !== 1) {
    return { title: expected.title, status: "not-discovered", detail: "file result missing" };
  }
  const fileResult = fileResults[0];
  const suiteError = typeof fileResult.message === "string" && fileResult.message !== ""
    ? fileResult.message.split("\n", 1)[0].slice(0, 400) : undefined;
  const matches = (fileResult.assertionResults ?? []).filter((assertion) =>
    assertion?.title === expected.title &&
      Array.isArray(assertion.ancestorTitles) &&
      assertion.ancestorTitles[assertion.ancestorTitles.length - 1] === expected.describe);
  if (matches.length !== 1) {
    return {
      title: expected.title,
      status: matches.length === 0 ? "not-discovered" : "duplicate",
      ...(suiteError === undefined ? {} : { suiteError }),
    };
  }
  const failure = matches[0].status === "failed"
    ? failureHead(matches[0].failureMessages) : undefined;
  return {
    title: expected.title,
    status: matches[0].status,
    ...(failure === undefined ? {} : {
      failure,
      assertionError: /AssertionError/.test(failure),
    }),
    ...(suiteError === undefined ? {} : { suiteError }),
  };
}

async function baseline(host, scratch, file, tests) {
  const outputFile = join(scratch, `baseline-${file.replaceAll("/", "_")}.json`);
  const run = await runVitest(host, [file], tests.map((item) => item.title), outputFile);
  const report = await readReport(outputFile);
  const located = tests.map((item) => locate(report, item));
  const passed = report !== null && !run.timedOut &&
    located.every((item) => item.status === "passed" && item.suiteError === undefined);
  return {
    file,
    status: passed ? "passed" : "failed",
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    tests: located,
    ...(passed ? {} : { stderr: run.stderr }),
  };
}

function applyReplacements(text, replacements) {
  let mutated = text;
  for (const [from, to] of replacements) {
    const count = mutated.split(from).length - 1;
    if (count !== 1) {
      throw new Error(`mutation anchor occurs ${count} times: ${JSON.stringify(from)}`);
    }
    mutated = mutated.replace(from, () => to);
  }
  return mutated;
}

async function mutant(host, scratch, definition) {
  const targetPath = join(host, definition.target);
  const original = await readFile(targetPath);
  const originalSha256 = sha256(original);
  let mutated;
  try {
    mutated = applyReplacements(original.toString("utf8"), definition.replacements);
  } catch (error) {
    return {
      id: definition.id,
      contract: definition.contract,
      target: `${HOST}/${definition.target}`,
      status: "invalid",
      restored: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  let restored = false;
  let run;
  let report = null;
  try {
    await writeFile(targetPath, mutated);
    const files = [...new Set([...definition.witnesses, ...definition.controls]
      .map((item) => item.file))];
    const outputFile = join(scratch, `mutant-${definition.id}.json`);
    run = await runVitest(host, files,
      [...definition.witnesses, ...definition.controls].map((item) => item.title), outputFile);
    report = await readReport(outputFile);
  } finally {
    await writeFile(targetPath, original);
    restored = sha256(await readFile(targetPath)) === originalSha256;
  }
  const witnesses = definition.witnesses.map((item) => locate(report, item));
  const controls = definition.controls.map((item) => locate(report, item));
  // The witness must fail on its mutant-specific assertion text, never on a
  // thrown runtime/import error that merely happens to fail the same test.
  const intended = (item) => item.status === "failed" && item.suiteError === undefined &&
    definition.expectedFailure.test(item.failure ?? "") &&
    !/^\s*(?:TypeError|ReferenceError|SyntaxError|RangeError)\b/.test(item.failure ?? "");
  let status;
  if (report === null || run.timedOut) status = "invalid";
  else if (witnesses.every((item) => item.status === "passed")) status = "survived";
  else if (witnesses.every(intended) &&
      controls.every((item) => item.status === "passed" && item.suiteError === undefined)) {
    status = "killed";
  } else status = "invalid";
  return {
    id: definition.id,
    contract: definition.contract,
    target: `${HOST}/${definition.target}`,
    replacements: definition.replacements.length,
    expectedFailure: String(definition.expectedFailure),
    status,
    restored,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    witnesses,
    controls,
    ...(status === "killed" ? {} : { stderr: run.stderr }),
  };
}

async function repositoryTargets() {
  const targets = [...new Set(MUTANTS.map((item) => item.target))].sort();
  return Object.fromEntries(await Promise.all(targets.map(async (target) => [
    `${HOST}/${target}`,
    sha256(await readFile(join(repoRoot, HOST, target))),
  ])));
}

const started = Date.now();
const vitestCli = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
if (!existsSync(vitestCli)) throw new Error(`installed Vitest CLI is missing: ${vitestCli}`);
const vitestManifest = JSON.parse(
  await readFile(join(repoRoot, "node_modules", "vitest", "package.json"), "utf8"),
);
const before = await repositoryTargets();
const root = await mkdtemp(join(tmpdir(), "dacs-pr303-effectiveness-"));
const baselines = [];
const mutants = [];
try {
  const host = await prepareCopy(root);
  const scratch = join(root, "reports");
  await mkdir(scratch);
  const byFile = new Map();
  for (const item of Object.values(T)) {
    byFile.set(item.file, [...(byFile.get(item.file) ?? []), item]);
  }
  for (const [file, tests] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    baselines.push(await baseline(host, scratch, file, tests));
  }
  const baselinePassed = baselines.every((item) => item.status === "passed");
  for (const definition of MUTANTS) {
    if (!baselinePassed || Date.now() - started > TOTAL_BUDGET_MS) {
      mutants.push({ id: definition.id, contract: definition.contract, status: "not-run",
        restored: true });
      continue;
    }
    const result = await mutant(host, scratch, definition);
    mutants.push(result);
    if (!result.restored) throw new Error(`disposable copy was not restored after ${definition.id}`);
  }
} finally {
  await removeCopy(root);
}
const after = await repositoryTargets();
const unchanged = JSON.stringify(before) === JSON.stringify(after);
const report = {
  schema: "dacs-pr303-test-effectiveness/v1",
  toolchain: { node: process.version, vitest: vitestManifest.version },
  command: "node scripts/verify-pr303-test-effectiveness.mjs",
  repositoryTargets: { sha256: before, unchanged },
  baselines,
  mutants,
  durationMs: Date.now() - started,
  passed: unchanged &&
    baselines.every((item) => item.status === "passed") &&
    mutants.every((item) => item.status === "killed" && item.restored === true),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.passed ? 0 : 1;
