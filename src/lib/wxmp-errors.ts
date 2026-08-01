export function isWxmpAuthError(message: string) {
  const normalized = message.toLowerCase()

  return (
    message.includes("认证失败") ||
    message.includes("尚未登录") ||
    message.includes("请先扫码登录") ||
    message.includes("登录已过期") ||
    message.includes("重新扫码") ||
    normalized.includes("auth failed") ||
    normalized.includes("invalid session") ||
    normalized.includes("re-login needed") ||
    normalized.includes("ret=200003")
  )
}

export function isWxmpRateLimitError(message: string) {
  const normalized = message.toLowerCase()

  return (
    message.includes("触发风控") ||
    message.includes("频率保护") ||
    message.includes("保护冷却") ||
    message.includes("暂停微信公众号接口请求") ||
    normalized.includes("ret=200013") ||
    normalized.includes("rate limited") ||
    normalized.includes("ratelimit")
  )
}

export function isWxmpLocalCooldownError(message: string) {
  return message.includes("本地保护") || message.includes("本次请求未发往微信")
}
