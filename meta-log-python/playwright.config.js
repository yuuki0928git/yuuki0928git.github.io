import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "*.spec.js",
  timeout: 90000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4180" },
  webServer: {
    command: "python3 -m http.server 4180 --bind 127.0.0.1 --directory web",
    url: "http://127.0.0.1:4180",
    reuseExistingServer: true,
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
