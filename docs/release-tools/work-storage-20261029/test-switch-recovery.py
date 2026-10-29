"""Exercise the exact exception handler with fake Docker and private temp paths."""
import json, os, tempfile, traceback, types
from pathlib import Path

source=(Path(__file__).parent/'switch-direct-safety.py').read_text()
handler=source.split('except BaseException:\n',1)[1]
script='try:\n    raise RuntimeError("synthetic primary failure")\nexcept BaseException:\n'+handler
for selection,changed_id,healthy,partition,verified in [('old',False,True,False,False),('new',False,True,False,False),('foreign',False,True,False,False),('old',True,True,False,False),('new',False,False,False,False),('new',False,True,True,True),('new',False,True,True,False)]:
    with tempfile.TemporaryDirectory() as folder:
        root=Path(folder);r=root/'evidence';r.mkdir();(root/'.env').write_text('ARTEL_IMAGE='+selection+'\n')
        (root/'data/operations').mkdir(parents=True);(root/'data/operations/operations.json').write_text(json.dumps({'format':'artel-work-partition-v1'} if partition else {'data':{}}))
        if verified:(r/'migration-proof.json').write_text(json.dumps({'allDataExact':True}))
        commands=[];saved={}
        c={'previousImage':'old','previousImageId':'old-id','image':'new'}
        def out(args):
            if args[:3]==['docker','image','inspect']:return 'new-id'
            fmt=args[args.index('--format')+1]
            if fmt=='{{.Id}}':return 'different-container' if changed_id else 'original-container'
            if fmt=='{{.Image}}':return 'old-id' if selection=='old' else 'new-id'
            if fmt=='{{.State.Health.Status}}':return 'healthy' if healthy else 'unhealthy'
            raise AssertionError('Unexpected command')
        scope={'r':r,'root':root,'c':c,'proof':{'images':{'image':{'id':'new-id'}}},'original_container_id':'original-container','container':'crm','out':out,'run':lambda args:commands.append(args),'state':types.SimpleNamespace(save=lambda path,value:saved.update({path.name:value})),'time':types.SimpleNamespace(sleep=lambda delay:None),'traceback':traceback,'os':os,'json':json,'print':lambda value:None}
        try:exec(compile(script,'switch-handler-test','exec'),scope)
        except SystemExit as error:assert error.code==1
        else:raise AssertionError('Failed switch must exit nonzero')
        assert 'synthetic primary failure' in (r/'switch-error.private.log').read_text()
        assert (root/'.env').read_text()=='ARTEL_IMAGE='+selection+'\n'
        result=saved['switch-recovery-result.json']
        assert not result['dataRestored'] and not result['oldBackendRestored']
        if selection=='old' and not changed_id:
            assert commands==[['docker','start','original-container']] and result['healthy']
        elif selection=='new' and (not partition or verified):
            assert len(commands)==1 and commands[0][0:2]==['docker','compose']
            assert commands[0][-6:]==['up','-d','--no-build','--pull','never','crm']
            assert result['healthy']==healthy and result['scope']=='same_candidate_code_only'
        else:assert commands==[] and not result['healthy']
print(json.dumps({'passed':True,'syntheticRecoveryCases':7,'productionCalls':0}))
