import { useEffect } from "react"
import { check } from "@tauri-apps/plugin-updater"
import { relaunch } from "@tauri-apps/plugin-process"
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

async function checkForUpdate() {
  try {
    const update = await check()
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
