'use strict';
const fs = require('node:fs');
// Memory-depth benchmark runner: drives the real adapter protocol over the
// frozen memory-depth-bench-v1 case, then scores answers programmatically.
// Model comes from --settings-file (gpt-6-luna). Read-only: no QQ sends.
const path = require('node:path');
const { createAdapterFactory } = require(path.resolve(process.argv[2] || './scripts/eval-qq-adapter.cjs'));
const caseJson = require(process.argv[3] || '../evals/memory-bench/memory-depth-bench-v1.json');
const registry = require(process.argv[4] || '../evals/memory-bench/registry.json');

const ROOT = path.resolve(__dirname, '..');
const REPO = ROOT;

async function main() {
  const factory = await createAdapterFactory({
    live: true,
    sourceRoot: ROOT,
    settingsFile: process.env.MB_SETTINGS || path.join(REPO, 'data/settings.json'),
    maxHttp: Number(process.env.MB_MAX_HTTP || 200),
    timeoutMs: 1200000,
  });
  const adapter = await factory.create();
  const episode = { status: 'running', steps: [] };
  await adapter.open(JSON.parse(JSON.stringify(caseJson.initial)), { goal: caseJson.runtime_goal });
  const drain = async (stepId, at, phase) => {
    if (!adapter.drainOutputs) return [];
    const outputs = await adapter.drainOutputs();
    return outputs.map(o => ({ stepId, at, phase, text: (o && o.text || '').slice(0, 160), disposition: o && o.disposition }));
  };
  let drained = [];
  for (const step of caseJson.steps) {
    if (step.qq_events && step.qq_events.length) {
      await adapter.advanceTo(step.as_of);
      for (const event of step.qq_events) await adapter.observe([JSON.parse(JSON.stringify(event))]);
      drained.push(...await drain(step.id, step.as_of, 'session'));
    }
    if (step.request) {
      await adapter.advanceTo(step.as_of);
      let answer;
      try { answer = await adapter.respond({ id: step.request.id, at: step.request.at, text: step.request.text }); }
      catch (e) { throw new Error('QA step ' + step.id + ' respond failed: ' + e.message); }
      try {
        const diag = await adapter.diagnostics();
        const msgs = diag.snapshot && diag.snapshot.messages || [];
        const memView = diag.snapshot && (diag.snapshot.publicMemoryView || diag.snapshot.memoryView) || null;
        fs.writeFileSync('/tmp/mb-diag-' + step.id + '.json', JSON.stringify({ storeMessages: msgs.map(m => ({ direction: m.direction, kind: m.kind, text: String(m.text || '').slice(0, 40) })), companionTurns: (diag.snapshot.companion && diag.snapshot.companion.turns || []).map(t => ({ role: t.role, kind: t.kind, text: String(t.text || '').slice(0, 40) })), memView }, null, 1));
      } catch (e) {}
      const meta = registry[Number(step.id.split('-')[1])] || {};
      drained.push(...await drain(step.id, step.as_of, 'post_qa'));
      episode.steps.push({ id: step.id, ask: step.request.text, answer: (answer && answer.text || ''), category: meta.cat, expect: meta.expect || null, abstain: !!meta.abstain });
    }
  }
  // Score
  const rows = episode.steps.map(s => {
    const text = s.answer || '';
    let verdict;
    const norm = t => String(t || '').replace(/\s+/g, '');
    if (s.abstain) {
      const fabricated = /\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\b\d{4}-\d{2}-\d{2}\b|某公司|有限公司|公司叫/.test(text);
      const hasHedge = /(没有?提到|没说过|不知道|不记得|没有告诉|没法确定|不想猜|没有.*信息|没有.*日期)/.test(text);
      verdict = fabricated ? 'fail_fabricated' : (hasHedge ? 'pass' : 'pass_weak');
    } else {
      const normText = norm(text);
      const hits = (s.expect || []).filter(kw => normText.includes(norm(kw)));
      verdict = hits.length === (s.expect || []).length ? 'pass' : (hits.length ? 'partial' : 'fail');
    }
    return { ask: s.ask, category: s.category, verdict, answer: text.slice(0, 140) };
  });
  const byCat = {};
  for (const row of rows) {
    byCat[row.category] = byCat[row.category] || { pass: 0, partial: 0, fail: 0, pass_weak: 0, fail_fabricated: 0 };
    byCat[row.category][row.verdict]++;
  }
  const report = { model: process.env.MB_MODEL_TAG || 'gpt-6-luna', generated: new Date().toISOString(),
    totals: rows.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {}),
    byCategory: byCat, rows, drainedPreRequest: drained.filter(d => d.phase === 'session').length };
  const outDir = path.join(ROOT, 'evals/memory-bench/runs');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(outDir, 'report-' + stamp + '.json'), JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ totals: report.totals, byCategory: report.byCategory }, null, 1));
  await adapter.close().catch(() => {});
}
main().catch(e => { console.error('BENCH_FAIL:', e.message); process.exit(1); });