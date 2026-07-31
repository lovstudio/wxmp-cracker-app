import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager"
import { toast as sonnerToast, type ExternalToast } from "sonner"
import { isWxmpAuthError, isWxmpRateLimitError } from "@/lib/wxmp-errors"

export { isWxmpAuthError, isWxmpRateLimitError } from "@/lib/wxmp-errors"

type ToastKind = "success" | "error" | "info" | "warning"
type ToastActionHandler = () => unknown | Promise<unknown>
type ToastOptionsWithoutActions = Omit<ExternalToast, "action" | "cancel">

export const copyableToast = {
  success: (message: string, options?: ExternalToast) =>
    showCopyableToast("success", message, options),
  error: (message: string, options?: ExternalToast) =>
    showCopyableToast("error", message, options),
  wxmpError: (
    message: string,
    onLogin: ToastActionHandler,
    options?: ToastOptionsWithoutActions
  ) =>
    isWxmpAuthError(message)
      ? showWxmpRecoveryToast(message, onLogin, "重新登录", options)
      : isWxmpRateLimitError(message)
        ? showWxmpRecoveryToast(message, onLogin, "重新登录", options)
        : showCopyableToast("error", message, options),
  info: (message: string, options?: ExternalToast) =>
    showCopyableToast("info", message, options),
  warning: (message: string, options?: ExternalToast) =>
    showCopyableToast("warning", message, options),
}

function showCopyableToast(
  kind: ToastKind,
  message: string,
  options?: ExternalToast
) {
  return sonnerToast[kind](message, {
    ...options,
    action: {
      label: "复制",
      onClick: () => {
        copyText(message)
      },
    },
  })
}

function showWxmpRecoveryToast(
  message: string,
  onLogin: ToastActionHandler,
  actionLabel: string,
  options?: ToastOptionsWithoutActions
) {
  return sonnerToast.error(message, {
    duration: 12000,
    ...options,
    cancel: {
      label: "复制",
      onClick: () => {
        void copyText(message)
      },
    },
    action: {
      label: actionLabel,
      onClick: () => {
        void Promise.resolve(onLogin()).catch((error) => {
          showCopyableToast("error", errorMessage(error))
        })
      },
    },
  })
}

export async function copyText(text: string) {
  try {
    await writeClipboardText(text)
    sonnerToast.success("已复制")
    return true
  } catch {
    // Browser preview has no Tauri plugin, so keep the web clipboard path.
  }

  try {
    await navigator.clipboard.writeText(text)
    sonnerToast.success("已复制")
    return true
  } catch {
    // Clipboard API may reject writes outside a focused secure context.
  }

  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.top = "-9999px"
  textarea.style.left = "-9999px"
  document.body.appendChild(textarea)
  textarea.select()

  try {
    const copied = document.execCommand("copy")
    if (!copied) {
      throw new Error("document.execCommand returned false")
    }
    sonnerToast.success("已复制")
    return true
  } catch {
    sonnerToast.error("复制失败")
    return false
  } finally {
    document.body.removeChild(textarea)
  }
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}
