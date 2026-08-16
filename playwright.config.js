import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    // 用系统 Edge（Chromium 内核），零浏览器下载
    channel: "msedge",
    baseURL: "http://127.0.0.1:9721",
    headless: true,
  },
  webServer: {
    command: "node e2e/e2e-server.mjs",
    url: "http://127.0.0.1:9721",
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
