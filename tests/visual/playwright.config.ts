import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  use: { deviceScaleFactor: 1, viewport: { width: 1400, height: 900 } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  snapshotPathTemplate: "{testDir}/baselines/{arg}-{platform}.png",
});
