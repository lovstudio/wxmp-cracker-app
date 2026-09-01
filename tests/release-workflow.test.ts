import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

describe("release workflow packaging", () => {
  test("keeps the Windows desktop executable next to its wcx sidecar", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8"
    )

    expect(workflow).toContain(
      "Compress-Archive -Path @($exe.FullName, $wcx.FullName)"
    )
    expect(workflow).toContain(
      "Windows ZIP must contain the application executable and wcx.exe sidecar"
    )
    expect(workflow).toContain("& $packagedWcx.FullName --version")
  })

  test("downloads previous and current macOS archives by their own versions", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8"
    )

    expect(workflow).toContain('local previous_asset="$2"')
    expect(workflow).toContain('local current_asset="$3"')
    expect(workflow).toContain(
      'gh release download "$PREVIOUS_TAG" --repo "$REPO" --pattern "$previous_asset"'
    )
    expect(workflow).toContain(
      'gh release download "$TAG" --repo "$REPO" --pattern "$current_asset"'
    )
    expect(workflow).toContain(
      '"wxmp-cracker-app-${PREVIOUS_TAG#v}-darwin-aarch64.app.tar.gz"'
    )
    expect(workflow).toContain(
      '"wxmp-cracker-app-${VERSION}-darwin-aarch64.app.tar.gz"'
    )
    expect(workflow).toContain(
      '"wxmp-cracker-app-${PREVIOUS_TAG#v}-darwin-x64.app.tar.gz"'
    )
    expect(workflow).toContain(
      '"wxmp-cracker-app-${VERSION}-darwin-x64.app.tar.gz"'
    )
  })
})
