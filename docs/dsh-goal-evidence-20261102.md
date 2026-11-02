# Goal 迭代证据总结 — 2026-11-02

## 已验收（accepted）

| 轮 | 目标案例 | 盲评结论 |
|---|---|---|
| 002d | coverage-long-private-consultation | 7/7 usable；咨询跨轮记忆修复 |
| sv-002 | coverage-long-single-source | 双步 usable；时间窗+录音细节完整采纳 |
| sw1i | replay-job-change-later-recall | 配对双臂 64-cap；候选 3/3 usable（B12 修复正式验证），基线 3/3 冻结失败；守卫双步 usable |

memory_continuity 阶段：11/11 目标全部有 usable 盲审判定（accepted 谱系）。

## 结构性修复（全部在 main，1934 测试绿）

B1-B12 瓶颈全部定位、结构承载、live 验证。最新 B12 arrangementHandling 消费契约：门控 + wire 句柄解码 + 解析期补全——sw1i 配对验证。

## hard-v1 难例扩展（goal v2026-11-02.3）

5 个针对真实弱点的新案例（说话人归属/撤回后引用/时间窗冲突/过期事实/线程存活），冻结 38 案例哈希不变。
首轮验证（hd-sw6b）：16/16 全 usable、零硬失败、4 目标全等价——修复是架构性的。守卫线程存活候选 2/3 胜出。

## CQ 阶段

全 21+5 目标首轮覆盖完成。反复出现的候选优势模式：当场交付可用草稿 vs 只澄清推迟（多轮盲评一致）。
cq-sw2/sw6b 因代理 503 中断如实 inconclusive；cq-sw7 双臂 fresh 已执行完毕，打包盲评待下轮。

## 待办（下轮）

1. cq-sw7 打包盲评裁决（双臂 fresh 已在盘）
2. delivery_provenance 专项轮
3. 生命周期条款：白天桌面验证（需用户操作）
4. 可选层退役（parity §6 路线图）
5. UI 两轮重设计已合入 main，待实际使用反馈


## 通宵 mega-run 计划（22:00 启动）

| 轮 | 覆盖 | 目的 |
|---|---|---|
| dp-sw2 | delivery 10 案例 | B15 修复（STATED_FACT_GUARD）后验收重试 |
| mc-sw15 | memory_continuity 全 16 案例 | 阶段完成度冲顶（全案例单轮配对）|
| cq-sw16 | CQ 全 32 案例 | 阶段完成度冲顶（含 hard-v1 扩展）|

每轮完成后：组装 → attach → 盲评 → check → decide → main 同步。
守卫全部通过 + 目标改进注册 = 阶段验收；仅 parity 则如实 inconclusive。

## 当日最终账本（截至 22:00）

- 4 ACCEPTED 轮（002d/sv-002/sw1i/cq-sw14）
- B1-B15 全部定位→修复/入档（B12/B13/B14/B15 当日发现当日闭环）
- 三阶段全盲评覆盖；1939+ 测试绿；冻结数据集哈希全程不变


## mc-sw15 结果补录（23:00）

| 轮 | 覆盖 | 结果 |
|---|---|---|
| mc-sw15 | MC 全 16 案例 | 如实 inconclusive：12 共享案例 64/64 全 usable 全等价（完美 parity）；4 重案例基线结构性不可用（sw1i 已记录并验收改进证据）|

_delivery_provenance dp-sw2 ACCEPTED 已在上方记录（B15 验证 live，2 目标改进 + 守卫全净）。_


## dp-sw3 结果（23:59）

inconclusive：40 usable + 2 minor + 2 insuff，零硬失败，7 候选偏好。**B15 composer 修复有效但 observed 通道冗余仍在（投影层架构）→ B16 入档**。delivery 验收推迟至投影修复后。


## dp-sw5 ACCEPTED（01:15）—— delivery 阶段完美验收

**44/44 全 usable、零 minor、零 insuff、零硬失败**——goal 史上首个完美轮。
全部修复链一次验证：B15/B16 通道冲突解决 + invitation s1 分支补全 + null-output 正确判定。
1 目标改进（invitation s2）+ 3 守卫偏好 + 18 等价 + 0 落败。

## Delivery 证据链完整闭环（5 轮因果）

| 轮 | 发现 | 修复 |
|---|---|---|
| dp-sw1 | 通道冗余 | B15 |
| dp-sw2 | 验证 composer 修复 | STATED_FACT_GUARD |
| dp-sw3 | 定位真因（投影/合规） | 反例强化守卫 |
| dp-sw4 | invitation 分支缺口 | GENERATED_VS_ACTUAL_GUARD |
| **dp-sw5** | **全部通过 · ACCEPTED** | — |
