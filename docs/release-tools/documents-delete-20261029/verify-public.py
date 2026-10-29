#!/usr/bin/env python3
"""Verify deployed public bytes/routes and scan bundles without printing secrets."""
import argparse,hashlib,json,re,tarfile,urllib.request,urllib.error
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('release',type=Path);a=p.parse_args();r=a.release.resolve()
assert r.parent==Path('/opt/artel-crm/releases')
config=json.loads((r/'config.json').read_text())
manifest=json.loads((r/'candidate-ui-manifest.json').read_text())
# Compare the public response with the reviewed policy in this frozen package,
# rather than silently accepting whatever the reverse proxy happens to return.
expected_headers={
    'Content-Security-Policy': "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
}
assert hashlib.sha256((r/'source.tar.gz').read_bytes()).hexdigest()==config['sourceArchiveSha256']
with tarfile.open(r/'source.tar.gz') as archive:
    production_source=archive.extractfile('server/production.ts').read().decode('utf-8')
for header,value in expected_headers.items():
    # Only string literals are accepted; this helper never evaluates source code.
    pattern=r"response\.setHeader\('"+re.escape(header)+r"', (['\"])(.*?)\1\);"
    matches=re.findall(pattern,production_source)
    assert len(matches)==1 and matches[0][1]==value,'Reviewed header source differs: '+header
def verify_headers(headers,path):
    for header,expected in expected_headers.items():
        values=headers.get_all(header,[])
        assert values==[expected],'Missing, duplicate, or changed security header: '+header+' on '+path
secret_values=[]
for root in ['/opt/artel-crm','/opt/artel-invoices']:
    for line in (Path(root)/'secrets/runtime.env').read_text().splitlines():
        if '=' not in line:continue
        key,value=line.split('=',1)
        if re.search(r'KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL',key,re.I) and len(value)>=8 and not key.endswith(('_FILE','_DIR')):secret_values.append(value.encode())
for name in ['invoices-bridge.key']:
    secret_values.append((Path('/opt/artel-crm/secrets')/name).read_bytes().strip())
for name in manifest:
    raw=(r/'context/app-dist'/name).read_bytes()
    assert not any(v and v in raw for v in secret_values),'Private value found in public bundle'
def get(path):
    request=urllib.request.Request('https://artel-crm.online/'+path,headers={'Cache-Control':'no-cache'})
    try:
        with urllib.request.urlopen(request,timeout=30) as response:
            assert response.geturl()==request.full_url,'Unexpected public redirect: '+path
            verify_headers(response.headers,path)
            return response.status,response.read()
    except urllib.error.HTTPError as error:
        verify_headers(error.headers,path)
        return error.code,error.read()
files={}
for name,h in manifest.items():
    status,raw=get(name);actual=hashlib.sha256(raw).hexdigest()
    assert status==200 and actual==h,'Published asset differs: '+name
    files[name]=actual
routes={}
for path,expected in [('',200),('healthz',200),('api/snapshot',401),('api/shipment-trips',401),('api/invoices',401),('api/directories',401),('api/operator',401),('api/banking',401),('api/banking/export',401),('api/banking/sber/statements',401),('api/work',401),('api/navigation',401),('api/auth/users',401),('api/china',401),('.env',404),('server-render/production.mjs',404),('server/auth.ts',404),('package-lock.json',404),('data/operations/operations.json',404)]:
    status,_=get(path);assert status==expected,'Unexpected route status: '+path;routes[path]=status
proof={'image':config['image'],'publishedFiles':files,'routes':routes,'privateValueScanPassed':True,'authenticatedUiIncluded':False,'securityHeaders':expected_headers,'securityHeadersVerifiedForEveryResponse':True,'getOnly':True,'cookiesSent':False}
with (r/'public-proof.json').open('x') as f:json.dump(proof,f,indent=2)
print(json.dumps({'filesVerified':len(files),'routesVerified':len(routes),'secretScanPassed':True,'securityHeadersVerified':len(expected_headers),'getOnly':True}))
