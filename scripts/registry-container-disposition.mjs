#!/usr/bin/env node
// Maps a registry/container acceptance summary to the script's exit status.
//
//   0  functional rehearsal and the release security gate both passed.
//   1  the functional rehearsal failed.
//   3  the release security gate is blocked by something the recorded #191
//      baseline does not explain: a dependency or image policy violation, an
//      engine-strict or SBOM failure, or audit findings beyond the baseline.
//   4  the release security gate is blocked only by transitive audit findings
//      within the recorded #191 baseline. Production publication stays blocked,
//      but this is not a regression introduced by the change under test.
//
// A summary without the expected schema, or that does not record a functional
// pass and passing generated tests, is a functional failure (1). The workflow
// re-runs this check before it waives status 4.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const ACCEPTANCE_SUMMARY_SCHEMA = "dacs-registry-container-acceptance/v1";

export function registryContainerDisposition(summary) {
  if (summary?.schema !== ACCEPTANCE_SUMMARY_SCHEMA) {
    return { exitCode: 1, message: "registry/container acceptance summary has an unexpected schema" };
  }
  if (summary.functionalPassed !== true || summary.generatedTestsPassed !== true) {
    return { exitCode: 1, message: "functional registry/container rehearsal failed" };
  }
  const gate = summary.securityGate;
  if (gate?.passed === true) {
    return { exitCode: 0, message: "registry/container acceptance passed" };
  }
  const total = summary.audit?.total;
  const withinRecordedBaseline = gate !== null && typeof gate === "object" &&
    gate.registryDependencyPolicyPassed === true &&
    gate.productionImageDependencyPolicyPassed === true &&
    gate.engineStrictExitCode === 0 &&
    gate.lockSbomExitCode === 0 &&
    gate.physicalSbomExitCode === 0 &&
    gate.auditBaselineExceeded === false &&
    Number.isInteger(total) && total > 0;
  if (withinRecordedBaseline) {
    return {
      exitCode: 4,
      message: "functional registry/container rehearsal passed; the #191 security gate " +
        "remains blocked only by audit findings within the recorded baseline",
    };
  }
  return {
    exitCode: 3,
    message: "functional registry/container rehearsal passed, but the #191 security gate " +
      "is blocked beyond the recorded baseline",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) {
    process.stderr.write("usage: registry-container-disposition.mjs <acceptance-summary.json>\n");
    process.exit(2);
  }
  const summary = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const { exitCode, message } = registryContainerDisposition(summary);
  (exitCode === 0 ? process.stdout : process.stderr).write(`${message}\n`);
  process.exit(exitCode);
}
