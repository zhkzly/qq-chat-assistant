"""Build the offline review from public research and source-only evidence."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import html
import json

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
data = json.loads((HERE / 'report-data.json').read_text())
proposal = json.loads((HERE / 'evaluation-proposal_CN.json').read_text())
check = json.loads((HERE / 'local-dataset-check.json').read_text())
replay = json.loads((HERE / 'local-replay-inventory.json').read_text())
memory = json.loads((HERE / 'local-memory-inventory.json').read_text())
probe = json.loads((HERE / 'scorer-probe.json').read_text())

evidence = {}
def capture(path, line=None, needle=None):
    raw = (ROOT / path).read_bytes()
    lines = raw.decode().splitlines()
    if needle:
        matches = [i + 1 for i, text in enumerate(lines) if needle in text]
        if not matches:
            raise ValueError(f'Missing source anchor: {path}: {needle}')
        line = matches[0]
    line = line or 1
    first, last = max(1, line - 2), min(len(lines), line + 7)
    key = f'{path}:{line}'
    evidence[key] = {'path': path, 'line': line, 'sha256': hashlib.sha256(raw).hexdigest(),
                     'from': first, 'to': last,
                     'excerpt': '\n'.join(f'{i}: {lines[i-1]}' for i in range(first, last + 1))}
    return key

for layer in data['layers']:
    layer['evidence_key'] = capture(layer['path'], layer['line'])
for finding in data['findings']:
    finding['evidence_keys'] = [capture(ref['path'], needle=ref['needle']) for ref in finding['refs']]
for finding in data['findings'][:2]:
    finding['kind'] = '离线评分探针复现'
    finding['probe'] = '抽取现有评分片段：正确对照 pass；两个已知坏输出 pass，另一个坏输出 pass_weak。仅测试评分逻辑，未调用模型。'

payload = {'review': data, 'proposal': proposal, 'evidence': evidence, 'probe': probe,
           'local': {'check': check, 'replay': replay, 'memory': memory},
           'built_at': datetime.now(timezone.utc).isoformat()}
(HERE / 'source-evidence.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
serialized = json.dumps(payload, ensure_ascii=False).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
diagram = html.escape((HERE / 'architecture.html').read_text())

template = r'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="description" content="QQ 助手的场景评分草案、上下文与记忆设计、公开数据集映射和可证伪检查。">
<title>QQ 助手 · 场景评测与记忆设计</title>
<style>
:root{--bg:#f4f4ed;--paper:#fffef9;--ink:#203a35;--muted:#62736b;--line:#d8dfd5;--accent:#246553;--soft:#e7eee6;--amber:#86621d;--amberbg:#f6eed8;--red:#9a3c36;--redbg:#f8eae5;--code:#eef1e9;--shadow:0 12px 32px #203a3507}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.75 system-ui,-apple-system,"Noto Sans CJK SC","Microsoft YaHei",sans-serif}body.dark{--bg:#15221e;--paper:#1c2c26;--ink:#e5eee2;--muted:#afc0b3;--line:#3b5045;--accent:#9dd2af;--soft:#2a4034;--amber:#e5c77d;--amberbg:#3b3522;--red:#efaaa0;--redbg:#402c28;--code:#263a30;--shadow:none}button,input,select{font:inherit}button,a,input{touch-action:manipulation}a{color:var(--accent);text-underline-offset:3px}button{cursor:pointer;color:inherit;background:var(--paper);border:1px solid var(--line);border-radius:9px;padding:8px 14px}button:hover{border-color:var(--accent);background:var(--soft)}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #b38a3e;outline-offset:3px}button.primary{background:var(--accent);color:var(--paper);border-color:var(--accent)}.top{padding:18px 32px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:12px;background:var(--paper)}.brand{font-weight:750;letter-spacing:.04em;font-size:14px}.brand span{font-weight:400;color:var(--muted);margin-left:12px}.top-actions{display:flex;gap:8px;flex-wrap:wrap}.layout{max-width:1536px;margin:auto;display:grid;grid-template-columns:224px minmax(0,1fr);gap:40px;padding:38px 32px 72px}.sidebar{align-self:start;position:sticky;top:24px}.side-label,.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.16em;font-weight:750;color:var(--muted)}nav{display:grid;gap:7px;margin:14px 0 24px}nav button{text-align:left;padding:12px;background:transparent;border-color:transparent}nav button[aria-selected=true]{background:var(--ink);color:var(--paper);border-color:var(--ink)}.navnum{opacity:.65;font-size:12px;margin-right:10px;font-family:monospace}.side-note{font-size:12px;color:var(--muted);padding:18px 12px;border-top:1px solid var(--line)}main{min-width:0}.hero{border-bottom:1px solid var(--line);padding-bottom:28px;margin-bottom:26px}.eyebrow{color:var(--accent)}h1{font-size:clamp(30px,3vw,48px);line-height:1.25;letter-spacing:-.04em;margin:14px 0 18px;font-weight:760}h2{font-size:26px;line-height:1.45;margin:0 0 14px}h3{font-size:18px;line-height:1.5;margin:0 0 10px}h4{font-size:14px;margin:14px 0 5px}p{margin:0 0 12px}.lead{font-size:17px;max-width:830px;color:var(--muted)}.badge{display:inline-block;font-size:11px;line-height:1.5;padding:4px 8px;border-radius:5px;background:var(--soft);color:var(--accent);font-weight:650;vertical-align:middle}.badge.amber{color:var(--amber);background:var(--amberbg)}.badge.red{color:var(--red);background:var(--redbg)}.meta{display:flex;gap:9px;flex-wrap:wrap;margin:18px 0 0}.panel[hidden]{display:none}.callout{border-left:3px solid var(--accent);padding:16px 20px;background:var(--soft);margin:20px 0}.callout.amber{border-color:var(--amber);background:var(--amberbg)}.callout.red{border-color:var(--red);background:var(--redbg)}.muted{color:var(--muted)}.small{font-size:12px}.section{margin:30px 0}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:22px;box-shadow:var(--shadow);min-width:0}.card.wide{grid-column:1/-1}.card p:last-child{margin-bottom:0}.cardhead{display:flex;justify-content:space-between;align-items:start;gap:12px;margin-bottom:10px}.dim-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:24px 0 16px}.dim{padding:18px 12px;text-align:left;min-height:104px;display:block}.dim b{display:block;font-size:14px;margin-top:8px}.dim.active{border:2px solid var(--accent);background:var(--soft)}.dim span{font:12px ui-monospace,monospace;color:var(--muted)}.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--paper);margin:14px 0}table{border-collapse:collapse;width:100%;font-size:13px}th{text-align:left;background:var(--soft);font-size:12px;color:var(--muted)}th,td{padding:14px 16px;vertical-align:top;border-bottom:1px solid var(--line)}tr:last-child td{border-bottom:0}th:first-child,td:first-child{min-width:140px}td b{font-size:14px}.table-wide{min-width:720px}code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}code{background:var(--code);padding:2px 5px;border-radius:4px;font-size:.86em;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--code);padding:18px;border-radius:8px;font-size:12px;line-height:1.65;margin:12px 0}details{border-top:1px solid var(--line);padding:12px 0 0;margin-top:14px}summary{cursor:pointer;color:var(--accent);font-size:13px;font-weight:600;overflow-wrap:anywhere}.filters{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.filters button{font-size:12px;border-radius:24px;padding:6px 14px}.filters button.active{background:var(--ink);color:var(--paper);border-color:var(--ink)}.benchcard .tags{margin:9px 0 14px;display:flex;gap:5px;flex-wrap:wrap}.two-col{display:grid;grid-template-columns:1fr 1fr;gap:18px}.label{font-size:11px;letter-spacing:.06em;color:var(--muted);font-weight:700;display:block;margin-bottom:5px}.diagram{border:1px solid var(--line);border-radius:14px;margin-top:16px;background:white}.diagram iframe{display:block;width:100%;height:710px;border:0;border-radius:14px}.diagramhint{padding:12px 18px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--line)}.step-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:18px}.stepdot{border-radius:50%;width:36px;height:36px;padding:0}.stepdot.active{background:var(--accent);color:var(--paper)}.trace-card{min-height:320px}.trace-title{font-size:27px;margin:12px 0 20px}.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:18px 0}.stat{padding:18px;background:var(--paper);border:1px solid var(--line);border-radius:12px}.stat b{display:block;font-size:28px;line-height:1.3}.stat span{font-size:12px;color:var(--muted)}ul,ol{padding-left:22px;margin:10px 0}li{margin:7px 0}.footer{margin-top:38px;padding-top:18px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}.check{font-family:monospace;color:var(--accent)}.source-list{display:grid;gap:12px}.source-item{padding:16px;border:1px solid var(--line);border-radius:9px;background:var(--paper)}.source-item p{font-size:12px;margin:6px 0 0;color:var(--muted)}.anchorlink{font-size:12px;overflow-wrap:anywhere}.nav-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}.no-results{padding:24px;color:var(--muted)}.result-count{margin-left:auto;font-size:12px;color:var(--muted)}.line-list>li{margin:14px 0}.critical{display:flex;flex-wrap:wrap;gap:8px}.critical .badge{padding:7px 11px}.source-index{word-break:break-word}.kicker{font-size:12px;color:var(--accent);font-family:monospace}input[type=search]{width:100%;border:1px solid var(--line);border-radius:10px;padding:10px 13px;color:var(--ink);background:var(--paper)}.search-row{max-width:520px;margin:18px 0}.screen-label{font-weight:600;color:var(--accent)}
@media(min-width:1800px){.layout{gap:52px}}@media(max-width:1000px){.layout{grid-template-columns:170px minmax(0,1fr);gap:20px;padding:26px 20px}.dim-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.grid,.two-col{grid-template-columns:1fr}.diagram iframe{height:630px}}@media(max-width:700px){.top{padding:14px 16px;align-items:start}.brand span{display:block;margin:0}.layout{display:block;padding:20px 16px}.sidebar{position:static}nav{grid-template-columns:repeat(3,minmax(0,1fr));gap:5px;margin:8px 0 22px}nav button{padding:8px 4px;text-align:center;font-size:12px}.navnum{display:none}.side-note,.side-label{display:none}h1{font-size:32px}.hero{padding-bottom:22px}.dim-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dim{min-height:88px}.stats{gap:8px}.stat{padding:12px}.stat b{font-size:23px}.card{padding:18px}.diagram iframe{height:530px}.top-actions button{font-size:12px;padding:5px 9px}.table-wide{min-width:650px}}@media print{.top-actions,.sidebar,.nav-actions,.filters,.step-controls{display:none}.layout{display:block;max-width:none;padding:10px}.panel[hidden]{display:block}body{background:white;color:#111}.card{break-inside:avoid}.section{break-inside:auto}.diagram{display:none}.hero{break-after:avoid}.panel{break-before:page}.panel:first-child{break-before:auto}}
</style></head><body>
<header class="top"><div class="brand">QQ ASSISTANT <span>场景评测与设计审视 · 2026.11.05</span></div><div class="top-actions"><button id="theme" aria-label="切换明暗主题">明暗切换</button><button id="export">导出评测草案</button><button id="print">打印 / PDF</button></div></header>
<div class="layout"><aside class="sidebar"><div class="side-label">Review notebook / 01</div><nav role="tablist" aria-label="报告章节">
<button role="tab" id="tab-proposal" data-tab="proposal" aria-controls="proposal" aria-selected="true"><span class="navnum">01</span>先定评分</button>
<button role="tab" id="tab-design" data-tab="design" aria-controls="design" aria-selected="false"><span class="navnum">02</span>当前设计</button>
<button role="tab" id="tab-trace" data-tab="trace" aria-controls="trace" aria-selected="false"><span class="navnum">03</span>追踪一条消息</button>
<button role="tab" id="tab-questions" data-tab="questions" aria-controls="questions" aria-selected="false"><span class="navnum">04</span>保持质疑</button>
<button role="tab" id="tab-bench" data-tab="bench" aria-controls="bench" aria-selected="false"><span class="navnum">05</span>公开数据怎么用</button>
<button role="tab" id="tab-plan" data-tab="plan" aria-controls="plan" aria-selected="false"><span class="navnum">06</span>Luna 快测方案</button>
</nav><div class="side-note">先问“帮上忙了吗”，再看存储和检索。<br><br>已做：源码核对、公开资料检索、离线数据校验与评分探针。<br><br>未做：本轮模型质量实验、真实 QQ 桌面测试。<br><br><code>b74e111</code><br>工作区未提交文件另有哈希记录。</div></aside><main>
<section id="proposal" class="panel" role="tabpanel" aria-labelledby="tab-proposal">
<div class="hero"><div class="eyebrow">场景先行 / EVALUATION PROPOSAL</div><h1>先定义怎样才算<br>帮上忙，再选择 benchmark。</h1><p class="lead">我们的目标是持续理解两个人的处境，辅助真实、得体的交流。评分应覆盖“记得对、更新对、用得对、表达忠实、帮助有用”，而不只看是否答出旧事实。</p><div class="meta"><span class="badge">5 个行为维度</span><span class="badge amber">草案 · 尚未执行</span><span class="badge">Luna 作为快速被测模型</span></div></div>
<p>点击一个维度，查看它的评分锚点、反例及可复用的数据。<strong>先不设加权总分</strong>，保留各维度分布和关键错误，避免“话说得自然”抵消错记事实。</p>
<div class="dim-grid" id="dimensions"></div><div class="card" id="dimension-detail" aria-live="polite"></div>
<div class="section"><h2>关键错误单列，效用也必须单评</h2><div class="critical" id="critical"></div><p class="small muted" style="margin-top:12px">不是每一题都适用所有维度。可标 N/A，但要解释；一味不答、反复追问也拿不到高效用分。评分不要求某一种 memory schema 或工具顺序。</p></div>
<div class="section"><h2>第一版不必从零写一大套</h2><p>建议 12 个母体历史，每个配 2 个关键条件不同的对照，共 24 个回放案例。<strong>先跑其中 6 个母体的 12 例</strong>，看哪类失败值得追。</p><div id="mix-table"></div><p class="small muted">这是拟议构成，尚未创建新案例。先复用现有回放与公开原始历史；没有必要为了规模重写全部数据。</p></div>
<div class="callout"><b>这轮想检验的核心问题</b><br>在相同 Luna、相同原始历史与资源条件下，完整上下文/记忆方案，是否比“近期原文”或“原文检索”更可靠、更有用？增加的成本是否值得？</div>
<div class="nav-actions"><button class="primary" data-jump="bench">看各类数据怎么用 →</button><button data-jump="design">对照当前设计</button></div>
</section>
<section id="design" class="panel" role="tabpanel" aria-labelledby="tab-design" hidden>
<div class="hero"><div class="eyebrow">SOURCE-TRACED DESIGN</div><h1>保存、理解、交付，<br>是三件不同的事。</h1><p class="lead">原始记录在本地 SQLite；长期理解带来源和版本；每次请求再按任务、相关性与预算组装模型输入。当前主调用直接生成完整候选，随后核验发布。</p><div class="meta"><span class="badge">源码关系已核对</span><span class="badge amber">效果仍需实际输出评审</span></div></div>
<div class="diagram"><div class="diagramhint">架构图可缩放、搜索、切换主题和导出。<a href="architecture.html" target="_blank" rel="noopener">独立打开架构图 ↗</a>　下方各卡有源码快照。补查回路与失效关系为简化阅读未全部画入图中。</div><iframe id="diagram" title="QQ 助手上下文与记忆架构" sandbox="allow-scripts allow-downloads" referrerpolicy="no-referrer"></iframe></div>
<div class="section"><h2>各部分的职责与未解问题</h2><div class="grid" id="layers"></div></div>
<div class="callout amber"><b>不要把模块存在当成已上线</b><br>主流程目前仍走词法 BM25；向量检索、JEV 和新的维护编排模块尚未接到主入口。新 admission 核心与旧 selection 协作；完整字节上限也不是模型 tokenizer 的容量证明。</div>
</section>
<section id="trace" class="panel" role="tabpanel" aria-labelledby="tab-trace" hidden>
<div class="hero"><div class="eyebrow">FICTIONAL WALKTHROUGH</div><h1>一条消息，<br>到底经过了哪些转换？</h1><p class="lead">以下是解释数据流的虚构示例，不是模型回放，也不代表这些语义已经被软件正确理解。每一步都对应一个可观察的检查点。</p></div><div class="step-controls" id="steps"></div><div class="card trace-card" id="trace-detail" aria-live="polite"></div><div class="nav-actions"><button id="prev-step">← 上一步</button><button id="next-step">下一步 →</button><button data-jump="proposal">映射到评分维度</button></div>
</section>
<section id="questions" class="panel" role="tabpanel" aria-labelledby="tab-questions" hidden>
<div class="hero"><div class="eyebrow">FALSIFIABLE QUESTIONS</div><h1>设计值得保留，<br>需要哪些反证机会？</h1><p class="lead">已复现的评分缺口、源码确认的机制和待实验假设分开记录。每个风险都有能区分原因的下一检查，而不是直接建议加组件或重写。</p></div>
<div class="callout red"><b>现有 memory-depth 评分不宜直接作验收依据。</b><br>离线抽取原评分片段测试：正确对照 pass；“正确词 + 被禁止旧事实”和“否定正确词”也 pass；编造工作单位被标 pass_weak。没有调用模型，也没有修改原评分脚本。</div>
<details><summary>展开离线探针的四条固定输出</summary><div id="probe-table"></div><p class="small muted">这是 scorer fixture 检查，不是对实际 Luna 输出的质量评价。源码哈希、原评分片段与固定输出保存在 scorer-probe.json。</p></details>
<div class="filters" id="finding-filters"></div><div class="grid" id="findings"></div>
</section>
<section id="bench" class="panel" role="tabpanel" aria-labelledby="tab-bench" hidden>
<div class="hero"><div class="eyebrow">BENCHMARK → SCENARIO MAPPING</div><h1>用公开数据补能力面，<br>保留我们的场景边界。</h1><p class="lead">LongMemEval 更适合查时间与更新；LoCoMo-Conv / Plus 更贴近隐式求助；PersonaMem 补偏好应用。QQ 的私下权限、实发、撤回和持续商量仍需项目原生数据。</p><div class="meta"><span class="badge">一手论文 / 官方仓库</span><span class="badge amber">本次未运行公开 benchmark</span></div></div>
<div class="search-row"><label class="small muted" for="bench-search">按名称、能力或局限搜索</label><input type="search" id="bench-search" placeholder="例如：隐式、时间、拒答、偏好"></div><div class="filters" id="bench-filters"></div><div class="grid" id="benchmarks"></div>
<div class="section"><h2>数据进入软件前，先检查这三件事</h2><div class="grid"><div class="card"><h3>角色不能改错</h3><p>LongMemEval 是 user/assistant 历史。助手回答不能为了适配 QQ 被改成对方实际说的话。LoCoMo 两个人物则要显式映射到 self/contact。</p></div><div class="card"><h3>答案字段不能进入产品</h3><p><code>answer</code>、<code>has_answer</code>、<code>answer_session_ids</code>、<code>qa.evidence</code> 和期望理解只给评审。用原始事件重建本系统自己的记忆。</p></div><div class="card wide"><h3>改编后的分数是新协议</h3><p>翻译、角色转换、追加“未发送/已发送”或“允许/不允许分享”等条件后，记录来源和变更；分别报告原协议与 QQ 改编版。所有同源会话变体在同一个 split，防止同母体泄漏。</p></div></div></div>
<div class="section"><h2>公开来源与核对范围</h2><div id="sources" class="source-list"></div></div>
</section>
<section id="plan" class="panel" role="tabpanel" aria-labelledby="tab-plan" hidden>
<div class="hero"><div class="eyebrow">LUNA PILOT / NOT STARTED</div><h1>先用小批对照，<br>定位哪一步没有帮上忙。</h1><p class="lead">Luna 测的是整个软件：从原始事件、正常记忆维护和上下文组装到实际回答。只把整理好的材料交给裸模型，测不到系统本身。</p></div>
<div class="section"><h2>三个基线，一个诊断上界</h2><div id="baseline-table"></div><p class="small muted">各臂保持相同行为规则、权限检查、时间条件和版本校验。诊断上界不是可发布系统；不能用它的 gold 原文替正常检索得分。</p></div>
<div class="section"><h2>构造流程</h2><ol class="line-list" id="construction"></ol></div>
<div class="section"><h2>Luna 怎么用，评分怎么独立</h2><ol class="line-list" id="luna-plan"></ol></div>
<div class="section"><h2>行为分之外，单独记录系统指标</h2><div id="system-metrics" class="critical"></div><p class="small muted" style="margin-top:14px">“找到了来源 → 真正交付给模型 → 模型正确使用”分别观察。没有证据时标未知；未完成不是失败率里的隐形删样。</p></div>
<details><summary>查看一个示意 case：产品输入与评审要求分开</summary><p class="small muted">只是字段示意，尚未注册为可执行案例。不给唯一参考句，允许多个合适表达。</p><pre id="case-example"></pre></details>
<div class="section"><h2>本次实际做了什么</h2><div id="local-stats" class="stats"></div><div class="card"><div id="local-results"></div><p class="small muted">现有原生回放有准备阶段的受控整理，不能用其通过替代正常空闲调度证明。memory-understanding 另有显式 scheduled-idle 条件；README 状态可能滞后，以当前 runner、inventory 和实际工件为准。</p><pre>npm run eval:check
npm run eval:list
npm run eval:replay:list
node scripts/eval-memory-understanding.cjs --list</pre><p>以上均已执行，未调用被测模型。当前工作区还有独立 memory-depth 脚本，它默认 live，不能当上述 inventory 命令使用；本次只读取源码并抽取评分片段。</p></div></div>
<div class="section"><h2>建议的第一轮顺序</h2><ol class="line-list"><li>先校准 scorer：已知好/坏输出、主体、否定、局部/长期、未知与撤回，确保错误不会被关键词命中放过。</li><li>冻结 12 例对照、五维锚点与预算；保留已有开发集，不声称它们是未见测试。</li><li>用 Luna 执行相同原始历史的三个方案，保留完整实际结果，独立盲审。</li><li>按首个偏差归因：没理解、没更新、没找到、没交付、没用对，还是表达不忠实；再决定是否改架构。</li></ol></div>
<details><summary>可复核的身份与工件</summary><div id="identity"></div></details>
</section>
<footer class="footer">离线 HTML · 无外部字体、脚本或服务依赖。来源链接联网打开；源码摘录、评测提案和图均随页面嵌入。<br>本文是方案讨论与源码审视，不声明当前软件质量通过，也没有启动 Goal、自动优化或修改生产数据。</footer>
</main></div><script type="application/json" id="report-data">__REPORT_DATA__</script><template id="diagram-document">__DIAGRAM_HTML__</template>
<script>
'use strict';
const D=JSON.parse(document.getElementById('report-data').textContent),R=D.review,P=D.proposal;
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const badge=(s,type='')=>`<span class="badge ${type}">${esc(s)}</span>`;
const sourceById=id=>R.sources.find(s=>s.id===id);
const citations=ids=>(ids||[]).map(id=>{const s=sourceById(id);return `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)} ↗</a>`}).join(' · ');
function evidence(keys){return keys.map(key=>{const e=D.evidence[key];return `<details><summary>${esc(e.path)}:${e.line} · 源码摘录</summary><pre>${esc(e.excerpt)}</pre><p class="small muted source-index">SHA-256 ${esc(e.sha256)}</p><a class="anchorlink" href="../../${esc(e.path)}" target="_blank" rel="noopener">打开工作区原文件 ↗</a></details>`}).join('')}
function table(headers,rows,wide=false){return `<div class="table-wrap"><table class="${wide?'table-wide':''}"><thead><tr>${headers.map(x=>`<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(x=>`<td>${x}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`}
let activeDim=0,step=0,benchFilter='全部',findingFilter='全部';
function dimension(i){activeDim=i;$('#dimensions').innerHTML=P.dimensions.map((d,j)=>`<button class="dim ${i===j?'active':''}" data-dim="${j}" aria-pressed="${i===j}"><span>${d.id}</span><b>${esc(d.name)}</b></button>`).join('');const d=P.dimensions[i];$('#dimension-detail').innerHTML=`<div class="cardhead"><h3>${esc(d.name)}</h3>${badge(d.id)}</div><p>${esc(d.question)}</p>${table(['得分','行为锚点'],[['2 · 做到',esc(d.two)],['1 · 部分做到',esc(d.one)],['0 · 未做到',esc(d.zero)]])}<div class="two-col"><div><h4>暴露问题的例子</h4><p>${esc(d.example)}</p></div><div><h4>必须保留的反例</h4><p>${esc(d.counter)}</p></div></div><p class="small muted">可借用的数据：${esc(d.sources)}</p>`}
function trace(i){step=Math.max(0,Math.min(R.trace.length-1,i));$('#steps').innerHTML=R.trace.map((_,j)=>`<button class="stepdot ${j===step?'active':''}" data-step="${j}" aria-label="第 ${j+1} 步" aria-pressed="${j===step}">${j+1}</button>`).join('')+`<span class="result-count">${step+1} / ${R.trace.length} · 虚构示意</span>`;const s=R.trace[step];$('#trace-detail').innerHTML=`<span class="kicker">CHECKPOINT 0${step+1}</span><h3 class="trace-title">${esc(s.title)}</h3><p>${esc(s.body)}</p><div class="callout"><span class="label">查看哪个表示</span>${esc(s.representation)}</div><p><span class="label">保持质疑</span>${esc(s.probe)}</p>`;$('#prev-step').disabled=step===0;$('#next-step').disabled=step===R.trace.length-1}
function findings(){const options=['全部','离线评分探针复现','待实验假设','P1'];$('#finding-filters').innerHTML=options.map(x=>`<button data-finding="${esc(x)}" class="${x===findingFilter?'active':''}" aria-pressed="${x===findingFilter}">${esc(x)}</button>`).join('');$('#findings').innerHTML=R.findings.filter(f=>findingFilter==='全部'||f.kind===findingFilter||f.priority===findingFilter).map(f=>`<article class="card"><div class="cardhead">${badge(f.priority,f.priority==='P1'?'red':'amber')}${badge(f.kind,f.kind==='待实验假设'?'amber':'')}</div><h3>${f.id} · ${esc(f.title)}</h3><span class="label">依据</span><p>${esc(f.evidence)}</p><span class="label">可能影响</span><p>${esc(f.risk)}</p><span class="label">区分性检查</span><p>${esc(f.check)}</p><span class="label">可比较的替代</span><p>${esc(f.alternative)}</p>${f.probe?`<p class="small muted">${esc(f.probe)}</p>`:''}${evidence(f.evidence_keys)}</article>`).join('')}
function benchmarks(){const opts=['全部','事实与更新','时间推理','隐式应用','长上下文','产品生命周期'];$('#bench-filters').innerHTML=opts.map(x=>`<button data-bench="${esc(x)}" class="${x===benchFilter?'active':''}" aria-pressed="${x===benchFilter}">${esc(x)}</button>`).join('');const q=$('#bench-search').value.trim().toLowerCase();const items=R.benchmarks.filter(b=>(benchFilter==='全部'||b.tags.includes(benchFilter))&&(!q||JSON.stringify(b).toLowerCase().includes(q)));$('#benchmarks').innerHTML=items.length?items.map(b=>`<article class="card benchcard"><div class="cardhead"><h3>${esc(b.name)}</h3>${badge(b.priority,b.priority==='暂缓'?'amber':'')}</div><div class="tags">${b.tags.map(x=>badge(x)).join('')}</div><span class="label">适合测什么</span><p>${esc(b.measures)}</p><span class="label">不能证明什么 · 本报告判断</span><p>${esc(b.cannot)}</p><details><summary>怎么接入、看什么指标</summary><h4>适配建议</h4><p>${esc(b.adapt)}</p><h4>指标</h4><p>${esc(b.metric)}</p><h4>成本与协议判断</h4><p>${esc(b.cost)} ${esc(b.protocol)}</p></details><p class="small" style="margin-top:15px">${b.source.length?citations(b.source):'<a href="../../evals/assistant/REPLAY.md" target="_blank">本地回放协议 ↗</a>'}</p></article>`).join(''):'<p class="no-results">没有匹配项。可以清空搜索或切回“全部”。</p>'}
function showTab(id,scroll=false){if(!document.getElementById('tab-'+id))id='proposal';$$('.panel').forEach(p=>p.hidden=p.id!==id);$$('[data-tab]').forEach(b=>{const active=b.dataset.tab===id;b.setAttribute('aria-selected',active);b.tabIndex=active?0:-1});if(id==='design'&&!$('#diagram').srcdoc)$('#diagram').srcdoc=$('#diagram-document').content.textContent;history.replaceState(null,'','#'+id);if(scroll)window.scrollTo({top:0,behavior:'auto'})}
$('#critical').innerHTML=P.critical_errors.map(x=>badge(x,'red')).join('');
$('#mix-table').innerHTML=table(['母体来源','母体 × 对照','回放数','用途'],P.data_plan.map(x=>[esc(x.source),`${x.histories} × ${x.variants}`,`<b>${x.episodes}</b>`,esc(x.purpose)]),true);
$('#layers').innerHTML=R.layers.map(l=>`<article class="card"><div class="cardhead"><h3>${esc(l.name)}</h3>${badge(l.status,l.status==='尚未接主入口'?'amber':'')}</div><p class="small muted">${esc(l.owner)}</p><p><span class="label">输入 → 输出</span>${esc(l.input)} → ${esc(l.output)}</p><p>${esc(l.purpose)}</p><p><span class="label">值得追问</span>${esc(l.question)}</p>${evidence([l.evidence_key])}</article>`).join('');
$('#probe-table').innerHTML=table(['固定样本','原评分结果','构造样本应判'],D.probe.fixtures.map(x=>[`${esc(x.id)}<br>${esc(x.answer)}`,badge(x.verdict,x.false_positive?'red':''),esc(x.fixture_expectation)]));
$('#sources').innerHTML=R.sources.map(s=>`<div class="source-item"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)} ↗</a><p>${esc(s.note)} · 核对日期 ${esc(R.date)}</p></div>`).join('');
$('#baseline-table').innerHTML=table(['方案','比较目的'],P.baselines.map(x=>[`<b>${esc(x.name)}</b>`,esc(x.detail)]));
$('#construction').innerHTML=P.construction.map(x=>`<li>${esc(x)}</li>`).join('');$('#luna-plan').innerHTML=P.luna_plan.map(x=>`<li>${esc(x)}</li>`).join('');$('#system-metrics').innerHTML=P.system_metrics.map(x=>badge(x)).join('');$('#case-example').textContent=JSON.stringify(P.case_envelope_example,null,2);
const replayCases=D.local.replay.cases.length,replaySteps=D.local.replay.cases.reduce((n,c)=>n+c.steps,0),muCases=D.local.memory.cases.length,muSteps=D.local.memory.cases.reduce((n,c)=>n+c.steps,0);
$('#local-stats').innerHTML=`<div class="stat"><b>${D.local.check.cases} / ${D.local.check.steps}</b><span>基础案例 / 步骤 · 结构有效</span></div><div class="stat"><b>${replayCases} / ${replaySteps}</b><span>原生回放案例 / 步骤 · inventory</span></div><div class="stat"><b>${muCases} / ${muSteps}</b><span>记忆观察案例 / 步骤 · inventory</span></div>`;
$('#local-results').innerHTML=`<p><span class="check">✓</span> 基础数据集校验通过；rubric：<code>${esc(D.local.check.rubric_version)}</code>，语义评测状态：<code>${esc(D.local.check.semantic_evaluation)}</code>。</p><p><span class="check">✓</span> 原生回放与记忆观察清单已读取；当前各 ${replayCases}、${muCases} 案。</p><p><span class="check">✓</span> 离线 scorer 探针运行 4 个固定输出，0 次模型调用；架构图 9 项检查通过。</p><p><span class="screen-label">—</span> 本轮没有被测模型输出，没有五维评分，没有公开 benchmark 成绩。</p>`;
$('#identity').innerHTML=`<pre>${esc(JSON.stringify({revision:R.revision,built_at:D.built_at,dataset_hash:D.local.check.dataset_hash,replay_dataset_hash:D.local.replay.dataset_hash,memory_dataset_hash:D.local.memory.dataset_hash,scorer_source_sha256:D.probe.source_sha256,semantic_evaluation:'not_run'},null,2))}</pre><p class="small">本地工件：report-data.json、evaluation-proposal_CN.json、source-evidence.json、scorer-probe.json、local-*-inventory.json、architecture.json / html / visual-check.json。</p><p class="small muted">背景检索：Nowledge thread_search，query “QQ assistant 场景 评分维度 数据集 luna”，mode full，当前默认 scope、无额外 filters。rank 1：c3c66914-fd52-4b4e-83f7-c3a052a79dd5，QQ Assistant End-to-End Evaluation, Fixes, and Deployment，relevance_score 36.66185488019671。历史线索只作导航，本报告的当前机制来自源码核对。</p>`;
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.tab)showTab(b.dataset.tab,true);if(b.dataset.jump)showTab(b.dataset.jump,true);if(b.dataset.dim!==undefined)dimension(Number(b.dataset.dim));if(b.dataset.step!==undefined)trace(Number(b.dataset.step));if(b.dataset.bench){benchFilter=b.dataset.bench;benchmarks()}if(b.dataset.finding){findingFilter=b.dataset.finding;findings()}});
$$('[data-tab]').forEach((button,i,items)=>button.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key))return;e.preventDefault();let j=e.key==='Home'?0:e.key==='End'?items.length-1:(i+(['ArrowRight','ArrowDown'].includes(e.key)?1:-1)+items.length)%items.length;showTab(items[j].dataset.tab);items[j].focus()}));
$('#bench-search').addEventListener('input',benchmarks);$('#prev-step').onclick=()=>trace(step-1);$('#next-step').onclick=()=>trace(step+1);$('#theme').onclick=()=>{document.body.classList.toggle('dark');$('#theme').setAttribute('aria-pressed',String(document.body.classList.contains('dark')))};$('#print').onclick=()=>window.print();
$('#export').onclick=()=>{const blob=new Blob([JSON.stringify(P,null,2)],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='qq-scenario-evaluation-proposal_CN.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),5000)};
dimension(0);trace(0);findings();benchmarks();showTab(location.hash.slice(1));window.addEventListener('hashchange',()=>showTab(location.hash.slice(1)));
</script></body></html>'''

output = template.replace('__REPORT_DATA__', serialized).replace('__DIAGRAM_HTML__', diagram)
(HERE / 'index.html').write_text(output)
manifest = {'built_at': payload['built_at'], 'revision': data['revision'],
            'evidence_status': data['scope'], 'scorer_probe': {'model_calls': 0, 'source_sha256': probe['source_sha256']},
            'files': {name: {'sha256': hashlib.sha256((HERE/name).read_bytes()).hexdigest(), 'bytes': (HERE/name).stat().st_size}
                      for name in ['index.html', 'architecture.html', 'architecture.json', 'report-data.json', 'evaluation-proposal_CN.json', 'source-evidence.json', 'scorer-probe.json', 'local-dataset-check.json', 'local-replay-inventory.json', 'local-memory-inventory.json']}}
(HERE / 'evidence-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n')
print(json.dumps({'html': str(HERE/'index.html'), 'bytes': len(output.encode()), 'source_anchors': len(evidence),
                  'model_quality_run': False}, ensure_ascii=False))
