import { test, expect } from "@playwright/test";

test("three-pane layout", async ({ page }) => {
  await page.goto("http://127.0.0.1:1420");
  await page.waitForSelector("text=Outline");
  await expect(page).toHaveScreenshot("three-pane.png", { fullPage: false, maxDiffPixelRatio: 0.02 });
});
