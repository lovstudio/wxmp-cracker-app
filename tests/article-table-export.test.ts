import { describe, expect, test } from "bun:test"
import {
  activeArticleManagementFilterCount,
  articleManagementAuthorValue,
  articleManagementTagValue,
  articleTableExportFileName,
  buildArticleTableCsv,
  DEFAULT_ARTICLE_MANAGEMENT_FILTERS,
  filterArticleTableRows,
} from "../src/lib/article-table-export"
import { DEFAULT_ARTICLE_FILTERS } from "../src/lib/article-filters"
import type { ArticleSummary } from "../src/lib/api"

const article = (
  aid: string,
  overrides: Partial<ArticleSummary> = {}
): ArticleSummary => ({
  aid,
  fakeid: "account-1",
  title: `标题 ${aid}`,
  link: `https://mp.weixin.qq.com/s/${aid}`,
  digest: `带有"引号",逗号和\n换行的摘要 ${aid}`,
  cover: null,
  author: "作者",
  create_time: 1_700_000_000,
  has_content: true,
  article_type: 9,
  copyright_type: 1,
  tags: ["产品", "待研究"],
  local_file_path: `/Users/example/archive/${aid}.md`,
  ...overrides,
})

describe("article table export", () => {
  test("exports selected columns in order as Excel-friendly UTF-8 CSV", () => {
    const csv = buildArticleTableCsv(
      [article("article-1")],
      ["title", "tags", "digest", "content_status", "link", "local_file_path"]
    )

    expect(csv.startsWith("\uFEFF")).toBe(true)
    expect(csv).toContain(
      '"标题","标签","摘要","正文状态","原文网址","文件地址"'
    )
    expect(csv).toContain('"标题 article-1"')
    expect(csv).toContain('"产品、待研究"')
    expect(csv).toContain('"带有""引号"",逗号和\n换行的摘要 article-1"')
    expect(csv).toContain('"正文已采集"')
    expect(csv).toContain('"https://mp.weixin.qq.com/s/article-1"')
    expect(csv).toContain('"/Users/example/archive/article-1.md"')
    expect(csv.endsWith("\r\n")).toBe(true)
  })

  test("combines text search with the shared article filters", () => {
    const rows = [
      article("matching", { title: "Agent 产品", copyright_type: 1 }),
      article("reprint", { title: "Agent 转载", copyright_type: 2 }),
      article("other", { title: "设计系统", copyright_type: 1 }),
    ]

    expect(
      filterArticleTableRows(rows, "agent", {
        ...DEFAULT_ARTICLE_FILTERS,
        copyright: "original",
      }).map((item) => item.aid)
    ).toEqual(["matching"])
  })

  test("searches tags, URLs, and local file paths", () => {
    const rows = [
      article("tagged", { tags: ["重点案例"] }),
      article("path", {
        tags: [],
        local_file_path: "/Users/example/archive/独立开发.md",
      }),
    ]

    expect(
      filterArticleTableRows(rows, "重点案例", DEFAULT_ARTICLE_FILTERS).map(
        (item) => item.aid
      )
    ).toEqual(["tagged"])
    expect(
      filterArticleTableRows(rows, "独立开发.md", DEFAULT_ARTICLE_FILTERS).map(
        (item) => item.aid
      )
    ).toEqual(["path"])
  })

  test("combines tag, author, date, local file, and completeness filters", () => {
    const rows = [
      article("complete", {
        tags: ["重点案例", "产品"],
        author: "林老师",
        create_time: localUnix(2026, 1, 15),
        cover: "https://example.com/complete.jpg",
      }),
      article("missing-file", {
        tags: ["重点案例"],
        author: "林老师",
        create_time: localUnix(2026, 1, 20),
        cover: "https://example.com/missing-file.jpg",
        local_file_path: null,
      }),
      article("outside-range", {
        tags: ["重点案例"],
        author: "林老师",
        create_time: localUnix(2026, 2, 1),
        cover: "https://example.com/outside-range.jpg",
      }),
    ]

    expect(
      filterArticleTableRows(rows, "", DEFAULT_ARTICLE_FILTERS, {
        ...DEFAULT_ARTICLE_MANAGEMENT_FILTERS,
        tag: articleManagementTagValue("重点案例"),
        author: articleManagementAuthorValue("林老师"),
        publishedFrom: "2026-01-01",
        publishedTo: "2026-01-31",
        originalUrl: "present",
        coverUrl: "present",
        localFile: "generated",
        completeness: "complete",
      }).map((item) => item.aid)
    ).toEqual(["complete"])
  })

  test("filters missing metadata and includes both date boundaries", () => {
    const rows = [
      article("start", {
        tags: [],
        author: null,
        digest: null,
        cover: null,
        link: "",
        create_time: localUnix(2026, 3, 1, 0),
        local_file_path: null,
      }),
      article("end", {
        tags: [],
        author: null,
        digest: null,
        cover: null,
        link: "",
        create_time: localUnix(2026, 3, 31, 23),
        local_file_path: null,
      }),
      article("next-day", {
        tags: [],
        author: null,
        cover: null,
        link: "",
        create_time: localUnix(2026, 4, 1, 0),
        local_file_path: null,
      }),
    ]
    const missingMetadata = {
      ...DEFAULT_ARTICLE_MANAGEMENT_FILTERS,
      tag: "untagged" as const,
      author: "missing" as const,
      publishedFrom: "2026-03-01",
      publishedTo: "2026-03-31",
      originalUrl: "missing" as const,
      coverUrl: "missing" as const,
      localFile: "missing" as const,
      completeness: "missing_cover" as const,
    }

    expect(
      filterArticleTableRows(
        rows,
        "",
        DEFAULT_ARTICLE_FILTERS,
        missingMetadata
      ).map((item) => item.aid)
    ).toEqual(["start", "end"])
    expect(activeArticleManagementFilterCount(missingMetadata)).toBe(8)
  })

  test("returns no rows for an inverted date range", () => {
    expect(
      filterArticleTableRows(
        [article("article-1")],
        "",
        DEFAULT_ARTICLE_FILTERS,
        {
          ...DEFAULT_ARTICLE_MANAGEMENT_FILTERS,
          publishedFrom: "2026-05-02",
          publishedTo: "2026-05-01",
        }
      )
    ).toEqual([])
  })

  test("creates a safe, dated CSV file name", () => {
    expect(
      articleTableExportFileName(
        " 手工川/研究:组? ",
        new Date("2026-08-25T00:00:00Z")
      )
    ).toBe("微探-手工川-研究-组--文章-2026-08-25.csv")
  })
})

function localUnix(year: number, month: number, day: number, hour = 12) {
  return Math.floor(new Date(year, month - 1, day, hour).getTime() / 1000)
}
