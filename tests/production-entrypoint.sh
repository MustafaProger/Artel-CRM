#!/bin/sh
# Run on Linux, including inside the built image with its entrypoint overridden:
# docker run --rm --entrypoint sh IMAGE -s < tests/production-entrypoint.sh
set -eu

entrypoint=${ARTEL_TEST_ENTRYPOINT:-/usr/local/bin/artel-entrypoint}
command -v flock >/dev/null
command -v node >/dev/null
directory=$(mktemp -d)
holder_pid=
cleanup() {
  if [ -n "$holder_pid" ]; then
    kill -KILL "$holder_pid" 2>/dev/null || true
    wait "$holder_pid" 2>/dev/null || true
  fi
  rm -rf -- "$directory"
}
trap cleanup EXIT HUP INT TERM
export ARTEL_STORE_DIR="$directory/store"
export ARTEL_TEST_MARKER="$directory/entered"
mkdir "$ARTEL_STORE_DIR"

# A stale transaction marker from an already dead process must be recovered.
printf '%s' 'stale' > "$ARTEL_STORE_DIR/operations.json.lock"
"$entrypoint" node -e '
  const fs = require("node:fs");
  const lock = process.env.ARTEL_STORE_DIR + "/operations.json.lock";
  if (fs.existsSync(lock)) throw new Error("stale lock was not recovered");
  fs.fstatSync(9);
  fs.writeFileSync(lock, "live-transaction");
  fs.writeFileSync(process.env.ARTEL_TEST_MARKER, "");
  setInterval(() => {}, 600000);
' &
holder_pid=$!
attempt=0
while [ ! -e "$ARTEL_TEST_MARKER" ]; do
  kill -0 "$holder_pid"
  attempt=$((attempt + 1))
  test "$attempt" -lt 100
  sleep 0.05
done

# A concurrent runtime cannot launch its command or remove the live marker.
rm "$ARTEL_TEST_MARKER"
status=0
"$entrypoint" sh -c ': > "$ARTEL_TEST_MARKER"' 2> "$directory/conflict.log" || status=$?
test "$status" -eq 75
test ! -e "$ARTEL_TEST_MARKER"
test "$(cat "$ARTEL_STORE_DIR/operations.json.lock")" = 'live-transaction'

# Kernel locks vanish even on SIGKILL; the stable lockfile inode remains.
kill -KILL "$holder_pid"
wait "$holder_pid" 2>/dev/null || true
holder_pid=
test -e "$ARTEL_STORE_DIR/.runtime.lock"
test -e "$ARTEL_STORE_DIR/operations.json.lock"
"$entrypoint" sh -c '
  test ! -e "$ARTEL_STORE_DIR/operations.json.lock"
  : > "$ARTEL_TEST_MARKER"
'
test -e "$ARTEL_TEST_MARKER"
test -e "$ARTEL_STORE_DIR/.runtime.lock"
printf '%s\n' 'PASS: stale recovery, concurrent exclusion, SIGKILL release and restart recovery'
