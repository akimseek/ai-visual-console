import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./ui",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5174",
    browserName: "chromium",
    channel: "msedge",
    trace: "retain-on-failure"
  },
  outputDir: "test-results/playwright",
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 5174",
    url: "http://127.0.0.1:5174",
    reuseExistingServer: !process.env.CI
  }
});
