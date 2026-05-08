const REPO = "lovstudio/wxmp-cracker-app"
const RELEASE_TAG = "v0.1.3"
const GITHUB_RELEASE_URL = `https://github.com/${REPO}/releases/download/${RELEASE_TAG}`

const DOWNLOAD_TARGETS = {
  "macos-arm64": {
    assetName: "wxmp-cracker-app-0.1.3-darwin-aarch64.dmg",
    contentType: "application/x-apple-diskimage",
  },
  "macos-x64": {
    assetName: "wxmp-cracker-app-0.1.3-darwin-x64.dmg",
    contentType: "application/x-apple-diskimage",
  },
  "windows-x64": {
    assetName: "wxmp-cracker-app-v0.1.3-windows-x64.zip",
    contentType: "application/zip",
  },
  "linux-appimage": {
    assetName: "wxmp-cracker-app-0.1.3-linux-amd64.AppImage",
    contentType: "application/octet-stream",
  },
  "linux-deb": {
    assetName: "wxmp-cracker-app-0.1.3-linux-amd64.deb",
    contentType: "application/vnd.debian.binary-package",
  },
  "linux-rpm": {
    assetName: "wxmp-cracker-app-0.1.3-linux-x86_64.rpm",
    contentType: "application/x-rpm",
  },
}

export default async function handler(request, response) {
  const targetKey = getQueryValue(request.query?.target)
  const target = DOWNLOAD_TARGETS[targetKey]

  if (!target) {
    response.status(404).json({ error: "Unknown download target." })
    return
  }

  const token =
    process.env.WXMP_RELEASE_TOKEN ??
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN

  if (!token) {
    redirectToPublicReleaseAsset(response, target.assetName)
    return
  }

  try {
    const release = await fetchJson(
      `https://api.github.com/repos/${REPO}/releases/tags/${RELEASE_TAG}`,
      token
    )
    const asset = release.assets?.find((item) => item.name === target.assetName)

    if (!asset) {
      response.status(404).json({ error: "Download asset was not found." })
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
      "Content-Type": target.contentType,
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
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "User-Agent": "wxmp-lovstudio-download",
    "X-GitHub-Api-Version": "2022-11-28",
  }
}

function redirectToPublicReleaseAsset(response, assetName) {
  response.writeHead(302, {
    "Cache-Control": "no-store",
    Location: `${GITHUB_RELEASE_URL}/${assetName}`,
  })
  response.end()
}

function attachmentHeader(assetName) {
  return `attachment; filename="${assetName.replaceAll('"', "")}"`
}
