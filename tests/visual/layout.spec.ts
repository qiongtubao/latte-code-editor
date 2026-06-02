// TODO: extend this test to cover the full three-pane layout once the
// file tree (left) and right panel (Outline) are added. For now it
// screenshots the current app shell — Monaco editor + status bar.
import { test, expect } from "@playwright/test";

test("editor shell layout", async ({ page }) => {
  await page.goto("http://127.0.0.1:1420");
  await page.waitForSelector("[data-testid=app-shell]");
  const shell = page.locator("[data-testid=app-shell]");
  await expect(shell).toBeVisible();
  // Monaco is lazy-loaded by @monaco-editor/react and writes its
  // initial line into the DOM after the first paint frame. Without
  // this wait the screenshot is captured before the gutter/view
  // renders, which produces a "blank editor" baseline that does not
  // reflect what users see.
  await page.waitForSelector(".view-lines");
  await page.waitForFunction(() => {
    const el = document.querySelector(".view-lines");
    return !!el && !!el.textContent && el.textContent.length > 0;
  });
  // Give one more paint frame to flush so syntax-highlighted spans
  // have their final colors.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await expect(shell).toHaveScreenshot("three-pane.png", { maxDiffPixelRatio: 0.02 });
});
