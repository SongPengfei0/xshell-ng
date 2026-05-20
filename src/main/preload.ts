import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  ConnectRequest,
  ConnectResponse,
  KnownHostDeleteRequest,
  KnownHostListResponse,
  LocalDeleteRequest,
  LocalListRequest,
  LocalMkdirRequest,
  LocalRenameRequest,
  ProfileExportRequest,
  ProfileExportResponse,
  ProfileImportResponse,
  ResizeRequest,
  SecretDeleteRequest,
  SecretGetRequest,
  SecretSetRequest,
  SendDataRequest,
  SftpDeleteRequest,
  SftpDownloadRequest,
  SftpEditCloseRequest,
  SftpEditOpenRequest,
  SftpEditOpenResponse,
  SftpEditStatusEvent,
  SftpCancelTransferRequest,
  SftpListRequest,
  SftpMkdirRequest,
  SftpPreviewRequest,
  SftpPreviewResponse,
  SftpRenameRequest,
  SftpUploadRequest,
  TunnelCloseRequest,
  TunnelCreateRequest,
  TunnelCreateResponse,
  TunnelInfo,
  TunnelListEvent,
  TunnelListRequest,
  TransferSummary,
  TransferProgressEvent,
  SshDataEvent,
  SshStatusEvent,
  TerminalLogDirectoryRequest,
  TerminalLogDirectorySelectResponse,
  TerminalLogListResponse,
  TerminalLogOpenFileRequest,
  TerminalLogStartRequest,
  TerminalLogStartResponse,
  TerminalLogStopRequest,
  WindowStateEvent
} from "../shared/ipc";

const on = <T>(channel: string, callback: (payload: T) => void) => {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("xshellBridge", {
  connect: (request: ConnectRequest): Promise<ConnectResponse> =>
    ipcRenderer.invoke("ssh:connect", request),
  disconnect: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke("ssh:disconnect", sessionId),
  sendData: (request: SendDataRequest): void => {
    ipcRenderer.send("ssh:input", request);
  },
  resize: (request: ResizeRequest): void => {
    ipcRenderer.send("ssh:resize", request);
  },
  terminalLogStart: (
    request: TerminalLogStartRequest
  ): Promise<TerminalLogStartResponse> =>
    ipcRenderer.invoke("terminal-log:start", request),
  terminalLogStop: (request: TerminalLogStopRequest): Promise<void> =>
    ipcRenderer.invoke("terminal-log:stop", request),
  terminalLogDefaultDirectory: (): Promise<string> =>
    ipcRenderer.invoke("terminal-log:default-directory"),
  terminalLogSelectDirectory: (
    request: TerminalLogDirectoryRequest
  ): Promise<TerminalLogDirectorySelectResponse> =>
    ipcRenderer.invoke("terminal-log:select-directory", request),
  terminalLogList: (
    request: TerminalLogDirectoryRequest
  ): Promise<TerminalLogListResponse> =>
    ipcRenderer.invoke("terminal-log:list", request),
  terminalLogOpenDirectory: (request: TerminalLogDirectoryRequest): Promise<void> =>
    ipcRenderer.invoke("terminal-log:open-directory", request),
  terminalLogOpenFile: (request: TerminalLogOpenFileRequest): Promise<void> =>
    ipcRenderer.invoke("terminal-log:open-file", request),
  terminalLogShowFile: (request: TerminalLogOpenFileRequest): Promise<void> =>
    ipcRenderer.invoke("terminal-log:show-file", request),
  knownHostsList: (): Promise<KnownHostListResponse> =>
    ipcRenderer.invoke("known-hosts:list"),
  knownHostsDelete: (request: KnownHostDeleteRequest): Promise<void> =>
    ipcRenderer.invoke("known-hosts:delete", request),
  knownHostsClear: (): Promise<void> =>
    ipcRenderer.invoke("known-hosts:clear"),
  clipboardReadText: (): Promise<string> =>
    ipcRenderer.invoke("clipboard:read-text"),
  clipboardWriteText: (text: string): Promise<void> =>
    ipcRenderer.invoke("clipboard:write-text", text),
  secretSet: (request: SecretSetRequest): Promise<void> =>
    ipcRenderer.invoke("secret:set", request),
  secretGet: (request: SecretGetRequest): Promise<string | undefined> =>
    ipcRenderer.invoke("secret:get", request),
  secretDelete: (request: SecretDeleteRequest): Promise<void> =>
    ipcRenderer.invoke("secret:delete", request),
  profilesExport: (request: ProfileExportRequest): Promise<ProfileExportResponse> =>
    ipcRenderer.invoke("profiles:export", request),
  profilesImport: (): Promise<ProfileImportResponse> =>
    ipcRenderer.invoke("profiles:import"),
  selectPrivateKey: (): Promise<string | undefined> =>
    ipcRenderer.invoke("key:select"),
  localHome: (): Promise<string> => ipcRenderer.invoke("local:home"),
  dragFilePath: (file: File): string => webUtils.getPathForFile(file),
  localList: (request: LocalListRequest) =>
    ipcRenderer.invoke("local:list", request),
  localMkdir: (request: LocalMkdirRequest): Promise<void> =>
    ipcRenderer.invoke("local:mkdir", request),
  localRename: (request: LocalRenameRequest): Promise<void> =>
    ipcRenderer.invoke("local:rename", request),
  localDelete: (request: LocalDeleteRequest): Promise<void> =>
    ipcRenderer.invoke("local:delete", request),
  sftpList: (request: SftpListRequest) =>
    ipcRenderer.invoke("sftp:list", request),
  sftpUpload: (request: SftpUploadRequest): Promise<TransferSummary> =>
    ipcRenderer.invoke("sftp:upload", request),
  sftpDownload: (request: SftpDownloadRequest): Promise<TransferSummary> =>
    ipcRenderer.invoke("sftp:download", request),
  sftpMkdir: (request: SftpMkdirRequest): Promise<void> =>
    ipcRenderer.invoke("sftp:mkdir", request),
  sftpDelete: (request: SftpDeleteRequest): Promise<void> =>
    ipcRenderer.invoke("sftp:delete", request),
  sftpRename: (request: SftpRenameRequest): Promise<void> =>
    ipcRenderer.invoke("sftp:rename", request),
  sftpCancelTransfer: (request: SftpCancelTransferRequest): Promise<boolean> =>
    ipcRenderer.invoke("sftp:cancel-transfer", request),
  sftpEditOpen: (request: SftpEditOpenRequest): Promise<SftpEditOpenResponse> =>
    ipcRenderer.invoke("sftp:edit-open", request),
  sftpPreview: (request: SftpPreviewRequest): Promise<SftpPreviewResponse> =>
    ipcRenderer.invoke("sftp:preview", request),
  sftpEditClose: (request: SftpEditCloseRequest): Promise<void> =>
    ipcRenderer.invoke("sftp:edit-close", request),
  tunnelList: (request: TunnelListRequest): Promise<TunnelInfo[]> =>
    ipcRenderer.invoke("tunnel:list", request),
  tunnelCreate: (request: TunnelCreateRequest): Promise<TunnelCreateResponse> =>
    ipcRenderer.invoke("tunnel:create", request),
  tunnelClose: (request: TunnelCloseRequest): Promise<void> =>
    ipcRenderer.invoke("tunnel:close", request),
  windowToggleFullScreen: (): Promise<boolean> =>
    ipcRenderer.invoke("window:toggle-full-screen"),
  windowExitFullScreen: (): Promise<boolean> =>
    ipcRenderer.invoke("window:exit-full-screen"),
  windowMinimize: (): Promise<void> =>
    ipcRenderer.invoke("window:minimize"),
  windowToggleMaximize: (): Promise<boolean> =>
    ipcRenderer.invoke("window:toggle-maximize"),
  windowClose: (): Promise<void> =>
    ipcRenderer.invoke("window:close"),
  onTransferProgress: (callback: (payload: TransferProgressEvent) => void) =>
    on<TransferProgressEvent>("sftp:transfer-progress", callback),
  onSftpEditStatus: (callback: (payload: SftpEditStatusEvent) => void) =>
    on<SftpEditStatusEvent>("sftp:edit-status", callback),
  onData: (callback: (payload: SshDataEvent) => void) =>
    on<SshDataEvent>("ssh:data", callback),
  onStatus: (callback: (payload: SshStatusEvent) => void) =>
    on<SshStatusEvent>("ssh:status", callback),
  onTunnelsChanged: (callback: (payload: TunnelListEvent) => void) =>
    on<TunnelListEvent>("tunnel:changed", callback),
  onCommand: (callback: (command: string) => void) =>
    on<string>("app:command", callback),
  onWindowState: (callback: (payload: WindowStateEvent) => void) =>
    on<WindowStateEvent>("window:state", callback)
});
