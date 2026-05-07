import { toast as sonnerToast, type ExternalToast } from "sonner"

type ToastKind = "success" | "error" | "info" | "warning"

export const copyableToast = {
  success: (message: string, options?: ExternalToast) =>
    showCopyableToast("success", message, options),
  error: (message: string, options?: ExternalToast) =>
    showCopyableToast("error", message, options),
  info: (message: string, options?: ExternalToast) =>
    showCopyableToast("info", message, options),
  warning: (message: string, options?: ExternalToast) =>
    showCopyableToast("warning", message, options),
}

function showCopyableToast(kind: ToastKind, message: string, options?: ExternalToast) {
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

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    sonnerToast.success("已复制")
    return true
  } catch {
    // Tauri/WebKit may reject Clipboard API outside a focused secure context.
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
    document.execCommand("copy")
    sonnerToast.success("已复制")
    return true
  } catch {
    sonnerToast.error("复制失败")
    return false
  } finally {
    document.body.removeChild(textarea)
  }
}
