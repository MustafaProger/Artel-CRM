"""Synthetic release guard cases; no production or provider access."""
import copy
import importlib.util
import json
from pathlib import Path
spec = importlib.util.spec_from_file_location('target', Path(__file__).with_name('target-workflow-audit.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def fixture():
    trip = {'updatedAt':'old', 'direct':{'authorization':{'actorId':'actor','factsHash':'facts'},'attemptId':'direct-attempt','phase':'sending_etrn','updatedAt':'old'},'deliveries':{}}
    for row,(identifier,number) in m.NATIVE.items():
        trip['deliveries'][row] = {'profile':{'immutable':True},'snapshot':{'shipmentId':row},'preparedHash':'frozen','updatedAt':'old',
            'document':{'id':identifier,'number':number,'status':'draft','attemptId':'attempt-'+row,'marker':'marker-'+row,'payloadHash':'frozen','snapshot':{'shipmentId':row},'createdAt':'created',
                'reservationAttempted':row==next(iter(m.NATIVE)),'uploadAttempted':True,'writeAttempts':[{'action':'upload','outcome':'received','result':{'id':identifier}}],
                'nativeAdoptionEvidence':{'nativeDocumentId':identifier,'originalAttemptId':'attempt-'+row,'originalMarker':'marker-'+row,'holdForReview':False,'stage':'verified'},
                'dispatch':{'version':1,'sender':{'state':'blocked'},'carrier':{'state':'not_started'}},'updatedAt':'old'}}
    return {'revision':1,'shipments':{row:{'litres':'8000'} for row in m.NATIVE},'driverTripProgress':{m.TARGET:{'departedAt':'fixed'}},'etrn':{'trips':{m.TARGET:trip,m.SOURCE:{'updatedAt':'old','direct':{'phase':'unknown','leaseId':None},'deliveries':{}}}},'tripSaby':{'trips':{}}}
def classification():
    return {'phase':'after','classifiedChanges':[],'exactFacts':{'shipments':True},'banks':{'equalByStableIdAndDateExceptPolling':True},'revisionNotRewound':True,'protectedFilesUnchanged':True,'otherServicesUnchanged':True,'workerContainerUnchanged':True,'workerNonBridgeFilesUnchanged':True,'workerBridgeAuth':{'unexplainedChanges':0},'rawStrictDataEqual':False,'rawUnexplainedChanges':1}
def rejects(edit):
    before=fixture();after=copy.deepcopy(before);edit(after)
    try: result=m.compare(before,after,m.capture_guard(before),classification())
    except AssertionError:return
    assert not result['releaseInvariantChecksPassed']
row=next(iter(m.NATIVE));doc=lambda data:data['etrn']['trips'][m.TARGET]['deliveries'][row]['document']
before=fixture();after=copy.deepcopy(before)
doc(after)['dispatch']['sender']={'state':'preparing','binding':{'documentId':m.NATIVE[row][0],'documentType':'ConsignmentNote','side':'sender'}}
after['etrn']['trips'][m.SOURCE]['direct']['leaseId']='next-poll'
result=m.compare(before,after,m.capture_guard(before),classification())
assert result['releaseInvariantChecksPassed'] and result['finalClassificationPending'] and not result['providerCompletionClaimed']
rejects(lambda data:doc(data).__setitem__('attemptId','replaced'))
rejects(lambda data:doc(data).__setitem__('reservationAttempted',False))
rejects(lambda data:doc(data)['snapshot'].__setitem__('mass','changed'))
rejects(lambda data:data['etrn']['trips'][m.TARGET]['direct']['authorization'].__setitem__('actorId','other'))
rejects(lambda data:data['shipments'][row].__setitem__('litres','9000'))
rejects(lambda data:data['etrn']['trips'][m.SOURCE]['direct'].__setitem__('phase','completed'))
rejects(lambda data:doc(data)['writeAttempts'][0].__setitem__('outcome','uncertain'))
rejects(lambda data:doc(data)['writeAttempts'].append({'action':'reservation'}))
rejects(lambda data:doc(data)['nativeAdoptionEvidence'].__setitem__('holdForReview',True))
rejects(lambda data:doc(data)['dispatch']['sender'].__setitem__('executeAttempted',True))
rejects(lambda data:doc(data).__setitem__('id','foreign-document'))
rejects(lambda data:doc(data)['writeAttempts'].append({'action':'upload','result':{'id':'foreign-document'}}))
rejects(lambda data:data['etrn']['trips'][m.SOURCE].__setitem__('updatedAt','unexpected'))
rejects(lambda data:data['etrn']['trips'][m.SOURCE]['direct'].__setitem__('lastCheckedAt','unexpected'))
assert m.dispatch_checks({'sender':{'executeAttempted':True},'carrier':{}},{'sender':{'executeAttempted':False},'carrier':{}},'id')
assert m.dispatch_checks({'sender':{'prepared':{'receipt':'fixed'}},'carrier':{}},{'sender':{'prepared':{'receipt':'changed'}},'carrier':{}},'id')
before=fixture();after=copy.deepcopy(before)
for current_row,(identifier,_) in m.NATIVE.items():
    dispatch=after['etrn']['trips'][m.TARGET]['deliveries'][current_row]['document']['dispatch']
    for side in ['sender','carrier']:
        binding={'documentId':identifier,'documentType':'ConsignmentNote','side':side}
        dispatch[side]={'state':'confirmed','binding':binding,'prepared':{'binding':copy.deepcopy(binding),'files':['provider-receipt']},'verified':True,'executeAttempted':True,'dispatchState':'acknowledged'}
    dispatch['operatorUid']='12345678-1234-1234-1234-123456789abc';dispatch['completedAt']='completed'
after['etrn']['trips'][m.TARGET]['direct'].update(phase='completed',completedAt='completed')
complete=m.compare(before,after,m.capture_guard(before),classification())
assert complete['releaseInvariantChecksPassed'] and complete['finalClassificationPending'] and not complete['providerCompletionClaimed']
assert all(row['providerReadbackStillRequired'] for row in complete['targetDocuments'].values())
for malformed in ['00000000-0000-0000-0000-000000000000','------------------------------------','12345678123412341234123456789abc']:
    invalid=copy.deepcopy(after);doc(invalid)['dispatch']['operatorUid']=malformed
    assert not m.compare(before,invalid,m.capture_guard(before),classification())['releaseInvariantChecksPassed']
print(json.dumps({'passed':True,'cases':21,'productionCalls':0}))
