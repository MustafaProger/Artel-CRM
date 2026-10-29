# Production storage ownership

The production volume has exactly one runtime container. Every runtime must
run through `artel-entrypoint`, which acquires the Linux
`flock` exclusive lease on `.runtime.lock`. Descriptor 9 remains open across
`exec` for the complete application lifetime. A concurrent instance exits with
status 75 before touching the transaction marker or launching Node.

The `.runtime.lock` file is permanent. Never delete, rename or replace it while
any runtime may be alive: different inodes would allow independent leases.

`operations.json.lock` is the short-lived transaction marker used by the shared
application store. SIGKILL/OOM may leave it behind. The entrypoint removes it
only after obtaining the exclusive lifetime lease, proving that no compliant
production runtime is still running. Linux releases the lease automatically when
the process dies, including forced container termination.

Do not run development servers, Vercel processes, host scripts or a second
container against this volume without the same exclusive lease. Short maintenance
writes may use `docker exec` inside the active CRM container if they use the
standard `OperationsStore` transaction lock. They share the container lifetime:
Docker must terminate all exec processes before a replacement container starts.
Never detach a maintenance writer onto the host or another container. For
offline imports or repairs, stop the CRM container first and acquire the same
lease. Read-only inspection and copies of the atomically
replaced `operations.json` do not write to the store and do not need this lease.
Do not copy runtime or transaction lockfiles into restore targets.

Use a local Linux filesystem with working `flock`; this design is not intended
for multiple independent nodes or network filesystems. The image build checks
that `flock` exists. Compose must retain `init: true` so termination is forwarded
to the application; container restart must terminate all processes from the old
container. Keep the production snapshot mounted read-only and separate from the
writable operations volume.

Verification inside the built image:

```sh
docker run --rm --entrypoint sh IMAGE -s < tests/production-entrypoint.sh
```

The test uses a temporary synthetic store, checks that a concurrent process
cannot remove a live transaction marker, kills the holder with SIGKILL, then
confirms the next runtime recovers the stale marker and obtains the lease.

## Work partition, 2026-10-29

After an explicit offline split, operations.json is a format pointer. Never copy
that pointer as a business-data backup. Export a consistent complete envelope
with server-render/export-operations.mjs (store/snapshot env required). It uses
the transaction latch and replays a committed redo journal. Offline export,
split and merge run in the new image through its lifetime-lock entrypoint with
all CRM writers stopped. Merge composes current data; never restore an old
premigration snapshot over newer writes.

The same lifetime lease fences work-storage/{transaction,core-queue,work-queue}.lock.
The entrypoint removes only stale lock files after acquiring the lease and keeps
commit.json for redo recovery. Core and Work share one consistency latch; Work
has a separate admission queue. A mixed transaction may increment the composed
revision by two. Total partition size is conservatively bounded for a <=64MiB
flat export. Backup, audit and deployment tools must be layout-aware.
