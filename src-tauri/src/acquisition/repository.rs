use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;

use super::model::{
    AcquisitionJob, AcquisitionJobStatus, AcquisitionRequest, CapabilityId, ProviderAttempt,
    ProviderAttemptStatus,
};

static NEXT_LOCAL_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
pub struct AcquisitionRepository {
    path: PathBuf,
}

impl AcquisitionRepository {
    pub fn open_default() -> Result<Self> {
        let base = dirs::data_dir().context("no data dir")?;
        Self::open(base.join("wcx").join("acquisition.db"))
    }

    pub fn open(path: impl Into<PathBuf>) -> Result<Self> {
        let repository = Self { path: path.into() };
        if let Some(parent) = repository.path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("mkdir {}", parent.display()))?;
        }
        let connection = repository.connection()?;
        ensure_schema(&connection)?;
        Ok(repository)
    }

    #[cfg(test)]
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    pub fn create_job(&self, request: &AcquisitionRequest) -> Result<AcquisitionJob> {
        let job_id = new_local_id("job");
        let created_at = unix_millis();
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO acquisition_jobs (
                 job_id, capability, resource_key, requested_provider_id,
                 status, created_at, diagnostic_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                job_id,
                request.capability.as_str(),
                request.resource_key,
                request.requested_provider_id,
                AcquisitionJobStatus::Queued.as_str(),
                created_at,
                job_id,
            ],
        )?;
        self.get_job(&job_id)?
            .ok_or_else(|| anyhow!("new acquisition job disappeared: {job_id}"))
    }

    pub fn get_job(&self, job_id: &str) -> Result<Option<AcquisitionJob>> {
        let connection = self.connection()?;
        let raw = connection
            .query_row(
                "SELECT job_id, capability, resource_key, requested_provider_id,
                        selected_provider_id, status, created_at, started_at,
                        completed_at, result_json, error_code, error_message,
                        diagnostic_id
                 FROM acquisition_jobs
                 WHERE job_id = ?1",
                [job_id],
                raw_job_from_row,
            )
            .optional()?;
        raw.map(RawJob::into_job).transpose()
    }

    pub fn mark_job_running(&self, job_id: &str, provider_id: &str) -> Result<AcquisitionJob> {
        let connection = self.connection()?;
        let changed = connection.execute(
            "UPDATE acquisition_jobs
             SET status = ?2,
                 selected_provider_id = ?3,
                 started_at = COALESCE(started_at, ?4),
                 error_code = NULL,
                 error_message = NULL
             WHERE job_id = ?1 AND status = ?5",
            params![
                job_id,
                AcquisitionJobStatus::Running.as_str(),
                provider_id,
                unix_millis(),
                AcquisitionJobStatus::Queued.as_str(),
            ],
        )?;
        if changed != 1 {
            return Err(anyhow!("job {job_id} is not queued"));
        }
        self.require_job(job_id)
    }

    pub fn complete_job(
        &self,
        job_id: &str,
        provider_id: &str,
        status: AcquisitionJobStatus,
        result: &Value,
    ) -> Result<AcquisitionJob> {
        if !matches!(
            status,
            AcquisitionJobStatus::Completed | AcquisitionJobStatus::Partial
        ) {
            return Err(anyhow!("invalid successful job status: {status:?}"));
        }
        let result_json = serde_json::to_string(result)?;
        let connection = self.connection()?;
        let changed = connection.execute(
            "UPDATE acquisition_jobs
             SET status = ?2,
                 selected_provider_id = ?3,
                 completed_at = ?4,
                 result_json = ?5,
                 error_code = NULL,
                 error_message = NULL
             WHERE job_id = ?1 AND status = ?6",
            params![
                job_id,
                status.as_str(),
                provider_id,
                unix_millis(),
                result_json,
                AcquisitionJobStatus::Running.as_str(),
            ],
        )?;
        if changed != 1 {
            return Err(anyhow!("job {job_id} is not running"));
        }
        self.require_job(job_id)
    }

    pub fn fail_job(
        &self,
        job_id: &str,
        provider_id: Option<&str>,
        error_code: &str,
        error_message: &str,
    ) -> Result<AcquisitionJob> {
        let connection = self.connection()?;
        let changed = connection.execute(
            "UPDATE acquisition_jobs
             SET status = ?2,
                 selected_provider_id = COALESCE(?3, selected_provider_id),
                 completed_at = ?4,
                 result_json = NULL,
                 error_code = ?5,
                 error_message = ?6
             WHERE job_id = ?1 AND status IN (?7, ?8)",
            params![
                job_id,
                AcquisitionJobStatus::Failed.as_str(),
                provider_id,
                unix_millis(),
                error_code,
                error_message,
                AcquisitionJobStatus::Queued.as_str(),
                AcquisitionJobStatus::Running.as_str(),
            ],
        )?;
        if changed != 1 {
            return Err(anyhow!("job {job_id} cannot transition to failed"));
        }
        self.require_job(job_id)
    }

    pub fn start_attempt(
        &self,
        job_id: &str,
        provider_id: &str,
        provider_version: &str,
    ) -> Result<ProviderAttempt> {
        let attempt_id = new_local_id("attempt");
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO provider_attempts (
                 attempt_id, job_id, provider_id, provider_version,
                 status, started_at, returned_fields_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]')",
            params![
                attempt_id,
                job_id,
                provider_id,
                provider_version,
                ProviderAttemptStatus::Running.as_str(),
                unix_millis(),
            ],
        )?;
        self.require_attempt(&attempt_id)
    }

    pub fn complete_attempt(
        &self,
        attempt_id: &str,
        status: ProviderAttemptStatus,
        returned_fields: &[String],
    ) -> Result<ProviderAttempt> {
        if !matches!(
            status,
            ProviderAttemptStatus::Completed | ProviderAttemptStatus::Partial
        ) {
            return Err(anyhow!("invalid successful attempt status: {status:?}"));
        }
        let completed_at = unix_millis();
        let fields_json = serde_json::to_string(returned_fields)?;
        let connection = self.connection()?;
        let changed = connection.execute(
            "UPDATE provider_attempts
             SET status = ?2,
                 completed_at = ?3,
                 duration_ms = MAX(0, ?3 - started_at),
                 returned_fields_json = ?4,
                 error_code = NULL,
                 error_message = NULL
             WHERE attempt_id = ?1 AND status = ?5",
            params![
                attempt_id,
                status.as_str(),
                completed_at,
                fields_json,
                ProviderAttemptStatus::Running.as_str(),
            ],
        )?;
        if changed != 1 {
            return Err(anyhow!("attempt {attempt_id} is not running"));
        }
        self.require_attempt(attempt_id)
    }

    pub fn fail_attempt(
        &self,
        attempt_id: &str,
        error_code: &str,
        error_message: &str,
    ) -> Result<ProviderAttempt> {
        let completed_at = unix_millis();
        let connection = self.connection()?;
        let changed = connection.execute(
            "UPDATE provider_attempts
             SET status = ?2,
                 completed_at = ?3,
                 duration_ms = MAX(0, ?3 - started_at),
                 error_code = ?4,
                 error_message = ?5
             WHERE attempt_id = ?1 AND status = ?6",
            params![
                attempt_id,
                ProviderAttemptStatus::Failed.as_str(),
                completed_at,
                error_code,
                error_message,
                ProviderAttemptStatus::Running.as_str(),
            ],
        )?;
        if changed != 1 {
            return Err(anyhow!("attempt {attempt_id} is not running"));
        }
        self.require_attempt(attempt_id)
    }

    pub fn list_attempts(&self, job_id: &str) -> Result<Vec<ProviderAttempt>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT attempt_id, job_id, provider_id, provider_version, status,
                    started_at, completed_at, duration_ms, returned_fields_json,
                    error_code, error_message
             FROM provider_attempts
             WHERE job_id = ?1
             ORDER BY started_at ASC, attempt_id ASC",
        )?;
        let raw = statement
            .query_map([job_id], raw_attempt_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        raw.into_iter().map(RawAttempt::into_attempt).collect()
    }

    fn require_job(&self, job_id: &str) -> Result<AcquisitionJob> {
        self.get_job(job_id)?
            .ok_or_else(|| anyhow!("acquisition job not found: {job_id}"))
    }

    fn require_attempt(&self, attempt_id: &str) -> Result<ProviderAttempt> {
        let connection = self.connection()?;
        let raw = connection
            .query_row(
                "SELECT attempt_id, job_id, provider_id, provider_version, status,
                        started_at, completed_at, duration_ms, returned_fields_json,
                        error_code, error_message
                 FROM provider_attempts
                 WHERE attempt_id = ?1",
                [attempt_id],
                raw_attempt_from_row,
            )
            .optional()?;
        raw.ok_or_else(|| anyhow!("provider attempt not found: {attempt_id}"))?
            .into_attempt()
    }

    fn connection(&self) -> Result<Connection> {
        let connection = Connection::open(&self.path)
            .with_context(|| format!("open {}", self.path.display()))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        Ok(connection)
    }
}

fn ensure_schema(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS acquisition_jobs (
             job_id TEXT PRIMARY KEY,
             capability TEXT NOT NULL,
             resource_key TEXT NOT NULL,
             requested_provider_id TEXT,
             selected_provider_id TEXT,
             status TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             started_at INTEGER,
             completed_at INTEGER,
             result_json TEXT,
             error_code TEXT,
             error_message TEXT,
             diagnostic_id TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_acquisition_jobs_created
             ON acquisition_jobs(created_at DESC);
         CREATE INDEX IF NOT EXISTS idx_acquisition_jobs_resource
             ON acquisition_jobs(capability, resource_key, created_at DESC);

         CREATE TABLE IF NOT EXISTS provider_attempts (
             attempt_id TEXT PRIMARY KEY,
             job_id TEXT NOT NULL,
             provider_id TEXT NOT NULL,
             provider_version TEXT NOT NULL,
             status TEXT NOT NULL,
             started_at INTEGER NOT NULL,
             completed_at INTEGER,
             duration_ms INTEGER,
             returned_fields_json TEXT NOT NULL DEFAULT '[]',
             error_code TEXT,
             error_message TEXT,
             FOREIGN KEY (job_id) REFERENCES acquisition_jobs(job_id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_provider_attempts_job
             ON provider_attempts(job_id, started_at ASC);",
    )?;
    Ok(())
}

struct RawJob {
    job_id: String,
    capability: String,
    resource_key: String,
    requested_provider_id: Option<String>,
    selected_provider_id: Option<String>,
    status: String,
    created_at: i64,
    started_at: Option<i64>,
    completed_at: Option<i64>,
    result_json: Option<String>,
    error_code: Option<String>,
    error_message: Option<String>,
    diagnostic_id: String,
}

impl RawJob {
    fn into_job(self) -> Result<AcquisitionJob> {
        let capability = CapabilityId::parse(&self.capability)
            .ok_or_else(|| anyhow!("unknown acquisition capability: {}", self.capability))?;
        let status = AcquisitionJobStatus::parse(&self.status)
            .ok_or_else(|| anyhow!("unknown acquisition job status: {}", self.status))?;
        let result = self
            .result_json
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .context("parse acquisition job result")?;
        Ok(AcquisitionJob {
            job_id: self.job_id,
            capability,
            resource_key: self.resource_key,
            requested_provider_id: self.requested_provider_id,
            selected_provider_id: self.selected_provider_id,
            status,
            created_at: self.created_at,
            started_at: self.started_at,
            completed_at: self.completed_at,
            result,
            error_code: self.error_code,
            error_message: self.error_message,
            diagnostic_id: self.diagnostic_id,
        })
    }
}

fn raw_job_from_row(row: &Row<'_>) -> rusqlite::Result<RawJob> {
    Ok(RawJob {
        job_id: row.get(0)?,
        capability: row.get(1)?,
        resource_key: row.get(2)?,
        requested_provider_id: row.get(3)?,
        selected_provider_id: row.get(4)?,
        status: row.get(5)?,
        created_at: row.get(6)?,
        started_at: row.get(7)?,
        completed_at: row.get(8)?,
        result_json: row.get(9)?,
        error_code: row.get(10)?,
        error_message: row.get(11)?,
        diagnostic_id: row.get(12)?,
    })
}

struct RawAttempt {
    attempt_id: String,
    job_id: String,
    provider_id: String,
    provider_version: String,
    status: String,
    started_at: i64,
    completed_at: Option<i64>,
    duration_ms: Option<i64>,
    returned_fields_json: String,
    error_code: Option<String>,
    error_message: Option<String>,
}

impl RawAttempt {
    fn into_attempt(self) -> Result<ProviderAttempt> {
        let status = ProviderAttemptStatus::parse(&self.status)
            .ok_or_else(|| anyhow!("unknown provider attempt status: {}", self.status))?;
        let returned_fields = serde_json::from_str(&self.returned_fields_json)
            .context("parse provider attempt fields")?;
        Ok(ProviderAttempt {
            attempt_id: self.attempt_id,
            job_id: self.job_id,
            provider_id: self.provider_id,
            provider_version: self.provider_version,
            status,
            started_at: self.started_at,
            completed_at: self.completed_at,
            duration_ms: self.duration_ms,
            returned_fields,
            error_code: self.error_code,
            error_message: self.error_message,
        })
    }
}

fn raw_attempt_from_row(row: &Row<'_>) -> rusqlite::Result<RawAttempt> {
    Ok(RawAttempt {
        attempt_id: row.get(0)?,
        job_id: row.get(1)?,
        provider_id: row.get(2)?,
        provider_version: row.get(3)?,
        status: row.get(4)?,
        started_at: row.get(5)?,
        completed_at: row.get(6)?,
        duration_ms: row.get(7)?,
        returned_fields_json: row.get(8)?,
        error_code: row.get(9)?,
        error_message: row.get(10)?,
    })
}

fn new_local_id(prefix: &str) -> String {
    let micros = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros();
    let sequence = NEXT_LOCAL_ID.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{micros:x}-{:x}-{sequence:x}", std::process::id())
}

fn unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_persists_job_and_attempt_lifecycle() {
        let temp = tempfile::tempdir().unwrap();
        let repository = AcquisitionRepository::open(temp.path().join("acquisition.db")).unwrap();
        let request = AcquisitionRequest::article_metrics("article-1");

        let queued = repository.create_job(&request).unwrap();
        assert_eq!(queued.status, AcquisitionJobStatus::Queued);
        assert_eq!(queued.diagnostic_id, queued.job_id);

        let running = repository
            .mark_job_running(&queued.job_id, "legacy.article-metrics")
            .unwrap();
        assert_eq!(running.status, AcquisitionJobStatus::Running);

        let attempt = repository
            .start_attempt(&queued.job_id, "legacy.article-metrics", "1.0.0")
            .unwrap();
        let completed_attempt = repository
            .complete_attempt(
                &attempt.attempt_id,
                ProviderAttemptStatus::Completed,
                &["read".to_string(), "like".to_string()],
            )
            .unwrap();
        assert_eq!(completed_attempt.status, ProviderAttemptStatus::Completed);
        assert_eq!(completed_attempt.returned_fields, vec!["read", "like"]);

        let result = serde_json::json!({
            "kind": "article_metrics",
            "data": { "aid": "article-1", "read_count": 42 }
        });
        let completed = repository
            .complete_job(
                &queued.job_id,
                "legacy.article-metrics",
                AcquisitionJobStatus::Completed,
                &result,
            )
            .unwrap();
        assert_eq!(completed.status, AcquisitionJobStatus::Completed);
        assert_eq!(completed.result, Some(result));
        assert_eq!(repository.list_attempts(&queued.job_id).unwrap().len(), 1);
        assert!(repository.path().ends_with("acquisition.db"));
    }

    #[test]
    fn failed_provider_attempt_does_not_erase_the_job_diagnostic_id() {
        let temp = tempfile::tempdir().unwrap();
        let repository = AcquisitionRepository::open(temp.path().join("acquisition.db")).unwrap();
        let request = AcquisitionRequest::article_metrics("article-2");
        let queued = repository.create_job(&request).unwrap();
        repository
            .mark_job_running(&queued.job_id, "legacy.article-metrics")
            .unwrap();
        let attempt = repository
            .start_attempt(&queued.job_id, "legacy.article-metrics", "1.0.0")
            .unwrap();
        repository
            .fail_attempt(&attempt.attempt_id, "provider.failed", "expected failure")
            .unwrap();
        let failed = repository
            .fail_job(
                &queued.job_id,
                Some("legacy.article-metrics"),
                "provider.failed",
                "expected failure",
            )
            .unwrap();

        assert_eq!(failed.status, AcquisitionJobStatus::Failed);
        assert_eq!(failed.diagnostic_id, queued.job_id);
        assert_eq!(failed.error_code.as_deref(), Some("provider.failed"));
        assert_eq!(
            repository.list_attempts(&queued.job_id).unwrap()[0].status,
            ProviderAttemptStatus::Failed
        );
    }
}
