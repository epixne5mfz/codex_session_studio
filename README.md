<div align="center">

<img src="icon_1024.png" width="96" alt="Codex 合并台图标" />

# Codex 合并台

**一款纯本地、开箱即用的桌面工具，让散落各处的 Codex 会话记录一键迁移、归档、找回。**

[![Release](https://img.shields.io/github/v/release/epixne5mfz/codex_session_studio?label=下载&color=2ea44f)](https://github.com/epixne5mfz/codex_session_studio/releases/latest)
![平台](https://img.shields.io/badge/macOS%2011%2B-Intel%20%7C%20Apple%20Silicon-blue)
![Windows](https://img.shields.io/badge/Windows-Python%203-informational)
![隐私](https://img.shields.io/badge/纯本地运行-无云端上传-success)

[快速开始](#快速开始) · [界面与用法](#界面与用法) · [功能亮点](#功能亮点) · [常见问题](#常见问题)

</div>

---

## 为什么需要它？

如果你是 Codex（ChatGPT 桌面版编程助手）的重度用户，大概率遇到过这些烦恼：

- 换电脑、重装系统、切换中转账号后，**历史会话找不回来了**
- `~/.codex` 备份了好几份，**哪份是最新的、里面有什么，完全是黑盒**
- 想删掉一批过时会话给侧栏减负，又**怕误删重要记录**
- 想找某次对话里的一段代码，**只记得内容、不记得标题**

Codex 合并台就是为解决这些问题而生的。

## 功能亮点

| | 功能 | 说明 |
| --- | --- | --- |
| 🔄 | 一键迁移 | 自动扫描本机所有 Codex 数据目录（含历史备份），旧会话安全合并进当前 Codex，已存在的只更新不重复 |
| 🔍 | 全文搜索 | 不止搜标题，「搜内容」开关可直接搜聊天正文，命中片段高亮展示 |
| 🎛️ | 精准筛选 | 按日期范围、中转渠道、新增/已存在/已归档多维过滤；按日期、标题、中转排序 |
| ✅ | 批量管理 | 分组一键全选，实时显示「新增 X 条、更新 Y 条」，迁移前弹出差异预览清单 |
| 🛟 | 三重兜底 | 写操作前自动备份数据库；回收站可还原误删；备份管理界面一键还原/清理 |
| 📤 | 导出 | 选中会话合并导出为 Markdown，或导出整个记录源为 JSON |
| 🔒 | 隐私 | 所有数据不出你的电脑，服务只监听 `127.0.0.1`，没有任何云端上传 |

## 快速开始

### macOS（推荐）

1. 在 [Releases](https://github.com/epixne5mfz/codex_session_studio/releases/latest) 下载 `Codex-Merge-Studio.dmg`
2. 打开 DMG，把 App 拖进「应用程序」
3. 双击打开（首次若提示"无法验证开发者"，右键 App → 打开 一次即可）

支持 macOS 11+，Intel 与 Apple Silicon 通用。也可以从源码打包：

```bash
./install_desktop_macos_app.sh   # 生成 Codex合并台桌面版.app 与 DMG
```

### Windows

需先安装 Python 3（勾选 "Add to PATH"），然后双击 `Codex合并台桌面版.bat` 打开桌面窗口。

生成独立 exe 或桌面快捷方式：

```powershell
powershell -ExecutionPolicy Bypass -File install_desktop_windows_app.ps1
```

- 已安装 PyInstaller（`pip install pyinstaller`）时生成 `Codex合并台桌面版.exe`，可独立分发、无需 Python
- 未安装时创建带图标的桌面快捷方式

### 命令行 / Web 版

```bash
python3 server.py --open                                    # 启动并自动打开浏览器
python3 server.py --open --codex-homes "/path/a,~/.codex"   # 扫描多个 Codex 目录
python3 server.py --scan-json                                # 只输出扫描结果
```

macOS 也可以双击 `Codex合并台.command`，Windows 双击 `Codex合并台.bat`，浏览器会自动打开 `http://127.0.0.1:4174`。

## 界面与用法

### 主界面：浏览与迁移

![主界面](docs/screenshots/main.png)

1. 左上下拉框选择**来源目录**（自动扫描到的 Codex 数据目录），也可点「添加目录…」手动加入
2. 列表按日期分组展示所有会话，右上可切换排序（日期 ↓ / 日期 ↑ / 标题 / 中转）
3. 筛选行支持：仅新增 / 已存在 / 已归档、按中转筛选、日期范围过滤
4. 勾选要迁移的会话（「全选本组」整组勾选，「全选」按钮一键全选/取消全选）
5. 右侧选择**目标目录**，点「开始迁移」

### 搜索聊天内容

![内容搜索](docs/screenshots/search.png)

搜索框默认只搜标题；点亮「搜内容」后会同时搜索聊天正文，命中的会话下方显示高亮片段。

### 迁移前差异预览

![迁移预览](docs/screenshots/preview.png)

点「开始迁移」后先弹出确认预览，列出将**新增**和**已存在、只会更新**的会话清单，确认无误再执行。

### 备份管理

![备份管理](docs/screenshots/backups.png)

顶部「备份管理」可查看每次迁移自动生成的 `.merge-backup-*` 备份（大小、时间），支持一键还原或删除释放空间。

其他功能：勾选会话后可「导出 MD」；「回收站」可找回误删会话；右上角切换深浅色主题（默认跟随系统）。

## 工作原理

- 启动后自动扫描当前用户可访问的 Codex 记录：`~/.codex`、`~/.codex-backups` 的所有备份层级，以及 `Project(s)`、`Documents`、`Desktop`、`Downloads`、`Library/Application Support` 中的 Codex 数据目录
- 扫描只识别 `state_5.sqlite`、`session_index.jsonl`、`sessions` 和 `archived_sessions`，**不会读取 `auth.json`**；缓存、依赖和系统构建目录会被跳过
- 启动时只读取会话索引，完整消息在点击聊天时按需加载，避免一次性传输几十 MB 的历史数据
- 每次写操作前自动备份 `state_5.sqlite` / `session_index.jsonl` / `.codex-global-state.json`

### 合并规则

- 同一个聊天键优先保留最新时间戳；时间戳相同时比较消息条数
- 合并后的账户会标记为 `merged`；同名账户自动聚合
- 文件夹导入时按目录名推断账户名
- 解析不出结构时退回原始文本预览，避免整份文件消失

## 项目结构

| 文件 | 职责 |
| --- | --- |
| `server.py` | 本地 HTTP 服务：扫描 Codex 目录、会话/搜索/回收站 API、合并/删除/重命名等写操作（写前自动备份） |
| `index.html` / `app.js` / `styles.css` | 前端界面与全部交互逻辑 |
| `macos_app.swift` | macOS 桌面壳（WKWebView + 原生弹窗/文件面板，不依赖 Electron） |
| `install_desktop_macos_app.sh` | 编译 Swift 壳（universal 二进制）并打包 `.app` / DMG |
| `windows_app.py` / `install_desktop_windows_app.ps1` | Windows 桌面版及打包脚本 |
| `Codex合并台.command` / `Codex合并台.bat` | Web 版启动脚本（浏览器访问本地服务） |

## 常见问题

**打开 DMG 里的 App 提示"已损坏"或"无法验证开发者"？**
App 使用本地自签名，首次打开请右键 App → 打开，之后正常双击即可。

**直接用 `file://` 打开页面为什么读不到记录？**
浏览器无法读取 `~/.codex`，请通过 App 或 `server.py` 启动，页面才能扫描本机记录；`file://` 模式下只能手动导入文件。

**手动导入的数据存在哪里？**
小型数据保存在浏览器 `localStorage`；完整 Codex 历史超过缓存容量时不会强行写入，下次打开时会重新扫描本机源文件。

**导出会不会丢消息？**
导出记录源时后台会读取该来源的完整会话内容后再生成 JSON，不会只导出已经点开过的聊天。
