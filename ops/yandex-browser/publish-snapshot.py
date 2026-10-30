#!/usr/bin/env python3
"""Run the browser collector; publish only its money/status envelope, never browser storage."""
import json, os, subprocess, tempfile
from datetime import datetime, timezone
from pathlib import Path
TARGET = Path('/opt/artel-crm/data/operations/yandex-balance.json')
SCOPE = {'version': 1, 'companyId': '7d90c6ecc6804d738c19d1c1c0ab0aaa', 'contractId': '49844602', 'contractNumber': '43207794/25'}
now = lambda: datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
try:
    run = subprocess.run(['docker','exec','artel-yandex-browser','node','/state/worker/collect.mjs'], capture_output=True, timeout=100, check=True)
    assert len(run.stdout) <= 16384
    raw = json.loads(run.stdout)
    assert all(raw.get(k) == v for k,v in SCOPE.items())
    assert raw['state'] in ['connected','error','auth_required']
    result = {k: raw[k] for k in [*SCOPE, 'state', 'createdAt', 'lastAttemptAt']}
    for k in ['lastSuccessAt','balance']:
        if k in raw: result[k] = raw[k]
    if 'balance' in result:
        b=result['balance']; assert b.get('currency')=='RUB'
        assert all(type(b.get(k)) is int and abs(b[k]) <= 9007199254740991 for k in ['amountMinor','availableMinor'])
        assert all(type(b[k]) is int and abs(b[k]) <= 9007199254740991 for k in ['overdraftLimitMinor','overdraftAvailableMinor'] if k in b)
        result['balance']={k:b[k] for k in ['currency','amountMinor','availableMinor','overdraftLimitMinor','overdraftAvailableMinor'] if k in b}
except Exception:
    try: result = json.loads(TARGET.read_text())
    except Exception: result = {**SCOPE, 'createdAt':now()}
    result.update(state='error', lastAttemptAt=now())
fd, name = tempfile.mkstemp(prefix='.yandex-balance-', dir=TARGET.parent)
try:
    with os.fdopen(fd, 'w') as f:
        json.dump(result,f,ensure_ascii=False);f.write('\n');f.flush();os.fsync(f.fileno())
    os.chown(name,0,1000);os.chmod(name,0o640);os.replace(name,TARGET)
finally:
    if os.path.exists(name):os.unlink(name)
print(json.dumps({'state':result['state'],'lastAttemptAt':result['lastAttemptAt'],'lastSuccessAt':result.get('lastSuccessAt')}))
