from pathlib import Path,PurePosixPath
import json,collections,subprocess,hashlib,argparse
parser=argparse.ArgumentParser(description='Regenerate findings from retained locks, audits and physical inventories.')
parser.add_argument('--collection',type=Path,required=True)
parser.add_argument('--output',type=Path)
parser.add_argument('--npm-root',help='npm 10.9.9 installation whose bundled semver matches ranges; default derives it from the running node.')
args=parser.parse_args()
BASE=args.collection.resolve()
RAW=BASE/'raw'
OUT=args.output.resolve() if args.output else BASE/'derived';OUT.mkdir(parents=True,exist_ok=True)
TREES=['bare-core','bare-node','bare-generator','live-buyer','live-seller','native-alpha2','native-candidate']

def load(p):return json.loads(p.read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def entries(a):return next((v for v in a.values() if isinstance(v,dict) and any(isinstance(x,dict) and 'via' in x for x in v.values())),{})
def counts(a):return next(v for v in a['metadata'].values() if isinstance(v,dict) and 'critical' in v)
def pname(location,meta):
    if meta.get('name'):return meta['name']
    return location.rsplit('node_modules/',1)[-1]
def resolve(location,name,packages):
    search=PurePosixPath(location) if location else PurePosixPath('.')
    for ancestor in [search,*search.parents]:
        candidate=str(ancestor/'node_modules'/name)
        if candidate.startswith('./'):candidate=candidate[2:]
        if candidate in packages:return candidate
    return None

def graph(packages):
    result={}
    for loc,meta in packages.items():
        deps={}
        for key,kind in [('dependencies','runtime'),('optionalDependencies','optional'),('peerDependencies','peer')]:
            for name,spec in meta.get(key,{}).items():
                if key=='peerDependencies' and meta.get('peerDependenciesMeta',{}).get(name,{}).get('optional'):kind_here='optional peer'
                else:kind_here=kind
                target=resolve(loc,name,packages)
                if target is not None:deps[target]={'to':target,'package':name,'required':spec,'edge_type':kind_here}
        result[loc]=list(deps.values())
    return result

def shortest(g,start):
    result={start:[]};q=collections.deque([start])
    while q:
        x=q.popleft()
        for edge in g.get(x,[]):
            if edge['to'] not in result:
                result[edge['to']]=[*result[x],edge];q.append(edge['to'])
    return result

def sources(items,name):
    found={};q=[name];seen=set()
    while q:
        key=q.pop()
        if key in seen:continue
        seen.add(key)
        for via in items.get(key,{}).get('via',[]):
            if isinstance(via,str):q.append(via)
            else:found[via['source']]=via
    return sorted(found.values(),key=lambda x:x['source'])

def public_ids(src):return sorted(set(x['url'].rstrip('/').rsplit('/',1)[-1] for x in src))

OP={
'@simplewebauthn/server':'Attestation certificate trust-chain validation; this package is not in the traced Demos import closure.',
'axios':'Affected instances are nested legacy or chain HTTP clients. The Demos native HTTP call resolves the separate patched root instance; compare instance paths, not the shared package name.',
'base-x':'Unicode lookalike decoding in affected old chain copies; the imported Solana decoding copy has a separate patched version.',
'bigint-buffer':'toBigIntLE native conversion is in the Solana module closure. Demos provider registration calls clusterApiUrl, not this conversion; affected operation not demonstrated.',
'bn.js':'Old integer arithmetic copies carried by chain clients; no affected copy occurs in the traced literal-import closure.',
'csv-parse':'Columns processing carried by the chain asset toolchain; no affected copy occurs in the traced literal-import closure.',
'elliptic':'Legacy elliptic arithmetic carried by chain clients; no affected copy occurs in the traced literal-import closure.',
'form-data':'Affected multipart boundary/header construction is in legacy chain HTTP clients. The Demos native HTTP path resolves a separate patched root copy.',
'node-forge':'RSA PKCS#1 v1.5 signature verification. Module is imported, while the reviewed DACS native authentication and protocol-signing paths use Ed25519. No affected RSA verification call was established.',
'protobufjs':'Schema/code generation and recursive conversion in the old Cosmos proof copy; no affected copy occurs in the traced literal-import closure.',
'secp256k1':'ECDH in version 5.0.0 and inherited legacy elliptic arithmetic; native Demos authority is Ed25519. No affected copy occurs in the traced literal-import closure.',
'stream-json':'Streaming parser and object assembler; the Solana import selects jayson browser client, not its server/streaming parser.',
'toml':'TOML parsing in chain program toolchains; no affected copy occurs in the traced literal-import closure.',
'underscore':'Recursive flatten/equality in the asset-toolchain dependency; no affected copy occurs in the traced literal-import closure.',
'uuid':'Buffer-writing v3/v5/v6 APIs. The traced jayson browser client explicitly selects v4 with no output buffer; affected operation not demonstrated.',
'ws':'Affected old WebSocket copies belong to legacy chain clients; the traced native and abstraction copies have separate patched versions.',
}
package_rows=[];range_rows=[];summaries=[];path_gaps=[];semver_jobs=[]
for tree in TREES:
    raw=RAW/tree;consumer=BASE/'consumers'/tree
    lock=load(raw/'package-lock.json');packages=lock['packages'];g=graph(packages)
    physical_locations={x['location'] for x in load(raw/'physical-inventory.json')}
    origins=[p for p in ['node_modules/@kynesyslabs/dacs','node_modules/@kynesyslabs/dacs-node','node_modules/create-dacs-agent'] if p in packages]
    if tree=='native-alpha2':origins=['node_modules/@demosnetwork/demos-native']
    walks={o:shortest(g,o) for o in origins}
    rootwalk=shortest(g,'')
    trace=load(raw/'static-imports.json') if (raw/'static-imports.json').exists() else {'packages':{}}
    audit=load(raw/'npm-audit.json');items=entries(audit)
    def instances(locations):
        result=[]
        for loc in sorted(set(locations)):
            meta=packages.get(loc,{})
            physical=loc in physical_locations
            routes=[]
            for origin,walk in walks.items():
                if loc in walk:routes.append({'from':pname(origin,packages[origin]),'origin':origin,'edges':walk[loc]})
            if not routes and loc in rootwalk:
                routes.append({'from':'consumer','origin':'','edges':rootwalk[loc]})
            if not routes:path_gaps.append({'tree':tree,'location':loc})
            result.append({'location':loc,'version':meta.get('version'), 'installed':physical,'lock_optional':bool(meta.get('optional')), 'install_paths':routes,'module_import_path':trace['packages'].get(loc,{}).get('chain')})
        return result
    def enrich(row,inst,src):
        present=[x for x in inst if x['installed']]
        imported=[x for x in present if x['module_import_path']]
        inherited=row['kind']=='inherited'
        if not inst:
            reach='no affected version selected in this lock'
            disposition='not reachable'
            rationale='No package instance in the audit node list matches this public source range; retain the raw record without asserting an installed finding.'
        elif not present:
            reach='not installed'
            disposition='not reachable'
            rationale='Every affected instance is absent only after --omit=optional with this exact lock. The generated project has no persisted omission; later plain npm install or npm ci can restore these paths. Persist omit=optional in generated configuration or have the doctor reject those paths, then reassess before release.'
        else:
            disposition='narrow entry point'
            reach='module import path present; affected operation not established' if imported else 'no static import path found; affected operation not established'
            if row['package'] in ['@kynesyslabs/dacs','@kynesyslabs/dacs-node']:
                reach='conditional Demos feature; inherited finding'
            rationale='All matching findings are absent in the zero-finding native candidate tree. Migration and runtime compatibility remain unqualified; no release exemption is asserted.'
        row.update(id=public_ids(src),instances=inst,reachability=reach,evidence_kind='static source and installed inventory; no chain execution',affected_operation=OP.get(row['package'],'Inherited dependency finding; inspect the source-range rows for the affected leaf operations.' if inherited else 'Affected package operation not established from static evidence.'),disposition=disposition,disposition_evidence=rationale,raw_file='<collection>/raw/'+tree+'/npm-audit.json',safe_upgrade_qualified=False)
        return row
    for name,item in sorted(items.items()):
        src=sources(items,name)
        inst=instances(item.get('nodes',[]))
        row={'tree':tree,'package':name,'affected_range':item.get('range'),'severity':item['severity'],'kind':'inherited' if not any(isinstance(v,dict) for v in item.get('via',[])) else 'direct or mixed','via_packages':[v for v in item.get('via',[]) if isinstance(v,str)],'npm_fix_available':item['fixAvailable']}
        package_rows.append(enrich(row,inst,src))
        groups={}
        for via in item.get('via',[]):
            if isinstance(via,dict):
                groups.setdefault(via['range'],{'kind':'direct','sources':[]})['sources'].append(via)
        indirect=[v for v in item.get('via',[]) if isinstance(v,str)]
        if indirect:
            group=groups.setdefault(item.get('range'),{'kind':'inherited','sources':[]})
            if group['kind']=='direct':group['kind']='direct and inherited'
            inherited_sources=[]
            for child in indirect:inherited_sources.extend(sources(items,child))
            group['sources'].extend(inherited_sources)
        for affected,group in groups.items():
            severity=max((v['severity'] for v in group['sources']),key=lambda s:['info','low','moderate','high','critical'].index(s)) if group['kind']=='direct' else item['severity']
            r={'tree':tree,'package':name,'affected_range':affected,'kind':group['kind'],'severity':severity,'npm_package_severity':item['severity'],'npm_fix_available':item['fixAvailable']}
            job={'versions':[x['version'] for x in inst],'range':affected,'inherited':group['kind'] in ['inherited','direct and inherited']}
            semver_jobs.append(job)
            range_rows.append((r,inst,group['sources'],enrich))
    summary={'tree':tree,'lock_sha256':sha(raw/'package-lock.json'),'audit_package_counts':counts(audit),'physical_components':len(load(raw/'sbom-physical.cdx.json')['components']),'primary_sbom_exit':load(raw/'sbom.command.json')['exit_code'],'install_exit':load(raw/'install.command.json')['exit_code']}
    if (raw/'audit-installed.stdout.log').exists():summary['audit_omit_optional_counts']=counts(load(raw/'audit-installed.stdout.log'))
    summaries.append(summary)
# Match source ranges with the pinned semver bundled by npm; inherited rows retain npm's affected node set.
matcher=['node',str(Path(__file__).with_name('semver-match.cjs')),*([args.npm_root] if args.npm_root else [])]
matched=json.loads(subprocess.check_output(matcher,input=json.dumps(semver_jobs).encode()))
# Each closure below was captured in the tree iteration; bind explicit tree state for final enrichment.
final_ranges=[]
for (row,inst,src,_),match in zip(range_rows,matched):
    chosen=[x for x,yes in zip(inst,match) if yes]
    present=[x for x in chosen if x['installed']];imported=[x for x in present if x['module_import_path']]
    if not chosen:reach='no affected version selected in this lock';disp='not reachable';reason='No audit-listed instance matches this exact source range under npm semver. This source record does not establish a finding in this installed composition.'
    elif not present:reach='not installed';disp='not reachable';reason='All matching affected paths are absent only after --omit=optional with this exact lock. The generated project has no persisted omission; later plain npm install or npm ci can restore these paths. Persist omit=optional in generated configuration or have the doctor reject those paths, then reassess before release.'
    else:
        reach='module import path present; affected operation not established' if imported else 'no static import path found; affected operation not established'
        if row['package'] in ['@kynesyslabs/dacs','@kynesyslabs/dacs-node']:reach='conditional Demos feature; inherited finding'
        disp='narrow entry point';reason='Matching package findings disappear in the native candidate tree. Runtime compatibility and release qualification remain required.'
    row.update(id=public_ids(src),instances=chosen,reachability=reach,evidence_kind='static source and installed inventory; no chain execution',affected_operation=OP.get(row['package'],'Inherited dependency finding; follow the via packages in package-findings.json.' if row['kind']=='inherited' else 'Affected operation not established.'),disposition=disp,disposition_evidence=reason,raw_file='<collection>/raw/'+row['tree']+'/npm-audit.json',safe_upgrade_qualified=False)
    final_ranges.append(row)
for summary in summaries:
    for label,rows in [('package',package_rows),('source_range',final_ranges)]:
        selected=[r for r in rows if r['tree']==summary['tree']]
        summary[label+'_rows']=len(selected)
        summary[label+'_dispositions']={d:sum(r['disposition']==d for r in selected) for d in ['upgrade available and safe','narrow entry point','not reachable','needs an upstream repair (U-03)']}
        summary[label+'_reachability']=dict(collections.Counter(r['reachability'] for r in selected))
# Engines come from installed trees (tools/engines-check.cjs), not from retained raw data; carry the catalog counts forward.
checks=Path(__file__).resolve().parents[1]/'release-checks.json'
engines={t['tree']:t for t in load(checks)['engines']['trees']} if checks.exists() else {}
for summary in summaries:
    if summary['tree'] in engines:
        e=engines[summary['tree']]
        summary['engines']={'advertised':e['advertised'],'outside_advertised':len(e['outside']),'rejects_advertised_floor':sum(bool(r['rejected_probes']) for r in e['outside']),'catalog':'release-checks.json'}
for name,data in [('package-findings.json',package_rows),('source-range-findings.json',final_ranges),('summary.json',summaries),('path-gaps.json',path_gaps)]:
    (OUT/name).write_text(json.dumps(data,indent=2)+'\n')
print(json.dumps(summaries,indent=2))
print('path gaps',len(path_gaps))
