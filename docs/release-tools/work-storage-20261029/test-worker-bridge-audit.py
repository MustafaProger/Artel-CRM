import copy, importlib.util, json, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('bridge_audit',Path(__file__).with_name('worker-bridge-audit.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
fixture={'version':2,'mappingHash':'a'*64,'nonces':[{'id':'00000000-0000-4000-8000-000000000001','expiresAt':1}], 'revokedSessions':[], 'owners':[{'crmUserId':'synthetic-one','invoiceOwnerId':'00000000-0000-4000-8000-000000000002'}, {'crmUserId':'synthetic-two','invoiceOwnerId':'00000000-0000-4000-8000-000000000003'}]}
def run(after,before=fixture):return m.compare_bridge(json.dumps(before).encode(),json.dumps(after).encode(),'2026-10-21T10:00:00Z')
class BridgeAudit(unittest.TestCase):
 def test_same(self):
  r=run(fixture);self.assertTrue(r['rawBytesUnchanged']);self.assertEqual(r['unexplainedChanges'],0)
 def test_expired_nonce_removed_new_added(self):
  after=copy.deepcopy(fixture);after['nonces']=[{'id':'00000000-0000-4000-8000-000000000009','expiresAt':1792586405000}]
  r=run(after);self.assertTrue(r['onlyRequestNonceJournalChanged']);self.assertFalse(r['rawBytesUnchanged']);self.assertEqual(r['unexplainedChanges'],0)
 def test_unexpired_removal_requires_review(self):
  before=copy.deepcopy(fixture);before['nonces'][0]['expiresAt']=9999999999999
  after=copy.deepcopy(before);after['nonces']=[]
  self.assertEqual(run(after,before)['unexplainedChanges'],1)
 def test_nonce_mutation_requires_review(self):
  after=copy.deepcopy(fixture);after['nonces'][0]['expiresAt']=2
  self.assertEqual(run(after)['unexplainedChanges'],1)
 def test_owner_add_requires_review(self):
  after=copy.deepcopy(fixture);after['owners'].append({'crmUserId':'synthetic-private-owner','invoiceOwnerId':'00000000-0000-4000-8000-000000000008'})
  r=run(after);self.assertEqual(r['unexplainedChanges'],1);self.assertFalse(r['identityAndRevocationsUnchanged']);self.assertNotIn('synthetic-private-owner',json.dumps(r));self.assertNotIn('00000000-',json.dumps(r))
 def test_revocation_requires_review(self):
  after=copy.deepcopy(fixture);after['revokedSessions'].append({'hash':'b'*64,'revokedAt':1})
  self.assertEqual(run(after)['unexplainedChanges'],1)
 def test_mapping_requires_review(self):
  after=copy.deepcopy(fixture);after['mappingHash']='b'*64
  self.assertEqual(run(after)['unexplainedChanges'],1)
 def test_order_only(self):
  after=copy.deepcopy(fixture);after['owners'].reverse()
  r=run(after);self.assertEqual(r['unexplainedChanges'],0);self.assertFalse(r['rawBytesUnchanged']);self.assertTrue(r['identityAndRevocationsUnchanged'])
 def test_unknown_shape_fails_closed(self):
  after=copy.deepcopy(fixture);after['privateExtra']='never-print'
  r=run(after);self.assertFalse(r['validatedSchema']);self.assertEqual(r['unexplainedChanges'],1);self.assertNotIn('never-print',json.dumps(r))
 def test_missing_snapshot_is_not_invented(self):
  r=m.compare_bridge(b'{}',b'{}','2026-10-21T10:00:00Z');self.assertEqual(r['unexplainedChanges'],1)
if __name__=='__main__':unittest.main()
