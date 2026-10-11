#!/usr/bin/env python3
"""Verify every vendored input against its reviewed source hash before CI builds."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'source-provenance.json').read_text())
for path, expected in manifest['files'].items():
    assert hashlib.sha256((root / 'app' / path).read_bytes()).hexdigest() == expected, path
files = {str(p.relative_to(root / 'app')) for p in (root / 'app').rglob('*')
         if p.is_file() and not any(part in {'node_modules', 'dist'} for part in p.parts)}
assert files == set(manifest['files']), ('unexpected or missing vendored files', files ^ set(manifest['files']))
print(f"Verified {len(files)} unchanged source files from {manifest['sourceCommit']}")
