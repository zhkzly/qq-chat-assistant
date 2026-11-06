# QQ Assistant 上下文与记忆评估：接手提示词

你接手的是一个尚未完成的开发任务。请先读取这份文档和指定工件，再执行。不要从头调研、重建评测框架或恢复旧 Goal 的优化队列。

## 用户现在要什么

项目：`/home/zhkzly/pycodes/qq-chat-assistant`。

用户要求基于当前项目构造新的上下文／记忆 benchmark，同时准备端到端和组件设置，真实调用 Luna，独立评分、定位失败、据此修改结构，再复测。**新的数据集是主集；旧 Goal 和旧43条只作回归。**

用户允许并发多个 agent、充分使用 tokens，已明确取消实验的全局 HTTP 总额限制。实际选定模型为 `gpt-6-luna`，保留现有提供方、审批、hooks、sandbox。全局不限不等于取消每次求助的超时、调用预算或失效检查。

用户对这轮耗时非常不满意。之前把评审封装、流程工具和大量历史测试迁移放入了主路径，进展太慢。**优先完成有真实结果的产品闭环，减少流程扩张。**先修已确认问题、组合已有候选、完成新主集实际复测，然后旧集回归；不要再用大量未评分执行或工程测试数量替代交付。

用户最新要求是交接给其他 AI，并已明确选择“暂停本会话，交给其他 AI”。所有子代理已收拢，原生 Goal 已返回 paused，目标仍未完成；没有把它标为完成或通过。补充交接文档不代表恢复产品开发或模型实验。

## 不可突破的边界

- QQ 正常聊天＋独立助手窗口；只供用户手工复制发送。不得发送、转发、自动回复或模拟发送按键，不恢复旧 AstrBot/NapCat 自动回复。
- 不操作真实 QQ、不改安装、不改生产配置。账号／联系人绑定、过期结果丢弃、字符串 QQ ID 必须保持。
- 不泄露或归档密钥、真实聊天。`data/settings.json` 和下面的临时 R8 配置包含凭据，不要输出或放入 Git。
- 保留脏工作区、失败、旧工件和原始评分；不要 `git clean` 或回滚别人的改动。未获提交／部署授权。
- 原数据、切点、时间、外部输入、评价标准不能为了通过而修改。用户原写内容不是预期记忆；生成稿和复制动作不是实际发送。
- 原评分不可覆写；格式修正保存原版、修正版和语义一致性记录。新评审、争议裁决分别保留。
- 主仓普通文档用英文，中文文档用 `_CN.md`；HTML 中文 UI 可用。mutation 不是必需门禁。

## 先读这些，不必重读全部聊天

1. 仓库 `AGENTS.md`，`.agents/skills/qq-goal-iteration/SKILL.md` 及对应 implement/evaluate/diagnose/architecture-review 角色技能。
2. **新 Goal**：`goals/context-memory-evaluation-20261105/goal.json`、`state.json`。
3. 当前不可变契约：`goals/context-memory-evaluation-20261105/versions/normal-note-api-v3/`；旧轮次引用自己的 v1/v2 快照，不能改。
4. `evals/assistant-stream/README.md`、`extensions/README.md`（若存在）、`evals/memory-decisions/README.md`、`evals/assistant/REPLAY.md`。
5. 本目录 `index.html` 是证据快照，不是实时面板。`report-data.json` 的时间和状态可能落后最新工件。

旧 `goals/assistant-improvement/` **未修改**。技能中的旧首批四案及阶段队列已被用户的新主集要求覆盖；不要重新把旧 Goal 作为优化目标。

## 当前工作区与代码状态

- 主仓 HEAD：`196cca3a924d025fc0e56dda9c59bb5628ed9360`。
- **主仓 `src/` 和 `ui/` 没有产品改动**；`git diff -- src ui` 为空。产品修改仍在 `/tmp` 隔离候选里，尚未组合或合入。
- 主仓有本次评测基础设施、测试、文档和新 Goal 的未提交改动。`task.md`、`checklist.md`、`DECISIONS.md`、`design/`、`research/` 等还含更早的脏内容，不要覆盖。
- 所有实际运行证据位于被 Git 忽略的 `.goal-runs/context-memory-20261105/`。不要删除。
- 原产品快照：`/tmp/qq-memory-goal-baseline-20261105-v1`，后台源码 hash `1b3a2cfa8cbde306dd6899307d13e6cb6354365d79f2a77207f01d8b6ec57e77`。它没有 UI，旧基线 UI 投影有明确的 HEAD196 fallback，并在各轮次冻结了字节。
- 候选源码另有交接快照（若已生成）：`.goal-runs/context-memory-20261105/handoff/candidate-source-archives/`。`/tmp` 原目录保留更多测试／诊断资料。换机器只带 Git HEAD 会丢失本次工作。

## 新主集和验收口径

| 设置 | 数据 | 范围和限制 |
| --- | --- | --- |
| 新端到端核心 | `evals/assistant-stream/cases.jsonl` | 4轨迹、8求助；空状态按原始事件摄入 |
| 新端到端扩展 | `evals/assistant-stream/extensions/memory-context-v1.jsonl` | 12轨迹、42求助；局部／持续要求、第三人归属、私人原因、话题关闭／重启、长单源头尾控制、长历史回忆 |
| 受控关系探针 | `evals/memory-decisions/cases.jsonl` | 16案例／8对照族；固定旧／新原文与来源可用性，四轴关系判断 |
| 旧回归 | `evals/assistant/` | 43案例、89步骤；只保护回归 |

**受控关系探针不是生产记忆写入器。** 它不运行实际摄入、检索或记忆提交，不能称为生产记忆系统准确率。实际生产链路由端到端集覆盖。

这些是可见开发集，部分素材来自旧项目案例并改编为新摄入／对照，另有新编长文本；不是未见 holdout。没有导入公开 benchmark，不能声称测过 LongMemEval、LoCoMo 或 HaluMem。

冻结标准：新 E2E 请求全部执行，零未解决硬失败，至少90% usable，其余只能 minor_edit，不留 rewrite/insufficient_evidence；组件单列，至少90% usable、零严重归属／范围错误；旧回归不得新增硬失败或明显退化。结构校验、synthetic transport、构建和功能测试不算对话质量。

主集哈希见 Goal：核心 `467b6221…`，组件 `c06234c6…`，扩展 `b414736d…`。不要改数据再沿用旧评分。

## JEV／Jev-Mem：必须保留的原始讨论与后续验证方向

用户多次提出 JEV：是否能更快地完成记忆写入前的语义筛查、处理新旧信息冲突；同时明确同意**版本、来源、权限和提交仍由程序管理**。用户提到 Jev-Mem 项目作为启发。这是待检验方向，不能遗漏，也不能把“可能更快”写成已经证明的效果。

当前源码已核对：`src/memory/jev-decisions.cjs` 是可选适配器，**默认关闭**，声明的类型只有 `candidate_relevance` 和 `next_read_choice`；`retrieval-service.cjs` 可选注入并使用前者调整候选排序。主入口没有构造这些服务。本轮没有实际 JEV 调用，没有可用的 JEV 记忆写入 bridge，也没有 JEV 对 Luna 的速度／质量结论。适配器自己标明 `contractUnverified:true`；文件存在不能证明远程接口可用。

已有资源约定在 `docs/available-resources_CN.md`，其中记录了 OpenRouter JEV 的模型、接口和 SDK 入口。它是历史资源记录；实际测试前须核验当前官方协议、可用性和数据去向授权。不要把 alpha 决策接口直接当聊天补全接口，不读取或打印整份 shell 配置或密钥。

后续可基于本轮新组件集比较以下窄判断：

- 临时情况与持续偏好；局部控制与条件性重复控制。
- 同一事实主体／活动与引用第三人的区别。
- 明确纠正、随时间变化、矛盾、重复和兼容补充。
- 来源撤回与现实取消的区别；证据足以识别关系与足以确定世界真相的区别。

先验证 JEV 能否表达共同任务与输出契约；必要时做单独声明的适配映射，保持原始输入和评价标准不变。`evals/memory-decisions/` 的16条可以作为对照种子，但现有 Luna 探针不是生产写入器。不能因 JEV 给出某个标签／概率，就直接删除、合并或覆盖记忆。反证、更正、撤回、时间及披露边界不得被筛掉。

比较应同时报告原文支持的判断质量、严重误判、弃权／失败、实际延迟分布、HTTP与token用量；保留原 Luna 基线和独立评审。同输入 JEV 组件更快，也还需要在正常历史摄入→自行形成记忆→真实求助的完整新E2E集上验证净收益。

当前已确认的笔记作者丢失、读到却不能消费、畸形核心放行等属于程序／协议问题，应优先修好；JEV无法恢复根本没有保存的作者身份。是否接入JEV由实际对照决定，不能为了使用可选资源而强制重写架构。若参考本地 `/home/zhkzly/pycodes/Jev-Mem`，先核对其当前实现，不把该项目的写入判定、冲突边或效果当作本项目现状。

## 已做出的实际结果

- 初始新核心4轨迹／8求助已原生独立评审：**5 usable、2 minor_edit、1 rewrite／硬失败**。硬失败是排除素材后把未知经历写成“我以前没补过”；两次小改涉及有据报告与时间适用性混用。
- 原结构新扩展12条都尝试过，保留失败。R8／observer-v4 批次有6条执行不完整，包含一次 provider408；不是全部质量通过。
- D003 实际4条长源／长历史比较：3条执行完整、1条失败；独立评分尚未完成，不能称3/4质量通过。
- B002 实际比较失败，原生独立评审不支持接受，轮次已记 **rejected**。
- B004 实际新核心4条：两个 running 案和 excluded 案执行完整，retained 案 r2 被终态核对拒绝。完整盲评已返回且结构有效，是否已登记看轮次 `round.json`；不可称整体通过。
- C005 受控探针实际16条跑完。一次独立配对评审给原探针13/16 usable、新探针16/16 usable，但两组比较的 preferred opaque system ID 与它自己偏好的文字理由相反，原轮次检查不接受。正在用“模型选 entry handle、程序绑定 system ID”的新盲包裁决，**尚未接受**。

## 隔离候选：哪些能用，哪些不能直接接收

### A001：确定性与时间适用性分开

目录：`/tmp/qq-memory-goal-candidate-reported-001`。

改动 `src/relationship-store.cjs` 和 `ui/app.js`：有原文支持但持续时间未知的报告进入近期有据报告，不冒充稳定现状；UI 单独说明适用期未知。51项功能检查通过。

轮次 `.goal-runs/context-memory-20261105/rounds/reported-understanding-001a` 的实际小范围比较已接受：候选4次请求均 usable。**仅局部诊断接受，未覆盖完整主集／回归。**

### B007：终态来源事实／隐私核对

目录：`/tmp/qq-memory-goal-candidate-fact-007`。

冻结后台 identity：`481537ce65374da00da4e5d4db4b20957fb22455b9c08b48c49971285f4ea2f5`。

报告／manifest：`docs/candidate-fact-privacy-007/product-manifest.json`，manifest SHA `22a0612422a7d1c69644ac1ba8e710545af874183fde029e9805d24b11a0b96a`，只读源码快照在同目录 `frozen-product-001/src/`。

继承 B002 的 Controller：完整候选正常准入→只读审计→最多一次整稿重生成→重新准入和 fresh audit→来源／scope／artifact／最终可见投影检查→保存。有效缺陷先于 incomplete 处理；拒绝候选不遗留辅助写入。审计不走可暂存操作的 invoke。机械 seal 仍为 `semanticCheck:false`。

B004 补了 programSources OR admittedFragments 许可、有效问题／可选诊断分离、按报告命题类型限制事实阻断、允许终态 clarify、压缩调用预留。B007 再把事实责任与披露责任分开：问句／意见也可能泄露明确受限原文，不可一概豁免。

**B007 尚未实际 Luna 复测，也有真实源代码问题，见下文。** 225项相关功能检查通过不等于可接收。

### D006：输入范围、任务权限和下游消费

目录：`/tmp/qq-memory-goal-candidate-source-006`。

冻结后台 identity：`ad9f12df5b519673989685c0bec8cd4bba2e9acf7ca270da67792538d69fef6f`。

报告：`docs/source-control-consumers-006/implementation-report.md`，同目录有 manifest、相对 D003 和原结构的完整补丁。

D003 修最终 wire 丢失 delivery/lookup、续读保留、派生摘要越权和 producer 素材菜单；D006 修实际已读片段无法被事实／许可消费者采用，以及模型自己选错 prepare 后把错误固化为“用户必须要消息”的问题。另有 generic 头尾保留、当前正文去重预算、次级 option quotes 菜单一致性、partial parent 必须合法细化。

真实失败工件派生测试17/17（同组 D003 为4/17），相关功能187/187、生命周期27/27、最终关键检查43/43，构建通过；这些批次有重叠，不要加成一个总数。**D006 没有实际 Luna 复测。**

## 接下来最重要的已确认问题

### 1. 用户笔记的作者身份在写入处丢失——尚未实施 Note008

轮次 `rounds/authored-note-source-008` 已按 Goal v3 准备，**没有候选代码**。原 D worker 尚未收到实施契约，现已停止。

证据：B004 retained 的 auditor requestId6（全局 transport sequence20）收到完整 note:n1，却标为：

```json
{"type":"note","role":"unknown","authority":"note_context_not_original_human_statement","lineage":"authored_or_unattributed","evidenceSourceIds":[]}
```

下游因此拒绝真实修包经历，即使 programSources 与 admittedFragments 都允许分享。

第一处丢失：`Store.saveNote` 只保留文本、用途、kind、版本、时间、可选证据 roots，没有作者／创建来源。`_deriveSources` 发出 note 时无 role。`speaker-identity.cjs` 把 note 说话人视为 undetermined，但 `ownerAuthoredRecord` 又把无 roots note 当用户原写；`whole-answer-fidelity` 则把所有 note 都标为非原始人类陈述。三个消费者契约不一致。

修复应贯穿可信摄入→持久化→source revision／观察日志→共享 provenance／memory／audit 投影。区分**用户原写、模型派生、旧记录归属不明**，不要把全部 rootless notes 升格。模型派生已有 revision-bound roots。`kind=material` 和 `use=draft` 不代表作者身份。

建议由真实用户保存入口赋予可信创建来源，不能接受客户端随便伪造 author 字段；模型 action 路径保持派生。只改分享开关／确认模型笔记不能自动证明作者身份。作者是记录作者，不代表引号里每个“我”或所有事实主体都是用户；仍须保留归属、时间、否定和分享范围。原始用户报告是来源支持，不是外部世界真相证明。

### 2. B007 的两个真实程序缺陷——不能当旧 mock 债务略过

- `whole-answer-fidelity` 对5种畸形原生 `issue.code`（缺失、空、空白、过长等）降为 nonblocking `audit_untyped_finding`，可能发布。原生 issues 的必需 code 应按规范验证；坏核心不能当“核对完成”。保留有效缺陷混合坏可选字段仍可修复的机制。`helper-m-z/blockers.json` 与 `manual-review-delivery.test.cjs.tap` 有5个真实失败。
- `consultation-context.test.cjs` 的7000字节最新助手原文保留场景：B007失败，原 B002通过；只把导出的长 PROMPT_VERSION 换回旧短标签即可通过。不要加大7000上限或删最新原文断言。下一组合使用**短且唯一的版本号**以失效缓存，并检查最新商量优先级／元数据预算。日志 `consultation-{diagnostic,original-baseline,short-label-probe}.tap`。

另外，B004 fresh audit 把“可能也能补，具体看位置程度”当硬 unsupported_fact；是否应属于可错的实用判断而不是来源事实阻断，需要明确审计职责并实际复测。不要继续堆例句，或把所有判断都要求外部事实证明；也不能为了方便把真正的未知个人经历错误降成 advisory。

### 3. 组合时的已知交叉点

- D006 与 B007 都改 `assistant-model.cjs`、`model-response-format.cjs`、`context/shared.cjs`、Controller 等，不能整文件覆盖。
- D006 Controller 主要是读取范围合并／原始 delivery obligation；B 的主要是终态审计循环，区域可分开组合。
- D006 private-only facts 使用 `admission.payload.privateEvidence`，不产生 outboundQuotes／disclosureBindings。组合后审计必须把这些精确 source/revision 也放入必需证据集合；不能因为不是 outbound 而在预算压力下丢掉，也不能因此授予对外许可。
- 组合 A 的 UI／relationship-store。用同一短新 PROMPT_VERSION 使全部相关缓存失效。
- 独立架构评审已检查 D006 之前的源代码路径；组合后应检查消费者／生命周期／预算，不要把架构评审当对话评分。

## 评测基础设施：已经修好的和仍需注意的

主仓 `scripts/eval-runtime-session.cjs` 现在为 **v5**。

- v4 修掉可选压缩错误被误判成外层失败：保留内部拒绝和 provider trace，以 Controller 外层结果判终态。原 v3工件不改。
- v5：新 stream 的实时 material 笔记走正常 authenticated `/api/note`，产品自己赋当前时间和实际保存结果；旧归档恢复仍是单独、明确的受控 Store 边界。当前 API 不支持的 preference-kind／evidence-lineage 实时写入会被拒绝，不能假装 UI 支持。当前新主集只有两个普通 material note，原始数据未变。
- v5 正反例、stream／adapter／round 等 **62/62** 通过。旧 observer-v4 源码在 `harness-snapshots/observer-v4/`，旧运行保留。
- 缺失请求的 bound `unexecuted` marker 原来通过 current 检查又被自己 prefix 检查排除，已用正反例修正；不能把这个修正算产品能力提高。
- `--unlimited-http` 已贯穿实际 runner／adapter，JSON cap 为 null，不是 Infinity。默认 replay 不付费；只有显式 `--live` 真调模型。

不要动已经冻结的旧 adapter 文件来让历史轮次校验失效；旧轮次会检查 adapter 字节。当前普通流式 runner／adapter 和原始数据分离。

## 主要运行目录

以下均相对 `.goal-runs/context-memory-20261105/`：

| 工件 | 用途 |
| --- | --- |
| `baseline-stream-core` | 初始 R4 核心4实际运行 |
| `baseline-component` | 原始关系探针16实际输出 |
| `baseline-core-r8-observer-v4` | 原结构 R8核心4，旧直接 Store note 边界 |
| `baseline-challenges-r8-observer-v4` | 原结构扩展12、95 HTTP、6条不完整；注意整批分母 |
| `baseline-core-r8-observer-v5` | **最新 normal note API 核心基线4，8求助均执行，未评分** |
| `candidate-reported-001-core` | A 局部实际比较 |
| `candidate-fact-002-r8-observer-v4` | B002失败，已拒绝 |
| `candidate-fact-004-r8-observer-v4` | B004核心4实际运行，retained r2失败 |
| `candidate-source-003-r8-observer-v4` | D003四个长源／历史案例，3完整1失败 |
| `component-semantics-005` | C005的16条实际探针输出 |
| `regression-baseline` | 旧43全部尝试，35完整、8失败；R4旧条件 |

每轮 `rounds/<id>/round.json`、`runs/`、`review-packet/`、`review.json` 和决定保留。`*.run.json` 有归因诊断，不能给盲评员。

旧43失败保留：warm-reciprocity、misunderstanding-repair、observed-output-feedback、long-single-source、mixed-history-reciprocity、speaker-attribution-emotion、arrangement-window-conflict、observed-qq-recall（完整ID见 manifest）。新候选若使用R8/v5，不能直接把旧R4/v3当同条件效果比较。

## 评审现状与工具限制

- QQ 20项盲校准：总体18/20、硬失败20/20，与**暂定AI参考**一致，不是人工金标。远程逻辑评审与 SUT 同 Luna 家族，偏差明确保留。
- 原生 B002 review 原版／格式修正版及49项语义一致性检查在 `native-qq-review-execution/candidate-fact-coverage-002a/`，轮次已经 rejected。
- B004与privacy baseline已有有效实际远程评审：`remote-qq-review-execution/candidate-fact-coverage-004/`、`baseline-r8-privacy-assessment-attempt2/`。交接时如未登记轮次，可只登记已有实际结果，不能重新填分。
- 长历史 baseline 的一次评审把 `lp-r3` 误认成包含 u5…8；原始数据明确 `lp-r2=u5…8`、`lp-r3=u9…12`，u11的葱／蒜苗／面条事实就在 r3。该硬失败**有争议，未独立裁决，不能据它改产品**。长包可用可逆去重，不能删真实输出／来源或改原文。
- C005原配对评审在 `component-paired-review-005/`；原轮次 `component-relation-semantics-005` 保留 valid review但check不接受。另建 `component-relation-semantics-005b` 重用同一实际输出并更清楚绑定比较对象。
- `component-paired-review-005b-entry-handles/calibration/result.json` 已有4项实际有效校准，**尚未启动 paired 请求，calibration-report也可能未生成**。临时执行器 `/tmp/qq-component-paired-entry-handles-005b-20261105.cjs`；检查后可继续 `calibration-report`、`paired`，保留所有原评审。模型选 entry handle，程序只绑定 opaque system ID，不得按理由手改 preferred。
- 流式远程执行器 `/tmp/qq-remote-product-review-v3-lossless-300s-20261105.cjs` 支持完整 stream 盲包、精确 witness、可逆字符串／JSON子树去重，300秒 deadline。它**不支持旧43的 legacy packet 格式**，不能直接套用。

独立 reviewer 只接完整 inline 盲包；不要带实现假设、候选身份、诊断和参考标签。形式验证只是绑定有效，不证明评分正确。

## 测试迁移：避免重复劳动

B007 中已做了大量显式 audit-aware mock 迁移，原始不变量和失败日志保留，不是全局 auto-allow shim。

- 最近全量219文件清点：**172通过、47失败**，在 `docs/candidate-fact-privacy-007/unit-all-002/summary.json`；之后还有迁移，**未重新跑全量**，不能说最终仍47或全绿。
- `helper-m-z/`：23文件、254/259，5个真实 issue.code 缺陷保留；其余22文件通过。
- `helper-a-l-extra/`：7文件、92/92。
- 父worker后续：`migrated-audit-basics`39/39、`migrated-defect-lifecycle`52/52、`migrated-compaction-actions`4/4、`migrated-harness-and-generation`34/35、`restored-goal-support`52/53。
- 一个旧 continuous-conversation globalcap1断言仍期待首案成功；强制审计现在会在首案耗尽，这是待判断并迁移的旧预期。
- `eval-http-budget` 的无限模式失败准备里 `preparation.after=null` 尚未归因，不可随便判为产品bug或删检查。
- 缺的源资产、旧 Git支持被显式只读恢复。部分历史测试依赖主仓 `.goal-runs` 和 Git objects，symlink／`QQ_TEST_FROZEN_LEGACY_ROOT`、`QQ_TEST_FROZEN_GIT_ROOT`、每进程 `GIT_DIR` 有记录。不要误报为缺库、不要替换成空理想夹具。

## 推荐执行顺序：先完成一个可审核闭环

1. 确认候选／工件存在、hash未漂移，读取当前 state。不要再开无边界架构调研。
2. 实施 Note008 的可信笔记作者链；保留原始／派生／旧不明区别。修掉畸形 audit core 放行和短版本预算问题，独立记录各补丁因果。
3. 在新隔离目录组合 A001、D006、B007和上述修复，按diff合并重叠文件，带上已有显式测试迁移；统一短版本。先跑相关功能／构建和已知真实反例，不重复先铺219个旧文件。
4. **先跑新核心4／8次求助，使用 observer-v5、同一Luna/R8条件与新基线比较。** 保存实际生成／审计／澄清／拒绝；独立评审判断是否确实帮助到用户。
5. 核心闭环有效后扩到完整新E2E16／50。修复真正新增失败，不按错误评审或缺失输出推断成功。组件探针、生产E2E、工程测试分别报告。
6. 完成 C005比较对象裁决；生产新主集达标后，再用同条件跑旧43回归，明确旧失败和新增退化；最后完整相关测试和候选整体验证。没有部署或真实桌面验证就不要声称做过。
7. 交付更新HTML、明确分母／版本／失败／未覆盖边界。达到冻结标准前不标Goal完成，也不要通过改数据、弱化拒绝门或挑选一轮好输出宣布成功。

## 实际运行入口

先看 `npm run eval:check`、`eval:list`、`eval:replay:list` 和 `node scripts/goal-round.cjs --help`。保留新主集，不执行旧Goal自动优化。

配置 `data/settings.json` 使用已选 Luna。隔离 R8 配置 `/tmp/qq-context-memory-lab-r8-20261105.json`（权限600）只提高单次求助调用上限到8，未改生产配置；不要展示内容。

示例（必须用新输出目录，先冻结候选并验证自己的 source root）：

```bash
node scripts/eval-stream-replay.cjs --all \
  --adapter scripts/eval-qq-adapter.cjs \
  --source-root /tmp/YOUR_FROZEN_CANDIDATE \
  --settings-file /tmp/qq-context-memory-lab-r8-20261105.json \
  --live --unlimited-http --continue-on-case-error \
  --out .goal-runs/context-memory-20261105/YOUR_NEW_RUN
```

扩展加 `--cases evals/assistant-stream/extensions/memory-context-v1.jsonl`。组件用 `scripts/eval-memory-decisions.cjs`；它与生产设置不同。

使用既有 `goal-round prepare/attach/packet/review/check/decide`。从较大批基线取子集需准备时声明 `--reuse-compatible-baseline`。决定枚举是 accepted/rejected/inconclusive，没有 continue。完整原评审不能替换。

本环境部分 Node 子进程／本地 loopback 在默认 sandbox 中报 EPERM，已多次在正常审批的 escalated执行中通过。区分执行沙箱问题和产品缺陷；不改变全局 sandbox／provider。

最后提醒：当前没有在运行的子代理或已知付费模型会话；所有最新已启动的根模型／校准会话都已完成并保留结果。Note008未实施，D006/B007未实际复测，产品未合入。不要把“准备好”误读成“已经完成”。
