"""Unit checks for validate.py: row derivation, schema results, SBOM normalization and engines rows."""
from pathlib import Path
import copy
import importlib.util
import json
import re
import subprocess
import sys
import tarfile
import tempfile
import unittest

sys.dont_write_bytecode = True
TOOLS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('validate', TOOLS / 'validate.py')
validate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validate)

def record(source, ident, severity, affected):
    return dict(source=source, name='leaf', url='https://example.invalid/records/' + ident, severity=severity, range=affected)
AUDIT = {
    'leaf': dict(name='leaf', severity='high', range='<2.0.0', fixAvailable=False,
                 nodes=['node_modules/leaf', 'node_modules/mid/node_modules/leaf'],
                 via=[record(1, 'ID-1', 'high', '<2.0.0'), record(2, 'ID-2', 'moderate', '<1.5.0')]),
    'mid': dict(name='mid', severity='high', range='*', fixAvailable=True, nodes=['node_modules/mid'], via=['leaf']),
}
LOCK = {'node_modules/leaf': {'version': '1.4.0'}, 'node_modules/mid/node_modules/leaf': {'version': '1.8.0'},
        'node_modules/mid': {'version': '3.0.0'}}
PHYSICAL = {'node_modules/leaf', 'node_modules/mid'}
def below(version, affected):
    bound = re.fullmatch(r'<(\d+)\.(\d+)\.(\d+)', affected)
    return tuple(map(int, version.split('.'))) < tuple(map(int, bound.groups()))
def match(jobs):
    return [[job['inherited'] or below(v, job['range']) for v in job['versions']] for job in jobs]
def committed(rows):
    """Shape derived rows like the catalog: instances become objects."""
    result = copy.deepcopy(rows)
    for row in result:
        row['instances'] = [dict(location=l, version=v, installed=i) for l, v, i in row['instances']]
    return result

class RowDerivation(unittest.TestCase):
    def setUp(self):
        self.packages, self.ranges = validate.expected_rows('t', AUDIT, LOCK, PHYSICAL, match)

    def test_exact_ranges_select_matching_instances(self):
        by_range = {r['affected_range']: r for r in self.ranges if r['package'] == 'leaf'}
        self.assertEqual(by_range['<1.5.0']['instances'], [('node_modules/leaf', '1.4.0', True)])
        self.assertEqual(by_range['<1.5.0']['severity'], 'moderate')
        self.assertEqual(len(by_range['<2.0.0']['instances']), 2)
        inherited = [r for r in self.ranges if r['package'] == 'mid'][0]
        self.assertEqual((inherited['kind'], inherited['id']), ('inherited', ['ID-1', 'ID-2']))

    def test_unchanged_rows_pass(self):
        validate.compare_rows(self.packages, committed(self.packages), 'packages')
        validate.compare_rows(self.ranges, committed(self.ranges), 'ranges')

    def test_one_changed_field_fails(self):
        def changed_id(row): row['id'] = ['ID-9']
        def changed_range(row): row['affected_range'] = '<1.6.0'
        def changed_severity(row): row['severity'] = 'low'
        def changed_location(row): row['instances'][0]['location'] = 'node_modules/other/node_modules/leaf'
        def changed_installed(row): row['instances'][0]['installed'] = False
        def changed_fix(row): row['npm_fix_available'] = True
        for change in [changed_id, changed_range, changed_severity, changed_location, changed_installed, changed_fix]:
            for rows in [self.packages, self.ranges]:
                with self.subTest(change=change.__name__, rows=len(rows)):
                    bad = committed(rows)
                    change(bad[0])
                    with self.assertRaises(AssertionError):
                        validate.compare_rows(rows, bad, change.__name__)

class Sboms(unittest.TestCase):
    validator = validate.schema_validator(TOOLS.parent / 'cyclonedx')
    def bom(self, *components):
        return dict(bomFormat='CycloneDX', specVersion='1.5', version=1,
                    metadata=dict(component={'bom-ref': 'root', 'type': 'library', 'name': 'root'}),
                    components=list(components), dependencies=[{'ref': c['bom-ref']} for c in components])
    def test_valid_bom(self):
        result = validate.schema_result(self.validator, self.bom({'bom-ref': 'a@1', 'type': 'library', 'name': 'a'}))
        self.assertEqual(result, dict(valid=True, errors=[], duplicate_bom_refs={}))
    def test_primary_output_requires_exact_specification_version(self):
        # Primary npm output goes directly through schema_result, without check_bom.
        primary = dict(bomFormat='CycloneDX', specVersion='1.5', version=1)
        self.assertTrue(validate.schema_result(self.validator, primary)['valid'])
        for version in ['0.0', '1.4', '1.6', '', None, 1.5]:
            with self.subTest(version=version):
                primary['specVersion'] = version
                result = validate.schema_result(self.validator, primary)
                self.assertFalse(result['valid'])
                self.assertIn('specVersion: expected 1.5', result['errors'])
        del primary['specVersion']
        self.assertFalse(validate.schema_result(self.validator, primary)['valid'])

    def test_repeated_references_fail(self):
        a = {'bom-ref': 'a@1', 'type': 'library', 'name': 'a'}
        result = validate.schema_result(self.validator, self.bom(a, dict(a)))
        self.assertFalse(result['valid'])
        self.assertEqual(result['duplicate_bom_refs'], {'a@1': 2})
        self.assertIn('dependencies: uniqueItems', result['errors'])
    def test_shared_reference_on_different_components_fails(self):
        a = {'bom-ref': 'dup', 'type': 'library', 'name': 'a', 'version': '1.0.0'}
        b = {'bom-ref': 'dup', 'type': 'library', 'name': 'b', 'version': '2.0.0'}
        bom = dict(self.bom(a, b), dependencies=[{'ref': 'dup'}])
        self.assertEqual(validate.schema_result(self.validator, bom),
                         dict(valid=False, errors=[], duplicate_bom_refs={'dup': 2}))
    def test_nested_references_count(self):
        nested = {'bom-ref': 'a@1', 'type': 'library', 'name': 'inner'}
        outer = {'bom-ref': 'outer', 'type': 'library', 'name': 'outer', 'components': [nested]}
        a = {'bom-ref': 'a@1', 'type': 'library', 'name': 'a'}
        bom = dict(self.bom(outer, a))
        self.assertEqual(validate.schema_result(self.validator, bom)['duplicate_bom_refs'], {'a@1': 2})
        service = dict(self.bom(a), services=[{'bom-ref': 'a@1', 'name': 'svc'}])
        self.assertFalse(validate.schema_result(self.validator, service)['valid'])
        nested['bom-ref'] = 'inner@1'
        self.assertEqual(validate.schema_result(self.validator, bom), dict(valid=True, errors=[], duplicate_bom_refs={}))
    def test_license_reference_belongs_in_name(self):
        def component(license): return {'bom-ref': 'a@1', 'type': 'library', 'name': 'a', 'licenses': [{'license': license}]}
        self.assertFalse(validate.schema_result(self.validator, self.bom(component({'id': 'LicenseRef-Custom'})))['valid'])
        self.assertTrue(validate.schema_result(self.validator, self.bom(component({'name': 'LicenseRef-Custom'})))['valid'])
        self.assertTrue(validate.schema_result(self.validator, self.bom(component({'id': 'MIT'})))['valid'])
    def test_normalization_rules(self):
        raw = {'licenses': [{'license': {'id': 'LicenseRef-Custom'}}, {'license': {'id': 'MIT'}}],
               'externalReferences': [{'url': 'file:/somewhere/else/pkg-1.0.0.tgz'}]}
        self.assertEqual(validate.normalize_bom(raw), {
            'licenses': [{'license': {'name': 'LicenseRef-Custom'}}, {'license': {'id': 'MIT'}}],
            'externalReferences': [{'url': 'file:tarballs/pkg-1.0.0.tgz'}]})

class Engines(unittest.TestCase):
    def setUp(self):
        self.checks = dict(engines=dict(probes=['20.19.0', '24.0.0'], trees=[dict(
            tree='t', advertised='>=20', effective_node_range='>=22 <24 || >=25', checked=1, outside=[
            dict(location='node_modules/a', name='a', version='1.0.0', engines_node='>=22 <24 || >=25',
                 rejected_probes=['20.19.0', '24.0.0'])])]))
        self.summary = [dict(tree='t', physical_components=1, engines=dict(
            advertised='>=20', outside_advertised=1, rejects_advertised_floor=1, catalog='release-checks.json'))]
        self.boms = {'t': dict(components=[dict(name='a', version='1.0.0', properties=[
            dict(name='cdx:npm:package:path', value='node_modules/a')])])}
    def test_consistent(self):
        self.assertEqual(validate.check_engines(self.checks, self.summary, self.boms), {'t': 1})
    def test_version_not_installed_fails(self):
        self.checks['engines']['trees'][0]['outside'][0]['version'] = '1.0.1'
        with self.assertRaises(AssertionError):
            validate.check_engines(self.checks, self.summary, self.boms)
    def test_summary_count_mismatch_fails(self):
        self.summary[0]['engines']['rejects_advertised_floor'] = 0
        with self.assertRaises(AssertionError):
            validate.check_engines(self.checks, self.summary, self.boms)
    def test_missing_rejected_probe_fails_without_changing_floor_count(self):
        self.checks['engines']['trees'][0]['outside'][0]['rejected_probes'].remove('24.0.0')
        with self.assertRaises(AssertionError):
            validate.check_engines(self.checks, self.summary, self.boms)
    def test_incorrect_effective_range_fails(self):
        for effective in ['>=0', '>=22 <24', '>=22 <24 || >=25 <99', '>=22']:
            with self.subTest(effective=effective):
                self.checks['engines']['trees'][0]['effective_node_range'] = effective
                with self.assertRaises(AssertionError):
                    validate.check_engines(self.checks, self.summary, self.boms)
    def test_equivalent_effective_range_passes(self):
        self.checks['engines']['trees'][0]['effective_node_range'] = '>=22 <23 || 23.x || >=25'
        self.assertEqual(validate.check_engines(self.checks, self.summary, self.boms), {'t': 1})

class Catalog(unittest.TestCase):
    def test_catalog_mode_passes(self):
        result = subprocess.run([sys.executable, '-I', str(TOOLS / 'validate.py'), '--repo', str(TOOLS.parents[2])],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        output = json.loads(result.stdout)
        self.assertEqual(output['sbom_schema_invalid'], ['native-candidate.npm.cdx.json'])
        self.assertEqual(output['replacement_evidence'], 'not run: supply --recollection to verify the replacement inputs')

class EvidenceFiles(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'collection'
        self.root.mkdir()
        self.raw = self.root / 'audit.json'
        self.raw.write_text('{"metadata": {}}\n')
        self.archive = self.root.parent / 'evidence.tar.gz'
        with tarfile.open(self.archive, 'w:gz') as tar:
            tar.add(self.raw, arcname='audit.json')
        self.evidence = dict(archive=dict(path=self.archive.name, sha256=validate.digest(self.archive)),
                             files=[dict(path=self.raw.name, sha256=validate.digest(self.raw), bytes=self.raw.stat().st_size)])
    def test_original_inputs_and_archive_pass(self):
        self.assertEqual(validate.check_evidence_files(self.root, self.evidence), 1)
    def test_missing_or_changed_input_fails(self):
        self.raw.write_text('{}')
        with self.assertRaises(AssertionError):
            validate.check_evidence_files(self.root, self.evidence)
        self.raw.unlink()
        with self.assertRaises(AssertionError):
            validate.check_evidence_files(self.root, self.evidence)
    def test_archive_bytes_must_match_loose_inputs(self):
        self.raw.write_text('{"metadata": []}\n')
        self.evidence['files'][0]['sha256'] = validate.digest(self.raw)
        with self.assertRaises(AssertionError):
            validate.check_evidence_files(self.root, self.evidence)
    def test_archive_hash_must_match(self):
        self.archive.write_bytes(b'changed archive')
        with self.assertRaises(AssertionError):
            validate.check_evidence_files(self.root, self.evidence)
    def test_inventory_versions_match_npm_canonical_versions(self):
        entries = [dict(location='', name='consumer', version='1.0.0'),
                   dict(location='node_modules/a', name='a', version='1.0.01'),
                   dict(location='node_modules/b', name='b', version='3.1.0')]
        self.assertEqual(validate.canonical_inventory(entries, validate.semver_matcher()), {
            'node_modules/a': ('a', '1.0.1'), 'node_modules/b': ('b', '3.1.0')})

if __name__ == '__main__':
    unittest.main()
