const REPO = "lovstudio/wxmp-cracker-app"
const LATEST_JSON_URL = `https://github.com/${REPO}/releases/latest/download/latest.json`
const GITHUB_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`

const ASSET_TARGETS = [
  {
    key: "macos-arm64",
    platforms: ["darwin-aarch64", "darwin-aarch64-app"],
    suffix: "-darwin-aarch64.dmg",
  },
  {
    key: "macos-x64",
    platforms: ["darwin-x86_64", "darwin-x86_64-app"],
    suffix: "-darwin-x64.dmg",
  },
  {
    key: "windows-x64",
    platforms: ["windows-x86_64", "windows-x86_64-nsis", "windows-x86_64-msi"],
    suffix: "-windows-x64.zip",
  },
  {
    key: "linux-appimage",
    platforms: ["linux-x86_64", "linux-x86_64-appimage"],
    suffix: "-linux-amd64.AppImage",
  },
  {
    key: "linux-deb",
    platforms: ["linux-x86_64-deb"],
    suffix: "-linux-amd64.deb",
  },
  {
    key: "linux-rpm",
    platforms: ["linux-x86_64-rpm"],
    suffix: "-linux-x86_64.rpm",
  },
]

let _cachedPayload = null
let _cachedAt = 0
const CACHE_TTL = 5 * 60 * 1000

export default async function handler(request, response) {
  if (request.method && !["GET", "HEAD"].includes(request.method)) {
    response.setHeader("Allow", "GET, HEAD")
    response.status(405).json({ error: "Method not allowed." })
    return
  }

  const token =
    process.env.WXMP_RELEASE_TOKEN ??
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN

  try {
    const payload = await getReleasePayload(token)

    response.setHeader(
      "Cache-Control",
      "public, s-maxage=300, stale-while-revalidate=3600"
    )

    if (request.method === "HEAD") {
      response.status(200).end()
      return
    }

    response.status(200).json(payload)
  } catch (error) {
    response.setHeader("Cache-Control", "no-store")
    response.status(502).json({
      error: error instanceof Error ? error.message : "Release lookup failed.",
    })
  }
}

async function getReleasePayload(token) {
  if (_cachedPayload && Date.now() - _cachedAt < CACHE_TTL)
    return _cachedPayload

  try {
    const updater = await fetchJsonWithRetry(LATEST_JSON_URL, undefined, 3)
    _cachedPayload = updaterPayload(updater)
  } catch {
    const release = await fetchJson(GITHUB_RELEASE_URL, token)
    _cachedPayload = releasePayload(release)
  }

  _cachedAt = Date.now()
  return _cachedPayload
}

async function fetchJsonWithRetry(url, token, attempts) {
  let lastError = null

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetchJson(url, token)
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1) {
        await delay(250 * (attempt + 1))
      }
    }
  }

  throw lastError
}

async function fetchJson(url, token) {
  const result = await fetch(url, {
    headers: githubHeaders(token, "application/vnd.github+json"),
  })

  if (!result.ok) {
    throw new Error(`GitHub release lookup failed with ${result.status}.`)
  }

  return result.json()
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function githubHeaders(token, accept) {
  const headers = {
    Accept: accept,
    "User-Agent": "wxmp-lovstudio-release",
    "X-GitHub-Api-Version": "2022-11-28",
  }

  if (token) headers.Authorization = `Bearer ${token}`

  return headers
}

function releasePayload(release) {
  const tagName = release.tag_name ?? ""
  const publishedAt = release.published_at ?? release.created_at ?? ""

  return {
    version: tagName.replace(/^v/i, ""),
    tagName,
    releaseDate: formatReleaseDate(publishedAt),
    publishedAt,
    url: release.html_url,
    assets: ASSET_TARGETS.map((target) => releaseAsset(release, target)).filter(
      Boolean
    ),
  }
}

function updaterPayload(updater) {
  const version = String(updater.version ?? "").replace(/^v/i, "")
  const publishedAt = updater.pub_date ?? ""

  return {
    version,
    tagName: version ? `v${version}` : "",
    releaseDate: formatReleaseDate(publishedAt),
    publishedAt,
    url: version
      ? `https://github.com/${REPO}/releases/tag/v${version}`
      : `https://github.com/${REPO}/releases/latest`,
    assets: ASSET_TARGETS.map((target) => updaterAsset(updater, target)).filter(
      Boolean
    ),
  }
}

function releaseAsset(release, target) {
  const asset = release.assets?.find((item) =>
    item.name.endsWith(target.suffix)
  )
  if (!asset) return null

  return {
    target: target.key,
    name: asset.name,
    size: asset.size,
    updatedAt: asset.updated_at,
    downloadPath: `/api/download?target=${target.key}`,
  }
}

function updaterAsset(updater, target) {
  const item = target.platforms
    .map((platform) => updater.platforms?.[platform])
    .find(Boolean)

  if (!item?.url) return null

  return {
    target: target.key,
    name: item.url.split("/").pop(),
    size: null,
    updatedAt: updater.pub_date,
    downloadPath: `/api/download?target=${target.key}`,
  }
}

function formatReleaseDate(value) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""

  return date.toISOString().slice(0, 10)
}
