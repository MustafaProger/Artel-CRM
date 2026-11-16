#!/usr/bin/env python3
"""Publish the verified balance and timestamps without exporting browser session data."""
import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

TARGET = Path('/opt/artel-crm/data/operations/licard-balance.json')
CONTRACT = 'RU260007461'


def valid_amount(value):
    return type(value) is int and abs(value) <= 9007199254740991


last_success = None
amount = None
try:
    previous = json.loads(TARGET.read_text())
    if isinstance(previous, dict) and previous.get('version') == 1 and previous.get('contract') == CONTRACT and valid_amount(previous.get('amountMinor')):
        last_success = previous.get('lastSuccessAt')
        amount = previous['amountMinor']
except (OSError, ValueError):
    pass

state = 'error'
try:
    collected = subprocess.run(
        ['docker', 'exec', 'artel-licard-browser', 'node', '/state/worker/collect.mjs'],
        capture_output=True, timeout=30, check=True,
    )
    result = json.loads(collected.stdout)
    if result.get('state') == 'auth_required':
        state = 'auth_required'
    elif result.get('state') == 'connected' and valid_amount(result.get('amountMinor')):
        state = 'connected'
        amount = result['amountMinor']
except (OSError, subprocess.SubprocessError, ValueError, AttributeError):
    pass

now = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
if state == 'connected':
    last_success = now
snapshot = {'version': 1, 'contract': CONTRACT, 'state': state, 'lastAttemptAt': now}
if last_success and amount is not None:
    snapshot.update(lastSuccessAt=last_success, amountMinor=amount)

fd, name = tempfile.mkstemp(prefix='.licard-balance-', dir=TARGET.parent)
try:
    with os.fdopen(fd, 'w') as file:
        json.dump(snapshot, file)
        file.write('\n')
        file.flush()
        os.fsync(file.fileno())
    os.chown(name, 0, 1000)
    os.chmod(name, 0o640)
    os.replace(name, TARGET)
finally:
    if os.path.exists(name):
        os.unlink(name)
print(json.dumps({'state': state, 'lastAttemptAt': now, 'lastSuccessAt': last_success}))
