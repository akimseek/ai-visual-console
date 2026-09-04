import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "codexConsole", {
      configurable: true,
      value: {
        listProviders: async () => [{
          id: "codex",
          label: "Codex",
          capabilities: {
            skills: true,
            branch: true,
            usage: true,
            trash: true,
            batchActions: true,
            customCwd: true,
            export: true,
            sessionSettings: true,
            duplicate: true,
            vendorManagement: true
          }
        }],
        listCachedTargets: async () => [],
        listTargets: async () => [{
          id: "codex:local",
          provider: "codex",
          label: "Local Codex",
          kind: "local",
          available: true
        }],
        listCachedSessions: async () => [],
        listSessions: async () => [],
        listApiVendors: async () => [{
          id: "test-relay",
          providerId: "codex",
          name: "Test Relay",
          apiKey: "test-key",
          apiBaseUrl: "https://example.test/v1",
          sort: 1,
          configs: [],
          enabled: true,
          createdAt: "2026-09-04T00:00:00.000Z",
          updatedAt: "2026-09-04T00:00:00.000Z",
          balance: { remaining: 42.5, isValid: true },
          balanceStatus: "success"
        }],
        logPerformance: async () => undefined,
        getGatewayPort: async () => ({
          configuredPort: 0,
          activePort: 0,
          configuredFailureThreshold: 1,
          configuredCircuitFailureThreshold: 3,
          configuredCircuitDurationSeconds: 60
        }),
        listCompressionPrompts: async () => []
      }
    });
  });
  await page.goto("/");
});

test("opens core menus and overlays", async ({ page }) => {
  await expect(page.getByRole("navigation", { name: "应用菜单" })).toBeVisible();

  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  const settingsDialog = page.getByRole("dialog", { name: "设置" });
  await expect(settingsDialog).toBeVisible();
  await settingsDialog.getByRole("button", { name: "关闭" }).click();
  await expect(settingsDialog).toBeHidden();

  await page.getByRole("button", { name: "工具箱", exact: true }).click();
  await page.getByRole("menuitem", { name: "压缩提示", exact: true }).click();
  const compressionDialog = page.getByRole("dialog", { name: "压缩提示管理" });
  await expect(compressionDialog).toBeVisible();
  await compressionDialog.getByRole("button", { name: "关闭" }).click();
  await expect(compressionDialog).toBeHidden();
});

test("opens the vendor table for the selected target", async ({ page }) => {
  await page.locator(".target-picker select").first().selectOption("codex");
  await expect(page.getByRole("button", { name: "工具箱", exact: true })).toBeEnabled();

  await page.getByRole("button", { name: "工具箱", exact: true }).click();
  await page.getByRole("menuitem", { name: "供应商管理", exact: true }).click();
  const vendorDialog = page.getByRole("dialog", { name: "供应商管理" });
  await expect(vendorDialog).toBeVisible();
  await expect(vendorDialog.getByRole("columnheader", { name: "名称" })).toBeVisible();
  await expect(vendorDialog.getByRole("columnheader", { name: "余额" })).toBeVisible();
  await expect(vendorDialog.getByText("$42.50", { exact: true })).toBeVisible();
  await expect(vendorDialog.getByRole("switch", { name: "Test Relay已参与候选池" })).toHaveAttribute("aria-checked", "true");
  await vendorDialog.getByRole("button", { name: "关闭" }).click();
  await expect(vendorDialog).toBeHidden();
});
