import { FitAddon } from "@xterm/addon-fit";
import {
  SearchAddon,
  type ISearchOptions,
  type ISearchResultChangeEvent
} from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { createIcons, icons } from "lucide";
import type {
  AuthMethod,
  FileListEntry,
  KnownHostEntry,
  SavedTunnelConfig,
  SftpConflictPolicy,
  SftpEditOpenResponse,
  SftpEditStatus,
  SftpEditStatusEvent,
  SftpPreviewResponse,
  SshProfile,
  SshProxyType,
  TerminalLogEntry,
  TunnelCheckRequest,
  TunnelCheckResponse,
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
  logFilePath?: string;
  autoStartedSessionId?: string;
  manualDisconnect?: boolean;
  reconnectAttempts: number;
  reconnectTimer?: number;
  loginScriptSessionId?: string;
  triggerSessionId?: string;
  triggerBuffer: string;
  firedTriggerRules: Set<string>;
  status: "idle" | "connecting" | "connected" | "disconnected" | "error";
}

type SplitResizeDirection = "column" | "row";

interface SplitCell {
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
}

interface SplitDivider {
  id: string;
  direction: SplitResizeDirection;
  index: number;
  columnStart: number;
  columnEnd: number;
  rowStart: number;
  rowEnd: number;
}

interface SplitLayout {
  columnCount: number;
  rowCount: number;
  cells: Map<string, SplitCell>;
  dividers: SplitDivider[];
}

interface SplitMetrics {
  columnGap: number;
  rowGap: number;
  columnSizes: number[];
  rowSizes: number[];
  columnStarts: number[];
  columnEnds: number[];
  rowStarts: number[];
  rowEnds: number[];
}

interface SplitResizeState {
  direction: SplitResizeDirection;
  index: number;
  startX: number;
  startY: number;
  startColumns: number[];
  startRows: number[];
}

const themeIds = ["classic", "midnight", "paper"] as const;

type ThemeId = (typeof themeIds)[number];

interface Preferences {
  fontSize: number;
  theme: ThemeId;
  cursorBlink: boolean;
  terminalLogging: boolean;
  logDirectory: string;
}

interface AppTheme {
  label: string;
  colorScheme: "light" | "dark";
  ui: Record<`--${string}`, string>;
  terminal: ITheme;
  searchDecorations: ISearchOptions["decorations"];
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
  conflictPolicy: SftpConflictPolicy;
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

interface QuickCommand {
  id: string;
  name: string;
  group?: string;
  command: string;
}

interface RemoteEditItem extends SftpEditOpenResponse {
  status: SftpEditStatus;
  message: string;
  savedAt?: string;
}

const PROFILE_STORAGE_KEY = "xshell-ng.profiles.v1";
const PREF_STORAGE_KEY = "xshell-ng.preferences.v1";
const QUICK_COMMAND_STORAGE_KEY = "xshell-ng.quickCommands.v1";
const SPLIT_RESIZE_HANDLE_SIZE = 11;
const SPLIT_MIN_COLUMN_SIZE = 160;
const SPLIT_MIN_ROW_SIZE = 110;

const $ = <T extends HTMLElement>(selector: string) => {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element;
};

const elements = {
  topbar: $(".topbar"),
  exitFullscreen: $("#exit-fullscreen") as HTMLButtonElement,
  windowMinimize: $("#window-minimize") as HTMLButtonElement,
  windowMaximize: $("#window-maximize") as HTMLButtonElement,
  windowClose: $("#window-close") as HTMLButtonElement,
  fullscreenMenu: $("#fullscreen-menu"),
  newSession: $("#new-session") as HTMLButtonElement,
  quickConnect: $("#quick-connect") as HTMLButtonElement,
  disconnectTab: $("#disconnect-tab") as HTMLButtonElement,
  reconnectTab: $("#reconnect-tab") as HTMLButtonElement,
  duplicateTab: $("#duplicate-tab") as HTMLButtonElement,
  splitTerminal: $("#split-terminal") as HTMLButtonElement,
  openTerminalSearch: $("#open-terminal-search") as HTMLButtonElement,
  openQuickCommands: $("#open-quick-commands") as HTMLButtonElement,
  openTerminalLogs: $("#open-terminal-logs") as HTMLButtonElement,
  openSftp: $("#open-sftp") as HTMLButtonElement,
  openTunnels: $("#open-tunnels") as HTMLButtonElement,
  openPreferences: $("#open-preferences") as HTMLButtonElement,
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
  terminalContextMenu: $("#terminal-context-menu"),
  splitResizeLayer: $("#split-resize-layer"),
  emptyWorkspace: $("#empty-workspace"),
  statusLeft: $("#status-left"),
  statusRight: $("#status-right"),
  connectionDialog: $("#connection-dialog") as HTMLDialogElement,
  preferencesDialog: $("#preferences-dialog") as HTMLDialogElement,
  terminalLogDialog: $("#terminal-log-dialog") as HTMLDialogElement,
  quickCommandDialog: $("#quick-command-dialog") as HTMLDialogElement,
  knownHostDialog: $("#known-host-dialog") as HTMLDialogElement,
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
  profileProxyType: $("#profile-proxy-type") as HTMLSelectElement,
  profileJumpProfile: $("#profile-jump-profile") as HTMLSelectElement,
  profileJumpProfileRow: $("#profile-jump-profile-row"),
  profileProxyHost: $("#profile-proxy-host") as HTMLInputElement,
  profileProxyPort: $("#profile-proxy-port") as HTMLInputElement,
  profileProxyHostRow: $("#profile-proxy-host-row"),
  profileProxyPortRow: $("#profile-proxy-port-row"),
  profileKeepaliveInterval: $("#profile-keepalive-interval") as HTMLInputElement,
  profileAutoReconnect: $("#profile-auto-reconnect") as HTMLInputElement,
  profileReconnectLimit: $("#profile-reconnect-limit") as HTMLInputElement,
  profileLoginScript: $("#profile-login-script") as HTMLTextAreaElement,
  profileTriggerRules: $("#profile-trigger-rules") as HTMLTextAreaElement,
  passwordFields: $("#password-fields"),
  keyFields: $("#key-fields"),
  prefFontSize: $("#pref-font-size") as HTMLInputElement,
  prefTheme: $("#pref-theme") as HTMLSelectElement,
  prefCursorBlink: $("#pref-cursor-blink") as HTMLInputElement,
  prefTerminalLogging: $("#pref-terminal-logging") as HTMLInputElement,
  prefLogDirectory: $("#pref-log-directory") as HTMLInputElement,
  chooseLogDirectory: $("#choose-log-directory") as HTMLButtonElement,
  openLogDirectory: $("#open-log-directory") as HTMLButtonElement,
  terminalLogSummary: $("#terminal-log-summary"),
  terminalLogDirectory: $("#terminal-log-directory"),
  terminalLogList: $("#terminal-log-list"),
  terminalLogRefresh: $("#terminal-log-refresh") as HTMLButtonElement,
  terminalLogOpenDirectory: $("#terminal-log-open-directory") as HTMLButtonElement,
  terminalLogOpenCurrent: $("#terminal-log-open-current") as HTMLButtonElement,
  quickCommandSummary: $("#quick-command-summary"),
  quickCommandList: $("#quick-command-list"),
  quickCommandForm: $("#quick-command-form") as HTMLFormElement,
  quickCommandName: $("#quick-command-name") as HTMLInputElement,
  quickCommandGroup: $("#quick-command-group") as HTMLInputElement,
  quickCommandBody: $("#quick-command-body") as HTMLTextAreaElement,
  quickCommandDelete: $("#quick-command-delete") as HTMLButtonElement,
  quickCommandSend: $("#quick-command-send") as HTMLButtonElement,
  knownHostSummary: $("#known-host-summary"),
  knownHostList: $("#known-host-list"),
  knownHostClear: $("#known-host-clear") as HTMLButtonElement,
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
  tunnelSaveProfile: $("#tunnel-save-profile") as HTMLInputElement,
  tunnelAutoStart: $("#tunnel-auto-start") as HTMLInputElement,
  tunnelCheck: $("#tunnel-check") as HTMLButtonElement,
  tunnelCheckResult: $("#tunnel-check-result"),
  tunnelSummary: $("#tunnel-summary"),
  tunnelList: $("#tunnel-list"),
  savedTunnelSummary: $("#saved-tunnel-summary"),
  savedTunnelList: $("#saved-tunnel-list"),
  sftpSubtitle: $("#sftp-subtitle"),
  sftpLocalPath: $("#sftp-local-path") as HTMLInputElement,
  sftpRemotePath: $("#sftp-remote-path") as HTMLInputElement,
  sftpConflictPolicy: $("#sftp-conflict-policy") as HTMLSelectElement,
  sftpLocalList: $("#sftp-local-list"),
  sftpRemoteList: $("#sftp-remote-list"),
  sftpLocalCount: $("#sftp-local-count"),
  sftpRemoteCount: $("#sftp-remote-count"),
  sftpRemoteChmod: $("#remote-chmod") as HTMLButtonElement,
  sftpStatus: $("#sftp-status"),
  sftpProgressFill: $("#sftp-progress-fill"),
  sftpProgressPercent: $("#sftp-progress-percent"),
  sftpProgressDetail: $("#sftp-progress-detail"),
  sftpQueueSummary: $("#sftp-queue-summary"),
  sftpTransferQueue: $("#sftp-transfer-queue"),
  sftpEditSummary: $("#sftp-edit-summary"),
  sftpEditList: $("#sftp-edit-list"),
  sftpInputOverlay: $("#sftp-input-overlay"),
  sftpInputForm: $("#sftp-input-form") as HTMLFormElement,
  sftpInputTitle: $("#sftp-input-title"),
  sftpInputLabel: $("#sftp-input-label"),
  sftpInputValue: $("#sftp-input-value") as HTMLInputElement,
  sftpPreviewOverlay: $("#sftp-preview-overlay"),
  sftpPreviewTitle: $("#sftp-preview-title"),
  sftpPreviewMeta: $("#sftp-preview-meta"),
  sftpPreviewBody: $("#sftp-preview-body"),
  sftpPreviewEdit: $("#sftp-preview-edit") as HTMLButtonElement,
  toast: $("#toast")
};

let profiles: SshProfile[] = loadProfiles();
let tabs: TerminalTab[] = [];
let activeTabId: string | undefined;
let isSplitView = false;
let splitLayout: SplitLayout | undefined;
let splitLayoutKey = "";
let splitColumnFractions: number[] = [];
let splitRowFractions: number[] = [];
let splitResizeState: SplitResizeState | undefined;
let splitResizeFrame: number | undefined;
let editingProfileId: string | undefined;
let preferences: Preferences = loadPreferences();
let quickCommands: QuickCommand[] = loadQuickCommands();
let terminalLogEntries: TerminalLogEntry[] = [];
let activeQuickCommandId: string | undefined;
let knownHostEntries: KnownHostEntry[] = [];
let toastTimer: number | undefined;
let menuCloseTimer: number | undefined;
let pendingSftpInput: ((value: string | undefined) => void) | undefined;
let isTerminalSearchOpen = false;
let activeSftpTransferId: string | undefined;
let sftpTransferQueue: SftpTransferQueueItem[] = [];
let remoteEditSessions: RemoteEditItem[] = [];
let activeSftpPreviewEntry: FileListEntry | undefined;
let tunnelState: { sessionId?: string; profileId?: string; tunnels: TunnelInfo[] } = {
  tunnels: []
};
let sftpState: SftpState = {
  local: { path: "", entries: [] },
  remote: { path: ".", entries: [] }
};

const appThemes: Record<ThemeId, AppTheme> = {
  classic: {
    label: "Classic Blue",
    colorScheme: "light",
    ui: {
      "--klein": "#1247b7",
      "--klein-deep": "#0b255f",
      "--klein-bright": "#2563eb",
      "--klein-soft": "#e8f0ff",
      "--klein-panel": "#f7faff",
      "--cyan": "#0ea5c6",
      "--success": "#168a5b",
      "--warning": "#b77912",
      "--bg": "#edf3ff",
      "--panel": "#ffffff",
      "--panel-soft": "#f6f9ff",
      "--line": "#c7d6ee",
      "--line-strong": "#90a8d5",
      "--text": "#13213b",
      "--muted": "#61718d",
      "--accent": "#1247b7",
      "--accent-strong": "#0b255f",
      "--accent-soft": "#e8f0ff",
      "--danger": "#c2410c",
      "--terminal-frame": "#071326",
      "--app-glow": "rgba(18, 71, 183, 0.09)",
      "--scrollbar-track": "#eef4ff",
      "--scrollbar-thumb": "#9fb7eb",
      "--topbar-bg": "linear-gradient(90deg, #0b255f, #1247b7, #0877c4)",
      "--topbar-border": "rgba(255, 255, 255, 0.14)",
      "--topbar-text": "#ffffff",
      "--topbar-muted": "rgba(255, 255, 255, 0.74)",
      "--topbar-hover": "rgba(255, 255, 255, 0.14)",
      "--brand-border": "rgba(255, 255, 255, 0.36)",
      "--brand-bg": "rgba(255, 255, 255, 0.16)",
      "--brand-glow": "rgba(14, 165, 198, 0.24)",
      "--menu-bg": "#ffffff",
      "--menu-border": "rgba(18, 71, 183, 0.22)",
      "--menu-shadow": "rgba(0, 28, 96, 0.2)",
      "--menu-text": "#1f2937",
      "--menu-hover-bg": "#e8f0ff",
      "--menu-hover-text": "#1247b7",
      "--menu-divider": "#d6e1f7",
      "--toolbar-bg": "linear-gradient(#f9fbff, #e7efff)",
      "--toolbar-border": "#b8c9ec",
      "--toolbar-shadow": "#ffffff",
      "--control-bg": "#ffffff",
      "--control-soft-bg": "#f7faff",
      "--control-shadow": "rgba(255, 255, 255, 0.85)",
      "--button-hover-bg": "#ffffff",
      "--button-hover-border": "#9fb7eb",
      "--button-hover-text": "#1247b7",
      "--primary-shadow": "rgba(18, 71, 183, 0.18)",
      "--sidebar-bg": "linear-gradient(180deg, #f9fbff, #eff5ff)",
      "--sidebar-head-bg": "rgba(255, 255, 255, 0.64)",
      "--row-hover-bg": "#ffffff",
      "--row-hover-border": "#b7c8ef",
      "--row-hover-shadow": "rgba(18, 71, 183, 0.08)",
      "--tabbar-bg": "linear-gradient(180deg, #dce7ff, #c7d8ff)",
      "--tabbar-border": "#00143f",
      "--tab-bg": "#f7faff",
      "--tab-text": "#203761",
      "--tab-border": "#9fb4e4",
      "--tab-active-bg": "#071326",
      "--tab-active-text": "#ffffff",
      "--terminal-empty-bg": "radial-gradient(circle at 50% 36%, rgba(18, 71, 183, 0.32), transparent 240px), linear-gradient(135deg, rgba(255, 255, 255, 0.04), transparent 42%), #071326",
      "--status-bg": "#f7faff",
      "--status-text": "#49607f",
      "--modal-scrim": "rgba(0, 17, 64, 0.48)",
      "--modal-bg": "#ffffff",
      "--modal-head-bg": "linear-gradient(180deg, #f8fbff, #edf4ff)",
      "--danger-soft": "#fff1f2",
      "--success-soft": "#dcfce7",
      "--queue-track": "#dbe7ff",
      "--progress-bg": "#dbe7ff"
    },
    terminal: {
      background: "#071326",
      foreground: "#dbe8ff",
      cursor: "#00d4ff",
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
    searchDecorations: {
      matchBackground: "#fff1a8",
      matchBorder: "#d97706",
      matchOverviewRuler: "#d97706",
      activeMatchBackground: "#b7ccff",
      activeMatchBorder: "#1247b7",
      activeMatchColorOverviewRuler: "#1247b7"
    }
  },
  midnight: {
    label: "Midnight Ops",
    colorScheme: "dark",
    ui: {
      "--klein": "#60a5fa",
      "--klein-deep": "#08111f",
      "--klein-bright": "#22d3ee",
      "--klein-soft": "#10243a",
      "--klein-panel": "#131f31",
      "--cyan": "#2dd4bf",
      "--success": "#34d399",
      "--warning": "#f59e0b",
      "--bg": "#0d1420",
      "--panel": "#151f2e",
      "--panel-soft": "#101927",
      "--line": "#2a3a52",
      "--line-strong": "#3a516f",
      "--text": "#e6edf7",
      "--muted": "#8fa1bb",
      "--accent": "#60a5fa",
      "--accent-strong": "#22d3ee",
      "--accent-soft": "#10243a",
      "--danger": "#fb7185",
      "--terminal-frame": "#070b12",
      "--app-glow": "rgba(34, 211, 238, 0.08)",
      "--scrollbar-track": "#101927",
      "--scrollbar-thumb": "#39526f",
      "--topbar-bg": "linear-gradient(90deg, #070b12, #111827, #12303f)",
      "--topbar-border": "rgba(148, 163, 184, 0.2)",
      "--topbar-text": "#e6edf7",
      "--topbar-muted": "rgba(226, 232, 240, 0.68)",
      "--topbar-hover": "rgba(148, 163, 184, 0.16)",
      "--brand-border": "rgba(148, 163, 184, 0.34)",
      "--brand-bg": "rgba(148, 163, 184, 0.12)",
      "--brand-glow": "rgba(45, 212, 191, 0.28)",
      "--menu-bg": "#172235",
      "--menu-border": "rgba(96, 165, 250, 0.28)",
      "--menu-shadow": "rgba(0, 0, 0, 0.42)",
      "--menu-text": "#e6edf7",
      "--menu-hover-bg": "#213452",
      "--menu-hover-text": "#7dd3fc",
      "--menu-divider": "#2a3a52",
      "--toolbar-bg": "linear-gradient(#172235, #111b2b)",
      "--toolbar-border": "#2a3a52",
      "--toolbar-shadow": "rgba(255, 255, 255, 0.04)",
      "--control-bg": "#172235",
      "--control-soft-bg": "#111b2b",
      "--control-shadow": "rgba(255, 255, 255, 0.04)",
      "--button-hover-bg": "#1d2b42",
      "--button-hover-border": "#3d5875",
      "--button-hover-text": "#7dd3fc",
      "--primary-shadow": "rgba(34, 211, 238, 0.18)",
      "--sidebar-bg": "linear-gradient(180deg, #121d2d, #0f1724)",
      "--sidebar-head-bg": "rgba(22, 32, 48, 0.88)",
      "--row-hover-bg": "#172235",
      "--row-hover-border": "#36506f",
      "--row-hover-shadow": "rgba(0, 0, 0, 0.24)",
      "--tabbar-bg": "linear-gradient(180deg, #172235, #101927)",
      "--tabbar-border": "#070b12",
      "--tab-bg": "#142033",
      "--tab-text": "#c7d2e5",
      "--tab-border": "#2a3a52",
      "--tab-active-bg": "#070b12",
      "--tab-active-text": "#f8fafc",
      "--terminal-empty-bg": "radial-gradient(circle at 50% 36%, rgba(34, 211, 238, 0.16), transparent 240px), linear-gradient(135deg, rgba(255, 255, 255, 0.04), transparent 42%), #070b12",
      "--status-bg": "#111b2b",
      "--status-text": "#9fb0c9",
      "--modal-scrim": "rgba(0, 0, 0, 0.62)",
      "--modal-bg": "#151f2e",
      "--modal-head-bg": "linear-gradient(180deg, #1a2638, #121d2d)",
      "--danger-soft": "#3b1822",
      "--success-soft": "#102d23",
      "--queue-track": "#223149",
      "--progress-bg": "#223149"
    },
    terminal: {
      background: "#070b12",
      foreground: "#d8e2f0",
      cursor: "#22d3ee",
      selectionBackground: "#1d4ed8",
      black: "#070b12",
      red: "#fb7185",
      green: "#34d399",
      yellow: "#f59e0b",
      blue: "#60a5fa",
      magenta: "#c084fc",
      cyan: "#2dd4bf",
      white: "#d8e2f0",
      brightBlack: "#64748b",
      brightRed: "#fda4af",
      brightGreen: "#86efac",
      brightYellow: "#fcd34d",
      brightBlue: "#93c5fd",
      brightMagenta: "#d8b4fe",
      brightCyan: "#99f6e4",
      brightWhite: "#ffffff"
    },
    searchDecorations: {
      matchBackground: "#7c5d12",
      matchBorder: "#fbbf24",
      matchOverviewRuler: "#fbbf24",
      activeMatchBackground: "#075985",
      activeMatchBorder: "#22d3ee",
      activeMatchColorOverviewRuler: "#22d3ee"
    }
  },
  paper: {
    label: "Paper Light",
    colorScheme: "light",
    ui: {
      "--klein": "#256c5a",
      "--klein-deep": "#163f36",
      "--klein-bright": "#0f766e",
      "--klein-soft": "#e3f3ee",
      "--klein-panel": "#f7faf8",
      "--cyan": "#19758a",
      "--success": "#2f7d4f",
      "--warning": "#a46a12",
      "--bg": "#f3f6f2",
      "--panel": "#ffffff",
      "--panel-soft": "#f7faf8",
      "--line": "#ccd8d0",
      "--line-strong": "#9ab0a4",
      "--text": "#1f2a2a",
      "--muted": "#65736d",
      "--accent": "#256c5a",
      "--accent-strong": "#163f36",
      "--accent-soft": "#e3f3ee",
      "--danger": "#b42318",
      "--terminal-frame": "#f8faf7",
      "--app-glow": "rgba(37, 108, 90, 0.08)",
      "--scrollbar-track": "#edf3ef",
      "--scrollbar-thumb": "#a9beb2",
      "--topbar-bg": "linear-gradient(90deg, #163f36, #256c5a, #19758a)",
      "--topbar-border": "rgba(255, 255, 255, 0.18)",
      "--topbar-text": "#ffffff",
      "--topbar-muted": "rgba(255, 255, 255, 0.76)",
      "--topbar-hover": "rgba(255, 255, 255, 0.16)",
      "--brand-border": "rgba(255, 255, 255, 0.38)",
      "--brand-bg": "rgba(255, 255, 255, 0.14)",
      "--brand-glow": "rgba(255, 255, 255, 0.2)",
      "--menu-bg": "#ffffff",
      "--menu-border": "rgba(37, 108, 90, 0.22)",
      "--menu-shadow": "rgba(20, 58, 49, 0.18)",
      "--menu-text": "#1f2a2a",
      "--menu-hover-bg": "#e3f3ee",
      "--menu-hover-text": "#256c5a",
      "--menu-divider": "#d8e4de",
      "--toolbar-bg": "linear-gradient(#fbfcfb, #eaf2ee)",
      "--toolbar-border": "#b9cabe",
      "--toolbar-shadow": "#ffffff",
      "--control-bg": "#ffffff",
      "--control-soft-bg": "#f7faf8",
      "--control-shadow": "rgba(255, 255, 255, 0.86)",
      "--button-hover-bg": "#ffffff",
      "--button-hover-border": "#9ab0a4",
      "--button-hover-text": "#256c5a",
      "--primary-shadow": "rgba(37, 108, 90, 0.16)",
      "--sidebar-bg": "linear-gradient(180deg, #fbfcfb, #edf4f0)",
      "--sidebar-head-bg": "rgba(255, 255, 255, 0.7)",
      "--row-hover-bg": "#ffffff",
      "--row-hover-border": "#b9cabe",
      "--row-hover-shadow": "rgba(37, 108, 90, 0.08)",
      "--tabbar-bg": "linear-gradient(180deg, #eef5f1, #dce9e3)",
      "--tabbar-border": "#bdd0c5",
      "--tab-bg": "#ffffff",
      "--tab-text": "#2b3b38",
      "--tab-border": "#a9beb2",
      "--tab-active-bg": "#f8faf7",
      "--tab-active-text": "#1f2a2a",
      "--terminal-empty-bg": "radial-gradient(circle at 50% 36%, rgba(37, 108, 90, 0.15), transparent 240px), linear-gradient(135deg, rgba(25, 117, 138, 0.08), transparent 42%), #f8faf7",
      "--status-bg": "#f7faf8",
      "--status-text": "#52665f",
      "--modal-scrim": "rgba(24, 49, 43, 0.42)",
      "--modal-bg": "#ffffff",
      "--modal-head-bg": "linear-gradient(180deg, #fbfcfb, #edf4f0)",
      "--danger-soft": "#fff1f0",
      "--success-soft": "#e4f5e8",
      "--queue-track": "#dce9e3",
      "--progress-bg": "#dce9e3"
    },
    terminal: {
      background: "#fbfcf8",
      foreground: "#1f2a2a",
      cursor: "#256c5a",
      selectionBackground: "#cfe3d7",
      black: "#1f2a2a",
      red: "#b42318",
      green: "#2f7d4f",
      yellow: "#9a6700",
      blue: "#1d5fbf",
      magenta: "#7c3aed",
      cyan: "#19758a",
      white: "#f8faf7",
      brightBlack: "#718096",
      brightRed: "#d92d20",
      brightGreen: "#16a34a",
      brightYellow: "#b7791f",
      brightBlue: "#2563eb",
      brightMagenta: "#9333ea",
      brightCyan: "#0891b2",
      brightWhite: "#ffffff"
    },
    searchDecorations: {
      matchBackground: "#fff1a8",
      matchBorder: "#a46a12",
      matchOverviewRuler: "#a46a12",
      activeMatchBackground: "#cfe3d7",
      activeMatchBorder: "#256c5a",
      activeMatchColorOverviewRuler: "#256c5a"
    }
  }
};

function createId() {
  return crypto.randomUUID();
}

function normalizeQuickCommand(value: unknown): QuickCommand | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<QuickCommand>;
  const command = typeof candidate.command === "string" ? candidate.command : "";
  const name =
    typeof candidate.name === "string" && candidate.name.trim()
      ? candidate.name.trim()
      : command.trim().split(/\r?\n/)[0]?.slice(0, 42).trim() || "未命名命令";
  return {
    id: typeof candidate.id === "string" && candidate.id ? candidate.id : createId(),
    name,
    group:
      typeof candidate.group === "string" && candidate.group.trim()
        ? candidate.group.trim()
        : undefined,
    command
  };
}

function loadQuickCommands() {
  try {
    const raw = localStorage.getItem(QUICK_COMMAND_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed
          .map(normalizeQuickCommand)
          .filter((command): command is QuickCommand => Boolean(command))
      : [];
  } catch {
    return [];
  }
}

function saveQuickCommands() {
  localStorage.setItem(QUICK_COMMAND_STORAGE_KEY, JSON.stringify(quickCommands));
}

function isTunnelType(value: unknown): value is TunnelType {
  return value === "local" || value === "remote" || value === "dynamic";
}

function isProxyType(value: unknown): value is SshProxyType {
  return value === "jump" || value === "socks5" || value === "http";
}

function normalizePort(value: unknown, fallback?: number) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

function normalizeKeepaliveInterval(value: unknown) {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 0 && seconds <= 300 ? seconds : 15;
}

function normalizeReconnectLimit(value: unknown) {
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= 20 ? limit : 3;
}

function normalizeProxyConfig(value: unknown): SshProfile["proxy"] {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as NonNullable<SshProfile["proxy"]>;
  if (!isProxyType(candidate.type)) {
    return undefined;
  }

  if (candidate.type === "jump") {
    return typeof candidate.jumpProfileId === "string" && candidate.jumpProfileId
      ? {
          type: "jump",
          jumpProfileId: candidate.jumpProfileId
        }
      : undefined;
  }

  const port = normalizePort(candidate.port, candidate.type === "socks5" ? 1080 : 8080);
  return typeof candidate.host === "string" && candidate.host.trim() && port
    ? {
        type: candidate.type,
        host: candidate.host.trim(),
        port
      }
    : undefined;
}

function defaultTunnelName(type: TunnelType) {
  return {
    local: "本地转发",
    remote: "远端转发",
    dynamic: "SOCKS5 代理"
  }[type];
}

function normalizeSavedTunnel(value: unknown): SavedTunnelConfig | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<SavedTunnelConfig>;
  const type = isTunnelType(candidate.type) ? candidate.type : "local";
  const localPort = Number(candidate.localPort);
  const remotePort = Number(candidate.remotePort);
  const targetPort = Number(candidate.targetPort);
  return {
    id: typeof candidate.id === "string" && candidate.id ? candidate.id : createId(),
    type,
    name:
      typeof candidate.name === "string" && candidate.name.trim()
        ? candidate.name.trim()
        : defaultTunnelName(type),
    autoStart: Boolean(candidate.autoStart),
    localHost: typeof candidate.localHost === "string" ? candidate.localHost.trim() : undefined,
    localPort:
      Number.isInteger(localPort) && localPort >= 0 && localPort <= 65535
        ? localPort
        : undefined,
    remoteHost:
      typeof candidate.remoteHost === "string" ? candidate.remoteHost.trim() : undefined,
    remotePort:
      Number.isInteger(remotePort) && remotePort >= 0 && remotePort <= 65535
        ? remotePort
        : undefined,
    targetHost:
      typeof candidate.targetHost === "string" ? candidate.targetHost.trim() : undefined,
    targetPort:
      Number.isInteger(targetPort) && targetPort >= 1 && targetPort <= 65535
        ? targetPort
        : undefined
  };
}

function normalizeProfile(profile: SshProfile): SshProfile {
  return {
    ...profile,
    proxy: normalizeProxyConfig(profile.proxy),
    keepaliveInterval: normalizeKeepaliveInterval(profile.keepaliveInterval),
    autoReconnect: Boolean(profile.autoReconnect),
    reconnectLimit: normalizeReconnectLimit(profile.reconnectLimit),
    loginScript: typeof profile.loginScript === "string" ? profile.loginScript : "",
    triggerRules: typeof profile.triggerRules === "string" ? profile.triggerRules : "",
    tunnels: Array.isArray(profile.tunnels)
      ? profile.tunnels
          .map(normalizeSavedTunnel)
          .filter((tunnel): tunnel is SavedTunnelConfig => Boolean(tunnel))
      : []
  };
}

function loadProfiles() {
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SshProfile[]).map(normalizeProfile) : [];
  } catch {
    return [];
  }
}

function saveProfiles() {
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profiles));
}

function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && themeIds.includes(value as ThemeId);
}

function getThemeConfig(theme: ThemeId = preferences.theme) {
  return appThemes[theme];
}

function applyTheme(theme: ThemeId) {
  const config = getThemeConfig(theme);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = config.colorScheme;
  Object.entries(config.ui).forEach(([name, value]) => {
    document.documentElement.style.setProperty(name, value);
  });
  document.documentElement.style.setProperty(
    "--terminal-bg",
    config.terminal.background ?? config.ui["--terminal-frame"]
  );
  document.documentElement.style.setProperty(
    "--terminal-fg",
    config.terminal.foreground ?? config.ui["--text"]
  );
}

function loadPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(PREF_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Preferences>;
      return {
        fontSize: Number(parsed.fontSize || 14),
        theme: isThemeId(parsed.theme) ? parsed.theme : "classic",
        cursorBlink: parsed.cursorBlink ?? true,
        terminalLogging: Boolean(parsed.terminalLogging),
        logDirectory: typeof parsed.logDirectory === "string" ? parsed.logDirectory : ""
      };
    }
  } catch {
    // Fall through to defaults.
  }

  return {
    fontSize: 14,
    theme: "classic",
    cursorBlink: true,
    terminalLogging: false,
    logDirectory: ""
  };
}

function savePreferences() {
  localStorage.setItem(PREF_STORAGE_KEY, JSON.stringify(preferences));
}

function sanitizeProfile(profile: SshProfile): SshProfile {
  return {
    ...normalizeProfile(profile),
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

async function resolveConnectProfiles(profile: SshProfile) {
  const connectionProfile = await profileWithStoredPassword(normalizeProfile(profile));
  const proxy = connectionProfile.proxy;
  if (proxy?.type !== "jump" || !proxy.jumpProfileId) {
    return { profile: connectionProfile };
  }

  const jumpProfile = profiles.find((item) => item.id === proxy.jumpProfileId);
  return {
    profile: connectionProfile,
    proxyProfile: jumpProfile ? await profileWithStoredPassword(jumpProfile) : undefined
  };
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

function renderThemeOptions() {
  elements.prefTheme.innerHTML = themeIds
    .map((themeId) => {
      const theme = appThemes[themeId];
      return `<option value="${themeId}">${escapeHtml(theme.label)}</option>`;
    })
    .join("");
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

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function createSplitLayout(): SplitLayout | undefined {
  if (tabs.length < 2) {
    return undefined;
  }

  const cells = new Map<string, SplitCell>();
  const dividers: SplitDivider[] = [];

  if (tabs.length === 2) {
    cells.set(tabs[0].id, { column: 0, row: 0, columnSpan: 1, rowSpan: 1 });
    cells.set(tabs[1].id, { column: 1, row: 0, columnSpan: 1, rowSpan: 1 });
    dividers.push({
      id: "column-0",
      direction: "column",
      index: 0,
      columnStart: 0,
      columnEnd: 2,
      rowStart: 0,
      rowEnd: 1
    });
    return { columnCount: 2, rowCount: 1, cells, dividers };
  }

  if (tabs.length === 3) {
    cells.set(tabs[0].id, { column: 0, row: 0, columnSpan: 1, rowSpan: 2 });
    cells.set(tabs[1].id, { column: 1, row: 0, columnSpan: 1, rowSpan: 1 });
    cells.set(tabs[2].id, { column: 1, row: 1, columnSpan: 1, rowSpan: 1 });
    dividers.push(
      {
        id: "column-0",
        direction: "column",
        index: 0,
        columnStart: 0,
        columnEnd: 2,
        rowStart: 0,
        rowEnd: 2
      },
      {
        id: "row-0-secondary",
        direction: "row",
        index: 0,
        columnStart: 1,
        columnEnd: 2,
        rowStart: 0,
        rowEnd: 2
      }
    );
    return { columnCount: 2, rowCount: 2, cells, dividers };
  }

  const columnCount = tabs.length === 4 ? 2 : Math.ceil(Math.sqrt(tabs.length));
  const rowCount = Math.ceil(tabs.length / columnCount);

  tabs.forEach((tab, index) => {
    cells.set(tab.id, {
      column: index % columnCount,
      row: Math.floor(index / columnCount),
      columnSpan: 1,
      rowSpan: 1
    });
  });

  for (let index = 0; index < columnCount - 1; index += 1) {
    dividers.push({
      id: `column-${index}`,
      direction: "column",
      index,
      columnStart: 0,
      columnEnd: columnCount,
      rowStart: 0,
      rowEnd: rowCount
    });
  }

  for (let index = 0; index < rowCount - 1; index += 1) {
    dividers.push({
      id: `row-${index}`,
      direction: "row",
      index,
      columnStart: 0,
      columnEnd: columnCount,
      rowStart: 0,
      rowEnd: rowCount
    });
  }

  return { columnCount, rowCount, cells, dividers };
}

function getSplitLayoutKey(layout: SplitLayout) {
  return `${tabs.length}:${layout.columnCount}x${layout.rowCount}`;
}

function getDefaultSplitFractions(layout: SplitLayout, direction: SplitResizeDirection) {
  const count = direction === "column" ? layout.columnCount : layout.rowCount;
  if (direction === "column" && tabs.length === 3 && count === 2) {
    return [1.35, 1];
  }
  return Array.from({ length: count }, () => 1);
}

function ensureSplitFractions(layout: SplitLayout, force = false) {
  const nextLayoutKey = getSplitLayoutKey(layout);
  const shouldReset = force || splitLayoutKey !== nextLayoutKey;
  if (shouldReset || splitColumnFractions.length !== layout.columnCount) {
    splitColumnFractions = getDefaultSplitFractions(layout, "column");
  }
  if (shouldReset || splitRowFractions.length !== layout.rowCount) {
    splitRowFractions = getDefaultSplitFractions(layout, "row");
  }
  splitLayoutKey = nextLayoutKey;
}

function formatSplitFraction(value: number) {
  return String(Math.max(0.1, Number(value.toFixed(3))));
}

function applySplitGridStyles(layout: SplitLayout) {
  elements.terminalStack.style.setProperty(
    "--split-columns",
    splitColumnFractions
      .slice(0, layout.columnCount)
      .map((fraction) => `minmax(0, ${formatSplitFraction(fraction)}fr)`)
      .join(" ")
  );
  elements.terminalStack.style.setProperty(
    "--split-rows",
    splitRowFractions
      .slice(0, layout.rowCount)
      .map((fraction) => `minmax(0, ${formatSplitFraction(fraction)}fr)`)
      .join(" ")
  );
}

function clearSplitGridStyles() {
  splitLayout = undefined;
  elements.terminalStack.style.removeProperty("--split-columns");
  elements.terminalStack.style.removeProperty("--split-rows");
  elements.splitResizeLayer.innerHTML = "";
  for (const tab of tabs) {
    tab.element.style.gridColumn = "";
    tab.element.style.gridRow = "";
  }

  if (tabs.length < 2) {
    splitLayoutKey = "";
    splitColumnFractions = [];
    splitRowFractions = [];
  }
}

function renderSplitLayout() {
  if (!isSplitView) {
    clearSplitGridStyles();
    return;
  }

  const layout = createSplitLayout();
  if (!layout) {
    clearSplitGridStyles();
    return;
  }

  splitLayout = layout;
  ensureSplitFractions(layout);
  applySplitGridStyles(layout);

  for (const tab of tabs) {
    const cell = layout.cells.get(tab.id);
    if (!cell) {
      tab.element.style.gridColumn = "";
      tab.element.style.gridRow = "";
      continue;
    }

    tab.element.style.gridColumn = `${cell.column + 1} / span ${cell.columnSpan}`;
    tab.element.style.gridRow = `${cell.row + 1} / span ${cell.rowSpan}`;
  }

  window.requestAnimationFrame(renderSplitResizeHandles);
}

function syncToolbarState() {
  const activeTab = getActiveTab();
  const hasTab = Boolean(activeTab);
  const hasSession = Boolean(activeTab?.sessionId);
  const isConnected = activeTab?.status === "connected" && hasSession;

  elements.disconnectTab.disabled = !hasSession;
  elements.reconnectTab.disabled = !hasTab;
  elements.duplicateTab.disabled = !hasTab;
  elements.splitTerminal.disabled = tabs.length < 2;
  elements.splitTerminal.setAttribute("aria-pressed", String(isSplitView));
  elements.splitTerminal.title = isSplitView ? "关闭分屏终端" : "打开分屏终端";
  elements.openTerminalSearch.disabled = !hasTab;
  elements.openSftp.disabled = !isConnected;
  elements.openTunnels.disabled = !isConnected;
}

function renderTabs() {
  if (tabs.length < 2) {
    isSplitView = false;
  }

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
  elements.terminalStack.classList.toggle("split-mode", isSplitView);
  renderSplitLayout();
  tabs.forEach((tab) => {
    const isActive = tab.id === activeTabId;
    tab.element.classList.toggle("active", isActive);
    tab.element.dataset.title = tab.title;
    const titleElement = tab.element.querySelector<HTMLElement>(".terminal-pane-title");
    if (titleElement) {
      titleElement.textContent = tab.title;
    }
  });
  refreshIcons();
  syncToolbarState();
  if (elements.terminalLogDialog.open) {
    renderTerminalLogs();
  }
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
        <div class="file-row ${selectedPaths.has(entry.path) ? "selected" : ""}" role="button" tabindex="0" draggable="true" data-side="${side}" data-path="${escapeHtml(entry.path)}">
          <span class="file-name">
            <i data-lucide="${fileIcon(entry.kind)}"></i>
            <span>${escapeHtml(entry.name)}</span>
          </span>
          <span class="file-size">${formatBytes(entry.size, entry.kind)}</span>
          <span class="file-date">${formatDate(entry.modifiedAt)}</span>
          <span class="file-actions">
            ${
              side === "remote"
                ? `<button class="file-inline-action" type="button" data-action="chmod" title="修改权限">
                    <i data-lucide="shield-check"></i>
                  </button>`
                : ""
            }
            ${
              side === "remote" && entry.kind === "file"
                ? `<button class="file-inline-action" type="button" data-action="preview" title="预览远端文件">
                    <i data-lucide="eye"></i>
                  </button>
                  <button class="file-inline-action" type="button" data-action="edit" title="编辑远端文件">
                    <i data-lucide="file-pen-line"></i>
                  </button>`
                : ""
            }
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

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function decodeAutomationEscapes(value: string) {
  return value
    .replace(/\\\\/g, "\u0000")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\u0000/g, "\\");
}

function appendEnter(value: string) {
  return /[\r\n]$/.test(value) ? value : `${value}\r`;
}

function expandAutomationVariables(value: string, profile: SshProfile) {
  const variables: Record<string, string> = {
    PASSWORD: profile.password ?? "",
    USERNAME: profile.username,
    HOST: profile.host,
    PORT: String(profile.port),
    PROFILE_NAME: profile.name
  };
  return value.replace(/\$\{([A-Z_]+)\}/g, (_match, name: string) => variables[name] ?? "");
}

function loginScriptCommands(profile: SshProfile) {
  return (profile.loginScript ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function runLoginScript(tab: TerminalTab) {
  if (!tab.sessionId || tab.status !== "connected") {
    return;
  }

  const commands = loginScriptCommands(tab.profile);
  if (commands.length === 0 || tab.loginScriptSessionId === tab.sessionId) {
    return;
  }

  const sessionId = tab.sessionId;
  tab.loginScriptSessionId = sessionId;
  await delay(250);
  for (const command of commands) {
    if (tab.sessionId !== sessionId || tab.status !== "connected") {
      return;
    }
    window.xshellBridge.sendData({
      sessionId,
      data: appendEnter(
        decodeAutomationEscapes(expandAutomationVariables(command, tab.profile))
      )
    });
    await delay(140);
  }
}

interface ParsedTriggerRule {
  id: string;
  label: string;
  response: string;
  regex?: RegExp;
}

function regexFromTriggerPattern(pattern: string) {
  const match = /^\/(.+)\/([dgimsuvy]*)$/.exec(pattern);
  if (!match) {
    return undefined;
  }
  const flags = [...new Set(match[2].replace(/g/g, "").split(""))].join("");
  try {
    return new RegExp(match[1], flags);
  } catch {
    return undefined;
  }
}

function parseTriggerRules(rawRules: string | undefined): ParsedTriggerRule[] {
  return (rawRules ?? "")
    .split(/\r?\n/)
    .map((rawLine, index): ParsedTriggerRule | undefined => {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        return undefined;
      }

      const separatorIndex = line.includes("=>") ? line.indexOf("=>") : line.indexOf("->");
      const separatorLength = line.includes("=>") ? 2 : line.includes("->") ? 2 : 0;
      if (separatorIndex <= 0 || separatorLength === 0) {
        return undefined;
      }

      const pattern = line.slice(0, separatorIndex).trim();
      const response = line.slice(separatorIndex + separatorLength).trim();
      if (!pattern || !response) {
        return undefined;
      }

      return {
        id: `${index}:${pattern}`,
        label: pattern,
        response,
        regex: regexFromTriggerPattern(pattern)
      };
    })
    .filter((rule): rule is ParsedTriggerRule => Boolean(rule));
}

function resetTriggerStateForSession(tab: TerminalTab) {
  if (tab.triggerSessionId === tab.sessionId) {
    return;
  }
  tab.triggerSessionId = tab.sessionId;
  tab.triggerBuffer = "";
  tab.firedTriggerRules = new Set();
}

function triggerMatches(rule: ParsedTriggerRule, buffer: string) {
  if (rule.regex) {
    rule.regex.lastIndex = 0;
    return rule.regex.test(buffer);
  }
  return buffer.includes(rule.label);
}

function handleLoginTriggers(tab: TerminalTab, data: string) {
  if (!tab.sessionId || tab.status !== "connected") {
    return;
  }

  const rules = parseTriggerRules(tab.profile.triggerRules);
  if (rules.length === 0) {
    return;
  }

  resetTriggerStateForSession(tab);
  tab.triggerBuffer = `${tab.triggerBuffer}${data}`.slice(-8192);

  for (const rule of rules) {
    if (tab.firedTriggerRules.has(rule.id) || !triggerMatches(rule, tab.triggerBuffer)) {
      continue;
    }

    tab.firedTriggerRules.add(rule.id);
    window.xshellBridge.sendData({
      sessionId: tab.sessionId,
      data: appendEnter(
        decodeAutomationEscapes(expandAutomationVariables(rule.response, tab.profile))
      )
    });
  }
}

function visibleTerminalTabs() {
  if (isSplitView) {
    return tabs;
  }

  const activeTab = getActiveTab();
  return activeTab ? [activeTab] : [];
}

function activateTab(tabId: string) {
  if (!tabs.some((tab) => tab.id === tabId)) {
    return;
  }

  const previousTab = getActiveTab();
  const changed = previousTab?.id !== tabId;
  if (changed && isTerminalSearchOpen) {
    previousTab?.searchAddon.clearDecorations();
  }

  activeTabId = tabId;
  renderTabs();
  getActiveTab()?.terminal.focus();

  if (changed && isTerminalSearchOpen) {
    searchActiveTerminal("next", true, true);
  }
}

function parsePixel(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function distributeTrackSizes(fractions: number[], size: number, gap: number) {
  const availableSize = Math.max(0, size - Math.max(0, fractions.length - 1) * gap);
  const totalFraction = fractions.reduce((sum, fraction) => sum + Math.max(0.1, fraction), 0);
  return fractions.map((fraction) => (availableSize * Math.max(0.1, fraction)) / totalFraction);
}

function calculateTrackBounds(sizes: number[], start: number, gap: number) {
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = start;
  for (const size of sizes) {
    starts.push(offset);
    ends.push(offset + size);
    offset += size + gap;
  }
  return { starts, ends };
}

function getSplitMetrics(layout: SplitLayout): SplitMetrics {
  const style = window.getComputedStyle(elements.terminalStack);
  const paddingLeft = parsePixel(style.paddingLeft);
  const paddingRight = parsePixel(style.paddingRight);
  const paddingTop = parsePixel(style.paddingTop);
  const paddingBottom = parsePixel(style.paddingBottom);
  const columnGap = parsePixel(style.columnGap);
  const rowGap = parsePixel(style.rowGap);
  const contentWidth = Math.max(0, elements.terminalStack.clientWidth - paddingLeft - paddingRight);
  const contentHeight = Math.max(0, elements.terminalStack.clientHeight - paddingTop - paddingBottom);
  const columnSizes = distributeTrackSizes(
    splitColumnFractions.slice(0, layout.columnCount),
    contentWidth,
    columnGap
  );
  const rowSizes = distributeTrackSizes(
    splitRowFractions.slice(0, layout.rowCount),
    contentHeight,
    rowGap
  );
  const columnBounds = calculateTrackBounds(columnSizes, paddingLeft, columnGap);
  const rowBounds = calculateTrackBounds(rowSizes, paddingTop, rowGap);

  return {
    columnGap,
    rowGap,
    columnSizes,
    rowSizes,
    columnStarts: columnBounds.starts,
    columnEnds: columnBounds.ends,
    rowStarts: rowBounds.starts,
    rowEnds: rowBounds.ends
  };
}

function splitHandlePositionStyle(divider: SplitDivider, metrics: SplitMetrics) {
  if (divider.direction === "column") {
    const x = metrics.columnEnds[divider.index] + metrics.columnGap / 2;
    const top = metrics.rowStarts[divider.rowStart] ?? 0;
    const bottom = metrics.rowEnds[divider.rowEnd - 1] ?? top;
    return [
      `left:${Math.round(x - SPLIT_RESIZE_HANDLE_SIZE / 2)}px`,
      `top:${Math.round(top)}px`,
      `width:${SPLIT_RESIZE_HANDLE_SIZE}px`,
      `height:${Math.max(0, Math.round(bottom - top))}px`
    ].join(";");
  }

  const y = metrics.rowEnds[divider.index] + metrics.rowGap / 2;
  const left = metrics.columnStarts[divider.columnStart] ?? 0;
  const right = metrics.columnEnds[divider.columnEnd - 1] ?? left;
  return [
    `left:${Math.round(left)}px`,
    `top:${Math.round(y - SPLIT_RESIZE_HANDLE_SIZE / 2)}px`,
    `width:${Math.max(0, Math.round(right - left))}px`,
    `height:${SPLIT_RESIZE_HANDLE_SIZE}px`
  ].join(";");
}

function renderSplitResizeHandles() {
  if (!isSplitView || !splitLayout) {
    elements.splitResizeLayer.innerHTML = "";
    return;
  }

  const metrics = getSplitMetrics(splitLayout);
  elements.splitResizeLayer.innerHTML = splitLayout.dividers
    .map((divider) => {
      const orientation = divider.direction === "column" ? "vertical" : "horizontal";
      return `
        <div
          class="split-resize-handle ${orientation}"
          data-direction="${divider.direction}"
          data-index="${divider.index}"
          style="${splitHandlePositionStyle(divider, metrics)}"
          title="拖动调整分屏比例，双击重置"
        ></div>
      `;
    })
    .join("");
}

function resizeTrackPair(
  trackSizes: number[],
  index: number,
  delta: number,
  minTrackSize: number
) {
  const nextSizes = [...trackSizes];
  if (index < 0 || index + 1 >= nextSizes.length) {
    return nextSizes;
  }

  const pairSize = nextSizes[index] + nextSizes[index + 1];
  const minimum = Math.min(minTrackSize, pairSize / 2 - 1);
  if (!Number.isFinite(minimum) || minimum <= 0) {
    return nextSizes;
  }

  const firstSize = clampNumber(nextSizes[index] + delta, minimum, pairSize - minimum);
  nextSizes[index] = firstSize;
  nextSizes[index + 1] = pairSize - firstSize;
  return nextSizes;
}

function scheduleSplitResizeRender() {
  if (splitResizeFrame !== undefined) {
    return;
  }

  splitResizeFrame = window.requestAnimationFrame(() => {
    splitResizeFrame = undefined;
    if (splitLayout) {
      applySplitGridStyles(splitLayout);
      renderSplitResizeHandles();
    }
    fitActiveTerminal();
  });
}

function startSplitResize(event: PointerEvent) {
  const handle = (event.target as HTMLElement).closest<HTMLElement>(".split-resize-handle");
  if (!handle || !splitLayout) {
    return;
  }

  const direction = handle.dataset.direction as SplitResizeDirection | undefined;
  const index = Number(handle.dataset.index);
  if ((direction !== "column" && direction !== "row") || !Number.isInteger(index)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  const metrics = getSplitMetrics(splitLayout);
  splitResizeState = {
    direction,
    index,
    startX: event.clientX,
    startY: event.clientY,
    startColumns: metrics.columnSizes,
    startRows: metrics.rowSizes
  };

  document.body.classList.add("split-resizing");
  document.body.classList.toggle("split-resizing-column", direction === "column");
  document.body.classList.toggle("split-resizing-row", direction === "row");
  window.addEventListener("pointermove", handleSplitResizeMove);
  window.addEventListener("pointerup", stopSplitResize);
  window.addEventListener("pointercancel", stopSplitResize);
}

function handleSplitResizeMove(event: PointerEvent) {
  if (!splitResizeState) {
    return;
  }

  if (splitResizeState.direction === "column") {
    splitColumnFractions = resizeTrackPair(
      splitResizeState.startColumns,
      splitResizeState.index,
      event.clientX - splitResizeState.startX,
      SPLIT_MIN_COLUMN_SIZE
    );
  } else {
    splitRowFractions = resizeTrackPair(
      splitResizeState.startRows,
      splitResizeState.index,
      event.clientY - splitResizeState.startY,
      SPLIT_MIN_ROW_SIZE
    );
  }

  scheduleSplitResizeRender();
}

function stopSplitResize() {
  splitResizeState = undefined;
  document.body.classList.remove("split-resizing", "split-resizing-column", "split-resizing-row");
  window.removeEventListener("pointermove", handleSplitResizeMove);
  window.removeEventListener("pointerup", stopSplitResize);
  window.removeEventListener("pointercancel", stopSplitResize);
  renderSplitResizeHandles();
  fitActiveTerminal();
}

function handleSplitResizeDoubleClick(event: MouseEvent) {
  const handle = (event.target as HTMLElement).closest(".split-resize-handle");
  if (!handle) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  resetSplitLayout();
}

function resetSplitLayout(showToastMessage = true) {
  const layout = createSplitLayout();
  if (!isSplitView || !layout) {
    if (showToastMessage) {
      showToast("分屏未开启");
    }
    return;
  }

  splitLayout = layout;
  ensureSplitFractions(layout, true);
  renderTabs();
  getActiveTab()?.terminal.focus();
  if (showToastMessage) {
    showToast("分屏比例已重置");
  }
}

function handleTerminalStackGeometryChange() {
  renderSplitResizeHandles();
  fitActiveTerminal();
}

function quickCommandPreview(command: string) {
  return command.trim().split(/\r?\n/)[0] || "空命令";
}

function sortedQuickCommands() {
  return [...quickCommands].sort((left, right) => {
    const leftGroup = left.group?.trim() || "默认";
    const rightGroup = right.group?.trim() || "默认";
    const groupCompare = leftGroup.localeCompare(rightGroup, "zh-CN", {
      sensitivity: "base",
      numeric: true
    });
    return groupCompare || left.name.localeCompare(right.name, "zh-CN", {
      sensitivity: "base",
      numeric: true
    });
  });
}

function fillQuickCommandForm(command?: QuickCommand) {
  elements.quickCommandName.value = command?.name ?? "";
  elements.quickCommandGroup.value = command?.group ?? "";
  elements.quickCommandBody.value = command?.command ?? "";
  elements.quickCommandDelete.disabled = !command;
}

function renderQuickCommands() {
  elements.quickCommandSummary.textContent = `${quickCommands.length} 项命令片段`;

  if (quickCommands.length === 0) {
    elements.quickCommandList.innerHTML = `
      <div class="quick-command-empty">
        <i data-lucide="terminal"></i>
        <span>暂无命令片段</span>
      </div>
    `;
    elements.quickCommandDelete.disabled = true;
    refreshIcons();
    return;
  }

  const groups = new Map<string, QuickCommand[]>();
  for (const command of sortedQuickCommands()) {
    const groupName = command.group?.trim() || "默认";
    groups.set(groupName, [...(groups.get(groupName) ?? []), command]);
  }

  elements.quickCommandList.innerHTML = [...groups.entries()]
    .map(([groupName, commands]) => {
      const rows = commands
        .map(
          (command) => `
            <button class="quick-command-row ${command.id === activeQuickCommandId ? "active" : ""}" type="button" data-command-id="${escapeHtml(command.id)}">
              <strong>${escapeHtml(command.name)}</strong>
              <span>${escapeHtml(quickCommandPreview(command.command))}</span>
            </button>
          `
        )
        .join("");

      return `
        <section class="quick-command-group">
          <div class="quick-command-group-title">
            <span>${escapeHtml(groupName)}</span>
            <small>${commands.length}</small>
          </div>
          ${rows}
        </section>
      `;
    })
    .join("");
  refreshIcons();
}

function selectQuickCommand(commandId: string) {
  const command = quickCommands.find((item) => item.id === commandId);
  if (!command) {
    return;
  }

  activeQuickCommandId = command.id;
  fillQuickCommandForm(command);
  renderQuickCommands();
}

function newQuickCommand() {
  activeQuickCommandId = undefined;
  fillQuickCommandForm();
  renderQuickCommands();
  elements.quickCommandName.focus();
}

function saveQuickCommandFromForm() {
  const name = elements.quickCommandName.value.trim();
  const group = elements.quickCommandGroup.value.trim();
  const command = elements.quickCommandBody.value.trimEnd();

  if (!name) {
    showToast("请输入命令名称");
    elements.quickCommandName.focus();
    return;
  }
  if (!command.trim()) {
    showToast("请输入命令内容");
    elements.quickCommandBody.focus();
    return;
  }

  const existing = quickCommands.find((item) => item.id === activeQuickCommandId);
  if (existing) {
    quickCommands = quickCommands.map((item) =>
      item.id === existing.id
        ? {
            ...item,
            name,
            group: group || undefined,
            command
          }
        : item
    );
    activeQuickCommandId = existing.id;
  } else {
    const saved: QuickCommand = {
      id: createId(),
      name,
      group: group || undefined,
      command
    };
    quickCommands = [...quickCommands, saved];
    activeQuickCommandId = saved.id;
  }

  saveQuickCommands();
  renderQuickCommands();
  fillQuickCommandForm(quickCommands.find((item) => item.id === activeQuickCommandId));
  showToast("命令片段已保存");
}

function deleteActiveQuickCommand() {
  const existing = quickCommands.find((item) => item.id === activeQuickCommandId);
  if (!existing) {
    newQuickCommand();
    return;
  }
  if (!window.confirm(`删除命令片段「${existing.name}」？`)) {
    return;
  }

  const remaining = quickCommands.filter((item) => item.id !== existing.id);
  quickCommands = remaining;
  activeQuickCommandId = remaining[0]?.id;
  saveQuickCommands();
  fillQuickCommandForm(remaining[0]);
  renderQuickCommands();
  showToast("命令片段已删除");
}

function sendQuickCommand() {
  const rawCommand = elements.quickCommandBody.value;
  if (!rawCommand.trim()) {
    showToast("请输入命令内容");
    elements.quickCommandBody.focus();
    return;
  }

  const activeTab = getConnectedActiveTab();
  if (!activeTab?.sessionId) {
    showToast("请先连接一个 SSH 会话");
    return;
  }

  const data = rawCommand.endsWith("\n") || rawCommand.endsWith("\r")
    ? rawCommand
    : `${rawCommand}\r`;
  window.xshellBridge.sendData({
    sessionId: activeTab.sessionId,
    data
  });
  activeTab.terminal.focus();
  showToast("命令已发送");
}

function openQuickCommands() {
  if (!activeQuickCommandId && quickCommands.length > 0) {
    activeQuickCommandId = sortedQuickCommands()[0]?.id;
  }

  fillQuickCommandForm(quickCommands.find((item) => item.id === activeQuickCommandId));
  renderQuickCommands();
  if (!elements.quickCommandDialog.open) {
    elements.quickCommandDialog.showModal();
  }
  if (activeQuickCommandId) {
    elements.quickCommandBody.focus();
  } else {
    elements.quickCommandName.focus();
  }
  refreshIcons();
}

function formatKnownHostDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function renderKnownHosts() {
  elements.knownHostSummary.textContent = `${knownHostEntries.length} 项已信任主机`;
  elements.knownHostClear.disabled = knownHostEntries.length === 0;

  if (knownHostEntries.length === 0) {
    elements.knownHostList.innerHTML = `
      <div class="known-host-empty">
        <i data-lucide="key-round"></i>
        <span>暂无已信任主机</span>
      </div>
    `;
    refreshIcons();
    return;
  }

  elements.knownHostList.innerHTML = knownHostEntries
    .map(
      (entry) => `
        <article class="known-host-row" data-known-host-id="${escapeHtml(entry.id)}">
          <div class="known-host-icon">
            <i data-lucide="key-round"></i>
          </div>
          <div class="known-host-main">
            <strong>${escapeHtml(entry.host)}:${entry.port}</strong>
            <span>${escapeHtml(entry.keyAlgorithm)} · ${escapeHtml(entry.fingerprint)}</span>
            <small>首次信任 ${formatKnownHostDate(entry.firstSeenAt)} · 最近确认 ${formatKnownHostDate(entry.lastSeenAt)}</small>
          </div>
          <button class="icon-button danger" type="button" data-action="delete-known-host" title="删除主机密钥">
            <i data-lucide="trash-2"></i>
          </button>
        </article>
      `
    )
    .join("");
  refreshIcons();
}

async function refreshKnownHosts() {
  elements.knownHostList.innerHTML = `
    <div class="known-host-empty">
      <i data-lucide="loader-circle"></i>
      <span>正在读取主机密钥</span>
    </div>
  `;
  refreshIcons();

  try {
    const response = await window.xshellBridge.knownHostsList();
    knownHostEntries = response.entries;
    renderKnownHosts();
  } catch (error) {
    showToast(`读取主机密钥失败：${getErrorMessage(error)}`);
    renderKnownHosts();
  }
}

async function openKnownHosts() {
  if (!elements.knownHostDialog.open) {
    elements.knownHostDialog.showModal();
  }
  await refreshKnownHosts();
}

async function deleteKnownHost(id: string) {
  const entry = knownHostEntries.find((item) => item.id === id);
  if (!entry) {
    return;
  }
  if (!window.confirm(`删除 ${entry.host}:${entry.port} 的主机密钥记录？`)) {
    return;
  }

  try {
    await window.xshellBridge.knownHostsDelete({ id });
    await refreshKnownHosts();
    showToast("主机密钥记录已删除");
  } catch (error) {
    showToast(`删除主机密钥失败：${getErrorMessage(error)}`);
  }
}

async function clearKnownHosts() {
  if (knownHostEntries.length === 0) {
    return;
  }
  if (!window.confirm(`清空全部 ${knownHostEntries.length} 项主机密钥记录？`)) {
    return;
  }

  try {
    await window.xshellBridge.knownHostsClear();
    knownHostEntries = [];
    renderKnownHosts();
    showToast("主机密钥记录已清空");
  } catch (error) {
    showToast(`清空主机密钥失败：${getErrorMessage(error)}`);
  }
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
    decorations: getThemeConfig().searchDecorations
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
  const visibleTabs = visibleTerminalTabs();
  if (visibleTabs.length === 0) {
    return;
  }

  window.requestAnimationFrame(() => {
    for (const tab of visibleTabs) {
      tab.fitAddon.fit();
      if (!tab.sessionId) {
        continue;
      }
      window.xshellBridge.resize({
        sessionId: tab.sessionId,
        cols: tab.terminal.cols,
        rows: tab.terminal.rows
      });
    }
  });
}

function buildTerminal(profile: SshProfile): TerminalTab {
  const tabId = createId();
  const element = document.createElement("div");
  element.className = "terminal-pane";
  element.dataset.tabId = tabId;
  element.dataset.title = profile.name || profile.host;
  const head = document.createElement("div");
  head.className = "terminal-pane-head";
  const title = document.createElement("span");
  title.className = "terminal-pane-title";
  title.textContent = profile.name || profile.host;
  head.appendChild(title);
  const surface = document.createElement("div");
  surface.className = "terminal-surface";
  element.append(head, surface);
  elements.terminalStack.appendChild(element);

  const terminal = new Terminal({
    cursorBlink: preferences.cursorBlink,
    fontFamily: "Consolas, 'Cascadia Mono', 'Microsoft YaHei UI', monospace",
    fontSize: preferences.fontSize,
    lineHeight: 1.12,
    letterSpacing: 0,
    scrollback: 10000,
    theme: getThemeConfig().terminal,
    allowProposedApi: true,
    convertEol: true
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon({ highlightLimit: 2000 });
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());
  terminal.loadAddon(searchAddon);
  terminal.open(surface);

  const tab: TerminalTab = {
    id: tabId,
    title: profile.name || profile.host,
    profile,
    terminal,
    fitAddon,
    searchAddon,
    element,
    reconnectAttempts: 0,
    triggerBuffer: "",
    firedTriggerRules: new Set(),
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
  let proxyProfile: SshProfile | undefined;
  try {
    const resolved = await resolveConnectProfiles(profile);
    connectionProfile = resolved.profile;
    proxyProfile = resolved.proxyProfile;
  } catch (error) {
    showToast(getErrorMessage(error));
    connectionProfile = profile;
  }

  const validationError = validateConnectProfile(connectionProfile, proxyProfile);
  if (validationError) {
    showToast(validationError);
    openConnectionDialog(profile, { quick: true });
    return;
  }

  const tab = buildTerminal(connectionProfile);
  tabs.push(tab);
  activeTabId = tab.id;
  renderTabs();
  await connectTab(tab, connectionProfile, proxyProfile);
}

async function connectTab(tab: TerminalTab, profile: SshProfile, proxyProfile?: SshProfile) {
  window.clearTimeout(tab.reconnectTimer);
  tab.reconnectTimer = undefined;
  tab.manualDisconnect = false;
  tab.profile = profile;
  tab.status = "connecting";
  tab.sessionId = undefined;
  tab.logFilePath = undefined;
  tab.autoStartedSessionId = undefined;
  tab.loginScriptSessionId = undefined;
  tab.triggerSessionId = undefined;
  tab.triggerBuffer = "";
  tab.firedTriggerRules = new Set();
  renderTabs();

  tab.terminal.writeln(`\x1b[36m连接 ${profile.username}@${profile.host}:${profile.port} ...\x1b[0m`);

  try {
    const response = await window.xshellBridge.connect({
      profile,
      proxyProfile,
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
    scheduleAutoReconnect(tab, getErrorMessage(error));
  }
}

async function startTerminalLogging(tab: TerminalTab) {
  if (!preferences.terminalLogging || !tab.sessionId || tab.logFilePath) {
    return;
  }

  try {
    const response = await window.xshellBridge.terminalLogStart({
      sessionId: tab.sessionId,
      profileName: tab.profile.name,
      host: tab.profile.host,
      username: tab.profile.username,
      directoryPath: preferences.logDirectory.trim() || undefined
    });
    tab.logFilePath = response.filePath;
    tab.terminal.writeln(`\r\n\x1b[36m终端日志：${response.filePath}\x1b[0m`);
    if (elements.terminalLogDialog.open) {
      void refreshTerminalLogs({ quiet: true });
    }
  } catch (error) {
    showToast(`开启终端日志失败：${getErrorMessage(error)}`);
  }
}

function clearTerminalLogging(tab: TerminalTab) {
  tab.logFilePath = undefined;
}

async function stopTerminalLogging(tab: TerminalTab) {
  if (!tab.sessionId || !tab.logFilePath) {
    return;
  }

  try {
    await window.xshellBridge.terminalLogStop({ sessionId: tab.sessionId });
  } catch (error) {
    showToast(`停止终端日志失败：${getErrorMessage(error)}`);
  } finally {
    clearTerminalLogging(tab);
    if (elements.terminalLogDialog.open) {
      renderTerminalLogs();
    }
  }
}

function getConfiguredLogDirectory() {
  return preferences.logDirectory.trim() || undefined;
}

async function fillDefaultLogDirectoryPlaceholder() {
  try {
    const directoryPath = await window.xshellBridge.terminalLogDefaultDirectory();
    elements.prefLogDirectory.placeholder = `默认：${directoryPath}`;
    if (!elements.prefLogDirectory.value.trim()) {
      elements.prefLogDirectory.title = directoryPath;
    }
  } catch {
    elements.prefLogDirectory.placeholder = "使用默认日志目录";
  }
}

async function chooseLogDirectory() {
  try {
    const result = await window.xshellBridge.terminalLogSelectDirectory({
      directoryPath: elements.prefLogDirectory.value.trim() || getConfiguredLogDirectory()
    });
    if (!result.canceled && result.directoryPath) {
      elements.prefLogDirectory.value = result.directoryPath;
      elements.prefLogDirectory.title = result.directoryPath;
    }
  } catch (error) {
    showToast(`选择日志目录失败：${getErrorMessage(error)}`);
  }
}

async function openConfiguredLogDirectory() {
  try {
    await window.xshellBridge.terminalLogOpenDirectory({
      directoryPath: elements.prefLogDirectory.value.trim() || getConfiguredLogDirectory()
    });
  } catch (error) {
    showToast(`打开日志目录失败：${getErrorMessage(error)}`);
  }
}

function renderTerminalLogs() {
  elements.terminalLogSummary.textContent = `${terminalLogEntries.length} 个日志文件`;
  elements.terminalLogOpenCurrent.disabled = !getActiveTab()?.logFilePath;

  if (terminalLogEntries.length === 0) {
    elements.terminalLogList.innerHTML = `
      <div class="terminal-log-empty">
        <i data-lucide="file-clock"></i>
        <span>暂无终端日志</span>
      </div>
    `;
    refreshIcons();
    return;
  }

  const activeLogPath = getActiveTab()?.logFilePath;
  elements.terminalLogList.innerHTML = terminalLogEntries
    .map((entry) => {
      const isActive = activeLogPath === entry.filePath;
      return `
        <article class="terminal-log-row ${isActive ? "active" : ""}" data-log-path="${escapeHtml(entry.filePath)}">
          <div class="terminal-log-icon">
            <i data-lucide="${isActive ? "file-check-2" : "scroll-text"}"></i>
          </div>
          <div class="terminal-log-main">
            <strong>${escapeHtml(entry.name)}</strong>
            <span>${escapeHtml(entry.filePath)}</span>
            <small>${formatDate(entry.modifiedAt)} · ${formatBytes(entry.size)}</small>
          </div>
          <div class="terminal-log-actions">
            <button class="icon-button" type="button" data-action="open-log" title="打开日志">
              <i data-lucide="external-link"></i>
            </button>
            <button class="icon-button" type="button" data-action="show-log" title="定位文件">
              <i data-lucide="folder-search"></i>
            </button>
          </div>
        </article>
      `;
    })
    .join("");
  refreshIcons();
}

async function refreshTerminalLogs(options: { quiet?: boolean } = {}) {
  elements.terminalLogSummary.textContent = "读取中...";
  try {
    const response = await window.xshellBridge.terminalLogList({
      directoryPath: getConfiguredLogDirectory()
    });
    terminalLogEntries = response.entries;
    elements.terminalLogDirectory.textContent = response.directoryPath;
    elements.terminalLogDirectory.title = response.directoryPath;
    renderTerminalLogs();
  } catch (error) {
    terminalLogEntries = [];
    renderTerminalLogs();
    if (!options.quiet) {
      showToast(`读取日志失败：${getErrorMessage(error)}`);
    }
  }
}

async function openTerminalLogs() {
  if (!elements.terminalLogDialog.open) {
    elements.terminalLogDialog.showModal();
  }
  await refreshTerminalLogs();
}

async function openTerminalLogFile(filePath?: string) {
  if (!filePath) {
    showToast("没有可打开的日志文件");
    return;
  }

  try {
    await window.xshellBridge.terminalLogOpenFile({ filePath });
  } catch (error) {
    showToast(`打开日志失败：${getErrorMessage(error)}`);
  }
}

async function showTerminalLogFile(filePath?: string) {
  if (!filePath) {
    showToast("没有可定位的日志文件");
    return;
  }

  try {
    await window.xshellBridge.terminalLogShowFile({ filePath });
  } catch (error) {
    showToast(`定位日志失败：${getErrorMessage(error)}`);
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function openConnectionDialog(profile?: SshProfile, options?: { quick?: boolean }) {
  editingProfileId = profile?.id;
  elements.dialogTitle.textContent = profile ? "编辑连接配置" : options?.quick ? "快速连接" : "新建连接配置";
  elements.dialogSubtitle.textContent = profile?.host ? `${profile.username}@${profile.host}` : "SSH";
  const normalizedProfile = profile ? normalizeProfile(profile) : undefined;

  elements.profileName.value = normalizedProfile?.name ?? "";
  elements.profileGroup.value = normalizedProfile?.group ?? "";
  elements.profileHost.value = normalizedProfile?.host ?? "";
  elements.profilePort.value = String(normalizedProfile?.port ?? 22);
  elements.profileUsername.value = normalizedProfile?.username ?? "";
  elements.profilePassword.value = "";
  elements.profilePassword.placeholder =
    normalizedProfile?.authMethod === "password" && normalizedProfile.rememberPassword
      ? "已保存密码，留空则继续使用"
      : "";
  elements.profileRemember.checked = Boolean(normalizedProfile?.rememberPassword);
  elements.profileKeyPath.value = normalizedProfile?.privateKeyPath ?? "";
  elements.profilePassphrase.value = normalizedProfile?.passphrase ?? "";
  elements.profileProxyType.value = normalizedProfile?.proxy?.type ?? "none";
  elements.profileProxyHost.value =
    normalizedProfile?.proxy?.type === "socks5" || normalizedProfile?.proxy?.type === "http"
      ? normalizedProfile.proxy.host ?? ""
      : "";
  elements.profileProxyPort.value =
    normalizedProfile?.proxy?.type === "socks5" || normalizedProfile?.proxy?.type === "http"
      ? String(normalizedProfile.proxy.port ?? (normalizedProfile.proxy.type === "socks5" ? 1080 : 8080))
      : "1080";
  elements.profileKeepaliveInterval.value = String(normalizedProfile?.keepaliveInterval ?? 15);
  elements.profileAutoReconnect.checked = Boolean(normalizedProfile?.autoReconnect);
  elements.profileReconnectLimit.value = String(normalizedProfile?.reconnectLimit ?? 3);
  elements.profileLoginScript.value = normalizedProfile?.loginScript ?? "";
  elements.profileTriggerRules.value = normalizedProfile?.triggerRules ?? "";
  elements.profileSave.checked = !options?.quick;

  const authMethod = normalizedProfile?.authMethod ?? "password";
  const radio = elements.profileForm.querySelector<HTMLInputElement>(
    `input[name="auth-method"][value="${authMethod}"]`
  );
  if (radio) {
    radio.checked = true;
  }
  renderJumpProfileOptions(normalizedProfile?.proxy?.jumpProfileId);
  syncAuthPanels();
  syncConnectionPanels();

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
  const existingProfile = editingProfileId
    ? profiles.find((profile) => profile.id === editingProfileId)
    : undefined;
  const proxyType = elements.profileProxyType.value;
  const keepaliveInterval = normalizeKeepaliveInterval(elements.profileKeepaliveInterval.value);
  const reconnectLimit = normalizeReconnectLimit(elements.profileReconnectLimit.value);
  const proxy =
    proxyType === "jump"
      ? normalizeProxyConfig({
          type: "jump",
          jumpProfileId: elements.profileJumpProfile.value
        })
      : proxyType === "socks5" || proxyType === "http"
        ? normalizeProxyConfig({
            type: proxyType,
            host: elements.profileProxyHost.value,
            port: elements.profileProxyPort.value
          })
        : undefined;

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
    color: existingProfile?.color ?? profileColor(editingProfileId ?? host),
    tunnels: existingProfile?.tunnels ?? [],
    proxy,
    keepaliveInterval,
    autoReconnect: elements.profileAutoReconnect.checked,
    reconnectLimit,
    loginScript: elements.profileLoginScript.value.trim(),
    triggerRules: elements.profileTriggerRules.value.trim()
  };
}

function validateConnectProfile(profile: SshProfile, proxyProfile?: SshProfile) {
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
  if (profile.proxy?.type === "jump") {
    if (!profile.proxy.jumpProfileId || !proxyProfile) {
      return "请选择跳板连接配置";
    }
    if (proxyProfile.id === profile.id) {
      return "跳板配置不能指向自身";
    }
    const jumpError = validateBasicSshProfile(proxyProfile, "跳板");
    if (jumpError) {
      return jumpError;
    }
  }
  if (profile.proxy?.type === "socks5" || profile.proxy?.type === "http") {
    if (!profile.proxy.host?.trim()) {
      return "请输入代理主机";
    }
    const proxyPort = Number(profile.proxy.port);
    if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
      return "代理端口必须在 1 到 65535 之间";
    }
  }

  return undefined;
}

function validateBasicSshProfile(profile: SshProfile, label = "SSH") {
  if (!profile.host.trim()) {
    return `请输入${label}主机地址`;
  }
  if (!profile.username.trim()) {
    return `请输入${label}用户名`;
  }
  if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) {
    return `${label}端口必须在 1 到 65535 之间`;
  }
  if (profile.authMethod === "password" && !profile.password) {
    return `请输入${label}密码或先保存密码`;
  }
  if (profile.authMethod === "privateKey" && !profile.privateKeyPath) {
    return `请选择${label}私钥文件`;
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

function renderJumpProfileOptions(selectedId?: string) {
  const candidates = profiles.filter((profile) => profile.id !== editingProfileId);
  elements.profileJumpProfile.innerHTML = [
    `<option value="">选择连接配置</option>`,
    ...candidates.map(
      (profile) =>
        `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)} · ${escapeHtml(profile.username)}@${escapeHtml(profile.host)}:${profile.port}</option>`
    )
  ].join("");
  elements.profileJumpProfile.value = selectedId ?? "";
}

function syncConnectionPanels() {
  const proxyType = elements.profileProxyType.value;
  const isJump = proxyType === "jump";
  const isNetworkProxy = proxyType === "socks5" || proxyType === "http";
  elements.profileJumpProfileRow.classList.toggle("hidden", !isJump);
  elements.profileProxyHostRow.classList.toggle("hidden", !isNetworkProxy);
  elements.profileProxyPortRow.classList.toggle("hidden", !isNetworkProxy);
  if (proxyType === "socks5" && !elements.profileProxyPort.value) {
    elements.profileProxyPort.value = "1080";
  }
  if (proxyType === "http" && !elements.profileProxyPort.value) {
    elements.profileProxyPort.value = "8080";
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
    tab.manualDisconnect = true;
    void window.xshellBridge.disconnect(tab.sessionId);
  }
  clearReconnectTimer(tab);

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

function clearReconnectTimer(tab: TerminalTab) {
  window.clearTimeout(tab.reconnectTimer);
  tab.reconnectTimer = undefined;
}

function scheduleAutoReconnect(tab: TerminalTab, reason: string) {
  if (tab.manualDisconnect || !tab.profile.autoReconnect || tab.reconnectTimer) {
    return;
  }

  const limit = normalizeReconnectLimit(tab.profile.reconnectLimit);
  if (tab.reconnectAttempts >= limit) {
    tab.terminal.writeln(`\r\n\x1b[33m自动重连已停止：已达到 ${limit} 次\x1b[0m`);
    return;
  }

  tab.reconnectAttempts += 1;
  const attempt = tab.reconnectAttempts;
  const delay = Math.min(30000, 3000 + (attempt - 1) * 4000);
  tab.terminal.writeln(
    `\r\n\x1b[33m${reason}，${Math.round(delay / 1000)} 秒后自动重连 (${attempt}/${limit})\x1b[0m`
  );
  tab.reconnectTimer = window.setTimeout(() => {
    tab.reconnectTimer = undefined;
    void reconnectTab(tab, { automatic: true });
  }, delay);
}

async function disconnectActiveTab() {
  const activeTab = getActiveTab();
  if (!activeTab) {
    showToast("当前标签未连接");
    return;
  }
  if (!activeTab.sessionId) {
    if (activeTab.reconnectTimer) {
      activeTab.manualDisconnect = true;
      clearReconnectTimer(activeTab);
      showToast("已取消自动重连");
      return;
    }
    showToast("当前标签未连接");
    return;
  }

  activeTab.manualDisconnect = true;
  clearReconnectTimer(activeTab);
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

  await reconnectTab(activeTab);
}

async function reconnectTab(activeTab: TerminalTab, options?: { automatic?: boolean }) {
  if (!options?.automatic) {
    activeTab.reconnectAttempts = 0;
  }
  const { profile, proxyProfile } = await resolveConnectProfiles(activeTab.profile);
  const validationError = validateConnectProfile(profile, proxyProfile);
  if (validationError) {
    showToast(validationError);
    openConnectionDialog(activeTab.profile, { quick: true });
    return;
  }

  if (activeTab.sessionId) {
    try {
      activeTab.manualDisconnect = true;
      clearReconnectTimer(activeTab);
      await window.xshellBridge.disconnect(activeTab.sessionId);
    } catch {
      // The connection may already be gone; continue with reconnect.
    }
    activeTab.sessionId = undefined;
  }

  activeTab.terminal.writeln(
    `\r\n\x1b[36m${options?.automatic ? "自动重连" : "重新连接"} ${profile.username}@${profile.host}:${profile.port} ...\x1b[0m`
  );
  await connectTab(activeTab, profile, proxyProfile);
}

function applyPreferences() {
  applyTheme(preferences.theme);
  for (const tab of tabs) {
    tab.terminal.options.fontSize = preferences.fontSize;
    tab.terminal.options.cursorBlink = preferences.cursorBlink;
    tab.terminal.options.theme = getThemeConfig().terminal;
  }
  fitActiveTerminal();
}

function openPreferences() {
  elements.prefFontSize.value = String(preferences.fontSize);
  elements.prefTheme.value = preferences.theme;
  elements.prefCursorBlink.checked = preferences.cursorBlink;
  elements.prefTerminalLogging.checked = preferences.terminalLogging;
  elements.prefLogDirectory.value = preferences.logDirectory;
  elements.prefLogDirectory.title = preferences.logDirectory;
  void fillDefaultLogDirectoryPlaceholder();
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
  renderTunnelCheckResult(undefined);
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

function renderTunnelCheckResult(response?: TunnelCheckResponse, pendingMessage?: string) {
  elements.tunnelCheckResult.classList.remove("success", "error");
  if (!response) {
    elements.tunnelCheckResult.textContent = pendingMessage ?? "未检查";
    return;
  }

  elements.tunnelCheckResult.classList.add(response.ok ? "success" : "error");
  elements.tunnelCheckResult.innerHTML = `
    <strong>${escapeHtml(response.message)}</strong>
    ${response.checks
      .map((check) => `${escapeHtml(check.label)}：${escapeHtml(check.message)}`)
      .join("<br />")}
  `;
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
          <div class="tunnel-actions">
            <button class="tunnel-stop" type="button" data-action="check-tunnel">检查</button>
            <button class="tunnel-stop danger" type="button" data-action="stop-tunnel">停止</button>
          </div>
        </article>
      `;
    })
    .join("");
  refreshIcons();
}

function getTunnelProfile() {
  return profiles.find((profile) => profile.id === tunnelState.profileId);
}

function savedTunnelRoute(tunnel: SavedTunnelConfig) {
  if (tunnel.type === "dynamic") {
    return `SOCKS5 ${tunnel.localHost}:${tunnel.localPort}`;
  }
  if (tunnel.type === "remote") {
    return `${tunnel.remoteHost}:${tunnel.remotePort} -> ${tunnel.targetHost}:${tunnel.targetPort}`;
  }
  return `${tunnel.localHost}:${tunnel.localPort} -> ${tunnel.targetHost}:${tunnel.targetPort}`;
}

function renderSavedTunnels() {
  const profile = getTunnelProfile();
  const tunnels = profile?.tunnels ?? [];
  elements.savedTunnelSummary.textContent = `${tunnels.length} 项`;

  if (!profile) {
    elements.savedTunnelList.innerHTML = `
      <div class="tunnel-empty">
        <i data-lucide="save-off"></i>
        <span>快速连接不会保存隧道</span>
      </div>
    `;
    refreshIcons();
    return;
  }

  if (tunnels.length === 0) {
    elements.savedTunnelList.innerHTML = `
      <div class="tunnel-empty">
        <i data-lucide="bookmark-x"></i>
        <span>暂无已保存隧道</span>
      </div>
    `;
    refreshIcons();
    return;
  }

  elements.savedTunnelList.innerHTML = tunnels
    .map(
      (tunnel) => `
        <article class="tunnel-row saved" data-saved-tunnel-id="${tunnel.id}">
          <div class="tunnel-icon">
            <i data-lucide="${tunnelIconName(tunnel.type)}"></i>
          </div>
          <div class="tunnel-main">
            <div class="tunnel-title">
              <span>${escapeHtml(tunnel.name)}</span>
              <span class="tunnel-badge">${tunnelTypeText(tunnel.type)}</span>
              <span class="tunnel-badge ${tunnel.autoStart ? "" : "manual"}">${tunnel.autoStart ? "自动" : "手动"}</span>
            </div>
            <div class="tunnel-route">${escapeHtml(savedTunnelRoute(tunnel))}</div>
          </div>
          <div class="tunnel-actions">
            <button class="tunnel-stop" type="button" data-action="check-saved-tunnel">检查</button>
            <button class="tunnel-stop" type="button" data-action="start-saved-tunnel">启动</button>
            <button class="tunnel-stop" type="button" data-action="toggle-saved-tunnel">${tunnel.autoStart ? "手动" : "自动"}</button>
            <button class="tunnel-stop danger" type="button" data-action="delete-saved-tunnel">删除</button>
          </div>
        </article>
      `
    )
    .join("");
  refreshIcons();
}

function updateSavedTunnels(
  profileId: string,
  updater: (tunnels: SavedTunnelConfig[]) => SavedTunnelConfig[]
) {
  profiles = profiles.map((profile) =>
    profile.id === profileId
      ? { ...profile, tunnels: updater(profile.tunnels ?? []) }
      : profile
  );
  tabs = tabs.map((tab) =>
    tab.profile.id === profileId
      ? {
          ...tab,
          profile: {
            ...tab.profile,
            tunnels: profiles.find((profile) => profile.id === profileId)?.tunnels ?? []
          }
        }
      : tab
  );
  saveProfiles();
  renderProfiles();
  renderSavedTunnels();
}

function savedTunnelFromRequest(
  request: TunnelCreateRequest,
  response: TunnelInfo
): SavedTunnelConfig {
  return {
    id: createId(),
    type: request.type,
    name: request.name?.trim() || response.name || tunnelTypeText(request.type),
    autoStart: elements.tunnelAutoStart.checked,
    localHost: request.localHost,
    localPort: request.localPort,
    remoteHost: request.remoteHost,
    remotePort: request.remotePort,
    targetHost: request.targetHost,
    targetPort: request.targetPort
  };
}

function tunnelCreateRequestFromSaved(
  sessionId: string,
  tunnel: SavedTunnelConfig
): TunnelCreateRequest {
  return {
    sessionId,
    type: tunnel.type,
    name: tunnel.name,
    localHost: tunnel.localHost,
    localPort: tunnel.localPort,
    remoteHost: tunnel.remoteHost,
    remotePort: tunnel.remotePort,
    targetHost: tunnel.targetHost,
    targetPort: tunnel.targetPort
  };
}

async function startSavedTunnel(tunnel: SavedTunnelConfig, options: { quiet?: boolean } = {}) {
  if (!tunnelState.sessionId) {
    if (!options.quiet) {
      showToast("当前 SSH 会话不可用");
    }
    return;
  }

  try {
    const response = await window.xshellBridge.tunnelCreate(
      tunnelCreateRequestFromSaved(tunnelState.sessionId, tunnel)
    );
    if (!options.quiet) {
      showToast(`隧道已启动：${response.tunnel.name}`);
    }
    await refreshTunnels();
  } catch (error) {
    const message = `启动隧道失败：${getErrorMessage(error)}`;
    if (!options.quiet) {
      showToast(message);
    }
    throw error;
  }
}

async function autoStartProfileTunnels(tab: TerminalTab) {
  if (!tab.sessionId || tab.autoStartedSessionId === tab.sessionId) {
    return;
  }

  tab.autoStartedSessionId = tab.sessionId;
  const tunnels = tab.profile.tunnels?.filter((tunnel) => tunnel.autoStart) ?? [];
  for (const tunnel of tunnels) {
    try {
      await window.xshellBridge.tunnelCreate(
        tunnelCreateRequestFromSaved(tab.sessionId, tunnel)
      );
      tab.terminal.writeln(`\r\n\x1b[36m已自动启动隧道：${tunnel.name}\x1b[0m`);
    } catch (error) {
      tab.terminal.writeln(
        `\r\n\x1b[31m自动启动隧道失败：${tunnel.name} · ${getErrorMessage(error)}\x1b[0m`
      );
    }
  }

  if (tunnelState.sessionId === tab.sessionId) {
    await refreshTunnels();
  }
}

async function refreshTunnels() {
  if (!tunnelState.sessionId) {
    tunnelState.tunnels = [];
    renderTunnels();
    renderSavedTunnels();
    return;
  }

  try {
    tunnelState.tunnels = await window.xshellBridge.tunnelList({
      sessionId: tunnelState.sessionId
    });
    renderTunnels();
    renderSavedTunnels();
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
  tunnelState.profileId = profiles.some((profile) => profile.id === activeTab.profile.id)
    ? activeTab.profile.id
    : undefined;
  elements.tunnelSubtitle.textContent = `${activeTab.profile.name} · ${activeTab.profile.username}@${activeTab.profile.host}`;
  const canSaveTunnel = Boolean(tunnelState.profileId);
  elements.tunnelSaveProfile.checked = canSaveTunnel;
  elements.tunnelSaveProfile.disabled = !canSaveTunnel;
  elements.tunnelAutoStart.disabled = !canSaveTunnel;
  syncTunnelForm();
  renderTunnelCheckResult(undefined);
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

async function checkTunnelRequest(request: TunnelCheckRequest, label = "隧道") {
  try {
    renderTunnelCheckResult(undefined, `正在检查${label}`);
    const response = await window.xshellBridge.tunnelCheck(request);
    renderTunnelCheckResult(response);
    showToast(response.message);
  } catch (error) {
    const message = getErrorMessage(error);
    renderTunnelCheckResult({
      ok: false,
      message,
      checks: [{ label, status: "error", message }]
    });
    showToast(message);
  }
}

async function checkTunnelFromForm() {
  try {
    await checkTunnelRequest(readTunnelRequest(), "当前配置");
  } catch (error) {
    const message = getErrorMessage(error);
    renderTunnelCheckResult({
      ok: false,
      message,
      checks: [{ label: "当前配置", status: "error", message }]
    });
    showToast(message);
  }
}

async function createTunnelFromForm() {
  try {
    const request = readTunnelRequest();
    const response = await window.xshellBridge.tunnelCreate(request);
    let saved = false;
    if (elements.tunnelSaveProfile.checked && tunnelState.profileId) {
      const savedTunnel = savedTunnelFromRequest(request, response.tunnel);
      updateSavedTunnels(tunnelState.profileId, (tunnels) => [...tunnels, savedTunnel]);
      saved = true;
    }
    showToast(saved ? `隧道已创建并保存：${response.tunnel.name}` : `隧道已创建：${response.tunnel.name}`);
    elements.tunnelName.value = "";
    await refreshTunnels();
  } catch (error) {
    showToast(`创建隧道失败：${getErrorMessage(error)}`);
  }
}

async function checkRunningTunnel(tunnelId: string) {
  if (!tunnelState.sessionId || !tunnelId) {
    return;
  }

  await checkTunnelRequest(
    {
      sessionId: tunnelState.sessionId,
      tunnelId
    },
    "运行中隧道"
  );
}

async function checkSavedTunnel(tunnel: SavedTunnelConfig) {
  if (!tunnelState.sessionId) {
    showToast("当前 SSH 会话不可用");
    return;
  }

  await checkTunnelRequest(
    tunnelCreateRequestFromSaved(tunnelState.sessionId, tunnel),
    "已保存隧道"
  );
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

function renderWindowState(isFullScreen: boolean, isMaximized: boolean) {
  document.body.classList.toggle("window-fullscreen", isFullScreen);
  document.body.classList.toggle("window-maximized", isMaximized);
  elements.exitFullscreen.classList.toggle("hidden", !isFullScreen);
  elements.windowMaximize.title = isMaximized ? "还原" : "最大化";
  elements.windowMaximize.innerHTML = isMaximized
    ? '<i data-lucide="copy"></i>'
    : '<i data-lucide="square"></i>';
  refreshIcons();
}

function blurActiveElement() {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

function clearMenuCloseTimer() {
  window.clearTimeout(menuCloseTimer);
  menuCloseTimer = undefined;
}

function closeTopbarMenus() {
  clearMenuCloseTimer();
  elements.fullscreenMenu
    .querySelectorAll<HTMLElement>(".fullscreen-menu-group")
    .forEach((group) => {
      group.classList.remove("menu-open");
      group
        .querySelector<HTMLButtonElement>(".fullscreen-menu-trigger")
        ?.setAttribute("aria-expanded", "false");
    });
}

function openTopbarMenu(group: HTMLElement) {
  clearMenuCloseTimer();
  elements.fullscreenMenu
    .querySelectorAll<HTMLElement>(".fullscreen-menu-group")
    .forEach((candidate) => {
      const isOpen = candidate === group;
      candidate.classList.toggle("menu-open", isOpen);
      candidate
        .querySelector<HTMLButtonElement>(".fullscreen-menu-trigger")
        ?.setAttribute("aria-expanded", String(isOpen));
    });
}

function scheduleCloseTopbarMenus() {
  clearMenuCloseTimer();
  menuCloseTimer = window.setTimeout(closeTopbarMenus, 180);
}

function closeTerminalContextMenu() {
  elements.terminalContextMenu.classList.add("hidden");
}

function openTerminalContextMenu(clientX: number, clientY: number) {
  const menu = elements.terminalContextMenu;
  menu.classList.remove("hidden");
  menu.style.left = "0px";
  menu.style.top = "0px";

  const bounds = menu.getBoundingClientRect();
  const margin = 6;
  const left = Math.max(
    margin,
    Math.min(clientX, window.innerWidth - bounds.width - margin)
  );
  const top = Math.max(
    margin,
    Math.min(clientY, window.innerHeight - bounds.height - margin)
  );

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
}

function handleTerminalContextMenu(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const pane = target.closest<HTMLElement>(".terminal-pane");
  if (!pane?.dataset.tabId || !elements.terminalStack.contains(pane)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  closeTopbarMenus();
  if (pane.dataset.tabId !== activeTabId) {
    activateTab(pane.dataset.tabId);
  }
  getActiveTab()?.terminal.focus();
  openTerminalContextMenu(event.clientX, event.clientY);
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

    activeTab.terminal.paste(text);
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

function getSelectedConflictPolicy(): SftpConflictPolicy {
  const value = elements.sftpConflictPolicy.value;
  return value === "skip" || value === "rename" ? value : "overwrite";
}

function conflictPolicyLabel(policy: SftpConflictPolicy) {
  return {
    overwrite: "覆盖同名",
    skip: "跳过同名",
    rename: "重命名同名"
  }[policy];
}

function isCancelableTransfer(status: TransferStatus) {
  return status === "queued" || status === "preparing" || status === "running";
}

function remoteEditStatusLabel(status: SftpEditStatus) {
  return {
    opening: "打开",
    opened: "编辑",
    saving: "回传",
    saved: "已保存",
    error: "失败",
    closed: "关闭"
  }[status];
}

function remoteEditStatusBadgeClass(status: SftpEditStatus) {
  if (status === "saved" || status === "opened") {
    return "completed";
  }
  if (status === "error") {
    return "error";
  }
  if (status === "closed") {
    return "canceled";
  }
  return "running";
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

function renderRemoteEdits() {
  elements.sftpEditSummary.textContent = `${remoteEditSessions.length} 项`;

  if (remoteEditSessions.length === 0) {
    elements.sftpEditList.innerHTML = `
      <div class="queue-empty">
        <i data-lucide="file-pen-line"></i>
        <span>暂无编辑会话</span>
      </div>
    `;
    refreshIcons();
    return;
  }

  elements.sftpEditList.innerHTML = remoteEditSessions
    .map(
      (item) => `
        <article class="remote-edit-row ${item.status}" data-edit-id="${escapeHtml(item.editId)}">
          <span class="queue-badge ${remoteEditStatusBadgeClass(item.status)}">
            <i data-lucide="file-pen-line"></i>
            <span>${remoteEditStatusLabel(item.status)}</span>
          </span>
          <div class="remote-edit-main">
            <strong title="${escapeHtml(item.remotePath)}">${escapeHtml(item.name)}</strong>
            <span title="${escapeHtml(item.message)}">${escapeHtml(item.message)}</span>
          </div>
          <button class="icon-button danger" type="button" data-action="close-edit" title="停止监听">
            <i data-lucide="x"></i>
          </button>
        </article>
      `
    )
    .join("");
  refreshIcons();
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
              ${escapeHtml(`${item.message} · ${conflictPolicyLabel(item.conflictPolicy)}`)}
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
            transferId: next.id,
            conflictPolicy: next.conflictPolicy
          })
        : await window.xshellBridge.sftpDownload({
            sessionId: next.sessionId,
            remotePath: next.remotePath ?? next.sourcePath,
            localDirectory: next.localDirectory ?? next.targetPath,
            localName: next.localName ?? next.name,
            transferId: next.id,
            conflictPolicy: next.conflictPolicy
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

  closeSftpPreview();
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

function localNameFromPath(pathValue: string) {
  return pathValue.split(/[\\/]/).filter(Boolean).at(-1) ?? pathValue;
}

function enqueueUploadTransfer(localPath: string, remoteDirectory: string, name?: string) {
  if (!sftpState.sessionId) {
    showToast("SFTP 通道未建立");
    return;
  }

  const itemName = name || localNameFromPath(localPath);
  const conflictPolicy = getSelectedConflictPolicy();
  enqueueSftpTransfer({
    id: createId(),
    sessionId: sftpState.sessionId,
    direction: "upload",
    name: itemName,
    sourcePath: localPath,
    targetPath: remoteDirectory,
    localPath,
    remoteDirectory,
    remoteName: itemName,
    conflictPolicy,
    status: "queued",
    percent: 0,
    message: `等待上传 ${itemName}`,
    summary: createTransferSummary(),
    total: createTransferSummary(),
    createdAt: Date.now()
  });
}

function enqueueDownloadTransfer(entry: FileListEntry, localDirectory: string) {
  if (!sftpState.sessionId) {
    showToast("SFTP 通道未建立");
    return;
  }

  const conflictPolicy = getSelectedConflictPolicy();
  enqueueSftpTransfer({
    id: createId(),
    sessionId: sftpState.sessionId,
    direction: "download",
    name: entry.name,
    sourcePath: entry.path,
    targetPath: localDirectory,
    remotePath: entry.path,
    localDirectory,
    localName: entry.name,
    conflictPolicy,
    status: "queued",
    percent: 0,
    message: `等待下载 ${entry.name}`,
    summary: createTransferSummary(),
    total: createTransferSummary(),
    createdAt: Date.now()
  });
}

function sftpDragPayload(event: DragEvent) {
  const raw = event.dataTransfer?.getData("application/x-xshell-ng-sftp");
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as {
      side?: "local" | "remote";
      paths?: string[];
    };
    if (
      (parsed.side === "local" || parsed.side === "remote") &&
      Array.isArray(parsed.paths)
    ) {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function localDropDirectory(event: DragEvent) {
  const row = (event.target as HTMLElement).closest<HTMLElement>(".file-row");
  const entry = row
    ? sftpState.local.entries.find((item) => item.path === row.dataset.path)
    : undefined;
  return entry?.kind === "directory" ? entry.path : sftpState.local.path;
}

function remoteDropDirectory(event: DragEvent) {
  const row = (event.target as HTMLElement).closest<HTMLElement>(".file-row");
  const entry = row
    ? sftpState.remote.entries.find((item) => item.path === row.dataset.path)
    : undefined;
  return entry?.kind === "directory" ? entry.path : sftpState.remote.path;
}

function droppedFilePath(file: File) {
  return window.xshellBridge.dragFilePath(file);
}

function handleSftpDragStart(event: DragEvent) {
  const row = (event.target as HTMLElement).closest<HTMLElement>(".file-row");
  const side = row?.dataset.side === "remote" ? "remote" : row?.dataset.side === "local" ? "local" : undefined;
  const pathValue = row?.dataset.path;
  if (!side || !pathValue || !event.dataTransfer) {
    return;
  }

  const selected = getSelectedFiles(side);
  const paths = selected.some((entry) => entry.path === pathValue)
    ? selected.map((entry) => entry.path)
    : [pathValue];
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(
    "application/x-xshell-ng-sftp",
    JSON.stringify({ side, paths })
  );
  event.dataTransfer.setData("text/plain", paths.join("\n"));
}

function handleSftpDragOver(event: DragEvent) {
  if (!event.dataTransfer) {
    return;
  }
  const hasInternalPayload = event.dataTransfer.types.includes("application/x-xshell-ng-sftp");
  const hasExternalFiles = event.dataTransfer.types.includes("Files");
  if (!hasInternalPayload && !hasExternalFiles) {
    return;
  }

  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  (event.currentTarget as HTMLElement).classList.add("drop-target");
}

function handleSftpDragLeave(event: DragEvent) {
  (event.currentTarget as HTMLElement).classList.remove("drop-target");
}

function handleSftpDropOnRemote(event: DragEvent) {
  event.preventDefault();
  (event.currentTarget as HTMLElement).classList.remove("drop-target");
  const targetDirectory = remoteDropDirectory(event);
  const payload = sftpDragPayload(event);
  if (payload?.side === "local" && payload.paths) {
    const entries = payload.paths
      .map((pathValue) => sftpState.local.entries.find((entry) => entry.path === pathValue))
      .filter((entry): entry is FileListEntry => Boolean(entry));
    for (const entry of entries) {
      enqueueUploadTransfer(entry.path, targetDirectory, entry.name);
    }
    setSftpStatus(`已加入上传队列：${entries.length} 个本地项目`);
    return;
  }

  const files = Array.from(event.dataTransfer?.files ?? [])
    .map(droppedFilePath)
    .filter(Boolean);
  for (const filePath of files) {
    enqueueUploadTransfer(filePath, targetDirectory);
  }
  if (files.length > 0) {
    setSftpStatus(`已加入上传队列：${files.length} 个本地项目`);
  }
}

function handleSftpDropOnLocal(event: DragEvent) {
  event.preventDefault();
  (event.currentTarget as HTMLElement).classList.remove("drop-target");
  const targetDirectory = localDropDirectory(event);
  const payload = sftpDragPayload(event);
  if (payload?.side !== "remote" || !payload.paths) {
    return;
  }

  const entries = payload.paths
    .map((pathValue) => sftpState.remote.entries.find((entry) => entry.path === pathValue))
    .filter((entry): entry is FileListEntry => Boolean(entry));
  for (const entry of entries) {
    enqueueDownloadTransfer(entry, targetDirectory);
  }
  setSftpStatus(`已加入下载队列：${entries.length} 个远端项目`);
}

function upsertRemoteEditSession(item: RemoteEditItem) {
  const index = remoteEditSessions.findIndex((session) => session.editId === item.editId);
  if (index >= 0) {
    remoteEditSessions[index] = item;
  } else {
    remoteEditSessions = [item, ...remoteEditSessions];
  }
  renderRemoteEdits();
}

function handleSftpEditStatus(event: SftpEditStatusEvent) {
  if (event.status === "closed") {
    remoteEditSessions = remoteEditSessions.filter((item) => item.editId !== event.editId);
    renderRemoteEdits();
    setSftpStatus(event.message);
    return;
  }

  const existing = remoteEditSessions.find((item) => item.editId === event.editId);
  upsertRemoteEditSession({
    editId: event.editId,
    sessionId: event.sessionId,
    remotePath: event.remotePath,
    localPath: event.localPath,
    name: event.name,
    openedAt: existing?.openedAt ?? new Date().toISOString(),
    status: event.status,
    message: event.message,
    savedAt: event.savedAt
  });
  setSftpStatus(event.message);
  if (event.status === "saved" && event.sessionId === sftpState.sessionId) {
    void loadRemoteDirectory();
  }
  if (event.status === "error") {
    showToast(event.message);
  }
}

function sftpPreviewKindLabel(kind: SftpPreviewResponse["kind"]) {
  return {
    text: "文本",
    json: "JSON",
    log: "日志",
    image: "图片"
  }[kind];
}

function closeSftpPreview() {
  elements.sftpPreviewOverlay.classList.add("hidden");
  activeSftpPreviewEntry = undefined;
}

function renderSftpPreviewLoading(entry: FileListEntry) {
  elements.sftpPreviewTitle.textContent = entry.name;
  elements.sftpPreviewMeta.textContent = `${entry.path} · 正在读取`;
  elements.sftpPreviewEdit.disabled = entry.kind !== "file";
  elements.sftpPreviewBody.innerHTML = `
    <div class="sftp-preview-empty">
      <i data-lucide="loader"></i>
      <span>正在读取远端文件...</span>
    </div>
  `;
  elements.sftpPreviewOverlay.classList.remove("hidden");
  refreshIcons();
}

function renderSftpPreview(response: SftpPreviewResponse) {
  const meta = [
    sftpPreviewKindLabel(response.kind),
    formatBytes(response.size),
    response.truncated ? "已截断" : ""
  ].filter(Boolean);
  elements.sftpPreviewTitle.textContent = response.name;
  elements.sftpPreviewMeta.textContent = `${response.remotePath} · ${meta.join(" · ")}`;
  elements.sftpPreviewEdit.disabled = false;

  if (response.kind === "image") {
    elements.sftpPreviewBody.innerHTML = `
      <div class="sftp-preview-image">
        <img src="${escapeHtml(response.dataUrl ?? "")}" alt="${escapeHtml(response.name)}" />
      </div>
    `;
  } else {
    elements.sftpPreviewBody.innerHTML = `
      <pre class="sftp-preview-text ${response.kind}">${escapeHtml(response.text ?? "")}</pre>
    `;
  }

  refreshIcons();
}

async function previewRemoteFile(entry?: FileListEntry) {
  const selected = entry ?? getSelectedFile("remote");
  if (!sftpState.sessionId || !selected) {
    showToast("请选择一个远端文件");
    return;
  }
  if (selected.kind !== "file") {
    showToast("只能预览远端文件");
    return;
  }

  activeSftpPreviewEntry = selected;
  renderSftpPreviewLoading(selected);

  try {
    const response = await window.xshellBridge.sftpPreview({
      sessionId: sftpState.sessionId,
      remotePath: selected.path,
      name: selected.name
    });
    renderSftpPreview(response);
    setSftpStatus(`已预览远端文件：${selected.name}`);
  } catch (error) {
    const message = getErrorMessage(error);
    elements.sftpPreviewBody.innerHTML = `
      <div class="sftp-preview-empty error">
        <i data-lucide="circle-alert"></i>
        <span>${escapeHtml(message)}</span>
      </div>
    `;
    refreshIcons();
    setSftpStatus(message);
    showToast(message);
  }
}

async function editRemoteFile(entry?: FileListEntry) {
  const selected = entry ?? getSelectedFile("remote");
  if (!sftpState.sessionId || !selected) {
    showToast("请选择一个远端文件");
    return;
  }
  if (selected.kind !== "file") {
    showToast("只能编辑远端文件");
    return;
  }

  try {
    setSftpStatus(`正在打开远端文件：${selected.name}`);
    const response = await window.xshellBridge.sftpEditOpen({
      sessionId: sftpState.sessionId,
      remotePath: selected.path,
      name: selected.name
    });
    upsertRemoteEditSession({
      ...response,
      status: "opened",
      message: `已打开 ${response.name}`
    });
    setSftpStatus(`已打开远端文件：${selected.name}`);
  } catch (error) {
    const message = getErrorMessage(error);
    setSftpStatus(message);
    showToast(message);
  }
}

async function closeRemoteEdit(editId: string) {
  try {
    await window.xshellBridge.sftpEditClose({ editId });
  } catch (error) {
    showToast(`关闭远端编辑失败：${getErrorMessage(error)}`);
  }
}

async function uploadSelectedEntry() {
  const selected = getSelectedFile("local");
  if (!sftpState.sessionId || !selected) {
    showToast("请选择一个本地项目");
    return;
  }

  const conflictPolicy = getSelectedConflictPolicy();
  enqueueUploadTransfer(selected.path, sftpState.remote.path, selected.name);
  setSftpStatus(`已加入上传队列：${selected.name} · ${conflictPolicyLabel(conflictPolicy)}`);
}

async function downloadSelectedEntry() {
  const selectedItems = getSelectedFiles("remote");
  if (!sftpState.sessionId || selectedItems.length === 0) {
    showToast("请选择一个或多个远端项目");
    return;
  }

  const conflictPolicy = getSelectedConflictPolicy();
  for (const selected of selectedItems) {
    enqueueDownloadTransfer(selected, sftpState.local.path);
  }

  setSftpStatus(
    selectedItems.length === 1
      ? `已加入下载队列：${selectedItems[0].name} · ${conflictPolicyLabel(conflictPolicy)}`
      : `已加入下载队列：${selectedItems.length} 个远端项目 · ${conflictPolicyLabel(conflictPolicy)}`
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

function defaultRemoteMode(entry: FileListEntry) {
  if (entry.permissions) {
    return entry.permissions;
  }
  return entry.kind === "directory" ? "755" : "644";
}

function normalizeModeInput(value: string) {
  const mode = value.trim();
  return /^[0-7]{3,4}$/.test(mode) ? mode : undefined;
}

async function chmodRemoteSelected(entry?: FileListEntry) {
  const selectedItems = entry ? [entry] : getSelectedFiles("remote");
  if (!sftpState.sessionId || selectedItems.length === 0) {
    showToast("请选择一个或多个远端项目");
    return;
  }

  const initialMode = selectedItems.length === 1 ? defaultRemoteMode(selectedItems[0]) : "";
  const rawMode = await requestSftpInput("修改远端权限", "八进制权限", initialMode);
  if (rawMode === undefined) {
    return;
  }

  const mode = normalizeModeInput(rawMode);
  if (!mode) {
    showToast("权限必须是 3 或 4 位八进制数字");
    return;
  }

  try {
    setSftpStatus(
      selectedItems.length === 1
        ? `正在修改 ${selectedItems[0].name} 权限`
        : `正在修改 ${selectedItems.length} 个远端项目权限`
    );
    await window.xshellBridge.sftpChmod({
      sessionId: sftpState.sessionId,
      mode,
      items: selectedItems.map((item) => ({
        path: item.path,
        kind: item.kind
      }))
    });
    await loadRemoteDirectory();
    setSftpStatus(
      selectedItems.length === 1
        ? `远端权限已修改为 ${mode}`
        : `已修改 ${selectedItems.length} 个远端项目权限为 ${mode}`
    );
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

function toggleSplitView(force?: boolean) {
  if (tabs.length < 2) {
    showToast("至少打开两个标签后才能分屏");
    return;
  }

  isSplitView = force ?? !isSplitView;
  renderTabs();
  getActiveTab()?.terminal.focus();
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
    case "disconnect-tab":
      void disconnectActiveTab();
      break;
    case "reconnect-tab":
      void reconnectActiveTab();
      break;
    case "duplicate-tab":
      duplicateActiveTab();
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
    case "toggle-split-view":
      toggleSplitView();
      break;
    case "reset-split-layout":
      resetSplitLayout();
      break;
    case "import-profiles":
      void importProfiles();
      break;
    case "export-profiles":
      void exportProfiles();
      break;
    case "open-quick-commands":
      openQuickCommands();
      break;
    case "open-terminal-logs":
      void openTerminalLogs();
      break;
    case "open-sftp":
      void openSftpPanel();
      break;
    case "open-tunnels":
      void openTunnelsPanel();
      break;
    case "open-known-hosts":
      void openKnownHosts();
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
    case "close-window":
      void window.xshellBridge.windowClose();
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
  elements.windowMinimize.addEventListener("click", () => {
    void window.xshellBridge.windowMinimize();
  });
  elements.windowMaximize.addEventListener("click", () => {
    void window.xshellBridge.windowToggleMaximize();
  });
  elements.windowClose.addEventListener("click", () => {
    void window.xshellBridge.windowClose();
  });
  elements.topbar.addEventListener("dblclick", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("button") || target.closest(".fullscreen-menu-popover")) {
      return;
    }
    void window.xshellBridge.windowToggleMaximize();
  });
  elements.fullscreenMenu
    .querySelectorAll<HTMLElement>(".fullscreen-menu-group")
    .forEach((group) => {
      group.addEventListener("pointerenter", () => openTopbarMenu(group));
      group.addEventListener("pointerleave", scheduleCloseTopbarMenus);
    });
  elements.fullscreenMenu.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const command = target.closest<HTMLElement>("[data-command]")?.dataset.command;
    if (!command) {
      return;
    }

    handleCommand(command);
    closeTopbarMenus();
    blurActiveElement();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeTopbarMenus();
      closeTerminalContextMenu();
    }
  });
  elements.newSession.addEventListener("click", () => openConnectionDialog());
  $("#new-tab").addEventListener("click", () => openConnectionDialog(undefined, { quick: true }));
  elements.quickConnect.addEventListener("click", () =>
    openConnectionDialog(undefined, { quick: true })
  );
  $("#empty-connect").addEventListener("click", () => openConnectionDialog());
  elements.disconnectTab.addEventListener("click", () => void disconnectActiveTab());
  elements.reconnectTab.addEventListener("click", () => void reconnectActiveTab());
  elements.duplicateTab.addEventListener("click", duplicateActiveTab);
  elements.splitTerminal.addEventListener("click", () => toggleSplitView());
  elements.splitResizeLayer.addEventListener("pointerdown", startSplitResize);
  elements.splitResizeLayer.addEventListener("dblclick", handleSplitResizeDoubleClick);
  elements.openTerminalSearch.addEventListener("click", () => openTerminalSearch());
  elements.openQuickCommands.addEventListener("click", openQuickCommands);
  elements.openTerminalLogs.addEventListener("click", () => void openTerminalLogs());
  elements.openPreferences.addEventListener("click", openPreferences);
  elements.openSftp.addEventListener("click", () => void openSftpPanel());
  elements.openTunnels.addEventListener("click", () => void openTunnelsPanel());
  $("#import-profiles").addEventListener("click", () => void importProfiles());
  $("#export-profiles").addEventListener("click", () => void exportProfiles());
  elements.chooseLogDirectory.addEventListener("click", () => void chooseLogDirectory());
  elements.openLogDirectory.addEventListener("click", () => void openConfiguredLogDirectory());
  $("#close-terminal-logs").addEventListener("click", () => elements.terminalLogDialog.close());
  $("#terminal-log-close-footer").addEventListener("click", () => elements.terminalLogDialog.close());
  elements.terminalLogRefresh.addEventListener("click", () => void refreshTerminalLogs());
  elements.terminalLogOpenDirectory.addEventListener("click", () =>
    void window.xshellBridge
      .terminalLogOpenDirectory({ directoryPath: getConfiguredLogDirectory() })
      .catch((error) => showToast(`打开日志目录失败：${getErrorMessage(error)}`))
  );
  elements.terminalLogOpenCurrent.addEventListener("click", () =>
    void openTerminalLogFile(getActiveTab()?.logFilePath)
  );
  elements.terminalLogList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".terminal-log-row");
    if (!row?.dataset.logPath) {
      return;
    }

    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    if (action === "open-log") {
      void openTerminalLogFile(row.dataset.logPath);
      return;
    }
    if (action === "show-log") {
      void showTerminalLogFile(row.dataset.logPath);
      return;
    }
  });
  $("#close-quick-commands").addEventListener("click", () => elements.quickCommandDialog.close());
  $("#quick-command-new").addEventListener("click", newQuickCommand);
  elements.quickCommandForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveQuickCommandFromForm();
  });
  elements.quickCommandDelete.addEventListener("click", deleteActiveQuickCommand);
  elements.quickCommandSend.addEventListener("click", sendQuickCommand);
  elements.quickCommandBody.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.key === "Enter") {
      event.preventDefault();
      sendQuickCommand();
    }
  });
  elements.quickCommandList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".quick-command-row");
    if (!row?.dataset.commandId) {
      return;
    }
    selectQuickCommand(row.dataset.commandId);
  });
  $("#close-known-hosts").addEventListener("click", () => elements.knownHostDialog.close());
  $("#known-host-close-footer").addEventListener("click", () => elements.knownHostDialog.close());
  $("#known-host-refresh").addEventListener("click", () => void refreshKnownHosts());
  elements.knownHostClear.addEventListener("click", () => void clearKnownHosts());
  elements.knownHostList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".known-host-row");
    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    if (!row?.dataset.knownHostId || action !== "delete-known-host") {
      return;
    }
    void deleteKnownHost(row.dataset.knownHostId);
  });
  $("#close-tunnels").addEventListener("click", () => elements.tunnelDialog.close());
  $("#tunnels-close-footer").addEventListener("click", () => elements.tunnelDialog.close());
  $("#refresh-tunnels").addEventListener("click", () => void refreshTunnels());
  elements.tunnelForm.addEventListener("change", (event) => {
    const target = event.target as HTMLElement;
    if (target.matches('input[name="tunnel-type"]')) {
      syncTunnelForm();
    }
    if (target === elements.tunnelSaveProfile) {
      elements.tunnelAutoStart.disabled = !elements.tunnelSaveProfile.checked;
    }
  });
  elements.tunnelCheck.addEventListener("click", () => void checkTunnelFromForm());
  elements.tunnelForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void createTunnelFromForm();
  });
  elements.tunnelList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".tunnel-row");
    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    if (!row || action !== "stop-tunnel") {
      if (row && action === "check-tunnel") {
        void checkRunningTunnel(row.dataset.tunnelId ?? "");
      }
      return;
    }
    void stopTunnel(row.dataset.tunnelId ?? "");
  });
  elements.savedTunnelList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".tunnel-row");
    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    const profileId = tunnelState.profileId;
    if (!row || !action || !profileId) {
      return;
    }

    const tunnel = getTunnelProfile()?.tunnels?.find(
      (item) => item.id === row.dataset.savedTunnelId
    );
    if (!tunnel) {
      return;
    }

    if (action === "start-saved-tunnel") {
      void startSavedTunnel(tunnel);
      return;
    }

    if (action === "check-saved-tunnel") {
      void checkSavedTunnel(tunnel);
      return;
    }

    if (action === "toggle-saved-tunnel") {
      updateSavedTunnels(profileId, (tunnels) =>
        tunnels.map((item) =>
          item.id === tunnel.id ? { ...item, autoStart: !item.autoStart } : item
        )
      );
      return;
    }

    if (action === "delete-saved-tunnel") {
      updateSavedTunnels(profileId, (tunnels) =>
        tunnels.filter((item) => item.id !== tunnel.id)
      );
    }
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
  elements.sftpRemoteChmod.addEventListener("click", () => void chmodRemoteSelected());
  $("#remote-preview").addEventListener("click", () => void previewRemoteFile());
  $("#remote-edit").addEventListener("click", () => void editRemoteFile());
  $("#remote-delete").addEventListener("click", () => void deleteRemoteSelected());
  $("#sftp-preview-close").addEventListener("click", closeSftpPreview);
  $("#sftp-preview-close-footer").addEventListener("click", closeSftpPreview);
  elements.sftpPreviewEdit.addEventListener("click", () => {
    const entry = activeSftpPreviewEntry ?? getSelectedFile("remote");
    closeSftpPreview();
    void editRemoteFile(entry);
  });
  elements.sftpDialog.addEventListener("close", closeSftpPreview);
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
  elements.sftpEditList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".remote-edit-row");
    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    if (!row?.dataset.editId || action !== "close-edit") {
      return;
    }
    void closeRemoteEdit(row.dataset.editId);
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
  elements.sftpLocalList.addEventListener("dragstart", handleSftpDragStart);
  elements.sftpRemoteList.addEventListener("dragstart", handleSftpDragStart);
  elements.sftpLocalList.addEventListener("dragover", handleSftpDragOver);
  elements.sftpRemoteList.addEventListener("dragover", handleSftpDragOver);
  elements.sftpLocalList.addEventListener("dragleave", handleSftpDragLeave);
  elements.sftpRemoteList.addEventListener("dragleave", handleSftpDragLeave);
  elements.sftpLocalList.addEventListener("drop", handleSftpDropOnLocal);
  elements.sftpRemoteList.addEventListener("drop", handleSftpDropOnRemote);
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
    if (target === elements.profileProxyType) {
      syncConnectionPanels();
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

    if (tabButton.dataset.tabId) {
      activateTab(tabButton.dataset.tabId);
    }
  });

  elements.terminalStack.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("#terminal-context-menu")) {
      return;
    }
    closeTerminalContextMenu();
    const pane = target.closest<HTMLElement>(".terminal-pane");
    if (pane?.dataset.tabId && pane.dataset.tabId !== activeTabId) {
      activateTab(pane.dataset.tabId);
      return;
    }
    getActiveTab()?.terminal.focus();
  });
  elements.terminalStack.addEventListener("contextmenu", handleTerminalContextMenu);
  elements.terminalContextMenu.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const command = target.closest<HTMLElement>("[data-command]")?.dataset.command;
    if (!command) {
      return;
    }

    closeTerminalContextMenu();
    handleCommand(command);
  });
  window.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement;
    if (!target.closest("#terminal-context-menu")) {
      closeTerminalContextMenu();
    }
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

    if (action === "chmod") {
      void chmodRemoteSelected(entry);
      return;
    }

    if (action === "preview") {
      void previewRemoteFile(entry);
      return;
    }

    if (action === "edit") {
      void editRemoteFile(entry);
      return;
    }

    if (event.detail >= 2 && entry?.kind === "file") {
      void previewRemoteFile(entry);
      return;
    }

    if (event.detail >= 2 && entry?.kind === "directory") {
      void loadRemoteDirectory(entry.path);
    }
  });

  elements.preferencesDialog.addEventListener("close", () => {
    const wasLogging = preferences.terminalLogging;
    const previousLogDirectory = preferences.logDirectory;
    preferences = {
      fontSize: Number(elements.prefFontSize.value || 14),
      theme: isThemeId(elements.prefTheme.value) ? elements.prefTheme.value : "classic",
      cursorBlink: elements.prefCursorBlink.checked,
      terminalLogging: elements.prefTerminalLogging.checked,
      logDirectory: elements.prefLogDirectory.value.trim()
    };
    savePreferences();
    applyPreferences();
    const logDirectoryChanged = previousLogDirectory !== preferences.logDirectory;
    if (preferences.terminalLogging && !wasLogging) {
      tabs
        .filter((tab) => tab.status === "connected")
        .forEach((tab) => void startTerminalLogging(tab));
    }
    if (preferences.terminalLogging && wasLogging && logDirectoryChanged) {
      tabs
        .filter((tab) => tab.status === "connected")
        .forEach((tab) => {
          void stopTerminalLogging(tab).then(() => startTerminalLogging(tab));
        });
    }
    if (logDirectoryChanged && elements.terminalLogDialog.open) {
      void refreshTerminalLogs({ quiet: true });
    }
    if (wasLogging && !preferences.terminalLogging) {
      tabs.forEach((tab) => void stopTerminalLogging(tab));
    }
  });

  window.addEventListener("resize", handleTerminalStackGeometryChange);
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
    if (!tab) {
      return;
    }
    tab.terminal.write(data);
    handleLoginTriggers(tab, data);
  });

  window.xshellBridge.onStatus(({ sessionId, status, message }) => {
    const tab = tabs.find((item) => item.sessionId === sessionId);
    if (!tab) {
      return;
    }

    tab.status = status;
    if (status === "connected") {
      tab.manualDisconnect = false;
      tab.reconnectAttempts = 0;
      clearReconnectTimer(tab);
      tab.terminal.writeln(`\x1b[32m${message}\x1b[0m`);
      void startTerminalLogging(tab);
      void autoStartProfileTunnels(tab);
      void runLoginScript(tab);
    }
    if (status === "error") {
      clearTerminalLogging(tab);
      tab.sessionId = undefined;
      tab.terminal.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
      showToast(message);
      scheduleAutoReconnect(tab, message);
    }
    if (status === "disconnected") {
      clearTerminalLogging(tab);
      tab.sessionId = undefined;
      tab.terminal.writeln(`\r\n\x1b[33m${message}\x1b[0m`);
      scheduleAutoReconnect(tab, message);
    }
    if (status !== "connected" && tunnelState.sessionId === sessionId) {
      tunnelState.tunnels = [];
      tunnelState.sessionId = undefined;
      tunnelState.profileId = undefined;
      renderTunnels();
      renderSavedTunnels();
    }
    renderTabs();
  });

  window.xshellBridge.onTransferProgress(renderTransferProgress);
  window.xshellBridge.onSftpEditStatus(handleSftpEditStatus);
  window.xshellBridge.onTunnelsChanged(({ sessionId, tunnels }) => {
    if (tunnelState.sessionId !== sessionId) {
      return;
    }
    tunnelState.tunnels = tunnels;
    renderTunnels();
  });

  window.xshellBridge.onCommand(handleCommand);
  window.xshellBridge.onWindowState(({ isFullScreen, isMaximized }) => {
    renderWindowState(isFullScreen, isMaximized);
  });

  new ResizeObserver(handleTerminalStackGeometryChange).observe(elements.terminalStack);
}

renderThemeOptions();
applyTheme(preferences.theme);
wireEvents();
renderProfiles();
renderTabs();
setStatus("就绪");
refreshIcons();
void migrateLegacyProfilePasswords();
