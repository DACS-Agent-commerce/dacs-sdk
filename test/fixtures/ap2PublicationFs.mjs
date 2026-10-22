// Child-only filesystem wrapper. The actual store still writes, flushes and
// publishes each file; this wrapper kills that writer at the syscall boundary.
export * from "node:fs/promises";
import { link as actualLink, rename as actualRename } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const point = process.env.DACS_TEST_AP2_PUBLICATION;
function barrier(label, path) {
  if (point !== label) return;
  writeFileSync(join(process.argv[2], "publication-kill.json"), JSON.stringify({ pid: process.pid, point, path: String(path) }));
  process.kill(process.pid, "SIGKILL");
}
export async function link(source, destination) {
  const phase = String(destination).includes("/phases/") && String(destination).endsWith(".json");
  if (phase) barrier("before-phase", destination);
  await actualLink(source, destination);
  if (phase) barrier("after-phase", destination);
}
export async function rename(source, destination) {
  const record = String(destination).includes("/records/") && String(destination).endsWith(".json");
  if (record) barrier("before-record", destination);
  await actualRename(source, destination);
  if (record) barrier("after-record", destination);
}
