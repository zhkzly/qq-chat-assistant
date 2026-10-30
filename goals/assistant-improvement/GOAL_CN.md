# QQ Assistant 持续优化 Goal

这里配置的是项目内的优化工作流。契约在 [goal.json](goal.json)，初始状态在 [state.json](state.json)，角色入口在 [roles.json](roles.json)。**文件存在不代表已经启动 Goal。** 配置文件与控制器命令本身不发起真实 SUT 模型调用、不优化生产代码、不重启 QQ，也不填写任何质量通过。

目标是让助手更好地帮助用户实现当下的交流目的：理解真实材料、延续私下商量、给出有用且自然的表达。当前用途包含恋爱交流，也必须支持朋友、工作、学习、关心他人和后来改变的目的。对方是否回复、关系是否成功不是工程 Goal 的完成条件。

## 启动前查看

```bash
npm run goal:roles
npm run goal:status
npm run eval:check
npm run eval:replay:list
```

`goal:roles` 检查项目角色配置与各自技能是否一致；它不证明智能体已按要求工作。`goal:status` 读取状态，不创建原生 Goal、不调用模型。`eval:check` 检查基础集的 18 场景、34 步；完整独立历史回放清单是 38 场景、81 步，哈希为 `d7890b62c8c92e7e496d631ca8f2c255bd6871380d779e194fbb85125a0e7aa0`。

已有的 `auto_review`、hooks、沙箱、网络和提供方权限边界继续生效。允许执行某项操作、回答质量合格、阶段完成，是三件独立的事。项目角色配置不能绕过自动审批，也不能把审批通过变成质量通过。

## 明确激活时可复制的指令

在要启动的项目会话中明确发送以下内容；只阅读本文件不会执行它。此版本同时授权在有限轮次内使用当前已选真实模型回放**虚构数据**。若只想检查链路，应删除其中的真实模型授权，并明确只运行合成传输。

```text
/goal
按 goals/assistant-improvement/goal.json 启动 qq-assistant-improvement。

outcome：全面尝试改进实际 QQ Assistant 的材料理解、私下咨询连续性和自然表达，帮助用户实现其当前交流目的。按既定三个阶段与有限案例集合推进；不要擅自缩成 MVP、最小绿灯或单个容易探针。
evidence：使用冻结的原始历史前缀、切点、目标和外部输入，每版自行构建状态。先保留实际 SUT 输入/输出，再由独立评审看盲化包；记录哈希、版本、失败、缺失和分歧。20 条 AI 参照是临时开发参照，不能当人工金标。
constraints：保留现有 auto_review、hooks、沙箱和权限边界；QQ 仍由用户手动发送；保护账户/联系人绑定、来源 ID、时间与披露权限。真实记录、凭据不得进入 Git 或公开证据。
boundaries：授权项目内实现、提示词/记忆/上下文重构及隔离测试，包括证据支持的较大重写；授权当前已选模型对虚构开发案例做显式 live 回放，每轮 SUT 基线与候选两侧合计最多 32 次 HTTP，各侧相同上限 16 次，包含准备、修复与维护。本指令不新增模型/提供方变更、正在使用的 QQ 安装或生产激活、全局配置/记忆写入和外部发布权限。会话已有授权继续有效，已授权工作中的本地可逆提交无需重复确认；只有尚未获授权的额外动作，才先准备可审查候选与验证材料，再说明具体所需授权。
iteration_policy：由原生主智能体使用 qq-goal-iteration 协调，直接按名称分派 qq_implementer 与 qq_evaluator，必要时才调用 qq_diagnostician。每轮先定失败假设、目标案例及本阶段声明守卫的相关子集，完成实现、实际回放、独立评审和归因。评审角色没有 shell，主智能体把 packet 命令产出的完整 bundle.json 内容内联交给它，保留真实评审原文。允许推翻架构，禁止靠缩题、放宽标准或自评冒充改进。
stop_conditions：只有三个阶段所需实际输出与反例证据都接受、相关工程检查通过、生命周期/桌面证据边界写清，才可完成。额度用尽、缺失输出、未评分或不确定结果继续保留为未完成；用户明确要求暂停才暂停。不得以关系成功作为工程完成条件。
```

`/goal` 是否可用取决于当前 Codex 客户端。以上是给主智能体的明确激活契约；项目脚本本身不调用原生 Goal API，也不因为配置存在而自动启动。无需设置未被请求的 `token_budget`。

## 三个阶段与当前起点

| 阶段 | 首要任务 | 有限范围与反例 |
| --- | --- | --- |
| `delivery_provenance` | 先实际交付出稿/咨询，再正确绑定来源与本轮反馈 | 6 个主案例，4 个具名守卫；包含两个仍失败的原出稿场景 |
| `memory_continuity` | 长输入、时间变化与咨询延续；另外验证正常宿主生命周期 | 11 个主案例，5 个具名守卫；保留长私聊和单条长来源失败 |
| `communication_quality` | 有用、自然、符合目的和个人表达的实际建议 | 21 个主案例，6 个具名守卫；包含欢迎/拒绝、明确/模糊等对照 |

完整 ID 及验收文字在 `goal.json`。三阶段主目标合计覆盖现有全部 38 个开发场景。每轮可以显式选择本阶段主目标与声明守卫的相关子集，至少保留一个具名守卫；阶段接受仍需覆盖其全部主目标和守卫，并保留与候选版本一致的证据。候选变化后必须明确哪些旧结论失效，并重跑受影响部分。

基线为 `009b4aa`。当前保留的实测问题包括：

- `coverage-observed-output-feedback`：原出稿在规划引用/授权校验处失败，后续反馈无实际首轮输出可绑定。
- `coverage-feedback-current-material`：编造的句子被绑定为当前用户原文；明确重复素材的对照同样没有修好原场景。
- `coverage-long-private-consultation`：受控记忆准备把局部反馈分成稳定偏好并遭拒绝，尚未进入请求轮。
- `coverage-long-single-source`：记忆准备已完成，回答仍被产品上下文预算挡住。不能缩短输入换取通过。

情绪袒露三轮的既有评审为“可用／需小改／可用”；第二轮说得过满，仍需处理。另一个私下商量专用的两轮探针证明实际反馈引用链路接通，但它改变了任务，不能替代上述出稿失败案例。完整边界见 [既有验证记录](../../docs/eval-fidelity-v2-verification_CN.md)。

## 角色如何分工

主智能体使用 `qq-goal-iteration`，负责选择阶段、假设与下一步，并检查证据是否足够。`qq_implementer` 使用自己的实现技能处理候选；`qq_evaluator` 使用自己的评审技能先看冻结观察与实际可见输出；`qq_diagnostician` 只在需要定位首个因果偏差时按需参与。每个项目角色的确切配置与技能路径在 `roles.json`。

评审包不能带实现假设、候选路径或内部诊断来暗示结论。评审先判断实际输出是否有用、忠实、自然，再由主智能体结合 `*.run.json` 诊断归因。若模型没有真正输出，就记录执行失败，不能让评审给一个并不存在的回答打通过。

原生主会话中的实际流程是：

1. 用户明确激活 Goal，主智能体读取契约与协调技能，选择本轮失败假设、目标和相关守卫并运行 `prepare`。
2. 主智能体直接按项目角色名分派 `qq_implementer` 处理有边界的候选，并组织同条件的基线／候选实际 SUT 回放，各侧最多 16 次 HTTP。
3. 主智能体附着两侧产物并运行 `packet`，读取完整 `bundle.json`，把其内容内联交给 `qq_evaluator`。评审角色没有 shell，不向它只发送文件路径或要求它读取代码。
4. 主智能体原样保存评审返回的 JSON，运行 `review` 与 `check`；需要因果定位时再把诊断材料交给 `qq_diagnostician`。
5. 主智能体根据实际证据运行 `decide` 并推进下一有限轮次。单轮接受不自动完成阶段；全部阶段的完整证据另按契约验收。

## 一轮的具体命令

以下示例先准备一个有限比较，**不调用模型**。输出目录必须尚不存在；每次换新轮次 ID 和目录。

```bash
npm run goal:round -- prepare \
  --id delivery-001 \
  --stage delivery_provenance \
  --cases coverage-observed-output-feedback,coverage-feedback-current-material \
  --guardrails cm-conditional-expression-scope,conv-share-own-material-missing \
  --hypothesis 'Source attribution during draft planning fails on actual user material.' \
  --max-http 32 \
  --out .goal-runs/delivery-001
```

`--cases` 和 `--guardrails` 分别接受该阶段声明的非空子集；省略时使用该阶段的完整集合。默认 `--max-http 32` 是一轮 SUT 比较两侧合计上限，准备后固定为每侧 `per_variant_http: 16`，记忆准备、修复、维护和其他内部请求全部计数。两侧须使用相同的 16 次上限，一侧剩余次数不能转成另一侧超过 16 次的额度；降低轮次上限时以 `round.json` 固定的等额分配为准。下面只展示合成接通检查：

```bash
npm run eval:replay -- \
  --id coverage-observed-output-feedback,coverage-feedback-current-material,cm-conditional-expression-scope,conv-share-own-material-missing \
  --out .goal-runs/delivery-001-candidate-synthetic
```

默认响应是合成占位，只能检查实际产品链路是否接通。真实质量比较需要在明确激活授权后，分别指定冻结基线与候选源码，使用完全相同的案例清单和每侧上限：

```bash
# Replace source paths with the actual frozen baseline and candidate checkouts.
npm run eval:replay -- \
  --id coverage-observed-output-feedback,coverage-feedback-current-material,cm-conditional-expression-scope,conv-share-own-material-missing \
  --source-root /path/to/frozen-baseline --live --max-http 16 \
  --out .goal-runs/delivery-001-baseline-live
npm run eval:replay -- \
  --id coverage-observed-output-feedback,coverage-feedback-current-material,cm-conditional-expression-scope,conv-share-own-material-missing \
  --source-root /path/to/candidate --live --max-http 16 \
  --out .goal-runs/delivery-001-candidate-live
```

基线源码必须对应契约中的 `009b4aa`；候选源码应保持到附着与检查完成，防止运行后改动导致身份失配。模型、提供方、设置、历史准备条件和资源额度保持可比；确需改变实验条件时，在 `prepare --condition-change <理由>` 中提前声明。旧基线的兼容输入复用须显式选择 `--reuse-compatible-baseline`，仍须通过逐案例原始输入与标准绑定检查。不要重复使用同一目录，也不要把合成产物改名当成真实运行。独立回放协议见 [REPLAY_CN.md](../../evals/assistant/REPLAY_CN.md)。

```bash
npm run goal:round -- attach --round .goal-runs/delivery-001 --variant baseline --replay .goal-runs/delivery-001-baseline-live
npm run goal:round -- attach --round .goal-runs/delivery-001 --variant candidate --replay .goal-runs/delivery-001-candidate-live
npm run goal:round -- packet --round .goal-runs/delivery-001 --out .goal-runs/delivery-001-review-packet
```

`attach` 核对来源身份并复制实际产物；更换适配器时可用 `--adapter <实际适配器路径>` 明确所用验证器。`packet` 可以为已经附着的单侧产物导出盲化材料，例如只做基线诊断；两侧都要比较时，先附着两侧再导出，因为包一经冻结不能替换。

导出目录中 `bundle.json` 包含 `packet`、`binding`、`review_template` 和 `allowed_hard_failures`。主智能体将**完整对象内容内联**交给 `qq_evaluator`，只附中性评审要求，不夹带系统标签到基线／候选的映射、实现假设、预期结论或诊断。`packet-map.json` 留在协调侧。评审按模板保留所有绑定字段，填写实际 `reviewer_id`、逐条 `ratings`、成对 `comparisons` 和真实输出引用；缺失输出与不确定性如实保留。成对比较须区分 `wording` 与 `delivery`：没有基线回答时不能判措辞更好，回答交付恢复也不能冒充措辞优化。

主智能体原样保存实际评审返回的 JSON，然后记录它并查看证据完整性；不要把未填写的 `review_template` 当成评审结果：

```bash
npm run goal:round -- review --round .goal-runs/delivery-001 --file /path/to/actual-evaluator-review.json
npm run goal:round -- check --round .goal-runs/delivery-001
npm run goal:round -- decide --round .goal-runs/delivery-001 --decision inconclusive --reason 'Record the actual evidence and next action here.'
npm run goal:status -- --round .goal-runs/delivery-001
```

`check` 在未具备接受条件时退出非零，并列出缺失或不一致；这通常是待补证据，不应通过删案例或填造评分消除。目标步骤需要实际可用的回答、无硬失败及真实改善证据，守卫不能退步。`decide` 的结论可为 `accepted`、`rejected` 或 `inconclusive`，其中 `accepted` 只能在检查具备条件时记录；原始评审与决定不能覆盖。填写实际结论与理由，不能直接复制示例理由充当评审。

`goal:status -- --round <目录>` 查看具体轮次；不带参数读取契约及初始状态，不能观察原生 Goal 是否已激活。控制器始终区分单轮接受、阶段完成与 Goal 完成；它不自动完成后两项。`.goal-runs/` 是忽略的本地证据目录；状态文件的初始 `not_started` 只是队列，不是已运行成绩。

## 证据与停止边界

轮次检查器只检查**所交证据的身份、绑定与完整性**。即使检查通过，它也不能确定语义真的正确、评审真的独立、表达真的自然或现实交流有效。语义结论必须来自独立评审及其具体引用；个人声线只能在用户实际反馈范围内确认。新评审或 Judge/rubric 变化须使用 `eval:judge:export` 的盲化校准，并保存实际比较和分歧。现有 20 条参照仍是 AI 编写且未获用户确认的临时参照。

当前回放会受控重建历史记忆，不能证明正常宿主自动摄入、维护、切换联系人、关闭再打开已经正确。第二阶段须在隔离环境走实际宿主生命周期并保留轨迹；若仍缺真人桌面验证，应明确记录待验证范围。这次工作流配置本身没有新增正常宿主或桌面证据。

额度用尽就停本轮调用并保留部分产物；缺失、错误、未执行、未评分、不确定和硬失败不能变成通过。同一修正再次复发或来回振荡时更换根因假设，不继续逐例加规则。生产激活或 QQ 安装操作须先有完整可审查候选与相容性证据，并保护未发送内容；现有会话已授权的动作按授权继续，只有新增、尚未获授权的范围才请求确认。本工作流配置本身不会执行这些操作。
