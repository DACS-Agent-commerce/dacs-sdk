# Durable filesystem safety

Filesystem-backed DACS stores share one admission and publication boundary.
On POSIX hosts the boundary:

- walks every existing path component with `lstat` and rejects
  application-controlled symbolic links;
- requires the configured root and persisted files to be owned by the current
  user, permits only root-owned system ancestors, and rejects group/world
  writable components (except a root-owned sticky scratch ancestor);
- rejects known network/distributed filesystem types and common consumer-sync
  directory locations;
- opens directories and files without following the endpoint, and compares
  device/inode identity before and after each open or publication;
- rejects a retained regular file when its link count is not exactly one, so a
  record cannot remain mutable through another hard-link name;
- writes through a cryptographically random `O_EXCL` temporary, fsyncs the
  file, atomically renames or hard-links it, then fsyncs the containing
  directory; and
- never changes an unsafe pre-existing path into an accepted one with `chmod`.

The root-owned macOS `/var`, `/tmp`, and `/etc` compatibility aliases are
normalized to their immutable `/private/...` targets before inspection. This
exception does not resolve an application-controlled symlink.

Windows fails closed for these stores until a platform adapter can verify the
owner and effective ACL with equivalent guarantees. A deployment must not
weaken that failure into a warning.

Local-filesystem admission combines `statfs` magic checks with the host mount
table and a deny-list of known network/distributed filesystem types. Failure to
read or match the mount table fails closed. An unfamiliar filesystem type is
currently admitted when neither check identifies it as remote, so this is a
conservative detector rather than a proof that every future filesystem has
local-disk durability semantics. Expanding this into a platform-specific local
filesystem allow-list remains part of the wider #286 follow-up.

The exported read and publication primitives repeat local-filesystem admission
on every operation; callers cannot bypass it by omitting directory preparation,
and a mount replaced between operations is re-evaluated. Node does not expose
an `fstatfs` binding, so a privileged mount replacement in the interval between
that check and a pathname operation remains a host-level race.

Node.js does not expose portable `openat(2)`/`renameat(2)` operations. The
implementation holds and revalidates directory descriptors and detects an
inode swap, but it cannot make every pathname operation relative to the held
descriptor. Temporary cleanup verifies the endpoint against the inode it
created before unlinking, but the final pathname unlink has the same narrow
same-UID race. Deploy each role under a separate OS user with a private store
root; do not grant another actor write access to any ancestor. A future native
host adapter should bind every operation to directory descriptors on platforms
that expose the required primitives.

The legacy `createFsSessionStore` lock now publishes complete owner metadata,
refuses to evict a live PID, and rechecks its unique token before release or
dead-owner recovery. That token-check-to-pathname-unlink interval is not an
atomic compare-and-delete operation. It is safe against other OS users under
the required private-root policy, but it does not claim protection from a
malicious process running as the same UID. Use the generation-fenced store for
new money-path integrations; eliminating the residual same-UID race in either
implementation requires a descriptor-relative native lock adapter.
