"""Round-trip the derived tables and preserve the authored qualification records."""
from pathlib import Path
import json
import shutil
import subprocess
import sys
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parent
CATALOG = TOOLS.parent


def load(path):
    return json.loads(path.read_text())


def location(component):
    return next(p['value'] for p in component['properties'] if p['name'] == 'cdx:npm:package:path')


class Supplement(unittest.TestCase):
    def test_all_four_tables_round_trip_from_portable_inputs(self):
        # Reconstruct just the collection inputs the generator needs. No private
        # archive, installed modules or network is required for this regression.
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / 'derived'
            output.mkdir()
            shutil.copyfile(CATALOG / 'package-findings.json', output / 'package-findings.json')
            candidate = root / 'raw/native-candidate'
            candidate.mkdir(parents=True)
            inventory = [dict(name=c['name'], version=c['version']) for c in
                         load(CATALOG / 'sboms/native-candidate.physical.cdx.json')['components']]
            (candidate / 'physical-inventory.json').write_text(json.dumps(inventory))

            for comparison in load(CATALOG / 'sbom-comparison.json'):
                role = comparison['tree']
                raw = root / 'raw' / role
                raw.mkdir()
                physical = load(CATALOG / 'sboms' / (role + '.physical.cdx.json'))
                (raw / 'sbom-installed.cdx.json').write_text(json.dumps(physical))
                # The comparison records exactly the physical/lock set difference.
                omitted = {entry['location'] for entry in comparison['only_physical']}
                components = [c for c in physical['components'] if location(c) not in omitted]
                components.extend(dict(name=c['package'], version=c['version'], properties=[
                    dict(name='cdx:npm:package:path', value=c['location'])]) for c in comparison['only_lock'])
                (raw / 'sbom-lock.stdout.log').write_text(json.dumps(dict(components=components)))

            # Only package findings are preloaded in the output directory. Authored
            # tables must come from the catalog, rather than previous output.
            result = subprocess.run([sys.executable, '-I', str(TOOLS / 'supplement.py'),
                                     '--collection', str(root), '--output', str(output)],
                                    capture_output=True, text=True, cwd=root)
            self.assertEqual(result.returncode, 0, result.stderr)
            for name in ['native-delta.json', 'native-api.json', 'upstream-actions.json', 'sbom-comparison.json']:
                with self.subTest(table=name):
                    self.assertEqual((output / name).read_bytes(), (CATALOG / name).read_bytes())


if __name__ == '__main__':
    unittest.main()
