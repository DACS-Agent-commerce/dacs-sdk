import { expect, test } from "vitest";
import { projectTemplates } from "../src/index.js";

// npm package names can contain separator sequences Docker repository names
// reject. The generated default and documented build command must agree.
test("generates a usable Docker image reference for repeated package-name separators", () => {
  for (const packageName of ["a..b", "a__b", "a---b", "a._-b"]) {
    const files = projectTemplates({ packageName, mode: "live-demos", role: "buyer",
      deployment: "docker", rails: "both" });
    expect(files[".env.example"], packageName).toContain("DACS_IMAGE=a-b:local\n");
    expect(files["README.md"], packageName).toContain("docker build -t a-b:local .\n");
  }
});

test("rejects explicit null live project identity while accepting omitted and valid identities", () => {
  for (const deployment of ["docker", "local"] as const) {
    const options = { packageName: "agent", mode: "live-demos", deployment } as const;
    expect(() => projectTemplates({ ...options, projectIdentity: null as never }))
      .toThrow(new TypeError("projectIdentity must be 32 lower-case hex digits"));
    for (const projectIdentity of [undefined, "a".repeat(32)]) {
      expect(projectTemplates({ ...options, projectIdentity })["README.md"]).toContain("live bootstrap");
    }
  }
});

test("renders the local README pre-start doctor as a standalone command", () => {
  const readme = projectTemplates({ packageName: "agent", mode: "live-demos", deployment: "local" })["README.md"]!;
  const shellExamples = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)];
  expect(shellExamples[0]?.[1]?.split("\n"))
    .toContain("npm run dacs:doctor -- --phase pre-start --for start");
});
