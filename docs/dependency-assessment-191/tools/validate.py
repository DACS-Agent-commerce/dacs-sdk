"""Validate the portable catalog, optionally with retained collection and fresh probes."""
from pathlib import Path
import argparse
import collections
import hashlib
import json
import re
import subprocess
import tarfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[3])
parser.add_argument('--collection', type=Path, help='Retained directory containing raw/ and tarballs/.')
parser.add_argument('--probe-root', type=Path, help='Fix-round scratch directory containing raw/ and consumers/.')
parser.add_argument('--round2-root', type=Path, help='Extracted round-2 evidence containing raw/ and consumers/.')
parser.add_argument('--output', type=Path, help='Optional result file; default is stdout only.')
args = parser.parse_args()
REPO = args.repo.resolve()
OUT = REPO / 'docs/dependency-assessment-191'
SOURCE = '3904d704fb540e6e1d7dd502a0be29f20569c92d'

def load(path): return json.loads(path.read_text())
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def audit_items(data):
    return next((v for v in data.values() if isinstance(v, dict) and any(
        isinstance(x, dict) and 'via' in x for x in v.values())), {})
def normalize_bom(value):
    if isinstance(value, dict):
        return {k: ('file:tarballs/' + v.rsplit('/', 1)[-1]
                    if k == 'url' and isinstance(v, str) and v.startswith('file:') and v.endswith('.tgz')
                    else normalize_bom(v)) for k, v in value.items()}
    if isinstance(value, list): return [normalize_bom(v) for v in value]
    return value
def check_bom(bom, count):
    assert bom['bomFormat'] == 'CycloneDX' and bom['specVersion'] == '1.5'
    components = [bom['metadata']['component'], *bom['components']]
    refs = {c['bom-ref'] for c in components}
    assert len(refs) == len(components) and len(bom['components']) == count
    for edge in bom['dependencies']:
        assert edge['ref'] in refs and set(edge['dependsOn']) <= refs
    return {p['value'] for c in components for p in c['properties'] if p['name'] == 'cdx:npm:package:path'}
def tap_counts(path):
    text = path.read_text()
    return {key: int(re.search(r'^# ' + key + r' (\d+)$', text, re.M)[1])
            for key in ['tests', 'pass', 'fail', 'skipped']}

manifest = load(OUT / 'manifest.json')
assert manifest['source_head'] == SOURCE
changed = subprocess.check_output(['git', '-C', str(REPO), 'diff', '--name-only', SOURCE,
                                  '--', 'package.json', 'package-lock.json', 'src', 'packages'], text=True)
assert not changed, 'SDK runtime, dependency or generator source changed'
for entry in manifest['catalog_files']:
    path = OUT / entry['path']
    assert path.is_file() and digest(path) == entry['sha256'], entry['path']
    assert path.stat().st_size == entry['bytes']
document = REPO / 'docs/dependency-assessment-191.md'
assert digest(document) == manifest['report_sha256']
links = re.findall(r'\[[^\]]+\]\(([^)]+)\)', document.read_text())
for target in links:
    assert not target.startswith(('/', 'file:', 'http:', 'https:')), target
    assert (document.parent / target.split('#')[0]).exists(), target

rollup = load(OUT / 'package-findings.json')
ranges = load(OUT / 'source-range-findings.json')
for rows in [rollup, ranges]:
    assert len(rows) == len({(r['tree'], r['package'], r['affected_range']) for r in rows})
    for row in rows:
        assert row['id'] and row['instances'] and not row['safe_upgrade_qualified']
        assert row['raw_file'] == '<collection>/raw/' + row['tree'] + '/npm-audit.json'
        installed = any(i['installed'] for i in row['instances'])
        assert (row['disposition'] == 'narrow entry point') == installed
        if not installed:
            assert row['disposition'] == 'not reachable'
            for phrase in ['--omit=optional', 'no persisted omission', 'npm install', 'npm ci']:
                assert phrase in row['disposition_evidence']
        for instance in row['instances']:
            assert instance['install_paths']
            for route in instance['install_paths']:
                target = route['origin']
                for edge in route['edges']: target = edge['to']
                assert target == instance['location']
assert manifest['install_path_gaps'] == []
results = []
for summary in load(OUT / 'summary.json'):
    name = summary['tree']
    rows = [r for r in rollup if r['tree'] == name]
    assert len(rows) == summary['audit_package_counts']['total'] == summary['package_rows']
    severity = collections.Counter(r['severity'] for r in rows)
    for key in ['low', 'moderate', 'high', 'critical']:
        assert severity[key] == summary['audit_package_counts'][key]
    assert sum(r['tree'] == name for r in ranges) == summary['source_range_rows']
    bom = load(OUT / 'sboms' / (name + '.physical.cdx.json'))
    locations = check_bom(bom, summary['physical_components'])
    if args.collection:
        raw = args.collection / 'raw' / name
        assert digest(raw / 'package-lock.json') == summary['lock_sha256']
        assert (raw / 'npm-audit.json').read_bytes() == (raw / 'audit.stdout.log').read_bytes()
        assert 'overrides' not in load(raw / 'package.json')
        audit = audit_items(load(raw / 'npm-audit.json'))
        assert {r['package'] for r in rows} == set(audit)
        for row in rows:
            assert row['affected_range'] == audit[row['package']]['range']
            assert row['npm_fix_available'] == audit[row['package']]['fixAvailable']
        inventory = load(raw / 'physical-inventory.json')
        assert locations == {x['location'] for x in inventory}
        assert bom == normalize_bom(load(raw / 'sbom-installed.cdx.json'))
        installed = {x['location']: x for x in inventory}
        for row in [*rows, *(r for r in ranges if r['tree'] == name)]:
            for instance in row['instances']:
                assert instance['installed'] == (instance['location'] in installed)
                if instance['installed']:
                    assert instance['version'] == installed[instance['location']]['version']
        assert load(raw / 'sbom.command.json')['exit_code'] == summary['primary_sbom_exit']
        if summary['primary_sbom_exit']:
            assert 'ESBOMPROBLEMS' in (raw / 'sbom.stderr.log').read_text()
        else:
            assert (raw / 'sbom.cdx.json').read_bytes() == (raw / 'sbom.stdout.log').read_bytes()
            assert load(raw / 'sbom.cdx.json')['bomFormat'] == 'CycloneDX'
            assert load(OUT / 'sboms' / (name + '.npm.cdx.json')) == normalize_bom(load(raw / 'sbom.cdx.json'))
    results.append(dict(tree=name, physical_components=summary['physical_components'],
                        package_rows=len(rows), source_range_rows=summary['source_range_rows'],
                        primary_sbom_exit=summary['primary_sbom_exit']))

raw_checked = 0
if args.collection:
    for entry in manifest['raw_files']:
        path = args.collection / entry['path']
        assert digest(path) == entry['sha256'] and path.stat().st_size == entry['bytes'], entry['path']
        raw_checked += 1
    archive = args.collection / 'evidence-original.tar.gz'
    assert digest(archive) == manifest['raw_archive']['sha256']
    with tarfile.open(archive) as tar:
        for entry in manifest['raw_files']:
            assert hashlib.sha256(tar.extractfile(entry['path']).read()).hexdigest() == entry['sha256']
    for pack in [*load(OUT / 'packs.json'), manifest['native_artifact']]:
        path = args.collection / 'tarballs' / pack['tarball'].rsplit('/', 1)[-1]
        assert digest(path) == pack['sha256']
        with tarfile.open(archive) as tar:
            assert hashlib.sha256(tar.extractfile('tarballs/' + path.name).read()).hexdigest() == pack['sha256']
        with tarfile.open(path) as tar:
            package = json.load(tar.extractfile('package/package.json'))
            assert package['version'] == ('0.1.0-alpha.2' if pack is manifest['native_artifact'] else '0.1.0-alpha.0')
            assert 'overrides' not in package

fresh = []
if args.probe_root:
    for entry in [*manifest['fix_round']['raw_files'], *manifest['fix_round']['source_files']]:
        path = args.probe_root / entry['path']
        assert digest(path) == entry['sha256'] and path.stat().st_size == entry['bytes'], entry['path']
    if args.collection:
        archive = args.collection / manifest['fix_round']['archive']['path'].rsplit('/', 1)[-1]
        assert digest(archive) == manifest['fix_round']['archive']['sha256']
        with tarfile.open(archive) as tar:
            for entry in [*manifest['fix_round']['raw_files'], *manifest['fix_round']['source_files']]:
                assert hashlib.sha256(tar.extractfile(entry['path']).read()).hexdigest() == entry['sha256']
    for name in ['live-buyer', 'live-seller']:
        raw = args.probe_root / 'raw' / name
        for check in ['typecheck', 'build', 'static-imports']:
            assert load(raw / (check + '.command.json'))['exit_code'] == 0
        assert load(raw / 'sbom.command.json')['exit_code'] == 1
        assert 'ESBOMPROBLEMS' in (raw / 'sbom.stderr.log').read_text()
        assert load(raw / 'npm-ls.command.json')['exit_code'] == 1
        counts = tap_counts(raw / 'generated-tests.stdout.log')
        assert counts == {'tests': 10, 'pass': 9, 'fail': 1, 'skipped': 0}
        assert 'ok 5 - pre-start doctor rejects an occupied service port' in (raw / 'generated-tests.stdout.log').read_text()
        assert len(re.findall(r'^test\(', (args.probe_root / 'consumers' / name / 'test/live-bootstrap.test.ts').read_text(), re.M)) == 10
        fresh.append(dict(tree=name, **counts))
    raw = args.probe_root / 'raw/native-compatibility'
    assert tap_counts(raw / 'pure-data-tests.stdout.log') == {'tests': 3, 'pass': 3, 'fail': 0, 'skipped': 0}
    for name, code in [('original-typecheck', 0), ('import-only-typecheck', 2),
                       ('adapted-typecheck', 0), ('adapted-without-broad-typecheck', 2)]:
        assert load(raw / (name + '.command.json'))['exit_code'] == code
    controls = []
    for version in ['4.0.16', '4.0.18']:
        raw = args.probe_root / 'raw' / ('demosdk-' + version)
        items = audit_items(load(raw / 'audit.stdout.log'))
        assert len(items) == 73
        assert collections.Counter(v['severity'] for v in items.values()) == {'low': 19, 'moderate': 14, 'high': 37, 'critical': 3}
        controls.append({(name, value['severity']) for name, value in items.items()})
    assert controls[0] == controls[1]

literal_pins = []
if args.round2_root:
    for entry in manifest['fix_round2']['files']:
        path = args.round2_root / entry['path']
        assert digest(path) == entry['sha256'] and path.stat().st_size == entry['bytes'], entry['path']
    if args.collection:
        archive = args.collection / manifest['fix_round2']['archive']['path'].rsplit('/', 1)[-1]
        assert digest(archive) == manifest['fix_round2']['archive']['sha256']
    for name in ['live-buyer', 'live-seller']:
        raw = args.round2_root / 'raw' / name
        for label, counts in [('file-spec-tests', {'tests': 10, 'pass': 9, 'fail': 1, 'skipped': 0}),
                              ('literal-pin-tests', {'tests': 10, 'pass': 10, 'fail': 0, 'skipped': 0})]:
            assert tap_counts(raw / (label + '.stdout.log')) == counts
            assert load(raw / (label + '.command.json'))['exit_code'] == counts['fail']
        comparison = load(raw / 'literal-pin-comparison.json')
        assert comparison['installed_modules_unchanged'] and comparison['manifest_restored']
        assert comparison['lock_sha256_before'] == comparison['lock_sha256_after']
        generated = load(args.collection / 'raw' / name / 'generated-package.json') if args.collection else None
        literal = load(raw / 'literal-pin-package.json')
        for package in ['@kynesyslabs/dacs', '@kynesyslabs/dacs-node']:
            assert literal['dependencies'][package] == '0.1.0-alpha.0'
            if generated: assert generated['dependencies'][package] == literal['dependencies'][package]
        assert load(raw / 'trace-without-flag.command.json')['exit_code'] == 1
        assert load(raw / 'static-imports.command.json')['exit_code'] == 0
        trace = load(raw / 'static-imports.json')
        assert len(trace['files']) == 643 and len(trace['packages']) == 72
        literal_pins.append(dict(tree=name, tests=10, passed=10, failed=0,
                                 cause='The assessment replaced generated literal version pins with file references.'))
    assert load(args.round2_root / 'raw/trace-fixture/missing-relative.command.json')['exit_code'] == 1

# Check authored catalog text without changing original tool data.
terms = ['gh'+'sa', 'advi'+'sory', 'vulnera'+'bility', 'by'+'pass']
local_prefixes = ['/'+'home/', '/'+'Users/']
def authored(value, key=None):
    if key == 'id': return
    if isinstance(value, dict):
        for k, v in value.items(): authored(v, k)
    elif isinstance(value, list):
        for v in value: authored(v, key)
    elif isinstance(value, str):
        assert not any(t in value.lower() for t in terms)
        assert not any(p in value for p in local_prefixes)
for path in [*OUT.glob('*.json'), *(OUT / 'sboms').glob('*.json')]: authored(load(path))
for path in [document, *(OUT / 'tools').glob('*')]:
    if path.is_file():
        text = path.read_text()
        assert not any(t in text.lower() for t in terms), path.name
        assert not any(p in text for p in local_prefixes), path.name
assert not (OUT / 's55').exists()
assert not list(OUT.rglob('package.json')) and not list(OUT.rglob('package-lock.json'))

result = dict(status='catalog checks passed', acceptance='blocked', source_head=SOURCE,
              catalog_files_checked=len(manifest['catalog_files']), links_checked=len(links),
              original_raw_files_checked=raw_checked, trees=results, fresh_generated_tests=fresh,
              raw_evidence='verified' if args.collection else 'not checked: pass --collection with retained evidence',
              fresh_probes='verified' if args.probe_root else 'not checked: pass --probe-root with fresh scratch evidence',
              literal_pin_probes=literal_pins,
              round2_probes='verified' if args.round2_root else 'not checked: pass --round2-root with retained round-2 evidence',
              open_checks=['D-2: supporting file dependency specifications is an optional owner decision; no generated doctor defect established.'],
              blocked=['Primary live npm SBOM commands still fail on optional range conflicts.'])
if args.output: args.output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
