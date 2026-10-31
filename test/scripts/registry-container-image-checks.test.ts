import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const source = () => readFileSync("scripts/verify-registry-container-consumer.sh", "utf8");
function imageChecks(testsStatus = 0, doctorStatus = 5) {
  const root = mkdtempSync(join(tmpdir(), "dacs-image-checks-")); roots.push(root);
  const output = join(root, "out"), artifacts = join(root, "artifacts"); mkdirSync(output); mkdirSync(artifacts);
  const block = source().split("stage=image-checks\n")[1]?.split("stage=evidence-collect\n")[0];
  expect(block, "functional checks must run from the accepted image").toBeTruthy();
  const commands = join(root, "commands");
  const result = spawnSync("bash", ["--norc", "--noprofile", "-euc", `
run_bounded() { "$@"; }
docker() {
  printf '%s\\n' "$*" >> "$commands"
  case "$*" in
    *--test*) echo test-output; return "$TESTS_RETURN" ;;
    *) echo '{"from":"image"}'; echo doctor-diagnostic >&2; return "$DOCTOR_RETURN" ;;
  esac
}
${block}`], { encoding: "utf8", env: { PATH: process.env.PATH, consumer_phases: "install measure", consumer_container: "fixture",
      runtime_image: "accepted-image:fixture", execute_out: output, artifact_stage: artifacts, commands,
      TESTS_RETURN: String(testsStatus), DOCTOR_RETURN: String(doctorStatus), host_uid: "1001", host_gid: "1001" } });
  return { result, output, artifacts, commands: existsSync(commands) ? readFileSync(commands, "utf8") : "" };
}

describe("immutable image functional evidence", () => {
  it("checks the built image in fresh containers without a writable project or evidence mount", () => {
    const { result, output, commands } = imageChecks();
    expect(result.status, result.stderr).toBe(0);
    const runs = commands.trim().split("\n"); expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run).toContain("--read-only --network none");
      expect(run).toContain("--cap-drop ALL --security-opt no-new-privileges");
      expect(run).toContain("--entrypoint sh");
      expect(run).toContain("accepted-image:fixture -ceu");
      expect(run).toContain('umask 077; mkdir -p -m 0700 /app/data/buyer /app/data/seller; exec node "$@"');
      expect(run).toContain("image-check --import @kynesyslabs/dacs-node/demos-loader");
      expect(run).not.toMatch(/--volume|--mount|npm |rebuild|\/work|\/out/);
    }
    expect(runs[0]).toContain("--name fixture-tests"); expect(runs[1]).toContain("--name fixture-doctor");
    expect(readFileSync(join(output, "doctor.json"), "utf8")).toBe('{"from":"image"}\n');
    expect(readFileSync(join(output, "doctor.log"), "utf8")).toBe("doctor-diagnostic\n");
    expect(readFileSync(join(output, "generated-tests.exit-code"), "utf8")).toBe("0\n");
    expect(readFileSync(join(output, "doctor.exit-code"), "utf8")).toBe("5\n");
    expect(source().indexOf("stage=image-build\n")).toBeLessThan(source().indexOf("stage=image-checks\n"));
  });

  it("uses private data owned by the runtime UID even when the host UID differs", () => {
    const { result, commands } = imageChecks();
    expect(result.status, result.stderr).toBe(0);
    for (const run of commands.trim().split("\n")) {
      expect(run).toContain("--user 10001:10001");
      expect(run).toContain("--tmpfs /app/data:uid=10001,gid=10001,mode=0700");
      expect(run).toContain("--tmpfs /tmp:mode=1777");
      expect(run).not.toContain("1001:1001");
    }
  });

  it.each([1, 124])("records test failure %s outside the container and skips doctor", status => {
    const { result, output, commands } = imageChecks(status);
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(output, "generated-tests.exit-code"), "utf8")).toBe(`${status}\n`);
    expect(commands).not.toContain("--name fixture-doctor");
    expect(existsSync(join(output, "doctor.json"))).toBe(false);
  });

  it.each([0, 1, 124])("records unexpected doctor status %s and fails", status => {
    const { result, output } = imageChecks(0, status);
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(output, "doctor.exit-code"), "utf8")).toBe(`${status}\n`);
  });
});
