#!/usr/bin/env python3
"""皮肤功能验证截图：默认深色 + github-light + solarized-light + monokai。
通过 addInitScript 预置 localStorage latte-settings（zustand persist 格式）换肤。"""

import json
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = "http://localhost:1420"
OUT = Path("/home/dong/Documents/latte/latte-code-editor/screenshots")

SKINS = ["default", "github-light", "solarized-light", "monokai"]

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for skin in SKINS:
            page = browser.new_page(viewport={"width": 1920, "height": 1080})
            if skin != "default":
                state = {"state": {"skin": skin}, "version": 0}
                page.add_init_script(
                    f"localStorage.setItem('latte-settings', {json.dumps(json.dumps(state))})"
                )
            page.goto(URL, wait_until="networkidle", timeout=30000)
            page.wait_for_timeout(1500)
            if skin == "github-light":
                # 打开 chat 面板验证 iframe 跟随换肤
                page.click("text=Chat")
                page.wait_for_timeout(2500)
            path = OUT / f"skin-{skin}.png"
            page.screenshot(path=str(path), full_page=True)
            print(f"OK {path} {path.stat().st_size}")
            page.close()
        browser.close()

if __name__ == "__main__":
    main()
