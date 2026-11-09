import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "browser.spec.js",
  webServer: {
    command: "python3 -m http.server 4173 --bind 127.0.0.1",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
  },
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 820, height: 1180 },
    hasTouch: true,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
    {
      name: "ipad-webkit",
      use: {
        ...devices["iPad (gen 7)"],
        browserName: "webkit",
        locale: "ja-JP",
      },
    },
  ],
});
