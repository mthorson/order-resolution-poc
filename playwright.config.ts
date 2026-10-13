import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests", testMatch: "ui.review.spec.ts", workers: 1,
  use: { baseURL: "http://127.0.0.1:3011", viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure" },
  webServer: { command: "node tests/helpers/start-ui-test.ts --port 3011", url: "http://127.0.0.1:3011", reuseExistingServer: false, timeout: 30000 },
});
