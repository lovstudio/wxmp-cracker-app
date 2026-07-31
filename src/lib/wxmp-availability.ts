// 微信在 2026-07-30 起集中拦截登录态文章列表入口。默认暂停这条路径，
// 避免每位用户都用自己的公众号登录态重复验证同一个上游故障。
export const WXMP_ARTICLE_LIST_PAUSED = true

export const WXMP_ARTICLE_LIST_PAUSED_TITLE = "公众号批量抓取已暂停"

export const WXMP_ARTICLE_LIST_PAUSED_DESCRIPTION =
  "微信近期调整了公众号文章列表来源。为保护登录账号，应用不会继续请求这条批量抓取路径；已缓存内容和文章链接导入仍可使用。"
