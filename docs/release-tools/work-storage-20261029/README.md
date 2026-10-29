# Work storage release tools, 2026-10-29

These tools are frozen into the signed-by-checksum release package. They require
the matching config.json, source archive, manifests and QA evidence; they must not
be run directly against an arbitrary directory or used to replay a completed switch.
Source baseline: artel-crm:20261029-documents-4a1a2deb.

`storage-snapshot.py` reads either the legacy envelope or a consistent flattened
export from the new runtime. Offline exports use the explicit candidate image
through its lifetime-lock entrypoint. `switch-direct-safety.py` verifies current
image/source, image tests, a migrated copy and an offline backup before migration.
After switching image selection it only recovers the same candidate, never old data.
The migration proof must be exact before a partitioned runtime may start.

Raw preservation results may remain false due to separately running jobs or user
activity; final review must preserve those results and explain any scoped deltas.

The release is deployed. `final-audit.py` and `finalize.py` capture immutable after-UI evidence and finalize only metadata. `review-supplement.py` compares frozen evidence without upgrading raw flags. They are archived for review, not replay. `evidence-summary.json` contains only sanitized results; full operational snapshots stay private on the server.
