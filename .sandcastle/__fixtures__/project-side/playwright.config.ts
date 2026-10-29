// Reference copy of the timeouts a project's Playwright config sets. See README.txt.
// Read as TEXT by lib/harness/timeout-budget-contract.test.ts.
export default {
  timeout: 240_000,
  use: {
    baseURL: "http://127.0.0.1:4001",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:4001",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: "chromium" }],
};
