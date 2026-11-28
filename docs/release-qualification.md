# Release qualification runbook

A qualification step calls the publisher in `scripts/produce-qualification-manifest.mjs` directly.
The package scripts and workflows currently provide no qualification command. From the repository
root, this example writes sample evidence into a temporary directory.

```sh
node --input-type=module <<'NODE'
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvidencePublisher, nodeEvidenceFs } from "./scripts/produce-qualification-manifest.mjs";
const root = await mkdtemp(join(tmpdir(), "qualification-example-"));
try {
  const evidence = join(root, "evidence");
  const bytes = Buffer.from('{"example":true}\n');
  const id = "local-example";
  const hash = createHash("sha256").update(bytes).digest("hex");
  const publisher = createEvidencePublisher(nodeEvidenceFs);
  await publisher.ensureDirectories(evidence);
  const index = await publisher.publishIndexAssociation(evidence, id, hash);
  const manifest = join(evidence, "manifests");
  const first = await publisher.publishExclusive(manifest, "example.json", bytes);
  const replay = await publisher.publishExclusive(manifest, "example.json", bytes);
  const conflict = await publisher.publishExclusive(manifest, "example.json", Buffer.from("other bytes"));
  if (conflict.outcome === "different") console.log("existing bytes retained");
  else throw new Error("expected different result for a conflicting name");
  console.log(index.outcome, first.outcome, replay.outcome, conflict.outcome);
} finally { await rm(root, { recursive: true, force: true }); }
NODE
```

The first publication returns `created`. Replaying identical bytes returns `identical`. A conflicting
manifest name resolves to `{ outcome: "different", existing }` without throwing or replacing its
contents, so callers must check that return value. An existing index id with a different hash throws
`QualificationEvidenceError` with code `result_content_changed`.

## The evidence directory

- Use one evidence directory per release candidate.
- The scripts create `index/` and `manifests/` inside it. `index/` holds one small file per result id. It
  records which content hash that id was qualified with.
- Never edit a result or an index entry in place. A result whose content changed under an existing id is
  refused. Give the changed result a new id and qualify it again.
- Every file is written to a temporary name, synchronized to disk, and then linked to its final name. A
  final name is never replaced, and a crash leaves either the whole file or nothing under that name.

## Leftover staging files

A producer that dies can leave `.staging-<id>-<n>` files in `index/` or `manifests/`. The scripts never read,
link or remove a staging file that another run created, because it may belong to a producer that is
still running. Remove leftover `.staging-*` files by hand, and only when no producer or qualification command is
running.
