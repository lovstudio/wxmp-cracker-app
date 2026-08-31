use anyhow::{anyhow, Result};

use super::{
    model::{
        AcquisitionJob, AcquisitionJobStatus, AcquisitionRequest, ProviderAttemptStatus,
        ProviderResultStatus, PROVIDER_API_VERSION,
    },
    provider::ProviderRegistry,
    repository::AcquisitionRepository,
};

pub struct AcquisitionOrchestrator<'a> {
    repository: &'a AcquisitionRepository,
    registry: &'a ProviderRegistry,
}

impl<'a> AcquisitionOrchestrator<'a> {
    pub fn new(repository: &'a AcquisitionRepository, registry: &'a ProviderRegistry) -> Self {
        Self {
            repository,
            registry,
        }
    }

    pub fn create_job(&self, request: &AcquisitionRequest) -> Result<AcquisitionJob> {
        validate_request(request)?;
        self.repository.create_job(request)
    }

    #[cfg(test)]
    pub fn run_job(&self, job_id: &str, request: &AcquisitionRequest) -> Result<AcquisitionJob> {
        self.run_job_with_observer(job_id, request, |_| {})
    }

    pub fn run_job_with_observer<F>(
        &self,
        job_id: &str,
        request: &AcquisitionRequest,
        mut observer: F,
    ) -> Result<AcquisitionJob>
    where
        F: FnMut(&AcquisitionJob),
    {
        validate_request(request)?;
        let provider_id = request
            .requested_provider_id
            .as_deref()
            .ok_or_else(|| anyhow!("阶段 1 需要明确指定 Provider"))?;
        let provider = match self.registry.resolve(provider_id, request.capability) {
            Ok(provider) => provider,
            Err(message) => {
                let failed = self.repository.fail_job(
                    job_id,
                    Some(provider_id),
                    "orchestrator.provider_unavailable",
                    &message,
                )?;
                observer(&failed);
                return Ok(failed);
            }
        };
        let manifest = provider.manifest();
        let running = self.repository.mark_job_running(job_id, &manifest.id)?;
        observer(&running);
        let attempt =
            self.repository
                .start_attempt(job_id, &manifest.id, &manifest.provider_version)?;

        let terminal = match provider.execute(request) {
            Ok(result) => {
                if result.provider_id != manifest.id {
                    let message = format!(
                        "Provider 结果身份不一致：expected={} actual={}",
                        manifest.id, result.provider_id
                    );
                    self.repository.fail_attempt(
                        &attempt.attempt_id,
                        "provider.identity_mismatch",
                        &message,
                    )?;
                    self.repository.fail_job(
                        job_id,
                        Some(&manifest.id),
                        "provider.identity_mismatch",
                        &message,
                    )?
                } else {
                    match result.status {
                        ProviderResultStatus::Complete => {
                            self.repository.complete_attempt(
                                &attempt.attempt_id,
                                ProviderAttemptStatus::Completed,
                                &result.returned_fields,
                            )?;
                            self.repository.complete_job(
                                job_id,
                                &manifest.id,
                                AcquisitionJobStatus::Completed,
                                &result.payload,
                            )?
                        }
                        ProviderResultStatus::Partial => {
                            self.repository.complete_attempt(
                                &attempt.attempt_id,
                                ProviderAttemptStatus::Partial,
                                &result.returned_fields,
                            )?;
                            self.repository.complete_job(
                                job_id,
                                &manifest.id,
                                AcquisitionJobStatus::Partial,
                                &result.payload,
                            )?
                        }
                        failure_status => {
                            let code = provider_status_error_code(failure_status);
                            let message = result
                                .diagnostics
                                .as_deref()
                                .unwrap_or("Provider 未返回可用数据");
                            self.repository
                                .fail_attempt(&attempt.attempt_id, code, message)?;
                            self.repository
                                .fail_job(job_id, Some(&manifest.id), code, message)?
                        }
                    }
                }
            }
            Err(error) => {
                self.repository
                    .fail_attempt(&attempt.attempt_id, &error.code, &error.message)?;
                self.repository
                    .fail_job(job_id, Some(&manifest.id), &error.code, &error.message)?
            }
        };
        debug_assert!(terminal.status.is_terminal());
        observer(&terminal);
        Ok(terminal)
    }
}

fn validate_request(request: &AcquisitionRequest) -> Result<()> {
    if request.api_version != PROVIDER_API_VERSION {
        return Err(anyhow!(
            "采集请求 API 版本 {} 与当前版本 {} 不兼容",
            request.api_version,
            PROVIDER_API_VERSION
        ));
    }
    if request.resource_key.trim().is_empty() {
        return Err(anyhow!("采集资源标识不能为空"));
    }
    Ok(())
}

fn provider_status_error_code(status: ProviderResultStatus) -> &'static str {
    match status {
        ProviderResultStatus::Unavailable => "provider.unavailable",
        ProviderResultStatus::Blocked => "provider.blocked",
        ProviderResultStatus::RetryableFailure => "provider.retryable_failure",
        ProviderResultStatus::PermanentFailure => "provider.permanent_failure",
        ProviderResultStatus::Complete | ProviderResultStatus::Partial => {
            "provider.unexpected_status"
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::acquisition::{
        model::{
            CapabilityId, ProviderCapability, ProviderDataBoundary, ProviderExecutionMode,
            ProviderManifest, ProviderResult,
        },
        provider::{AcquisitionProvider, ProviderError},
    };

    struct FakeMetricsProvider {
        fail: bool,
    }

    impl AcquisitionProvider for FakeMetricsProvider {
        fn manifest(&self) -> ProviderManifest {
            ProviderManifest {
                id: "fake.metrics".to_string(),
                name: "Fake metrics".to_string(),
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
            }
        }

        fn execute(
            &self,
            _request: &AcquisitionRequest,
        ) -> std::result::Result<ProviderResult, ProviderError> {
            if self.fail {
                return Err(ProviderError::permanent(
                    "fake.failed",
                    "expected provider failure",
                ));
            }
            Ok(ProviderResult {
                provider_id: "fake.metrics".to_string(),
                status: ProviderResultStatus::Complete,
                observed_at: 1,
                payload: json!({
                    "kind": "article_metrics",
                    "data": { "aid": "article-1", "read_count": 88 }
                }),
                returned_fields: vec!["read".to_string()],
                diagnostics: None,
            })
        }
    }

    fn request() -> AcquisitionRequest {
        let mut request = AcquisitionRequest::article_metrics("article-1");
        request.requested_provider_id = Some("fake.metrics".to_string());
        request
    }

    #[test]
    fn orchestrator_records_a_successful_provider_attempt() {
        let temp = tempfile::tempdir().unwrap();
        let repository = AcquisitionRepository::open(temp.path().join("acquisition.db")).unwrap();
        let mut registry = ProviderRegistry::new();
        registry
            .register(Arc::new(FakeMetricsProvider { fail: false }))
            .unwrap();
        let orchestrator = AcquisitionOrchestrator::new(&repository, &registry);
        let request = request();
        let queued = orchestrator.create_job(&request).unwrap();
        let completed = orchestrator.run_job(&queued.job_id, &request).unwrap();

        assert_eq!(completed.status, AcquisitionJobStatus::Completed);
        assert_eq!(
            completed.selected_provider_id.as_deref(),
            Some("fake.metrics")
        );
        assert_eq!(
            repository.list_attempts(&queued.job_id).unwrap()[0].status,
            ProviderAttemptStatus::Completed
        );
    }

    #[test]
    fn provider_failure_is_isolated_to_an_attempt_and_terminal_job() {
        let temp = tempfile::tempdir().unwrap();
        let repository = AcquisitionRepository::open(temp.path().join("acquisition.db")).unwrap();
        let mut registry = ProviderRegistry::new();
        registry
            .register(Arc::new(FakeMetricsProvider { fail: true }))
            .unwrap();
        let orchestrator = AcquisitionOrchestrator::new(&repository, &registry);
        let request = request();
        let queued = orchestrator.create_job(&request).unwrap();
        let failed = orchestrator.run_job(&queued.job_id, &request).unwrap();

        assert_eq!(failed.status, AcquisitionJobStatus::Failed);
        assert_eq!(failed.error_code.as_deref(), Some("fake.failed"));
        assert_eq!(
            repository.list_attempts(&queued.job_id).unwrap()[0].status,
            ProviderAttemptStatus::Failed
        );
    }
}
