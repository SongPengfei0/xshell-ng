import { FitAddon } from "@xterm/addon-fit";
import {
  SearchAddon,
  type ISearchOptions,
  type ISearchResultChangeEvent
} from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { createIcons, icons } from "lucide";
import type {
  AuthMethod,
  FileListEntry,
  SshProfile,
  TunnelCreateRequest,
  TunnelInfo,
  TunnelType,
  TransferDirection,
  TransferProgressEvent,
  TransferStatus,
  TransferSummary
} from "../shared/ipc";
import "./styles.css";

interface TerminalTab {
  id: string;
  title: string;
  profile: SshProfile;
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  element: HTMLDivElement;
  sessionId?: string;
  status: "idle" | "connecting" | "connected" | "disconnected" | "error";
}

interface Preferences {
  fontSize: number;
  theme: "classic" | "midnight" | "paper";
  cursorBlink: boolean;
}

interface FilePaneState {
  path: string;
  parentPath?: string;
  entries: FileListEntry[];
  selectedPath?: string;
  selectedPaths?: string[];
}

interface SftpState {
  sessionId?: string;
  local: FilePaneState;
  remote: FilePaneState;
}

interface SftpTransferQueueItem {
  id: string;
  sessionId: string;
  direction: TransferDirection;
  name: string;
  sourcePath: string;
  targetPath: string;
  localPath?: string;
  remoteDirectory?: string;
  remoteName?: string;
  remotePath?: string;
  localDirectory?: string;
  localName?: string;
  status: TransferStatus;
  percent: number;
  message: string;
  summary: TransferSummary;
  total: TransferSummary;
  currentPath?: string;
  activeFileBytes?: number;
  activeFileTransferred?: number;
  createdAt: number;
}

const PROFILE_STORAGE_KEY = "xshell-ng.profiles.v1";
const PREF_STORAGE_KEY = "xshell-ng.preferences.v1";

const $ = <T extends HTMLElement>(selector: string) => {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element;
};

const elements = {
  exitFullscreen: $("#exit-fullscreen") as HTMLButtonElement,
  fullscreenMenu: $("#fullscreen-menu"),
  sidebar: $("#sidebar"),
  sessionList: $("#session-list"),
  sessionSearch: $("#session-search") as HTMLInputElement,
  tabStrip: $("#tab-strip"),
  terminalStack: $("#terminal-stack"),
  terminalSearch: $("#terminal-search"),
  terminalSearchQuery: $("#terminal-search-query") as HTMLInputElement,
  terminalSearchCount: $("#terminal-search-count"),
  terminalSearchPrevious: $("#terminal-search-previous") as HTMLButtonElement,
  terminalSearchNext: $("#terminal-search-next") as HTMLButtonElement,
  terminalSearchCase: $("#terminal-search-case") as HTMLButtonElement,
  terminalSearchWord: $("#terminal-search-word") as HTMLButtonElement,
  terminalSearchRegex: $("#terminal-search-regex") as HTMLButtonElement,
  terminalSearchClose: $("#terminal-search-close") as HTMLButtonElement,
  emptyWorkspace: $("#empty-workspace"),
  statusLeft: $("#status-left"),
  statusRight: $("#status-right"),
  connectionDialog: $("#connection-dialog") as HTMLDialogElement,
  preferencesDialog: $("#preferences-dialog") as HTMLDialogElement,
  tunnelDialog: $("#tunnel-dialog") as HTMLDialogElement,
  sftpDialog: $("#sftp-dialog") as HTMLDialogElement,
  profileForm: $("#profile-form") as HTMLFormElement,
  dialogTitle: $("#dialog-title"),
  dialogSubtitle: $("#dialog-subtitle"),
  profileName: $("#profile-name") as HTMLInputElement,
  profileGroup: $("#profile-group") as HTMLInputElement,
  profileHost: $("#profile-host") as HTMLInputElement,
  profilePort: $("#profile-port") as HTMLInputElement,
  profileUsername: $("#profile-username") as HTMLInputElement,
  profilePassword: $("#profile-password") as HTMLInputElement,
  profileRemember: $("#profile-remember") as HTMLInputElement,
  profileKeyPath: $("#profile-key-path") as HTMLInputElement,
  profilePassphrase: $("#profile-passphrase") as HTMLInputElement,
  profileSave: $("#profile-save") as HTMLInputElement,
  passwordFields: $("#password-fields"),
  keyFields: $("#key-fields"),
  prefFontSize: $("#pref-font-size") as HTMLInputElement,
  prefTheme: $("#pref-theme") as HTMLSelectElement,
  prefCursorBlink: $("#pref-cursor-blink") as HTMLInputElement,
  tunnelSubtitle: $("#tunnel-subtitle"),
  tunnelForm: $("#tunnel-form") as HTMLFormElement,
  tunnelName: $("#tunnel-name") as HTMLInputElement,
  tunnelBindHost: $("#tunnel-bind-host") as HTMLInputElement,
  tunnelBindPort: $("#tunnel-bind-port") as HTMLInputElement,
  tunnelBindHostLabel: $("#tunnel-bind-host-label"),
  tunnelBindPortLabel: $("#tunnel-bind-port-label"),
  tunnelTargetHost: $("#tunnel-target-host") as HTMLInputElement,
  tunnelTargetPort: $("#tunnel-target-port") as HTMLInputElement,
  tunnelTargetHostRow: $("#tunnel-target-host-row"),
  tunnelTargetPortRow: $("#tunnel-target-port-row"),
  tunnelTargetHostLabel: $("#tunnel-target-host-label"),
  tunnelTargetPortLabel: $("#tunnel-target-port-label"),
  tunnelSummary: $("#tunnel-summary"),
  tunnelList: $("#tunnel-list"),
  sftpSubtitle: $("#sftp-subtitle"),
  sftpLocalPath: $("#sftp-local-path") as HTMLInputElement,
  sftpRemotePath: $("#sftp-remote-path") as HTMLInputElement,
  sftpLocalList: $("#sftp-local-list"),
  sftpRemoteList: $("#sftp-remote-list"),
  sftpLocalCount: $("#sftp-local-count"),
  sftpRemoteCount: $("#sftp-remote-count"),
  sftpStatus: $("#sftp-status"),
  sftpProgressFill: $("#sftp-progress-fill"),
  sftpProgressPercent: $("#sftp-progress-percent"),
  sftpProgressDetail: $("#sftp-progress-detail"),
  sftpQueueSummary: $("#sftp-queue-summary"),
  sftpTransferQueue: $("#sftp-transfer-queue"),
  sftpInputOverlay: $("#sftp-input-overlay"),
  sftpInputForm: $("#sftp-input-form") as HTMLFormElement,
  sftpInputTitle: $("#sftp-input-title"),
  sftpInputLabel: $("#sftp-input-label"),
  sftpInputValue: $("#sftp-input-value") as HTMLInputElement,
  toast: $("#toast")
};

let profiles: SshProfile[] = loadProfiles();
let tabs: TerminalTab[] = [];
let activeTabId: string | undefined;
let editingProfileId: string | undefined;
let preferences: Preferences = loadPreferences();
let toastTimer: number | undefined;
let pendingSftpInput: ((value: string | undefined) => void) | undefined;
let isTerminalSearchOpen = false;
let activeSftpTransferId: string | undefined;
let sftpTransferQueue: SftpTransferQueueItem[] = [];
let tunnelState: { sessionId?: string; tunnels: TunnelInfo[] } = {
  tunnels: []
};
let sftpState: SftpState = {
  local: { path: "", entries: [] },
  remote: { path: ".", entries: [] }
};

const terminalThemes = {
  classic: {
    background: "#071326",
    foreground: "#dbe8ff",
    cursor: "#00c2ff",
    selectionBackground: "#123d9f",
    black: "#08111f",
    red: "#ff6b7c",
    green: "#34d399",
    yellow: "#fbbf24",
    blue: "#3b82ff",
    magenta: "#a78bfa",
    cyan: "#00c2ff",
    white: "#e8f0ff",
    brightBlack: "#64748b",
    brightRed: "#fb7185",
    brightGreen: "#86efac",
    brightYellow: "#fde68a",
    brightBlue: "#73a7ff",
    brightMagenta: "#c4b5fd",
    brightCyan: "#67e8f9",
    brightWhite: "#ffffff"
  },
  midnight: {
    background: "#061021",
    foreground: "#eaf2ff",
    cursor: "#00c2ff",
    selectionBackground: "#0d3b91",
    black: "#061021",
    red: "#fb7185",
    green: "#34d399",
    yellow: "#fbbf24",
    blue: "#2f6cff",
    magenta: "#c084fc",
    cyan: "#00c2ff",
    white: "#e5e7eb"
  },
  paper: {
    background: "#f8fbff",
    foreground: "#202124",
    cursor: "#202124",
    selectionBackground: "#cfe0ff",
    black: "#202124",
    red: "#c2410c",
    green: "#15803d",
    yellow: "#a16207",
    blue: "#002fa7",
    magenta: "#7e22ce",
    cyan: "#007ea7",
    white: "#f8fafc"
  }
};

const terminalSearchDecorations: ISearchOptions["decorations"] = {
  matchBackground: "#fff1a8",
  matchBorder: "#d97706",
  matchOverviewRuler: "#d97706",
  activeMatchBackground: "#b7ccff",
  activeMatchBorder: "#002fa7",
  activeMatchColorOverviewRuler: "#002fa7"
};

function createId() {
  return crypto.randomUUID();
}

function loadProfiles() {
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SshProfile[]) : [];
  } catch {
    return [];
  }
}

function saveProfiles() {
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profiles));
}

function loadPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(PREF_STORAGE_KEY);
    if (raw) {
      return { fontSize: 14, theme: "classic", cursorBlink: true, ...JSON.parse(raw) };
    }
  } catch {
    // Fall through to defaults.
  }

  return {
    fontSize: 14,
    theme: "classic",
    cursorBlink: true
  };
}

function savePreferences() {
  localStorage.setItem(PREF_STORAGE_KEY, JSON.stringify(preferences));
}

function sanitizeProfile(profile: SshProfile): SshProfile {
  return {
    ...profile,
    password: "",
    passphrase: ""
  };
}

function passwordSecretKey(profileId: string) {
  return `profile:${profileId}:password`;
}

async function saveProfileSecret(profile: SshProfile) {
  if (profile.authMethod !== "password") {
    await window.xshellBridge.secretDelete({ key: passwordSecretKey(profile.id) });
    return;
  }

  if (profile.rememberPassword && profile.password) {
    await window.xshellBridge.secretSet({
      key: passwordSecretKey(profile.id),
      value: profile.password
    });
    return;
  }

  if (!profile.rememberPassword) {
    await window.xshellBridge.secretDelete({ key: passwordSecretKey(profile.id) });
  }
}

async function profileWithStoredPassword(profile: SshProfile) {
  if (profile.authMethod !== "password" || profile.password) {
    return profile;
  }

  if (!profile.rememberPassword) {
    return profile;
  }

  const password = await window.xshellBridge.secretGet({
    key: passwordSecretKey(profile.id)
  });
  return password ? { ...profile, password } : profile;
}

function setStatus(message: string) {
  elements.statusLeft.textContent = message;
  elements.statusRight.textContent = `${profiles.length} 个连接配置 · ${tabs.length} 个标签`;
}

function showToast(message: string) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove("show");
  }, 2800);
}

function refreshIcons() {
  createIcons({ icons });
}

function renderProfiles() {
  const query = elements.sessionSearch.value.trim().toLowerCase();
  const visibleProfiles = profiles.filter((profile) => {
    const haystack = `${profile.group ?? ""} ${profile.name} ${profile.host} ${profile.username}`.toLowerCase();
    return haystack.includes(query);
  });

  if (visibleProfiles.length === 0) {
    elements.sessionList.innerHTML = `
      <div class="empty-list">
        <i data-lucide="server-off"></i>
        <span>暂无连接配置</span>
      </div>
    `;
  } else {
    const groups = new Map<string, SshProfile[]>();
    for (const profile of visibleProfiles) {
      const groupName = profile.group?.trim() || "默认";
      groups.set(groupName, [...(groups.get(groupName) ?? []), profile]);
    }

    elements.sessionList.innerHTML = [...groups.entries()]
      .map(([groupName, groupProfiles]) => {
        const rows = groupProfiles
          .map(
            (profile) => `
          <article class="session-row" data-profile-id="${profile.id}">
            <button class="session-main" type="button" data-action="connect" title="连接 ${escapeHtml(profile.name)}">
              <span class="session-color" style="--session-color: ${profile.color ?? "#2f80ed"}"></span>
              <span>
                <strong>${escapeHtml(profile.name)}</strong>
                <small>${escapeHtml(profile.username)}@${escapeHtml(profile.host)}:${profile.port}</small>
              </span>
            </button>
            <div class="session-actions">
              <button class="icon-button" type="button" data-action="edit" title="编辑连接配置">
                <i data-lucide="square-pen"></i>
              </button>
              <button class="icon-button" type="button" data-action="delete" title="删除连接配置">
                <i data-lucide="trash-2"></i>
              </button>
            </div>
          </article>
        `
          )
          .join("");

        return `
          <section class="session-group">
            <div class="session-group-title">
              <span>${escapeHtml(groupName)}</span>
              <small>${groupProfiles.length}</small>
            </div>
            ${rows}
          </section>
        `;
      })
      .join("");
  }

  setStatus("就绪");
  refreshIcons();
}

function renderTabs() {
  elements.tabStrip.innerHTML = tabs
    .map((tab) => {
      const isActive = tab.id === activeTabId;
      const statusLabel = {
        idle: "未连接",
        connecting: "连接中",
        connected: "已连接",
        disconnected: "已断开",
        error: "错误"
      }[tab.status];

      return `
        <button class="tab ${isActive ? "active" : ""}" type="button" data-tab-id="${tab.id}" title="${statusLabel}">
          <span class="tab-dot ${tab.status}"></span>
          <span class="tab-title">${escapeHtml(tab.title)}</span>
          <span class="tab-close" data-action="close" title="关闭标签">
            <i data-lucide="x"></i>
          </span>
        </button>
      `;
    })
    .join("");

  elements.emptyWorkspace.classList.toggle("hidden", tabs.length > 0);
  tabs.forEach((tab) => {
    tab.element.classList.toggle("active", tab.id === activeTabId);
  });
  refreshIcons();
  fitActiveTerminal();
  setStatus(tabs.length ? "终端就绪" : "就绪");
}

function formatBytes(size: number, kind?: FileListEntry["kind"]) {
  if (kind === "directory") {
    return "";
  }
  if (size < 1024) {
    return `${size} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function createTransferSummary(): TransferSummary {
  return {
    files: 0,
    directories: 0,
    bytes: 0,
    skipped: 0
  };
}

function formatTransferSummary(summary: TransferSummary) {
  const parts = [`${summary.files} 个文件`];
  if (summary.directories > 0) {
    parts.push(`${summary.directories} 个目录`);
  }
  if (summary.skipped > 0) {
    parts.push(`跳过 ${summary.skipped} 项`);
  }
  parts.push(formatBytes(summary.bytes));
  return parts.join(" · ");
}

function formatDate(value?: number) {
  if (!value) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function fileIcon(kind: FileListEntry["kind"]) {
  if (kind === "directory") {
    return "folder";
  }
  if (kind === "symlink") {
    return "link";
  }
  return "file";
}

function renderFilePane(side: "local" | "remote") {
  const pane = sftpState[side];
  const listElement = side === "local" ? elements.sftpLocalList : elements.sftpRemoteList;
  const countElement = side === "local" ? elements.sftpLocalCount : elements.sftpRemoteCount;
  const pathElement = side === "local" ? elements.sftpLocalPath : elements.sftpRemotePath;
  const selectedPaths = new Set(pane.selectedPaths ?? (pane.selectedPath ? [pane.selectedPath] : []));

  pathElement.value = pane.path;
  countElement.textContent =
    selectedPaths.size > 1
      ? `${pane.entries.length} 项 · 已选 ${selectedPaths.size} 项`
      : `${pane.entries.length} 项`;

  if (pane.entries.length === 0) {
    listElement.innerHTML = `
      <div class="file-empty">
        <i data-lucide="folder-open"></i>
        <span>空目录</span>
      </div>
    `;
    refreshIcons();
    return;
  }

  listElement.innerHTML = pane.entries
    .map(
      (entry) => `
        <div class="file-row ${selectedPaths.has(entry.path) ? "selected" : ""}" role="button" tabindex="0" data-side="${side}" data-path="${escapeHtml(entry.path)}">
          <span class="file-name">
            <i data-lucide="${fileIcon(entry.kind)}"></i>
            <span>${escapeHtml(entry.name)}</span>
          </span>
          <span class="file-size">${formatBytes(entry.size, entry.kind)}</span>
          <span class="file-date">${formatDate(entry.modifiedAt)}</span>
          <span class="file-actions">
            <button class="file-inline-action" type="button" data-action="rename" title="重命名">
              <i data-lucide="square-pen"></i>
            </button>
          </span>
        </div>
      `
    )
    .join("");
  refreshIcons();
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getActiveTab() {
  return tabs.find((tab) => tab.id === activeTabId);
}

function getConnectedActiveTab() {
  const activeTab = getActiveTab();
  if (!activeTab?.sessionId || activeTab.status !== "connected") {
    return undefined;
  }
  return activeTab;
}

function isSearchToggleActive(button: HTMLButtonElement) {
  return button.getAttribute("aria-pressed") === "true";
}

function setSearchToggleActive(button: HTMLButtonElement, active: boolean) {
  button.setAttribute("aria-pressed", String(active));
}

function getTerminalSearchOptions(incremental = false): ISearchOptions {
  return {
    caseSensitive: isSearchToggleActive(elements.terminalSearchCase),
    wholeWord: isSearchToggleActive(elements.terminalSearchWord),
    regex: isSearchToggleActive(elements.terminalSearchRegex),
    incremental,
    decorations: terminalSearchDecorations
  };
}

function resetTerminalSearchCount(label = "0/0") {
  elements.terminalSearchCount.textContent = label;
}

function renderTerminalSearchResult(event: ISearchResultChangeEvent) {
  if (!elements.terminalSearchQuery.value) {
    resetTerminalSearchCount();
    return;
  }

  if (event.resultCount === 0 || event.resultIndex < 0) {
    resetTerminalSearchCount(`0/${event.resultCount}`);
    return;
  }

  resetTerminalSearchCount(`${event.resultIndex + 1}/${event.resultCount}`);
}

function openTerminalSearch(options: { select?: boolean } = {}) {
  const activeTab = getActiveTab();
  if (!activeTab) {
    showToast("没有可查找的终端标签");
    return;
  }

  isTerminalSearchOpen = true;
  elements.terminalSearch.classList.remove("hidden");
  refreshIcons();

  window.requestAnimationFrame(() => {
    elements.terminalSearchQuery.focus();
    if (options.select !== false) {
      elements.terminalSearchQuery.select();
    }
  });

  if (elements.terminalSearchQuery.value) {
    searchActiveTerminal("next", true, true);
  }
}

function closeTerminalSearch() {
  isTerminalSearchOpen = false;
  elements.terminalSearch.classList.add("hidden");
  getActiveTab()?.searchAddon.clearDecorations();
  resetTerminalSearchCount();
  elements.terminalSearchQuery.blur();
  fitActiveTerminal();
}

function searchActiveTerminal(
  direction: "next" | "previous" = "next",
  incremental = false,
  quiet = false
) {
  const activeTab = getActiveTab();
  if (!activeTab) {
    if (!quiet) {
      showToast("没有可查找的终端标签");
    }
    return;
  }

  const term = elements.terminalSearchQuery.value;
  if (!term) {
    activeTab.searchAddon.clearDecorations();
    resetTerminalSearchCount();
    return;
  }

  try {
    const found =
      direction === "previous"
        ? activeTab.searchAddon.findPrevious(term, getTerminalSearchOptions(false))
        : activeTab.searchAddon.findNext(term, getTerminalSearchOptions(incremental));

    if (!found) {
      resetTerminalSearchCount("0/0");
    }
  } catch (error) {
    resetTerminalSearchCount("错误");
    if (!quiet) {
      showToast(`查找失败：${getErrorMessage(error)}`);
    }
  }
}

function toggleTerminalSearchOption(button: HTMLButtonElement) {
  setSearchToggleActive(button, !isSearchToggleActive(button));
  if (isTerminalSearchOpen) {
    searchActiveTerminal("next", true, true);
  }
}

function fitActiveTerminal() {
  const activeTab = getActiveTab();
  if (!activeTab) {
    return;
  }

  window.requestAnimationFrame(() => {
    activeTab.fitAddon.fit();
    if (activeTab.sessionId) {
      window.xshellBridge.resize({
        sessionId: activeTab.sessionId,
        cols: activeTab.terminal.cols,
        rows: activeTab.terminal.rows
      });
    }
  });
}

function buildTerminal(profile: SshProfile): TerminalTab {
  const element = document.createElement("div");
  element.className = "terminal-pane";
  elements.terminalStack.appendChild(element);

  const terminal = new Terminal({
    cursorBlink: preferences.cursorBlink,
    fontFamily: "Consolas, 'Cascadia Mono', 'Microsoft YaHei UI', monospace",
    fontSize: preferences.fontSize,
    lineHeight: 1.12,
    letterSpacing: 0,
    scrollback: 10000,
    theme: terminalThemes[preferences.theme],
    allowProposedApi: false,
    convertEol: true
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon({ highlightLimit: 2000 });
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());
  terminal.loadAddon(searchAddon);
  terminal.open(element);

  const tab: TerminalTab = {
    id: createId(),
    title: profile.name || profile.host,
    profile,
    terminal,
    fitAddon,
    searchAddon,
    element,
    status: "idle"
  };

  searchAddon.onDidChangeResults((event) => {
    if (tab.id === activeTabId) {
      renderTerminalSearchResult(event);
    }
  });

  terminal.onData((data) => {
    if (tab.sessionId && tab.status === "connected") {
      window.xshellBridge.sendData({ sessionId: tab.sessionId, data });
    }
  });

  terminal.onResize(({ cols, rows }) => {
    if (tab.sessionId) {
      window.xshellBridge.resize({ sessionId: tab.sessionId, cols, rows });
    }
  });

  return tab;
}

async function connectProfile(profile: SshProfile) {
  let connectionProfile: SshProfile;
  try {
    connectionProfile = await profileWithStoredPassword(profile);
  } catch (error) {
    showToast(getErrorMessage(error));
    connectionProfile = profile;
  }

  const validationError = validateConnectProfile(connectionProfile);
  if (validationError) {
    showToast(validationError);
    openConnectionDialog(profile, { quick: true });
    return;
  }

  const tab = buildTerminal(connectionProfile);
  tabs.push(tab);
  activeTabId = tab.id;
  renderTabs();
  await connectTab(tab, connectionProfile);
}

async function connectTab(tab: TerminalTab, profile: SshProfile) {
  tab.profile = profile;
  tab.status = "connecting";
  tab.sessionId = undefined;
  renderTabs();

  tab.terminal.writeln(`\x1b[36m连接 ${profile.username}@${profile.host}:${profile.port} ...\x1b[0m`);

  try {
    const response = await window.xshellBridge.connect({
      profile,
      terminal: {
        cols: tab.terminal.cols,
        rows: tab.terminal.rows
      }
    });

    tab.sessionId = response.sessionId;
    renderTabs();
  } catch (error) {
    tab.status = "error";
    tab.terminal.writeln(`\x1b[31m${getErrorMessage(error)}\x1b[0m`);
    renderTabs();
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function openConnectionDialog(profile?: SshProfile, options?: { quick?: boolean }) {
  editingProfileId = profile?.id;
  elements.dialogTitle.textContent = profile ? "编辑连接配置" : options?.quick ? "快速连接" : "新建连接配置";
  elements.dialogSubtitle.textContent = profile?.host ? `${profile.username}@${profile.host}` : "SSH";

  elements.profileName.value = profile?.name ?? "";
  elements.profileGroup.value = profile?.group ?? "";
  elements.profileHost.value = profile?.host ?? "";
  elements.profilePort.value = String(profile?.port ?? 22);
  elements.profileUsername.value = profile?.username ?? "";
  elements.profilePassword.value = "";
  elements.profilePassword.placeholder =
    profile?.authMethod === "password" && profile.rememberPassword
      ? "已保存密码，留空则继续使用"
      : "";
  elements.profileRemember.checked = Boolean(profile?.rememberPassword);
  elements.profileKeyPath.value = profile?.privateKeyPath ?? "";
  elements.profilePassphrase.value = profile?.passphrase ?? "";
  elements.profileSave.checked = !options?.quick;

  const authMethod = profile?.authMethod ?? "password";
  const radio = elements.profileForm.querySelector<HTMLInputElement>(
    `input[name="auth-method"][value="${authMethod}"]`
  );
  if (radio) {
    radio.checked = true;
  }
  syncAuthPanels();

  elements.connectionDialog.showModal();
  elements.profileHost.focus();
  refreshIcons();
}

function readProfileForm(): SshProfile {
  const authMethod =
    elements.profileForm.querySelector<HTMLInputElement>('input[name="auth-method"]:checked')
      ?.value === "privateKey"
      ? "privateKey"
      : "password";

  const host = elements.profileHost.value.trim();
  const username = elements.profileUsername.value.trim();
  const fallbackName = host ? `${username || "ssh"}@${host}` : "未命名配置";

  return {
    id: editingProfileId ?? createId(),
    name: elements.profileName.value.trim() || fallbackName,
    group: elements.profileGroup.value.trim() || "默认",
    host,
    port: Number(elements.profilePort.value || 22),
    username,
    authMethod,
    password: elements.profilePassword.value,
    rememberPassword: elements.profileRemember.checked,
    privateKeyPath: elements.profileKeyPath.value.trim(),
    passphrase: elements.profilePassphrase.value,
    color: profileColor(editingProfileId ?? host)
  };
}

function validateConnectProfile(profile: SshProfile) {
  if (!profile.host.trim()) {
    return "请输入主机地址";
  }
  if (!profile.username.trim()) {
    return "请输入用户名";
  }
  if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) {
    return "端口必须在 1 到 65535 之间";
  }
  if (profile.authMethod === "password" && !profile.password) {
    return "请输入 SSH 密码";
  }
  if (profile.authMethod === "privateKey" && !profile.privateKeyPath) {
    return "请选择私钥文件";
  }

  return undefined;
}

function profileColor(seed: string) {
  const colors = ["#2f80ed", "#219653", "#f2994a", "#9b51e0", "#eb5757", "#00a3a3"];
  const source = seed || createId();
  const index = [...source].reduce((total, char) => total + char.charCodeAt(0), 0) % colors.length;
  return colors[index];
}

async function upsertProfile(profile: SshProfile) {
  await saveProfileSecret(profile);
  const stored = sanitizeProfile(profile);
  const existingIndex = profiles.findIndex((item) => item.id === stored.id);
  if (existingIndex >= 0) {
    profiles[existingIndex] = stored;
  } else {
    profiles.unshift(stored);
  }
  saveProfiles();
  renderProfiles();
}

async function migrateLegacyProfilePasswords() {
  const legacyProfiles = profiles.filter(
    (profile) =>
      profile.authMethod === "password" &&
      profile.rememberPassword &&
      Boolean(profile.password)
  );
  if (legacyProfiles.length === 0) {
    return;
  }

  try {
    await Promise.all(
      legacyProfiles.map((profile) =>
        window.xshellBridge.secretSet({
          key: passwordSecretKey(profile.id),
          value: profile.password ?? ""
        })
      )
    );

    profiles = profiles.map(sanitizeProfile);
    saveProfiles();
    renderProfiles();
    showToast("已迁移保存的密码到系统加密存储");
  } catch (error) {
    showToast(`密码迁移失败：${getErrorMessage(error)}`);
  }
}

async function exportProfiles() {
  if (profiles.length === 0) {
    showToast("没有可导出的连接配置");
    return;
  }

  try {
    const result = await window.xshellBridge.profilesExport({
      profiles: profiles.map(sanitizeProfile)
    });
    if (!result.canceled) {
      showToast("连接配置已导出");
    }
  } catch (error) {
    showToast(`导出失败：${getErrorMessage(error)}`);
  }
}

async function importProfiles() {
  try {
    const result = await window.xshellBridge.profilesImport();
    if (result.canceled) {
      return;
    }

    const importedProfiles = result.profiles.map((profile) =>
      sanitizeProfile({
        ...profile,
        id: createId(),
        group: profile.group?.trim() || "默认",
        color: profile.color ?? profileColor(`${profile.username}@${profile.host}`),
        rememberPassword: false
      })
    );

    if (importedProfiles.length === 0) {
      showToast("没有找到可导入的连接配置");
      return;
    }

    profiles = [...importedProfiles, ...profiles];
    saveProfiles();
    renderProfiles();
    showToast(`已导入 ${importedProfiles.length} 个连接配置`);
  } catch (error) {
    showToast(`导入失败：${getErrorMessage(error)}`);
  }
}

function syncAuthPanels() {
  const authMethod = elements.profileForm.querySelector<HTMLInputElement>(
    'input[name="auth-method"]:checked'
  )?.value as AuthMethod | undefined;

  const isKey = authMethod === "privateKey";
  elements.keyFields.classList.toggle("hidden", !isKey);
  elements.passwordFields.classList.toggle("hidden", isKey);
}

function closeTab(tabId: string) {
  const tab = tabs.find((item) => item.id === tabId);
  if (!tab) {
    return;
  }

  if (tab.sessionId) {
    void window.xshellBridge.disconnect(tab.sessionId);
  }

  tab.terminal.dispose();
  tab.element.remove();
  tabs = tabs.filter((item) => item.id !== tabId);

  if (activeTabId === tabId) {
    activeTabId = tabs.at(-1)?.id;
  }

  renderTabs();
  if (isTerminalSearchOpen) {
    if (activeTabId) {
      searchActiveTerminal("next", true, true);
    } else {
      closeTerminalSearch();
    }
  }
}

function duplicateActiveTab() {
  const activeTab = getActiveTab();
  if (!activeTab) {
    showToast("没有可复制的标签");
    return;
  }

  void connectProfile({ ...activeTab.profile, password: activeTab.profile.password ?? "" });
}

async function disconnectActiveTab() {
  const activeTab = getActiveTab();
  if (!activeTab?.sessionId) {
    showToast("当前标签未连接");
    return;
  }

  await window.xshellBridge.disconnect(activeTab.sessionId);
  activeTab.sessionId = undefined;
  activeTab.status = "disconnected";
  renderTabs();
}

async function reconnectActiveTab() {
  const activeTab = getActiveTab();
  if (!activeTab) {
    showToast("没有可重连的标签");
    return;
  }

  const profile = await profileWithStoredPassword(activeTab.profile);
  const validationError = validateConnectProfile(profile);
  if (validationError) {
    showToast(validationError);
    openConnectionDialog(activeTab.profile, { quick: true });
    return;
  }

  if (activeTab.sessionId) {
    try {
      await window.xshellBridge.disconnect(activeTab.sessionId);
    } catch {
      // The connection may already be gone; continue with reconnect.
    }
    activeTab.sessionId = undefined;
  }

  activeTab.terminal.writeln(`\r\n\x1b[36m重新连接 ${profile.username}@${profile.host}:${profile.port} ...\x1b[0m`);
  await connectTab(activeTab, profile);
}

function applyPreferences() {
  for (const tab of tabs) {
    tab.terminal.options.fontSize = preferences.fontSize;
    tab.terminal.options.cursorBlink = preferences.cursorBlink;
    tab.terminal.options.theme = terminalThemes[preferences.theme];
  }
  fitActiveTerminal();
}

function openPreferences() {
  elements.prefFontSize.value = String(preferences.fontSize);
  elements.prefTheme.value = preferences.theme;
  elements.prefCursorBlink.checked = preferences.cursorBlink;
  elements.preferencesDialog.showModal();
}

function getSelectedTunnelType(): TunnelType {
  return (
    elements.tunnelForm.querySelector<HTMLInputElement>('input[name="tunnel-type"]:checked')
      ?.value as TunnelType | undefined
  ) ?? "local";
}

function syncTunnelForm() {
  const type = getSelectedTunnelType();
  const isDynamic = type === "dynamic";
  elements.tunnelTargetHostRow.classList.toggle("hidden", isDynamic);
  elements.tunnelTargetPortRow.classList.toggle("hidden", isDynamic);
  elements.tunnelTargetPort.required = !isDynamic;

  if (type === "remote") {
    elements.tunnelBindHostLabel.textContent = "远端监听地址";
    elements.tunnelBindPortLabel.textContent = "远端监听端口";
    elements.tunnelTargetHostLabel.textContent = "本地目标主机";
    elements.tunnelTargetPortLabel.textContent = "本地目标端口";
  } else if (type === "dynamic") {
    elements.tunnelBindHostLabel.textContent = "本地 SOCKS 地址";
    elements.tunnelBindPortLabel.textContent = "本地 SOCKS 端口";
    if (elements.tunnelBindPort.value === "8080") {
      elements.tunnelBindPort.value = "1080";
    }
  } else {
    elements.tunnelBindHostLabel.textContent = "本地监听地址";
    elements.tunnelBindPortLabel.textContent = "本地监听端口";
    elements.tunnelTargetHostLabel.textContent = "远端目标主机";
    elements.tunnelTargetPortLabel.textContent = "远端目标端口";
    if (elements.tunnelBindPort.value === "1080") {
      elements.tunnelBindPort.value = "8080";
    }
  }
}

function tunnelTypeText(type: TunnelType) {
  switch (type) {
    case "local":
      return "本地转发";
    case "remote":
      return "远端转发";
    case "dynamic":
      return "SOCKS5 代理";
  }
}

function tunnelIconName(type: TunnelType) {
  switch (type) {
    case "local":
      return "arrow-right-left";
    case "remote":
      return "radio-tower";
    case "dynamic":
      return "route";
  }
}

function renderTunnelRoute(tunnel: TunnelInfo) {
  if (tunnel.type === "dynamic") {
    return `SOCKS5 ${tunnel.localHost}:${tunnel.localPort}`;
  }
  if (tunnel.type === "remote") {
    return `${tunnel.remoteHost}:${tunnel.remotePort} -> ${tunnel.targetHost}:${tunnel.targetPort}`;
  }
  return `${tunnel.localHost}:${tunnel.localPort} -> ${tunnel.targetHost}:${tunnel.targetPort}`;
}

function renderTunnels() {
  elements.tunnelSummary.textContent = `${tunnelState.tunnels.length} 项`;

  if (tunnelState.tunnels.length === 0) {
    elements.tunnelList.innerHTML = `
      <div class="tunnel-empty">
        <i data-lucide="route-off"></i>
        <span>暂无隧道</span>
      </div>
    `;
    refreshIcons();
    return;
  }

  elements.tunnelList.innerHTML = tunnelState.tunnels
    .map((tunnel) => {
      const statusLabel = tunnel.status === "error" ? "异常" : "运行中";
      const errorText = tunnel.lastError ? ` · ${escapeHtml(tunnel.lastError)}` : "";
      return `
        <article class="tunnel-row" data-tunnel-id="${tunnel.id}">
          <div class="tunnel-icon">
            <i data-lucide="${tunnelIconName(tunnel.type)}"></i>
          </div>
          <div class="tunnel-main">
            <div class="tunnel-title">
              <span>${escapeHtml(tunnel.name)}</span>
              <span class="tunnel-badge ${tunnel.status === "error" ? "error" : ""}">${statusLabel}</span>
              <span class="tunnel-badge">${tunnelTypeText(tunnel.type)}</span>
            </div>
            <div class="tunnel-route">${escapeHtml(renderTunnelRoute(tunnel))}</div>
            <div class="tunnel-meta">
              ${tunnel.connections} 个连接 · ↑ ${formatBytes(tunnel.bytesUp)} · ↓ ${formatBytes(tunnel.bytesDown)}${errorText}
            </div>
          </div>
          <button class="tunnel-stop" type="button" data-action="stop-tunnel">停止</button>
        </article>
      `;
    })
    .join("");
  refreshIcons();
}

async function refreshTunnels() {
  if (!tunnelState.sessionId) {
    tunnelState.tunnels = [];
    renderTunnels();
    return;
  }

  try {
    tunnelState.tunnels = await window.xshellBridge.tunnelList({
      sessionId: tunnelState.sessionId
    });
    renderTunnels();
  } catch (error) {
    showToast(`刷新隧道失败：${getErrorMessage(error)}`);
  }
}

async function openTunnelsPanel() {
  const activeTab = getConnectedActiveTab();
  if (!activeTab) {
    showToast("请先打开一个已连接的 SSH 标签");
    return;
  }

  tunnelState.sessionId = activeTab.sessionId;
  elements.tunnelSubtitle.textContent = `${activeTab.profile.name} · ${activeTab.profile.username}@${activeTab.profile.host}`;
  syncTunnelForm();
  if (!elements.tunnelDialog.open) {
    elements.tunnelDialog.showModal();
  }
  await refreshTunnels();
}

function readTunnelPort(input: HTMLInputElement, label: string, allowZero = false) {
  const value = Number(input.value);
  const min = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < min || value > 65535) {
    throw new Error(`${label}必须在 ${min} 到 65535 之间`);
  }
  return value;
}

function readTunnelRequest(): TunnelCreateRequest {
  if (!tunnelState.sessionId) {
    throw new Error("当前 SSH 会话不可用");
  }

  const type = getSelectedTunnelType();
  const bindHost = elements.tunnelBindHost.value.trim() || "127.0.0.1";
  const bindPort = readTunnelPort(elements.tunnelBindPort, "监听端口", true);
  const request: TunnelCreateRequest = {
    sessionId: tunnelState.sessionId,
    type,
    name: elements.tunnelName.value.trim() || undefined
  };

  if (type === "remote") {
    request.remoteHost = bindHost;
    request.remotePort = bindPort;
    request.targetHost = elements.tunnelTargetHost.value.trim() || "127.0.0.1";
    request.targetPort = readTunnelPort(elements.tunnelTargetPort, "目标端口");
    return request;
  }

  request.localHost = bindHost;
  request.localPort = bindPort;
  if (type === "local") {
    request.targetHost = elements.tunnelTargetHost.value.trim() || "127.0.0.1";
    request.targetPort = readTunnelPort(elements.tunnelTargetPort, "目标端口");
  }
  return request;
}

async function createTunnelFromForm() {
  try {
    const response = await window.xshellBridge.tunnelCreate(readTunnelRequest());
    showToast(`隧道已创建：${response.tunnel.name}`);
    elements.tunnelName.value = "";
    await refreshTunnels();
  } catch (error) {
    showToast(`创建隧道失败：${getErrorMessage(error)}`);
  }
}

async function stopTunnel(tunnelId: string) {
  if (!tunnelState.sessionId) {
    return;
  }

  try {
    await window.xshellBridge.tunnelClose({
      sessionId: tunnelState.sessionId,
      tunnelId
    });
    showToast("隧道已停止");
    await refreshTunnels();
  } catch (error) {
    showToast(`停止隧道失败：${getErrorMessage(error)}`);
  }
}

function renderWindowState(isFullScreen: boolean) {
  document.body.classList.toggle("window-fullscreen", isFullScreen);
  elements.exitFullscreen.classList.toggle("hidden", !isFullScreen);
}

function blurActiveElement() {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

function getEditableTarget() {
  const activeElement = document.activeElement;
  if (
    !(activeElement instanceof HTMLInputElement) &&
    !(activeElement instanceof HTMLTextAreaElement)
  ) {
    return undefined;
  }
  if (activeElement.closest(".terminal-pane")) {
    return undefined;
  }
  if (activeElement.disabled || activeElement.readOnly) {
    return undefined;
  }
  return activeElement;
}

function selectedTextFromEditable(element: HTMLInputElement | HTMLTextAreaElement) {
  const start = element.selectionStart ?? 0;
  const end = element.selectionEnd ?? start;
  return element.value.slice(start, end);
}

function insertTextIntoEditable(element: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const start = element.selectionStart;
  const end = element.selectionEnd;
  if (typeof start === "number" && typeof end === "number") {
    element.setRangeText(text, start, end, "end");
  } else {
    element.value = text;
  }

  element.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      data: text,
      inputType: "insertFromPaste"
    })
  );
}

async function copyActiveSelection() {
  const editableTarget = getEditableTarget();
  const selection = editableTarget
    ? selectedTextFromEditable(editableTarget)
    : getActiveTab()?.terminal.getSelection();
  if (!selection) {
    showToast("没有可复制的选区");
    return;
  }

  try {
    await window.xshellBridge.clipboardWriteText(selection);
    showToast("已复制");
  } catch (error) {
    showToast(`复制失败：${getErrorMessage(error)}`);
  }
}

async function pasteClipboard() {
  try {
    const text = await window.xshellBridge.clipboardReadText();
    if (!text) {
      return;
    }

    const editableTarget = getEditableTarget();
    if (editableTarget) {
      insertTextIntoEditable(editableTarget, text);
      return;
    }

    const activeTab = getActiveTab();
    if (!activeTab?.sessionId || activeTab.status !== "connected") {
      showToast("当前标签未连接");
      return;
    }

    window.xshellBridge.sendData({
      sessionId: activeTab.sessionId,
      data: text
    });
  } catch (error) {
    showToast(`粘贴失败：${getErrorMessage(error)}`);
  }
}

function sendInterruptToActiveTerminal() {
  const activeTab = getActiveTab();
  if (!activeTab?.sessionId || activeTab.status !== "connected") {
    return false;
  }

  window.xshellBridge.sendData({
    sessionId: activeTab.sessionId,
    data: "\x03"
  });
  return true;
}

function handleClipboardShortcut(event: KeyboardEvent) {
  if (!event.ctrlKey || event.altKey || event.metaKey || event.isComposing) {
    return false;
  }

  const key = event.key.toLowerCase();
  const editableTarget = getEditableTarget();
  if (!editableTarget && document.querySelector("dialog[open]")) {
    return false;
  }

  if (key === "v") {
    event.preventDefault();
    event.stopPropagation();
    void pasteClipboard();
    return true;
  }

  if (key === "c") {
    const terminalSelection = getActiveTab()?.terminal.getSelection();
    if (editableTarget || terminalSelection) {
      event.preventDefault();
      event.stopPropagation();
      void copyActiveSelection();
      return true;
    }

    if (sendInterruptToActiveTerminal()) {
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
  }

  return false;
}

function selectActiveTerminal() {
  const editableTarget = getEditableTarget();
  if (editableTarget) {
    editableTarget.select();
    return;
  }

  const activeTab = getActiveTab();
  if (!activeTab) {
    showToast("没有可全选的终端标签");
    return;
  }

  activeTab.terminal.selectAll();
}

function setSftpStatus(message: string) {
  elements.sftpStatus.textContent = message;
}

function resetSftpProgress(detail = "等待传输") {
  elements.sftpProgressFill.style.width = "0%";
  elements.sftpProgressPercent.textContent = "0%";
  elements.sftpProgressDetail.textContent = detail;
}

function transferStatusLabel(status: TransferStatus) {
  return {
    queued: "等待",
    preparing: "准备",
    running: "传输",
    completed: "完成",
    error: "失败",
    canceled: "取消"
  }[status];
}

function transferStatusIcon(status: TransferStatus) {
  return {
    queued: "clock-3",
    preparing: "loader",
    running: "activity",
    completed: "circle-check",
    error: "circle-alert",
    canceled: "ban"
  }[status];
}

function transferDirectionLabel(direction: TransferDirection) {
  return direction === "upload" ? "上传" : "下载";
}

function transferDirectionIcon(direction: TransferDirection) {
  return direction === "upload" ? "upload" : "download";
}

function isCancelableTransfer(status: TransferStatus) {
  return status === "queued" || status === "preparing" || status === "running";
}

function queueSummaryText() {
  if (sftpTransferQueue.length === 0) {
    return "0 项";
  }

  const runningCount = sftpTransferQueue.filter((item) =>
    item.status === "preparing" || item.status === "running"
  ).length;
  const queuedCount = sftpTransferQueue.filter((item) => item.status === "queued").length;
  return `${sftpTransferQueue.length} 项 · ${runningCount} 运行 · ${queuedCount} 等待`;
}

function syncSftpFooterFromTransfer(item?: SftpTransferQueueItem) {
  if (!item) {
    setSftpStatus("就绪");
    resetSftpProgress();
    return;
  }

  elements.sftpProgressFill.style.width = `${item.percent}%`;
  elements.sftpProgressPercent.textContent = `${item.percent}%`;
  setSftpStatus(item.message);

  if (item.status === "queued") {
    elements.sftpProgressDetail.textContent = `${transferDirectionLabel(item.direction)}等待中 · ${item.name}`;
    return;
  }

  const active = item.activeFileBytes
    ? ` · 当前 ${formatBytes(item.activeFileTransferred ?? 0)} / ${formatBytes(item.activeFileBytes)}`
    : "";
  elements.sftpProgressDetail.textContent = `${formatTransferSummary(item.summary)} / ${formatTransferSummary(item.total)}${active}`;
}

function renderTransferQueue() {
  elements.sftpQueueSummary.textContent = queueSummaryText();

  if (sftpTransferQueue.length === 0) {
    elements.sftpTransferQueue.innerHTML = `
      <div class="queue-empty">
        <i data-lucide="list-checks"></i>
        <span>暂无传输任务</span>
      </div>
    `;
    syncSftpFooterFromTransfer();
    refreshIcons();
    return;
  }

  elements.sftpTransferQueue.innerHTML = sftpTransferQueue
    .map((item) => {
      const canCancel = isCancelableTransfer(item.status);
      return `
        <article class="queue-row ${item.status}" data-transfer-id="${item.id}">
          <span class="queue-badge ${item.status}">
            <i data-lucide="${transferStatusIcon(item.status)}"></i>
            <span>${transferStatusLabel(item.status)}</span>
          </span>
          <div class="queue-main">
            <span class="queue-title">
              <i data-lucide="${transferDirectionIcon(item.direction)}"></i>
              ${escapeHtml(transferDirectionLabel(item.direction))} · ${escapeHtml(item.name)}
            </span>
            <span class="queue-detail" title="${escapeHtml(`${item.sourcePath} -> ${item.targetPath}`)}">
              ${escapeHtml(item.message)}
            </span>
            <div class="queue-progress-track">
              <div class="queue-progress-fill" style="width: ${item.percent}%"></div>
            </div>
          </div>
          <span class="queue-percent">${item.percent}%</span>
          ${
            canCancel
              ? `<button class="icon-button danger" type="button" data-action="cancel-transfer" title="取消传输">
                  <i data-lucide="x"></i>
                </button>`
              : `<span></span>`
          }
        </article>
      `;
    })
    .join("");

  const activeItem =
    sftpTransferQueue.find((item) => item.id === activeSftpTransferId) ??
    sftpTransferQueue.at(-1);
  syncSftpFooterFromTransfer(activeItem);
  refreshIcons();
}

function updateTransferQueueItem(
  transferId: string,
  patch: Partial<SftpTransferQueueItem>
) {
  sftpTransferQueue = sftpTransferQueue.map((item) =>
    item.id === transferId ? { ...item, ...patch } : item
  );
  renderTransferQueue();
}

function enqueueSftpTransfer(item: SftpTransferQueueItem) {
  sftpTransferQueue = [...sftpTransferQueue, item];
  renderTransferQueue();
  void processSftpTransferQueue();
}

function clearCompletedTransfers() {
  sftpTransferQueue = sftpTransferQueue.filter((item) =>
    item.status !== "completed" && item.status !== "error" && item.status !== "canceled"
  );
  renderTransferQueue();
}

async function cancelSftpTransfer(transferId: string) {
  const item = sftpTransferQueue.find((candidate) => candidate.id === transferId);
  if (!item || !isCancelableTransfer(item.status)) {
    return;
  }

  if (item.status === "queued") {
    updateTransferQueueItem(transferId, {
      status: "canceled",
      percent: 0,
      message: "已取消"
    });
    return;
  }

  updateTransferQueueItem(transferId, {
    status: "canceled",
    message: "正在取消传输"
  });

  try {
    const canceled = await window.xshellBridge.sftpCancelTransfer({ transferId });
    if (!canceled) {
      updateTransferQueueItem(transferId, {
        status: "canceled",
        message: "传输已取消"
      });
    }
  } catch (error) {
    updateTransferQueueItem(transferId, {
      status: "error",
      message: `取消失败：${getErrorMessage(error)}`
    });
  }
}

async function processSftpTransferQueue() {
  if (activeSftpTransferId) {
    return;
  }

  const next = sftpTransferQueue.find((item) => item.status === "queued");
  if (!next) {
    return;
  }

  activeSftpTransferId = next.id;
  updateTransferQueueItem(next.id, {
    status: "preparing",
    percent: 0,
    message: `正在准备${transferDirectionLabel(next.direction)} ${next.name}`
  });

  try {
    const summary =
      next.direction === "upload"
        ? await window.xshellBridge.sftpUpload({
            sessionId: next.sessionId,
            localPath: next.localPath ?? next.sourcePath,
            remoteDirectory: next.remoteDirectory ?? next.targetPath,
            remoteName: next.remoteName ?? next.name,
            transferId: next.id
          })
        : await window.xshellBridge.sftpDownload({
            sessionId: next.sessionId,
            remotePath: next.remotePath ?? next.sourcePath,
            localDirectory: next.localDirectory ?? next.targetPath,
            localName: next.localName ?? next.name,
            transferId: next.id
          });

    const latest = sftpTransferQueue.find((item) => item.id === next.id);
    if (latest?.status !== "canceled") {
      updateTransferQueueItem(next.id, {
        status: "completed",
        percent: 100,
        message: `${transferDirectionLabel(next.direction)}完成 · ${formatTransferSummary(summary)}`,
        summary
      });

      if (next.sessionId === sftpState.sessionId) {
        if (next.direction === "upload") {
          await loadRemoteDirectory();
        } else {
          await loadLocalDirectory();
        }
      }
    }
  } catch (error) {
    const message = getErrorMessage(error);
    const latest = sftpTransferQueue.find((item) => item.id === next.id);
    if (latest?.status === "canceled" || message.includes("传输已取消")) {
      updateTransferQueueItem(next.id, {
        status: "canceled",
        message: "传输已取消"
      });
    } else {
      updateTransferQueueItem(next.id, {
        status: "error",
        message
      });
      showToast(message);
    }
  } finally {
    activeSftpTransferId = undefined;
    void processSftpTransferQueue();
  }
}

function renderTransferProgress(progress: TransferProgressEvent) {
  updateTransferQueueItem(progress.transferId, {
    direction: progress.direction,
    status: progress.status,
    message: progress.message,
    summary: progress.summary,
    total: progress.total,
    currentPath: progress.currentPath,
    activeFileBytes: progress.activeFileBytes,
    activeFileTransferred: progress.activeFileTransferred,
    percent: progress.percent
  });

  elements.sftpProgressFill.style.width = `${progress.percent}%`;
  elements.sftpProgressPercent.textContent = `${progress.percent}%`;
  setSftpStatus(progress.message);

  const active = progress.activeFileBytes
    ? ` · 当前 ${formatBytes(progress.activeFileTransferred ?? 0)} / ${formatBytes(progress.activeFileBytes)}`
    : "";
  elements.sftpProgressDetail.textContent = `${formatTransferSummary(progress.summary)} / ${formatTransferSummary(progress.total)}${active}`;

  if (progress.status === "error" || progress.status === "canceled") {
    showToast(progress.message);
  }
}

function closeSftpInput(value?: string) {
  elements.sftpInputOverlay.classList.add("hidden");
  const resolver = pendingSftpInput;
  pendingSftpInput = undefined;
  resolver?.(value);
}

function requestSftpInput(title: string, label: string, initialValue = "") {
  if (pendingSftpInput) {
    closeSftpInput();
  }

  elements.sftpInputTitle.textContent = title;
  elements.sftpInputLabel.textContent = label;
  elements.sftpInputValue.value = initialValue;
  elements.sftpInputOverlay.classList.remove("hidden");
  refreshIcons();

  window.requestAnimationFrame(() => {
    elements.sftpInputValue.focus();
    elements.sftpInputValue.select();
  });

  return new Promise<string | undefined>((resolve) => {
    pendingSftpInput = resolve;
  });
}

async function loadLocalDirectory(directoryPath?: string) {
  const response = await window.xshellBridge.localList({
    path: directoryPath || sftpState.local.path || undefined
  });
  sftpState.local = {
    path: response.path,
    parentPath: response.parentPath,
    entries: response.entries,
    selectedPath: undefined,
    selectedPaths: []
  };
  renderFilePane("local");
}

async function loadRemoteDirectory(remotePath?: string) {
  if (!sftpState.sessionId) {
    throw new Error("SFTP 通道未建立。");
  }

  const response = await window.xshellBridge.sftpList({
    sessionId: sftpState.sessionId,
    path: remotePath || sftpState.remote.path || "."
  });
  sftpState.remote = {
    path: response.path,
    parentPath: response.parentPath,
    entries: response.entries,
    selectedPath: undefined,
    selectedPaths: []
  };
  renderFilePane("remote");
}

async function refreshSftp() {
  setSftpStatus("正在刷新");
  try {
    await Promise.all([loadLocalDirectory(), loadRemoteDirectory()]);
    setSftpStatus("就绪");
  } catch (error) {
    const message = getErrorMessage(error);
    setSftpStatus(message);
    showToast(message);
  }
}

async function openSftpPanel() {
  const activeTab = getConnectedActiveTab();
  if (!activeTab) {
    showToast("请先打开一个已连接的 SSH 标签");
    return;
  }

  const sessionChanged = sftpState.sessionId !== activeTab.sessionId;
  sftpState.sessionId = activeTab.sessionId;
  if (sessionChanged) {
    sftpState.remote = { path: ".", entries: [] };
  }

  elements.sftpSubtitle.textContent = `${activeTab.profile.name} · ${activeTab.profile.username}@${activeTab.profile.host}`;
  if (!elements.sftpDialog.open) {
    elements.sftpDialog.showModal();
  }
  refreshIcons();

  try {
    setSftpStatus("正在打开 SFTP");
    if (!sftpState.local.path) {
      const homePath = await window.xshellBridge.localHome();
      await loadLocalDirectory(homePath);
    } else {
      await loadLocalDirectory();
    }
    await loadRemoteDirectory(sessionChanged ? "." : sftpState.remote.path);
    setSftpStatus("就绪");
  } catch (error) {
    const message = getErrorMessage(error);
    setSftpStatus(message);
    showToast(message);
  }
}

function getSelectedFile(side: "local" | "remote") {
  const pane = sftpState[side];
  return pane.entries.find((entry) => entry.path === pane.selectedPath);
}

function getSelectedFiles(side: "local" | "remote") {
  const pane = sftpState[side];
  const selectedPaths = new Set(
    pane.selectedPaths ?? (pane.selectedPath ? [pane.selectedPath] : [])
  );
  return pane.entries.filter((entry) => selectedPaths.has(entry.path));
}

function selectSingleFile(side: "local" | "remote", pathValue: string) {
  const pane = sftpState[side];
  pane.selectedPath = pathValue;
  pane.selectedPaths = [pathValue];
  renderFilePane(side);
}

function toggleRemoteFileSelection(pathValue: string) {
  toggleFileSelection("remote", pathValue);
}

function toggleFileSelection(side: "local" | "remote", pathValue: string) {
  const pane = sftpState[side];
  const selectedPaths = new Set(
    pane.selectedPaths ?? (pane.selectedPath ? [pane.selectedPath] : [])
  );
  if (selectedPaths.has(pathValue)) {
    selectedPaths.delete(pathValue);
  } else {
    selectedPaths.add(pathValue);
  }

  pane.selectedPaths = [...selectedPaths];
  pane.selectedPath = pathValue;
  renderFilePane(side);
}

async function uploadSelectedEntry() {
  const selected = getSelectedFile("local");
  if (!sftpState.sessionId || !selected) {
    showToast("请选择一个本地项目");
    return;
  }

  const transferId = createId();
  enqueueSftpTransfer({
    id: transferId,
    sessionId: sftpState.sessionId,
    direction: "upload",
    name: selected.name,
    sourcePath: selected.path,
    targetPath: sftpState.remote.path,
    localPath: selected.path,
    remoteDirectory: sftpState.remote.path,
    remoteName: selected.name,
    status: "queued",
    percent: 0,
    message: `等待上传 ${selected.name}`,
    summary: createTransferSummary(),
    total: createTransferSummary(),
    createdAt: Date.now()
  });
  setSftpStatus(`已加入上传队列：${selected.name}`);
}

async function downloadSelectedEntry() {
  const selectedItems = getSelectedFiles("remote");
  if (!sftpState.sessionId || selectedItems.length === 0) {
    showToast("请选择一个或多个远端项目");
    return;
  }

  for (const selected of selectedItems) {
    const transferId = createId();
    enqueueSftpTransfer({
      id: transferId,
      sessionId: sftpState.sessionId,
      direction: "download",
      name: selected.name,
      sourcePath: selected.path,
      targetPath: sftpState.local.path,
      remotePath: selected.path,
      localDirectory: sftpState.local.path,
      localName: selected.name,
      status: "queued",
      percent: 0,
      message: `等待下载 ${selected.name}`,
      summary: createTransferSummary(),
      total: createTransferSummary(),
      createdAt: Date.now()
    });
  }

  setSftpStatus(
    selectedItems.length === 1
      ? `已加入下载队列：${selectedItems[0].name}`
      : `已加入下载队列：${selectedItems.length} 个远端项目`
  );
}

async function createLocalDirectory() {
  const name = (await requestSftpInput("新建本地目录", "目录名称"))?.trim();
  if (!name) {
    return;
  }

  try {
    await window.xshellBridge.localMkdir({
      parentPath: sftpState.local.path,
      name
    });
    await loadLocalDirectory();
    setSftpStatus("本地目录已创建");
  } catch (error) {
    const message = getErrorMessage(error);
    setSftpStatus(message);
    showToast(message);
  }
}

async function renameLocalSelected(entry?: FileListEntry) {
  const selected = entry ?? getSelectedFile("local");
  if (!selected) {
    showToast("请选择一个本地项目");
    return;
  }

  const newName = (
    await requestSftpInput("重命名本地项目", "新的名称", selected.name)
  )?.trim();
  if (!newName || newName === selected.name) {
    return;
  }

  try {
    setSftpStatus(`正在重命名 ${selected.name}`);
    await window.xshellBridge.localRename({
      path: selected.path,
      newName
    });
    await loadLocalDirectory();
    setSftpStatus("本地项目已重命名");
  } catch (error) {
    const message = getErrorMessage(error);
    setSftpStatus(message);
    showToast(message);
  }
}

async function deleteLocalSelected() {
  const selectedItems = getSelectedFiles("local");
  if (selectedItems.length === 0) {
    showToast("请选择一个或多个本地项目");
    return;
  }

  const directoryCount = selectedItems.filter((item) => item.kind === "directory").length;
  const fileCount = selectedItems.length - directoryCount;
  const single = selectedItems[0];
  const confirmMessage =
    selectedItems.length === 1
      ? single.kind === "directory"
        ? `递归删除本地目录「${single.name}」及其中全部内容？`
        : `删除本地文件「${single.name}」？`
      : `删除选中的 ${selectedItems.length} 个本地项目？${directoryCount ? `\n其中 ${directoryCount} 个目录会被递归删除。` : ""}${fileCount ? `\n文件 ${fileCount} 个。` : ""}`;

  if (!window.confirm(confirmMessage)) {
    return;
  }

  try {
    setSftpStatus(
      selectedItems.length === 1
        ? `正在删除 ${single.name}`
        : `正在删除 ${selectedItems.length} 个本地项目`
    );
    await window.xshellBridge.localDelete({
      paths: selectedItems.map((item) => item.path)
    });
    await loadLocalDirectory();
    setSftpStatus(
      selectedItems.length === 1
        ? "本地项目已删除"
        : `已删除 ${selectedItems.length} 个本地项目`
    );
  } catch (error) {
    const message = getErrorMessage(error);
    setSftpStatus(message);
    showToast(message);
  }
}

async function createRemoteDirectory() {
  const name = (await requestSftpInput("新建远端目录", "目录名称"))?.trim();
  if (!name || !sftpState.sessionId) {
    return;
  }

  try {
    await window.xshellBridge.sftpMkdir({
      sessionId: sftpState.sessionId,
      parentPath: sftpState.remote.path,
      name
    });
    await loadRemoteDirectory();
    setSftpStatus("远端目录已创建");
  } catch (error) {
    const message = getErrorMessage(error);
    setSftpStatus(message);
    showToast(message);
  }
}

async function renameRemoteSelected(entry?: FileListEntry) {
  const selected = entry ?? getSelectedFile("remote");
  if (!sftpState.sessionId || !selected) {
    showToast("请选择一个远端项目");
    return;
  }

  const newName = (
    await requestSftpInput("重命名远端项目", "新的名称", selected.name)
  )?.trim();
  if (!newName || newName === selected.name) {
    return;
  }

  try {
    setSftpStatus(`正在重命名 ${selected.name}`);
    await window.xshellBridge.sftpRename({
      sessionId: sftpState.sessionId,
      path: selected.path,
      newName
    });
    await loadRemoteDirectory();
    setSftpStatus("远端项目已重命名");
  } catch (error) {
    const message = getErrorMessage(error);
    setSftpStatus(message);
    showToast(message);
  }
}

async function deleteRemoteSelected() {
  const selectedItems = getSelectedFiles("remote");
  if (!sftpState.sessionId || selectedItems.length === 0) {
    showToast("请选择一个或多个远端项目");
    return;
  }

  const directoryCount = selectedItems.filter((item) => item.kind === "directory").length;
  const fileCount = selectedItems.length - directoryCount;
  const single = selectedItems[0];
  const confirmMessage =
    selectedItems.length === 1
      ? single.kind === "directory"
        ? `递归删除远端目录「${single.name}」及其中全部内容？`
        : `删除远端文件「${single.name}」？`
      : `删除选中的 ${selectedItems.length} 个远端项目？${directoryCount ? `\n其中 ${directoryCount} 个目录会被递归删除。` : ""}${fileCount ? `\n文件 ${fileCount} 个。` : ""}`;
  if (!window.confirm(confirmMessage)) {
    return;
  }

  try {
    setSftpStatus(
      selectedItems.length === 1
        ? `正在删除 ${single.name}`
        : `正在删除 ${selectedItems.length} 个远端项目`
    );
    await window.xshellBridge.sftpDelete({
      sessionId: sftpState.sessionId,
      items: selectedItems.map((item) => ({
        path: item.path,
        kind: item.kind
      }))
    });
    await loadRemoteDirectory();
    setSftpStatus(
      selectedItems.length === 1
        ? "远端项目已删除"
        : `已删除 ${selectedItems.length} 个远端项目`
    );
  } catch (error) {
    const message = getErrorMessage(error);
    setSftpStatus(message);
    showToast(message);
  }
}

function toggleSidebar(force?: boolean) {
  const shouldShow = force ?? elements.sidebar.classList.contains("hidden");
  elements.sidebar.classList.toggle("hidden", !shouldShow);
  document.body.classList.toggle("sidebar-hidden", !shouldShow);
  fitActiveTerminal();
}

function handleCommand(command: string) {
  switch (command) {
    case "new-session":
    case "quick-connect":
      openConnectionDialog(undefined, { quick: command === "quick-connect" });
      break;
    case "close-tab":
      if (activeTabId) {
        closeTab(activeTabId);
      }
      break;
    case "reconnect-tab":
      void reconnectActiveTab();
      break;
    case "open-search":
      openTerminalSearch();
      break;
    case "search-next":
      openTerminalSearch({ select: false });
      searchActiveTerminal("next");
      break;
    case "search-previous":
      openTerminalSearch({ select: false });
      searchActiveTerminal("previous");
      break;
    case "copy":
      void copyActiveSelection();
      break;
    case "paste":
      void pasteClipboard();
      break;
    case "select-all":
      selectActiveTerminal();
      break;
    case "toggle-sidebar":
      toggleSidebar();
      break;
    case "import-profiles":
      void importProfiles();
      break;
    case "export-profiles":
      void exportProfiles();
      break;
    case "open-sftp":
      void openSftpPanel();
      break;
    case "open-tunnels":
      void openTunnelsPanel();
      break;
    case "open-preferences":
      openPreferences();
      break;
    case "exit-full-screen":
      void window.xshellBridge.windowExitFullScreen();
      break;
    case "toggle-full-screen":
      void window.xshellBridge.windowToggleFullScreen();
      break;
    case "about":
      showToast("XShell NG · 标签式 SSH 客户端");
      break;
  }
}

function wireEvents() {
  elements.exitFullscreen.addEventListener("click", () => {
    void window.xshellBridge.windowExitFullScreen();
  });
  elements.fullscreenMenu.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const command = target.closest<HTMLElement>("[data-command]")?.dataset.command;
    if (!command) {
      return;
    }

    handleCommand(command);
    blurActiveElement();
  });
  $("#new-session").addEventListener("click", () => openConnectionDialog());
  $("#new-tab").addEventListener("click", () => openConnectionDialog(undefined, { quick: true }));
  $("#quick-connect").addEventListener("click", () =>
    openConnectionDialog(undefined, { quick: true })
  );
  $("#empty-connect").addEventListener("click", () => openConnectionDialog());
  $("#disconnect-tab").addEventListener("click", () => void disconnectActiveTab());
  $("#reconnect-tab").addEventListener("click", () => void reconnectActiveTab());
  $("#duplicate-tab").addEventListener("click", duplicateActiveTab);
  $("#open-terminal-search").addEventListener("click", () => openTerminalSearch());
  $("#open-preferences").addEventListener("click", openPreferences);
  $("#open-sftp").addEventListener("click", () => void openSftpPanel());
  $("#open-tunnels").addEventListener("click", () => void openTunnelsPanel());
  $("#import-profiles").addEventListener("click", () => void importProfiles());
  $("#export-profiles").addEventListener("click", () => void exportProfiles());
  $("#close-tunnels").addEventListener("click", () => elements.tunnelDialog.close());
  $("#tunnels-close-footer").addEventListener("click", () => elements.tunnelDialog.close());
  $("#refresh-tunnels").addEventListener("click", () => void refreshTunnels());
  elements.tunnelForm.addEventListener("change", (event) => {
    const target = event.target as HTMLElement;
    if (target.matches('input[name="tunnel-type"]')) {
      syncTunnelForm();
    }
  });
  elements.tunnelForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void createTunnelFromForm();
  });
  elements.tunnelList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".tunnel-row");
    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    if (!row || action !== "stop-tunnel") {
      return;
    }
    void stopTunnel(row.dataset.tunnelId ?? "");
  });
  $("#close-sftp").addEventListener("click", () => elements.sftpDialog.close());
  $("#sftp-close-footer").addEventListener("click", () => elements.sftpDialog.close());
  $("#sftp-input-cancel").addEventListener("click", () => closeSftpInput());
  $("#sftp-input-cancel-footer").addEventListener("click", () => closeSftpInput());
  $("#local-refresh").addEventListener("click", () => void loadLocalDirectory());
  $("#remote-refresh").addEventListener("click", () => void loadRemoteDirectory());
  $("#local-go").addEventListener("click", () => void loadLocalDirectory(elements.sftpLocalPath.value));
  $("#remote-go").addEventListener("click", () => void loadRemoteDirectory(elements.sftpRemotePath.value));
  $("#local-up").addEventListener("click", () => {
    if (sftpState.local.parentPath) {
      void loadLocalDirectory(sftpState.local.parentPath);
    }
  });
  $("#remote-up").addEventListener("click", () => {
    if (sftpState.remote.parentPath) {
      void loadRemoteDirectory(sftpState.remote.parentPath);
    }
  });
  $("#local-mkdir").addEventListener("click", () => void createLocalDirectory());
  $("#local-rename").addEventListener("click", () => void renameLocalSelected());
  $("#local-delete").addEventListener("click", () => void deleteLocalSelected());
  $("#remote-mkdir").addEventListener("click", () => void createRemoteDirectory());
  $("#remote-rename").addEventListener("click", () => void renameRemoteSelected());
  $("#remote-delete").addEventListener("click", () => void deleteRemoteSelected());
  $("#sftp-upload").addEventListener("click", () => void uploadSelectedEntry());
  $("#sftp-download").addEventListener("click", () => void downloadSelectedEntry());
  $("#sftp-clear-completed").addEventListener("click", clearCompletedTransfers);
  elements.terminalSearchClose.addEventListener("click", closeTerminalSearch);
  elements.terminalSearchPrevious.addEventListener("click", () =>
    searchActiveTerminal("previous")
  );
  elements.terminalSearchNext.addEventListener("click", () => searchActiveTerminal("next"));
  elements.terminalSearchCase.addEventListener("click", () =>
    toggleTerminalSearchOption(elements.terminalSearchCase)
  );
  elements.terminalSearchWord.addEventListener("click", () =>
    toggleTerminalSearchOption(elements.terminalSearchWord)
  );
  elements.terminalSearchRegex.addEventListener("click", () =>
    toggleTerminalSearchOption(elements.terminalSearchRegex)
  );
  $("#collapse-sidebar").addEventListener("click", () => toggleSidebar(false));
  $("#show-sidebar").addEventListener("click", () => toggleSidebar(true));
  $("#close-dialog").addEventListener("click", () => elements.connectionDialog.close());
  $("#browse-key").addEventListener("click", async () => {
    const filePath = await window.xshellBridge.selectPrivateKey();
    if (filePath) {
      elements.profileKeyPath.value = filePath;
    }
  });

  elements.sessionSearch.addEventListener("input", renderProfiles);
  elements.sftpTransferQueue.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".queue-row");
    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    if (!row || action !== "cancel-transfer") {
      return;
    }

    void cancelSftpTransfer(row.dataset.transferId ?? "");
  });
  elements.terminalSearchQuery.addEventListener("input", () =>
    searchActiveTerminal("next", true, true)
  );
  elements.terminalSearchQuery.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeTerminalSearch();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      searchActiveTerminal(event.shiftKey ? "previous" : "next");
    }
  });
  elements.sftpInputForm.addEventListener("submit", (event) => {
    event.preventDefault();
    closeSftpInput(elements.sftpInputValue.value);
  });
  elements.sftpInputOverlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeSftpInput();
    }
  });
  elements.sftpLocalPath.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      void loadLocalDirectory(elements.sftpLocalPath.value);
    }
  });
  elements.sftpRemotePath.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      void loadRemoteDirectory(elements.sftpRemotePath.value);
    }
  });
  elements.profileForm.addEventListener("change", (event) => {
    const target = event.target as HTMLElement;
    if (target.matches('input[name="auth-method"]')) {
      syncAuthPanels();
    }
  });

  elements.profileForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitProfileForm();
  });

  async function submitProfileForm() {
    const profile = readProfileForm();
    let connectionProfile: SshProfile;
    try {
      connectionProfile = await profileWithStoredPassword(profile);
    } catch (error) {
      showToast(getErrorMessage(error));
      connectionProfile = profile;
    }

    const validationError = validateConnectProfile(connectionProfile);
    if (validationError) {
      showToast(validationError);
      return;
    }

    if (elements.profileSave.checked) {
      await upsertProfile(profile);
    }
    elements.connectionDialog.close();
    void connectProfile(connectionProfile);
  }

  $("#save-profile").addEventListener("click", () => {
    void saveProfileFromDialog();
  });

  async function saveProfileFromDialog() {
    if (!elements.profileForm.reportValidity()) {
      return;
    }

    const profile = readProfileForm();
    await upsertProfile(profile);
    elements.connectionDialog.close();
    showToast("连接配置已保存");
  }

  elements.sessionList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".session-row");
    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    if (!row || !action) {
      return;
    }

    const profile = profiles.find((item) => item.id === row.dataset.profileId);
    if (!profile) {
      return;
    }

    if (action === "connect") {
      void connectProfile(profile);
    }

    if (action === "edit") {
      openConnectionDialog(profile);
    }

    if (action === "delete") {
      if (!window.confirm(`删除连接配置「${profile.name}」？`)) {
        return;
      }

      profiles = profiles.filter((item) => item.id !== profile.id);
      void window.xshellBridge.secretDelete({ key: passwordSecretKey(profile.id) });
      saveProfiles();
      renderProfiles();
      showToast("连接配置已删除");
    }
  });

  elements.tabStrip.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const tabButton = target.closest<HTMLButtonElement>(".tab");
    if (!tabButton) {
      return;
    }

    if (target.closest("[data-action='close']")) {
      closeTab(tabButton.dataset.tabId ?? "");
      return;
    }

    activeTabId = tabButton.dataset.tabId;
    renderTabs();
    getActiveTab()?.terminal.focus();
    if (isTerminalSearchOpen) {
      searchActiveTerminal("next", true, true);
    }
  });

  elements.terminalStack.addEventListener("pointerdown", () => {
    getActiveTab()?.terminal.focus();
  });

  elements.sftpLocalList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".file-row");
    if (!row) {
      return;
    }

    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    const entry = sftpState.local.entries.find((item) => item.path === row.dataset.path);
    if (!entry) {
      return;
    }

    const filePath = row.dataset.path;
    if (!filePath) {
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      toggleFileSelection("local", filePath);
    } else {
      selectSingleFile("local", filePath);
    }

    if (action === "rename") {
      void renameLocalSelected(entry);
      return;
    }

    if (event.detail >= 2 && entry?.kind === "directory") {
      void loadLocalDirectory(entry.path);
    }
  });

  elements.sftpRemoteList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".file-row");
    if (!row) {
      return;
    }

    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    const entry = sftpState.remote.entries.find((item) => item.path === row.dataset.path);
    if (!entry) {
      return;
    }

    const filePath = row.dataset.path;
    if (!filePath) {
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      toggleRemoteFileSelection(filePath);
    } else {
      selectSingleFile("remote", filePath);
    }

    if (action === "rename") {
      void renameRemoteSelected(entry);
      return;
    }

    if (event.detail >= 2 && entry?.kind === "directory") {
      void loadRemoteDirectory(entry.path);
    }
  });

  elements.preferencesDialog.addEventListener("close", () => {
    preferences = {
      fontSize: Number(elements.prefFontSize.value || 14),
      theme: elements.prefTheme.value as Preferences["theme"],
      cursorBlink: elements.prefCursorBlink.checked
    };
    savePreferences();
    applyPreferences();
  });

  window.addEventListener("resize", fitActiveTerminal);
  window.addEventListener(
    "keydown",
    (event) => {
      handleClipboardShortcut(event);
    },
    true
  );
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) {
      return;
    }

    const key = event.key.toLowerCase();
    if (event.ctrlKey && !event.shiftKey && !event.altKey && key === "f") {
      event.preventDefault();
      openTerminalSearch();
      return;
    }

    if (event.key === "F3") {
      event.preventDefault();
      openTerminalSearch({ select: false });
      searchActiveTerminal(event.shiftKey ? "previous" : "next");
      return;
    }

    if (event.key === "Escape" && isTerminalSearchOpen) {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("dialog")) {
        event.preventDefault();
        closeTerminalSearch();
      }
    }
  });

  window.xshellBridge.onData(({ sessionId, data }) => {
    const tab = tabs.find((item) => item.sessionId === sessionId);
    tab?.terminal.write(data);
  });

  window.xshellBridge.onStatus(({ sessionId, status, message }) => {
    const tab = tabs.find((item) => item.sessionId === sessionId);
    if (!tab) {
      return;
    }

    tab.status = status;
    if (status === "connected") {
      tab.terminal.writeln(`\x1b[32m${message}\x1b[0m`);
    }
    if (status === "error") {
      tab.sessionId = undefined;
      tab.terminal.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
      showToast(message);
    }
    if (status === "disconnected") {
      tab.sessionId = undefined;
      tab.terminal.writeln(`\r\n\x1b[33m${message}\x1b[0m`);
    }
    if (status !== "connected" && tunnelState.sessionId === sessionId) {
      tunnelState.tunnels = [];
      renderTunnels();
    }
    renderTabs();
  });

  window.xshellBridge.onTransferProgress(renderTransferProgress);
  window.xshellBridge.onTunnelsChanged(({ sessionId, tunnels }) => {
    if (tunnelState.sessionId !== sessionId) {
      return;
    }
    tunnelState.tunnels = tunnels;
    renderTunnels();
  });

  window.xshellBridge.onCommand(handleCommand);
  window.xshellBridge.onWindowState(({ isFullScreen }) => {
    renderWindowState(isFullScreen);
  });

  new ResizeObserver(fitActiveTerminal).observe(elements.terminalStack);
}

wireEvents();
renderProfiles();
renderTabs();
setStatus("就绪");
refreshIcons();
void migrateLegacyProfilePasswords();
