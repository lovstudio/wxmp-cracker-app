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

export type ArticleMatchField = "title" | "digest" | "author" | "content"

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
  match_fields?: ArticleMatchField[]
  match_excerpt?: string | null
}

export interface ArticleDetail extends ArticleSummary {
  content_html: string | null
  content_md: string | null
}

export interface ArticleLocalFile {
  path: string
  exists: boolean
}

export interface ResolvedWechatImage {
  data_url: string
  content_type: string
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

export type FetchMode = "forward" | "backward" | "audit"

export interface AccountSearchResult {
  fakeid: string
  nickname: string
  alias: string | null
  signature: string | null
  avatar: string | null
}

export interface FetchAccountProgress {
  fakeid: string
  nickname: string
  stage: string
  status: string
  message: string
  current: number | null
  total: number | null
  title: string | null
}

export type LicenseKind = "trial" | "official"

export interface LicenseStatus {
  active: boolean
  kind: LicenseKind | null
  activated_at: number | null
  expires_at: number | null
  days_remaining: number | null
  customer: string | null
  license_id: string | null
  account_id: string | null
  current_account_id: string | null
  message: string
}

export const api = {
  authStatus: () => invoke<AuthStatus>("auth_status"),
  openLogin: () => invoke<void>("open_login"),
  licenseStatus: (accountId?: string | null) =>
    invoke<LicenseStatus>("license_status", { accountId: accountId ?? null }),
  activateLicense: (code: string, accountId: string) =>
    invoke<LicenseStatus>("activate_license", { code, accountId }),
  syncRemoteLicense: (accountId: string) =>
    invoke<LicenseStatus>("sync_remote_license", { accountId }),
  listAccounts: () => invoke<Account[]>("list_accounts"),
  listArticles: (fakeid: string) =>
    invoke<ArticleSummary[]>("list_articles", { fakeid }),
  searchArticles: (fakeid: string, query: string) =>
    invoke<ArticleSummary[]>("search_articles", { fakeid, query }),
  getArticle: (aid: string) =>
    invoke<ArticleDetail | null>("get_article", { aid }),
  cacheDbPath: () => invoke<string>("cache_db_path"),
  articleLocalFile: (aid: string) =>
    invoke<ArticleLocalFile | null>("article_local_file", { aid }),
  resolveWechatImage: (url: string) =>
    invoke<ResolvedWechatImage>("resolve_wechat_image", { url }),
  searchAccounts: (query: string) =>
    invoke<AccountSearchResult[]>("search_accounts", { query }),
  fetchAccount: (query: string, limit: number, withContent: boolean) =>
    invoke<FetchAccountResult>("fetch_account", { query, limit, withContent }),
  fetchSelectedAccount: (
    account: AccountSearchResult,
    limit: number,
    withContent: boolean,
    mode: FetchMode = "forward",
    auditDate?: string | null
  ) =>
    invoke<FetchAccountResult>("fetch_selected_account", {
      account,
      limit,
      withContent,
      mode,
      auditDate: auditDate ?? null,
    }),
  cancelFetchAccount: (fakeid: string) =>
    invoke<boolean>("cancel_fetch_account", { fakeid }),
  fetchArticleContent: (aid: string, force = false) =>
    invoke<ArticleDetail>("fetch_article_content", { aid, force }),

  // GitHub archive integration -------------------------------------------
  githubOauthStart: () => invoke<GhDeviceCodeStart>("github_oauth_start"),
  githubOauthPoll: (deviceCode: string) =>
    invoke<GhDevicePollOutcome>("github_oauth_poll", { deviceCode }),
  githubOauthStatus: () => invoke<GhOauthStatus>("github_oauth_status"),
  githubOauthLogout: () => invoke<void>("github_oauth_logout"),
  githubListRepos: () => invoke<GhRepoBrief[]>("github_list_repos"),
  githubCreateRepo: (name: string, isPrivate: boolean) =>
    invoke<GhRepoBrief>("github_create_repo", { name, private: isPrivate }),
  githubSyncSettingsGet: () =>
    invoke<GhSyncSettings>("github_sync_settings_get"),
  githubSyncSettingsSet: (settings: GhSyncSettings) =>
    invoke<GhSyncSettings>("github_sync_settings_set", { settings }),
  githubSyncArticles: (options: GhSyncOptions) =>
    invoke<GhSyncSummary>("github_sync_articles", { options }),
}

export const onLoginSuccess = (cb: () => void) => listen("login://success", cb)
export const onLoginError = (cb: (msg: string) => void) =>
  listen<string>("login://error", (e) => cb(e.payload))
export const onFetchAccountProgress = (
  cb: (progress: FetchAccountProgress) => void
) =>
  listen<FetchAccountProgress>("fetch-account://progress", (e) => cb(e.payload))
export const onGithubSyncProgress = (cb: (progress: GhSyncProgress) => void) =>
  listen<GhSyncProgress>("github-sync://progress", (e) => cb(e.payload))

// ---- GitHub types --------------------------------------------------------

export interface GhDeviceCodeStart {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export type GhDevicePollOutcome =
  | { kind: "authorized"; login: string; avatar_url: string }
  | { kind: "pending"; interval: number }
  | { kind: "denied"; message: string }

export interface GhOauthStatus {
  logged_in: boolean
  login: string | null
  avatar_url: string | null
}

export interface GhRepoBrief {
  full_name: string
  name: string
  owner: string
  private: boolean
  default_branch: string
  html_url: string
}

export interface GhSyncSettings {
  repo_full_name: string | null
  branch: string
  sync_images: boolean
  auto_push: boolean
  last_synced_at: number | null
  last_error: string | null
}

export interface GhSyncOptions {
  account_fakeid?: string | null
  force?: boolean
}

export interface GhSyncSummary {
  pushed: number
  skipped: number
  repo_html_url: string | null
  commit_message: string | null
}

export type GhSyncProgress =
  | { stage: "start"; total_candidates: number }
  | { stage: "prepare"; message: string }
  | { stage: "render"; current: number; total: number; title: string }
  | { stage: "image"; current: number; total: number; url: string }
  | { stage: "commit"; changed: number }
  | { stage: "push"; message: string }
  | { stage: "done"; pushed: number; skipped: number; message: string }
