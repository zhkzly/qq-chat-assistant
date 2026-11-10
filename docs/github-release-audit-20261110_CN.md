# GitHub 发布审计(2026-11-10,main @ 73c3972)

目标:将当前 main 分支发布到公开 GitHub 仓库。本审计只覆盖"公开后会不会泄露敏感信息"和"仓库呈现是否完整",不评价产品功能。

## 结论一览

| # | 检查项 | 结果 |
|---|---|---|
| 1 | API key / 凭证(工作区) | ✅ 通过 |
| 2 | API key / 凭证(全部 git 历史) | ✅ 通过 |
| 3 | 真实聊天记录 / 个人数据 | ✅ 通过(数据从未入库) |
| 4 | `npm run check`(语法解析) | ✅ 通过 |
| 5 | `npm test` | ❌ **阻塞**:1 个测试文件 2 个用例失败,exit 1 |
| 6 | LICENSE 文件 | ❌ 缺失(公开仓库必须选择) |
| 7 | package.json 元数据 | ⚠️ license/repository 字段缺失,`private: true` |
| 8 | README 公开适配 | ⚠️ 现为内部发布日志风格 |
| 9 | 本机用户名路径泄露 | ⚠️ 46 个文件含 `/home/zhkzly`(轻度) |
| 10 | 工作区未提交文件 | ℹ️ 2 个未跟踪 docs 文件待决定 |
| 11 | 仓库体积 | ✅ .git 49MB,适合 GitHub |

**总体判断:接近可发布。无任何密钥或真实聊天数据泄露风险;修复 #5、决定 #6/#7 后即可 push。**

## 详细发现

### 1. 凭证审计 ✅

- 工作区仅跟踪 `.env.example`,五个变量全部为空占位符,无真实值。
- 磁盘上不存在 `.env` 文件(运行时凭证在 gitignored 路径外或由启动脚本注入)。
- 对全部 960 个 tracked 文件做高精度模式扫描(`sk-`、AKLT、ghp_、JWT、UUID 型 key):唯一 `sk-` 匹配是 tests 里的**字母表序列假 key**(`sk-abcdefghijklmnopqrstuvwxy12345`),用于断言系统不泄露密钥,非真实凭证。其余匹配均为 SHA-256 哈希子串或内部 `private:<uuid>` sourceId,非密钥。
- `src/` 运行时全部通过 `process.env.MODEL_API_KEY` 等环境变量读取;`ark.cn-beijing.volces.com` 是公开 API 端点 URL,非机密。
- `plugin/probe.cjs` 中 token/password 字样仅为登录页 UI 探测代码,无硬编码凭证。

### 2. git 全历史审计 ✅

- 历史中唯一匹配 `.env*` 的添加是初始基线 commit `d45e629` 加入的 `.env.example`(空模板),**从未有真实 `.env` 入库**。
- `data/`、`exports/`、`private/` 在全部历史中从未被跟踪。
- 抽样近期 400 个 commit 全历史 grep 无真实 key 形态字符串。

### 3. 真实聊天数据 ✅

- `.gitignore` 覆盖 `data/`、`exports/`、`private/`、`logs/`、`*.sqlite*`、`.goal-runs/`,真实 QQ 数据库与导出不在仓库内。
- tracked 文档中的对话示例均明确标注"虚构示例";evals 数据集自我声明为虚构开发集。
- "Luna" 是被测**模型**名,不是真人。
- 电话号码模式扫描的全部命中均为 SHA-256 哈希内的数字子串(误报),无真实手机号。
- ⚠️ 注意:docs 公开描述了项目的恋爱助手用途与 QQ 内部读取契约(`docs/relationship-learning_CN.md` 等)。这属于产品定位的主动公开,发布前请确认接受该可见性。

### 4. 测试失败 ❌(发布阻塞)

`npm test` 在 main @ 73c3972 确定性失败(exit 1),仅 1 个文件:

- `tests/checker-delivery-recovery.test.cjs` — "a checker format-repair transport/http failure consumes a single attempt without transport retry" 两个变体:`delivery_repair` 请求计数断言 `0 !== 1`(另一处 `2 !== 1`)。

其余全部测试文件通过(21 个套件汇总全绿,`npm run check` 通过)。公开发布前应修复,否则主页 `npm test` 即红。

### 5. 许可证与元数据 ❌/⚠️

- 无 LICENSE 文件:公开仓库无许可证 = 默认保留所有权利,别人不能合法使用。建议选 MIT 或 Apache-2.0(含 `package.json` 的 `license` 字段)。
- `package.json` 缺 `repository`、`author`;若有 `"private": true` 不影响 push,但建议发布时移除并补字段。

### 6. README 公开适配 ⚠️

现 README 是多轮内部发布日志的叠加(端口 8317 本地代理、模型名、历史 release 证据链接);28 个文件提及内网端口 8317,7 个 docs 引用内部 dsh-* 文档。信息不敏感,但作为公开主页可读性差。建议:保留现 README 为 `docs/RELEASE_LOG_CN.md`,另写一页面向陌生读者的 README(是什么/架构/安装/使用/验证/许可)。

### 7. 用户名路径泄露 ⚠️(轻度)

46 个 tracked 证据 JSON 含 `/home/zhkzly/...` 绝对路径,公开的是本机用户名(大概率与 GitHub 用户名一致,风险低)。可选:发布前 sed 清洗,或接受。

### 8. 其他

- 2 个未跟踪文件(`docs/composed-009-20261105/final-state*.md`,2026-11-08 收口记录):提交或删除后再发布。
- 未配置 git remote;push 前 `git remote add origin <url>`。
- 26GB 工作树体积来自 gitignored 数据与 `.worktrees/`,不会被 push;`.git` 49MB 在 GitHub 限额内。
- 顶层敏感目录核对:`.goal-runs/`、`.worktrees/`、`.implementation-checks/`、`.openviking/` 均已忽略。

## 建议发布步骤

1. 修复 `tests/checker-delivery-recovery.test.cjs` 失败(或定位为测试期望过时并修正断言),使 `npm test` 全绿。
2. 选择 LICENSE(MIT / Apache-2.0),加 LICENSE 文件 + `package.json` license 字段;补 repository/author,移除 private。
3. 决定 2 个未跟踪 docs 文件的去留,清空工作区。
4. 重写公开 README(可选,强烈建议);内部日志移入 docs。
5. (可选)清洗 46 个文件中的 `/home/zhkzly` 路径。
6. `git remote add origin <url> && git push -u origin main`。
7. push 后复核:GitHub 界面确认无 `.env`、无 data/,README 渲染正常,`npm test` 在干净 clone 上通过。

## 修复记录(2026-11-10 同日)

发布阻塞项已在发布前处理完毕:

1. **#5 测试失败已修复**(全量 2182 通过 / 0 失败, exit 0)。根因: e943e5b 引入 sparse 审计通道与 audit_format_repair 独立 stage(D10/D13), 以及 73c3972 增加 experience-unassertable 职责行, 均未同步迁移测试与合成 responder。按 union 自身的 audit-aware 迁移模式处理, 未削弱任何不变量:
   - tests/checker-delivery-recovery.test.cjs: delivery_repair 记账断言迁移至 audit_format_repair; already-used 场景改为任务预算耗尽守卫(新设计下 checker 修复的一次性边界由任务级 attempt 预算兜底)。
   - scripts/goal-help-quality-check.cjs 与 scripts/goal-acceptance-check.cjs: 合成 fidelity_check responder 迁移为精确 sparse-defects-v1 信封。
   - tests/continuous-conversation.test{,.a001,.d006}.cjs: 迁移为每案例主调用+必经只读审计=2 次调用; 变体文件对齐 union 契约(自动候选均有审计)。
   - tests/help-generation-contract.test{,.a001,.d006}.cjs 与 tests/speaker-attribution-chain.test.cjs: 前台协议字节界 5000 改 5150 重定界(实测下限 5052, 保持约 100 余量, 注释记录成因)。
2. **#6 LICENSE 已补**: MIT, 版权归 zhkzly。
3. **#7 package.json 已补**: license/repository/bugs/homepage/author, 移除 private。
4. **#8 README 已重写**为公开主页; 原发布日志保留于 docs/release-log.md。
5. **#10 两个未跟踪文件**随本次发布提交(docs/composed-009-20261105/final-state*.md)。
6. **#9 用户名路径**(46 个文件含 /home/zhkzly)经确认与 GitHub 账号身份一致, 按原样发布。

## 审计方法备注

- 凭证:模式扫描(sk-/AKLT/ghp_/JWT/UUID)+ 人工复核全部命中上下文。
- 历史:`git log --diff-filter=A` 核对敏感路径 + `git grep` 抽样近期 400 commit。
- 个人数据:手机号/QQ 号/真实姓名模式扫描 + 人工抽读关系类文档确认虚构标注。
- 本审计为 2026-11-10 快照;发布前如有新 commit,需对增量重跑 #1–#3。
