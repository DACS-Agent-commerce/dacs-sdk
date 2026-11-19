# Release qualification runbook

This runbook is for the person who qualifies a release candidate. It covers the evidence directory that
the qualification scripts write.

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
link or remove a staging file that another run created, because it may belong to a producer that is still
running. Remove leftover `.staging-*` files by hand, and only when no producer or qualification command is
running.
