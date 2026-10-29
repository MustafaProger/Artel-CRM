"""Read frozen release evidence; emit a sanitized comparison. Never write files or metadata."""
import argparse
import copy
import hashlib
import json
import re
import subprocess
from pathlib import Path

BANK_KEYS = ('banking', 'sber', 'sberArtel')
POLL_KEYS = {'updatedAt', 'syncedAt', 'lastSuccessAt', 'lastScheduledAt', 'lastAttemptAt', 'requestNotBefore', 'lastCompletedPeriod', 'lease', 'job'}
FACT_KEYS = ('shipments', 'companies', 'directories', 'paymentAllocations', 'accounts', 'china', 'work', 'operator', 'tripNumbers', 'tripCreateRequests', 'tripRequests', 'tripRequestCreates', 'driverTripProgress', 'tripExecutions')


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def equal(left, right):
    return canonical(left) == canonical(right)


def safe(key):
    return key if re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_]{0,35}|\d+', key) else '#' + digest(key)[:12]


def array_key(values):
    if values and all(isinstance(row, dict) and isinstance(row.get('id'), str) and row['id'] for row in values):
        return 'id'
    if values and all(isinstance(row, dict) and isinstance(row.get('date'), str) and row['date'] for row in values):
        return 'date'
    return None


def normalize_bank(value):
    if isinstance(value, dict):
        return {key: normalize_bank(child) for key, child in value.items() if key not in POLL_KEYS}
    if isinstance(value, list):
        rows = [normalize_bank(row) for row in value]
        key = array_key(rows)
        if key and len({row[key] for row in rows}) == len(rows):
            rows.sort(key=lambda row: row[key])
        return rows
    return value


def compare_banks(before, after):
    arrays, issues = [], []

    def walk(left, right, path):
        if isinstance(left, dict) and isinstance(right, dict):
            for key in sorted(set(left) | set(right)):
                if key not in POLL_KEYS:
                    walk(left.get(key), right.get(key), path + '/' + safe(key))
        elif isinstance(left, list) and isinstance(right, list):
            key = array_key(left + right)
            if not key:
                if left or right:
                    arrays.append({'path': path, 'stableKey': None, 'beforeCount': len(left), 'afterCount': len(right), 'exactEqualExceptPolling': equal(normalize_bank(left), normalize_bank(right))})
                return
            old, new = {row[key]: row for row in left}, {row[key]: row for row in right}
            if len(old) != len(left) or len(new) != len(right):
                issues.append({'path': path, 'reason': 'duplicate_stable_identifier', 'stableKey': key})
                return
            common = set(old) & set(new)
            modified = {item for item in common if not equal(normalize_bank(old[item]), normalize_bank(new[item]))}
            added, removed = set(new) - set(old), set(old) - set(new)
            arrays.append({'path': path, 'stableKey': key, 'beforeCount': len(left), 'afterCount': len(right),
                           'unchangedStoredRecords': len(common) - len(modified), 'added': len(added), 'removed': len(removed), 'modified': len(modified),
                           'changedEntryHashes': sorted(digest(item) for item in added | removed | modified)})
            for item in sorted(common):
                walk(old[item], new[item], path + '/#' + digest(item)[:12])

    old = {key: before.get(key) for key in BANK_KEYS}
    new = {key: after.get(key) for key in BANK_KEYS}
    walk(old, new, 'banks')
    return {'exactEqual': equal(old, new), 'equalByStableIdAndDateExceptPolling': equal(normalize_bank(old), normalize_bank(new)) and not issues,
            'storedRecordArrays': arrays, 'issues': issues}


def accounts_without_activity(value):
    result = copy.deepcopy(value)
    if isinstance(result, dict):
        result.pop('sessions', None)
        result.pop('attempts', None)
    return result


def compare_phase(release, phase, audit_runtime_container=None):
    inputs = {}

    def read(name):
        raw = (release / name).read_bytes()
        inputs[name] = sha(raw)
        return raw

    before_raw, after_raw = read('before-operations.private.json'), read(phase + '-operations.private.json')
    before_envelope, after_envelope = json.loads(before_raw), json.loads(after_raw)
    before, after = before_envelope['data'], after_envelope['data']
    before_state, after_state = json.loads(read('before-state.json')), json.loads(read(phase + '-state.json'))
    if sha(before_raw) != before_state['rawStoreSha256'] or sha(after_raw) != after_state['rawStoreSha256']:
        raise ValueError('Private store snapshot does not match captured state SHA')
    saved_audit = json.loads(read(phase + '-preservation.json'))
    config = json.loads(read('config.json'))
    audit_source = read('audit-data.mjs')
    if sha(audit_source) != config['deployHelperHashes']['audit-data.mjs']:
        raise ValueError('Audit helper differs from frozen config')
    node = ['docker', 'exec', '-i', audit_runtime_container, 'node'] if audit_runtime_container else ['node']
    checked = subprocess.run([*node, '--input-type=module', '--eval', audit_source.decode()],
                             input=json.dumps({'before': before_envelope, 'after': after_envelope}), text=True, capture_output=True, timeout=60)
    if checked.returncode != 0:
        raise ValueError('Frozen audit helper rejected snapshot checksums')
    audit = json.loads(checked.stdout)
    if any(not equal(saved_audit.get(key), value) for key, value in audit.items()):
        raise ValueError('Fresh audit differs from captured preservation audit')
    banks = compare_banks(before, after)
    facts = {key: equal(before.get(key), after.get(key)) for key in FACT_KEYS}
    if facts != audit['checks']['facts']:
        raise ValueError('Independent exact fact comparison differs from frozen audit')
    account_business_equal = equal(accounts_without_activity(before.get('accounts')), accounts_without_activity(after.get('accounts')))
    changes = []
    for row in audit['differences']:
        reviewed = row['classification']
        if reviewed == 'requires_review' and row['path'].startswith(tuple(key + '/' for key in BANK_KEYS)) and banks['equalByStableIdAndDateExceptPolling']:
            reviewed = 'bank_order_or_polling_confirmed_by_stable_records'
        changes.append({**row, 'independentClassification': reviewed})
    remaining = sum(row['independentClassification'] == 'requires_review' for row in changes)
    protected_equal = equal(before_state['protectedFiles'], after_state['protectedFiles'])
    worker_changes = sorted(key for key in set(before_state['workerFiles']) | set(after_state['workerFiles']) if before_state['workerFiles'].get(key) != after_state['workerFiles'].get(key))
    worker_container_equal = all('/artel-invoices-invoices-1' in state['containers'] for state in [before_state, after_state]) and equal(before_state['containers']['/artel-invoices-invoices-1'], after_state['containers']['/artel-invoices-invoices-1'])
    def neighbors(state):
        return {key: value for key, value in state['containers'].items() if key not in ['/artel-crm-crm-1', '/artel-invoices-invoices-1']}
    neighbors_equal = equal(neighbors(before_state), neighbors(after_state)) and before_state['caddyPid'] == after_state['caddyPid']
    for key, value in [('protectedFilesUnchanged', protected_equal), ('otherServicesUnchanged', neighbors_equal), ('workerFilesUnchanged', not worker_changes)]:
        if saved_audit[key] != value:
            raise ValueError('Captured file or service comparison differs from independent evidence')
    if set(saved_audit['workerFileChanges']) != set(worker_changes):
        raise ValueError('Captured worker change list differs from independent evidence')
    bridge = {'available': False, 'unexplainedChanges': 1, 'classification': 'requires_review_missing_private_snapshot'}
    if all(state.get('workerBridgeAuth', {}).get('present') for state in [before_state, after_state]):
        old_bridge, new_bridge = read('before-worker-bridge-auth.private.json'), read(phase + '-worker-bridge-auth.private.json')
        for raw, state in [(old_bridge, before_state), (new_bridge, after_state)]:
            if sha(raw) != state['workerBridgeAuth']['sha256'] or sha(raw) != state['workerFiles']['crm-bridge/auth.json']:
                raise ValueError('Worker bridge snapshot does not match captured hashes')
        namespace = {}
        bridge_source = read('worker-bridge-audit.py')
        if sha(bridge_source) != config['deployHelperHashes']['worker-bridge-audit.py']:
            raise ValueError('Worker bridge helper differs from frozen config')
        exec(compile(bridge_source, 'worker-bridge-audit.py', 'exec'), namespace)
        bridge = namespace['compare_bridge'](old_bridge, new_bridge, after_state['at'])
        if not equal(bridge, saved_audit.get('workerBridgeAuth')):
            raise ValueError('Fresh worker bridge classification differs from saved audit')
    non_bridge_equal = set(worker_changes) <= {'crm-bridge/auth.json'}
    business_facts_equal = all(value or key == 'accounts' and account_business_equal for key, value in facts.items())
    crm_preserved = business_facts_equal and banks['equalByStableIdAndDateExceptPolling'] and audit['checks']['workflowDocumentsAndAuthorizationUnchanged'] and audit['checks']['revisionNotRewound'] and remaining == 0
    return {'phase': phase, 'inputSha256': inputs, 'rawStrictDataEqual': saved_audit['strictDataEqual'],
            'rawUnexplainedChanges': saved_audit['unexplainedChanges'], 'exactFacts': facts,
            'accountsBusinessFactsExcludingSessionActivityUnchanged': account_business_equal, 'banks': banks,
            'workflowDocumentsAndAuthorizationUnchanged': audit['checks']['workflowDocumentsAndAuthorizationUnchanged'],
            'revisionNotRewound': audit['checks']['revisionNotRewound'], 'classifiedChanges': changes,
            'classifiedCrmUnexplainedChanges': remaining, 'crmBusinessFactsPreserved': crm_preserved,
            'protectedFilesUnchanged': protected_equal, 'otherServicesUnchanged': neighbors_equal,
            'workerContainerUnchanged': worker_container_equal, 'workerFilesUnchanged': not worker_changes,
            'workerFileChanges': worker_changes, 'workerNonBridgeFilesUnchanged': non_bridge_equal, 'workerBridgeAuth': bridge,
            'allReviewedInvariantsPassed': crm_preserved and protected_equal and neighbors_equal and worker_container_equal and non_bridge_equal and bridge['unexplainedChanges'] == 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('release', type=Path)
    parser.add_argument('phases', nargs='+', choices=['after', 'after-ui'])
    parser.add_argument('--config-sha256', required=True)
    parser.add_argument('--audit-runtime-container', help='Run the pure audit through the existing container Node binary; no application API or file writes.')
    args = parser.parse_args()
    if sha((args.release / 'config.json').read_bytes()) != args.config_sha256:
        raise ValueError('Release config SHA differs from authorized package')
    result = {'readOnly': True, 'metadataWritten': False, 'phases': {phase: compare_phase(args.release, phase, args.audit_runtime_container) for phase in args.phases}}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
