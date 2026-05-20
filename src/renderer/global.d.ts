import type {
  ConnectRequest,
  ConnectResponse,
  FileListResponse,
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
  SftpRenameRequest,
  SftpUploadRequest,
  TunnelCloseRequest,
  TunnelCreateRequest,
  TunnelCreateResponse,
  TunnelInfo,
  TunnelListEvent,
  TunnelListRequest,
  TransferProgressEvent,
  TransferSummary,
  SshDataEvent,
  SshStatusEvent,
  TerminalLogStartRequest,
  TerminalLogStartResponse,
  TerminalLogStopRequest,
  WindowStateEvent
} from "../shared/ipc";

declare global {
  interface Window {
    xshellBridge: {
      connect: (request: ConnectRequest) => Promise<ConnectResponse>;
      disconnect: (sessionId: string) => Promise<void>;
      sendData: (request: SendDataRequest) => void;
      resize: (request: ResizeRequest) => void;
      terminalLogStart: (
        request: TerminalLogStartRequest
      ) => Promise<TerminalLogStartResponse>;
      terminalLogStop: (request: TerminalLogStopRequest) => Promise<void>;
      knownHostsList: () => Promise<KnownHostListResponse>;
      knownHostsDelete: (request: KnownHostDeleteRequest) => Promise<void>;
      knownHostsClear: () => Promise<void>;
      clipboardReadText: () => Promise<string>;
      clipboardWriteText: (text: string) => Promise<void>;
      secretSet: (request: SecretSetRequest) => Promise<void>;
      secretGet: (request: SecretGetRequest) => Promise<string | undefined>;
      secretDelete: (request: SecretDeleteRequest) => Promise<void>;
      profilesExport: (request: ProfileExportRequest) => Promise<ProfileExportResponse>;
      profilesImport: () => Promise<ProfileImportResponse>;
      selectPrivateKey: () => Promise<string | undefined>;
      localHome: () => Promise<string>;
      dragFilePath: (file: File) => string;
      localList: (request: LocalListRequest) => Promise<FileListResponse>;
      localMkdir: (request: LocalMkdirRequest) => Promise<void>;
      localRename: (request: LocalRenameRequest) => Promise<void>;
      localDelete: (request: LocalDeleteRequest) => Promise<void>;
      sftpList: (request: SftpListRequest) => Promise<FileListResponse>;
      sftpUpload: (request: SftpUploadRequest) => Promise<TransferSummary>;
      sftpDownload: (request: SftpDownloadRequest) => Promise<TransferSummary>;
      sftpMkdir: (request: SftpMkdirRequest) => Promise<void>;
      sftpDelete: (request: SftpDeleteRequest) => Promise<void>;
      sftpRename: (request: SftpRenameRequest) => Promise<void>;
      sftpCancelTransfer: (request: SftpCancelTransferRequest) => Promise<boolean>;
      sftpEditOpen: (request: SftpEditOpenRequest) => Promise<SftpEditOpenResponse>;
      sftpEditClose: (request: SftpEditCloseRequest) => Promise<void>;
      tunnelList: (request: TunnelListRequest) => Promise<TunnelInfo[]>;
      tunnelCreate: (request: TunnelCreateRequest) => Promise<TunnelCreateResponse>;
      tunnelClose: (request: TunnelCloseRequest) => Promise<void>;
      windowToggleFullScreen: () => Promise<boolean>;
      windowExitFullScreen: () => Promise<boolean>;
      windowMinimize: () => Promise<void>;
      windowToggleMaximize: () => Promise<boolean>;
      windowClose: () => Promise<void>;
      onTransferProgress: (callback: (payload: TransferProgressEvent) => void) => () => void;
      onSftpEditStatus: (callback: (payload: SftpEditStatusEvent) => void) => () => void;
      onData: (callback: (payload: SshDataEvent) => void) => () => void;
      onStatus: (callback: (payload: SshStatusEvent) => void) => () => void;
      onTunnelsChanged: (callback: (payload: TunnelListEvent) => void) => () => void;
      onCommand: (callback: (command: string) => void) => () => void;
      onWindowState: (callback: (payload: WindowStateEvent) => void) => () => void;
    };
  }
}

export {};
