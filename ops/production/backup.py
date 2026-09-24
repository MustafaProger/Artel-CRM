#!/usr/bin/env python3
"""Back up only this CRM; validate the atomic operations envelope before archiving."""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path('/opt/artel-crm')
os.umask(0o077)
destination = ROOT / 'backups'
destination.mkdir(mode=0o700, exist_ok=True)
with (destination / '.backup.lock').open('w') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    # OperationsStore replaces whole files atomically, so this read is a single revision.
    raw = (ROOT / 'data/operations/operations.json').read_bytes()
    envelope = json.loads(raw)
    if not isinstance(envelope.get('data'), dict) or not isinstance(envelope.get('sha256'), str):
        raise RuntimeError('Invalid operations envelope; no backup published')
    # Use JavaScript serialization, exactly as OperationsStore does; never put data in argv/logs.
    check = "let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>raw+=s);process.stdin.on('end',()=>{try{const e=JSON.parse(raw);if(require('crypto').createHash('sha256').update(JSON.stringify(e.data)).digest('hex')!==e.sha256)process.exit(2)}catch{process.exit(2)}})"
    verified = subprocess.run(['docker', 'compose', '--project-directory', str(ROOT),
                               'exec', '-T', 'crm', 'node', '-e', check], input=raw, capture_output=True)
    if verified.returncode:
        raise RuntimeError('Operations checksum could not be verified; no backup published')
    if shutil.disk_usage(ROOT).free < max(1024**3, len(raw) * 3):
        raise RuntimeError('Less than the CRM backup safety reserve is available')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    final = destination / f'artel-crm-{stamp}.tar.gz'
    with tempfile.TemporaryDirectory(prefix='.backup-', dir=destination) as temporary:
        folder = Path(temporary)
        (folder / 'operations.json').write_bytes(raw)
        manifest = {'createdAt': stamp, 'revision': envelope['data']['revision'],
                    'operationsSha256': hashlib.sha256(raw).hexdigest()}
        (folder / 'manifest.json').write_text(json.dumps(manifest))
        archive = folder / 'backup.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            tar.add(folder / 'operations.json', arcname='data/operations/operations.json')
            tar.add(folder / 'manifest.json', arcname='backup-manifest.json')
            for relative in ['data/snapshot', 'secrets/runtime.env', 'compose.yaml', '.env', 'release.json']:
                path = ROOT / relative
                if path.exists():
                    tar.add(path, arcname=relative)
        with tarfile.open(archive, 'r:gz') as tar:
            if hashlib.sha256(tar.extractfile('data/operations/operations.json').read()).hexdigest() != manifest['operationsSha256']:
                raise RuntimeError('Backup verification failed')
        os.replace(archive, final)
    # Keep 72 recent hourly copies and one per day for 30 days, only our exact filenames.
    archives = sorted((p for p in destination.iterdir() if p.is_file() and not p.is_symlink()
                       and re.fullmatch(r'artel-crm-\d{8}T\d{6}\.\d{6}Z\.tar\.gz', p.name)), reverse=True)
    keep = set(archives[:72])
    days = set()
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=30)
    for path in archives:
        moment = datetime.datetime.strptime(path.name[10:-7], '%Y%m%dT%H%M%S.%fZ').replace(tzinfo=datetime.timezone.utc)
        if moment >= cutoff and moment.date() not in days:
            keep.add(path)
            days.add(moment.date())
    for path in archives:
        if path not in keep:
            path.unlink()
    print(f'CRM backup verified: {final.name}; revision {manifest["revision"]}')
