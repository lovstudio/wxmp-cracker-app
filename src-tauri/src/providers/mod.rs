mod legacy_article_metrics;

use std::sync::Arc;

use crate::acquisition::provider::ProviderRegistry;

pub fn default_registry() -> Result<ProviderRegistry, String> {
    let mut registry = ProviderRegistry::new();
    registry.register(Arc::new(
        legacy_article_metrics::LegacyArticleMetricsProvider::new(),
    ))?;
    Ok(registry)
}
