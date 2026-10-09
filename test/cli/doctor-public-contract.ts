// Compile-time regressions: credential metadata must stay internal to the CLI.
import type { DoctorOptions } from "../../src/cli/index.js";
// @ts-expect-error Internal credential metadata is not a CLI barrel export.
import type { DoctorSecretFile as CliFile } from "../../src/cli/index.js";
// @ts-expect-error Internal credential metadata is not a root barrel export.
import type { DoctorSecretFile as RootFile } from "../../src/index.js";
// @ts-expect-error The metadata-taking entry point is not a public export.
import type { runDoctorForCli as CliEntry } from "../../src/cli/index.js";
// @ts-expect-error The metadata-taking entry point is not a public export.
import type { runDoctorForCli as RootEntry } from "../../src/index.js";

type AssertAbsent<T extends never> = T;
type NoCredentialMetadata = AssertAbsent<Extract<keyof DoctorOptions, "secretFiles">>;
