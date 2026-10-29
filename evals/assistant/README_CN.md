# QQ 助手开发验收数据集

这批是项目内可反复使用的虚构开发／回归案例，不是回答模板，也不是未见泛化测试。包含18个案例、34个步骤，覆盖久未联系、接话、自我分享、邀约、纠正、记忆更新和工作／学习等目的。

- `conversation.jsonl`：对话与目的相关案例。
- `context-memory.jsonl`：上下文与记忆相关案例。
- `rubric.json`：公共评价标准；每个步骤另有具体的应做到、应避免及关键失败条件。
- `FORMAT.md`：字段与引用规则；详细操作见`README.md`。

在项目根目录使用：

```bash
npm run eval:check
npm run eval:list
npm run --silent eval:case -- --id conv-reconnect-known-anchor --step s1 --view model
npm run --silent eval:case -- --id conv-reconnect-known-anchor --step s1 --view review
```

`model`给被评助手看，只含目的、可用背景和本次请求；`review`给评审看，额外包含验收标准和未填写的评审表。评审表必须之后绑定实际响应与版本，不能先填“通过”。

每次优化相关行为时先校验，再选相关案例及反例，用同样条件比较修改前后。完整验收还应覆盖其他目的，避免把助手调成“永远提问”“永远含蓄”或“永远邀约”。标准可以修正，但需保留版本和理由。

数据校验／查看命令仍不调用模型。真实产品多轮回放已另行接入，见 [独立节点回放](REPLAY_CN.md)：`npm run eval:replay:list` 查看场景；`eval:replay` 默认用合成传输验证产品链路，显式 `--live` 才使用真实模型。旧运行脚本不是本数据集的执行入口，未启动自动优化或Goal。

格式和引用校验通过，仅证明数据结构可用。助手是否会选内容、是否得体、是否真正符合你的意思，需要之后用实际响应评审。这里固定写下的后续消息，也不证明模型记忆持续生效或现实关系变好了。
