"""Exercise the deployed backup script on isolated files with no Docker/live data."""
import hashlib,io,json,pathlib,subprocess,tarfile,tempfile,unittest
from contextlib import redirect_stdout
from unittest.mock import patch
SCRIPT=pathlib.Path(__file__).parents[1]/'ops/production/backup.py'
DATA={'schemaVersion':1,'sourceSha256':'a'*64,'revision':21,'accounts':{'users':[],'sessions':[]},'documentArchive':{'unchanged':'content'},'work':{'tasks':[]}}
def envelope():
 raw=json.dumps(DATA,separators=(',',':'));return json.dumps({'sha256':hashlib.sha256(raw.encode()).hexdigest(),'data':DATA},separators=(',',':')).encode()
class Tests(unittest.TestCase):
 def execute(self,fmt=None,fail_export=False,corrupt=False):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);store=root/'data/operations';store.mkdir(parents=True);(root/'data/snapshot').mkdir();(root/'data/snapshot/test.json').write_text('{}')
   data=envelope();(store/'operations.json').write_bytes(json.dumps({'format':fmt}).encode() if fmt else data)
   calls=[];real_run=subprocess.run
   def run(args,**kwargs):
    calls.append(args)
    if '/app/server-render/export-operations.mjs' in args:
     return subprocess.CompletedProcess(args,3 if fail_export else 0,data.replace(b'content',b'changed') if corrupt else data,b'')
    self.assertIn('-e',args);return real_run(['node','-e',args[-1]],**kwargs)
   source=SCRIPT.read_text().replace("ROOT = Path('/opt/artel-crm')",'ROOT = Path('+repr(str(root))+')')
   with patch('subprocess.run',side_effect=run),redirect_stdout(io.StringIO()):
    if fail_export or corrupt or fmt=='unknown':
     with self.assertRaises(RuntimeError):exec(compile(source,str(SCRIPT),'exec'),{'__name__':'__main__'})
     self.assertEqual(list((root/'backups').glob('*.tar.gz')),[]);return
    exec(compile(source,str(SCRIPT),'exec'),{'__name__':'__main__'})
   files=list((root/'backups').glob('*.tar.gz'));self.assertEqual(len(files),1)
   with tarfile.open(files[0]) as archive:
    self.assertEqual(archive.extractfile('data/operations/operations.json').read(),data)
    manifest=json.load(archive.extractfile('backup-manifest.json'))
    self.assertEqual(manifest['storageLayout'], 'auth-archive-partitioned-flattened' if fmt=='artel-auth-partition-v2' else 'auth-partitioned-flattened' if fmt=='artel-auth-partition-v1' else 'partitioned-flattened' if fmt else 'legacy')
    self.assertEqual(manifest['revision'],21)
   self.assertEqual(sum('/app/server-render/export-operations.mjs' in c for c in calls),int(fmt is not None))
 def test_legacy(self):self.execute()
 def test_work(self):self.execute('artel-work-partition-v1')
 def test_auth(self):self.execute('artel-auth-partition-v1')
 def test_auth_v2(self):self.execute('artel-auth-partition-v2')
 def test_auth_v2_export_failure(self):self.execute('artel-auth-partition-v2',fail_export=True)
 def test_auth_v2_bad_checksum(self):self.execute('artel-auth-partition-v2',corrupt=True)
 def test_export_failure(self):self.execute('artel-auth-partition-v1',fail_export=True)
 def test_bad_checksum(self):self.execute('artel-auth-partition-v1',corrupt=True)
 def test_unknown_format(self):self.execute('unknown')
if __name__=='__main__':unittest.main()
