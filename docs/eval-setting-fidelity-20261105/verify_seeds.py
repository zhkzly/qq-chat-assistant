"""Verify recorded fictional seed hashes and source IDs; do not score labels."""
from pathlib import Path
import hashlib
import json

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
def read_rows(filename):
    return [json.loads(line) for line in filename.read_text().splitlines() if line.strip()]

def ids_in(value):
    found = set()
    if isinstance(value, dict):
        if isinstance(value.get('id'), str):
            found.add(value['id'])
        for field, nested in value.items():
            if field not in ('reviewer_only', 'evaluation', 'review'):
                found.update(ids_in(nested))
    elif isinstance(value, list):
        for nested in value:
            found.update(ids_in(nested))
    return found

results = []
for dataset, style in [('evals/memory-decisions/cases.jsonl', 'component'), ('evals/assistant-stream/cases.jsonl', 'stream')]:
    for case in read_rows(ROOT/dataset):
        references = case['source_seed']['references'] if style == 'component' else [case['seed']]
        for ref in references:
            relative = ref['path'] if style == 'component' else ref['source']
            source = (ROOT/relative).resolve()
            if not source.is_relative_to(ROOT/'evals') or source.suffix != '.jsonl':
                raise ValueError('Seed audit only reads project fictional eval JSONL sources')
            actual_hash = hashlib.sha256(source.read_bytes()).hexdigest()
            original = next((item for item in read_rows(source) if item['id'] == ref['case_id']), None)
            if original is None:
                raise ValueError(f'Missing source case: {relative}: {ref["case_id"]}')
            requested = ref['event_ids'] if style == 'component' else ref['raw_ids']
            missing = sorted(set(requested)-ids_in(original))
            expected_hash = ref.get('sha256')
            matched = not missing and (expected_hash is None or expected_hash == actual_hash)
            results.append({'dataset': dataset, 'case_id': case['id'], 'source': relative, 'source_case_id': ref['case_id'],
                            'referenced_ids': requested, 'missing_ids': missing, 'source_sha256': actual_hash,
                            'embedded_expected_sha256': expected_hash, 'verified': matched})
            if not matched:
                raise ValueError(f'Seed provenance mismatch: {case["id"]}')

report = {'kind': 'fictional_seed_provenance_audit', 'status': 'verified', 'references': results,
          'scope': 'source file bytes, source case IDs and referenced raw IDs; adaptations and semantic labels require separate review',
          'model_calls': 0, 'semantic_quality': 'not_evaluated'}
(HERE/'seed-provenance-audit.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
print(json.dumps({'status': 'verified', 'references': len(results), 'model_calls': 0}))
