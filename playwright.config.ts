import { defineConfig, devices } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT ?? "3100";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: {
    timeout: 5_000
  },
  use: {
    baseURL,
    trace: "on-first-retry"
  },
  webServer: {
    command: [
      `PORT=${port}`,
      `NEXT_PUBLIC_SITE_URL=${baseURL}`,
      "REPORT_USE_MOCK_PROVIDERS=true",
      "REPORT_USE_INLINE_WORKER=true",
      "REPORT_USE_MEMORY_STORE=true",
      "npm run dev"
    ].join(" "),
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
