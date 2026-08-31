import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

describe("license customer notes", () => {
  test("updates only the selected license customer field", async () => {
    const source = await readFile(
      new URL("../src/lib/cloud-license.ts", import.meta.url),
      "utf8"
    )
    const start = source.indexOf(
      "export async function updateCloudLicenseCustomer"
    )
    const end = source.indexOf(
      "\nexport async function resolveUserIdByEmail",
      start
    )
    const updateCustomer = source.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(updateCustomer).toContain("customer: nullableText(input.customer)")
    expect(updateCustomer).toContain(".update(payload)")
    expect(updateCustomer).toContain('.eq("id", licenseId)')
    expect(updateCustomer).not.toContain("upsertCloudLicense")
  })

  test("supports editing, clearing, and refreshing a note in the license list", async () => {
    const source = await readFile(
      new URL("../src/components/license-admin-panel.tsx", import.meta.url),
      "utf8"
    )
    const start = source.indexOf("function LicenseListDialog")
    const end = source.indexOf("\nfunction ErrorMessage", start)
    const dialog = source.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(dialog).toContain("await updateCloudLicenseCustomer")
    expect(dialog).toContain("customer: customerDraft")
    expect(dialog).toContain("await onRefresh()")
    expect(dialog).toContain('placeholder="可选，留空可删除备注"')
    expect(dialog).toContain("保存备注")
  })
})
