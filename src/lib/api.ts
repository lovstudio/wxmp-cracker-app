import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

export interface Account {
  fakeid: string
  nickname: string
  alias: string | null
  signature: string | null
  avatar: string | null
  article_count: number
}

export interface ArticleSummary {
  aid: string
  fakeid: string
  title: string
  link: string
  digest: string | null
  cover: string | null
  author: string | null
  create_time: number
  has_content: boolean
}

export interface ArticleDetail extends ArticleSummary {
  content_html: string | null
  content_md: string | null
}

export interface LoginAccount {
  nickname: string | null
  username: string | null
  avatar: string | null
  alias: string | null
  service_type: string | null
}

export interface AuthStatus {
  logged_in: boolean
  token: string | null
  account: LoginAccount | null
  last_login_at: number | null
}

export interface FetchAccountResult {
  stdout: string
  stderr: string
}

export const api = {
  authStatus: () => invoke<AuthStatus>("auth_status"),
  openLogin: () => invoke<void>("open_login"),
  listAccounts: () => invoke<Account[]>("list_accounts"),
  listArticles: (fakeid: string) =>
    invoke<ArticleSummary[]>("list_articles", { fakeid }),
  getArticle: (aid: string) =>
    invoke<ArticleDetail | null>("get_article", { aid }),
  cacheDbPath: () => invoke<string>("cache_db_path"),
  fetchAccount: (query: string, limit: number, withContent: boolean) =>
    invoke<FetchAccountResult>("fetch_account", { query, limit, withContent }),
  fetchArticleContent: (aid: string, force = false) =>
    invoke<ArticleDetail>("fetch_article_content", { aid, force }),
}

export const onLoginSuccess = (cb: () => void) => listen("login://success", cb)
export const onLoginError = (cb: (msg: string) => void) =>
  listen<string>("login://error", (e) => cb(e.payload))
