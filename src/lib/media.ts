export function normalizeWechatImageUrl(src: string | null): string | null {
  const value = src?.trim().replaceAll("&amp;", "&")
  if (!value) return null
  if (value.startsWith("//")) return `https:${value}`
  if (shouldUpgradeWechatImageUrl(value)) {
    return value.replace("http://", "https://")
  }
  return value
}

function shouldUpgradeWechatImageUrl(value: string) {
  if (!value.startsWith("http://")) return false

  try {
    const { hostname } = new URL(value)
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
  } catch {
    return value.startsWith("http://mmbiz.")
  }
}
