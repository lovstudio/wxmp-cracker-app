import { useEffect, useState } from "react"
import { LoaderCircleIcon, PlusIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface Props {
  open: boolean
  busy: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (query: string, limit: number, withContent: boolean) => void
}

export function AddAccountDialog({
  open,
  busy,
  onOpenChange,
  onSubmit,
}: Props) {
  const [query, setQuery] = useState("")
  const [limit, setLimit] = useState("20")
  const [withContent, setWithContent] = useState(false)

  useEffect(() => {
    if (open) return
    setQuery("")
    setLimit("20")
    setWithContent(false)
  }, [open])

  if (!open) return null

  const parsedLimit = Number.parseInt(limit, 10)
  const canSubmit =
    query.trim().length > 0 && Number.isFinite(parsedLimit) && parsedLimit > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4 backdrop-blur-sm">
      <form
        className="dialog-panel w-full max-w-[420px] rounded-lg p-4 text-card-foreground shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault()
          if (!canSubmit || busy) return
          onSubmit(query, Math.min(Math.max(parsedLimit, 1), 500), withContent)
        }}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="font-heading text-lg leading-none font-semibold">
              新增公众号
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              微探 · Powered by Lovstudio
            </div>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            <XIcon className="size-4" />
          </Button>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="track-query">公众号名称或 fakeid</Label>
            <Input
              id="track-query"
              value={query}
              disabled={busy}
              autoFocus
              placeholder="例如：人民日报"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div className="grid grid-cols-[1fr_auto] items-end gap-3">
            <div className="space-y-2">
              <Label htmlFor="track-limit">抓取篇数</Label>
              <Input
                id="track-limit"
                type="number"
                min={1}
                max={500}
                value={limit}
                disabled={busy}
                onChange={(event) => setLimit(event.target.value)}
              />
            </div>
            <label className="mb-2 flex h-9 items-center gap-2 rounded-md border border-border/70 bg-muted/35 px-3 text-sm">
              <Checkbox
                checked={withContent}
                disabled={busy}
                onCheckedChange={(checked) => setWithContent(checked === true)}
              />
              <span>抓正文</span>
            </label>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button type="submit" disabled={!canSubmit || busy}>
            {busy ? (
              <LoaderCircleIcon className="size-4 animate-spin" />
            ) : (
              <PlusIcon className="size-4" />
            )}
            开始抓取
          </Button>
        </div>
      </form>
    </div>
  )
}
