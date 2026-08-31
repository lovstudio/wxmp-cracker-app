pub(crate) mod model;
pub(crate) mod orchestrator;
pub(crate) mod provider;
pub(crate) mod repository;

use tauri::{AppHandle, Emitter};

use crate::{commands::CmdError, providers};

use self::{
    model::{AcquisitionJob, AcquisitionRequest, ProviderAttempt, ProviderManifest},
    orchestrator::AcquisitionOrchestrator,
    repository::AcquisitionRepository,
};

pub const JOB_UPDATED_EVENT: &str = "acquisition-job-updated";

#[tauri::command]
pub fn create_article_metrics_acquisition_job(
    app: AppHandle,
    aid: String,
) -> Result<AcquisitionJob, CmdError> {
    let aid = aid.trim();
    if aid.is_empty() {
        return Err(CmdError {
            message: "缺少文章 ID".to_string(),
        });
    }

    let request = AcquisitionRequest::article_metrics(aid);
    let repository = AcquisitionRepository::open_default().map_err(CmdError::from)?;
    let registry = providers::default_registry().map_err(|message| CmdError { message })?;
    let orchestrator = AcquisitionOrchestrator::new(&repository, &registry);
    let job = orchestrator.create_job(&request).map_err(CmdError::from)?;
    emit_job(&app, &job);

    let job_id = job.job_id.clone();
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let join_job_id = job_id.clone();
        let join_app = task_app.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            run_article_metrics_job(&task_app, &job_id, &request)
        })
        .await;
        let failure_code = match result {
            Ok(Ok(())) => return,
            Ok(Err(error)) => {
                log::error!(
                    "[acquisition] job worker failed job_id={} error={error:#}",
                    join_job_id
                );
                "orchestrator.worker_failed"
            }
            Err(error) => {
                log::error!(
                    "[acquisition] job worker panicked job_id={} error={error}",
                    join_job_id
                );
                "orchestrator.worker_panicked"
            }
        };
        if let Ok(repository) = AcquisitionRepository::open_default() {
            if let Ok(failed) = repository.fail_job(
                &join_job_id,
                Some("legacy.article-metrics"),
                failure_code,
                "采集任务执行器异常退出",
            ) {
                emit_job(&join_app, &failed);
            }
        }
    });

    Ok(job)
}

#[tauri::command]
pub fn get_acquisition_job(job_id: String) -> Result<Option<AcquisitionJob>, CmdError> {
    let job_id = job_id.trim();
    if job_id.is_empty() {
        return Err(CmdError {
            message: "缺少采集任务 ID".to_string(),
        });
    }
    AcquisitionRepository::open_default()
        .and_then(|repository| repository.get_job(job_id))
        .map_err(CmdError::from)
}

#[tauri::command]
pub fn list_acquisition_attempts(job_id: String) -> Result<Vec<ProviderAttempt>, CmdError> {
    let job_id = job_id.trim();
    if job_id.is_empty() {
        return Err(CmdError {
            message: "缺少采集任务 ID".to_string(),
        });
    }
    AcquisitionRepository::open_default()
        .and_then(|repository| repository.list_attempts(job_id))
        .map_err(CmdError::from)
}

#[tauri::command]
pub fn list_acquisition_providers() -> Result<Vec<ProviderManifest>, CmdError> {
    providers::default_registry()
        .map(|registry| registry.manifests())
        .map_err(|message| CmdError { message })
}

fn run_article_metrics_job(
    app: &AppHandle,
    job_id: &str,
    request: &AcquisitionRequest,
) -> anyhow::Result<()> {
    let repository = AcquisitionRepository::open_default()?;
    let registry = providers::default_registry().map_err(anyhow::Error::msg)?;
    let orchestrator = AcquisitionOrchestrator::new(&repository, &registry);
    let terminal = orchestrator.run_job_with_observer(job_id, request, |job| emit_job(app, job))?;
    log::info!(
        "[acquisition] job terminal job_id={} capability={} status={} provider={} diagnostic_id={}",
        terminal.job_id,
        terminal.capability.as_str(),
        terminal.status.as_str(),
        terminal.selected_provider_id.as_deref().unwrap_or("none"),
        terminal.diagnostic_id
    );
    Ok(())
}

fn emit_job(app: &AppHandle, job: &AcquisitionJob) {
    if let Err(error) = app.emit(JOB_UPDATED_EVENT, job) {
        log::warn!(
            "[acquisition] failed to emit job update job_id={} status={} error={error}",
            job.job_id,
            job.status.as_str()
        );
    }
}
