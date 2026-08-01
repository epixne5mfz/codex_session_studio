#!/usr/bin/env python3
"""Codex 合并台 Windows 桌面壳：内嵌启动 server.py，用 Edge/Chrome 应用模式窗口展示。"""
import os
import shutil
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path

import server


APP_TITLE = "Codex 合并台"
HOST = "127.0.0.1"


def find_browser():
    candidates = []
    for env in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
        base = os.environ.get(env)
        if not base:
            continue
        candidates += [
            Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
            Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe",
        ]
    for name in ("msedge", "chrome"):
        found = shutil.which(name)
        if found:
            candidates.append(Path(found))
    for path in candidates:
        if path.exists():
            return str(path)
    return None


def main():
    os.chdir(Path(__file__).resolve().parent)

    from http.server import ThreadingHTTPServer

    httpd = ThreadingHTTPServer((HOST, 0), server.Handler)
    port = httpd.server_address[1]
    url = f"http://{HOST}:{port}"

    server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    server_thread.start()

    browser = find_browser()
    if browser:
        profile_dir = Path.home() / ".codex_session" / "webview-profile"
        profile_dir.mkdir(parents=True, exist_ok=True)
        proc = subprocess.Popen([
            browser,
            f"--app={url}",
            f"--user-data-dir={profile_dir}",
            "--no-first-run",
            "--no-default-browser-check",
            f"--window-size=1240,780",
        ])
        proc.wait()
        httpd.shutdown()
    else:
        # 找不到 Edge/Chrome 时退回默认浏览器，窗口关闭后需手动结束本进程
        webbrowser.open(url)
        print(f"{APP_TITLE}: {url}（按 Ctrl+C 退出）")
        try:
            server_thread.join()
        except KeyboardInterrupt:
            httpd.shutdown()


if __name__ == "__main__":
    sys.exit(main())
