#!/usr/bin/env python3
"""Initialize only the cabinet encryption key; never print or rotate a key."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets

os.umask(0o077)
parser = argparse.ArgumentParser()
parser.add_argument('release', type=Path)
parser.add_argument('--execute', action='store_true')
args = parser.parse_args()
if not args.execute:
    parser.error('Use --execute to initialize the cabinet key without changing other settings.')
root = Path('/opt/artel-crm')
release = args.release.resolve()
assert release.parent == root / 'releases' and release.is_dir()
proof = release / 'cabinet-key-proof.json'
assert not proof.exists(), 'Key setup already recorded; inspect evidence before retrying'
locks = [open(root / '.runtime-env.lock', 'a'), open(root / 'secrets/.runtime-env.lock', 'a')]
for lock in locks:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
path = root / 'secrets/runtime.env'
assert not path.is_symlink() and path.stat().st_mode & 0o077 == 0
before = path.read_bytes()
prefix = b'ARTEL_CABINET_ENCRYPTION_KEY='
lines = [line for line in before.splitlines() if line.startswith(prefix)]
assert len(lines) <= 1, 'Duplicate cabinet key setting'
if lines:
    assert re.fullmatch(rb'[a-fA-F0-9]{64}', lines[0][len(prefix):]), 'Existing key is invalid; refusing to replace it'
    after = before
else:
    backup = release / 'runtime.env.before-cabinet-key'
    with backup.open('xb') as output:
        output.write(before)
        output.flush()
        os.fsync(output.fileno())
    suffix = (b'' if before.endswith(b'\n') else b'\n') + prefix + secrets.token_hex(32).encode() + b'\n'
    after = before + suffix
    temporary = root / 'secrets/.runtime.env.cabinet.tmp'
    with temporary.open('xb') as output:
        output.write(after)
        output.flush()
        os.fsync(output.fileno())
    os.chown(temporary, path.stat().st_uid, path.stat().st_gid)
    assert path.read_bytes() == before, 'Runtime environment changed during setup'
    os.replace(temporary, path)
assert path.read_bytes() == after
result = {'keyConfigured': True, 'keyCreated': not bool(lines), 'existingConfigurationPreserved': after.startswith(before),
          'beforeSha256': hashlib.sha256(before).hexdigest(), 'afterSha256': hashlib.sha256(after).hexdigest()}
with proof.open('x') as output:
    json.dump(result, output, indent=2)
    output.write('\n')
print(json.dumps(result))
