import { useEffect } from "react"
import { invoke } from "@tauri-apps/api/core"
import { check } from "@tauri-apps/plugin-updater"
import { exit, relaunch } from "@tauri-apps/plugin-process"
import { isTauri } from "@/lib/tauri"
import { copyableToast as toast } from "@/lib/toast"

export function useAutoUpdate() {
  useEffect(() => {
    if (!isTauri()) return

    const timer = window.setTimeout(() => {
      void checkForUpdate()
    }, 3000)

    return () => window.clearTimeout(timer)
  }, [])
}

type DeltaUpdate = {
  version: string
  fromVersion: string
  size: number
}

let checkInFlight: Promise<void> | null = null

async function checkForUpdate() {
  if (checkInFlight) return checkInFlight

  checkInFlight = checkForUpdateInner().finally(() => {
    checkInFlight = null
  })
  return checkInFlight
}

async function checkForUpdateInner() {
  try {
    const delta = await invoke<DeltaUpdate | null>("check_delta_update")
    if (delta) {
      const size = formatBytes(delta.size)
      toast.info(`发现新版本 v${delta.version}，正在下载 ${size} 增量更新...`, {
        duration: 8000,
      })
      await invoke("install_delta_update")
      toast.success("增量更新已准备完成，正在重启应用", { duration: 2000 })
      window.setTimeout(() => void exit(0), 2000)
      return
    }
  } catch (error) {
    // 差分包不可用时沿用已经验证过的完整包更新链路。
    console.warn(
      "delta update check failed, falling back to full update:",
      error
    )
  }

  try {
    const update = await check({ timeout: 20_000 })
    if (!update) return

    toast.info(`发现新版本 v${update.version}，正在下载...`, {
      duration: 8000,
    })

    await update.downloadAndInstall()

    toast.success("更新已下载，即将重启应用", {
      duration: 3000,
      action: {
        label: "立即重启",
        onClick: () => void relaunch(),
      },
    })

    window.setTimeout(() => void relaunch(), 3000)
  } catch (e) {
    console.warn("auto-update check failed:", e)
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
