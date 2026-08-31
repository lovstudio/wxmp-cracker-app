use crate::{
    acquisition::{
        model::{
            AcquisitionRequest, CapabilityId, ProviderCapability, ProviderDataBoundary,
            ProviderExecutionMode, ProviderManifest, ProviderResult, ProviderResultStatus,
            ProviderSideEffect, PROVIDER_API_VERSION,
        },
        provider::{AcquisitionProvider, ProviderError},
    },
    commands::CmdError,
    public_metrics::{self, ArticlePublicMetricsSnapshot},
};

pub const PROVIDER_ID: &str = "legacy.article-metrics";

type CaptureArticleMetrics = fn(&str) -> Result<ArticlePublicMetricsSnapshot, CmdError>;

pub struct LegacyArticleMetricsProvider {
    capture: CaptureArticleMetrics,
}

impl LegacyArticleMetricsProvider {
    pub fn new() -> Self {
        Self {
            capture: public_metrics::capture_and_store_for_provider,
        }
    }

    #[cfg(test)]
    fn with_capture(capture: CaptureArticleMetrics) -> Self {
        Self { capture }
    }
}

impl AcquisitionProvider for LegacyArticleMetricsProvider {
    fn manifest(&self) -> ProviderManifest {
        ProviderManifest {
            id: PROVIDER_ID.to_string(),
            name: "现有文章互动数据链".to_string(),
            provider_version: env!("CARGO_PKG_VERSION").to_string(),
            api_version: PROVIDER_API_VERSION,
            execution_mode: ProviderExecutionMode::Builtin,
            capabilities: vec![ProviderCapability {
                id: CapabilityId::ArticleMetricsFetch,
                fields: vec![
                    "read".to_string(),
                    "like".to_string(),
                    "recommend".to_string(),
                    "share".to_string(),
                    "comment".to_string(),
                    "collect".to_string(),
                ],
                pagination: None,
            }],
            requirements: vec!["existing_metrics_runtime".to_string()],
            // The legacy chain may select a pure cache/backend path or fall
            // back to WeChat UI. Until it is split into independent providers,
            // its Manifest must declare the strongest possible side effect.
            side_effects: vec![ProviderSideEffect::ForegroundWindow],
            data_boundary: ProviderDataBoundary::LocalOnly,
            max_concurrency: 1,
            supports_cancellation: false,
        }
    }

    fn execute(
        &self,
        request: &AcquisitionRequest,
    ) -> std::result::Result<ProviderResult, ProviderError> {
        if request.capability != CapabilityId::ArticleMetricsFetch {
            return Err(ProviderError::permanent(
                "provider.capability_unsupported",
                format!("{} 不支持 {}", PROVIDER_ID, request.capability.as_str()),
            ));
        }
        let aid = request
            .input
            .get("aid")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ProviderError::permanent("request.invalid_aid", "缺少文章 ID"))?;

        let snapshot = (self.capture)(aid).map_err(|error| {
            ProviderError::permanent("legacy.article_metrics.failed", error.message)
        })?;
        let observed_at = snapshot.captured_at;
        let mut returned_fields = Vec::new();
        for (name, present) in [
            ("read", snapshot.read_count.is_some()),
            ("like", snapshot.like_count.is_some()),
            ("recommend", snapshot.recommend_count.is_some()),
            ("share", snapshot.share_count.is_some()),
            ("comment", snapshot.comment_count.is_some()),
            ("collect", snapshot.collect_count.is_some()),
        ] {
            if present {
                returned_fields.push(name.to_string());
            }
        }
        let payload = serde_json::json!({
            "kind": "article_metrics",
            "data": snapshot,
        });

        Ok(ProviderResult {
            provider_id: PROVIDER_ID.to_string(),
            status: ProviderResultStatus::Complete,
            observed_at,
            payload,
            returned_fields,
            diagnostics: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Instant};

    use super::*;
    use crate::acquisition::{
        model::{AcquisitionJobStatus, ProviderAttemptStatus},
        orchestrator::AcquisitionOrchestrator,
        provider::ProviderRegistry,
        repository::AcquisitionRepository,
    };

    fn fixture_capture(aid: &str) -> Result<ArticlePublicMetricsSnapshot, CmdError> {
        Ok(ArticlePublicMetricsSnapshot {
            id: 42,
            aid: aid.to_string(),
            source_url: "https://mp.weixin.qq.com/s/example".to_string(),
            source_kind: "wechat_account_feed".to_string(),
            capture_method: "wechat_account_feed_batch".to_string(),
            captured_at: 1_788_000_000,
            status: "visible".to_string(),
            read_count: Some(123),
            like_count: Some(12),
            recommend_count: Some(3),
            share_count: Some(8),
            comment_count: Some(1),
            collect_count: Some(6),
            note: None,
        })
    }

    #[test]
    fn legacy_provider_manifest_declares_the_widest_real_side_effect() {
        let manifest = LegacyArticleMetricsProvider::new().manifest();

        assert_eq!(manifest.id, PROVIDER_ID);
        assert!(manifest.supports(CapabilityId::ArticleMetricsFetch));
        assert_eq!(manifest.execution_mode, ProviderExecutionMode::Builtin);
        assert!(manifest
            .side_effects
            .contains(&ProviderSideEffect::ForegroundWindow));
        assert!(!manifest.supports_cancellation);
    }

    #[test]
    fn legacy_provider_preserves_the_existing_snapshot_through_a_job() {
        let temp = tempfile::tempdir().unwrap();
        let repository = AcquisitionRepository::open(temp.path().join("acquisition.db")).unwrap();
        let mut registry = ProviderRegistry::new();
        registry
            .register(Arc::new(LegacyArticleMetricsProvider::with_capture(
                fixture_capture,
            )))
            .unwrap();
        let orchestrator = AcquisitionOrchestrator::new(&repository, &registry);
        let request = AcquisitionRequest::article_metrics("article-42");

        let queued = orchestrator.create_job(&request).unwrap();
        let completed = orchestrator.run_job(&queued.job_id, &request).unwrap();

        assert_eq!(completed.status, AcquisitionJobStatus::Completed);
        assert_eq!(
            completed
                .result
                .as_ref()
                .and_then(|result| result.pointer("/data/aid"))
                .and_then(serde_json::Value::as_str),
            Some("article-42")
        );
        assert_eq!(
            completed
                .result
                .as_ref()
                .and_then(|result| result.pointer("/data/read_count"))
                .and_then(serde_json::Value::as_i64),
            Some(123)
        );
        let attempts = repository.list_attempts(&queued.job_id).unwrap();
        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0].status, ProviderAttemptStatus::Completed);
        assert_eq!(
            attempts[0].returned_fields,
            vec!["read", "like", "recommend", "share", "comment", "collect"]
        );
    }

    #[test]
    #[ignore = "requires an owned article and a current authenticated mp.weixin.qq.com backend session"]
    fn live_legacy_provider_runs_the_real_backend_through_a_job() {
        let aid = std::env::var("WXMP_TEST_ARTICLE_AID")
            .expect("set WXMP_TEST_ARTICLE_AID to an owned article id");
        let temp = tempfile::tempdir().unwrap();
        let repository = AcquisitionRepository::open(temp.path().join("acquisition.db")).unwrap();
        let mut registry = ProviderRegistry::new();
        registry
            .register(Arc::new(LegacyArticleMetricsProvider::new()))
            .unwrap();
        let orchestrator = AcquisitionOrchestrator::new(&repository, &registry);
        let request = AcquisitionRequest::article_metrics(&aid);
        let queued = orchestrator.create_job(&request).unwrap();
        let started = Instant::now();

        let completed = orchestrator.run_job(&queued.job_id, &request).unwrap();

        assert_eq!(completed.status, AcquisitionJobStatus::Completed);
        assert_eq!(
            completed
                .result
                .as_ref()
                .and_then(|result| result.pointer("/data/aid"))
                .and_then(serde_json::Value::as_str),
            Some(aid.as_str())
        );
        assert_eq!(
            completed
                .result
                .as_ref()
                .and_then(|result| result.pointer("/data/source_kind"))
                .and_then(serde_json::Value::as_str),
            Some("wechat_mp_backend")
        );
        assert!(completed
            .result
            .as_ref()
            .and_then(|result| result.pointer("/data/read_count"))
            .and_then(serde_json::Value::as_i64)
            .is_some());
        eprintln!(
            "live acquisition job: job_id={} diagnostic_id={} elapsed_ms={} source=wechat_mp_backend",
            completed.job_id,
            completed.diagnostic_id,
            started.elapsed().as_millis()
        );
    }
}
