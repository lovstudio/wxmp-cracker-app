import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

describe("account setup presentation", () => {
  test("manual setup actions open a dialog without changing workspace tabs", async () => {
    const source = await readFile(
      new URL("../src/WorkspaceApp.tsx", import.meta.url),
      "utf8"
    )
    const handlerStart = source.indexOf("const openSetupDialog = useCallback")
    const handlerEnd = source.indexOf("\n  const ", handlerStart + 1)
    const handler = source.slice(handlerStart, handlerEnd)

    expect(handlerStart).toBeGreaterThan(-1)
    expect(handler).toContain("setSetupPanelOpen(true)")
    expect(handler).not.toContain("setActiveTab")
    expect(source.match(/onOpenSetup=\{openSetupDialog\}/g)).toHaveLength(2)
    expect(source).toContain("<GettingStartedDialog")
    expect(source).toContain("open={setupPanelOpen}")
    expect(source).toContain("onOpenChange={setSetupPanelOpen}")
  })

  test("the setup dialog uses the shared dialog primitive", async () => {
    const source = await readFile(
      new URL("../src/components/getting-started-panel.tsx", import.meta.url),
      "utf8"
    )
    const dialogStart = source.indexOf("export function GettingStartedDialog")
    const dialog = source.slice(dialogStart)

    expect(dialogStart).toBeGreaterThan(-1)
    expect(dialog).toContain("<Dialog open={open}")
    expect(dialog).toContain("<DialogContent")
    expect(dialog).toContain("<DialogTitle>账号准备</DialogTitle>")
    expect(dialog).toContain('presentation="dialog"')
  })
})
