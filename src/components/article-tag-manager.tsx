import {
  AlertCircleIcon,
  CheckIcon,
  CopyIcon,
  FileTextIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlusIcon,
  TagIcon,
  Trash2Icon,
  UnlinkIcon,
  XIcon,
} from "lucide-react"
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { buildArticleTagHandoff } from "@/lib/article-tag-handoff"
import {
  api,
  type Account,
  type ArticleSummary,
  type ArticleTag,
} from "@/lib/api"
import { isTauri } from "@/lib/tauri"
import { copyText, copyableToast as toast } from "@/lib/toast"

interface ArticleTagManagerProps {
  accounts: Account[]
  refreshKey: number
}

export function ArticleTagManager({
  accounts,
  refreshKey,
}: ArticleTagManagerProps) {
  const [tags, setTags] = useState<ArticleTag[]>([])
  const [selectedTagId, setSelectedTagId] = useState<number | null>(null)
  const [articles, setArticles] = useState<ArticleSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [articlesLoading, setArticlesLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [articleError, setArticleError] = useState<string | null>(null)
  const [newTagName, setNewTagName] = useState("")
  const [editingTagId, setEditingTagId] = useState<number | null>(null)
  const [editingName, setEditingName] = useState("")
  const [pendingDelete, setPendingDelete] = useState<ArticleTag | null>(null)
  const [actionKey, setActionKey] = useState<string | null>(null)
  const [copyingTagId, setCopyingTagId] = useState<number | null>(null)
  const accountNames = useMemo(
    () =>
      new Map(accounts.map((account) => [account.fakeid, account.nickname])),
    [accounts]
  )
  const selectedTag = tags.find((tag) => tag.id === selectedTagId) ?? null
  const busy = actionKey !== null

  useEffect(() => {
    if (!isTauri()) {
      setTags([])
      setSelectedTagId(null)
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    api
      .listAllArticleTags()
      .then((nextTags) => {
        if (cancelled) return
        const orderedTags = sortTags(nextTags)
        setTags(orderedTags)
        setSelectedTagId((current) =>
          current && orderedTags.some((tag) => tag.id === current)
            ? current
            : (orderedTags[0]?.id ?? null)
        )
      })
      .catch((caughtError) => {
        if (cancelled) return
        setTags([])
        setSelectedTagId(null)
        setError(errorMessage(caughtError))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [refreshKey])

  useEffect(() => {
    if (selectedTagId === null) {
      setArticles([])
      setArticleError(null)
      setArticlesLoading(false)
      return
    }

    let cancelled = false
    setArticlesLoading(true)
    setArticleError(null)
    api
      .listTagArticles(selectedTagId)
      .then((nextArticles) => {
        if (!cancelled) setArticles(nextArticles)
      })
      .catch((caughtError) => {
        if (cancelled) return
        setArticles([])
        setArticleError(errorMessage(caughtError))
      })
      .finally(() => {
        if (!cancelled) setArticlesLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedTagId])

  const createTag = async (event: FormEvent) => {
    event.preventDefault()
    const name = newTagName.trim()
    if (!name || busy) return

    setActionKey("create")
    setError(null)
    try {
      const created = await api.createArticleTag(name)
      setTags((current) => sortTags([...current, created]))
      setSelectedTagId(created.id)
      setNewTagName("")
      toast.success(`已新建标签“${created.name}”`)
    } catch (caughtError) {
      const message = errorMessage(caughtError)
      setError(message)
      toast.error(`新建标签失败：${message}`)
    } finally {
      setActionKey(null)
    }
  }

  const renameTag = async (event: FormEvent, tag: ArticleTag) => {
    event.preventDefault()
    const name = editingName.trim()
    if (!name || busy) return

    setActionKey(`rename:${tag.id}`)
    setError(null)
    try {
      const updated = await api.updateArticleTag(tag.id, name)
      setTags((current) =>
        sortTags(
          current.map((item) =>
            item.id === tag.id ? { ...item, name: updated.name } : item
          )
        )
      )
      setEditingTagId(null)
      setEditingName("")
      toast.success(`标签已重命名为“${updated.name}”`)
    } catch (caughtError) {
      const message = errorMessage(caughtError)
      setError(message)
      toast.error(`编辑标签失败：${message}`)
    } finally {
      setActionKey(null)
    }
  }

  const deleteTag = async (tag: ArticleTag) => {
    if (busy) return

    setActionKey(`delete:${tag.id}`)
    setError(null)
    try {
      await api.deleteArticleTag(tag.id)
      const nextTags = tags.filter((item) => item.id !== tag.id)
      setTags(nextTags)
      if (selectedTagId === tag.id) {
        setSelectedTagId(nextTags[0]?.id ?? null)
      }
      setPendingDelete(null)
      toast.success(`已删除标签“${tag.name}”`)
    } catch (caughtError) {
      const message = errorMessage(caughtError)
      setError(message)
      toast.error(`删除标签失败：${message}`)
    } finally {
      setActionKey(null)
    }
  }

  const removeArticle = async (article: ArticleSummary) => {
    if (!selectedTag || busy) return

    setActionKey(`unlink:${article.aid}`)
    setArticleError(null)
    try {
      await api.setArticleTag(article.aid, selectedTag.id, false)
      setArticles((current) =>
        current.filter((item) => item.aid !== article.aid)
      )
      setTags((current) =>
        current.map((tag) =>
          tag.id === selectedTag.id
            ? { ...tag, article_count: Math.max(0, tag.article_count - 1) }
            : tag
        )
      )
      toast.success(`已从“${selectedTag.name}”移除文章`)
    } catch (caughtError) {
      const message = errorMessage(caughtError)
      setArticleError(message)
      toast.error(`移除文章失败：${message}`)
    } finally {
      setActionKey(null)
    }
  }

  const copyTagIndex = async (tag: ArticleTag) => {
    if (copyingTagId !== null) return

    setCopyingTagId(tag.id)
    setError(null)
    try {
      const indexedArticles = await api.listTagArticles(tag.id)
      const text = buildArticleTagHandoff({
        tag,
        articles: indexedArticles,
        accounts,
      })
      const copied = await copyText(
        text,
        `已复制“${tag.name}”及 ${indexedArticles.length} 篇文章索引`
      )
      if (!copied) {
        setError("系统剪贴板写入失败，请重试")
        return
      }
      setTags((current) =>
        current.map((item) =>
          item.id === tag.id
            ? { ...item, article_count: indexedArticles.length }
            : item
        )
      )
      if (selectedTagId === tag.id) setArticles(indexedArticles)
    } catch (caughtError) {
      const message = errorMessage(caughtError)
      setError(message)
      toast.error(`复制标签索引失败：${message}`)
    } finally {
      setCopyingTagId(null)
    }
  }

  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <main className="mx-auto flex min-h-full w-full max-w-6xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-1 flex items-center gap-2 text-xs font-medium text-primary">
              <TagIcon className="size-3.5" />
              跨公众号文章组织
            </div>
            <h1 className="font-serif text-2xl font-semibold text-foreground">
              标签管理
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              统一整理本机文章标签，查看每个标签关联的文章，并复制完整索引交给其他
              Agent。
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{tags.length} 个标签</Badge>
            <Badge variant="outline">
              {tags.reduce((total, tag) => total + tag.article_count, 0)} 次关联
            </Badge>
          </div>
        </header>

        <Card>
          <CardHeader className="border-b">
            <CardTitle className="font-serif">新建标签</CardTitle>
            <CardDescription>
              标签名称最多 24 个字符，英文名称不区分大小写。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={createTag}
              className="flex flex-col gap-2 sm:flex-row sm:items-end"
            >
              <div className="min-w-0 flex-1 space-y-1.5">
                <Label htmlFor="global-new-article-tag">标签名称</Label>
                <Input
                  id="global-new-article-tag"
                  maxLength={24}
                  value={newTagName}
                  disabled={busy}
                  placeholder="例如：产品洞察"
                  onChange={(event) => setNewTagName(event.target.value)}
                />
              </div>
              <Button
                type="submit"
                disabled={!newTagName.trim() || busy}
                className="sm:mb-px"
              >
                {actionKey === "create" ? (
                  <LoaderCircleIcon className="animate-spin" />
                ) : (
                  <PlusIcon />
                )}
                新建标签
              </Button>
            </form>
          </CardContent>
        </Card>

        {error ? <ErrorNotice message={error} /> : null}

        <div className="grid min-h-[430px] gap-4 lg:grid-cols-[minmax(280px,0.85fr)_minmax(0,1.55fr)]">
          <Card className="min-h-0">
            <CardHeader className="border-b">
              <CardTitle className="font-serif">全部标签</CardTitle>
              <CardDescription>选择标签查看背后的文章索引。</CardDescription>
              <CardAction>
                <Badge variant="secondary">{tags.length}</Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="min-h-0 px-2">
              <div className="max-h-[520px] overflow-y-auto py-1">
                {loading ? (
                  <LoadingState label="正在读取标签" />
                ) : tags.length === 0 ? (
                  <EmptyState
                    icon={<TagIcon className="size-6" />}
                    title="还没有标签"
                    detail="在上方创建第一个标签，然后可从文章右键菜单添加内容。"
                  />
                ) : (
                  tags.map((tag) => {
                    const selected = tag.id === selectedTagId
                    const editing = tag.id === editingTagId
                    return (
                      <div
                        key={tag.id}
                        className={`group flex min-h-11 items-center gap-1 rounded-lg px-1.5 py-1 transition-colors ${
                          selected ? "bg-primary/10" : "hover:bg-muted/60"
                        }`}
                      >
                        {editing ? (
                          <form
                            onSubmit={(event) => void renameTag(event, tag)}
                            className="flex min-w-0 flex-1 items-center gap-1"
                          >
                            <Input
                              autoFocus
                              maxLength={24}
                              value={editingName}
                              disabled={busy}
                              aria-label={`编辑标签 ${tag.name}`}
                              className="h-7"
                              onChange={(event) =>
                                setEditingName(event.target.value)
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Escape") {
                                  event.preventDefault()
                                  setEditingTagId(null)
                                }
                              }}
                            />
                            <Button
                              type="submit"
                              size="icon-xs"
                              variant="ghost"
                              disabled={!editingName.trim() || busy}
                              aria-label="保存标签名称"
                            >
                              {actionKey === `rename:${tag.id}` ? (
                                <LoaderCircleIcon className="animate-spin" />
                              ) : (
                                <CheckIcon />
                              )}
                            </Button>
                            <Button
                              type="button"
                              size="icon-xs"
                              variant="ghost"
                              disabled={busy}
                              aria-label="取消编辑"
                              onClick={() => setEditingTagId(null)}
                            >
                              <XIcon />
                            </Button>
                          </form>
                        ) : (
                          <>
                            <button
                              type="button"
                              aria-pressed={selected}
                              className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                              onClick={() => setSelectedTagId(tag.id)}
                            >
                              <div className="truncate text-sm font-medium text-foreground">
                                {tag.name}
                              </div>
                              <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                                {tag.article_count} 篇文章
                              </div>
                            </button>
                            <TagIconButton
                              label={`复制标签 ${tag.name} 及文章索引`}
                              tooltip="复制标签索引"
                              disabled={copyingTagId !== null}
                              onClick={() => void copyTagIndex(tag)}
                            >
                              {copyingTagId === tag.id ? (
                                <LoaderCircleIcon className="animate-spin" />
                              ) : (
                                <CopyIcon />
                              )}
                            </TagIconButton>
                            <TagIconButton
                              label={`编辑标签 ${tag.name}`}
                              tooltip="重命名"
                              disabled={busy}
                              onClick={() => {
                                setEditingTagId(tag.id)
                                setEditingName(tag.name)
                                setPendingDelete(null)
                              }}
                            >
                              <PencilIcon />
                            </TagIconButton>
                            <TagIconButton
                              label={`删除标签 ${tag.name}`}
                              tooltip="删除标签"
                              disabled={busy}
                              destructive
                              onClick={() => {
                                setPendingDelete(tag)
                                setEditingTagId(null)
                              }}
                            >
                              <Trash2Icon />
                            </TagIconButton>
                          </>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
              {pendingDelete ? (
                <div className="mt-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3">
                  <div className="text-sm font-medium text-foreground">
                    删除“{pendingDelete.name}”？
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    标签会从 {pendingDelete.article_count}{" "}
                    篇文章中移除，文章本身不会被删除。
                  </p>
                  <div className="mt-3 flex justify-end gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setPendingDelete(null)}
                    >
                      取消
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void deleteTag(pendingDelete)}
                    >
                      {actionKey === `delete:${pendingDelete.id}` ? (
                        <LoaderCircleIcon className="animate-spin" />
                      ) : (
                        <Trash2Icon />
                      )}
                      确认删除
                    </Button>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card className="min-h-0">
            <CardHeader className="border-b">
              <CardTitle className="font-serif">
                {selectedTag ? selectedTag.name : "文章索引"}
              </CardTitle>
              <CardDescription>
                {selectedTag
                  ? `${selectedTag.article_count} 篇文章与该标签关联`
                  : "选择左侧标签查看关联文章"}
              </CardDescription>
              {selectedTag ? (
                <CardAction>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={copyingTagId !== null}
                    onClick={() => void copyTagIndex(selectedTag)}
                  >
                    {copyingTagId === selectedTag.id ? (
                      <LoaderCircleIcon className="animate-spin" />
                    ) : (
                      <CopyIcon />
                    )}
                    复制标签索引
                  </Button>
                </CardAction>
              ) : null}
            </CardHeader>
            <CardContent className="min-h-0 px-2">
              {articleError ? (
                <div className="px-2 pt-2">
                  <ErrorNotice message={articleError} />
                </div>
              ) : null}
              <div className="max-h-[520px] overflow-y-auto py-1">
                {articlesLoading ? (
                  <LoadingState label="正在读取文章索引" />
                ) : !selectedTag ? (
                  <EmptyState
                    icon={<FileTextIcon className="size-6" />}
                    title="尚未选择标签"
                    detail="选择一个标签后，这里会展示它关联的全部本地文章索引。"
                  />
                ) : articles.length === 0 ? (
                  <EmptyState
                    icon={<FileTextIcon className="size-6" />}
                    title="这个标签还没有文章"
                    detail="在阅读列表中右键文章，即可把文章加入该标签。"
                  />
                ) : (
                  articles.map((article) => (
                    <div
                      key={article.aid}
                      className="flex items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-muted/50"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="line-clamp-2 text-sm leading-snug font-medium text-foreground">
                          {article.title}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                          <span>
                            {accountNames.get(article.fakeid) ?? article.fakeid}
                          </span>
                          <span aria-hidden="true">·</span>
                          <time dateTime={articleDateTime(article.create_time)}>
                            {formatArticleDate(article.create_time)}
                          </time>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">{article.aid}</span>
                          <Badge
                            variant={
                              article.has_content ? "secondary" : "outline"
                            }
                            className="h-4 px-1.5 text-[10px]"
                          >
                            {article.has_content ? "含正文" : "仅索引"}
                          </Badge>
                        </div>
                      </div>
                      <TagIconButton
                        label={`从标签 ${selectedTag.name} 移除文章 ${article.title}`}
                        tooltip="从标签移除"
                        disabled={busy}
                        onClick={() => void removeArticle(article)}
                      >
                        {actionKey === `unlink:${article.aid}` ? (
                          <LoaderCircleIcon className="animate-spin" />
                        ) : (
                          <UnlinkIcon />
                        )}
                      </TagIconButton>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  )
}

function TagIconButton({
  label,
  tooltip,
  disabled,
  destructive = false,
  onClick,
  children,
}: {
  label: string
  tooltip: string
  disabled?: boolean
  destructive?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={disabled}
          className={
            destructive
              ? "text-destructive hover:bg-destructive/10 hover:text-destructive"
              : undefined
          }
          aria-label={label}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-relaxed text-destructive select-text"
    >
      <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
      <span>{message}</span>
    </div>
  )
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex min-h-36 items-center justify-center gap-2 text-sm text-muted-foreground">
      <LoaderCircleIcon className="size-4 animate-spin" />
      {label}
    </div>
  )
}

function EmptyState({
  icon,
  title,
  detail,
}: {
  icon: ReactNode
  title: string
  detail: string
}) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center px-6 text-center text-muted-foreground">
      <div className="mb-3 rounded-xl border border-border bg-muted/40 p-3">
        {icon}
      </div>
      <div className="font-serif text-sm font-semibold text-foreground">
        {title}
      </div>
      <p className="mt-1 max-w-xs text-xs leading-relaxed">{detail}</p>
    </div>
  )
}

function sortTags(tags: ArticleTag[]) {
  return [...tags].sort(
    (left, right) =>
      left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base" }) ||
      left.id - right.id
  )
}

function articleDateTime(timestamp: number) {
  return new Date(timestamp * 1000).toISOString()
}

function formatArticleDate(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp * 1000))
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}
