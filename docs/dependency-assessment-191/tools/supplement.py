from pathlib import Path
import json,argparse
parser=argparse.ArgumentParser(description='Regenerate comparison tables from a retained collection.')
parser.add_argument('--collection',type=Path,required=True)
parser.add_argument('--output',type=Path)
args=parser.parse_args()
BASE=args.collection.resolve();RAW=BASE/'raw';OUT=args.output.resolve() if args.output else BASE/'derived'
def load(p):return json.loads(p.read_text())
def write(name,value):(OUT/name).write_text(json.dumps(value,indent=2)+'\n')
rows=load(OUT/'package-findings.json')
candidate=load(RAW/'native-candidate/physical-inventory.json')
delta=[]
for row in rows:
    if row['tree']!='live-buyer':continue
    values=sorted(set(x['version'] for x in candidate if x['name']==row['package']))
    delta.append(dict(package=row['package'],affected_range=row['affected_range'],live_installed_affected_versions=sorted(set(x['version'] for x in row['instances'] if x['installed'])),candidate_installed_versions=values,candidate_audit_reports_package=False,interpretation='Finding absent from candidate audit; runtime compatibility not established.' if row['package']!='ws' else 'Candidate resolutions are outside this affected range, but native alpha.2 declares ws ^8.18.3 and can admit affected versions. Raise the floor to >=8.21.0 and qualify a pinned release.'))
write('native-delta.json',delta)
# These two authored tables are the authoritative qualification record. They are
# curated inputs, not facts that can be re-derived from installed package trees.
# Read them from the shipped catalog, so regenerating into a new output directory
# cannot replace reviewed qualifications with stale tool literals.
CATALOG=Path(__file__).resolve().parent.parent
for name in ['native-api.json','upstream-actions.json']:
    write(name,load(CATALOG/name))
# Inventory comparison is explicit because the lock-only omit output is incomplete here.
checks=[]
for name in ['live-buyer','live-seller']:
    physical=load(RAW/name/'sbom-installed.cdx.json');locked=load(RAW/name/'sbom-lock.stdout.log')
    def keys(b):return {(p['value'],c['name'],c['version']) for c in b['components'] for p in c['properties'] if p['name']=='cdx:npm:package:path'}
    pkeys,lkeys=keys(physical),keys(locked)
    checks.append(dict(tree=name,physical_instances=len(pkeys),lock_only_omit_optional_components=len(lkeys),only_physical=[dict(location=x[0],package=x[1],version=x[2]) for x in sorted(pkeys-lkeys)],only_lock=[dict(location=x[0],package=x[1],version=x[2]) for x in sorted(lkeys-pkeys)],interpretation='Lock-only omission is not a complete installed-tree SBOM; physical instance export retains the original range conflicts.'))
write('sbom-comparison.json',checks)
print('supplemental data written')
