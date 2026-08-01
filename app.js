/**
 * Codex 合并台前端入口（无框架，直接操作 DOM）。
 *
 * 结构：
 * - state：全局 UI 状态（记录源、选中项、筛选、搜索命中等），小体积数据持久化到 localStorage；
 * - els：一次性缓存的 DOM 引用；
 * - 渲染分为 renderAccounts / renderChats / renderMessages 三列，统一由 render() 驱动；
 * - 与 server.py 的 /api/* 交互：扫描、懒加载消息、合并写回、归档/删除/重命名、回收站、全局搜索；
 * - 桌面壳为 WKWebView：alert/confirm/prompt/文件选择由 macos_app.swift 的原生面板接管，
 *   导出不能用浏览器下载，改走 /api/save-file 存到 ~/Downloads。
 */
const state = {
  accounts: loadState(),
  selectedAccountId: null,
  selectedChatKey: null,
  search: "",
  groupFilter: "",
  providerFilter: "",
  archiveFilter: "",
  sortOrder: loadSortOrder(),
  merged: null,
  inspectorOpen: false,
  selected: new Map(),
  primaryHome: localStorage.getItem("codex-primary-home") || "",
  searchHits: null,
  searchSnippets: {},
  globalHits: null,
  messageLimit: 120,
};

const els = {
  scanBtn: document.getElementById("scanBtn"),
  importBtn: document.getElementById("importBtn"),
  folderBtn: document.getElementById("folderBtn"),
  mergeBtn: document.getElementById("mergeBtn"),
  mergeBadge: document.getElementById("mergeBadge"),
  confirmMergeBtn: document.getElementById("confirmMergeBtn"),
  applyMergeBtn: document.getElementById("applyMergeBtn"),
  projectNameInput: document.getElementById("projectNameInput"),
  migrateSource: document.getElementById("migrateSource"),
  migrateTarget: document.getElementById("migrateTarget"),
  projectNameOptions: document.getElementById("projectNameOptions"),
  groupSelect: document.getElementById("groupSelect"),
  providerSelect: document.getElementById("providerSelect"),
  archiveSelect: document.getElementById("archiveSelect"),
  selectTools: document.getElementById("selectTools"),
  selectAllChk: document.getElementById("selectAllChk"),
  selectedCount: document.getElementById("selectedCount"),
  clearSelectBtn: document.getElementById("clearSelectBtn"),
  archiveSelBtn: document.getElementById("archiveSelBtn"),
  deleteSelBtn: document.getElementById("deleteSelBtn"),
  closeInspectorBtn: document.getElementById("closeInspectorBtn"),
  inspector: document.getElementById("inspector"),
  inspectorBackdrop: document.getElementById("inspectorBackdrop"),
  exportBtn: document.getElementById("exportBtn"),
  clearBtn: document.getElementById("clearBtn"),
  moreBtn: document.getElementById("moreBtn"),
  moreMenu: document.getElementById("moreMenu"),
  themeBtn: document.getElementById("themeBtn"),
  exportMdBtn: document.getElementById("exportMdBtn"),
  unarchiveSelBtn: document.getElementById("unarchiveSelBtn"),
  copyChatBtn: document.getElementById("copyChatBtn"),
  trashBtn: document.getElementById("trashBtn"),
  trashModal: document.getElementById("trashModal"),
  trashList: document.getElementById("trashList"),
  closeTrashBtn: document.getElementById("closeTrashBtn"),
  addSourceBtn: document.getElementById("addSourceBtn"),
  fileInput: document.getElementById("fileInput"),
  folderInput: document.getElementById("folderInput"),
  dropzone: document.getElementById("dropzone"),
  accountList: document.getElementById("accountList"),
  chatList: document.getElementById("chatList"),
  accountCount: document.getElementById("accountCount"),
  chatCount: document.getElementById("chatCount"),
  searchInput: document.getElementById("searchInput"),
  sortSelect: document.getElementById("sortSelect"),
  selectedAccountLabel: document.getElementById("selectedAccountLabel"),
  selectedChatTitle: document.getElementById("selectedChatTitle"),
  chatMeta: document.getElementById("chatMeta"),
  messageList: document.getElementById("messageList"),
  mergePreview: document.getElementById("mergePreview"),
  mergeMeta: document.getElementById("mergeMeta"),
  stats: document.getElementById("stats"),
  statusText: document.getElementById("statusText"),
};

const templates = {
  account: document.getElementById("accountItemTpl"),
  chat: document.getElementById("chatItemTpl"),
  message: document.getElementById("messageTpl"),
};

els.scanBtn.addEventListener("click", scanLocalCodex);
els.importBtn.addEventListener("click", () => els.fileInput.click());
els.folderBtn.addEventListener("click", () => els.folderInput.click());
els.fileInput.addEventListener("change", onFileInput);
els.folderInput.addEventListener("change", onFolderInput);
els.mergeBtn.addEventListener("click", openMergeInspector);
els.confirmMergeBtn.addEventListener("click", mergeSelectedAccounts);
els.applyMergeBtn.addEventListener("click", applyMergeToCodex);
if (els.migrateSource) {
  els.migrateSource.addEventListener("change", () => {
    els.migrateSource.dataset.touched = "1";
  });
}
els.groupSelect.addEventListener("change", (event) => {
  state.groupFilter = event.target.value;
  renderChats();
});
els.providerSelect.addEventListener("change", (event) => {
  state.providerFilter = event.target.value;
  renderChats();
});
els.archiveSelect.addEventListener("change", (event) => {
  state.archiveFilter = event.target.value;
  renderChats();
});
els.archiveSelBtn.addEventListener("click", () => deleteSelectedFromCodex("archive"));
els.unarchiveSelBtn.addEventListener("click", () => deleteSelectedFromCodex("unarchive"));
els.deleteSelBtn.addEventListener("click", () => deleteSelectedFromCodex("purge"));
els.selectAllChk.addEventListener("change", (event) => {
  const account = state.accounts.find((item) => item.id === state.selectedAccountId) || state.accounts[0];
  if (!account || !accountIsSelectable(account)) return;
  const set = selectionFor(account.id);
  for (const chat of currentChats()) {
    if (!chat.threadId) continue;
    if (event.target.checked) set.add(chat.threadId);
    else set.delete(chat.threadId);
  }
  renderChats();
});
els.clearSelectBtn.addEventListener("click", () => {
  state.selected.clear();
  renderChats();
});
els.closeInspectorBtn.addEventListener("click", closeMergeInspector);
els.inspectorBackdrop.addEventListener("click", closeMergeInspector);
els.exportBtn.addEventListener("click", exportCurrentView);
els.clearBtn.addEventListener("click", clearAll);
els.addSourceBtn.addEventListener("click", () => els.folderInput.click());
els.moreBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  els.moreMenu.hidden = !els.moreMenu.hidden;
});
document.addEventListener("click", (event) => {
  if (!els.moreMenu.contains(event.target) && event.target !== els.moreBtn) {
    els.moreMenu.hidden = true;
  }
});
els.moreMenu.addEventListener("click", () => {
  els.moreMenu.hidden = true;
});
els.searchInput.addEventListener("input", (event) => {
  state.search = event.target.value.trim().toLowerCase();
  scheduleServerSearch();
  render();
});
els.themeBtn.addEventListener("click", toggleTheme);
els.exportMdBtn.addEventListener("click", exportCurrentAsMarkdown);
els.copyChatBtn.addEventListener("click", copyCurrentChat);
els.sortSelect.value = state.sortOrder;
els.sortSelect.addEventListener("change", (event) => {
  state.sortOrder = event.target.value === "asc" ? "asc" : "desc";
  localStorage.setItem("codex-session-sort-order", state.sortOrder);
  renderChats();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.inspectorOpen) {
    closeMergeInspector();
    return;
  }
  const target = event.target;
  const inField = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
  if (event.key === "/" && !inField) {
    event.preventDefault();
    els.searchInput.focus();
    return;
  }
  if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !inField) {
    const chats = currentChats();
    if (!chats.length) return;
    event.preventDefault();
    const index = chats.findIndex((chat) => chat.key === state.selectedChatKey);
    const next = event.key === "ArrowDown" ? Math.min(chats.length - 1, index + 1) : Math.max(0, index - 1);
    if (next === index) return;
    selectChat(chats[next].key);
  }
});

els.dropzone.addEventListener("click", () => hideDropzone());
let dragDepth = 0;
document.addEventListener("dragenter", (event) => {
  if (!dragHasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  els.dropzone.hidden = false;
});
document.addEventListener("dragover", (event) => {
  if (!dragHasFiles(event)) return;
  event.preventDefault();
  els.dropzone.classList.add("dragover");
});
document.addEventListener("dragleave", (event) => {
  if (!dragHasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) hideDropzone();
});
document.addEventListener("drop", async (event) => {
  if (!dragHasFiles(event)) return;
  event.preventDefault();
  hideDropzone();
  await importFiles([...event.dataTransfer.files]);
});

function dragHasFiles(event) {
  return Boolean(event.dataTransfer && [...(event.dataTransfer.types || [])].includes("Files"));
}

function hideDropzone() {
  dragDepth = 0;
  els.dropzone.hidden = true;
  els.dropzone.classList.remove("dragover");
}

function initTheme() {
  const saved = localStorage.getItem("codex-theme");
  if (saved === "dark" || (!saved && window.matchMedia?.("(prefers-color-scheme: dark)").matches)) {
    document.documentElement.dataset.theme = "dark";
  }
}

function toggleTheme() {
  const isDark = document.documentElement.dataset.theme === "dark";
  if (isDark) {
    delete document.documentElement.dataset.theme;
    localStorage.setItem("codex-theme", "light");
  } else {
    document.documentElement.dataset.theme = "dark";
    localStorage.setItem("codex-theme", "dark");
  }
}

let searchTimer = null;
let searchSeq = 0;
function scheduleServerSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  const needle = state.search;
  if (!needle || needle.length < 2 || location.protocol === "file:") {
    state.searchHits = null;
    state.searchSnippets = {};
    state.globalHits = null;
    return;
  }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    try {
      const query = new URLSearchParams({ q: needle });
      const response = await fetch(`/api/search-all?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (seq !== searchSeq || state.search !== needle) return;
      const map = {};
      for (const [home, found] of Object.entries(payload.results || {})) {
        map[home] = { ids: new Set(found.threadIds || []), snippets: found.snippets || {} };
      }
      state.globalHits = map;
      applySearchHitsForAccount();
      renderAccounts();
      renderChats();
    } catch (error) {
      console.error(error);
    }
  }, 350);
}

els.trashBtn.addEventListener("click", () => {
  els.moreMenu.hidden = true;
  openTrash();
});
els.closeTrashBtn.addEventListener("click", () => { els.trashModal.hidden = true; });
els.trashModal.addEventListener("click", (event) => {
  if (event.target === els.trashModal) els.trashModal.hidden = true;
});

async function openTrash() {
  els.trashModal.hidden = false;
  els.trashList.innerHTML = `<div class="empty-state">加载中...</div>`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const response = await fetch("/api/trash", { cache: "no-store", signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    renderTrash(payload.entries || []);
  } catch (error) {
    console.error(error);
    els.trashList.innerHTML = "";
    const tip = document.createElement("div");
    tip.className = "empty-state";
    tip.textContent = `回收站读取失败或超时（${error && error.name === "AbortError" ? "20 秒无响应" : error.message || error}）。`;
    const retry = document.createElement("button");
    retry.className = "btn";
    retry.type = "button";
    retry.textContent = "重试";
    retry.style.marginTop = "10px";
    retry.addEventListener("click", openTrash);
    els.trashList.append(tip, retry);
  }
}

function renderTrash(entries) {
  if (!entries.length) {
    els.trashList.innerHTML = `<div class="empty-state">回收站是空的。</div>`;
    return;
  }
  els.trashList.innerHTML = "";
  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = "trash-item";
    const info = document.createElement("div");
    info.className = "trash-info";
    const title = document.createElement("strong");
    title.textContent = entry.title || entry.id || "未命名会话";
    const meta = document.createElement("small");
    meta.textContent = `${compactSourcePath(entry.home)} · 删除于 ${formatTime(entry.deletedAt)}`;
    info.append(title, meta);
    const restoreBtn = document.createElement("button");
    restoreBtn.className = "btn";
    restoreBtn.type = "button";
    restoreBtn.textContent = "恢复";
    restoreBtn.addEventListener("click", async () => {
      restoreBtn.disabled = true;
      restoreBtn.textContent = "恢复中...";
      try {
        const response = await fetch("/api/restore-threads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ home: entry.home, paths: [entry.path] }),
        });
        const payload = await response.json();
        if (!response.ok || payload.error) throw new Error(payload.error || `HTTP ${response.status}`);
        item.remove();
        if (!els.trashList.children.length) {
          els.trashList.innerHTML = `<div class="empty-state">回收站是空的。</div>`;
        }
        setStatus(`已恢复「${entry.title || entry.id}」${payload.codexRunning ? "（Codex 正在运行，重启后生效）" : ""}`);
        scanLocalCodex();
      } catch (error) {
        console.error(error);
        restoreBtn.disabled = false;
        restoreBtn.textContent = "恢复";
        alert(`恢复失败：${error.message || error}`);
      }
    });
    item.append(info, restoreBtn);
    els.trashList.appendChild(item);
  }
}

function applySearchHitsForAccount() {
  const account = state.accounts.find((item) => item.id === state.selectedAccountId) || state.accounts[0];
  const entry = account && state.globalHits ? state.globalHits[account.sourceFile] : null;
  state.searchHits = entry ? entry.ids : null;
  state.searchSnippets = entry ? entry.snippets : {};
}

function loadState() {
  try {
    const raw = localStorage.getItem("codex-merge-studio");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.accounts) ? parsed.accounts : [];
  } catch {
    return [];
  }
}

function loadSortOrder() {
  return localStorage.getItem("codex-session-sort-order") === "asc" ? "asc" : "desc";
}

function persistState() {
  try {
    localStorage.setItem("codex-merge-studio", JSON.stringify({ accounts: state.accounts }));
  } catch (error) {
    // Full Codex histories can exceed WebKit's localStorage quota. The source files
    // remain authoritative and are scanned again on the next launch.
    console.warn("Session cache skipped because it is too large.", error);
  }
  syncMergedAccounts();
}

// 合并账户只存在于内存，完整历史又常常超过 localStorage 配额，
// 所以额外把它们写到本地服务的磁盘存储，刷新/重开后可以恢复。
function syncMergedAccounts() {
  if (location.protocol === "file:") return;
  const accounts = state.accounts.filter((account) => account.isMerged);
  fetch("/api/merged-accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accounts }),
  }).catch((error) => console.warn("保存合并账户失败", error));
}

async function restoreMergedAccounts() {
  if (location.protocol === "file:") return;
  try {
    const response = await fetch("/api/merged-accounts", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    let added = 0;
    for (const account of accounts) {
      if (!account || !account.id) continue;
      if (state.accounts.some((item) => item.id === account.id)) continue;
      state.accounts.push(account);
      added += 1;
    }
    if (added) render();
  } catch (error) {
    console.warn("恢复合并账户失败", error);
  }
}

async function onFileInput(event) {
  await importFiles([...event.target.files].map((file) => ({ file, mode: "file" })));
  event.target.value = "";
}

async function onFolderInput(event) {
  await importFiles([...event.target.files].map((file) => ({ file, mode: "folder" })));
  event.target.value = "";
}

async function importFiles(files) {
  if (!files.length) return;
  const imported = [];

  for (const entry of files) {
    const file = entry.file || entry;
    const mode = entry.mode || "file";
    const text = await file.text();
    const parsedAccounts = parseImportedText(text, importLabel(file, mode), mode);
    for (const account of parsedAccounts) {
      imported.push(account);
    }
  }

  for (const account of imported) {
    upsertAccount(account);
  }

  if (!state.selectedAccountId && state.accounts.length) {
    state.selectedAccountId = state.accounts[0].id;
  }
  if (!state.selectedChatKey) {
    const first = currentChats()[0];
    state.selectedChatKey = first ? first.key : null;
  }

  persistState();
  render();
}

async function scanLocalCodex() {
  setStatus("正在扫描本机 Codex 记录...");
  try {
    const response = await fetch("/api/scan", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    if (!accounts.length) {
      setStatus("没有从本机 Codex 目录扫描到记录。");
      return;
    }
    const primaryHome = payload.meta?.codexHomes?.[0];
    if (primaryHome) {
      state.primaryHome = primaryHome;
      localStorage.setItem("codex-primary-home", primaryHome);
    }
    for (const account of accounts) {
      upsertAccount(account);
    }
    state.selectedAccountId = accounts[0].id;
    const first = currentChats()[0];
    state.selectedChatKey = first ? first.key : null;
    render();
    const seconds = ((payload.meta?.scanDurationMs || 0) / 1000).toFixed(1);
    setStatus(`已扫描设备：发现 ${accounts.length} 个记录源、${payload.meta?.threads || totalChats()} 个会话（${seconds} 秒）。`);
    loadSelectedChatDetails();
  } catch (error) {
    setStatus(location.protocol === "file:"
      ? "当前页面无法直接扫描本机，请启动桌面版。"
      : "本机记录扫描失败，请重新扫描。");
    console.error(error);
  }
}

function setStatus(text) {
  if (els.statusText) {
    els.statusText.textContent = text;
  }
}

function parseImportedText(text, fileLabel, mode) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (looksLikeJsonl(trimmed)) {
    const records = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => tryParseJson(line))
      .filter(Boolean);
    const normalized = normalizeRecords(records, fileLabel, mode);
    return normalized.length ? normalized : [buildFallbackAccount(fileLabel, trimmed, mode)];
  }

  const parsed = tryParseJson(trimmed);
  if (parsed == null) {
    const records = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => tryParseJson(line))
      .filter(Boolean);
    const normalized = normalizeRecords(records, fileLabel, mode);
    return normalized.length ? normalized : [buildFallbackAccount(fileLabel, trimmed, mode)];
  }

  const normalized = normalizeRecords([parsed], fileLabel, mode);
  return normalized.length ? normalized : [buildFallbackAccount(fileLabel, trimmed, mode)];
}

function looksLikeJsonl(text) {
  return text.includes("\n") && text.split(/\r?\n/).some((line) => line.trim().startsWith("{") && line.trim().endsWith("}"));
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeRecords(records, fileLabel, mode) {
  const out = [];
  for (const record of records) {
    if (record == null) continue;
    if (Array.isArray(record)) {
      const allObjects = record.every((item) => item && typeof item === "object");
      const looksLikeAccounts = allObjects && record.every((item) => extractChats(item).length > 0) && !record.some((item) => looksLikeChatRecord(item));
      const looksLikeChats = allObjects && record.some((item) => looksLikeChatRecord(item)) && record.every((item) => !extractChats(item).length || looksLikeChatRecord(item));

      if (looksLikeAccounts) {
        out.push(...record.flatMap((item, index) => {
          const accountName = inferString(item.name, item.account, item.title, item.label, `${stripExtension(fileLabel)}-${index + 1}`);
          const chats = extractChats(item);
          return chats.length ? [buildAccount(accountName, chats, fileLabel)] : [];
        }));
        continue;
      }

      if (looksLikeChats) {
        const accountName = accountNameFromMode(fileLabel, mode);
        out.push(buildAccount(accountName, record.map(normalizeChatRecord), fileLabel));
        continue;
      }

      out.push(...normalizeRecords(record, fileLabel, mode));
      continue;
    }

    const accountChunks = extractAccountChunks(record, fileLabel, mode);
    if (accountChunks.length) {
      out.push(...accountChunks);
      continue;
    }

    if (looksLikeChatRecord(record)) {
      const accountName = inferString(record.accountName, record.account, record.owner, record.source, accountNameFromMode(fileLabel, mode)) || accountNameFromMode(fileLabel, mode);
      out.push(buildAccount(accountName, [record], fileLabel));
    }
  }
  return out;
}

function buildFallbackAccount(fileLabel, text, mode) {
  const accountName = accountNameFromMode(fileLabel, mode);
  const summary = text.slice(0, 400).replace(/\s+/g, " ").trim();
  return buildAccount(
    accountName,
    [
      {
        title: stripExtension(fileLabel),
        name: stripExtension(fileLabel),
        createdAt: null,
        updatedAt: null,
        messages: [
          {
            role: "raw",
            content: summary || text.slice(0, 1200),
            timestamp: null,
          },
        ],
        raw: {
          type: "raw-text",
          fileLabel,
          text,
        },
      },
    ],
    fileLabel,
  );
}

function extractAccountChunks(record, fileLabel, mode) {
  const candidates = [
    record.accounts,
    record.accountRecords,
    record.workspaces,
    record.conversationsByAccount,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.flatMap((item, index) => {
        if (!item || typeof item !== "object") return [];
        const accountName = inferString(item.name, item.account, item.title, item.label, `${stripExtension(fileLabel)}-${index + 1}`);
        const chats = extractChats(item);
        return chats.length ? [buildAccount(accountName, chats, fileLabel)] : [];
      });
    }
  }

  const chats = extractChats(record);
  if (chats.length) {
    const accountName = inferString(record.name, record.account, record.title, record.label, accountNameFromMode(fileLabel, mode)) || accountNameFromMode(fileLabel, mode);
    return [buildAccount(accountName, chats, fileLabel)];
  }

  return [];
}

function extractChats(record) {
  const arrays = [
    record.conversations,
    record.threads,
    record.sessions,
    record.chats,
    record.items,
  ];
  for (const array of arrays) {
    if (Array.isArray(array)) {
      return array.filter((item) => item && typeof item === "object").map(normalizeChatRecord);
    }
  }
  return [];
}

function buildAccount(name, chats, fileName) {
  return {
    id: stableId(`${name}-${fileName}`),
    name,
    sourceFile: fileName,
    sourceFiles: [fileName],
    importedAt: Date.now(),
    chats: chats.map((chat) => ({
      ...chat,
      accountName: name,
      sourceAccount: name,
    })),
  };
}

function importLabel(file, mode) {
  const label = file.webkitRelativePath || file.relativePath || file.name;
  return label || file.name;
}

function accountNameFromMode(label, mode) {
  const clean = stripExtension(label);
  if (mode === "folder" && clean.includes("/")) {
    return clean.split("/")[0];
  }
  return clean;
}

function looksLikeChatRecord(record) {
  return Boolean(
    record &&
      typeof record === "object" &&
      (
        Array.isArray(record.messages) ||
        Array.isArray(record.content) ||
        typeof record.prompt === "string" ||
        typeof record.response === "string"
      ),
  );
}

function normalizeChatRecord(chat) {
  const messages = normalizeMessages(chat);
  const title = inferString(chat.title, chat.name, chat.summary, chat.topic, chat.id, "未命名聊天");
  const createdAt = toMillis(chat.created_at || chat.createdAt || chat.start_time || chat.startTime || messages[0]?.timestamp);
  const updatedAt = toMillis(
    chat.updated_at ||
      chat.updatedAt ||
      chat.last_updated ||
      chat.lastUpdated ||
      messages[messages.length - 1]?.timestamp ||
      createdAt,
  );
  const keySource = inferString(chat.id, chat.thread_id, chat.conversation_id, chat.session_id, title, messages[0]?.content?.slice?.(0, 60));

  return {
    key: stableId(keySource || `${title}-${updatedAt}`),
    title,
    createdAt,
    updatedAt,
    messageCount: messages.length,
    messages,
    raw: chat,
    sourceAccount: null,
  };
}

function normalizeMessages(chat) {
  const source = Array.isArray(chat.messages)
    ? chat.messages
    : Array.isArray(chat.content)
      ? chat.content
      : chat.prompt || chat.response
        ? [{ role: "user", content: chat.prompt }, { role: "assistant", content: chat.response }]
        : [];

  return source
    .map((item, index) => {
      if (!item) return null;
      if (typeof item === "string") {
        return {
          id: stableId(`${index}-${item}`),
          role: index % 2 === 0 ? "user" : "assistant",
          content: item,
          timestamp: null,
        };
      }

      const role = inferString(item.role, item.author, item.sender, item.type, "message") || "message";
      const content = inferString(item.content, item.text, item.message, item.value, JSON.stringify(item));
      return {
        id: inferString(item.id, item.message_id, item.uuid, stableId(`${role}-${content}-${index}`)),
        role,
        content,
        timestamp: toMillis(item.timestamp || item.created_at || item.createdAt || item.time || item.date),
      };
    })
    .filter(Boolean);
}

function upsertAccount(account) {
  const existingIndex = state.accounts.findIndex((item) => item.name === account.name);
  if (existingIndex >= 0) {
    const existing = state.accounts[existingIndex];
    const mergedChats = mergeChatArrays(existing.chats, account.chats);
    state.accounts[existingIndex] = {
      ...existing,
      ...account,
      id: existing.id,
      sourceFiles: [...new Set([...(existing.sourceFiles || [existing.sourceFile]), ...(account.sourceFiles || [account.sourceFile])])],
      sourceFile: existing.sourceFile,
      importedAt: Math.max(existing.importedAt || 0, account.importedAt || 0),
      chats: mergedChats,
    };
  } else {
    state.accounts.push(account);
  }
}

function mergeChatArrays(left, right) {
  const map = new Map();
  for (const chat of [...left, ...right]) {
    const key = chat.key || stableId(chat.title);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...chat });
      continue;
    }
    const preferred = (chat.updatedAt || 0) > (existing.updatedAt || 0) ||
      ((chat.updatedAt || 0) === (existing.updatedAt || 0) && (chat.messages?.length || 0) > (existing.messages?.length || 0))
      ? chat
      : existing;
    map.set(key, {
      ...existing,
      ...preferred,
      sourceAccount: existing.sourceAccount || preferred.sourceAccount,
    });
  }
  return [...map.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function currentChats() {
  const account = state.accounts.find((item) => item.id === state.selectedAccountId) || state.accounts[0];
  if (!account) return [];
  const direction = state.sortOrder === "asc" ? 1 : -1;
  return filterChats(account.chats).sort((a, b) => direction * ((a.updatedAt || 0) - (b.updatedAt || 0)));
}

function filterChats(chats) {
  let filtered = chats;
  if (state.groupFilter) {
    filtered = filtered.filter((chat) => (chat.projectName || "未分组") === state.groupFilter);
  }
  if (state.providerFilter) {
    filtered = filtered.filter((chat) => providerLabel(chat) === state.providerFilter);
  }
  if (state.archiveFilter === "archived") {
    filtered = filtered.filter((chat) => chat.archived);
  } else if (state.archiveFilter === "active") {
    filtered = filtered.filter((chat) => !chat.archived);
  }
  if (!state.search) return filtered;
  return filtered.filter((chat) => {
    if (state.searchHits && chat.threadId && state.searchHits.has(chat.threadId)) return true;
    const haystack = [
      chat.title,
      chat.key,
      chat.projectName || "",
      chat.messages.map((message) => message.content).join(" "),
      formatTime(chat.updatedAt),
      formatTime(chat.createdAt),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(state.search);
  });
}

function render() {
  renderAccounts();
  renderChats();
  renderViewer();
  renderMergePreview();
  renderMigrateSelects();
}

function openMergeInspector() {
  if (migratableAccounts().length < 2) {
    alert("至少需要两个账户（记录源）才能迁移。");
    return;
  }
  renderMigrateSelects();
  state.inspectorOpen = true;
  renderInspectorState();
}

function closeMergeInspector() {
  state.inspectorOpen = false;
  renderInspectorState();
}

function renderInspectorState() {
  els.inspector.classList.toggle("open", state.inspectorOpen);
  els.inspector.setAttribute("aria-hidden", String(!state.inspectorOpen));
  els.inspectorBackdrop.hidden = !state.inspectorOpen;
}

function renderAccounts() {
  els.accountList.innerHTML = "";
  els.accountCount.textContent = String(state.accounts.length);

  const selected = state.accounts.find((item) => item.id === state.selectedAccountId) || state.accounts[0];
  if (selected && selected.id !== state.selectedAccountId) {
    state.selectedAccountId = selected.id;
  }

  state.accounts.forEach((account) => {
    const chatCount = account.chats.length;
    const fileCount = (account.sourceFiles || [account.sourceFile]).length;
    const item = templates.account.content.firstElementChild.cloneNode(true);
    item.classList.toggle("active", account.id === state.selectedAccountId);
    item.querySelector(".account-avatar").textContent = accountInitials(account.name);
    item.querySelector(".item-title").textContent = account.name;
    const badge = item.querySelector(".login-badge");
    if (badge) {
      if (account.loginType === "official") {
        badge.textContent = "官方";
        badge.classList.add("official");
        badge.hidden = false;
      } else if (account.loginType === "apikey") {
        badge.textContent = account.loginDetail ? `中转 · ${account.loginDetail}` : "中转";
        badge.classList.add("apikey");
        badge.hidden = false;
      }
      const stats = accountProviderStats(account);
      if (stats.length) {
        badge.textContent = stats.length > 1 ? `${stats.length} 个中转 · ${stats[0][0]} 等` : `中转 · ${stats[0][0]}`;
        badge.classList.add("apikey");
        badge.hidden = false;
        badge.dataset.tip = stats.map(([name, count]) => `${name}：${count}`).join("\n");
        badge.title = badge.dataset.tip;
      }
    }
    item.querySelector(".item-subtitle").textContent = account.isMerged
      ? `${fileCount} 个来源的合并结果`
      : compactSourcePath(account.sourceFile);
    item.querySelector(".pill").textContent = String(chatCount);
    const hitEntry = state.search && state.globalHits ? state.globalHits[account.sourceFile] : null;
    if (hitEntry && hitEntry.ids.size) {
      const hitBadge = document.createElement("span");
      hitBadge.className = "hit-badge";
      hitBadge.textContent = `${hitEntry.ids.size} 命中`;
      item.querySelector(".pill").after(hitBadge);
    }
    item.addEventListener("click", () => {
      state.selectedAccountId = account.id;
      state.messageLimit = 120;
      applySearchHitsForAccount();
      const first = currentChats()[0];
      state.selectedChatKey = first ? first.key : null;
      render();
      loadSelectedChatDetails();
    });
    els.accountList.appendChild(item);
  });
}

function primaryAccount() {
  const local = state.accounts.filter((account) => !account.isMerged && account.sourceFile?.startsWith("/"));
  return local.find((account) => account.sourceFile === state.primaryHome)
    || local.find((account) => /\/\.codex$/.test(account.sourceFile));
}

function accountIsSelectable(account) {
  return Boolean(account && !account.isMerged && account.sourceFile?.startsWith("/"));
}

function selectionFor(accountId) {
  if (!state.selected.has(accountId)) state.selected.set(accountId, new Set());
  return state.selected.get(accountId);
}

function totalSelected() {
  let count = 0;
  for (const set of state.selected.values()) count += set.size;
  return count;
}

function renderSelectTools(account, chats) {
  const selectable = accountIsSelectable(account);
  els.selectTools.hidden = !selectable && !totalSelected();
  if (els.selectTools.hidden) return;
  const set = account ? selectionFor(account.id) : new Set();
  const visibleIds = chats.filter((chat) => chat.threadId).map((chat) => chat.threadId);
  els.selectAllChk.disabled = !selectable || !visibleIds.length;
  els.selectAllChk.checked = selectable && visibleIds.length > 0 && visibleIds.every((id) => set.has(id));
  const total = totalSelected();
  const isPrimary = account && account === primaryAccount();
  els.selectedCount.textContent = total
    ? `已选 ${total} 个`
    : isPrimary
      ? "勾选要归档/删除的会话"
      : "勾选要写入 Codex 的会话";
  const hasSelection = set.size > 0;
  els.archiveSelBtn.hidden = !(isPrimary && hasSelection);
  els.unarchiveSelBtn.hidden = !(isPrimary && hasSelection);
  els.deleteSelBtn.hidden = !(selectable && hasSelection);
}

function providerLabel(chat, account) {
  const provider = (chat.provider || "").trim();
  if (!provider) return "未记录";
  const owner = account || state.accounts.find((item) => item.id === state.selectedAccountId) || state.accounts[0];
  const hosts = (owner && owner.providerHosts) || {};
  return hosts[provider] ? `${provider}（${hosts[provider]}）` : provider;
}

function accountProviderStats(account) {
  const counts = new Map();
  for (const chat of account?.chats || []) {
    const label = providerLabel(chat, account);
    if (label === "未记录") continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function renderProviderOptions() {
  if (!els.providerSelect) return;
  const account = state.accounts.find((item) => item.id === state.selectedAccountId) || state.accounts[0];
  const names = new Map();
  for (const chat of account?.chats || []) {
    const label = providerLabel(chat);
    names.set(label, (names.get(label) || 0) + 1);
  }
  const sorted = [...names.entries()].sort((a, b) => b[1] - a[1]);
  const previous = state.providerFilter;
  els.providerSelect.innerHTML =
    `<option value="">全部中转（${sorted.length}）</option>` +
    sorted
      .map(([name, count]) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}（${count}）</option>`)
      .join("");
  if (previous && names.has(previous)) {
    els.providerSelect.value = previous;
  } else {
    state.providerFilter = "";
    els.providerSelect.value = "";
  }
}

function renderGroupOptions() {
  const account = state.accounts.find((item) => item.id === state.selectedAccountId) || state.accounts[0];
  const names = new Map();
  for (const chat of account?.chats || []) {
    const name = chat.projectName || "未分组";
    names.set(name, (names.get(name) || 0) + 1);
  }
  const sorted = [...names.entries()].sort((a, b) => b[1] - a[1]);
  const previous = state.groupFilter;
  els.groupSelect.innerHTML = `<option value="">全部分组</option>` + sorted
    .map(([name, count]) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}（${count}）</option>`)
    .join("");
  if (previous && names.has(previous)) {
    els.groupSelect.value = previous;
  } else {
    state.groupFilter = "";
    els.groupSelect.value = "";
  }

  let archivedCount = 0;
  let activeCount = 0;
  for (const chat of account?.chats || []) {
    if (chat.archived) archivedCount += 1;
    else activeCount += 1;
  }
  els.archiveSelect.innerHTML =
    `<option value="">全部状态</option>` +
    `<option value="active">未归档（${activeCount}）</option>` +
    `<option value="archived">已归档（${archivedCount}）</option>`;
  els.archiveSelect.value = state.archiveFilter || "";
  renderProviderOptions();
}

function renderChats() {
  const previousScroll = els.chatList.scrollTop;
  els.chatList.innerHTML = "";
  renderGroupOptions();
  const chats = currentChats();
  els.chatCount.textContent = String(chats.length);

  if (!chats.length) {
    els.chatList.innerHTML = `<div class="empty-state">没有匹配的聊天。</div>`;
    return;
  }

  if (!state.selectedChatKey || !chats.some((chat) => chat.key === state.selectedChatKey)) {
    state.selectedChatKey = chats[0].key;
  }

  const activeAccount = state.accounts.find((item) => item.id === state.selectedAccountId) || state.accounts[0];
  renderSelectTools(activeAccount, chats);
  const selectable = accountIsSelectable(activeAccount);
  const selection = activeAccount ? selectionFor(activeAccount.id) : new Set();

  chats.forEach((chat) => {
    const item = templates.chat.content.firstElementChild.cloneNode(true);
    item.classList.toggle("active", chat.key === state.selectedChatKey);
    const checkbox = item.querySelector(".chat-check");
    if (selectable && chat.threadId) {
      checkbox.hidden = false;
      checkbox.checked = selection.has(chat.threadId);
      checkbox.addEventListener("click", (event) => event.stopPropagation());
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selection.add(chat.threadId);
        else selection.delete(chat.threadId);
        renderSelectTools(activeAccount, chats);
      });
    }
    const titleEl = item.querySelector(".item-title");
    if (state.search) {
      titleEl.innerHTML = highlightHtml(chat.title, state.search);
    } else {
      titleEl.textContent = chat.title;
    }
    const messageLabel = chat.detailsLoaded
      ? `${chat.messageCount ?? chat.messages.length} 条消息`
      : "按需加载";
    const groupLabel = chat.projectName && chat.projectName !== "未分组" ? ` · ${chat.projectName}` : "";
    const provider = providerLabel(chat);
    const providerText = provider && provider !== "未记录" ? ` · ${provider}` : "";
    const archivedLabel = chat.archived ? " · 已归档" : "";
    const subtitleEl = item.querySelector(".item-subtitle");
    const snippet = state.search && chat.threadId ? state.searchSnippets[chat.threadId] : "";
    if (snippet) {
      subtitleEl.innerHTML = highlightHtml(snippet, state.search);
    } else {
      subtitleEl.textContent = `${formatRelativeTime(chat.updatedAt)} · ${messageLabel}${providerText}${groupLabel}${archivedLabel}`;
    }
    item.querySelector(".pill").textContent = formatShortDate(chat.updatedAt);
    item.addEventListener("click", () => selectChat(chat.key));
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      selectChat(chat.key);
      openChatMenu(event, chat, activeAccount);
    });
    els.chatList.appendChild(item);
  });
  els.chatList.scrollTop = previousScroll;
}

function chatMenuElement() {
  let menu = document.getElementById("chatContextMenu");
  if (!menu) {
    menu = document.createElement("div");
    menu.id = "chatContextMenu";
    menu.className = "menu context-menu";
    menu.hidden = true;
    document.body.appendChild(menu);
    document.addEventListener("click", () => { menu.hidden = true; });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") menu.hidden = true;
    });
    window.addEventListener("blur", () => { menu.hidden = true; });
    els.chatList.addEventListener("scroll", () => { menu.hidden = true; });
  }
  return menu;
}

function openChatMenu(event, chat, account) {
  const menu = chatMenuElement();
  const canEdit = accountIsSelectable(account) && Boolean(chat.threadId);
  const actions = [
    { label: "重命名…", run: () => renameChat(chat, account) },
    chat.archived
      ? { label: "取消归档", run: () => runChatAction(chat, account, "unarchive") }
      : { label: "归档", run: () => runChatAction(chat, account, "archive") },
    { label: "彻底删除", danger: true, run: () => runChatAction(chat, account, "purge") },
  ];
  menu.innerHTML = "";
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    if (action.danger) button.className = "danger";
    button.disabled = !canEdit;
    button.addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      menu.hidden = true;
      action.run();
    });
    menu.appendChild(button);
  }
  if (!canEdit) {
    const hint = document.createElement("p");
    hint.className = "context-hint";
    hint.textContent = "只有本机记录源的会话可以修改。";
    menu.appendChild(hint);
  }
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(event.clientX, window.innerWidth - rect.width - 8);
  const top = Math.min(event.clientY, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

async function renameChat(chat, account) {
  const next = prompt("修改会话名称：", chat.title || "");
  if (next === null) return;
  const title = next.trim();
  if (!title || title === chat.title) return;
  setStatus("正在重命名会话...");
  try {
    const response = await fetch("/api/rename-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ home: account.sourceFile, threadId: chat.threadId, title }),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error || `HTTP ${response.status}`);
    chat.title = title;
    persistState();
    render();
    setStatus(`已重命名为「${title}」${payload.codexRunning ? "（Codex 正在运行，重启后生效）" : ""}`);
  } catch (error) {
    console.error(error);
    setStatus("重命名失败。");
    alert(`重命名失败：${error.message || error}`);
  }
}

async function runChatAction(chat, account, mode) {
  const label = mode === "purge" ? "彻底删除" : mode === "unarchive" ? "取消归档" : "归档";
  const extra = mode === "purge"
    ? "\n聊天文件会移入 deleted_sessions 回收目录（可在回收站恢复），写入前自动备份。"
    : "";
  if (!confirm(`确定${label}「${chat.title}」？${extra}`)) return;
  setStatus(`正在${label}会话...`);
  try {
    const response = await fetch("/api/delete-threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ home: account.sourceFile, threadIds: [chat.threadId], mode }),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error || `HTTP ${response.status}`);
    setStatus(`已${label}「${chat.title}」${payload.codexRunning ? "（Codex 正在运行，重启后生效）" : ""}`);
    scanLocalCodex();
  } catch (error) {
    console.error(error);
    setStatus(`${label}失败。`);
    alert(`${label}失败：${error.message || error}`);
  }
}

function selectChat(key) {
  state.selectedChatKey = key;
  state.messageLimit = 120;
  for (const item of els.chatList.children) {
    if (item.classList) item.classList.remove("active");
  }
  const chats = currentChats();
  const index = chats.findIndex((chat) => chat.key === key);
  const node = els.chatList.children[index];
  if (node && node.classList) {
    node.classList.add("active");
    node.scrollIntoView({ block: "nearest" });
  }
  renderViewer();
  loadSelectedChatDetails();
}

function renderViewer() {
  const account = state.accounts.find((item) => item.id === state.selectedAccountId) || state.accounts[0];
  const chat = account ? account.chats.find((item) => item.key === state.selectedChatKey) : null;

  els.selectedAccountLabel.textContent = account ? account.name : "未选择账户";
  els.selectedChatTitle.textContent = chat ? chat.title : "选择一个聊天";
  els.chatMeta.textContent = chat
    ? `${chat.detailsLoaded ? `${chat.messageCount} 条消息 · ` : ""}更新于 ${formatTime(chat.updatedAt)}`
    : "";

  els.stats.innerHTML = [
    statChip(state.accounts.length, "记录源"),
    statChip(totalChats(), "会话"),
  ].join("");
  const conflicts = countMergedConflicts();
  els.mergeBadge.textContent = String(conflicts);
  els.mergeBadge.classList.toggle("visible", conflicts > 0);
  renderInspectorState();

  if (!chat) {
    els.messageList.classList.add("empty-state");
    els.messageList.innerHTML = "还没有选中聊天。";
    return;
  }

  if (chat.detailsLoading) {
    els.messageList.classList.add("empty-state");
    els.messageList.innerHTML = "正在读取完整会话...";
    return;
  }

  els.messageList.classList.remove("empty-state");
  els.messageList.innerHTML = "";
  els.copyChatBtn.hidden = !chat.messages.length;
  if (!chat.messages.length) {
    els.messageList.innerHTML = `<div class="empty-state">这个聊天没有消息。</div>`;
    return;
  }

  const visible = chat.messages.slice(0, state.messageLimit);
  const fragment = document.createDocumentFragment();
  visible.forEach((message) => {
    fragment.appendChild(buildMessageNode(message));
  });
  els.messageList.appendChild(fragment);

  if (chat.messages.length > visible.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "load-more-messages";
    more.textContent = `显示更多（还有 ${chat.messages.length - visible.length} 条）`;
    more.addEventListener("click", () => {
      state.messageLimit += 200;
      const scroll = els.messageList.scrollTop;
      renderViewer();
      els.messageList.scrollTop = scroll;
    });
    els.messageList.appendChild(more);
  }
}

function buildMessageNode(message) {
  const item = templates.message.content.firstElementChild.cloneNode(true);
  const role = String(message.role || "message").toLowerCase();
  item.classList.add(role === "user" ? "user" : "assistant");
  item.querySelector(".role").textContent = roleLabel(role);
  item.querySelector(".message-time").textContent = message.timestamp ? formatTime(message.timestamp) : "";
  const pre = item.querySelector("pre");
  const content = message.content || "";
  if (state.search) {
    pre.innerHTML = highlightHtml(content, state.search);
  } else if (looksLikeMarkdown(content)) {
    const container = document.createElement("div");
    container.className = "md";
    container.innerHTML = renderMarkdown(content);
    pre.replaceWith(container);
  } else {
    pre.textContent = content;
  }
  const copyButton = item.querySelector(".copy-message");
  copyButton.dataset.tip = "复制消息";
  copyButton.removeAttribute("title");
  copyButton.addEventListener("click", async () => {
    await copyText(content);
    copyButton.dataset.tip = "已复制";
    setTimeout(() => { copyButton.dataset.tip = "复制消息"; }, 1200);
  });
  return item;
}

async function copyCurrentChat() {
  const account = state.accounts.find((item) => item.id === state.selectedAccountId) || state.accounts[0];
  const chat = account ? account.chats.find((item) => item.key === state.selectedChatKey) : null;
  if (!chat || !chat.messages.length) return;
  const text = chat.messages
    .map((message) => `${roleLabel(String(message.role || "message").toLowerCase())}：\n${message.content || ""}`)
    .join("\n\n---\n\n");
  await copyText(`# ${chat.title}\n\n${text}`);
  els.copyChatBtn.dataset.tip = "已复制";
  setTimeout(() => { els.copyChatBtn.dataset.tip = "复制整个会话"; }, 1200);
}

function renderProjectNameOptions() {
  if (!els.projectNameOptions) return;
  const names = new Set();
  for (const account of state.accounts) {
    for (const chat of account.chats) {
      const name = (chat.projectName || "").trim();
      if (name && name !== "未分组") names.add(name);
    }
  }
  els.projectNameOptions.innerHTML = [...names]
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
    .map((name) => `<option value="${escapeHtml(name)}"></option>`)
    .join("");
}

function renderMergePreview() {
  renderProjectNameOptions();
  const eligible = mergeEligibleAccounts();
  if (eligible.length < 2) {
    state.merged = null;
    els.mergeMeta.textContent = "0";
    els.confirmMergeBtn.disabled = true;
    els.mergePreview.innerHTML = `<div class="empty-state">导入两个或以上账户后，这里会显示合并预览。</div>`;
    return;
  }

  const merged = mergeAccounts(eligible);
  state.merged = merged;
  els.mergeMeta.textContent = String(merged.chats.length);
  els.confirmMergeBtn.disabled = false;
  els.mergePreview.innerHTML = merged.chats
    .slice(0, 12)
    .map((chat) => {
      const conflict = chat.versions.length > 1 ? `<div class="merge-conflict">存在 ${chat.versions.length} 个版本，已保留最新时间戳。</div>` : "";
      return `
        <div class="merge-item">
          <strong>${escapeHtml(chat.title)}</strong>
          <small>${escapeHtml(chat.sourceAccounts.join(" / "))} · ${formatTime(chat.updatedAt)} · ${chat.messageCount} 条消息</small>
          ${conflict}
        </div>
      `;
    })
    .join("");
}

function mergeSelectedAccounts() {
  const eligible = mergeEligibleAccounts();
  if (eligible.length < 2) {
    alert("至少导入两个账户后再合并。");
    return;
  }

  const merged = mergeAccounts(eligible);
  const mergedAccount = {
    id: stableId(`merged-${Date.now()}`),
    name: `Merged ${formatDateCompact(Date.now())}`,
    sourceFile: "merged-output",
    importedAt: Date.now(),
    isMerged: true,
    chats: merged.chats.map((chat) => ({
      ...chat,
      sourceAccount: chat.sourceAccounts.join(" / "),
    })),
  };

  state.accounts.push(mergedAccount);
  state.selectedAccountId = mergedAccount.id;
  state.selectedChatKey = mergedAccount.chats[0]?.key || null;
  state.inspectorOpen = false;
  persistState();
  render();
}

async function deleteSelectedFromCodex(mode) {
  const account = state.accounts.find((item) => item.id === state.selectedAccountId);
  if (!accountIsSelectable(account)) return;
  const set = state.selected.get(account.id);
  if (!set || !set.size) return;
  const label = mode === "purge" ? "彻底删除" : mode === "unarchive" ? "取消归档" : "归档";
  const extra = mode === "purge"
    ? "\n会话将从 Codex 数据库和列表中移除，聊天文件移入 deleted_sessions 回收目录，写入前会自动备份。"
    : mode === "unarchive"
      ? "\n会话会重新出现在 Codex 侧栏，写入前会自动备份。"
      : "\n会话会从 Codex 侧栏隐藏（可随时取消归档恢复），写入前会自动备份。";
  if (!confirm(`确定${label}「${account.name}」的 ${set.size} 个选中会话？${extra}`)) return;

  setStatus(`正在${label}选中会话...`);
  try {
    const response = await fetch("/api/delete-threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ home: account.sourceFile, threadIds: [...set], mode }),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error || `HTTP ${response.status}`);
    const summary = mode === "purge"
      ? `已彻底删除 ${payload.deleted || 0} 个会话（聊天文件已移入回收目录）。`
      : mode === "unarchive"
        ? `已取消归档 ${payload.unarchived || 0} 个会话。`
        : `已归档 ${payload.archived || 0} 个会话。`;
    setStatus(summary);
    alert(`${summary}\n${payload.codexRunning ? "检测到 Codex 正在运行，请完全退出并重启 Codex 后查看。" : "重新打开 Codex 即可生效。"}`);
    state.selected.clear();
    scanLocalCodex();
  } catch (error) {
    console.error(error);
    setStatus(`${label}失败：${error.message}`);
    alert(`${label}失败：${error.message}`);
  }
}

function migratableAccounts() {
  return state.accounts.filter((account) => !account.isMerged && account.sourceFile?.startsWith("/"));
}

function renderMigrateSelects() {
  if (!els.migrateSource || !els.migrateTarget) return;
  const accounts = migratableAccounts();
  const options = accounts
    .map((account) => `<option value="${account.sourceFile}">${account.name}（${account.chats.length} 条）</option>`)
    .join("");
  for (const select of [els.migrateSource, els.migrateTarget]) {
    const keep = select.value;
    select.innerHTML = options;
    if (keep && accounts.some((account) => account.sourceFile === keep)) select.value = keep;
  }
  if (accounts.length > 1 && !els.migrateSource.dataset.touched) {
    const target = primaryAccount() || accounts[0];
    els.migrateTarget.value = target.sourceFile;
    const source = accounts.find((account) => account.sourceFile !== target.sourceFile);
    if (source) els.migrateSource.value = source.sourceFile;
  }
}

async function applyMergeToCodex() {
  const accounts = migratableAccounts();
  const source = accounts.find((account) => account.sourceFile === els.migrateSource?.value);
  const target = accounts.find((account) => account.sourceFile === els.migrateTarget?.value);
  if (!source || !target) {
    alert("请先选择来源账户和目标账户。");
    return;
  }
  if (source === target) {
    alert("来源账户和目标账户不能是同一个。");
    return;
  }

  const set = state.selected.get(source.id);
  const threadIds = set && set.size ? [...set] : null;
  const scope = threadIds ? `勾选的 ${threadIds.length} 个会话` : `全部 ${source.chats.length} 个会话`;
  const projectName = els.projectNameInput ? els.projectNameInput.value.trim() : "";
  const projectHint = projectName ? `\n迁移后会放在侧栏文件夹「${projectName}」里。` : "";
  if (!confirm(`把「${source.name}」的${scope}迁移到「${target.name}」（${target.sourceFile}）？${projectHint}\n写入前会自动备份目标账户。`)) return;

  els.applyMergeBtn.disabled = true;
  setStatus("正在迁移聊天记录...");
  try {
    const body = { source: source.sourceFile, target: target.sourceFile };
    if (threadIds) body.threadIds = threadIds;
    if (projectName) body.projectName = projectName;
    const response = await fetch("/api/apply-merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error || `HTTP ${response.status}`);
    const inserted = payload.inserted || 0;
    const updated = payload.updated || 0;
    const unarchived = payload.unarchived || 0;
    const codexRunning = payload.codexRunning;
    const summary = `迁移完成：新增 ${inserted} 个会话，更新 ${updated} 个（其中取消归档 ${unarchived} 个）。${projectName ? `已放入侧栏文件夹「${projectName}」。` : ""}`;
    setStatus(summary);
    alert(`${summary}\n${codexRunning ? "检测到 Codex 正在运行，请完全退出并重启 Codex 后查看。" : "请重新打开 Codex 查看。"}`);
    state.selected.clear();
    state.inspectorOpen = false;
    renderInspectorState();
    scanLocalCodex();
  } catch (error) {
    console.error(error);
    setStatus(`迁移失败：${error.message}`);
    alert(`迁移失败：${error.message}`);
  } finally {
    els.applyMergeBtn.disabled = false;
  }
}

function loginLabel(account) {
  if (account.loginType === "official") return "官方";
  if (account.loginType === "apikey") return account.loginDetail ? `中转 · ${account.loginDetail}` : "中转";
  return "";
}

function accountDisplayName(account) {
  const label = loginLabel(account);
  return label ? `${account.name}（${label}）` : account.name;
}

function mergeEligibleAccounts() {
  return state.accounts.filter((account) => account.chats.length && !account.isMerged && account.sourceFile !== "merged-output");
}

async function loadSelectedChatDetails() {
  const account = state.accounts.find((item) => item.id === state.selectedAccountId) || state.accounts[0];
  const chat = account?.chats.find((item) => item.key === state.selectedChatKey);
  if (!account || !chat || chat.detailsLoaded || chat.detailsLoading || !chat.threadId) return;

  const sourceForLoad = account.isMerged ? chat.sourceFile : account.sourceFile;
  if (!sourceForLoad || !sourceForLoad.startsWith("/")) return;

  chat.detailsLoading = true;
  renderViewer();
  try {
    const query = new URLSearchParams({ source: sourceForLoad, thread: chat.threadId });
    const response = await fetch(`/api/messages?${query}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    chat.messages = Array.isArray(payload.messages) ? payload.messages : [];
    chat.messageCount = payload.messageCount ?? chat.messages.length;
    chat.detailsLoaded = true;
  } catch (error) {
    console.error(error);
    setStatus("会话内容读取失败，可重新扫描后再试。");
  } finally {
    chat.detailsLoading = false;
    renderChats();
    renderViewer();
  }
}

function mergeAccounts(accounts) {
  const buckets = new Map();

  for (const account of accounts) {
    for (const chat of account.chats) {
      const key = chat.key || stableId(chat.title);
      const bucket = buckets.get(key) || {
        key,
        title: chat.title,
        updatedAt: chat.updatedAt || 0,
        createdAt: chat.createdAt || 0,
        messageCount: chat.messageCount ?? chat.messages.length,
        messages: chat.messages,
        threadId: chat.threadId,
        sourceFile: account.sourceFile,
        detailsLoaded: chat.detailsLoaded,
        versions: [],
        sourceAccounts: [],
        raw: chat.raw,
      };

      bucket.versions.push({
        accountName: accountDisplayName(account),
        updatedAt: chat.updatedAt || 0,
        createdAt: chat.createdAt || 0,
        messageCount: chat.messageCount ?? chat.messages.length,
        chat,
      });
      bucket.sourceAccounts.push(accountDisplayName(account));

      const shouldReplace =
        (chat.updatedAt || 0) > bucket.updatedAt ||
        ((chat.updatedAt || 0) === bucket.updatedAt && (chat.messageCount ?? chat.messages.length) > bucket.messageCount);

      if (shouldReplace) {
        bucket.title = chat.title;
        bucket.updatedAt = chat.updatedAt || 0;
        bucket.createdAt = chat.createdAt || 0;
        bucket.messageCount = chat.messageCount ?? chat.messages.length;
        bucket.messages = chat.messages;
        bucket.threadId = chat.threadId;
        bucket.sourceFile = account.sourceFile;
        bucket.detailsLoaded = chat.detailsLoaded;
        bucket.raw = chat.raw;
      }

      buckets.set(key, bucket);
    }
  }

  const chats = [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      sourceAccounts: [...new Set(bucket.sourceAccounts)],
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  return { chats };
}

async function exportCurrentView() {
  const account = state.accounts.find((item) => item.id === state.selectedAccountId) || state.accounts[0];
  if (!account) {
    alert("还没有可导出的数据。");
    return;
  }
  if (!account.isMerged && account.sourceFile?.startsWith("/")) {
    setStatus(`正在读取并导出 ${account.name} 的完整记录...`);
    try {
      const query = new URLSearchParams({ source: account.sourceFile });
      const response = await fetch(`/api/export?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await downloadBlob(await response.blob(), `${slugify(account.name)}.json`);
      setStatus(`已导出 ${account.name} 的完整记录。`);
      return;
    } catch (error) {
      console.error(error);
      setStatus("完整记录导出失败。");
      return;
    }
  }
  downloadJson(account, `${slugify(account.name)}.json`);
}

async function exportCurrentAsMarkdown() {
  const account = state.accounts.find((item) => item.id === state.selectedAccountId) || state.accounts[0];
  if (!account) {
    alert("还没有可导出的数据。");
    return;
  }
  let source = account;
  if (!account.isMerged && account.sourceFile?.startsWith("/")) {
    setStatus(`正在读取 ${account.name} 的完整记录用于 Markdown 导出...`);
    try {
      const query = new URLSearchParams({ source: account.sourceFile });
      const response = await fetch(`/api/export?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      source = await response.json();
    } catch (error) {
      console.error(error);
      setStatus("Markdown 导出失败。");
      return;
    }
  }
  const lines = [`# ${source.name || "Codex 记录"}`, ""];
  for (const chat of source.chats || []) {
    lines.push(`## ${chat.title || "未命名会话"}`);
    lines.push("");
    lines.push(`> 更新于 ${formatTime(chat.updatedAt)} · ${(chat.messages || []).length} 条消息`);
    lines.push("");
    for (const message of chat.messages || []) {
      const role = roleLabel(String(message.role || "message").toLowerCase());
      lines.push(`**${role}**（${message.timestamp ? formatTime(message.timestamp) : "时间未知"}）：`);
      lines.push("");
      lines.push(String(message.content || ""));
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  await downloadBlob(blob, `${slugify(account.name)}.md`);
  setStatus(`已导出 ${account.name} 的 Markdown。`);
}

function clearAll() {
  if (!confirm("确定要清空本地导入记录吗？")) return;
  state.accounts = [];
  state.selectedAccountId = null;
  state.selectedChatKey = null;
  state.merged = null;
  localStorage.removeItem("codex-merge-studio");
  syncMergedAccounts();
  render();
}

function totalChats() {
  return state.accounts.reduce((sum, account) => sum + account.chats.length, 0);
}

function countMergedConflicts() {
  const seen = new Map();
  let conflicts = 0;
  for (const account of state.accounts) {
    if (account.isMerged || account.sourceFile === "merged-output") continue;
    for (const chat of account.chats) {
      const key = chat.key;
      const current = seen.get(key) || 0;
      seen.set(key, current + 1);
    }
  }
  for (const count of seen.values()) {
    if (count > 1) conflicts += 1;
  }
  return conflicts;
}

function selectedAccountName() {
  const account = state.accounts.find((item) => item.id === state.selectedAccountId);
  return account ? account.name : "";
}

function statChip(value, label) {
  return `<span class="stat"><strong>${escapeHtml(value)}</strong>${escapeHtml(label)}</span>`;
}

function roleLabel(role) {
  if (role === "user") return "你";
  if (role === "assistant") return "Codex";
  if (role === "system") return "系统";
  return role || "消息";
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

function accountInitials(name) {
  const text = String(name || "C").replace(/\/.codex$/i, "").trim();
  const parts = text.split(/[\s/_-]+/).filter(Boolean);
  if (!parts.length) return "C";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function compactSourcePath(value) {
  const text = String(value || "本地记录");
  const homeMatch = text.match(/\/Users\/[^/]+\/(.*)$/);
  return homeMatch ? `~/${homeMatch[1]}` : text;
}

function formatShortDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date);
}

function formatRelativeTime(value) {
  if (!value) return "未知时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";
  const delta = Date.now() - date.getTime();
  if (delta >= 0 && delta < 60 * 60 * 1000) return `${Math.max(1, Math.floor(delta / 60000))} 分钟前`;
  if (delta >= 0 && delta < 24 * 60 * 60 * 1000) return `${Math.floor(delta / 3600000)} 小时前`;
  if (delta >= 0 && delta < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(delta / 86400000)} 天前`;
  return formatTime(value);
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  downloadBlob(blob, filename);
}

async function downloadBlob(blob, filename) {
  if (location.protocol !== "file:") {
    try {
      const response = await fetch("/api/save-file", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Filename": encodeURIComponent(filename),
        },
        body: blob,
      });
      const payload = await response.json();
      if (response.ok && !payload.error) {
        setStatus(`已导出到 ${payload.path}`);
        alert(`已导出到：\n${payload.path}`);
        return;
      }
    } catch (error) {
      console.error(error);
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function inferString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function toMillis(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") {
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stableId(text) {
  let hash = 2166136261;
  const str = String(text ?? "");
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `k_${(hash >>> 0).toString(36)}`;
}

function slugify(text) {
  return String(text || "export")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "export";
}

function stripExtension(name) {
  return String(name || "imported").replace(/\.[^.]+$/, "");
}

function formatTime(value) {
  if (!value) return "未知时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatDateCompact(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .replace(/\//g, "");
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightHtml(text, needle) {
  const escaped = escapeHtml(text);
  if (!needle) return escaped;
  const pattern = new RegExp(escapeRegExp(escapeHtml(needle)), "gi");
  return escaped.replace(pattern, (match) => `<mark>${match}</mark>`);
}

function looksLikeMarkdown(text) {
  const value = String(text || "");
  return /```|^#{1,4}\s|^\s*[-*]\s+\S|^\s*\d+\.\s+\S|\*\*[^*]+\*\*|`[^`]+`|^>\s/m.test(value);
}

function renderMarkdown(text) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  const blocks = [];
  const withPlaceholders = source.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    blocks.push({ lang: lang.trim().toLowerCase(), code });
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });

  const lines = withPlaceholders.split("\n");
  const html = [];
  let listType = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${paragraph.join("<br>")}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const line of lines) {
    const blockMatch = line.match(/^\u0000BLOCK(\d+)\u0000\s*$/);
    if (blockMatch) {
      flushParagraph();
      closeList();
      const block = blocks[Number(blockMatch[1])];
      html.push(`<pre class="code-block"><code>${highlightCode(block.code, block.lang)}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_]){3,}\s*$/.test(line)) {
      flushParagraph();
      closeList();
      html.push("<hr>");
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      closeList();
      html.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }
    const unordered = line.match(/^\s*[-*]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (unordered || ordered) {
      flushParagraph();
      const wanted = unordered ? "ul" : "ol";
      if (listType !== wanted) {
        closeList();
        html.push(`<${wanted}>`);
        listType = wanted;
      }
      html.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }
    paragraph.push(inlineMarkdown(line));
  }
  flushParagraph();
  closeList();
  return html.join("\n");
}

function inlineMarkdown(text) {
  let out = escapeHtml(text);
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (_match, code) => {
    codes.push(code);
    return `\u0000CODE${codes.length - 1}\u0000`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  out = out.replace(/\u0000CODE(\d+)\u0000/g, (_match, index) => `<code>${codes[Number(index)]}</code>`);
  return out;
}

function highlightCode(code, lang) {
  let out = escapeHtml(code.replace(/\n$/, ""));
  const strings = [];
  const comments = [];
  out = out.replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;|&#39;(?:[^&]|&(?!#39;))*?&#39;|`[^`]*`)/g, (match) => {
    strings.push(match);
    return `\u0000STR${strings.length - 1}\u0000`;
  });
  out = out.replace(/((?:^|\n)\s*(?:#|\/\/)[^\n]*)/g, (match) => {
    comments.push(match);
    return `\u0000COM${comments.length - 1}\u0000`;
  });
  const keywords = /\b(function|return|const|let|var|if|else|elif|for|while|def|class|import|from|export|async|await|try|except|catch|finally|with|as|in|is|not|and|or|None|True|False|null|undefined|true|false|new|this|self|pass|raise|lambda|yield|break|continue|switch|case|default|struct|fn|impl|pub|match|type|interface)\b/g;
  out = out.replace(keywords, '<span class="tok-kw">$1</span>');
  out = out.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-num">$1</span>');
  out = out.replace(/\u0000COM(\d+)\u0000/g, (_match, index) => `<span class="tok-com">${comments[Number(index)]}</span>`);
  out = out.replace(/\u0000STR(\d+)\u0000/g, (_match, index) => `<span class="tok-str">${strings[Number(index)]}</span>`);
  return out;
}

if (state.accounts.length && !state.selectedAccountId) {
  state.selectedAccountId = state.accounts[0].id;
}

initTheme();
initTooltips();
initColumnResizers();

function initTooltips() {
  document.querySelectorAll("[title]").forEach((node) => {
    node.dataset.tip = node.getAttribute("title");
    node.removeAttribute("title");
  });
}

function initColumnResizers() {
  const workspace = document.querySelector(".workspace");
  if (!workspace) return;

  const STORAGE_KEY = "codexColumnWidths";
  const LIMITS = {
    "--col-sources": { min: 160, max: 420 },
    "--col-sessions": { min: 240, max: 620 },
  };

  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    saved = {};
  }
  for (const [varName, limit] of Object.entries(LIMITS)) {
    const value = Number(saved[varName]);
    if (Number.isFinite(value)) {
      workspace.style.setProperty(varName, `${clamp(value, limit.min, limit.max)}px`);
    }
  }

  bindResizer("resizerSources", "--col-sources", ".sources-pane");
  bindResizer("resizerSessions", "--col-sessions", ".sessions-pane");

  function bindResizer(id, varName, paneSelector) {
    const handle = document.getElementById(id);
    const pane = workspace.querySelector(paneSelector);
    if (!handle || !pane) return;

    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = pane.getBoundingClientRect().width;
      const limit = LIMITS[varName];
      handle.setPointerCapture(event.pointerId);
      handle.classList.add("dragging");
      document.body.classList.add("col-resizing");

      const onMove = (moveEvent) => {
        const width = clamp(startWidth + (moveEvent.clientX - startX), limit.min, limit.max);
        workspace.style.setProperty(varName, `${width}px`);
      };
      const onUp = () => {
        handle.classList.remove("dragging");
        document.body.classList.remove("col-resizing");
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        saved[varName] = Math.round(pane.getBoundingClientRect().width);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
        } catch {
          /* localStorage 不可用时忽略 */
        }
      };

      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    });

    handle.addEventListener("dblclick", () => {
      workspace.style.removeProperty(varName);
      delete saved[varName];
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      } catch {
        /* ignore */
      }
    });
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
}

render();

if (location.protocol !== "file:") {
  if (!state.accounts.length) {
    scanLocalCodex();
  }
  restoreMergedAccounts();
}
