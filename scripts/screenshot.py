#!/usr/bin/env python3
"""全页截图脚本 — 对 localhost:4567 进行 1920x1080 全页截图"""

import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = "http://localhost:4567"
OUTPUT_DIR = Path("/home/dong/Documents/latte/latte-code-editor/screenshots")
OUTPUT_PATH = OUTPUT_DIR / "localhost_4567.png"

def main():
    # 确保输出目录存在
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1920, "height": 1080})

        try:
            page.goto(URL, wait_until="networkidle", timeout=30000)
        except Exception as e:
            print(f"ERROR: 页面加载失败: {e}", file=sys.stderr)
            browser.close()
            sys.exit(1)

        # 额外等 1 秒确保渲染完成
        page.wait_for_timeout(1000)

        page.screenshot(path=str(OUTPUT_PATH), full_page=True)
        browser.close()

    bytes_size = OUTPUT_PATH.stat().st_size
    abs_path = OUTPUT_PATH.resolve()
    print(f"SUCCESS")
    print(f"PATH: {abs_path}")
    print(f"SIZE: {bytes_size} 字节")


if __name__ == "__main__":
    main()
