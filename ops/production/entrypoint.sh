#!/bin/sh
set -eu
umask 077

: "${ARTEL_STORE_DIR:?ARTEL_STORE_DIR must point to the isolated persistent store}"
if [ ! -d "$ARTEL_STORE_DIR" ] || [ "$#" -eq 0 ]; then
  echo 'Artel CRM entrypoint requires an existing store directory and a command.' >&2
  exit 64
fi

# Every production runtime must enter through this wrapper. FD 9 is inherited by
# exec and holds the kernel lease for the complete lifetime of the Node process.
# Never unlink .runtime.lock: all contenders must lock the same stable inode.
exec 9>> "$ARTEL_STORE_DIR/.runtime.lock"
if ! flock --exclusive --nonblock --conflict-exit-code 75 9; then
  echo 'Artel CRM store already has an active runtime; refusing to start.' >&2
  exit 75
fi

# The operations-store transaction marker can survive SIGKILL/OOM. Acquiring the
# exclusive lifetime lease proves the prior runtime is gone, so only now may the
# marker be removed. This is not safe for writers outside the container lifetime;
# same-container maintenance must use OperationsStore transaction locking, and
# container teardown must kill those exec processes before the next startup.
rm -f -- "$ARTEL_STORE_DIR/operations.json.lock"
exec "$@"
