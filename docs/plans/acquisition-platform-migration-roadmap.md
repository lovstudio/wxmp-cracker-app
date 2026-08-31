# 微探采集平台渐进迁移路线

- 状态：In progress
- 日期：2026-08-26
- 原则：先建立契约和观测，再迁移调用；不推倒重写，不继续扩张旧分支
- 相关 PRD：[数据采集与研究平台](../product/acquisition-platform-prd.md)
- 相关架构：[可插拔 Provider 架构](../architecture/pluggable-provider-architecture.md)

## 1. 当前基线

现有能力已经覆盖：

- 文章链接导入与正文抓取；
- 公众号搜索、分页抓取和正文补齐；
- 自有公众号后台互动数据；
- 本机微信缓存、会话和公众号列表互动数据；
- 微信前台自动化兜底；
- 本地文章库、标签、筛选、归档和导出。

问题是这些能力通过 `commands.rs`、`public_metrics.rs`、`wechat_automation.rs` 和前端来源分支直接耦合。迁移目标不是重新发明这些能力，而是让它们服从统一 Capability、Job 和 Provider 契约。

## 2. 迁移规则

1. 新需求不得继续在旧模块中增加跨 Provider fallback。
2. 每次只迁移一项 Capability，并保留 Feature Flag 回滚。
3. 新内核先影子执行和对账，再成为默认路径。
4. 真实环境成功率、字段完整率和副作用不低于旧路径才能切换。
5. 旧数据原地兼容；新增表采用可回滚迁移。
6. 任何阶段都保持当前开发实例可运行，不同时启动生产实例验证。

## 3. 目标目录结构

```text
src-tauri/src/
  acquisition/
    mod.rs
    capability.rs
    request.rs
    result.rs
    orchestrator.rs
    routing.rs
    job.rs
    errors.rs

  providers/
    mod.rs
    registry.rs
    manifest.rs
    health.rs
    builtin/
      local_cache.rs
      public_http.rs
      mp_backend.rs
      wechat_session.rs
      wechat_account_feed.rs
      wechat_ui.rs
    sidecar/
      protocol.rs
      runtime.rs
    remote/
      client.rs

  domain/
    account.rs
    article.rs
    identity.rs
    content.rs
    metrics.rs
    coverage.rs

  repositories/
    resource_repository.rs
    acquisition_repository.rs
    provider_repository.rs
    dataset_repository.rs
```

目录表示依赖方向，不要求一次性移动现有文件。

## 4. 阶段 0：契约、基准和门禁

### 工作

- 确认 PRD、ADR 和 Provider 协议。
- 建立固定基准集：文章正文、互动数据、公众号列表和不同内容类型。
- 给现有三类用户旅程记录：
  - 成功率；
  - 身份正确率；
  - 字段完整率；
  - p50、p95；
  - 人工步骤；
  - 前台抢占和残留窗口。
- 为旧入口分配稳定诊断 ID，避免只有自然语言日志。
- 建立架构测试：前端不得新增 Provider 特定业务分支。

### 退出条件

- 三类请求及结果语义冻结为 v1。
- 至少一套可重复执行的本地基准集。
- 当前旧路径拥有可比较的真实基线。

## 5. 阶段 1：最小采集内核

### 工作

- 建立 Capability、Request、Result、Provider Manifest 和 Registry。
- 建立 Job 与 Attempt SQLite 表及 Repository。
- 建立 Orchestrator，但第一版只支持指定 Provider，不做复杂自动评分。
- 将结构化事件桥接到前端 `acquisition-job-updated`。
- 现有 `public_metrics.rs` 先包装为 `legacy.article-metrics` Provider。
- 现有正文与公众号抓取分别包装为 Legacy Provider。

### 退出条件

- 三类请求都能通过新内核调用旧实现。
- Provider 失败只结束 Attempt，Job 能继续选择后续 Provider。
- UI 可以离开当前页面后继续收到任务状态。
- 新旧结果对账没有资源身份差异。

## 6. 阶段 2：身份、provenance 与分页恢复

### 工作

- 增加 `account_identities` 和 `article_identities`。
- 将临时 URL、`fakeid`、`biz`、`mid`、`idx`、`sn` 统一映射到规范资源。
- 将互动数据迁移为追加快照及字段级 provenance。
- 增加 `sync_checkpoints` 和规范 Coverage。
- 公众号分页支持暂停、恢复、取消和幂等提交。
- 对同一 Provider 的 cursor 加版本约束。

### 退出条件

- App 中断后能从最后成功页面恢复。
- 重跑任务不会重复创建文章或覆盖正确正文。
- 身份冲突进入待确认，不会自动写错公众号。
- UI 能显示“同步到哪里”而非只显示抓到多少篇。

## 7. 阶段 3：拆分第一批正式 Provider

按低风险到高风险迁移：

1. `cache.article.local`
2. `http.article.public`
3. `wcx.local`
4. `wechat.mp-backend`
5. `wechat.session-cache`
6. `wechat.account-feed.local`
7. `wechat.ui-automation`

每迁移一个 Provider 都必须：

- 补齐 Manifest；
- 通过 Contract Test Kit；
- 跑固定基准集；
- 与 Legacy Provider 对账；
- 验证取消、超时和敏感日志；
- 删除已被正式 Provider 覆盖的旧分支。

### 退出条件

- `public_metrics.rs` 不再承担 Provider 选择和 UI 导航编排。
- `commands.rs` 只做参数校验和 Use Case 调用。
- 前端不再判断 `wechat_*` 来源来决定流程。
- 微信 UI 自动化明确处于最后降级位置。

## 8. 阶段 4：Provider 自动路由与评测

### 工作

- 持久化 Provider Health 和最近执行指标。
- 实现候选过滤、规则评分、熔断和恢复。
- 支持后台优先、速度优先、完备率优先、低成本和指定 Provider。
- 只有无前台、无费用、无远程副作用的 Provider 可并行或 hedged。
- 增加路由解释：为什么选择、为什么跳过、为什么降级。
- 在设置中提供 Provider 健康和基准结果视图。

### 退出条件

- 自动路由在基准集上的成功率不低于任何单一默认 Provider。
- 用户可以禁止前台和 Remote Provider，且不会被隐式绕过。
- 身份冲突自动阻断，不参与“部分成功”统计。

## 9. 阶段 5：重做三类核心 UX

### 工作

- 建立统一采集入口，自动识别文章链接、公众号名称和 ID。
- 文章任务支持“正文”和“互动数据”独立选择。
- 公众号同步支持范围、类型、正文、互动和监控策略。
- 建立任务中心，移除长时间绑定页面的 Spinner。
- 资料库展示新鲜度、完整度、Coverage 和来源摘要。
- Provider 高级选项进入设置，不占据普通用户主流程。

### 退出条件

- 新用户不理解 Provider 也能完成三类任务。
- 需要前台微信时必须在执行前明确提示。
- 失败结果提供恢复动作与诊断 ID，不要求用户阅读内部日志。

## 10. 阶段 6：数据集与 Agent 分析

### 工作

- 将标签扩展为保存筛选和冻结数据集。
- 冻结数据集保存文章 ID 与正文版本。
- 定义 Analysis Provider，支持内置 Agent 和外部 Agent 连接器。
- 建立文风、选题、观点演变和高表现文章等模板。
- 分析结果必须引用输入文章，不生成无法追溯的结论。

### 退出条件

- 用户可在资料库筛选十篇文章并一键分析。
- 同一冻结数据集重复运行可得到可比较结果。
- 分析产物可以回链具体文章与段落。

## 11. 阶段 7：监控与外部 Provider SDK

### 工作

- 建立公众号 Monitor、调度、去重和失败通知。
- 新文章可以触发正文、互动、数据集和分析工作流。
- 发布 Sidecar Provider SDK、Manifest Schema 和 Contract Test Kit。
- 建立安装来源、完整性校验、权限声明和卸载机制。

### 退出条件

- 监控任务在 App 重启后恢复且不重复导入。
- 第三方 Provider 无需修改主应用业务代码即可接入。
- Provider 升级不兼容时被安全拒绝，不影响主应用启动。

## 12. 现有文件迁移映射

| 当前文件                               | 迁移方向                                        |
| -------------------------------------- | ----------------------------------------------- |
| `src-tauri/src/public_metrics.rs`      | 拆为互动 Use Case、Normalizer 和多个 Provider   |
| `src-tauri/src/wechat_account_feed.rs` | `wechat.account-feed.local` Provider 内部实现   |
| `src-tauri/src/wechat_automation.rs`   | `wechat.ui-automation` Provider 内部实现        |
| `src-tauri/src/commands.rs`            | 瘦 Tauri 命令层，调用 application use cases     |
| `src-tauri/src/db.rs`                  | 拆为资源 Repository，保留兼容 facade            |
| `src/lib/api.ts`                       | 稳定 Job/Resource API，不枚举 Provider 业务分支 |
| `src/components/article-list.tsx`      | 只创建任务和展示状态，不执行 Provider 策略      |
| `src/components/account-workspace.tsx` | 资料库、数据集与分析工作流                      |

## 13. Feature Flag 与回滚

建议提供：

- `acquisition_core_v1`
- `acquisition_metrics_v1`
- `acquisition_account_sync_v1`
- `acquisition_content_v1`
- `acquisition_ui_v1`

切换策略：

1. 开发环境先启用影子执行，只记录对账，不改变用户结果。
2. 单 Capability 开启新读路径，旧路径保留回滚。
3. 新写入稳定后停止双写。
4. 最后删除旧分支和 Feature Flag。

不得让影子执行触发微信前台、付费或远程副作用；这些 Provider 只能在明确测试任务中对账。

## 14. 每阶段统一验证

- Rust 单元和集成测试；
- Provider Contract Test Kit；
- 固定基准集真实运行；
- SQLite 迁移与回滚测试；
- 前端 typecheck、测试和生产构建；
- 当前开发实例真实用户旅程；
- 进程、窗口、凭证和敏感日志审计；
- `git diff --check` 与无关 dirty 文件保护。

## 15. 首个实施切片

- 实施状态：已完成（2026-08-26）
- 默认开关：`VITE_ACQUISITION_CORE_V1`；设为 `0` 可回退旧 Tauri 命令
- 真实验证：自有文章 `2247498514_1` 经 `wechat_mp_backend`、`legacy.article-metrics`、Job/Attempt 和标准结果信封完成，耗时 1.802 秒，未调用微信 UI

第一刀只做以下内容，不拆微信自动化：

1. 建立 Capability、Manifest、Registry、Job 和 Attempt 类型。
2. 建立最小 SQLite 表。
3. 将文章互动现有入口包装为 `legacy.article-metrics` Provider。
4. 前端仍使用原按钮，但内部创建 Job 并接收统一事件。
5. 运行现有真实样本，证明新内核没有改变结果、耗时和窗口行为。

这个切片验证插件边界是否成立，同时保留完整回滚能力。
