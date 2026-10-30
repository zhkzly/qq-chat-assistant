# 可选技术资源与复用准则

2026-10-30 用户提供并要求保留。以下是能力候选，不是必须接入的产品需求；未验证本机账户额度或网络可达性。此文件不存密钥值，也不要求读取或输出整个 shell 配置。

| 资源 | 用户提供的配置 | 可评估用途 |
| --- | --- | --- |
| OpenRouter JEV | `POST https://openrouter.ai/api/alpha/decisions`；`typesafe/jev-1.14`；变量 `OPENROUTER_API_KEY` 可能在 `~/.bashrc` | 当前任务关联、下一读取动作、检索候选相关性等窄类型决策；不生成聊天正文，不把概率当事实或授权 |
| 方舟 Agent Plan Embedding | `https://ark.cn-beijing.volces.com/api/plan/v3`；`doubao-embedding-vision`；变量 `ARK_API_KEY` | 语义／多模态检索的候选编码，与关键词、时间及来源过滤组合对照 |
| 本地与已有库 | 项目现有 SQLite；可调查供应方 SDK、全文搜索与向量检索库 | 优先复用通用协议、索引与向量计算，项目代码拥有作用域、来源、任务状态和消费关系 |

## 选择方式

- 从具体缺口决定是否引入：例如同义表达持续漏召回，或主要模型反复在一个窄决策上失误；先搜索现有资料、官方接口和可维护的库，不因资源可用就增加组件。
- 引入前保留不使用该能力的同输入基线；记录模型实际版本、检索证据、误判、延迟、调用量和最终帮助质量。不能只比较概率或召回数量。
- JEV 应批量／按变化触发并缓存适用判断，不能默认逐条全史重复调用，也不能筛掉反证和更正。工作流、权限、来源修订和副作用由程序决定。
- Embedding 不替代时间、账号／联系人、来源撤回和披露过滤。远程编码是新的数据流；先做隔离虚构试验，真实资料按已有授权范围处理。
- Provider / SDK / library versions must be pinned and recorded when adopted. A library's existence does not establish compatibility or quality; test scope filtering, deletion and stale-index recovery.

## 已查阅的一手入口

- [OpenRouter Jev 1.14 模型页](https://openrouter.ai/typesafe/jev-1.14)：确认它面向结构化决策而非自由文本生成，不据此推断本项目效果。
- [OpenRouter TypeSafe SDK 文档](https://openrouter.ai/docs/guides/community/typesafe-sdk)：接入前调查 TypeScript / Python SDK 是否覆盖所需 alpha 接口，不默认当聊天补全调用。
- [方舟 Agent Plan 向量模型文档](https://docs.volcengine.com/docs/ark/agent-plan-personal-vectorized-models)：本次网页正文受客户端渲染限制，具体字段与实际响应版本需在接入时核验；用户给定的 `/plan/v3` 配置保持原样。
- [sqlite-vec 作者仓库](https://github.com/asg017/sqlite-vec)：可以调查现有 SQLite 向量扩展；其 README 明示 pre-v1，不能只因有 Node/Python 绑定就视为已验证稳定或直接安装。
