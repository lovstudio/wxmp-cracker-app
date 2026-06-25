export function normalizeWechatImageUrl(src: string | null): string | null {
  const value = src?.trim().replaceAll("&amp;", "&")
  if (!value) return null
  if (value.startsWith("//")) return `https:${value}`
  if (shouldUpgradeWechatImageUrl(value)) {
    return value.replace("http://", "https://")
  }
  return value
}

export function isWechatRemoteImageUrl(src: string | null): boolean {
  const value = normalizeWechatImageUrl(src)
  if (!value) return false

  try {
    const { hostname, protocol } = new URL(value)
    return (
      (protocol === "http:" || protocol === "https:") &&
      isWechatImageHost(hostname)
    )
  } catch {
    return (
      value.startsWith("http://mmbiz.") || value.startsWith("https://mmbiz.")
    )
  }
}

function shouldUpgradeWechatImageUrl(value: string) {
  if (!value.startsWith("http://")) return false

  try {
    const { hostname } = new URL(value)
    return isWechatImageHost(hostname)
  } catch {
    return value.startsWith("http://mmbiz.")
  }
}

function isWechatImageHost(hostname: string) {
  return (
    hostname === "mmbiz.qpic.cn" ||
    hostname.endsWith(".mmbiz.qpic.cn") ||
    hostname === "mmbiz.qlogo.cn" ||
    hostname.endsWith(".mmbiz.qlogo.cn") ||
    hostname === "wx.qlogo.cn" ||
    hostname.endsWith(".wx.qlogo.cn") ||
    hostname === "thirdwx.qlogo.cn" ||
    hostname.endsWith(".thirdwx.qlogo.cn")
  )
}
