# 调研结论与组件选择

日期：2026-10-11。结论置信度：整体组件路径中等偏高；用户当前 Ubuntu/QQ 版本的端到端兼容尚待实盘验证。

建议开发“桌面 QQ 只读接入 + 辅助窗口”，以现有 QQ 登录实例为主。先验证同一客户端的历史与双向消息读取，再实现建议、复制和导出。现有 Docker 机器人适合托管消息，不提供当前桌面会话绑定或原客户端历史可达性的证明。

## 证据如何分级

- 【经验级·维护方文档/源码】：可核对的功能、参数、实现路径，不等于在本机可用。
- 【现场执行证据】：本次实际执行的本机检查；只证明该检查覆盖的事实，不是效果对照实验。
- 【推断级】：本项目架构选择和预计代价。
- 【实验级】：需要有对照样本与数字；本轮没有恋爱建议效果实验，也没有完整 QQ 接入实验。

## 已核验的候选组件

| 组件 | 正向证据 | 负向/缺口 | 判断 |
|---|---|---|---|
| LiteLoaderQQNT-GPT-Reply | QQ 内图标/右键入口、自定义模型接口、复制建议；当前源码只有复制监听器生效 | 生成入口传入提示文本；未发现自动历史回补与双向监听的完整链路；当前 QQ 兼容未实测 | GUI 接入与复制交互的参考，不直接当成成品 |
| NapCat Framework | 官方当前文档描述桌面 QQ 插件方式，可配置 OneBot | 前提是 LiteLoader 支持当前 QQ；文档不能证明 Ubuntu 26.04 的这版客户端兼容 | 只读采集候选，M0 先验证 |
| NapCat 历史/事件接口 | 存在指定好友历史接口；自发消息可上报 | 无游标时读最新窗口；空结果实现会抛错；自发消息默认不上报 | 核验分页和方向识别的基础 |
| QQ Chat Exporter | 有成熟历史分页、导出、进度和覆盖信息处理 | 官方发布包中桌面 Framework 标为 Windows；Linux 的 Shell 支持不能移植成桌面兼容证明 | 参考/复用已验证的数据读取方法，不能用导出导入替换主体验 |
| Cherry Studio 快捷助手 | 浮动窗口，可读剪贴板、复用助手提示 | 官方流程仍基于输入或剪贴板；未证明 QQ 会话历史与双向实时同步 | 快速体验文案建议的辅助选项 |
| 本地 FisherAI | 现有侧栏、模型调用、流式显示和复制结构 | Manifest 是 Chrome sidePanel/网页内容脚本；没有桌面 QQ 采集层；工作区有既有修改 | 可参考交互与异步防护，保持其项目不变 |

依据：[QQ 内 GPT 插件](https://github.com/wangyz1999/LiteLoaderQQNT-GPT-Reply)、[NapCat Framework](https://napneko.github.io/guide/boot/Framework)、[QCE 使用手册](https://qce.sdjz.wiki/docs/guide.html)、[Cherry 快捷助手](https://cherryai.com/docs/en/cherrystudio/preview/quick-assistant/)、[Chrome sidePanel](https://developer.chrome.com/docs/extensions/develop/ui/create-a-side-panel)。均属于【经验级】功能资料。

## 历史接口：存在，但不能等同于完整历史

冻结的 NapCat 源码显示：QQ 号先解析为 NTQQ UID；无有效游标调用 `getAioFirstViewLatestMsgs`，有游标才调用 `getMsgHistory`。空消息列表会抛错误，响应没有一个可以证明腾讯服务端“全部历史”的标记。

[具体实现](https://github.com/NapNeko/NapCatQQ/blob/7471e3ecd648189a9e80530b00348a17a4528906/packages/napcat-onebot/action/go-cqhttp/GetFriendMsgHistory.ts)，【经验级·源码】。

工程选择【推断级】：后台做分页、去重、进度和覆盖记录；游标不前进或错误时显示部分加载，不能把错误转换成“已读完全部”。QCE 的分页和漫游文档可供参考。其漫游资料明确限定验证环境，并提醒查询可能触发 QQ 同步/缓存更新；不是完全无副作用的数据库读取，也不证明服务端历史完整。

[QCE 私聊漫游边界](https://github.com/shuakami/qq-chat-exporter/blob/7d154b847a0cb3f9cffbdb126598c4d1434995ba/docs/roaming-api.md)，【经验级·维护方验证记录】。

## 双向监听：必须区分发送者与对端

NapCat 网络适配器默认关闭 `reportSelfMessage`。收到自己的已发消息时，`user_id` 是自己，事件为 `message_sent`；私聊事件还携带对端 `target_id`。因此不能只用 `user_id == 指定好友` 过滤，否则会漏掉用户自己发送的话。

[事件派发](https://github.com/NapNeko/NapCatQQ/blob/7471e3ecd648189a9e80530b00348a17a4528906/packages/napcat-onebot/index.ts)、[消息构造](https://github.com/NapNeko/NapCatQQ/blob/7471e3ecd648189a9e80530b00348a17a4528906/packages/napcat-onebot/api/msg.ts)，【经验级·源码】。

工程选择【推断级】：先识别真实对端，再进行会话过滤；保存实际已发文本；不要将复制的 AI 草稿提前写成用户消息。

## 当前机器：哪些真正测过

本轮会话已确认 Ubuntu 26.04、桌面 QQ 3.2.31-51102；现有本机模型服务的模型列表和简短生成请求曾返回 HTTP 200。历史读取与桌面插件没有实盘验证。此前 Docker 的 QQ 数据挂载独立于桌面程序；据此不能推导它能读到桌面的全部旧记录。

这是【现场执行证据】，不证明新产品的延迟、建议质量或 QQ 接入成功。这里不保存真实联系人号码、API Key 或聊天内容。

## 推荐决定

1. 优先研究同一桌面 QQ 的插件/Framework 接入，窗口采用 QQ 的 Electron 插件入口或受支持的本机伴随窗口。
2. 独立实现会话隔离、上下文构建、建议和复制；模型沿用已有本机 API。
3. 历史读写方法参考 QCE，文件导出作为副功能。窗口开启时自动加载，不能要求手工准备历史文件。
4. 首先交付 M0 的本机兼容证据；未通过时列出确切阻塞，不能宣称 MVP 已实现。

这是一项【推断级】工程选择，不是现成产品的实盘结果。

## 许可与材料范围

冻结源码的许可标识：GPT-Reply 为 MIT；QCE 为 GPL-3.0；NapCat 为自定义 Limited Redistribution License。研究项目仅保存链接和原创说明，没有将其实现源码并入项目。未来任何代码复制、改动或公开打包均应先核对相应完整许可及授权，不能把所有仓库统一称为无条件可复用。

[NapCat 许可](https://github.com/NapNeko/NapCatQQ/blob/7471e3ecd648189a9e80530b00348a17a4528906/LICENSE)、[QCE 许可](https://github.com/shuakami/qq-chat-exporter/blob/7d154b847a0cb3f9cffbdb126598c4d1434995ba/LICENSE)、[GPT-Reply 许可](https://github.com/wangyz1999/LiteLoaderQQNT-GPT-Reply/blob/24c0d6f0237549712a18f9748e2f21598e398755/LICENSE)。这只是事实记录，尚未进行发行方案的许可审查。


## 2026-10-11 实现与现场验证更新

已落地为独立可运行项目，而不再停留在界面原型。当前桌面 QQ 为基础版 3.2.31、自动更新版 3.2.33、Electron 40。MIT LiteLoader 的私有副本需要一行 Dirent.path 兼容修复；Electron 40 使用官方 `session.registerPreloadScript` 注入窄入口。来源：[Electron session 官方文档](https://www.electronjs.org/docs/latest/api/session)。

NapCat 最新插件入口限制了第三方插件，且此桌面 QQ 不通过 JavaScript dlopen 导入 wrapper.node。最终采用本机实际观测的 QQ IPC 读接口，不加载、修改或冒充 NapCat 官方插件。已实际读取两页共 58 条指定会话记录。完整验证与未关闭项见 [verification_CN.md](verification_CN.md)。

真实聊天给模型的数据授权仍待用户确认；自动审批拒绝后已默认关闭。调研与代码包均不包含真实聊天、凭据或原 QQ 资料。

## 2026-10-12 当前状态

上文待授权/58 条记录为前一日快照。当前用户已对所选文字会话授权；图片仍独立默认禁止。真实 QQ 现已验证 739 条双方历史、全部浏览、点击私聊入口自动绑定、原生输入框插入与清除测试文字。没有发送 QQ 测试消息；新来信完整链路未现场确认。模型配置与上下文规则、窗口修复负结果及最终证据分别见 context-management_CN.md、window-fill-fix_CN.md、verification_CN.md。
