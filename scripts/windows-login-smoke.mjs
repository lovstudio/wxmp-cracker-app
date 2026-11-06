#!/usr/bin/env node
// Drives a packaged Windows build through the WeChat login window lifecycle on
// a real WebView2 desktop. The app is exercised as shipped: commands go through
// the main webview's real IPC, and the window is closed with the same system
// command the title bar X sends. No QR code is scanned; the post-scan step
// replays the redirect with a throwaway session cookie. It then checks that the
// wcx engine, a separate program, finds that kind of login and the app's cache.
//
// Usage: node scripts/windows-login-smoke.mjs <path-to-app.exe> <output-dir>
// CI only: the replay overwrites the machine's WeChat login with a fake one, and it
// needs WebView2's debugging port on 9222. See .github/workflows/windows-login-smoke.yml.
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"

const [exeArg, outArg = "windows-login-smoke"] = process.argv.slice(2)
if (!exeArg) {
  console.error("usage: windows-login-smoke.mjs <path-to-app.exe> <output-dir>")
  process.exit(2)
}
if (process.env.CI !== "true") {
  console.error("refusing to run outside CI: this replaces the machine's WeChat login with a fake one")
  process.exit(2)
}

const exe = resolve(exeArg)
const outDir = resolve(outArg)
const CDP_PORT = 9222
const CDP = `http://127.0.0.1:${CDP_PORT}`
const LOGIN_TITLE = "微信公众号登录"
const OPEN_TIMEOUT_MS = 30_000
const CLOSE_TIMEOUT_MS = 15_000
const HEALTH_TIMEOUT_MS = 15_000
// A runner that has just finished building can keep the renderer busy for 20 s.
const BOOT_TIMEOUT_MS = 120_000
const QR_TIMEOUT_MS = 45_000
// Longer than the app's cookie retry window (20 attempts, 500 ms apart).
const CAPTURE_SETTLE_MS = 12_000
const ENGINE_TIMEOUT_MS = 90_000
const TOKEN_URL = (token) =>
  `https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=${token}&lang=zh_CN`
// Where platformdirs sends wcx on Windows. `wcx status` has to report the same place.
const ENGINE_DIR = join(process.env.LOCALAPPDATA ?? "", "wcx", "wcx")
const ENGINE_CONFIG = join(ENGINE_DIR, "config.json")
const ENGINE_CACHE = join(ENGINE_DIR, "cache.db")
const LEGACY_CACHE = join(process.env.APPDATA ?? "", "wcx", "cache.db")
const LOG_DIR = join(process.env.LOCALAPPDATA ?? homedir(), "ai.lovstudio.wxmp-cracker", "logs")
const SEEDED_ACCOUNT = { fakeid: "smoke-upgrade", nickname: "升级前的账号" }
const SEARCH_QUERY = "测试公众号"
// Needs Chinese in its body text: many articles are only images.
const PUBLIC_ARTICLE = "https://mp.weixin.qq.com/s/3h4RsEa8-IpJb2TSA5LV2Q"
const ENGINE_BROKEN = /codec|charmap|UTF-8|curl: \(77\)|意外结束|提前退出|解析 wcx|尚未登录/
// Everyone whose Windows user name is Chinese has a temp directory like this, and the
// frozen engine unpacks its certificates there.
const HAN_TEMP = "C:\\微探临时目录"
const APP_ENV = { ...process.env, TEMP: HAN_TEMP, TMP: HAN_TEMP }

const steps = []
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function record(name, ok, detail) {
  steps.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`)
  return ok
}

async function until(probe, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() >= deadline) return null
    await sleep(intervalMs)
  }
}

function powershell(script, timeout = 60_000) {
  const body = `$ProgressPreference='SilentlyContinue'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n${script}`
  return execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(body, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", timeout, windowsHide: true }
  )
}

const WIN32 = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class SmokeWin {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsHungAppWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
  public static string[] List(uint target) {
    var rows = new List<string>();
    EnumWindows((hwnd, _) => {
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (pid == target && IsWindowVisible(hwnd)) {
        var text = new StringBuilder(512);
        GetWindowTextW(hwnd, text, text.Capacity);
        rows.Add(hwnd.ToInt64() + "\t" + IsHungAppWindow(hwnd) + "\t" + text);
      }
      return true;
    }, IntPtr.Zero);
    return rows.ToArray();
  }
}
'@
`

function appWindows(pid) {
  const output = powershell(`${WIN32}\n[SmokeWin]::List(${pid})`)
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((row) => {
      const [hwnd, hung, ...title] = row.split("\t")
      return { hwnd, hung: hung === "True", title: title.join("\t") }
    })
}

// WM_SYSCOMMAND + SC_CLOSE is what the title bar X button sends.
function pressTitleBarClose(hwnd) {
  powershell(`${WIN32}\n[void][SmokeWin]::PostMessageW([IntPtr]${hwnd}, 0x0112, [IntPtr]0xF060, [IntPtr]0)`)
}

function desktopScreenshot(name) {
  const path = join(outDir, `${name}.png`)
  try {
    powershell(String.raw`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$canvas = [System.Drawing.Graphics]::FromImage($bitmap)
$canvas.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save('${path.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
`)
  } catch (error) {
    console.log(`note: desktop screenshot ${name} failed: ${String(error.message).split("\n")[0]}`)
  }
}

class Cdp {
  #socket
  #nextId = 0
  #pending = new Map()

  static connect(url) {
    return new Promise((done, fail) => {
      const socket = new WebSocket(url)
      socket.onopen = () => done(new Cdp(socket))
      socket.onerror = () => fail(new Error(`CDP connection failed: ${url}`))
    })
  }

  constructor(socket) {
    this.#socket = socket
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data)
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      if (message.error) pending.fail(new Error(message.error.message))
      else pending.done(message.result)
    }
    socket.onclose = () => {
      for (const pending of this.#pending.values()) pending.fail(new Error("CDP target closed"))
      this.#pending.clear()
    }
  }

  send(method, params = {}, timeoutMs = 30_000) {
    return new Promise((done, fail) => {
      const id = ++this.#nextId
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        fail(new Error(`CDP ${method} timed out`))
      }, timeoutMs)
      this.#pending.set(id, {
        done: (value) => (clearTimeout(timer), done(value)),
        fail: (error) => (clearTimeout(timer), fail(error)),
      })
      this.#socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression, timeoutMs = 30_000) {
    const { result, exceptionDetails } = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      timeoutMs
    )
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    return result.value
  }

  close() {
    this.#socket.close()
  }
}

async function targets() {
  try {
    return await (await fetch(`${CDP}/json/list`)).json()
  } catch {
    return []
  }
}

const hostOf = ({ url }) => {
  try {
    return new URL(url).hostname
  } catch {
    return ""
  }
}
const isPage = ({ type }) => type === "page" || type === "webview"
const mainTarget = async () => (await targets()).find((t) => isPage(t) && hostOf(t) === "tauri.localhost")
const loginTarget = async () => (await targets()).find((t) => isPage(t) && hostOf(t).endsWith("qq.com"))

function invoke(main, command, args = {}, timeoutMs = HEALTH_TIMEOUT_MS) {
  return main
    .evaluate(
      `(async () => {
        const started = performance.now()
        const timeout = new Promise((done) => setTimeout(() => done({ status: "timeout" }), ${timeoutMs}))
        const call = window.__TAURI__.core.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}).then(
          (value) => ({ status: "ok", value }),
          (error) => ({ status: "error", error: error?.message ?? String(error) })
        )
        const result = await Promise.race([call, timeout])
        return { ...result, elapsedMs: Math.round(performance.now() - started) }
      })()`,
      timeoutMs + 15_000
    )
    .catch((error) => ({ status: "no-answer", error: error.message }))
}

const summarize = ({ status, elapsedMs, error }) => ({ status, elapsedMs, ...(error ? { error } : {}) })

// A URL only proves a navigation started; scanning needs the QR image itself.
async function waitForQrCode(page) {
  const started = Date.now()
  const qr = await until(
    () =>
      page
        .evaluate(`(() => {
          const image = [...document.images].find((candidate) => candidate.src.includes("scanloginqrcode"))
          return image?.complete && image.naturalWidth > 0
            ? { width: image.naturalWidth, height: image.naturalHeight }
            : null
        })()`)
        .catch(() => null),
    QR_TIMEOUT_MS
  )
  const pageState = await page
    .evaluate(`({
      title: document.title,
      readyState: document.readyState,
      text: document.body?.innerText?.replace(/\\s+/g, " ").slice(0, 200),
      images: [...document.images].slice(0, 8).map((image) => ({ src: image.src.slice(0, 80), width: image.naturalWidth })),
    })`)
    .catch((error) => ({ error: error.message }))
  return { qr, elapsedMs: Date.now() - started, ...pageState }
}

const pageScreenshot = async (cdp, name) => {
  try {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" })
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, "base64"))
  } catch (error) {
    console.log(`note: page screenshot ${name} failed: ${error.message}`)
  }
}

async function explainMissingCdp() {
  desktopScreenshot("00-no-cdp")
  const version = await fetch(`${CDP}/json/version`).then((r) => r.text()).catch((e) => `unreachable: ${e.cause?.code ?? e.message}`)
  console.log(`/json/version: ${version}`)
  console.log(`/json/list: ${JSON.stringify(await targets())}`)
  console.log(
    powershell(`
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -in 9222 | Format-Table -AutoSize | Out-String
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object { $_.CommandLine } | Out-String
`)
  )
}

// What an upgrading user has on disk: earlier releases kept the cache in %APPDATA%.
function seedLegacyCache() {
  mkdirSync(dirname(LEGACY_CACHE), { recursive: true })
  const db = new DatabaseSync(LEGACY_CACHE)
  db.exec(`CREATE TABLE accounts (
    fakeid TEXT PRIMARY KEY,
    nickname TEXT NOT NULL,
    alias TEXT,
    signature TEXT,
    round_head_img TEXT,
    updated_at INTEGER NOT NULL
  )`)
  db.prepare("INSERT INTO accounts (fakeid, nickname, updated_at) VALUES (?, ?, 1)").run(
    SEEDED_ACCOUNT.fakeid,
    SEEDED_ACCOUNT.nickname
  )
  db.close()
}

// The engine's own view of this machine, with no help from the app.
function engineStatus() {
  const { status, stdout, stderr, error } = spawnSync(join(dirname(exe), "wcx.exe"), ["status"], {
    encoding: "utf8",
    timeout: ENGINE_TIMEOUT_MS,
    windowsHide: true,
    // Wide enough that the report does not wrap the paths it prints.
    env: { ...APP_ENV, COLUMNS: "400" },
  })
  const text = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
  const count = (label) => Number(text.match(new RegExp(`${label}\\D*(\\d+)`))?.[1] ?? -1)
  return {
    exitCode: status,
    text,
    accounts: count("缓存账号数"),
    articles: count("缓存文章数"),
    stderr: String(stderr ?? "").slice(-500) || undefined,
    spawnError: error?.message,
  }
}

const appLogs = () =>
  existsSync(LOG_DIR)
    ? readdirSync(LOG_DIR)
        .map((name) => readFileSync(join(LOG_DIR, name), "utf8"))
        .join("\n")
    : ""

let app
let appExit = null

const appAlive = () => appExit === null
const loginWindow = (windows = appWindows(app.pid)) => windows.find((w) => w.title.includes(LOGIN_TITLE))

async function closeLoginWindow() {
  const window = loginWindow()
  if (!window) return { closed: true, note: "no login window" }
  pressTitleBarClose(window.hwnd)
  const started = Date.now()
  const closed = await until(() => !appAlive() || !loginWindow(), CLOSE_TIMEOUT_MS)
  return { closed: Boolean(closed) && appAlive(), elapsedMs: Date.now() - started, appAlive: appAlive() }
}

async function openLoginAndLoad(main) {
  const opened = await invoke(main, "open_login", {}, OPEN_TIMEOUT_MS)
  const window = await until(() => loginWindow(), 10_000)
  const target = opened.status === "ok" ? await until(loginTarget, OPEN_TIMEOUT_MS) : await loginTarget()
  return { opened, window, target }
}

async function run() {
  seedLegacyCache()
  mkdirSync(HAN_TEMP, { recursive: true })
  const launchedAt = Date.now()
  const stdio = openSync(join(outDir, "app-output.log"), "a")
  app = spawn(exe, [], { stdio: ["ignore", stdio, stdio], env: APP_ENV })
  app.on("exit", (code, signal) => {
    appExit = { code, signal, afterMs: Date.now() - launchedAt }
    console.log(`app exited: ${JSON.stringify(appExit)}`)
  })

  const target = await until(mainTarget, 45_000, 1_000)
  if (!record("main webview exposes CDP", Boolean(target), { pid: app.pid })) {
    await explainMissingCdp()
    return
  }
  const main = await Cdp.connect(target.webSocketDebuggerUrl)
  const health =
    (await until(async () => {
      const ready = await main
        .evaluate(`document.readyState === "complete" && typeof window.__TAURI__?.core?.invoke === "function"`, 10_000)
        .catch(() => false)
      if (!ready) return null
      const answer = await invoke(main, "cache_db_path")
      return answer.status === "ok" ? answer : null
    }, BOOT_TIMEOUT_MS)) ?? { status: "no-ipc" }
  const bootMs = Date.now() - launchedAt
  if (!record("app boots and IPC answers", health.status === "ok", { ...summarize(health), bootMs })) return
  desktopScreenshot("01-booted")
  const upgraded = await invoke(main, "list_accounts")
  record(
    "an upgrading user's cache moves to where the engine reads it",
    Boolean(upgraded.value?.some((account) => account.nickname === SEEDED_ACCOUNT.nickname)) &&
      !existsSync(LEGACY_CACHE) &&
      existsSync(ENGINE_CACHE),
    { ...summarize(upgraded), legacyLeftBehind: existsSync(LEGACY_CACHE), atEnginePath: existsSync(ENGINE_CACHE) }
  )

  // 1. The reported bug: opening the window must not take the main thread with it.
  const first = await openLoginAndLoad(main)
  const windowsAfterOpen = appWindows(app.pid)
  record("open_login returns", first.opened.status === "ok", summarize(first.opened))
  record("login window is on screen", Boolean(first.window), windowsAfterOpen)
  record("login page opens in WebView2", Boolean(first.target), first.target?.url)
  const healthWhileOpen = await invoke(main, "cache_db_path")
  record("main thread still answers IPC with the window open", healthWhileOpen.status === "ok", summarize(healthWhileOpen))
  if (first.target) {
    const page = await Cdp.connect(first.target.webSocketDebuggerUrl)
    const scan = await waitForQrCode(page)
    record("QR code renders and can be scanned", Boolean(scan.qr), scan)
    await pageScreenshot(page, "02-login-page")
    page.close()
  }
  desktopScreenshot("02-login-open")

  // 2. The window must close from the title bar.
  const firstClose = await closeLoginWindow()
  record("title bar close removes the login window", firstClose.closed, firstClose)
  desktopScreenshot("03-after-close")
  if (!firstClose.closed || !appAlive()) return
  const healthAfterClose = await invoke(main, "cache_db_path")
  record("app keeps working after the close", healthAfterClose.status === "ok", summarize(healthAfterClose))

  // 3. Reopening works, and a double click does not stack windows.
  const [openA, openB] = await Promise.all([
    invoke(main, "open_login", {}, OPEN_TIMEOUT_MS),
    invoke(main, "open_login", {}, OPEN_TIMEOUT_MS),
  ])
  const reopenedWindow = await until(() => loginWindow(), 10_000)
  await sleep(2_000)
  const loginWindows = appWindows(app.pid).filter((w) => w.title.includes(LOGIN_TITLE))
  record(
    "concurrent opens end with exactly one login window",
    openA.status === "ok" && openB.status === "ok" && Boolean(reopenedWindow) && loginWindows.length === 1,
    { a: summarize(openA), b: summarize(openB), windows: loginWindows.length }
  )
  const reopenedTarget = await until(loginTarget, OPEN_TIMEOUT_MS)
  record("reopened window loads the login page", Boolean(reopenedTarget), reopenedTarget?.url)
  if (!reopenedTarget) return

  // 4. Closing while the post-scan cookie capture is still retrying must not take
  // the app down. No session cookie exists yet, so the capture keeps polling.
  const events = `window.__smokeEvents`
  await main.evaluate(`(async () => {
    ${events} = []
    await window.__TAURI__.event.listen("login://success", (e) => ${events}.push({ event: "success", token: e.payload?.token, hasSessionCookie: String(e.payload?.cookie).includes("slave_sid=") }))
    await window.__TAURI__.event.listen("login://error", (e) => ${events}.push({ event: "error", message: String(e.payload) }))
  })()`)
  const capturePage = await Cdp.connect(reopenedTarget.webSocketDebuggerUrl)
  // Like a person, wait for the QR code: a redirect sent while the page is still
  // loading loses to that load and never reaches the app.
  await waitForQrCode(capturePage)
  await capturePage.evaluate(`location.href = ${JSON.stringify(TOKEN_URL("smoke-close"))}; 0`).catch(() => {})
  await sleep(1_500)
  capturePage.close()
  const midCaptureClose = await closeLoginWindow()
  record("title bar close works during cookie capture", midCaptureClose.closed, midCaptureClose)
  await until(() => !appAlive(), CAPTURE_SETTLE_MS)
  record("app survives a close during cookie capture", appAlive(), appExit ?? undefined)
  if (!appAlive()) return
  const healthAfterCapture = await invoke(main, "cache_db_path")
  const eventsAfterClose = await main.evaluate(events)
  record(
    "closing during capture stays quiet",
    healthAfterCapture.status === "ok" && eventsAfterClose.length === 0,
    { health: summarize(healthAfterCapture), events: eventsAfterClose }
  )

  // 5. The post-scan path: redirect with a token, cookies captured, config written,
  // success event delivered and the window closing itself.
  const finalOpen = await openLoginAndLoad(main)
  if (!record("window opens for the post-scan replay", Boolean(finalOpen.target), summarize(finalOpen.opened))) return
  const scanPage = await Cdp.connect(finalOpen.target.webSocketDebuggerUrl)
  await waitForQrCode(scanPage)
  await scanPage.send("Network.enable")
  await scanPage.send("Network.setCookie", {
    name: "slave_sid",
    value: "smoke-test-not-a-session",
    url: "https://mp.weixin.qq.com/",
    secure: true,
    httpOnly: true,
  })
  await scanPage.evaluate(`location.href = ${JSON.stringify(TOKEN_URL("smoke-success"))}; 0`).catch(() => {})
  const outcome = await until(async () => (await main.evaluate(events))[0], 30_000)
  scanPage.close()
  // The app emits this only after writing the wcx config, and the UI then discards
  // the fake session on its next check, so the event is the stable proof.
  record(
    "post-scan redirect captures the session and reports success",
    outcome?.event === "success" && outcome.token === "smoke-success" && outcome.hasSessionCookie === true,
    outcome
  )
  const selfClosed = await until(() => !loginWindow(), CLOSE_TIMEOUT_MS)
  record("login window closes itself after capture", Boolean(selfClosed))
  const healthAtEnd = await invoke(main, "cache_db_path")
  record("app keeps working after login", appAlive() && healthAtEnd.status === "ok", summarize(healthAtEnd))
  desktopScreenshot("04-after-login")

  // 6. The engine is a separate program: a login and a cache only help if it finds
  // them. The UI discards the replay's fake session on its next check, so wait for
  // that, then put down a login that nothing touches until the UI's next poll. The
  // Chinese nickname is what a real account has and what Windows code pages choke on.
  await until(() => !existsSync(ENGINE_CONFIG), 20_000)
  mkdirSync(ENGINE_DIR, { recursive: true })
  writeFileSync(
    ENGINE_CONFIG,
    JSON.stringify({
      token: "smoke-engine",
      cookie: "slave_sid=smoke-test-not-a-session; slave_user=gh_smoke",
      last_login_at: Math.floor(Date.now() / 1000),
      account: { nickname: "测试账号" },
    })
  )
  const appCacheDb = await invoke(main, "cache_db_path")
  const engine = engineStatus()
  console.log(`wcx status: ${JSON.stringify(engine)}`)
  record(
    "engine and app agree on where the login and cache live",
    engine.exitCode === 0 && appCacheDb.value === ENGINE_CACHE && engine.text.includes(ENGINE_CACHE) && engine.text.includes(ENGINE_DIR),
    { app: appCacheDb.value, engineExit: engine.exitCode, engineError: engine.stderr }
  )
  record("engine finds the login", engine.text.includes("已登录"), { engineExit: engine.exitCode })
  record("engine sees the app's cache", engine.accounts >= 1, { accounts: engine.accounts })

  // WeChat refuses a throwaway session, and getting that far means the engine read the
  // login, sent the request and carried the answer back to the app.
  const search = await invoke(main, "search_accounts", { query: SEARCH_QUERY }, ENGINE_TIMEOUT_MS)
  record(
    "engine uses the login to reach WeChat",
    search.status === "error" && /Auth failed|API error ret=|HTTP \d{3}/.test(search.error),
    summarize(search)
  )
  const decoded = await until(() => appLogs().includes(`query_chars=${SEARCH_QUERY.length} `), 5_000)
  record("engine receives Chinese text intact", Boolean(decoded))

  const authStatus = await invoke(main, "auth_status", {}, ENGINE_TIMEOUT_MS)
  record(
    "app reads the same login",
    authStatus.status === "ok" && (authStatus.value.logged_in || authStatus.value.expired),
    { ...summarize(authStatus), loggedIn: authStatus.value?.logged_in, expired: authStatus.value?.expired }
  )

  // No login needed. WeChat may refuse a data center, which says nothing about the
  // engine, as long as the refusal comes back in one readable piece.
  const imported = await invoke(main, "import_article_link", { link: PUBLIC_ARTICLE }, ENGINE_TIMEOUT_MS)
  const stored =
    imported.status === "ok" && /\p{Script=Han}/u.test(imported.value.title) && /\p{Script=Han}/u.test(imported.value.content_md ?? "")
  const refused = imported.status === "error" && !ENGINE_BROKEN.test(imported.error)
  record("a public article comes through the engine in readable Chinese", stored || refused, {
    ...summarize(imported),
    title: imported.value?.title,
    contentChars: imported.value?.content_md?.length,
  })
  if (stored) {
    const afterImport = engineStatus()
    record("engine sees the article the app stored", afterImport.articles >= 1, { articles: afterImport.articles })
  }

  const engineStarts = appLogs().split("daemon_spawn_start").length - 1
  record("the resident engine survives all of it", appAlive() && engineStarts === 1, { appAlive: appAlive(), engineStarts })
  desktopScreenshot("05-after-engine")
  main.close()
}

mkdirSync(outDir, { recursive: true })
let fatal = null
try {
  await run()
} catch (error) {
  fatal = error
  record("smoke script finished", false, String(error?.stack ?? error))
}

if (app?.pid && appAlive()) {
  const windows = appWindows(app.pid)
  console.log(`windows before stopping the app: ${JSON.stringify(windows)}`)
  // A hang has to be attributable: record what the process looked like before the kill.
  writeFileSync(join(outDir, "final-windows.json"), JSON.stringify(windows, null, 2))
  try {
    execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { windowsHide: true })
  } catch (error) {
    console.log(`note: taskkill failed: ${String(error.message).split("\n")[0]}`)
  }
}

if (existsSync(LOG_DIR)) cpSync(LOG_DIR, join(outDir, "app-logs"), { recursive: true })

const failed = steps.filter((step) => !step.ok)
writeFileSync(join(outDir, "report.json"), JSON.stringify({ exe, appExit, steps }, null, 2))
console.log(`\n${steps.length - failed.length}/${steps.length} checks passed${fatal ? " (script aborted)" : ""}`)
process.exit(failed.length === 0 ? 0 : 1)
