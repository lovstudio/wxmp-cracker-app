use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROVIDER_API_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub enum CapabilityId {
    #[serde(rename = "article.resolve")]
    ArticleResolve,
    #[serde(rename = "article.content.fetch")]
    ArticleContentFetch,
    #[serde(rename = "article.metrics.fetch")]
    ArticleMetricsFetch,
    #[serde(rename = "account.resolve")]
    AccountResolve,
    #[serde(rename = "account.articles.list")]
    AccountArticlesList,
}

impl CapabilityId {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ArticleResolve => "article.resolve",
            Self::ArticleContentFetch => "article.content.fetch",
            Self::ArticleMetricsFetch => "article.metrics.fetch",
            Self::AccountResolve => "account.resolve",
            Self::AccountArticlesList => "account.articles.list",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "article.resolve" => Some(Self::ArticleResolve),
            "article.content.fetch" => Some(Self::ArticleContentFetch),
            "article.metrics.fetch" => Some(Self::ArticleMetricsFetch),
            "account.resolve" => Some(Self::AccountResolve),
            "account.articles.list" => Some(Self::AccountArticlesList),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderExecutionMode {
    Builtin,
    Sidecar,
    Remote,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderSideEffect {
    ForegroundWindow,
    Clipboard,
    RemoteDataTransfer,
    PaidRequest,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderDataBoundary {
    LocalOnly,
    RemoteProcessing,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderCapability {
    pub id: CapabilityId,
    pub fields: Vec<String>,
    pub pagination: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderManifest {
    pub id: String,
    pub name: String,
    pub provider_version: String,
    pub api_version: u32,
    pub execution_mode: ProviderExecutionMode,
    pub capabilities: Vec<ProviderCapability>,
    pub requirements: Vec<String>,
    pub side_effects: Vec<ProviderSideEffect>,
    pub data_boundary: ProviderDataBoundary,
    pub max_concurrency: u32,
    pub supports_cancellation: bool,
}

impl ProviderManifest {
    pub fn supports(&self, capability: CapabilityId) -> bool {
        self.capabilities
            .iter()
            .any(|candidate| candidate.id == capability)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct AcquisitionRequest {
    pub api_version: u32,
    pub capability: CapabilityId,
    pub resource_key: String,
    pub input: Value,
    pub requested_provider_id: Option<String>,
}

impl AcquisitionRequest {
    pub fn article_metrics(aid: &str) -> Self {
        Self {
            api_version: PROVIDER_API_VERSION,
            capability: CapabilityId::ArticleMetricsFetch,
            resource_key: aid.to_string(),
            input: serde_json::json!({ "aid": aid }),
            requested_provider_id: Some("legacy.article-metrics".to_string()),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderResultStatus {
    Complete,
    Partial,
    Unavailable,
    Blocked,
    RetryableFailure,
    PermanentFailure,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ProviderResult {
    pub provider_id: String,
    pub status: ProviderResultStatus,
    pub observed_at: i64,
    pub payload: Value,
    pub returned_fields: Vec<String>,
    pub diagnostics: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AcquisitionJobStatus {
    Queued,
    Running,
    WaitingUser,
    Completed,
    Partial,
    Failed,
    Cancelled,
}

impl AcquisitionJobStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::WaitingUser => "waiting_user",
            Self::Completed => "completed",
            Self::Partial => "partial",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "queued" => Some(Self::Queued),
            "running" => Some(Self::Running),
            "waiting_user" => Some(Self::WaitingUser),
            "completed" => Some(Self::Completed),
            "partial" => Some(Self::Partial),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }

    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Partial | Self::Failed | Self::Cancelled
        )
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct AcquisitionJob {
    pub job_id: String,
    pub capability: CapabilityId,
    pub resource_key: String,
    pub requested_provider_id: Option<String>,
    pub selected_provider_id: Option<String>,
    pub status: AcquisitionJobStatus,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub result: Option<Value>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub diagnostic_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAttemptStatus {
    Running,
    Completed,
    Partial,
    Failed,
}

impl ProviderAttemptStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Partial => "partial",
            Self::Failed => "failed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "running" => Some(Self::Running),
            "completed" => Some(Self::Completed),
            "partial" => Some(Self::Partial),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ProviderAttempt {
    pub attempt_id: String,
    pub job_id: String,
    pub provider_id: String,
    pub provider_version: String,
    pub status: ProviderAttemptStatus,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub returned_fields: Vec<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_serializes_to_the_stable_wire_identifier() {
        assert_eq!(
            serde_json::to_string(&CapabilityId::ArticleMetricsFetch).unwrap(),
            "\"article.metrics.fetch\""
        );
        assert_eq!(
            CapabilityId::parse("account.articles.list"),
            Some(CapabilityId::AccountArticlesList)
        );
        assert_eq!(CapabilityId::parse("wechat.account-feed"), None);
    }

    #[test]
    fn provider_manifest_declares_capability_without_leaking_routing() {
        let manifest = ProviderManifest {
            id: "test.metrics".to_string(),
            name: "Test".to_string(),
            provider_version: "1.0.0".to_string(),
            api_version: PROVIDER_API_VERSION,
            execution_mode: ProviderExecutionMode::Builtin,
            capabilities: vec![ProviderCapability {
                id: CapabilityId::ArticleMetricsFetch,
                fields: vec!["read".to_string()],
                pagination: None,
            }],
            requirements: Vec::new(),
            side_effects: Vec::new(),
            data_boundary: ProviderDataBoundary::LocalOnly,
            max_concurrency: 1,
            supports_cancellation: false,
        };

        assert!(manifest.supports(CapabilityId::ArticleMetricsFetch));
        assert!(!manifest.supports(CapabilityId::ArticleContentFetch));
    }
}
