use std::{collections::HashMap, sync::Arc};

use super::model::{
    AcquisitionRequest, CapabilityId, ProviderManifest, ProviderResult, PROVIDER_API_VERSION,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl ProviderError {
    pub fn permanent(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
        }
    }
}

pub trait AcquisitionProvider: Send + Sync {
    fn manifest(&self) -> ProviderManifest;

    fn execute(
        &self,
        request: &AcquisitionRequest,
    ) -> std::result::Result<ProviderResult, ProviderError>;
}

#[derive(Default)]
pub struct ProviderRegistry {
    providers: HashMap<String, Arc<dyn AcquisitionProvider>>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(
        &mut self,
        provider: Arc<dyn AcquisitionProvider>,
    ) -> std::result::Result<(), String> {
        let manifest = provider.manifest();
        validate_manifest(&manifest)?;
        if self.providers.contains_key(&manifest.id) {
            return Err(format!("Provider ID 重复：{}", manifest.id));
        }
        self.providers.insert(manifest.id, provider);
        Ok(())
    }

    pub fn resolve(
        &self,
        provider_id: &str,
        capability: CapabilityId,
    ) -> std::result::Result<Arc<dyn AcquisitionProvider>, String> {
        let provider = self
            .providers
            .get(provider_id)
            .cloned()
            .ok_or_else(|| format!("Provider 不存在：{provider_id}"))?;
        let manifest = provider.manifest();
        if !manifest.supports(capability) {
            return Err(format!(
                "Provider {} 不支持 {}",
                manifest.id,
                capability.as_str()
            ));
        }
        Ok(provider)
    }

    pub fn manifests(&self) -> Vec<ProviderManifest> {
        let mut manifests = self
            .providers
            .values()
            .map(|provider| provider.manifest())
            .collect::<Vec<_>>();
        manifests.sort_by(|left, right| left.id.cmp(&right.id));
        manifests
    }
}

fn validate_manifest(manifest: &ProviderManifest) -> std::result::Result<(), String> {
    if manifest.id.trim().is_empty() {
        return Err("Provider ID 不能为空".to_string());
    }
    if manifest.api_version != PROVIDER_API_VERSION {
        return Err(format!(
            "Provider {} 的 API 版本 {} 与当前版本 {} 不兼容",
            manifest.id, manifest.api_version, PROVIDER_API_VERSION
        ));
    }
    if manifest.capabilities.is_empty() {
        return Err(format!("Provider {} 未声明任何能力", manifest.id));
    }
    if manifest.max_concurrency == 0 {
        return Err(format!("Provider {} 的并发上限必须大于 0", manifest.id));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::acquisition::model::{
        ProviderCapability, ProviderDataBoundary, ProviderExecutionMode, ProviderResultStatus,
    };

    struct FakeProvider {
        id: &'static str,
    }

    impl AcquisitionProvider for FakeProvider {
        fn manifest(&self) -> ProviderManifest {
            ProviderManifest {
                id: self.id.to_string(),
                name: "Fake".to_string(),
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
            Ok(ProviderResult {
                provider_id: self.id.to_string(),
                status: ProviderResultStatus::Complete,
                observed_at: 1,
                payload: json!({ "kind": "test" }),
                returned_fields: vec!["read".to_string()],
                diagnostics: None,
            })
        }
    }

    #[test]
    fn registry_rejects_duplicate_ids_and_capability_mismatches() {
        let mut registry = ProviderRegistry::new();
        registry
            .register(Arc::new(FakeProvider { id: "fake.metrics" }))
            .unwrap();

        assert!(registry
            .register(Arc::new(FakeProvider { id: "fake.metrics" }))
            .unwrap_err()
            .contains("重复"));
        assert!(registry
            .resolve("fake.metrics", CapabilityId::ArticleMetricsFetch)
            .is_ok());
        assert!(registry
            .resolve("fake.metrics", CapabilityId::ArticleContentFetch)
            .err()
            .expect("capability mismatch")
            .contains("不支持"));
    }
}
