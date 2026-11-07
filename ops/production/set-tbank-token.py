#!/usr/bin/env python3
"""Read the new read-only token from a hidden terminal prompt; never print it."""
import datetime
import getpass
import fcntl
import os
from pathlib import Path
import shutil
import sys

os.umask(0o077)
path = Path('/opt/artel-crm/secrets/runtime.env')
token = (sys.stdin.read() if sys.argv[1:] == ['--stdin'] else getpass.getpass('New T-Bank read-only token (hidden): ')).strip()
if len(token) < 20 or len(token) > 16000 or any(ord(c) < 33 or ord(c) > 126 for c in token):
    raise SystemExit('Invalid token format; configuration unchanged')
with path.with_name('.runtime-env.lock').open('w') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    lines = path.read_text().splitlines()
    key = 'ARTEL_BANK_TBANK_NK_TOKEN='
    updated = [line for line in lines if not line.startswith(key)]
    updated.append(key + token)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    backup = path.with_name(f'runtime-before-token-{stamp}.env')
    shutil.copyfile(path, backup)
    os.chmod(backup, 0o600)
    temporary = path.with_suffix('.env.new')
    temporary.write_text('\n'.join(updated) + '\n')
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
print('Token saved privately. Restart only the CRM container, verify the read request, then enable synchronization.')
