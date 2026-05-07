export function normalizeWechatImageUrl(src: string | null): string | null {
  const value = src?.trim().replaceAll("&amp;", "&")
  if (!value) return null
  if (value.startsWith("//")) return `https:${value}`
  if (value.startsWith("http://mmbiz.")) return value.replace("http://", "https://")
  return value
}
