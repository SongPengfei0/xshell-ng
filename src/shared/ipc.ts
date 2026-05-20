export type AuthMethod = "password" | "privateKey";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface SshProfile {
  id: string;
  name: string;
  group?: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  password?: string;
  rememberPassword?: boolean;
  privateKeyPath?: string;
  passphrase?: string;
  color?: string;
  tunnels?: SavedTunnelConfig[];
  proxy?: SshProxyConfig;
  keepaliveInterval?: number;
  autoReconnect?: boolean;
  reconnectLimit?: number;
}

export interface ConnectRequest {
  profile: SshProfile;
  proxyProfile?: SshProfile;
  terminal: {
    cols: number;
    rows: number;
  };
}

export interface ConnectResponse {
  sessionId: string;
}

export interface SshDataEvent {
  sessionId: string;
  data: string;
}

export interface SshStatusEvent {
  sessionId: string;
  status: ConnectionStatus;
  message: string;
}

export type SshProxyType = "jump" | "socks5" | "http";

export interface SshProxyConfig {
  type: SshProxyType;
  jumpProfileId?: string;
  host?: string;
  port?: number;
}

export type TunnelType = "local" | "remote" | "dynamic";

export type TunnelStatus = "running" | "closed" | "error";

export interface TunnelInfo {
  id: string;
  sessionId: string;
  type: TunnelType;
  name: string;
  status: TunnelStatus;
  createdAt: number;
  localHost?: string;
  localPort?: number;
  remoteHost?: string;
  remotePort?: number;
  targetHost?: string;
  targetPort?: number;
  connections: number;
  bytesUp: number;
  bytesDown: number;
  lastError?: string;
}

export interface TunnelListRequest {
  sessionId: string;
}

export interface TunnelCreateRequest {
  sessionId: string;
  type: TunnelType;
  name?: string;
  localHost?: string;
  localPort?: number;
  remoteHost?: string;
  remotePort?: number;
  targetHost?: string;
  targetPort?: number;
}

export interface SavedTunnelConfig {
  id: string;
  type: TunnelType;
  name: string;
  autoStart: boolean;
  localHost?: string;
  localPort?: number;
  remoteHost?: string;
  remotePort?: number;
  targetHost?: string;
  targetPort?: number;
}

export interface TunnelCreateResponse {
  tunnel: TunnelInfo;
}

export interface TunnelCloseRequest {
  sessionId: string;
  tunnelId: string;
}

export interface TunnelListEvent {
  sessionId: string;
  tunnels: TunnelInfo[];
}

export interface WindowStateEvent {
  isFullScreen: boolean;
  isMaximized: boolean;
}

export interface ResizeRequest {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface SendDataRequest {
  sessionId: string;
  data: string;
}

export interface TerminalLogStartRequest {
  sessionId: string;
  profileName: string;
  host: string;
  username: string;
}

export interface TerminalLogStartResponse {
  filePath: string;
}

export interface TerminalLogStopRequest {
  sessionId: string;
}

export interface KnownHostEntry {
  id: string;
  host: string;
  port: number;
  keyAlgorithm: string;
  fingerprint: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface KnownHostListResponse {
  entries: KnownHostEntry[];
}

export interface KnownHostDeleteRequest {
  id: string;
}

export interface SecretSetRequest {
  key: string;
  value: string;
}

export interface SecretGetRequest {
  key: string;
}

export interface SecretDeleteRequest {
  key: string;
}

export interface ProfileExportRequest {
  profiles: SshProfile[];
}

export interface ProfileExportResponse {
  canceled: boolean;
  filePath?: string;
}

export interface ProfileImportResponse {
  canceled: boolean;
  filePath?: string;
  profiles: SshProfile[];
}

export type FileEntryKind = "file" | "directory" | "symlink" | "other";

export interface FileListEntry {
  name: string;
  path: string;
  kind: FileEntryKind;
  size: number;
  modifiedAt?: number;
  permissions?: string;
}

export interface FileListResponse {
  path: string;
  parentPath?: string;
  entries: FileListEntry[];
}

export interface LocalListRequest {
  path?: string;
}

export interface LocalMkdirRequest {
  parentPath: string;
  name: string;
}

export interface LocalRenameRequest {
  path: string;
  newName: string;
}

export interface LocalDeleteRequest {
  paths: string[];
}

export interface SftpListRequest {
  sessionId: string;
  path?: string;
}

export interface SftpUploadRequest {
  sessionId: string;
  localPath: string;
  remoteDirectory: string;
  remoteName?: string;
  transferId?: string;
  conflictPolicy?: SftpConflictPolicy;
}

export interface SftpDownloadRequest {
  sessionId: string;
  remotePath: string;
  localDirectory: string;
  localName?: string;
  transferId?: string;
  conflictPolicy?: SftpConflictPolicy;
}

export interface SftpMkdirRequest {
  sessionId: string;
  parentPath: string;
  name: string;
}

export interface SftpDeleteRequest {
  sessionId: string;
  path?: string;
  kind?: FileEntryKind;
  items?: Array<{
    path: string;
    kind: FileEntryKind;
  }>;
}

export interface SftpRenameRequest {
  sessionId: string;
  path: string;
  newName: string;
}

export interface SftpCancelTransferRequest {
  transferId: string;
}

export interface SftpEditOpenRequest {
  sessionId: string;
  remotePath: string;
  name?: string;
}

export interface SftpEditOpenResponse {
  editId: string;
  sessionId: string;
  remotePath: string;
  localPath: string;
  name: string;
  openedAt: string;
}

export interface SftpEditCloseRequest {
  editId: string;
}

export type SftpEditStatus =
  | "opening"
  | "opened"
  | "saving"
  | "saved"
  | "error"
  | "closed";

export interface SftpEditStatusEvent {
  editId: string;
  sessionId: string;
  remotePath: string;
  localPath: string;
  name: string;
  status: SftpEditStatus;
  message: string;
  savedAt?: string;
}

export interface TransferSummary {
  files: number;
  directories: number;
  bytes: number;
  skipped: number;
}

export type TransferDirection = "upload" | "download";

export type SftpConflictPolicy = "overwrite" | "skip" | "rename";

export type TransferStatus =
  | "queued"
  | "preparing"
  | "running"
  | "completed"
  | "error"
  | "canceled";

export interface TransferProgressEvent {
  transferId: string;
  direction: TransferDirection;
  status: TransferStatus;
  message: string;
  summary: TransferSummary;
  total: TransferSummary;
  currentPath?: string;
  activeFileBytes?: number;
  activeFileTransferred?: number;
  percent: number;
}
