"""Pin direct trip 30 facts/history while recording its authorized workflow changes as pending review."""
import copy
import hashlib
import json
import re

TARGET = 'shipment-trip-1ba13267-09b9-4cf9-a4cc-0e72fa511f7e'
SOURCE = 'shipment-trip-20d93bd0-7538-4160-a468-e3393f31b9f0'
NATIVE = {'shipment-local-0cfd1a1a-ccc8-4ab4-83b6-13d5f5698290': ('056bead2-e8be-4e76-99f1-da2d9b2fcc61', '2'),
          'shipment-local-d006ccac-f112-4cc2-a25c-f8de86370341': ('9557107b-f14e-44bb-a856-23b79c7949e4', '3')}
DOC_RUNTIME = {'revision', 'url', 'remoteStatus', 'lastError', 'updatedAt', 'signatureStatus', 'gisStatus', 'availableActions', 'artifacts', 'leaseId', 'leaseUntil', 'dispatch'}
DIRECT_RUNTIME = {'phase', 'lastError', 'updatedAt', 'leaseId', 'leaseUntil', 'lastCheckedAt', 'lastCheckAttemptAt', 'completedAt'}
POLL = {'updatedAt', 'leaseId', 'leaseUntil'}
def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()
def equal(left, right):
    return canonical(left) == canonical(right)
def without(value, fields):
    return {key: child for key, child in value.items() if key not in fields}
def normalized_workflows(data, remove_target=False):
    value = copy.deepcopy({key: data.get(key) for key in ['tripSaby', 'etrn']})
    for trip in (value.get('tripSaby') or {}).get('trips', {}).values():
        for key in ['updatedAt', 'lastCheckedAt', 'lastCheckAttemptAt', 'leaseId', 'leaseUntil']:
            trip.pop(key, None)
        for key, child in [('carrierFill', 'checkedAt'), ('carrierEvidence', 'confirmedAt')]:
            if isinstance(trip.get(key), dict): trip[key].pop(child, None)
    trips = (value.get('etrn') or {}).get('trips', {})
    if remove_target: trips.pop(TARGET, None)
    for trip in trips.values():
        trip.pop('updatedAt', None)
        if isinstance(trip.get('direct'), dict):
            for key in ['updatedAt', 'lastCheckedAt', 'lastCheckAttemptAt', 'leaseId', 'leaseUntil']: trip['direct'].pop(key, None)
        for delivery in trip.get('deliveries', {}).values():
            delivery.pop('updatedAt', None)
            if isinstance(delivery.get('document'), dict):
                for key in POLL: delivery['document'].pop(key, None)
    return value
def immutable_target(data):
    trip = copy.deepcopy(data['etrn']['trips'][TARGET])
    trip.pop('updatedAt', None)
    trip['direct'] = without(trip['direct'], DIRECT_RUNTIME)
    for row in trip['deliveries'].values():
        row.pop('updatedAt', None)
        row['document'] = without(row['document'], DOC_RUNTIME | {'writeAttempts'})
    return trip
def original27_projection(data):
    # Only the eight paths observed in the saved 136b after/after-ui raw deltas.
    # Top-level updatedAt and direct.lastCheckedAt remain exact.
    trip = copy.deepcopy(data['etrn']['trips'][SOURCE])
    for key in ['updatedAt', 'lastCheckAttemptAt', 'leaseId', 'leaseUntil']:
        trip.get('direct', {}).pop(key, None)
    for delivery in trip.get('deliveries', {}).values():
        delivery.pop('updatedAt', None)
        if isinstance(delivery.get('document'), dict):
            for key in POLL: delivery['document'].pop(key, None)
    return trip
def capture_guard(data):
    trip = data['etrn']['trips'][TARGET]
    assert set(trip['deliveries']) == set(NATIVE)
    for row, (identifier, number) in NATIVE.items():
        document = trip['deliveries'][row]['document']
        evidence = document['nativeAdoptionEvidence']
        assert document['id'] == identifier and document['number'] == number and document['status'] == 'draft'
        assert evidence['holdForReview'] is False and evidence['stage'] == 'verified'
        assert evidence['nativeDocumentId'] == identifier and evidence['originalAttemptId'] == document['attemptId'] and evidence['originalMarker'] == document['marker']
    return {'version': 'target30-release-guard-v1', 'tripId': TARGET,
        'immutableTargetSha256': digest(immutable_target(data)),
        'authorizationSha256': digest(trip['direct']['authorization']),
        'targetShipmentsSha256': digest({row: data['shipments'][row] for row in NATIVE}),
        'targetDriverProgressSha256': digest(data.get('driverTripProgress', {}).get(TARGET)),
        'original27ExceptExactPollingSha256': digest(original27_projection(data)),
        'writeAttemptPrefixes': {row: {'count': len(trip['deliveries'][row]['document'].get('writeAttempts', [])),
                                      'sha256': digest(trip['deliveries'][row]['document'].get('writeAttempts', []))} for row in NATIVE}}
def check_guard(data, guard):
    current = capture_guard(data)
    assert equal(without(current, {'writeAttemptPrefixes'}), without(guard, {'writeAttemptPrefixes'})), 'Pinned target facts, adoption history, grant or original 27 changed'
    for row, prefix in guard['writeAttemptPrefixes'].items():
        attempts = data['etrn']['trips'][TARGET]['deliveries'][row]['document'].get('writeAttempts', [])
        assert len(attempts) >= prefix['count'] and digest(attempts[:prefix['count']]) == prefix['sha256'], 'Prior write history changed'
        assert all(attempt.get('action') == 'upload' and attempt.get('result', {}).get('id', NATIVE[row][0]) == NATIVE[row][0] for attempt in attempts[prefix['count']:]), 'New reservation or different document result is forbidden'
def dispatch_checks(old, new, identifier):
    issues = []
    if old and not new: return ['dispatch_removed']
    if not new: return []
    for side in ['sender', 'carrier']:
        before, after = (old or {}).get(side, {}), new.get(side, {})
        if before.get('executeAttempted') and after.get('executeAttempted') is not True: issues.append(side + '_execute_flag_reset')
        if before.get('prepared') is not None and not equal(before['prepared'], after.get('prepared')): issues.append(side + '_prepared_receipt_replaced')
        if before.get('state') == 'confirmed' and after.get('state') != 'confirmed': issues.append(side + '_confirmation_reset')
        binding, prepared = after.get('binding'), after.get('prepared')
        if binding and (binding.get('documentId') != identifier or binding.get('documentType') != 'ConsignmentNote' or binding.get('side') != side): issues.append(side + '_binding_identity')
        if prepared and not equal(prepared.get('binding'), binding): issues.append(side + '_manifest_binding')
        if after.get('verified') and not prepared: issues.append(side + '_verified_without_manifest')
        if after.get('executeAttempted') and (not prepared or after.get('verified') is not True): issues.append(side + '_execution_without_verified_manifest')
        if after.get('state') == 'confirmed' and not after.get('executeAttempted'): issues.append(side + '_confirmation_without_execution')
    for key in ['carrierFill', 'completedAt', 'recipientAcceptedAt']:
        if key in (old or {}) and not equal(old[key], new.get(key)): issues.append(key + '_receipt_replaced')
    if 'operatorUid' in (old or {}) and old['operatorUid'] != new.get('operatorUid'): issues.append('operator_uid_replaced')
    if new.get('operatorUid') and (not re.fullmatch(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', new['operatorUid']) or new['operatorUid']=='00000000-0000-0000-0000-000000000000' or not new.get('sender', {}).get('prepared')): issues.append('operator_uid_without_prepared_receipt')
    return issues
def compare(before, after, guard, classification):
    check_guard(before, guard)
    check_guard(after, guard)
    old, new = before['etrn']['trips'][TARGET], after['etrn']['trips'][TARGET]
    documents, issues = {}, []
    for row, (identifier, _) in NATIVE.items():
        old_doc, new_doc = old['deliveries'][row]['document'], new['deliveries'][row]['document']
        found = dispatch_checks(old_doc.get('dispatch'), new_doc.get('dispatch'), identifier)
        issues.extend(found)
        documents[row] = {'documentId': identifier, 'beforeDispatchSha256': digest(old_doc.get('dispatch')),
            'afterDispatchSha256': digest(new_doc.get('dispatch')), 'dispatchChanged': not equal(old_doc.get('dispatch'), new_doc.get('dispatch')),
            'durableReceiptStructurePassed': not found,
            'sender': without(new_doc.get('dispatch', {}).get('sender', {}), {'binding', 'prepared'}),
            'carrier': without(new_doc.get('dispatch', {}).get('carrier', {}), {'binding', 'prepared'}),
            'providerReadbackStillRequired': True}
    other_workflows = equal(normalized_workflows(before, True), normalized_workflows(after, True))
    # Frozen audit hashes unsafe path components with JSON.stringify(string).
    target_key = hashlib.sha256(json.dumps(TARGET, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()[:12]
    pending, unexplained = [], []
    for change in classification['classifiedChanges']:
        if change['path'].startswith('etrn/trips/#' + target_key + '/'):
            pending.append({**change, 'releaseClassification': 'target30_existing_user_grant_workflow_pending_provider_review'})
        elif change['independentClassification'] == 'requires_review': unexplained.append(change)
    facts = classification['exactFacts']
    business_facts = all(value or key == 'accounts' and classification['accountsBusinessFactsExcludingSessionActivityUnchanged'] for key, value in facts.items())
    invariant = (business_facts and classification['banks']['equalByStableIdAndDateExceptPolling']
        and classification['revisionNotRewound'] and classification['protectedFilesUnchanged'] and classification['otherServicesUnchanged']
        and classification['workerContainerUnchanged'] and classification['workerNonBridgeFilesUnchanged']
        and classification['workerBridgeAuth']['unexplainedChanges'] == 0 and other_workflows and not issues and not unexplained)
    return {'phase': classification['phase'], 'rawStrictDataEqual': classification['rawStrictDataEqual'],
        'rawUnexplainedChanges': classification['rawUnexplainedChanges'],
        'targetFactsGrantNativeHistoryAndPriorWritePrefixesPreserved': True,
        'allOtherWorkflowsExceptExactPollingPreserved': other_workflows,
        'releaseInvariantChecksPassed': invariant, 'unexpectedChanges': unexplained, 'receiptStructureIssues': issues,
        'targetWorkflowChangesPendingReview': pending, 'targetDocuments': documents,
        'finalClassificationPending': True, 'providerCompletionClaimed': False,
        'note': 'Target 30 runtime changes remain pending until durable receipts and actual provider read-back are independently reviewed.'}
