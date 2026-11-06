"""Record bounded execution evidence, excluding provider payloads and secrets."""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import re
import shutil

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
def read_json(path):
    return json.loads(Path(path).read_text())

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

checks = {}
for label, filename in [('focused', '/tmp/qq-eval-settings-tests-20261105-postreview.log'),
                        ('compatibility', '/tmp/qq-eval-settings-compatibility-20261105.log')]:
    text = Path(filename).read_text()
    values = {key: int(re.search(rf'ℹ {key} (\d+)', text).group(1)) for key in ['tests', 'pass', 'fail']}
    if values['fail'] or values['tests'] != values['pass']:
        raise ValueError(f'Validation is not green: {filename}')
    target = HERE/f'{label}-tests.log'
    shutil.copyfile(filename, target)
    checks[label] = {**values, 'log': target.name, 'sha256': sha(target)}

pilots = []
for name, label in [('qq-stream-luna-updated-20261105-boundary-v1', 'E2E 首次边界样本 · 原版本保留'),
                    ('qq-stream-luna-updated-20261105-frozen-v1', 'E2E 冻结源码样本 · 2 次求助')]:
    folder = Path('/tmp')/name
    manifest, transport = read_json(folder/'manifest.json'), read_json(folder/'transport.json')
    preparation = read_json(folder/'stream-temporary-state-updated.preparation.json')
    pilots.append({'label': label, 'artifacts': str(folder), 'status': manifest['status'],
                   'http_attempts': transport['http_attempts'], 'blocked_attempts': transport['blocked_attempts'],
                   'settings_unchanged': transport['settings_unchanged'], 'identity': manifest['identity'],
                   'manifest_sha256': sha(folder/'manifest.json'), 'transport_sha256': sha(folder/'transport.json'),
                   'forced_prefix_maintenance_requests': preparation['forced_maintenance_requests'],
                   'preparation_model_requests': preparation['model_requests'],
                   'quality': '未评审；无语义分数'})

folder = Path('/tmp/qq-component-luna-boundary-20261105-frozen-v1')
manifest, summary = read_json(folder/'manifest.json'), read_json(folder/'adapter-summary.json')
pilots.append({'label': '组件冻结样本 · 2 个受控判别', 'artifacts': str(folder), 'status': manifest['status'],
               'http_attempts': summary['http_attempts'], 'blocked_attempts': summary['blocked_attempts'],
               'settings_unchanged': summary['settings_unchanged'], 'identity': manifest['identity'],
               'manifest_sha256': sha(folder/'manifest.json'), 'transport_sha256': sha(folder/'adapter-summary.json'),
               'quality': '未评审；无语义分数'})

bundle = Path('/tmp/qq-eval-settings-frozen-20261105-v1')
bundle_manifest = read_json(bundle/'bundle-manifest.json')
if any(sha(bundle/name) != expected for name, expected in bundle_manifest['file_sha256'].items()):
    raise ValueError('The historical live source bundle changed')

total = sum(item['http_attempts'] for item in pilots)
if total > 14 or any(not item['settings_unchanged'] for item in pilots):
    raise ValueError('Declared model budget or configuration invariant violated')

report = {
    'recorded_at': datetime.now(timezone.utc).isoformat(),
    'purpose': 'Project-matched evaluation settings and execution-boundary evidence, not quality acceptance',
    'user_selected_settings': ['streaming_e2e', 'controlled_component'],
    'validation': {'test_summary': f'{checks["focused"]["pass"] + checks["compatibility"]["pass"]} 项离线检查通过（{checks["focused"]["pass"]} 项设置/回放检查 + {checks["compatibility"]["pass"]} 项兼容性检查）', 'checks': checks},
    'pilots': pilots,
    'retained_initialization_failure': {
        'setting': 'component', 'stage': 'standalone CLI adapter import before provider dispatch',
        'message': "Cannot destructure property '$schema' of 'OUTPUT_SCHEMA' as it is undefined.",
        'http_attempts': 0, 'evidence': 'Observed command/tool error; this pre-fix invocation created no run artifacts.',
        'repair': 'Initialize exports before CLI main; add real subprocess regression and persist subsequent general setup failures.'},
    'model': 'gpt-6-luna', 'provider_configuration_changed': False,
    'total_actual_http_attempts': total, 'declared_caps': {'e2e_all_versions': 12, 'component': 2},
    'jev_calls': 0, 'semantic_evaluation': 'not_run', 'desktop_qq': False,
    'frozen_live_source_bundle': {'path': str(bundle), 'manifest_sha256': sha(bundle/'bundle-manifest.json'), 'files': len(bundle_manifest['file_sha256']), 'unchanged': True},
    'current_dataset_identities': {name: sha(ROOT/name) for name in ['evals/assistant-stream/cases.jsonl', 'evals/memory-decisions/cases.jsonl', 'evals/memory-decisions/output.schema.json']},
    'post_pilot_revisions': ['Stream seed-source attestation metadata; original runtime events and reviewer criteria retained.',
                            'Component setup-failure evidence hardening; independent raw-data reference and common-semantics clarification.',
                            'Current contract/refinements were not paid-replayed; prior live results remain bound to the frozen v1 contract and hashes.'],
    'limits': ['All pilot quality reviews remain ungraded.', 'No JEV comparison or speed/quality improvement is established.',
               'Sequential synthetic-boundary E2E does not establish concurrent ingress, real desktop or restart persistence.',
               'Controlled evidence relation diagnosis is not the current production memory writer.']
}
(HERE/'validation-evidence.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
print(json.dumps({'tests_passed': checks['focused']['pass'] + checks['compatibility']['pass'], 'actual_http': total, 'model_quality': 'not_run', 'bundle_unchanged': True}))
