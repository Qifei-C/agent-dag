"""Read selected research metadata only; never execute experiment commands."""
import json
import os
import pathlib
import sys
from datetime import datetime, timezone
import yaml

root = pathlib.Path(sys.argv[1]).resolve()
names = sys.argv[2:]
coordinator = os.environ.get('DAG_WEB_COORDINATOR')
result = {'research': {}, 'researchUpdatedAt': None, 'artifacts': {}, 'errors': []}
try:
    p = root / 'research-state.yaml'
    result['research'] = yaml.safe_load(p.read_text()) or {}
    result['researchUpdatedAt'] = datetime.fromtimestamp(p.stat().st_mtime, timezone.utc).isoformat()
except Exception as e:
    result['errors'].append('research-state.yaml: ' + str(e))
for name in names:
    files = []
    bases = [root / 'reports/agents' / name]
    if name == coordinator:
        bases += [root / 'reports/handoffs']
    count = 0
    for base in bases:
        if not base.exists():
            continue
        for folder, dirs, entries in os.walk(base, followlinks=False):
            dirs[:] = [d for d in dirs if not d.startswith('.') and d not in
                       {'deps', 'node_modules', '__pycache__', 'site-packages', 'cpu_fixture_positive', 'remote'}
                       and len((pathlib.Path(folder) / d).relative_to(base).parts) <= 5]
            for entry in entries:
                count += 1
                p = pathlib.Path(folder) / entry
                if p.suffix not in {'.md', '.json', '.yaml', '.txt'} or p.is_symlink():
                    continue
                try:
                    st = p.stat()
                    if st.st_size > 1500000:
                        continue
                    files.append({'path': str(p.relative_to(root)), 'name': entry, 'bytes': st.st_size,
                                  'updatedAt': datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat()})
                except OSError:
                    continue
            if count > 8000:
                break
    result['artifacts'][name] = sorted(files, key=lambda f: f['updatedAt'], reverse=True)[:8]
print(json.dumps(result, default=str, ensure_ascii=False))
