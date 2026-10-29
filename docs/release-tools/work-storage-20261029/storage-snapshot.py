"""Consistent complete snapshots for flat and Work-partitioned stores; no secret output."""
import json,subprocess
from pathlib import Path

def read_operations(root=Path('/opt/artel-crm'), offline_image=None):
    raw=(root/'data/operations/operations.json').read_bytes()
    if json.loads(raw).get('format')!='artel-work-partition-v1':return raw
    running=subprocess.check_output(['docker','inspect','--format','{{.State.Running}}','artel-crm-crm-1'],text=True).strip()=='true'
    if running:
        cmd=['docker','exec','artel-crm-crm-1','node','/app/server-render/export-operations.mjs']
    else:
        assert offline_image, 'Stopped split-store export requires an explicitly verified image'
        cmd=['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','1000:1000','--tmpfs','/tmp:mode=1777,size=32m','-v',str(root/'data/operations')+':/var/lib/artel/operations','-v',str(root/'data/snapshot')+':/var/lib/artel/snapshot:ro','-e','ARTEL_STORE_DIR=/var/lib/artel/operations','-e','ARTEL_SNAPSHOT_DIR=/var/lib/artel/snapshot',offline_image,'node','/app/server-render/export-operations.mjs']
    result=subprocess.run(cmd,capture_output=True,timeout=120)
    if result.returncode:raise RuntimeError('Consistent snapshot export failed; inspect private runtime state')
    envelope=json.loads(result.stdout);assert isinstance(envelope.get('data'),dict) and isinstance(envelope.get('sha256'),str)
    return result.stdout
