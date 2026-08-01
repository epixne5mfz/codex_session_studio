#!/usr/bin/env python3
"""Codex 合并台本地服务。

职责：
- 静态托管前端（index.html / app.js / styles.css）；
- 扫描本机所有 Codex 数据目录（~/.codex、~/.codex-backups 及常见项目目录）；
- 提供只读 API（扫描、会话详情、全局搜索、回收站列表）与写 API
  （合并导入、归档/删除、恢复、重命名、导出保存）；
- 所有写操作先备份 state_5.sqlite / session_index.jsonl / .codex-global-state.json。

数据模型要点：
- 会话元数据以 state_5.sqlite 的 threads 表为主；
- Codex 侧栏显示的名称来自 session_index.jsonl 的 thread_name；
- 完整消息存在 sessions/**/rollout-*.jsonl，按需懒加载。

安全：只监听 127.0.0.1，写接口拒绝跨站请求（见 request_is_local）。
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import time
import uuid
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


ROOT = Path(__file__).resolve().parent
CODEX_HOME = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser()
CODEX_HOMES = [
    Path(item).expanduser()
    for item in os.environ.get("CODEX_HOMES", "").replace(":", ",").split(",")
    if item.strip()
]
CODEX_BACKUPS = Path(os.environ.get("CODEX_BACKUPS", Path.home() / ".codex-backups")).expanduser()
DISCOVERY_SKIP_DIRS = {
    ".git",
    ".svn",
    "node_modules",
    "__pycache__",
    ".Trash",
    "Caches",
    "DerivedData",
    "Pods",
    "vendor",
}
DISCOVERED_HOMES_CACHE = None
DISCOVERED_HOMES_AT = 0.0
DISCOVERY_TTL_SECONDS = 300.0
MERGED_STORE = Path.home() / ".codex-merge-studio" / "merged_accounts.json"
EXTRA_HOMES_STORE = Path.home() / ".codex-merge-studio" / "extra_homes.json"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed_url = urlparse(self.path)
        path = parsed_url.path
        if path == "/api/scan":
            query = parse_qs(parsed_url.query)
            refresh = (query.get("refresh") or [""])[0] in ("1", "true")
            self.write_json(scan_codex_home(refresh=refresh))
            return
        if path == "/api/messages":
            query = parse_qs(parsed_url.query)
            source = (query.get("source") or [""])[0]
            thread_id = (query.get("thread") or [""])[0]
            self.write_json(load_thread_messages(source, thread_id))
            return
        if path == "/api/export":
            query = parse_qs(parsed_url.query)
            source = (query.get("source") or [""])[0]
            account = export_codex_account(source)
            self.write_json(account, status=200 if "error" not in account else 400)
            return
        if path == "/api/search":
            query = parse_qs(parsed_url.query)
            source = (query.get("source") or [""])[0]
            needle = (query.get("q") or [""])[0]
            self.write_json(search_threads(source, needle))
            return
        if path == "/api/search-all":
            query = parse_qs(parsed_url.query)
            needle = (query.get("q") or [""])[0]
            self.write_json(search_all_threads(needle))
            return
        if path == "/api/trash":
            self.write_json(list_trash())
            return
        if path == "/api/backups":
            self.write_json(list_backups())
            return
        if path == "/api/merged-accounts":
            self.write_json(load_merged_accounts())
            return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in (
            "/api/apply-merge",
            "/api/delete-threads",
            "/api/save-file",
            "/api/restore-threads",
            "/api/rename-thread",
            "/api/merged-accounts",
            "/api/undo",
            "/api/restart-codex",
            "/api/add-home",
            "/api/delete-backups",
        ):
            self.send_error(404)
            return
        if not self.request_is_local():
            self.write_json({"error": "cross-origin request rejected"}, status=403)
            return
        if path == "/api/save-file":
            result = self.save_export_file()
            self.write_json(result, status=200 if "error" not in result else 400)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            limit = 200_000_000 if path == "/api/merged-accounts" else 1_000_000
            if length > limit:
                self.write_json({"error": "request body too large"}, status=413)
                return
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self.write_json({"error": "invalid json body"}, status=400)
            return
        if path == "/api/delete-threads":
            result = delete_threads(payload)
        elif path == "/api/restore-threads":
            result = restore_threads(payload)
        elif path == "/api/rename-thread":
            result = rename_thread(payload)
        elif path == "/api/merged-accounts":
            result = save_merged_accounts(payload)
        elif path == "/api/undo":
            result = restore_backups(payload)
        elif path == "/api/restart-codex":
            result = restart_codex(payload)
        elif path == "/api/add-home":
            result = add_extra_home(payload)
        elif path == "/api/delete-backups":
            result = delete_backups(payload)
        else:
            result = apply_merge(payload)
        self.write_json(result, status=200 if "error" not in result else 400)

    def save_export_file(self):
        """把导出内容保存到 ~/Downloads，供桌面壳（WKWebView 不支持浏览器下载）使用。"""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return {"error": "invalid content length"}
        if length <= 0 or length > 500_000_000:
            return {"error": "invalid file size"}
        name = Path(unquote(self.headers.get("X-Filename") or "").strip()).name
        if not name or name.startswith("."):
            name = f"export-{time.strftime('%Y%m%d-%H%M%S')}.json"
        downloads = Path.home() / "Downloads"
        try:
            downloads.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return {"error": f"cannot create Downloads: {exc}"}
        target = downloads / name
        stem, suffix = target.stem, target.suffix
        counter = 1
        while target.exists():
            target = downloads / f"{stem}-{counter}{suffix}"
            counter += 1
        remaining = length
        try:
            with target.open("wb") as handle:
                while remaining:
                    chunk = self.rfile.read(min(65536, remaining))
                    if not chunk:
                        break
                    handle.write(chunk)
                    remaining -= len(chunk)
        except OSError as exc:
            return {"error": f"write failed: {exc}"}
        return {"path": str(target), "bytes": length - remaining}

    def log_message(self, format, *args):
        try:
            log_dir = Path.home() / "Library" / "Logs"
            log_dir.mkdir(parents=True, exist_ok=True)
            with (log_dir / "CodexSessionStudio-server.log").open("a", encoding="utf-8") as handle:
                handle.write(f"{self.log_date_time_string()} {format % args}\n")
        except OSError:
            pass

    def request_is_local(self):
        """拒绝来自其它网站的跨站写请求（CSRF/DNS rebinding），只接受本机页面发起的写入。"""
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in {"127.0.0.1", "localhost", "[::1]", "::1"}:
            return False
        origin = self.headers.get("Origin")
        if origin:
            origin_host = urlparse(origin).hostname or ""
            if origin_host not in {"127.0.0.1", "localhost", "::1"}:
                return False
        return True

    def write_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def load_merged_accounts():
    """读取磁盘上保存的合并账户（localStorage 容量不够时的持久化后备）。"""
    try:
        if MERGED_STORE.is_file():
            data = json.loads(MERGED_STORE.read_text(encoding="utf-8"))
            accounts = data.get("accounts") if isinstance(data, dict) else None
            if isinstance(accounts, list):
                return {"accounts": accounts}
    except (OSError, json.JSONDecodeError):
        pass
    return {"accounts": []}


def save_merged_accounts(payload):
    """把合并账户写到磁盘，页面刷新/重开后可以恢复。"""
    accounts = payload.get("accounts")
    if not isinstance(accounts, list):
        return {"error": "accounts must be a list"}
    try:
        MERGED_STORE.parent.mkdir(parents=True, exist_ok=True)
        temporary = MERGED_STORE.with_name(MERGED_STORE.name + ".tmp")
        temporary.write_text(json.dumps({"accounts": accounts}, ensure_ascii=False), encoding="utf-8")
        temporary.replace(MERGED_STORE)
    except OSError as exc:
        return {"error": f"cannot save merged accounts: {exc}"}
    return {"saved": len(accounts)}


def scan_codex_home(refresh=False):
    started_at = time.monotonic()
    homes = resolve_codex_homes(refresh=refresh)
    accounts = []
    total_threads = 0
    total_archive_files = 0
    for home in homes:
        account = scan_one_codex_home(home)
        accounts.append(account)
        total_threads += len(account["chats"])
        archive_root = home / "archived_sessions"
        total_archive_files += len(list(archive_root.glob("*.jsonl"))) if archive_root.exists() else 0

    return {
        "accounts": accounts,
        "meta": {
            "codexHomes": [str(home) for home in homes],
            "threads": total_threads,
            "archiveFiles": total_archive_files,
            "scanDurationMs": round((time.monotonic() - started_at) * 1000),
        },
    }


def resolve_codex_homes(refresh=False):
    global DISCOVERED_HOMES_CACHE, DISCOVERED_HOMES_AT
    cache_fresh = (
        DISCOVERED_HOMES_CACHE is not None
        and time.monotonic() - DISCOVERED_HOMES_AT < DISCOVERY_TTL_SECONDS
    )
    if CODEX_HOMES:
        homes = list(CODEX_HOMES)
    elif DISCOVERED_HOMES_CACHE is not None and (not refresh or cache_fresh):
        return list(DISCOVERED_HOMES_CACHE)
    else:
        homes = discover_codex_homes()

    seen = []
    for home in homes:
        try:
            resolved = home.expanduser().resolve()
        except OSError:
            resolved = home.expanduser()
        if resolved not in seen and is_codex_home(resolved):
            seen.append(resolved)
    DISCOVERED_HOMES_CACHE = list(seen)
    DISCOVERED_HOMES_AT = time.monotonic()
    return seen


def load_extra_homes():
    """用户手动添加的 Codex 数据目录（自动扫描找不到时用）。"""
    try:
        data = json.loads(EXTRA_HOMES_STORE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return [Path(str(item)).expanduser() for item in data if str(item).strip()]


def add_extra_home(payload):
    raw = str((payload or {}).get("path") or "").strip()
    if not raw:
        return {"error": "path is required"}
    path = Path(raw).expanduser()
    try:
        path = path.resolve()
    except OSError:
        return {"error": "invalid path"}
    if not path.is_dir():
        return {"error": f"目录不存在：{path}"}
    if not is_codex_home(path):
        return {"error": f"这不像 Codex 数据目录（应包含 state_5.sqlite 或 sessions/）：{path}"}
    stored = [str(item) for item in load_extra_homes()]
    if str(path) not in stored:
        stored.append(str(path))
    try:
        EXTRA_HOMES_STORE.parent.mkdir(parents=True, exist_ok=True)
        EXTRA_HOMES_STORE.write_text(json.dumps(stored, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as exc:
        return {"error": f"cannot save: {exc}"}
    global DISCOVERED_HOMES_CACHE
    DISCOVERED_HOMES_CACHE = None
    return {"added": str(path), "homes": stored}


def discover_codex_homes():
    user_home = Path.home()
    homes = [CODEX_HOME, *load_extra_homes()]
    roots = [
        (CODEX_BACKUPS, 6),
        (user_home / "Project", 5),
        (user_home / "Projects", 5),
        (user_home / "Documents", 5),
        (user_home / "Desktop", 4),
        (user_home / "Downloads", 4),
        (user_home / "Library" / "Application Support", 4),
    ]

    for child in safe_iterdir(user_home):
        if child.is_dir() and "codex" in child.name.lower():
            roots.append((child, 5))

    deadline = time.monotonic() + 6.0
    for root, max_depth in roots:
        homes.extend(discover_under(root, max_depth, deadline))
        if time.monotonic() >= deadline:
            break
    return homes


def discover_under(root, max_depth, deadline):
    root = Path(root).expanduser()
    if not root.exists() or not root.is_dir():
        return []

    found = []
    root_depth = len(root.parts)
    for current, dirnames, filenames in os.walk(root, followlinks=False):
        if time.monotonic() >= deadline:
            break
        current_path = Path(current)
        depth = len(current_path.parts) - root_depth
        dirnames[:] = [
            name for name in dirnames
            if name not in DISCOVERY_SKIP_DIRS and not name.startswith(".")
        ]
        if current_path == root:
            dirnames.extend(
                child.name for child in safe_iterdir(current_path)
                if child.is_dir() and child.name.startswith(".codex") and child.name not in dirnames
            )
        if depth >= max_depth:
            dirnames[:] = []
        if "state_5.sqlite" in filenames or "session_index.jsonl" in filenames:
            found.append(current_path)
            dirnames[:] = []
    return found


def safe_iterdir(path):
    try:
        return list(Path(path).iterdir())
    except OSError:
        return []


def is_codex_home(path):
    return (
        (path / "state_5.sqlite").is_file()
        or (path / "session_index.jsonl").is_file()
        or (path / "sessions").is_dir()
        or (path / "archived_sessions").is_dir()
    )


def scan_one_codex_home(codex_home):
    threads = load_threads(codex_home)
    index = load_session_index(codex_home)
    rollouts = [] if threads or index else load_rollout_summaries(codex_home)

    by_id = {}
    for item in index + threads + rollouts:
        thread_id = item.get("id")
        if not thread_id:
            continue
        existing = by_id.get(thread_id, {})
        by_id[thread_id] = merge_thread(existing, item)

    label = account_label(codex_home)
    login_type = detect_login_type(codex_home)
    login_detail = relay_name(codex_home) if login_type == "apikey" else ""
    grouping = load_grouping(codex_home)
    chats = []
    for item in by_id.values():
        item["accountLabel"] = label
        chats.append(decorate_group(normalize_thread(item), grouping))
    chats.sort(key=lambda item: item.get("updatedAt") or 0, reverse=True)

    return {
        "id": stable_id(str(codex_home)),
        "name": label,
        "sourceFile": str(codex_home),
        "loginType": login_type,
        "loginDetail": login_detail,
        "providerHosts": provider_hosts(codex_home),
        "sourceFiles": sorted(source_files(chats)),
        "importedAt": int(time.time() * 1000),
        "projects": grouping["projects"],
        "chats": chats,
    }


def detect_login_type(codex_home):
    """读 auth.json 判断登录方式：官方 ChatGPT 账户带 tokens，API Key（中转）只有 OPENAI_API_KEY。"""
    path = Path(codex_home) / "auth.json"
    if not path.is_file():
        return ""
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return ""
    if not isinstance(data, dict):
        return ""
    tokens = data.get("tokens")
    if isinstance(tokens, dict) and (tokens.get("id_token") or tokens.get("access_token")):
        return "official"
    if data.get("OPENAI_API_KEY"):
        return "apikey"
    return ""


def relay_name(codex_home):
    """从 config.toml 的 model_providers.base_url 提取中转域名，用于区分不同中转。"""
    path = Path(codex_home) / "config.toml"
    if not path.is_file():
        return ""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    provider = ""
    match = re.search(r'^\s*model_provider\s*=\s*"([^"]+)"', text, re.M)
    if match:
        provider = match.group(1)
    base_url = ""
    if provider:
        section = re.search(
            r'\[model_providers\.' + re.escape(provider) + r'\](.*?)(?=\n\[|\Z)', text, re.S
        )
        if section:
            url_match = re.search(r'^\s*base_url\s*=\s*"([^"]+)"', section.group(1), re.M)
            if url_match:
                base_url = url_match.group(1)
    if not base_url:
        url_match = re.search(r'^\s*base_url\s*=\s*"([^"]+)"', text, re.M)
        if url_match:
            base_url = url_match.group(1)
    if not base_url:
        return provider
    host = urlparse(base_url).netloc or base_url
    if host.startswith("www."):
        host = host[4:]
    return host or provider


def provider_hosts(codex_home):
    """扫描 config.toml 及备份/变体配置里所有 [model_providers.X] 的 base_url，
    返回 {provider 名: 中转域名}，用于按会话显示历史使用过的中转。"""
    home = Path(codex_home)
    hosts = {}
    candidates = [home / "config.toml"]
    try:
        candidates += sorted(home.glob("config.toml.bak_*"))
        candidates += sorted(home.glob("*.config.toml"))
    except OSError:
        pass
    for path in candidates:
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for match in re.finditer(
            r'\[model_providers\.([^\]\s]+)\](.*?)(?=\n\[|\Z)', text, re.S
        ):
            name = match.group(1).strip().strip('"')
            if name in hosts:
                continue
            url_match = re.search(r'^\s*base_url\s*=\s*"([^"]+)"', match.group(2), re.M)
            if not url_match:
                continue
            host = urlparse(url_match.group(1)).netloc or url_match.group(1)
            if host.startswith("www."):
                host = host[4:]
            if host:
                hosts[name] = host
    return hosts


def global_state_path(codex_home):
    return Path(codex_home) / ".codex-global-state.json"


def read_global_state(codex_home):
    path = global_state_path(codex_home)
    if not path.is_file():
        return {}
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def load_grouping(codex_home):
    """Codex 桌面版把项目分组写在 .codex-global-state.json 里，扫描时一起读出来。"""
    state = read_global_state(codex_home)
    raw_projects = state.get("local-projects")
    raw_projects = raw_projects if isinstance(raw_projects, dict) else {}
    assignments = state.get("thread-project-assignments")
    assignments = assignments if isinstance(assignments, dict) else {}
    labels = state.get("electron-workspace-root-labels")
    labels = labels if isinstance(labels, dict) else {}
    pinned = state.get("pinned-thread-ids")
    pinned = set(pinned) if isinstance(pinned, list) else set()

    by_project_id = {}
    by_root_path = {}
    for project_id, project in raw_projects.items():
        if not isinstance(project, dict):
            continue
        name = project.get("name") or Path(str(project_id)).name
        roots = [str(root) for root in project.get("rootPaths") or [] if root]
        entry = {"id": str(project_id), "name": name, "rootPaths": roots}
        by_project_id[str(project_id)] = entry
        for root in roots:
            by_root_path[root] = entry
            by_project_id.setdefault(local_project_id(root), entry)

    thread_projects = {}
    for thread_id, assignment in assignments.items():
        if not isinstance(assignment, dict):
            continue
        project_id = str(assignment.get("projectId") or "")
        path = assignment.get("path") or assignment.get("cwd") or ""
        entry = by_project_id.get(project_id) or by_root_path.get(str(path))
        if entry is None and path:
            name = labels.get(str(path)) or Path(str(path)).name
            entry = {"id": project_id or local_project_id(str(path)), "name": name, "rootPaths": [str(path)]}
            by_project_id[entry["id"]] = entry
        if entry:
            thread_projects[str(thread_id)] = entry

    project_counts = {}
    for entry in thread_projects.values():
        project_counts[entry["id"]] = project_counts.get(entry["id"], 0) + 1

    projects = []
    for entry in {id(item): item for item in by_project_id.values()}.values():
        projects.append({**entry, "threadCount": project_counts.get(entry["id"], 0)})
    projects.sort(key=lambda item: (-item["threadCount"], item["name"]))

    return {
        "projects": projects,
        "threadProjects": thread_projects,
        "byRootPath": by_root_path,
        "pinned": pinned,
        "raw": state,
    }


def local_project_id(root_path):
    digest = hashlib.sha256(str(root_path).encode("utf-8")).hexdigest()
    return f"local-{digest[:32]}"


def decorate_group(chat, grouping):
    thread_id = chat.get("threadId")
    entry = grouping["threadProjects"].get(str(thread_id))
    if entry is None:
        cwd = (chat.get("raw") or {}).get("cwd")
        entry = grouping["byRootPath"].get(str(cwd)) if cwd else None
        if entry is None and cwd:
            for candidate in grouping["byRootPath"].values():
                if any(str(cwd).startswith(root.rstrip("/") + "/") for root in candidate["rootPaths"]):
                    entry = candidate
                    break
    chat["projectId"] = entry["id"] if entry else None
    chat["projectName"] = entry["name"] if entry else "未分组"
    chat["pinned"] = str(thread_id) in grouping["pinned"]
    chat["archived"] = bool((chat.get("raw") or {}).get("archived"))
    return chat


def export_codex_account(source):
    try:
        requested_home = Path(source).expanduser().resolve()
    except OSError:
        return {"error": "invalid source"}
    if requested_home not in set(resolve_codex_homes()):
        return {"error": "source is not an indexed Codex directory"}

    threads = load_threads(requested_home)
    index = load_session_index(requested_home)
    rollouts = []
    seen_paths = set()
    allowed_homes = set(resolve_codex_homes())
    for thread in threads:
        rollout_path = thread.get("rolloutPath")
        if not rollout_path:
            continue
        path = Path(rollout_path).expanduser()
        if not path.is_file() or not any(path_is_within(path, home) for home in allowed_homes):
            continue
        parsed = parse_rollout(path, include_messages=True)
        if parsed:
            parsed["id"] = thread.get("id") or parsed.get("id")
            rollouts.append(parsed)
            seen_paths.add(path.resolve())

    for path in sorted(rollout_paths(requested_home)):
        if path.resolve() in seen_paths:
            continue
        parsed = parse_rollout(path, include_messages=True)
        if parsed:
            rollouts.append(parsed)

    by_id = {}
    for item in index + threads + rollouts:
        thread_id = item.get("id")
        if not thread_id:
            continue
        by_id[thread_id] = merge_thread(by_id.get(thread_id, {}), item)

    label = account_label(requested_home)
    login_type = detect_login_type(requested_home)
    login_detail = relay_name(requested_home) if login_type == "apikey" else ""
    chats = []
    for item in by_id.values():
        item["accountLabel"] = label
        chats.append(normalize_thread(item))
    chats.sort(key=lambda item: item.get("updatedAt") or 0, reverse=True)
    return {
        "id": stable_id(str(requested_home)),
        "name": label,
        "sourceFile": str(requested_home),
        "loginType": login_type,
        "loginDetail": login_detail,
        "providerHosts": provider_hosts(requested_home),
        "exportedAt": int(time.time() * 1000),
        "chats": chats,
    }


def apply_merge(payload):
    """把源记录源里的会话真正写回目标 Codex 目录，让 Codex 自己能看到这些聊天。"""
    homes = set(resolve_codex_homes())
    try:
        source_home = Path(str(payload.get("source") or "")).expanduser().resolve()
        target_home = Path(str(payload.get("target") or CODEX_HOME)).expanduser().resolve()
    except OSError:
        return {"error": "invalid source or target"}
    if source_home not in homes or target_home not in homes:
        return {"error": "source or target is not an indexed Codex directory"}
    if source_home == target_home:
        return {"error": "source and target are the same directory"}
    target_db = target_home / "state_5.sqlite"
    if not target_db.is_file():
        return {"error": "target has no state_5.sqlite"}

    requested = {str(item) for item in payload.get("threadIds") or [] if item}
    unarchive = bool(payload.get("unarchive", True))
    keep_groups = bool(payload.get("keepGroups", True))

    source_threads = {thread["id"]: thread for thread in load_threads(source_home) if thread.get("id")}
    if not source_threads:
        for parsed in load_rollout_summaries(source_home):
            thread_id = parsed.get("id")
            if thread_id:
                source_threads.setdefault(thread_id, parsed)
    if requested:
        source_threads = {key: value for key, value in source_threads.items() if key in requested}
    if not source_threads:
        return {"error": "no threads found in source"}

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backups = backup_target(target_home, stamp)

    result = {
        "inserted": 0,
        "updated": 0,
        "unarchived": 0,
        "copiedRollouts": 0,
        "skipped": [],
        "backups": backups,
        "target": str(target_home),
        "source": str(source_home),
    }

    try:
        con = sqlite3.connect(str(target_db), timeout=10)
    except sqlite3.Error as exc:
        return {"error": f"cannot open target database: {exc}"}

    applied_ids = set()
    try:
        con.execute("pragma busy_timeout = 10000")
        target_columns = {row[1] for row in con.execute("pragma table_info(threads)").fetchall()}
        existing_ids = {row[0] for row in con.execute("select id from threads")}
        source_rows = read_source_rows(source_home, set(source_threads))
        for thread_id, thread in source_threads.items():
            if thread_id in source_rows:
                continue
            source_rows[thread_id] = {
                "id": thread_id,
                "title": thread.get("title"),
                "cwd": thread.get("cwd"),
                "created_at_ms": thread.get("createdAt") or 0,
                "updated_at_ms": thread.get("updatedAt") or 0,
                "model_provider": thread.get("provider"),
                "archived": 0,
                "rollout_path": thread.get("rolloutPath"),
                "preview": thread.get("preview"),
                "first_user_message": None,
            }

        for thread_id, row in source_rows.items():
            rollout_path = ensure_rollout_in_target(row.get("rollout_path"), source_home, target_home, thread_id)
            if rollout_path is None:
                result["skipped"].append({"id": thread_id, "reason": "rollout file not found"})
                continue
            if rollout_path.get("copied"):
                result["copiedRollouts"] += 1
            row["rollout_path"] = rollout_path["path"]

            if thread_id in existing_ids:
                current = con.execute(
                    "select archived, rollout_path from threads where id = ?", (thread_id,)
                ).fetchone()
                updates = {}
                current_rollout = Path(str(current[1])).expanduser() if current and current[1] else None
                if current_rollout is None or not current_rollout.is_file():
                    updates["rollout_path"] = row["rollout_path"]
                if unarchive and current and current[0]:
                    updates["archived"] = 0
                    if "archived_at" in target_columns:
                        updates["archived_at"] = None
                    result["unarchived"] += 1
                if updates:
                    assignments = ", ".join(f"{name} = ?" for name in updates)
                    con.execute(
                        f"update threads set {assignments} where id = ?",
                        [*updates.values(), thread_id],
                    )
                    result["updated"] += 1
                applied_ids.add(thread_id)
                continue

            insert_row = {name: value for name, value in row.items() if name in target_columns}
            insert_row.setdefault("archived", 0)
            if unarchive:
                insert_row["archived"] = 0
                if "archived_at" in target_columns:
                    insert_row["archived_at"] = None
            fill_preview(insert_row, target_columns)
            names = ", ".join(insert_row)
            placeholders = ", ".join("?" for _ in insert_row)
            con.execute(
                f"insert into threads ({names}) values ({placeholders})",
                list(insert_row.values()),
            )
            result["inserted"] += 1
            applied_ids.add(thread_id)
        con.commit()
    except sqlite3.Error as exc:
        con.rollback()
        return {"error": f"database write failed: {exc}", "backups": backups}
    finally:
        con.close()

    applied_rows = {thread_id: source_rows[thread_id] for thread_id in applied_ids}
    result["indexAppended"] = sync_session_index(target_home, applied_rows)
    project_name = str(payload.get("projectName") or "").strip()
    if keep_groups and not project_name:
        result["groupsWritten"] = merge_groups(source_home, target_home, applied_ids)
    if project_name and applied_ids:
        result["projectAssigned"] = assign_project(target_home, applied_ids, project_name)
        result["projectName"] = project_name
    result["codexRunning"] = is_codex_running()
    return result


def assign_project(target_home, thread_ids, project_name):
    """把写入的会话归到指定名称的项目下，项目不存在时自动创建。

    Codex 侧栏只显示带真实目录的项目，因此这里会建一个同名目录作为 rootPath，
    并按 Codex 自己的字段结构写入项目与归属信息。
    """
    target_path = global_state_path(target_home)
    state = read_global_state(target_home)

    root_path = Path.home() / "Documents" / project_name
    try:
        root_path.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    root = str(root_path)
    now = int(time.time() * 1000)

    projects = state.get("local-projects")
    projects = projects if isinstance(projects, dict) else {}
    assignments = state.get("thread-project-assignments")
    assignments = assignments if isinstance(assignments, dict) else {}

    project_id = None
    for existing_id, project in projects.items():
        if isinstance(project, dict) and str(project.get("name") or "").strip() == project_name:
            project_id = str(existing_id)
            break
    if project_id is None:
        project_id = str(uuid.uuid4())
    entry = projects.get(project_id) if isinstance(projects.get(project_id), dict) else {}
    roots = [item for item in (entry.get("rootPaths") or []) if item]
    if root not in roots:
        roots.append(root)
    projects[project_id] = {
        "id": project_id,
        "name": project_name,
        "rootPaths": roots,
        "createdAt": entry.get("createdAt") or now,
        "updatedAt": now,
    }

    written = 0
    for thread_id in thread_ids:
        assignments[str(thread_id)] = {
            "projectKind": "local",
            "projectId": project_id,
            "cwd": root,
            "pendingCoreUpdate": False,
        }
        written += 1

    projectless = state.get("projectless-thread-ids")
    if isinstance(projectless, list):
        state["projectless-thread-ids"] = [item for item in projectless if str(item) not in {str(t) for t in thread_ids}]

    state["local-projects"] = projects
    state["thread-project-assignments"] = assignments
    order = state.get("project-order")
    order = order if isinstance(order, list) else []
    if project_id not in order:
        order.insert(0, project_id)
    state["project-order"] = order

    try:
        temporary = target_path.with_name(target_path.name + ".tmp")
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False)
        temporary.replace(target_path)
    except OSError as exc:
        print(f"global state write failed: {exc}")
        return 0
    return written


def search_all_threads(needle):
    """全局搜索：在所有记录源里搜索关键词，按记录源返回命中结果。"""
    results = {}
    if len(str(needle or "").strip()) >= 2:
        for home in resolve_codex_homes():
            found = search_threads(str(home), needle)
            if found.get("threadIds"):
                results[str(home)] = found
    return {"results": results}


def list_trash():
    """列出所有记录源 deleted_sessions 回收目录里的会话文件。"""
    entries = []
    for home in resolve_codex_homes():
        trash_root = home / "deleted_sessions"
        if not trash_root.is_dir():
            continue
        try:
            files = sorted(trash_root.rglob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
        except OSError:
            continue
        for path in files:
            parsed = None
            try:
                parsed = parse_rollout(path, include_messages=False)
            except OSError:
                pass
            stat = None
            try:
                stat = path.stat()
            except OSError:
                continue
            entries.append({
                "home": str(home),
                "path": str(path),
                "id": (parsed or {}).get("id") or id_from_rollout_path(path),
                "title": (parsed or {}).get("title") or path.stem,
                "updatedAt": (parsed or {}).get("updatedAt") or 0,
                "deletedAt": int(stat.st_mtime * 1000),
                "size": stat.st_size,
            })
    entries.sort(key=lambda item: -item["deletedAt"])
    return {"entries": entries}


def restore_threads(payload):
    """把回收目录里的会话文件恢复回 sessions，并重新写回数据库和索引。"""
    homes = set(resolve_codex_homes())
    try:
        home = Path(str(payload.get("home") or "")).expanduser().resolve()
    except OSError:
        return {"error": "invalid home"}
    if home not in homes:
        return {"error": "home is not an indexed Codex directory"}
    trash_root = home / "deleted_sessions"
    raw_paths = [str(item) for item in payload.get("paths") or [] if item]
    if not raw_paths:
        return {"error": "paths is required"}

    result = {"restored": 0, "skipped": [], "home": str(home)}
    rows = {}
    for raw in raw_paths:
        path = Path(raw).expanduser()
        if not path.is_file() or not path_is_within(path, trash_root):
            result["skipped"].append({"path": raw, "reason": "file not found in trash"})
            continue
        parsed = None
        try:
            parsed = parse_rollout(path, include_messages=False)
        except OSError:
            pass
        dest = rollout_destination(home, path)
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists():
                dest = dest.with_name(f"{dest.stem}-restored-{time.strftime('%H%M%S')}{dest.suffix}")
            shutil.move(str(path), str(dest))
        except OSError as exc:
            result["skipped"].append({"path": raw, "reason": str(exc)})
            continue
        result["restored"] += 1
        thread_id = (parsed or {}).get("id") or id_from_rollout_path(dest)
        if thread_id:
            rows[thread_id] = {
                "id": thread_id,
                "title": (parsed or {}).get("title") or dest.stem,
                "cwd": (parsed or {}).get("cwd"),
                "created_at_ms": (parsed or {}).get("createdAt") or 0,
                "updated_at_ms": (parsed or {}).get("updatedAt") or 0,
                "model_provider": (parsed or {}).get("provider"),
                "archived": 0,
                "rollout_path": str(dest),
                "preview": (parsed or {}).get("preview"),
                "first_user_message": None,
            }

    db_path = home / "state_5.sqlite"
    if db_path.is_file() and rows:
        try:
            con = sqlite3.connect(str(db_path), timeout=10)
            try:
                con.execute("pragma busy_timeout = 10000")
                target_columns = {row[1] for row in con.execute("pragma table_info(threads)").fetchall()}
                existing_ids = {row[0] for row in con.execute("select id from threads")}
                for thread_id, row in rows.items():
                    if thread_id in existing_ids:
                        con.execute("update threads set rollout_path = ?, archived = 0 where id = ?", (row["rollout_path"], thread_id))
                        continue
                    insert_row = {name: value for name, value in row.items() if name in target_columns}
                    fill_preview(insert_row, target_columns)
                    names = ", ".join(insert_row)
                    placeholders = ", ".join("?" for _ in insert_row)
                    con.execute(f"insert into threads ({names}) values ({placeholders})", list(insert_row.values()))
                con.commit()
            finally:
                con.close()
        except sqlite3.Error as exc:
            result["dbError"] = str(exc)
    result["indexAppended"] = sync_session_index(home, rows)
    result["codexRunning"] = is_codex_running()
    return result


def rename_thread(payload):
    """修改会话标题：写回 state_5.sqlite 的 title/name，并同步 session_index.jsonl。"""
    homes = set(resolve_codex_homes())
    try:
        home = Path(str(payload.get("home") or CODEX_HOME)).expanduser().resolve()
    except OSError:
        return {"error": "invalid home"}
    if home not in homes:
        return {"error": "home is not an indexed Codex directory"}
    thread_id = str(payload.get("threadId") or "").strip()
    title = " ".join(str(payload.get("title") or "").split())[:180]
    if not thread_id:
        return {"error": "threadId is required"}
    if not title:
        return {"error": "title is required"}

    db_path = home / "state_5.sqlite"
    if not db_path.is_file():
        return {"error": "该记录源没有 Codex 数据库，无法重命名"}

    stamp = time.strftime("%Y%m%d-%H%M%S")
    result = {
        "home": str(home),
        "threadId": thread_id,
        "title": title,
        "backups": backup_target(home, stamp),
        "updated": 0,
    }
    try:
        con = sqlite3.connect(str(db_path), timeout=10)
    except sqlite3.Error as exc:
        return {"error": f"cannot open database: {exc}"}
    try:
        con.execute("pragma busy_timeout = 10000")
        columns = {row[1] for row in con.execute("pragma table_info(threads)").fetchall()}
        if "title" not in columns:
            return {"error": "数据库没有 title 字段，无法重命名"}
        cur = con.execute("update threads set title = ? where id = ?", (title, thread_id))
        result["updated"] = cur.rowcount
        if "name" in columns:
            con.execute("update threads set name = ? where id = ?", (title, thread_id))
        con.commit()
    except sqlite3.Error as exc:
        con.rollback()
        return {"error": f"database write failed: {exc}", "backups": result["backups"]}
    finally:
        con.close()
    if not result["updated"]:
        return {"error": "没有找到这个会话（可能已被删除）"}
    result["indexUpdated"] = rename_in_session_index(home, thread_id, title)
    result["codexRunning"] = is_codex_running()
    return result


def rename_in_session_index(home, thread_id, title):
    """Codex 侧栏显示的是 session_index.jsonl 里的 thread_name，重命名时同步写入（没有条目则追加）。"""
    path = home / "session_index.jsonl"
    lines = []
    updated = 0
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    try:
        if path.is_file():
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    stripped = line.strip()
                    if not stripped:
                        continue
                    try:
                        entry = json.loads(stripped)
                    except json.JSONDecodeError:
                        lines.append(stripped)
                        continue
                    if str(entry.get("id")) == thread_id:
                        entry["thread_name"] = title
                        entry["updated_at"] = now
                        updated += 1
                        lines.append(json.dumps(entry, ensure_ascii=False))
                    else:
                        lines.append(stripped)
        if not updated:
            lines.append(json.dumps({"id": thread_id, "thread_name": title, "updated_at": now}, ensure_ascii=False))
            updated = 1
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError as exc:
        print(f"session index rename failed: {exc}")
        return 0
    return updated


def delete_threads(payload):
    """批量归档或彻底删除指定会话；彻底删除时 rollout 文件移入 deleted_sessions 回收目录而不直接删。"""
    homes = set(resolve_codex_homes())
    try:
        home = Path(str(payload.get("home") or CODEX_HOME)).expanduser().resolve()
    except OSError:
        return {"error": "invalid home"}
    if home not in homes:
        return {"error": "home is not an indexed Codex directory"}
    db_path = home / "state_5.sqlite"
    has_db = db_path.is_file()

    thread_ids = {str(item) for item in payload.get("threadIds") or [] if item}
    if not thread_ids:
        return {"error": "threadIds is required"}
    mode = str(payload.get("mode") or "archive")
    if mode not in ("archive", "purge", "unarchive", "delete"):
        return {"error": "mode must be archive, unarchive, purge or delete"}
    if not has_db and mode not in ("purge", "delete"):
        return {"error": "该记录源没有 Codex 数据库，只支持彻底删除"}

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backups = backup_target(home, stamp)
    result = {"mode": mode, "archived": 0, "unarchived": 0, "deleted": 0, "backups": backups, "home": str(home)}

    rollouts = []
    if has_db:
        try:
            con = sqlite3.connect(str(db_path), timeout=10)
        except sqlite3.Error as exc:
            return {"error": f"cannot open database: {exc}"}
        db_result = delete_threads_from_db(con, mode, thread_ids, result, rollouts)
        if db_result is not None:
            return db_result

    if mode in ("purge", "delete"):
        hard = mode == "delete"
        trash = home / "deleted_sessions" / stamp
        moved = 0
        candidates = set()
        for rollout in rollouts:
            candidates.add(Path(str(rollout)).expanduser())
        for path in rollout_paths(home):
            if id_from_rollout_path(path) in thread_ids:
                candidates.add(path)
        for path in candidates:
            if not path.is_file() or not path_is_within(path, home):
                continue
            try:
                if hard:
                    path.unlink()
                else:
                    trash.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(path), str(trash / path.name))
                moved += 1
            except OSError as exc:
                print(f"rollout remove failed for {path}: {exc}")
        result["rolloutsRemoved" if hard else "rolloutsMovedToTrash"] = moved
        if moved and not hard:
            result["trashDir"] = str(trash)
        result["indexRemoved"] = remove_from_session_index(home, thread_ids)
        result["groupsRemoved"] = remove_from_global_state(home, thread_ids)
        if not has_db:
            result["deleted"] = max(result["indexRemoved"], moved)
    result["codexRunning"] = is_codex_running()
    return result


def delete_threads_from_db(con, mode, thread_ids, result, rollouts):
    try:
        con.execute("pragma busy_timeout = 10000")
        target_columns = {row[1] for row in con.execute("pragma table_info(threads)").fetchall()}
        placeholders = ", ".join("?" for _ in thread_ids)
        ordered_ids = list(thread_ids)
        if mode == "archive":
            now = int(time.time())
            if "archived_at" in target_columns:
                cur = con.execute(
                    f"update threads set archived = 1, archived_at = ? where id in ({placeholders}) and archived = 0",
                    [now, *ordered_ids],
                )
            else:
                cur = con.execute(
                    f"update threads set archived = 1 where id in ({placeholders}) and archived = 0",
                    ordered_ids,
                )
            result["archived"] = cur.rowcount
        elif mode == "unarchive":
            if "archived_at" in target_columns:
                cur = con.execute(
                    f"update threads set archived = 0, archived_at = null where id in ({placeholders}) and archived = 1",
                    ordered_ids,
                )
            else:
                cur = con.execute(
                    f"update threads set archived = 0 where id in ({placeholders}) and archived = 1",
                    ordered_ids,
                )
            result["unarchived"] = cur.rowcount
        else:
            rollouts.extend(
                row[0]
                for row in con.execute(
                    f"select rollout_path from threads where id in ({placeholders})", ordered_ids
                )
                if row[0]
            )
            cur = con.execute(f"delete from threads where id in ({placeholders})", ordered_ids)
            result["deleted"] = cur.rowcount
        con.commit()
    except sqlite3.Error as exc:
        con.rollback()
        return {"error": f"database write failed: {exc}", "backups": result.get("backups")}
    finally:
        con.close()
    return None


def remove_from_session_index(home, thread_ids):
    path = home / "session_index.jsonl"
    if not path.is_file():
        return 0
    kept = []
    removed = 0
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    entry = json.loads(stripped)
                except json.JSONDecodeError:
                    kept.append(stripped)
                    continue
                if str(entry.get("id")) in thread_ids:
                    removed += 1
                else:
                    kept.append(stripped)
        if removed:
            path.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")
    except OSError as exc:
        print(f"session index rewrite failed: {exc}")
        return 0
    return removed


def remove_from_global_state(home, thread_ids):
    path = global_state_path(home)
    state = read_global_state(home)
    if not state:
        return 0
    removed = 0
    assignments = state.get("thread-project-assignments")
    if isinstance(assignments, dict):
        for thread_id in list(assignments):
            if thread_id in thread_ids:
                assignments.pop(thread_id)
                removed += 1
    changed = removed > 0
    for key in ("pinned-thread-ids", "projectless-thread-ids"):
        values = state.get(key)
        if isinstance(values, list):
            filtered = [item for item in values if str(item) not in thread_ids]
            if len(filtered) != len(values):
                state[key] = filtered
                changed = True
    if changed:
        try:
            path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError as exc:
            print(f"global state rewrite failed: {exc}")
    return removed


def read_source_rows(source_home, thread_ids):
    path = source_home / "state_5.sqlite"
    rows = {}
    if not path.is_file():
        return rows
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        for row in con.execute("select * from threads"):
            if row["id"] in thread_ids:
                rows[row["id"]] = dict(row)
    except sqlite3.Error as exc:
        print(f"source read failed: {exc}")
    finally:
        con.close()
    return rows


def restore_backups(payload):
    """把 apply-merge / delete-threads 返回的备份文件复原，用于「撤销本次操作」。"""
    homes = {str(home) for home in resolve_codex_homes()}
    restored = []
    for item in payload.get("backups") or []:
        backup = Path(str(item)).expanduser()
        if ".merge-backup-" not in backup.name or not backup.is_file():
            continue
        original = backup.with_name(backup.name.split(".merge-backup-")[0])
        if str(original.parent) not in homes:
            continue
        try:
            shutil.copy2(backup, original)
            restored.append(str(original))
        except OSError as exc:
            return {"error": f"restore failed for {original}: {exc}"}
    if not restored:
        return {"error": "没有可恢复的备份文件"}
    return {"restored": restored, "codexRunning": is_codex_running()}


def restart_codex(_payload=None):
    """完全退出并重新打开 Codex（ChatGPT.app），让侧栏读到最新数据。"""
    try:
        subprocess.run(["osascript", "-e", 'quit app "ChatGPT"'], timeout=30, check=False)
        time.sleep(6)
        subprocess.run(["pkill", "-f", "ChatGPT.app/Contents/MacOS/ChatGPT"], timeout=15, check=False)
        time.sleep(2)
        subprocess.run(["open", "-a", "ChatGPT"], timeout=30, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        return {"error": f"restart failed: {exc}"}
    return {"restarted": True}


def list_backups():
    """列出所有 Codex 目录里的 .merge-backup-* 备份文件，供备份管理界面展示。"""
    entries = []
    for home in resolve_codex_homes():
        try:
            files = sorted(Path(home).glob("*.merge-backup-*"))
        except OSError:
            continue
        for path in files:
            if not path.is_file():
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            name = path.name
            stamp = name.split(".merge-backup-")[-1]
            entries.append({
                "path": str(path),
                "home": str(home),
                "original": name.split(".merge-backup-")[0],
                "stamp": stamp,
                "size": stat.st_size,
                "mtime": int(stat.st_mtime * 1000),
            })
    entries.sort(key=lambda item: item["mtime"], reverse=True)
    return {"entries": entries}


def delete_backups(payload):
    """删除选中的备份文件（只允许删 Codex 目录里的 .merge-backup-* 文件）。"""
    homes = {str(home) for home in resolve_codex_homes()}
    deleted = []
    errors = []
    for item in payload.get("paths") or []:
        path = Path(str(item)).expanduser()
        if ".merge-backup-" not in path.name or str(path.parent) not in homes or not path.is_file():
            errors.append(f"跳过非法路径：{path}")
            continue
        try:
            path.unlink()
            deleted.append(str(path))
        except OSError as exc:
            errors.append(f"删除失败 {path}: {exc}")
    if not deleted and errors:
        return {"error": "; ".join(errors)}
    return {"deleted": deleted, "errors": errors}


def backup_target(target_home, stamp):
    backups = []
    for name in ("state_5.sqlite", "session_index.jsonl", ".codex-global-state.json"):
        path = target_home / name
        if not path.is_file():
            continue
        backup = path.with_name(f"{name}.merge-backup-{stamp}")
        try:
            shutil.copy2(path, backup)
            backups.append(str(backup))
        except OSError as exc:
            print(f"backup failed for {path}: {exc}")
    return backups


def ensure_rollout_in_target(rollout_path, source_home, target_home, thread_id):
    candidates = []
    if rollout_path:
        candidates.append(Path(str(rollout_path)).expanduser())
    for home in (source_home, target_home):
        candidates.extend(path for path in rollout_paths(home) if thread_id in path.name)

    for candidate in candidates:
        if not candidate.is_file():
            continue
        if path_is_within(candidate, target_home):
            return {"path": str(candidate), "copied": False}
        destination = rollout_destination(target_home, candidate)
        copied = False
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            if not destination.exists():
                shutil.copy2(candidate, destination)
                copied = True
        except OSError as exc:
            print(f"rollout copy failed for {candidate}: {exc}")
            continue
        return {"path": str(destination), "copied": copied}
    return None


def rollout_destination(target_home, rollout_file):
    parts = rollout_file.stem.split("-")
    if len(parts) >= 4 and parts[0] == "rollout" and len(parts[1]) == 4:
        year, month, day = parts[1], parts[2], parts[3][:2]
    else:
        today = datetime.date.today()
        year, month, day = f"{today.year:04d}", f"{today.month:02d}", f"{today.day:02d}"
    return target_home / "sessions" / year / month / day / rollout_file.name


def fill_preview(row, target_columns):
    """Codex 侧栏只显示 preview 非空的会话，导入时补齐这两列。"""
    preview = str(row.get("preview") or "").strip()
    first_message = str(row.get("first_user_message") or "").strip()
    fallback = preview or first_message or str(row.get("title") or "").strip()
    if not fallback:
        parsed = parse_rollout(Path(str(row.get("rollout_path"))), include_messages=True)
        fallback = title_from_messages((parsed or {}).get("messages") or []) or "导入的会话"
    if "preview" in target_columns:
        row["preview"] = preview or fallback
    if "first_user_message" in target_columns:
        row["first_user_message"] = first_message or fallback
    if "title" in target_columns and not row.get("title"):
        row["title"] = fallback


def sync_session_index(target_home, source_rows):
    path = target_home / "session_index.jsonl"
    known = {str(obj.get("id")) for obj in read_jsonl(path)} if path.is_file() else set()
    appended = 0
    lines = []
    for thread_id, row in source_rows.items():
        if thread_id in known:
            continue
        updated_ms = row.get("updated_at_ms") or (row.get("updated_at") or 0) * 1000
        stamp = datetime.datetime.fromtimestamp(updated_ms / 1000, datetime.timezone.utc)
        lines.append(
            json.dumps(
                {
                    "id": thread_id,
                    "thread_name": row.get("title") or row.get("preview") or thread_id,
                    "updated_at": stamp.isoformat().replace("+00:00", "Z"),
                },
                ensure_ascii=False,
            )
        )
        appended += 1
    if lines:
        try:
            needs_newline = False
            if path.is_file() and path.stat().st_size:
                with path.open("rb") as handle:
                    handle.seek(-1, os.SEEK_END)
                    needs_newline = handle.read(1) != b"\n"
            with path.open("a", encoding="utf-8") as handle:
                if needs_newline:
                    handle.write("\n")
                handle.write("\n".join(lines) + "\n")
        except OSError as exc:
            print(f"session index append failed: {exc}")
            return 0
    return appended


def merge_groups(source_home, target_home, thread_ids):
    """把源账户的项目分组带到目标账户，已有的分组不会被覆盖。"""
    source_state = read_global_state(source_home)
    if not source_state:
        return 0
    target_path = global_state_path(target_home)
    target_state = read_global_state(target_home)

    source_projects = source_state.get("local-projects")
    source_projects = source_projects if isinstance(source_projects, dict) else {}
    target_projects = target_state.get("local-projects")
    target_projects = target_projects if isinstance(target_projects, dict) else {}
    source_assignments = source_state.get("thread-project-assignments")
    source_assignments = source_assignments if isinstance(source_assignments, dict) else {}
    target_assignments = target_state.get("thread-project-assignments")
    target_assignments = target_assignments if isinstance(target_assignments, dict) else {}

    written = 0
    for thread_id in thread_ids:
        assignment = source_assignments.get(thread_id)
        if not isinstance(assignment, dict) or thread_id in target_assignments:
            continue
        target_assignments[thread_id] = assignment
        written += 1
        project_id = str(assignment.get("projectId") or "")
        if project_id in source_projects and project_id not in target_projects:
            target_projects[project_id] = source_projects[project_id]

    if not written:
        return 0

    target_state["local-projects"] = target_projects
    target_state["thread-project-assignments"] = target_assignments
    order = target_state.get("project-order")
    order = order if isinstance(order, list) else []
    for project_id in target_projects:
        if project_id not in order:
            order.append(project_id)
    target_state["project-order"] = order

    try:
        temporary = target_path.with_name(target_path.name + ".tmp")
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(target_state, handle, ensure_ascii=False)
        temporary.replace(target_path)
    except OSError as exc:
        print(f"global state write failed: {exc}")
        return 0
    return written


def is_codex_running():
    try:
        import subprocess

        output = subprocess.run(
            ["pgrep", "-fil", "codex"], capture_output=True, text=True, timeout=5
        ).stdout
    except Exception:
        return False
    own_markers = ("codex_session", "server.py", "合并台")
    for line in output.splitlines():
        lowered = line.lower()
        if "codex" in lowered and not any(marker in line for marker in own_markers):
            return True
    return False


def load_session_index(codex_home):
    path = codex_home / "session_index.jsonl"
    if not path.exists():
        return []
    out = []
    for obj in read_jsonl(path):
        out.append(
            {
                "id": obj.get("id"),
                "threadName": obj.get("thread_name") or "",
                "title": obj.get("thread_name") or obj.get("title") or obj.get("name"),
                "updatedAt": to_millis(obj.get("updated_at")),
                "source": "session_index",
                "sourceFile": str(path),
            }
        )
    return out


def load_threads(codex_home):
    path = codex_home / "state_5.sqlite"
    if not path.exists():
        return []
    out = []
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        columns = {row[1] for row in con.execute("pragma table_info(threads)").fetchall()}
        select_parts = [
            "id",
            "title",
            "cwd",
            "created_at_ms",
            "updated_at_ms",
            "model_provider",
            "archived",
            "rollout_path",
            "preview",
            "first_user_message",
        ]
        if "name" in columns:
            select_parts.insert(2, "name")
        else:
            select_parts.insert(2, "null as name")
        query = f"select {', '.join(select_parts)} from threads"
        for row in con.execute(query):
            out.append(
                {
                    "id": row["id"],
                    "title": row["title"] or row["name"] or row["preview"] or row["first_user_message"],
                    "cwd": row["cwd"],
                    "createdAt": row["created_at_ms"],
                    "updatedAt": row["updated_at_ms"],
                    "provider": row["model_provider"],
                    "archived": bool(row["archived"]),
                    "rolloutPath": row["rollout_path"],
                    "preview": row["preview"] or row["first_user_message"],
                    "source": "state_db",
                    "sourceFile": str(path),
                }
            )
    except sqlite3.Error as exc:
        print(f"state sqlite scan failed: {exc}")
    finally:
        try:
            con.close()
        except Exception:
            pass
    return out


def rollout_paths(codex_home):
    paths = set()
    for folder_name in ("sessions", "archived_sessions"):
        root = codex_home / folder_name
        if not root.exists():
            continue
        try:
            paths.update(root.rglob("*.jsonl"))
        except OSError:
            continue
    return paths


def load_rollout_summaries(codex_home):
    out = []
    for path in sorted(rollout_paths(codex_home)):
        parsed = parse_rollout(path, include_messages=False)
        if parsed:
            out.append(parsed)
    return out


def load_thread_messages(source, thread_id):
    if not source or not thread_id:
        return {"messages": [], "error": "missing source or thread"}

    try:
        requested_home = Path(source).expanduser().resolve()
    except OSError:
        return {"messages": [], "error": "invalid source"}

    allowed_homes = set(resolve_codex_homes())
    if requested_home not in allowed_homes:
        return {"messages": [], "error": "source is not an indexed Codex directory"}

    candidate_paths = []
    for thread in load_threads(requested_home):
        if thread.get("id") == thread_id and thread.get("rolloutPath"):
            candidate_paths.append(Path(thread["rolloutPath"]).expanduser())

    candidate_paths.extend(path for path in rollout_paths(requested_home) if thread_id in path.name)

    for path in dict.fromkeys(candidate_paths):
        if not path.is_file() or not any(path_is_within(path, home) for home in allowed_homes):
            continue
        parsed = parse_rollout(path, include_messages=True)
        if parsed:
            return {"messages": parsed.get("messages", []), "messageCount": len(parsed.get("messages", []))}
    return {"messages": [], "messageCount": 0}


def search_threads(source, needle):
    """全文搜索：在指定记录源的所有 rollout 文件里搜索关键词，返回命中的会话 id 和片段。"""
    needle = str(needle or "").strip().lower()
    if not source or len(needle) < 2:
        return {"threadIds": [], "snippets": {}}
    try:
        requested_home = Path(source).expanduser().resolve()
    except OSError:
        return {"threadIds": [], "snippets": {}, "error": "invalid source"}
    if requested_home not in set(resolve_codex_homes()):
        return {"threadIds": [], "snippets": {}, "error": "source is not an indexed Codex directory"}

    started_at = time.monotonic()
    thread_files = {}
    for thread in load_threads(requested_home):
        thread_id = thread.get("id")
        rollout = thread.get("rolloutPath")
        if thread_id and rollout:
            thread_files.setdefault(thread_id, Path(rollout).expanduser())
    for path in rollout_paths(requested_home):
        thread_id = id_from_rollout_path(path)
        if thread_id:
            thread_files.setdefault(thread_id, path)

    hits = []
    snippets = {}
    allowed_homes = set(resolve_codex_homes())
    for thread_id, path in thread_files.items():
        if time.monotonic() - started_at > 20:
            break
        if not path.is_file() or not any(path_is_within(path, home) for home in allowed_homes):
            continue
        snippet = search_rollout_file(path, needle)
        if snippet is not None:
            hits.append(thread_id)
            snippets[thread_id] = snippet

    return {
        "threadIds": hits,
        "snippets": snippets,
        "durationMs": round((time.monotonic() - started_at) * 1000),
    }


def search_rollout_file(path, needle):
    """在单个 rollout 文件的消息文本里找关键词，命中时返回上下文片段。"""
    for obj in read_jsonl(path):
        kind = obj.get("type")
        payload = obj.get("payload") or {}
        if kind == "response_item":
            text = content_to_text(payload.get("content"))
        elif kind == "event_msg":
            text = payload.get("message") or payload.get("last_agent_message") or ""
        else:
            continue
        if not text:
            continue
        lowered = str(text).lower()
        position = lowered.find(needle)
        if position >= 0:
            start = max(0, position - 40)
            end = min(len(text), position + len(needle) + 60)
            return " ".join(str(text)[start:end].split())
    return None


def path_is_within(path, root):
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError):
        return False


def parse_rollout(path, include_messages=True):
    meta = {}
    messages = []
    updated = 0
    created = 0
    for obj in read_jsonl(path):
        timestamp = to_millis(obj.get("timestamp"))
        if timestamp:
            updated = max(updated, timestamp)
            created = created or timestamp
        kind = obj.get("type")
        payload = obj.get("payload") or {}
        if kind == "session_meta":
            meta = payload
            created = created or to_millis(payload.get("timestamp"))
        elif kind == "response_item":
            msg = message_from_response_item(payload, timestamp)
            if msg:
                if include_messages:
                    messages.append(msg)
        elif kind == "event_msg":
            msg = message_from_event_msg(payload, timestamp)
            if msg:
                if include_messages:
                    messages.append(msg)

    session_id = meta.get("session_id") or meta.get("id") or id_from_rollout_path(path)
    if not session_id:
        return None
    title = title_from_messages(messages) or path.stem
    return {
        "id": session_id,
        "title": title,
        "cwd": meta.get("cwd"),
        "createdAt": created,
        "updatedAt": updated or created,
        "provider": meta.get("model_provider"),
        "messages": messages,
        "source": "archived_session",
        "sourceFile": str(path),
        "rolloutPath": str(path),
    }


def message_from_response_item(payload, timestamp):
    role = payload.get("role")
    if role not in {"assistant"}:
        return None
    content = content_to_text(payload.get("content"))
    if not content:
        return None
    return {
        "id": payload.get("id") or stable_id(f"{role}-{timestamp}-{content[:40]}"),
        "role": role,
        "content": content,
        "timestamp": timestamp,
    }


def message_from_event_msg(payload, timestamp):
    event_type = payload.get("type")
    if event_type == "user_message":
        role = "user"
        text = payload.get("message")
    elif event_type == "task_complete":
        role = "assistant"
        text = payload.get("last_agent_message")
    else:
        return None
    if not text:
        return None
    return {
        "id": payload.get("client_id") or stable_id(f"{role}-{timestamp}-{text[:40]}"),
        "role": role,
        "content": text,
        "timestamp": timestamp,
    }


def content_to_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text") or item.get("content") or item.get("message")
                if text:
                    parts.append(str(text))
        return "\n".join(parts).strip()
    if isinstance(content, dict):
        return str(content.get("text") or content.get("content") or content.get("message") or "").strip()
    return ""


def merge_thread(left, right):
    merged = {**left, **{k: v for k, v in right.items() if v not in (None, "", [], 0)}}
    left_messages = left.get("messages") or []
    right_messages = right.get("messages") or []
    merged["messages"] = right_messages if len(right_messages) >= len(left_messages) else left_messages
    merged["sourceFiles"] = sorted(set((left.get("sourceFiles") or []) + [left.get("sourceFile")] + (right.get("sourceFiles") or []) + [right.get("sourceFile")]) - {None})
    merged["updatedAt"] = max(left.get("updatedAt") or 0, right.get("updatedAt") or 0)
    merged["createdAt"] = left.get("createdAt") or right.get("createdAt") or 0
    return merged


def normalize_thread(item):
    messages = item.get("messages") or []
    title = item.get("threadName") or item.get("title") or title_from_messages(messages) or item.get("id") or "未命名聊天"
    title = " ".join(str(title).split())[:180]
    return {
        "key": stable_id(item.get("id") or title),
        "title": title,
        "createdAt": item.get("createdAt") or item.get("updatedAt") or 0,
        "updatedAt": item.get("updatedAt") or item.get("createdAt") or 0,
        "messageCount": len(messages),
        "messages": messages,
        "threadId": item.get("id"),
        "provider": item.get("provider") or "",
        "detailsLoaded": bool(item.get("messages")),
        "sourceAccount": item.get("accountLabel") or account_label(CODEX_HOME),
        "sourceFiles": item.get("sourceFiles") or [item.get("sourceFile")],
        "raw": {
            "id": item.get("id"),
            "cwd": item.get("cwd"),
            "provider": item.get("provider"),
            "archived": item.get("archived"),
            "rolloutPath": item.get("rolloutPath"),
            "source": item.get("source"),
            "sourceFile": item.get("sourceFile"),
        },
    }


def title_from_messages(messages):
    for msg in messages:
        if msg.get("role") == "user" and msg.get("content"):
            text = " ".join(msg["content"].split())
            return text[:40]
    return ""


def read_jsonl(path):
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
    except OSError as exc:
        print(f"jsonl scan failed for {path}: {exc}")


def id_from_rollout_path(path):
    parts = path.stem.split("-")
    if len(parts) >= 7:
        return "-".join(parts[-5:])
    return path.stem


def source_files(chats):
    files = set()
    for chat in chats:
        for file_name in chat.get("sourceFiles") or []:
            if file_name:
                files.add(file_name)
    return files


def account_label(codex_home):
    home = Path(codex_home)
    if home.name == ".codex":
        return f"当前账户 · {home.parent.name}"
    if home.name.startswith("codex-config-"):
        stamp = home.name.removeprefix("codex-config-")
        if len(stamp) >= 8 and stamp[:8].isdigit():
            return f"历史账户 · {stamp[:4]}-{stamp[4:6]}-{stamp[6:8]}"
        return "历史账户备份"
    return home.name or str(home)


def to_millis(value):
    if value in (None, ""):
        return 0
    if isinstance(value, (int, float)):
        return int(value if value > 1_000_000_000_000 else value * 1000)
    try:
        text = str(value).replace("Z", "+00:00")
        return int(__import__("datetime").datetime.fromisoformat(text).timestamp() * 1000)
    except Exception:
        return 0


def stable_id(text):
    value = 2166136261
    for char in str(text):
        value ^= ord(char)
        value = (value * 16777619) & 0xFFFFFFFF
    return f"k_{value:x}"


def parse_args():
    parser = argparse.ArgumentParser(description="Codex 合并台本地轻量应用")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "4174")))
    parser.add_argument("--codex-home", default=os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
    parser.add_argument("--codex-homes", default=os.environ.get("CODEX_HOMES", ""))
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    parser.add_argument("--scan-json", action="store_true", help="只输出扫描结果 JSON，不启动服务")
    return parser.parse_args()


def configure_homes(args):
    global CODEX_HOME, CODEX_HOMES
    CODEX_HOME = Path(args.codex_home).expanduser()
    raw_homes = args.codex_homes.replace(":", ",")
    CODEX_HOMES = [Path(item).expanduser() for item in raw_homes.split(",") if item.strip()]


def main():
    args = parse_args()
    configure_homes(args)

    if args.scan_json:
        print(json.dumps(scan_codex_home(), ensure_ascii=False, indent=2))
        return

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    actual_port = httpd.server_address[1]
    url = f"http://{args.host}:{actual_port}"
    print(f"Codex merge app: {url}")
    print(f"Scanning CODEX_HOMES={resolve_codex_homes()}")
    if args.open:
        webbrowser.open(url)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
