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

The same lifetime lease fences work-storage/{transaction,core-queue,work-queue,trip-requests-queue}.lock.
The entrypoint removes only stale lock files after acquiring the lease and keeps
commit.json for redo recovery. Core and Work share one consistency latch; Work
has a separate admission queue. A mixed transaction may increment the composed
revision by two. Total partition size is conservatively bounded for a <=64MiB
flat export. Backup, audit and deployment tools must be layout-aware.

Trip requests have their own FIFO admission lock, but still commit the core file under the shared transaction latch. There is no third data partition, pointer change, or alternate backup format. Trip consumption uses the ordinary core transaction and races cancellation under the same latch.


## Auth partition, 2026-11-09

An explicit offline `split-auth` migration installs `artel-auth-partition-v1`
only after exact logical verification. The three authoritative files are
`auth-storage/{core,auth,work}.json`; `auth.json` owns accounts, directories and
push together. This keeps session revocation, device removal and the invoice
revocation outbox in one durable transaction. All domains share the transaction
latch; multi-part changes use `auth-storage/commit.json` redo recovery.

The lifetime lease also fences `auth-storage/{transaction,core-queue,work-queue,interactive-queue}.lock`.
After SIGKILL the entrypoint removes these stale markers, preserving the redo
journal. The old Work directory is historical migration evidence, never a source
for a new writer or recovery. Once the root pointer changes, do not start an old
backend. Recovery uses the new backend or an offline merge of CURRENT data.

The scheduled backup recognizes both partition formats and archives a verified
consistent flat export. A stopped release backup captures all data files,
including all three auth partitions and any redo journal, with an exact manifest.
A pointer-only copy is never a backup. Deployment/audit snapshots must verify a
stable complete generation; do not independently read three parts around a commit.
Migration, merge and restore are performed only with all writers stopped and
through the same lifetime-lock entrypoint. Keep the permanent lease inode intact.


## Auth/archive partition v2, 2026-11-09

Offline `split-archive` installs a new `artel-auth-partition-v2` pointer only
AFTER the complete new directory has been durably written and its composed
logical state verified exact. The authoritative directory is `auth-storage-v2`
with sealed `core.json`, `auth.json`, `work.json` and `archive.json` parts. Archive
owns `documentArchive`; its revision joins the other three revisions in the
logical export. Auth retains accounts/directories/push and durable revocation.
The previous `auth-storage` directory remains historical evidence; it must never
be used as an alternate current source after the v2 pointer commits.

All four parts share one transaction latch. `artel-auth-redo-v2` commit.json
stores ONLY changed sealed parts. Recovery combines those parts with the current
unchanged parts under the latch, validates the full composed state, applies the
redo, and durably removes the journal. Interrupted migration is safe to resume
only through the owning offline migration code, never by copying old data over
current writes. Lifetime lease acquisition removes stale v2 queue/latch markers,
not the journal. The permanent `.runtime.lock` inode remains unchanged.

The v1-only backend rejects the v2 pointer. Once v2 is installed, recovery must
use the same v2-capable candidate code or a verified offline merge of CURRENT
state; do not restore the old image or a premigration snapshot. Scheduled backup
exports one complete verified flat logical envelope from either auth layout.
Release captures must read pointer plus all four parts consistently and reject
live WAL/latch presence; audit tooling never replays a live journal independently.
