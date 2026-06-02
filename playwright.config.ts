import { defineConfig, devices } from "@playwright/test";
// Root-level Playwright config. The project-specific config (browser,
// viewport, etc.) lives in `tests/visual/playwright.config.ts`. This
// root config exists so that `pnpm exec playwright test` from the repo
// root discovers the visual tests AND runs them with the system Chrome
// (the same browser the user sees in production), since Playwright's
// downloaded Chromium isn't available in this offline environment.
//
// The two configs are kept in sync manually — if you change one,
// mirror the change in the other.
export default defineConfig({
  testDir: "tests/visual",
  testMatch: "**/*.spec.ts",
  use: {
    deviceScaleFactor: 1,
    viewport: { width: 1400, height: 900 },
    // Use the system Chrome rather than Playwright's downloaded
    // Chromium. The npm registry is offline in this environment, so
    // `playwright install` would fail. `channel: "chrome"` makes
    // Playwright use the stable Chrome on the host — same rendering
    // engine the user sees in production.
    channel: "chrome",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  snapshotPathTemplate: "{testDir}/baselines/{arg}-{platform}.png",
});
