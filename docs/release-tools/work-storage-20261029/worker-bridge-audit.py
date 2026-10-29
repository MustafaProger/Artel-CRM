"""Compare private worker bridge snapshots; return hashes/counts, never identities or tokens."""
import datetime, hashlib, json, re
HASH = re.compile(r'^[a-f0-9]{64}$')
UUID = re.compile(r'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$')
ID = re.compile(r'^[a-zA-Z0-9_-]{1,128}$')
def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
def exact(value, fields):
    return isinstance(value, dict) and set(value) == set(fields)
def timestamp(value):
    return type(value) is int and 0 <= value <= 9007199254740991
def valid(value):
    if not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] not in [1, 2]: return False
    keys = ['version', 'mappingHash', 'nonces', 'revokedSessions'] + (['owners'] if value['version'] == 2 else [])
    if not exact(value, keys) or not isinstance(value['mappingHash'], str) or not HASH.fullmatch(value['mappingHash']): return False
    for field, names, key, pattern, stamp in [
        ('nonces', ['id', 'expiresAt'], 'id', UUID, 'expiresAt'),
        ('revokedSessions', ['hash', 'revokedAt'], 'hash', HASH, 'revokedAt'),
        *([('owners', ['crmUserId', 'invoiceOwnerId'], 'crmUserId', ID, None)] if value['version'] == 2 else []),
    ]:
        rows=value[field]
        if not isinstance(rows, list) or len(rows) > (10000 if field == 'owners' else 20000): return False
        if field == 'owners' and len(rows) < 2: return False
        for row in rows:
            if not exact(row,names) or not isinstance(row[key],str) or not pattern.fullmatch(row[key]): return False
            if stamp and not timestamp(row[stamp]): return False
            if field == 'owners' and (not isinstance(row['invoiceOwnerId'],str) or not UUID.fullmatch(row['invoiceOwnerId'])): return False
        if len({row[key] for row in rows}) != len(rows): return False
        if field == 'owners' and len({row['invoiceOwnerId'] for row in rows}) != len(rows): return False
    return True

def compare_bridge(before_raw, after_raw, captured_at):
    result={'available':True, 'rawBytesUnchanged':before_raw==after_raw,
            'beforeSha256':hashlib.sha256(before_raw).hexdigest(), 'afterSha256':hashlib.sha256(after_raw).hexdigest(),
            'validatedSchema':False, 'unexplainedChanges':0, 'fieldChanges':[]}
    try:
        before,after=json.loads(before_raw),json.loads(after_raw)
        cutoff=int(datetime.datetime.fromisoformat(captured_at.replace('Z','+00:00')).timestamp()*1000)
        assert valid(before) and valid(after)
    except (ValueError, TypeError, AssertionError, AttributeError):
        result.update(unexplainedChanges=1, classification='requires_review_invalid_schema_or_capture_time')
        return result
    result['validatedSchema']=True
    for field in sorted(set(before)|set(after)):
        old,new=before.get(field),after.get(field)
        if old == new: continue
        change={'field':field, 'beforeHash':digest(old), 'afterHash':digest(new), 'classification':'requires_review'}
        if field in ['nonces','owners','revokedSessions'] and isinstance(old,list) and isinstance(new,list):
            key={'nonces':'id','owners':'crmUserId','revokedSessions':'hash'}[field]
            old_map={r[key]:r for r in old};new_map={r[key]:r for r in new}
            added=set(new_map)-set(old_map);removed=set(old_map)-set(new_map)
            modified={k for k in set(old_map)&set(new_map) if old_map[k] != new_map[k]}
            change.update(beforeCount=len(old),afterCount=len(new),added=len(added),removed=len(removed),modified=len(modified),
                          changedEntryHashes=sorted(digest(k) for k in added|removed|modified))
            if not added and not removed and not modified:
                change['classification']='entry_order_only'
            elif field == 'nonces' and not modified and all(old_map[k]['expiresAt'] <= cutoff for k in removed):
                change['classification']='request_nonce_journal'
            if field == 'nonces':
                change['removedEntriesExpiredAtAfterCapture']=all(old_map[k]['expiresAt'] <= cutoff for k in removed)
        result['fieldChanges'].append(change)
    result['unexplainedChanges']=sum(c['classification']=='requires_review' for c in result['fieldChanges'])
    result['identityAndRevocationsUnchanged']=all(c['field']=='nonces' or c['classification']=='entry_order_only' for c in result['fieldChanges'])
    result['onlyRequestNonceJournalChanged']=all(c['field']=='nonces' and c['classification'] in ['request_nonce_journal','entry_order_only'] for c in result['fieldChanges'])
    return result
