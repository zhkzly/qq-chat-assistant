# 项目 Goal 工作流验收记录

2026-10-30，从 `main@009b4aa` 的独立工作树建立项目级 Goal 工作流。此次完成角色、技能、契约、阶段队列和轮次证据检查，**没有启动优化 Goal，也没有改善或激活新的 QQ 产品实现**。使用入口见 [GOAL_CN.md](../goals/assistant-improvement/GOAL_CN.md)，结构化记录见 [goal-system-verification.json](goal-system-verification.json)。

## 已建立的机制

主智能体使用 `qq-goal-iteration` 协调，直接启动三个项目角色：`qq_implementer` 实现、`qq_evaluator` 独立评审、`qq_diagnostician` 按需归因。四份技能分别维护；生成器将对应技能正文及 SHA 写入原生角色配置，并检查漂移。评审者不通过 shell 加载技能，而是消费其角色指令中嵌入的正文。实现者继承父会话的工具权限，归因者的只读职责是指令约束，不能宣称为独立的安全沙箱。

原生配置位于项目 `.codex/agents/`，技能位于项目 `.agents/skills/`。未改全局角色、模型、提供方、`approvals_reviewer = "auto_review"` 或 Orca hooks。审批允许一次操作不等于回答质量合格，也不等于 Goal 完成。

轮次脚本冻结原始案例、标准、角色及实现身份；核对实际执行输入、顺序、反馈绑定、输出和资源条件；复制原始证据后生成盲化评审包。评分必须引用实际输出或执行情况；源记录引用不能代替当前输出证据。支持按当前回复 ID 引用实际输出，以及引用发生在请求之前的记忆准备失败。实现身份的具体范围由可替换适配器声明；当前适配器仅验证 `src/**/*.cjs` 后端，不覆盖桌面 UI 或 QQ 集成。

每轮默认两侧合计 32 次 SUT HTTP，双方各 16 次，含内部准备、修复和维护。上限用尽保留未完成，不转换为成功。这是单轮资源边界，不是原生 Goal 的 token budget。单轮接受也不自动接受阶段或完成整个 Goal。

## 验证与实际试跑

- 全量回归：108 个测试文件，742 项通过，0 失败、0 跳过；应用 JavaScript 解析、角色生成一致性和数据集结构检查通过。没有运行 mutation 检查。
- 原生 Codex 0.164.0 的配置发现包含三个项目角色。单独的加载探针返回了评审技能的准确 SHA，父请求未提供该摘要；保留了 [原始回执](evidence/goal-system-20261030/evaluator-role-receipt.json)。CLI JSONL 只显示协作等待，没有明确子线程创建事件，因此不补造 spawn ID 或声称完整线程审计已经通过。
- 实际原生评审推理消费了盲化的 20 条校准样例，及既有实际产品回放中的三轮情绪支持输出。[原始评审](evidence/goal-system-20261030/native-evaluator-response.json)、[校准比较](evidence/goal-system-20261030/calibration-comparison.json) 与 [局部回放评审输入](evidence/goal-system-20261030/forward-reviewer-bundle.json) 均保留。未在此次 setup 中重新调用 SUT 模型；这次 Codex 开发推理不算新的产品回放。
- 校准与临时 AI 参照的总体标签一致 18/20，7/7 坏参照被判需重写，8 个好参照没有被误判需重写；`c08`、`c12` 由参照的“小改”判为“重写”。这些是已见开发样例、AI 参照，不能推出评估者泛化可靠或具有人工偏好准确率。
- 新评审把三轮情绪支持均判可用，先前评审对中间一轮判需小改；分歧保留，没有覆盖旧记录或伪造共识。它只是局部、单侧评审，没有证明候选更好。
- 将这份实际局部评审原样交给轮次检查后，检查明确拒绝接受：候选缺失、守卫未评分、无成对结论，旧基线的案例范围和资源上限也与新轮次不同。[拒绝结果](evidence/goal-system-20261030/incomplete-round-check.json) 是预期行为。

## 保留的限制

此次没有改 `src/`、`ui/` 或 QQ 插件，没有正常宿主生命周期或真人桌面集成的新证据。原有来源校验、长私聊及单条长来源失败仍是 Goal 队列的正式任务，不能由上述局部试跑代替。

检查器能验证所交证据的身份与完整性，不能证明评审诚实独立、语义正确或建议自然。评审者的工具关闭来自原生配置声明；此次没有进行攻击性的权限绕过测试。个人口吻与现实交流效果仍需实际用户反馈。

契约和初始队列保持 `not_started`；需要用户明确激活后，主智能体才能按授权推进实际产品优化。原生 Goal 功能及项目角色格式参考 [Codex Goal 指南](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex#how-to-write-a-goal) 和 [自定义子智能体文档](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents)。
