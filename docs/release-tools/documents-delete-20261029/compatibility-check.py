import importlib.util,pathlib,shutil,os,json,subprocess,sys,hashlib
r=pathlib.Path(sys.argv[1]); p=r/'compatibility-private';p.mkdir(mode=0o700)
spec=importlib.util.spec_from_file_location('storage_snapshot',r/'storage-snapshot.py');snapshot=importlib.util.module_from_spec(spec);spec.loader.exec_module(snapshot)
(p/'operations.json').write_bytes(snapshot.read_operations());shutil.copytree('/opt/artel-crm/data/snapshot',p/'snapshot')
for f in [p,*p.rglob('*')]: os.chown(f,1000,1000);os.chmod(f,0o700 if f.is_dir() else 0o600)
c=json.loads((r/'config.json').read_text())
cmd=['docker','run','--rm','-i','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','1000:1000','--workdir','/app','--read-only','--tmpfs','/tmp:size=256m,mode=1777','-v',str(p)+':/compat:ro','--entrypoint','node',c['image'],'--input-type=module']
v=subprocess.run(cmd,input=(r/'compatibility.mjs').read_text(),text=True,capture_output=True);(r/'compatibility-final.log').write_text(v.stdout+v.stderr);
if v.returncode==0:
 proof={**json.loads(v.stdout),'configSha256':hashlib.sha256((r/'config.json').read_bytes()).hexdigest()};(r/'compatibility-proof.json').write_text(json.dumps(proof,indent=2));print('Copied current store: exact; no external requests')
else:print('Compatibility failed; private log retained')
raise SystemExit(v.returncode)
