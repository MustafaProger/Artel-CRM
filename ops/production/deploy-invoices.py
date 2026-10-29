#!/usr/bin/env python3
"""Guarded CRM-only cutover. Reads a reviewed private release plan; never restores old data."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

ROOT = Path('/opt/artel-crm')
os.umask(0o077)
parser = argparse.ArgumentParser()
parser.add_argument('release', type=Path)
parser.add_argument('--config-sha256', required=True)
parser.add_argument('--execute', action='store_true')
args = parser.parse_args()
if not args.execute:
    parser.error('Inspect the exact release plan and proofs before --execute')
release = args.release.resolve()
assert release.parent == ROOT / 'releases' and re.fullmatch(r'20261020-invoices-[a-f0-9]{8}', release.name)
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
assert sha(release / 'invoice-deploy-plan.json') == args.config_sha256
plan = json.loads((release / 'invoice-deploy-plan.json').read_text())
assert plan['releaseName'] == release.name
out = lambda cmd, **kw: subprocess.check_output(cmd, text=True, **kw).strip()
run = lambda cmd, **kw: subprocess.run(cmd, check=True, **kw)
save = lambda name, data: (release / name).write_text(json.dumps(data, indent=2) + '\n')
assert not (release / 'invoice-cutover-started.json').exists(), 'Inspect an interrupted cutover; never repeat blindly'
for filename, digest in plan['artifactHashes'].items():
    path = Path(filename)
    assert not path.is_absolute() and '..' not in path.parts and not (release / path).is_symlink()
    assert sha(release / path) == digest, 'Reviewed artifact changed'
for name in ['local-checks.json', 'worker-pdf-acceptance.json', 'image-proof.json', 'public-secret-scan.json']:
    assert name in plan['artifactHashes']
    assert json.loads((release / name).read_text())['passed'] is True
for name in ['compose.invoice.yaml', 'runtime.invoice.env', 'source-manifest.json', 'source-proof.json', 'verify-invoice-quiescence.mjs', 'verify-invoice-preservation.mjs']:
    assert name in plan['artifactHashes']
for key in ['image', 'rollbackImage', 'expectedImage']:
    assert re.fullmatch(r'artel-crm:[A-Za-z0-9_.-]+', plan[key])
assert plan['image'] == 'artel-crm:' + release.name
assert plan['rollbackImage'] == plan['image'] + '-ui-rollback'
assert plan['rollbackBackendSha256'] == plan['serverBundleSha256']
assert plan['sourceManifestSha256'] == sha(release / 'source-manifest.json')
assert plan['sourceProofSha256'] == sha(release / 'source-proof.json')
mapping = Path(plan['mappingFile']).resolve()
assert mapping == Path('/opt/artel-invoices/secrets/owners.json')
assert sha(mapping) == plan['mappingSha256']
compose = ['docker', 'compose', '--project-directory', str(ROOT)]
locks = []
for name in ['.runtime-env.lock', 'secrets/.runtime-env.lock']:
    lock = (ROOT / name).open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    locks.append(lock)
assert out(['docker', 'inspect', '--format', '{{.Config.Image}}', 'artel-crm-crm-1']) == plan['expectedImage']
assert out(['docker', 'inspect', '--format', '{{.Image}}', 'artel-crm-crm-1']) == plan['expectedImageId']
assert sha(ROOT / 'release.json') == plan['expectedReleaseSha256'], 'Production release drifted'
assert sha(ROOT / 'compose.yaml') == plan['expectedComposeSha256']
assert sha(ROOT / 'secrets/runtime.env') == plan['expectedRuntimeSha256']
assert out(['docker', 'exec', 'artel-crm-crm-1', 'id', '-u']) == '1000'
for key in ['image', 'rollbackImage']:
    assert out(['docker', 'image', 'inspect', '--format', '{{.Id}}', plan[key]]) == plan[key + 'Id']
    assert out(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', plan[key], '/app/server-render/production.mjs']).split()[0] == plan['serverBundleSha256']
runtime_before = (ROOT / 'secrets/runtime.env').read_bytes()
runtime_after = (release / 'runtime.invoice.env').read_bytes()
def env_map(raw):
    rows = [line for line in raw.decode().splitlines() if line and not line.startswith('#')]
    assert all('=' in line for line in rows)
    result = dict(line.split('=', 1) for line in rows)
    assert len(result) == len(rows)
    return result
old, new = env_map(runtime_before), env_map(runtime_after)
allowed = {'ARTEL_INVOICES_URL', 'ARTEL_INVOICES_BRIDGE_KEY_FILE'}
assert {k: v for k, v in old.items() if k not in allowed} == {k: v for k, v in new.items() if k not in allowed}
assert new['ARTEL_INVOICES_URL'] == 'http://invoices:4318'
assert new['ARTEL_INVOICES_BRIDGE_KEY_FILE'] == '/run/secrets/invoices-bridge.key'
keyfile = Path('/opt/artel-crm/secrets/invoices-bridge.key')
assert keyfile.is_file() and keyfile.stat().st_uid == 1000 and keyfile.stat().st_mode & 0o077 == 0
assert re.fullmatch(rb'[a-f0-9]{64}\n?', keyfile.read_bytes())
assert sha(keyfile) == plan['bridgeKeySha256']
env_before = (ROOT / '.env').read_bytes()
lines = env_before.decode().splitlines(keepends=True)
assert sum(line.startswith('ARTEL_IMAGE=') for line in lines) == 1
assert next(line.strip().split('=', 1)[1] for line in lines if line.startswith('ARTEL_IMAGE=')) == plan['expectedImage']
def inventory():
    ids = out(['docker', 'ps', '-q']).splitlines()
    neighbors = sorted(line for line in out(['docker', 'inspect', '--format', '{{.Name}}|{{.Id}}|{{.State.StartedAt}}', *ids]).splitlines() if not line.startswith('/artel-crm-crm-1|'))
    files = [Path('/etc/caddy/Caddyfile'), *sorted(Path('/etc/caddy/sites-enabled').glob('*')), *sorted((ROOT / 'data/snapshot').rglob('*'))]
    return {'neighbors': neighbors, 'protectedHashes': {str(p): sha(p) for p in files if p.is_file()}, 'caddyPid': out(['systemctl', 'show', 'caddy', '-p', 'MainPID', '--value'])}
before_inventory = inventory()
run(compose + ['config', '--quiet'])
run(['systemctl', 'start', 'artel-crm-backup.service'])
assert out(['systemctl', 'show', 'artel-crm-backup.service', '-p', 'Result', '--value']) == 'success'
assert out(['systemctl', 'show', 'artel-crm-backup.service', '-p', 'ExecMainStatus', '--value']) == '0'
backup = max((ROOT / 'backups').glob('artel-crm-*.tar.gz'), key=lambda p: p.stat().st_mtime)
assert time.time() - backup.stat().st_mtime < 180
run(['tar', '-tzf', str(backup)], stdout=subprocess.DEVNULL)
# Explicit pre-cutover readiness proof is separate from the backup, and must be fresh.
assert time.time() - (release / 'worker-pdf-acceptance.json').stat().st_mtime < 86400
save('invoice-cutover-started.json', {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'backup': str(backup), 'inventory': before_inventory})
for name, content in [('compose.before.yaml', (ROOT / 'compose.yaml').read_bytes()), ('runtime.before.private.env', runtime_before), ('image.before.env', env_before), ('metadata.before.json', (ROOT / 'release.json').read_bytes())]:
    (release / name).write_bytes(content)
run(compose + ['stop', '--timeout', '630', 'crm'])
stopped_state = json.loads(out(['docker', 'inspect', '--format', '{{json .State}}', 'artel-crm-crm-1']))
save('invoice-stopped-state.json', stopped_state)
raw_before = (ROOT / 'data/operations/operations.json').read_bytes()
(release / 'operations-before.private.json').write_bytes(raw_before)
assert stopped_state['Running'] is False and stopped_state['ExitCode'] == 0 and stopped_state['OOMKilled'] is False and not stopped_state['Error'], 'CRM did not drain cleanly; inspect stopped snapshot before proceeding'
audit = subprocess.run(['docker', 'run', '--rm', '-i', '--network', 'none', '--read-only',
    '--user', '0:0', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--memory', '128m', '--cpus', '0.5', '--entrypoint', 'node',
    '--mount', f'type=bind,source={release}/operations-before.private.json,target=/snapshot.json,readonly',
    plan['image'], '--input-type=module', '-', '/snapshot.json'],
    input=(release / 'verify-invoice-quiescence.mjs').read_text(), text=True, capture_output=True)
(release / 'invoice-quiescence-proof.json').write_text(audit.stdout)
assert audit.returncode == 0 and json.loads(audit.stdout)['passed'], 'Outstanding bank/Saby/ETRN lease after stop; inspect before any grant or restart'
try:
    grant = out([
        'docker', 'run', '--rm', '--network', 'none', '--read-only', '--memory', '512m', '--cpus', '1', '--pids-limit', '128',
        '--tmpfs', '/tmp:size=32m,mode=1777', '-e', 'ARTEL_STORE_DIR=/var/lib/artel/operations', '-e', 'ARTEL_INVOICES_MAINTENANCE=true',
        '--mount', f'type=bind,source={ROOT}/data/operations,target=/var/lib/artel/operations',
        '--mount', f'type=bind,source={mapping},target=/run/secrets/invoice-owners.json,readonly',
        plan['image'], 'node', '/app/server-render/grant-invoice-access.mjs', '--execute',
        '--mapping', '/run/secrets/invoice-owners.json', '--expected-sha256', hashlib.sha256(raw_before).hexdigest(),
    ])
    grant_proof = json.loads(grant)
    assert grant_proof['exactAdditiveChangeVerified'] and grant_proof['sessionsPasswordsAndOtherDataPreserved']
    save('invoice-grant-proof.json', grant_proof)
    (release / 'operations-after-grant.private.json').write_bytes((ROOT / 'data/operations/operations.json').read_bytes())
    for destination, content in [
        (ROOT / 'compose.yaml', (release / 'compose.invoice.yaml').read_bytes()),
        (ROOT / 'secrets/runtime.env', runtime_after),
        (ROOT / '.env', ''.join('ARTEL_IMAGE=' + plan['image'] + '\n' if line.startswith('ARTEL_IMAGE=') else line for line in lines).encode()),
    ]:
        temporary = destination.with_name(destination.name + '.invoice-next')
        with temporary.open('xb') as stream:
            stream.write(content); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, destination)
    run(compose + ['config', '--quiet'])
    run(compose + ['up', '-d', '--no-build', '--pull', 'never', '--timeout', '600', 'crm'])
    for _ in range(30):
        health = out(['docker', 'inspect', '--format', '{{.State.Health.Status}}', 'artel-crm-crm-1'])
        if health == 'healthy': break
        if health == 'unhealthy': raise RuntimeError('CRM unhealthy')
        time.sleep(2)
    assert health == 'healthy'
    assert out(['docker', 'inspect', '--format', '{{.Image}}', 'artel-crm-crm-1']) == plan['imageId']
    assert out(['docker', 'exec', 'artel-crm-crm-1', 'sha256sum', '/app/server-render/production.mjs']).split()[0] == plan['serverBundleSha256']
    assert inventory() == before_inventory, 'Neighbor/Caddy/snapshot preservation failed'
    (release / 'operations-after.private.json').write_bytes((ROOT / 'data/operations/operations.json').read_bytes())
    comparison = subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--read-only',
        '--user', '0:0', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--memory', '128m', '--cpus', '0.5', '--entrypoint', 'node',
        '--mount', f'type=bind,source={release},target=/release,readonly',
        '--mount', f'type=bind,source={mapping},target=/mapping.json,readonly',
        plan['image'], '/release/verify-invoice-preservation.mjs',
        '/release/operations-before.private.json', '/release/operations-after.private.json', '/mapping.json'],
        text=True, capture_output=True)
    (release / 'invoice-preservation-proof.json').write_text(comparison.stdout)
    assert comparison.returncode == 0 and json.loads(comparison.stdout)['dataPreservationPassed'], 'Preservation flags require classification; latest data retained'
    metadata = {key: plan[key] for key in ['releaseName', 'image', 'imageId', 'rollbackImage', 'rollbackImageId', 'serverBundleSha256', 'sourceManifestSha256', 'sourceProofSha256']}
    metadata.update(previousImage=plan['expectedImage'], rollbackScope='previous_ui_with_candidate_backend', configSha256=args.config_sha256, updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), invoiceAccessGrant=grant_proof, authenticatedProductionUiVerified=False)
    save('release.json', metadata)
    temporary = ROOT / 'release.invoice-next.json'
    temporary.write_bytes((release / 'release.json').read_bytes()); os.replace(temporary, ROOT / 'release.json')
    print(json.dumps({'healthy': True, 'imageIdVerified': True, 'grantVerified': True, 'neighborsAndCaddyPreserved': True, 'dataPreservationPassed': True, 'cleanShutdownVerified': True, 'workflowLeasesAbsent': True}))
except Exception:
    print('Cutover stopped for inspection. Latest data retained; no old backend or data was restored.')
    raise
