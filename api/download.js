const REPO = "lovstudio/wxmp-cracker-app"

const ASSET_PATTERNS = {
  "macos-arm64": {
    suffix: "-darwin-aarch64.dmg",
    contentType: "application/x-apple-diskimage",
  },
  "macos-x64": {
    suffix: "-darwin-x64.dmg",
    contentType: "application/x-apple-diskimage",
  },
  "windows-x64": { suffix: "-windows-x64.zip", contentType: "application/zip" },
  "linux-appimage": {
    suffix: "-linux-amd64.AppImage",
    contentType: "application/octet-stream",
  },
  "linux-deb": {
    suffix: "-linux-amd64.deb",
    contentType: "application/vnd.debian.binary-package",
  },
  "linux-rpm": {
    suffix: "-linux-x86_64.rpm",
    contentType: "application/x-rpm",
  },
}

let _cachedRelease = null
let _cachedAt = 0
const CACHE_TTL = 5 * 60 * 1000

async function getLatestRelease(token) {
  if (_cachedRelease && Date.now() - _cachedAt < CACHE_TTL)
    return _cachedRelease
  _cachedRelease = await fetchJson(
    `https://api.github.com/repos/${REPO}/releases/latest`,
    token
  )
  _cachedAt = Date.now()
  return _cachedRelease
}

export default async function handler(request, response) {
  const targetKey = getQueryValue(request.query?.target)
  const pattern = ASSET_PATTERNS[targetKey]

  if (!pattern) {
    response.status(404).json({ error: "Unknown download target." })
    return
  }

  const token =
    process.env.WXMP_RELEASE_TOKEN ??
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN

  try {
    const release = await getLatestRelease(token)
    const asset = release.assets?.find((item) =>
      item.name.endsWith(pattern.suffix)
    )

    if (!asset) {
      response.status(404).json({ error: "Download asset was not found." })
      return
    }

    if (!token) {
      response.writeHead(302, {
        "Cache-Control": "no-store",
        Location: asset.browser_download_url,
      })
      response.end()
      return
    }

    const assetResponse = await fetch(asset.url, {
      headers: githubHeaders(token, "application/octet-stream"),
      redirect: "manual",
    })
    const location = assetResponse.headers.get("location")

    if (location) {
      response.writeHead(302, {
        "Cache-Control": "private, max-age=300",
        "Content-Disposition": attachmentHeader(asset.name),
        Location: location,
      })
      response.end()
      return
    }

    if (!assetResponse.ok) {
      response.status(assetResponse.status).json({
        error: "GitHub asset download failed.",
      })
      return
    }

    const data = Buffer.from(await assetResponse.arrayBuffer())
    response.writeHead(200, {
      "Cache-Control": "private, max-age=300",
      "Content-Disposition": attachmentHeader(asset.name),
      "Content-Length": String(data.length),
      "Content-Type": pattern.contentType,
    })
    response.end(data)
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : "Download failed.",
    })
  }
}

function getQueryValue(value) {
  return Array.isArray(value) ? value[0] : value
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

function githubHeaders(token, accept) {
  const headers = {
    Accept: accept,
    "User-Agent": "wxmp-lovstudio-download",
    "X-GitHub-Api-Version": "2022-11-28",
  }

  if (token) headers.Authorization = `Bearer ${token}`

  return headers
}

function attachmentHeader(assetName) {
  return `attachment; filename="${assetName.replaceAll('"', "")}"`
}
