import { describe, expect, test } from "bun:test"
import {
  articleMetricsFromAcquisitionJob,
  type AcquisitionJob,
} from "../src/lib/acquisition"
import type { ArticlePublicMetricsSnapshot } from "../src/lib/api"

const snapshot: ArticlePublicMetricsSnapshot = {
  id: 42,
  aid: "article-1",
  source_url: "https://mp.weixin.qq.com/s/example",
  source_kind: "wechat_account_feed",
  capture_method: "wechat_account_feed_batch",
  captured_at: 1_788_000_000,
  status: "visible",
  read_count: 123,
  like_count: 12,
  recommend_count: 3,
  share_count: 8,
  comment_count: 1,
  collect_count: 6,
  note: null,
}

function job(overrides: Partial<AcquisitionJob> = {}): AcquisitionJob {
  return {
    job_id: "job-1",
    capability: "article.metrics.fetch",
    resource_key: snapshot.aid,
    requested_provider_id: "legacy.article-metrics",
    selected_provider_id: "legacy.article-metrics",
    status: "running",
    created_at: 1,
    started_at: 2,
    completed_at: null,
    result: null,
    error_code: null,
    error_message: null,
    diagnostic_id: "job-1",
    ...overrides,
  }
}

describe("article metrics acquisition jobs", () => {
  test("returns null while the provider is still running", () => {
    expect(articleMetricsFromAcquisitionJob(job())).toBeNull()
  })

  test("extracts the legacy snapshot from the stable job envelope", () => {
    expect(
      articleMetricsFromAcquisitionJob(
        job({
          status: "completed",
          completed_at: 3,
          result: { kind: "article_metrics", data: snapshot },
        })
      )
    ).toEqual(snapshot)
  })

  test("preserves the provider error and adds a diagnostic id", () => {
    expect(() =>
      articleMetricsFromAcquisitionJob(
        job({
          status: "failed",
          completed_at: 3,
          error_code: "legacy.article_metrics.failed",
          error_message: "微信没有返回互动数据",
        })
      )
    ).toThrow("微信没有返回互动数据（诊断 ID：job-1）")
  })
})
