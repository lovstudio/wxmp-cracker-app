# ADR 0002：采用可插拔数据 Provider 与统一采集编排器

- 状态：Accepted
- 日期：2026-08-26
- 决策人：产品确认，工程按渐进路线实施
- 相关 PRD：[微探数据采集与研究平台](../product/acquisition-platform-prd.md)
- 详细设计：[可插拔 Provider 架构](../architecture/pluggable-provider-architecture.md)

## 背景

微探的稳定用户需求只有三类：获取文章正文、获取文章互动数据、分页同步公众号文章列表。但这些需求的供给方式很多，包括普通 HTTP、本地缓存、公众号后台、本机微信会话、公众号文章列表、微信前台自动化和第三方 API。

当前实现把供给方式直接写入业务流程和前端类型。新增一种数据来源时，需要修改路由函数、状态文案、数据库来源字段和 UI 分支；某个供给方式失败时，也容易让整个用户任务卡死。微信自动化等降级路径因此逐渐主导产品结构。

产品还需要支持 Provider 评测、用户策略选择、后台任务、公众号监控和 Agent 分析。如果继续采用硬编码调用链，功能数量和失败组合会快速失控。

## 决策

采用本地优先的模块化单体，并在采集域内建立可插拔 Provider 架构：

1. 对外只暴露稳定 Capability：
   - `article.content.fetch`
   - `article.metrics.fetch`
   - `account.articles.list`
   - 以及作为前置步骤的文章、公众号身份解析能力。
2. 建立 Provider Registry。Provider 通过版本化 Manifest 声明能力、字段、认证、分页、成本、数据边界和副作用。
3. 建立 Acquisition Orchestrator，根据用户策略、动态健康、实测质量和副作用约束选择 Provider 并执行降级。
4. Provider 返回带身份证据的候选结果，不直接决定规范资源合并，也不控制前端流程。
5. 所有长任务使用可恢复 Job；每次 Provider 执行保存独立 Attempt。
6. 数据保存字段级 provenance、抓取时间、完整度和分页 Coverage。
7. 支持三种 Provider 形态：
   - 随 App 发布的 Built-in Rust Provider；
   - 通过版本化 JSON 协议运行的 Local Sidecar Provider；
   - 用户显式启用的 Remote HTTP Provider。
8. 第一版不加载第三方动态库。Sidecar 是第三方和实验性本地插件的主要隔离边界。
9. 现有实现先包装为 Legacy/Built-in Provider，再逐步拆分；不进行一次性重写。
10. 前端不得再以 `wechat_*` 来源字符串决定业务流程，只展示经过统一模型处理的任务、结果、来源摘要和影响等级。

## 重要约束

- 身份正确性是硬门槛，不能用更快但可能误匹配的 Provider 换取速度。
- 会操作微信前台、产生费用或发送远程数据的 Provider 不得隐式并行执行。
- 用户可禁止前台操作和 Remote Provider。
- Provider 不能把缺失字段写成零。
- Provider 凭证只按 Capability 最小化提供，日志不得保存完整令牌。

## 正面影响

- 新数据源可以通过注册 Provider 接入，而不改变三类用户需求的 UI 和 API。
- 微信自动化退化为可替换的最后降级路径。
- 可以基于真实成功率、完整率、耗时和副作用动态路由。
- 公众号分页、重试、取消、恢复和监控共用 Job 基础设施。
- 文章正文、互动数据和列表可以由不同 Provider 组合补齐。
- Provider 失败被隔离到 Attempt，不再等同于用户任务整体失败。
- 数据集和 Agent 分析建立在规范数据及可追溯来源之上。

## 负面影响

- 初期需要同时维护旧调用链和新编排器。
- Manifest、Job、Attempt、身份映射和 provenance 增加数据模型复杂度。
- Provider Contract Test Kit 和基准集需要持续维护。
- Sidecar 生命周期、协议兼容和权限边界带来额外工程工作。
- 自动路由的可解释性需要专门的产品设计，不能只显示“自动选择”。

## 中性影响

- 主程序仍为 Tauri/Rust/React，数据库仍为本地 SQLite。
- 现有 wcx 常驻进程可作为第一批 Sidecar Provider，不需要立即替换。
- 第三方数据 API 可以接入，但不会成为产品运行的强依赖。

## 考虑过的方案

### 继续维护硬编码 fallback 链

拒绝。短期修改最少，但新增 Provider、策略和失败组合会继续扩散到 UI 与数据库。

### 只保留一种“最强”数据来源

拒绝。文章正文、互动数据和公众号列表具有不同权限、稳定性和成本，不存在长期覆盖全部需求的单一来源。

### 推倒重写现有抓取逻辑

拒绝。现有缓存、wcx、公众号后台和微信自动化已经包含大量真实环境知识。应先适配再替换，避免同时改变契约和实现。

### 使用 Rust/C 动态库作为插件 ABI

第一版拒绝。动态库存在 ABI、崩溃隔离、签名、升级和供应链风险。可信核心能力采用 Built-in，第三方本地能力采用 Sidecar 协议。

### 拆成微服务

拒绝。当前是单用户本地桌面场景，微服务会引入部署、认证、网络和可观测性成本，不能解决当前边界问题。模块化单体已经足够。

### 完全依赖第三方数据 API

拒绝。成本、隐私、覆盖率和长期稳定性不可控。Remote Provider 应是用户可配置的供给方式之一。

## 失败模式与缓解

| 风险                              | 缓解                                                  |
| --------------------------------- | ----------------------------------------------------- |
| Provider 声明能力与真实行为不一致 | 统一 Contract Test Kit，加真实基准验证                |
| 自动路由选择了不合适的 Provider   | 保留路由解释、用户策略和单 Provider 强制模式          |
| Provider 身份匹配错误             | Identity Resolver 硬校验，冲突拒绝合并                |
| Legacy Provider 继续渗透新层      | 新 UI 只调用 Orchestrator，逐模块设置迁移门禁         |
| Sidecar 崩溃或失联                | 进程隔离、心跳、超时、取消和熔断                      |
| 远程 Provider 泄露数据            | 默认禁用、显式授权、Manifest 数据边界和审计           |
| 双写阶段产生不一致                | 以新 Job/Attempt 为审计源，执行可回滚的影子写入和对账 |

## 与 ADR 0001 的关系

[ADR 0001](0001-event-driven-wechat-public-metrics-capture.md) 中关于身份校验、未知值、敏感日志和有界窗口副作用的安全原则继续有效。

它对“非自有文章互动数据必须通过一条特定微信导航链处理”的产品级编排结论将由本 ADR 取代。迁移完成前，ADR 0001 描述的实现作为 `wechat.ui-automation` 或相关 Legacy Provider 的内部约束继续保留。

## 后续实施门禁

- 产品确认三类核心 Capability 和默认用户旅程。
- 工程确认 Built-in、Sidecar、Remote 三种插件边界。
- 安全评审确认 Sidecar 权限和 Remote 数据边界。
- 数据模型能够表达 Job、Attempt、Identity、Coverage 和 provenance。
- 迁移方案证明无需一次性重写现有能力。
