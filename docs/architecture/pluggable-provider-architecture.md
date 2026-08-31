# 可插拔数据 Provider 架构

- 状态：Accepted（Phase 1 实施中）
- 日期：2026-08-26
- 架构风格：本地优先的模块化单体 + 可隔离 Provider
- 产品需求：[数据采集与研究平台 PRD](../product/acquisition-platform-prd.md)
- 架构决策：[ADR 0002](../adr/0002-adopt-pluggable-acquisition-providers.md)

## 1. 设计原则

1. **需求稳定，供给可替换**：产品 API 表达用户要什么，不表达通过微信窗口、缓存还是第三方服务实现。
2. **Provider 不拥有产品流程**：Provider 只执行声明过的能力；选择、降级、持久化和通知由编排器负责。
3. **身份先于数据**：任何结果必须携带可校验的资源身份证据，身份不确定时不写入规范数据。
4. **字段级 provenance**：同一结果可以由多个 Provider 补齐，来源记录到字段而不是仅记录到整行。
5. **副作用可见且有界**：前台窗口、登录请求、远程上传和付费调用都必须通过 Manifest 声明。
6. **长任务可恢复**：分页、重试、等待授权和监控统一进入 Job 模型。
7. **先包装，后替换**：现有实现先作为 Legacy Provider 接入，不做一次性重写。

## 2. 高层结构

```text
┌─────────────────────────────────────────────────────────────────┐
│                         React UI                                │
│  统一采集入口 / 资料库 / 数据集与分析 / 任务与自动化 / 设置      │
└──────────────────────────────┬──────────────────────────────────┘
                               │ stable commands + job events
┌──────────────────────────────▼──────────────────────────────────┐
│                    Application / Use Cases                      │
│  AcquireArticleContent  AcquireArticleMetrics  SyncAccount      │
└───────────────┬────────────────────┬────────────────────────────┘
                │                    │
        ┌───────▼────────┐   ┌──────▼───────────┐
        │ Job Coordinator │   │ Result Normalizer │
        │ retry / cancel  │   │ identity / merge │
        └───────┬────────┘   └──────┬───────────┘
                │                    │
        ┌───────▼────────────────────▼───────────┐
        │          Provider Orchestrator          │
        │ registry / policy / score / fallback   │
        └───────┬───────────┬────────────┬────────┘
                │           │            │
      ┌─────────▼───┐ ┌─────▼──────┐ ┌──▼──────────────┐
      │ Built-in     │ │ Local       │ │ Remote          │
      │ Rust         │ │ Sidecar     │ │ HTTP API        │
      └─────────┬───┘ └─────┬──────┘ └──┬──────────────┘
                └────────────┴────────────┘
                              │ candidate results
┌─────────────────────────────▼───────────────────────────────────┐
│                         Repositories                            │
│ resources / identities / content / metrics / jobs / attempts   │
│ datasets / analyses / monitors                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 3. 稳定能力契约

第一阶段只定义五种基础能力，其中三种直接对应用户需求：

| Capability              | 用途                              | 是否直接面向用户 |
| ----------------------- | --------------------------------- | ---------------- |
| `article.resolve`       | 从 URL 或外部 ID 解析规范文章身份 | 否，作为前置能力 |
| `article.content.fetch` | 获取正文、元数据和媒体引用        | 是               |
| `article.metrics.fetch` | 获取文章互动快照                  | 是               |
| `account.resolve`       | 从名称、ID 或文章解析公众号身份   | 否，作为前置能力 |
| `account.articles.list` | 分页获取公众号文章列表            | 是               |

后续可增加 `media.fetch`、`comments.list` 等能力，但不得通过修改既有请求语义来塞入新功能。

### 3.1 请求信封

概念结构如下：

```rust
struct AcquisitionRequest {
    api_version: u32,
    request_id: String,
    capability: CapabilityId,
    input: ResourceInput,
    fields: FieldSelection,
    freshness: FreshnessPolicy,
    execution: ExecutionPolicy,
    pagination: Option<PaginationRequest>,
}
```

`ExecutionPolicy` 表达用户约束，而不是具体实现：

- `automatic`
- `background_only`
- `fastest`
- `highest_coverage`
- `lowest_cost`
- `provider:<provider_id>`
- `allow_foreground_interaction`
- `allow_remote_processing`

### 3.2 Provider 结果信封

```rust
struct ProviderResult {
    provider_id: String,
    status: ProviderResultStatus,
    resource: CandidateResource,
    identity_evidence: Vec<IdentityEvidence>,
    fields: Vec<ObservedField>,
    observed_at: i64,
    coverage: Coverage,
    next_cursor: Option<String>,
    exhausted: Option<bool>,
    diagnostics: ProviderDiagnostics,
}
```

状态包括：

- `complete`
- `partial`
- `unavailable`
- `blocked`
- `retryable_failure`
- `permanent_failure`

Provider 不得直接把 `unavailable` 字段转成零，也不得自行决定覆盖其他 Provider 的结果。

## 4. Provider Manifest

每个 Provider 必须拥有静态 Manifest 和动态 Health 两部分。

### 4.1 静态 Manifest

```json
{
  "id": "wechat.account-feed.local",
  "name": "本机微信公众号文章列表",
  "provider_version": "1.0.0",
  "api_version": 1,
  "execution_mode": "builtin",
  "capabilities": [
    {
      "id": "account.articles.list",
      "fields": ["identity", "title", "published_at", "metrics"],
      "pagination": "cursor"
    },
    {
      "id": "article.metrics.fetch",
      "fields": ["read", "like", "recommend", "share", "comment", "collect"]
    }
  ],
  "requirements": ["wechat_desktop_session"],
  "side_effects": ["foreground_window"],
  "data_boundary": "local_only"
}
```

Manifest 至少声明：

- 唯一 `provider_id` 和语义版本；
- 兼容的 Provider API 版本；
- 支持的 Capability、字段和分页模式；
- 需要的登录、软件、权限和网络环境；
- 是否使用前台、剪贴板、浏览器窗口或远程服务；
- 数据是否离开本机；
- 是否可能产生费用或额度消耗；
- 并发限制和取消能力。

### 4.2 动态 Health

Health 不能由“Provider 已安装”推断，必须通过轻量探测或最近真实执行更新：

```text
available | degraded | auth_required | permission_required |
rate_limited | offline | incompatible | disabled
```

动态信息包括：

- 最近探测时间；
- 登录与权限状态；
- 最近成功率；
- p50、p95 耗时；
- 字段完整率；
- 当前限流或熔断状态；
- 最近一次真实成功时间。

## 5. 三种插件执行形态

### 5.1 Built-in Provider

适用于：

- 需要直接访问现有 Rust 仓储或 macOS API 的可信实现；
- 稳定、核心且随 App 一起发布的 Provider；
- 现有本地缓存、公众号后台和微信自动化适配器。

优点是低延迟、部署简单；缺点是崩溃隔离较弱，需要随主程序发布。

### 5.2 Local Sidecar Provider

适用于：

- Python、Node.js 或独立 Rust 实现；
- 需要快速试验、单独升级或隔离崩溃的 Provider；
- 现有 wcx 常驻进程及未来的接口逆向实验。

第一版使用版本化 JSON Lines 或 JSON-RPC 协议，通过标准输入输出或本地受限套接字通信。主程序负责：

- 启动和生命周期；
- 握手及 `api_version` 校验；
- 超时、取消和心跳；
- 限制可传递的凭证和文件路径；
- 捕获结构化日志但过滤敏感字段。

不在第一版加载任意动态库，避免 Rust ABI、签名、崩溃和供应链风险。

### 5.3 Remote Provider

适用于第三方数据 API 或自建远程能力。

Remote Provider 必须额外声明：

- 数据发送范围；
- 服务域名和隐私说明；
- 认证方式；
- 定价和额度；
- 超时、重试及限流语义；
- 数据保留策略。

用户可全局禁止 Remote Provider；禁止时路由器不能将其作为隐式降级路径。

## 6. Provider Registry

Registry 的职责是：

1. 注册内置 Provider。
2. 发现允许的 Sidecar Manifest。
3. 加载用户配置的 Remote Provider。
4. 校验 ID 唯一性、API 版本和签名策略。
5. 保存启用状态、认证引用和用户优先级。
6. 对 Orchestrator 提供只读能力索引。

Registry 不负责执行任务，也不保存业务结果。

## 7. 路由与降级

### 7.1 候选过滤

先排除：

- 不支持请求 Capability 或字段的 Provider；
- 不符合 `background_only`、`allow_remote_processing` 等约束的 Provider；
- 未认证、缺少权限、已禁用或 API 不兼容的 Provider；
- 处于熔断期的 Provider；
- 无法满足身份校验最低要求的 Provider。

### 7.2 评分

候选 Provider 根据以下维度评分：

- 身份正确率；
- 字段完整率；
- 新鲜度；
- 最近成功率；
- p95 耗时；
- 前台干扰等级；
- 远程数据暴露等级；
- 成本和剩余额度；
- 用户偏好。

身份正确率是硬门槛，不参与以速度换正确性的加权。

### 7.3 执行策略

- 纯后台、只读、无费用 Provider 可以在明确策略下并行或采用 hedged request。
- 会操作微信前台、消耗付费额度或产生外部副作用的 Provider 必须串行执行。
- 同一请求不得并行启动两个微信前台 Provider。
- 获得足够结果后立即取消尚未开始的低优先级尝试。
- 部分结果可以继续由其他 Provider 补字段，但必须保留字段级来源。

### 7.4 熔断与恢复

- 连续出现相同系统性失败后暂时熔断 Provider。
- 身份冲突立即降低健康状态并禁止自动写入。
- `auth_required` 和 `permission_required` 不计入普通失败率。
- 健康状态可通过显式“重新检测”或成功探测恢复。

## 8. 身份解析与结果合并

Provider 返回 Candidate，不直接写入规范资源。

Identity Resolver 负责：

- 公众号：统一 `fakeid`、`biz`、别名、名称和 Provider 外部 ID；
- 文章：统一 URL、`biz`、`mid`、`idx`、`sn` 和 Provider 外部 ID；
- 处理重定向、临时签名链接和 URL 规范化；
- 对标题和日期匹配进行置信度约束；
- 冲突时创建待确认项，而不是错误合并。

Result Merger 负责：

- 依据观测时间和字段权威性合并；
- 保存每个字段的 Provider、原始观测时间和 Attempt；
- 正文以版本保存，不原地覆盖不可恢复内容；
- 互动数据只追加快照；
- 公众号分页结果去重并累计 Coverage。

## 9. Job 与 Attempt 模型

### 9.1 Job

Job 表示用户意图，包含：

- `job_id`
- 请求与执行策略；
- 当前状态和进度；
- 创建、开始、完成时间；
- 取消标记；
- 结果摘要；
- 分页 checkpoint；
- 可复制诊断 ID。

### 9.2 Attempt

每次 Provider 执行生成 Attempt：

- `attempt_id`
- `job_id`
- `provider_id` 与版本；
- 开始、结束和耗时；
- 状态与结构化错误码；
- 请求字段与返回字段；
- 身份证据摘要；
- 是否触发前台、远程或费用副作用；
- 安全过滤后的诊断信息。

### 9.3 公众号分页

Provider cursor 是不透明值，只能交还给产生它的同一 Provider 及兼容版本。规范 Coverage 另外记录：

- 已同步日期范围；
- 已处理页数和文章数；
- 内容类型覆盖；
- `exhausted`；
- 最近连续空页数；
- 最近成功 checkpoint。

App 重启后从成功 checkpoint 恢复，不重放已提交页面。

## 10. 数据模型

建议在现有 SQLite 上逐步加入：

```text
accounts
account_identities

articles
article_identities
article_content_versions
article_metric_snapshots

acquisition_jobs
provider_attempts
provider_health_snapshots
sync_checkpoints

collections
collection_items
analysis_runs
analysis_artifacts
monitor_subscriptions
```

### 10.1 Identity 表

外部 ID 与规范资源分离：

```text
provider_id + identity_type + external_id -> canonical_resource_id
```

保存身份来源、首次/最近观测时间、证据强度和冲突状态。

### 10.2 字段 provenance

互动快照可直接按快照记录 Provider。对于合并后的公众号和文章元数据，使用 observation 表或 JSON provenance 保存字段级来源，避免仅靠一个 `source_kind` 表达整行数据。

## 11. 前端契约

前端只认识：

- Capability；
- Job；
- 规范资源；
- Coverage；
- Provider 摘要和影响等级。

前端不得根据 `wechat_*` 字符串决定业务流程。Provider 特定信息只用于设置、诊断和来源说明。

建议的新命令：

```text
create_acquisition_job(request) -> Job
get_acquisition_job(job_id) -> Job
cancel_acquisition_job(job_id)
list_acquisition_jobs(filter) -> Job[]
list_providers() -> ProviderView[]
check_provider(provider_id) -> ProviderHealth
configure_provider(provider_id, config)
```

状态更新统一通过 `acquisition-job-updated` 事件推送。

## 12. 初始 Provider 映射

| Provider ID                 | 现有实现                     | 能力                       |
| --------------------------- | ---------------------------- | -------------------------- |
| `cache.article.local`       | `cache.db` 与已存正文        | 正文、元数据、既有列表     |
| `http.article.public`       | 普通 HTTP/浏览器 Header 获取 | 文章解析、正文             |
| `wcx.local`                 | 常驻 wcx sidecar             | 公众号解析、列表、正文     |
| `wechat.mp-backend`         | 当前登录公众号后台           | 自有文章列表、正文、互动   |
| `wechat.session-cache`      | 本机微信授权缓存             | 文章互动                   |
| `wechat.account-feed.local` | XWorker 公众号文章列表       | 公众号列表、文章互动       |
| `wechat.ui-automation`      | 微信窗口自动化               | 触发微信授权数据，最后降级 |
| `remote.*`                  | 未来第三方 API               | 由 Manifest 声明           |

现有 `public_metrics.rs` 可以先整体作为 Legacy Facade，被新 Orchestrator 当作一个 Provider 调用；待行为回归稳定后再拆成上表中的独立 Provider。

## 13. 安全模型

### 13.1 信任级别

- Built-in：随 App 签名发布，最高本地信任。
- Sidecar：需要安装来源、完整性校验和能力授权。
- Remote：需要用户显式启用并接受数据边界。

### 13.2 凭证

- Registry 只保存凭证引用，不保存明文。
- 凭证存入系统 Keychain 或既有安全存储。
- Provider 仅在执行相应 Capability 时获得最小凭证视图。
- 日志和 Attempt 永远不存储完整令牌。

### 13.3 Sidecar 权限

第一版至少区分：

- 网络访问；
- 微信数据目录只读；
- 指定工作目录读写；
- 前台辅助功能；
- 剪贴板；
- 远程数据发送。

## 14. 失败模式

| 失败                 | 影响              | 处理                                  |
| -------------------- | ----------------- | ------------------------------------- |
| Provider 崩溃        | 当前 Attempt 失败 | Sidecar 隔离，记录失败并降级          |
| Provider 协议不兼容  | 无法加载          | Registry 标记 incompatible，不启动    |
| 身份冲突             | 可能写错文章      | 拒绝自动合并，进入待确认              |
| 登录失效             | Provider 不可用   | `auth_required`，提供恢复动作         |
| 前台窗口未回收       | 打扰用户          | Provider 降级并记录副作用失败         |
| 分页 cursor 失效     | 同步中断          | 从最后规范 checkpoint 重新解析        |
| 远程限流             | 延迟或失败        | 尊重 Retry-After、熔断、切换 Provider |
| 多 Provider 字段冲突 | 数据不一致        | 保存各自观测，按权威性和时间展示      |
| App 异常退出         | 长任务中断        | 启动恢复 Job，不重复提交已完成页      |

## 15. 可测试性

### 15.1 Provider Contract Test Kit

所有 Provider 运行同一套契约测试：

- Manifest 与版本校验；
- Capability/字段声明和真实返回一致；
- 取消和超时；
- 敏感数据过滤；
- 身份证据完整性；
- partial、unavailable 和 zero 的区分；
- cursor 恢复与幂等；
- 前台和远程副作用声明准确。

### 15.2 固定基准集

Provider 评测必须使用版本化数据集，记录：

- 身份正确率；
- 成功率；
- 字段完整率；
- p50、p95；
- 前台干扰；
- 残留窗口；
- 人工操作；
- 成本和限流。

## 16. 运维复杂度控制

- 主体保持一个桌面应用和一个 SQLite 数据库。
- Job 执行器第一阶段在本地进程内运行，不引入 Kafka、Redis 或云队列。
- Sidecar 只用于语言隔离、崩溃隔离和独立迭代。
- Remote Provider 通过普通 HTTP 接入，不把核心产品迁移到云端。
- 只有在真实并发和团队规模证明需要时，才考虑拆分远程服务。
