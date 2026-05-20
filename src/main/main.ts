import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  shell,
  type WebContents
} from "electron";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  Client,
  type ClientChannel,
  type ConnectConfig,
  type FileEntryWithStats,
  type SFTPWrapper,
  type TcpConnectionDetails,
  type VerifyCallback
} from "ssh2";
import type {
  ConnectRequest,
  ConnectResponse,
  FileEntryKind,
  FileListEntry,
  FileListResponse,
  KnownHostDeleteRequest,
  KnownHostEntry,
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
  SftpCancelTransferRequest,
  SftpDeleteRequest,
  SftpDownloadRequest,
  SftpEditCloseRequest,
  SftpEditOpenRequest,
  SftpEditOpenResponse,
  SftpEditStatusEvent,
  SftpConflictPolicy,
  SftpListRequest,
  SftpMkdirRequest,
  SftpRenameRequest,
  SftpUploadRequest,
  SavedTunnelConfig,
  TerminalLogStartRequest,
  TerminalLogStartResponse,
  TerminalLogStopRequest,
  TunnelCloseRequest,
  TunnelCreateRequest,
  TunnelCreateResponse,
  TunnelInfo,
  TunnelListRequest,
  TunnelType,
  TransferDirection,
  TransferProgressEvent,
  TransferSummary,
  SshStatusEvent
} from "../shared/ipc";

interface SshRuntime {
  id: string;
  client: Client;
  stream?: ClientChannel;
  sftp?: SFTPWrapper;
  proxyClient?: Client;
  proxySocket?: Readable & Writable;
  window: BrowserWindow;
  tunnels: Map<string, TunnelRuntime>;
}

interface TunnelRuntime extends TunnelInfo {
  server?: net.Server;
  sockets: Set<net.Socket>;
  channels: Set<ClientChannel>;
}

interface RemoteEditSession {
  editId: string;
  sessionId: string;
  remotePath: string;
  localPath: string;
  directoryPath: string;
  localName: string;
  name: string;
  window: BrowserWindow;
  watcher?: fs.FSWatcher;
  saveTimer?: NodeJS.Timeout;
  saving: boolean;
  pendingSave: boolean;
  lastSavedMtimeMs: number;
}

const sessions = new Map<string, SshRuntime>();
const activeTransfers = new Map<string, TransferContext>();
const terminalLogs = new Map<string, fs.WriteStream>();
const remoteEditSessions = new Map<string, RemoteEditSession>();

const isDevelopment = !app.isPackaged;
const secretStoreFileName = "secure-secrets.json";
const knownHostsFileName = "known-hosts.json";

interface KnownHostRecord {
  host: string;
  port: number;
  keyAlgorithm: string;
  fingerprint: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const tunnelTypeLabel = (type: TunnelType) => {
  switch (type) {
    case "local":
      return "本地转发";
    case "remote":
      return "远端转发";
    case "dynamic":
      return "SOCKS5 代理";
  }
};

const toTunnelInfo = (tunnel: TunnelRuntime): TunnelInfo => ({
  id: tunnel.id,
  sessionId: tunnel.sessionId,
  type: tunnel.type,
  name: tunnel.name,
  status: tunnel.status,
  createdAt: tunnel.createdAt,
  localHost: tunnel.localHost,
  localPort: tunnel.localPort,
  remoteHost: tunnel.remoteHost,
  remotePort: tunnel.remotePort,
  targetHost: tunnel.targetHost,
  targetPort: tunnel.targetPort,
  connections: tunnel.connections,
  bytesUp: tunnel.bytesUp,
  bytesDown: tunnel.bytesDown,
  lastError: tunnel.lastError
});

const listTunnelInfos = (runtime: SshRuntime) =>
  [...runtime.tunnels.values()].map(toTunnelInfo);

const emitTunnelsChanged = (runtime: SshRuntime) => {
  if (!runtime.window.isDestroyed()) {
    runtime.window.webContents.send("tunnel:changed", {
      sessionId: runtime.id,
      tunnels: listTunnelInfos(runtime)
    });
  }
};

const normalizeTunnelHost = (host: string | undefined, fallback: string) => {
  const value = host?.trim();
  return value || fallback;
};

const normalizeTunnelPort = (value: number | undefined, label: string, allowZero = false) => {
  if (!Number.isInteger(value)) {
    throw new Error(`请输入${label}。`);
  }
  const min = allowZero ? 0 : 1;
  if ((value ?? -1) < min || (value ?? -1) > 65535) {
    throw new Error(`${label}必须在 ${min} 到 65535 之间。`);
  }
  return value as number;
};

const resolveServerPort = (server: net.Server) => {
  const address = server.address();
  return typeof address === "object" && address ? address.port : undefined;
};

const listenTcpServer = (server: net.Server, host: string, port: number) =>
  new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(resolveServerPort(server) ?? port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

const forwardIn = (client: Client, host: string, port: number) =>
  new Promise<number>((resolve, reject) => {
    client.forwardIn(host, port, (error, assignedPort) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(assignedPort ?? port);
    });
  });

const unforwardIn = (client: Client, host: string, port: number) =>
  new Promise<void>((resolve, reject) => {
    client.unforwardIn(host, port, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const forwardOut = (
  client: Client,
  srcHost: string,
  srcPort: number,
  targetHost: string,
  targetPort: number
) =>
  new Promise<ClientChannel>((resolve, reject) => {
    client.forwardOut(srcHost, srcPort, targetHost, targetPort, (error, channel) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(channel);
    });
  });

const sourceAddressForForward = (socket: net.Socket, fallback = "127.0.0.1") => {
  const address = socket.remoteAddress;
  if (!address) {
    return fallback;
  }
  if (address === "::1") {
    return "127.0.0.1";
  }
  if (address.startsWith("::ffff:")) {
    return address.slice(7);
  }
  return address;
};

const closeTcpServer = (server: net.Server) =>
  new Promise<void>((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });

const destroyTunnelConnections = (tunnel: TunnelRuntime) => {
  for (const socket of tunnel.sockets) {
    socket.destroy();
  }
  for (const channel of tunnel.channels) {
    channel.destroy();
  }
  tunnel.sockets.clear();
  tunnel.channels.clear();
};

const closeProxyResources = (runtime: SshRuntime) => {
  runtime.proxySocket?.destroy();
  runtime.proxyClient?.end();
  runtime.proxySocket = undefined;
  runtime.proxyClient = undefined;
};

const bindTunnelStreams = (
  tunnel: TunnelRuntime,
  socket: net.Socket,
  channel: ClientChannel
) => {
  tunnel.connections += 1;
  tunnel.sockets.add(socket);
  tunnel.channels.add(channel);

  const onSocketData = (chunk: Buffer) => {
    tunnel.bytesUp += chunk.length;
  };
  const onChannelData = (chunk: Buffer) => {
    tunnel.bytesDown += chunk.length;
  };
  const cleanup = () => {
    socket.off("data", onSocketData);
    channel.off("data", onChannelData);
    tunnel.sockets.delete(socket);
    tunnel.channels.delete(channel);
  };

  socket.on("data", onSocketData);
  channel.on("data", onChannelData);
  socket.once("close", cleanup);
  channel.once("close", cleanup);
  socket.once("error", () => channel.destroy());
  channel.once("error", () => socket.destroy());
  socket.pipe(channel);
  channel.pipe(socket);
};

const sameRemoteBind = (tunnel: TunnelRuntime, details: TcpConnectionDetails) => {
  if (tunnel.type !== "remote" || tunnel.status !== "running") {
    return false;
  }
  if (tunnel.remotePort !== details.destPort) {
    return false;
  }
  const remoteHost = tunnel.remoteHost ?? "";
  return (
    remoteHost === "0.0.0.0" ||
    remoteHost === "::" ||
    remoteHost === "" ||
    remoteHost === details.destIP
  );
};

const findRemoteTunnel = (runtime: SshRuntime, details: TcpConnectionDetails) =>
  [...runtime.tunnels.values()].find((tunnel) => sameRemoteBind(tunnel, details));

const handleRemoteForwardConnection = (
  runtime: SshRuntime,
  details: TcpConnectionDetails,
  accept: () => ClientChannel,
  reject: () => void
) => {
  const tunnel = findRemoteTunnel(runtime, details);
  if (!tunnel?.targetHost || !tunnel.targetPort) {
    reject();
    return;
  }

  let accepted = false;
  const socket = net.createConnection(
    {
      host: tunnel.targetHost,
      port: tunnel.targetPort
    },
    () => {
      accepted = true;
      const channel = accept();
      bindTunnelStreams(tunnel, socket, channel);
      emitTunnelsChanged(runtime);
    }
  );

  socket.once("error", (error) => {
    tunnel.lastError = error.message;
    if (!accepted) {
      reject();
    }
    socket.destroy();
    emitTunnelsChanged(runtime);
  });
};

const closeTunnel = async (
  runtime: SshRuntime,
  tunnelId: string,
  options: { unforwardRemote?: boolean } = {}
) => {
  const tunnel = runtime.tunnels.get(tunnelId);
  if (!tunnel) {
    return;
  }

  tunnel.status = "closed";
  destroyTunnelConnections(tunnel);

  if (tunnel.server) {
    await closeTcpServer(tunnel.server);
  }

  if (
    options.unforwardRemote &&
    tunnel.type === "remote" &&
    tunnel.remoteHost &&
    tunnel.remotePort
  ) {
    await unforwardIn(runtime.client, tunnel.remoteHost, tunnel.remotePort);
  }

  runtime.tunnels.delete(tunnel.id);
  emitTunnelsChanged(runtime);
};

const closeAllTunnels = async (
  runtime: SshRuntime,
  options: { unforwardRemote?: boolean } = {}
) => {
  const ids = [...runtime.tunnels.keys()];
  for (const id of ids) {
    await closeTunnel(runtime, id, options).catch(() => undefined);
  }
};

interface ParsedSocksRequest {
  host: string;
  port: number;
  pending: Buffer;
}

const parseSocksConnectRequest = (buffer: Buffer): ParsedSocksRequest | undefined => {
  if (buffer.length < 5) {
    return undefined;
  }

  const version = buffer[0];
  const command = buffer[1];
  const addressType = buffer[3];
  if (version !== 0x05 || command !== 0x01) {
    throw new Error("仅支持 SOCKS5 CONNECT。");
  }

  let offset = 4;
  let host = "";
  if (addressType === 0x01) {
    if (buffer.length < offset + 4 + 2) {
      return undefined;
    }
    host = [...buffer.subarray(offset, offset + 4)].join(".");
    offset += 4;
  } else if (addressType === 0x03) {
    const length = buffer[offset];
    if (buffer.length < offset + 1 + length + 2) {
      return undefined;
    }
    host = buffer.subarray(offset + 1, offset + 1 + length).toString("utf8");
    offset += 1 + length;
  } else if (addressType === 0x04) {
    if (buffer.length < offset + 16 + 2) {
      return undefined;
    }
    const parts: string[] = [];
    for (let index = 0; index < 16; index += 2) {
      parts.push(buffer.readUInt16BE(offset + index).toString(16));
    }
    host = parts.join(":");
    offset += 16;
  } else {
    throw new Error("不支持的 SOCKS 地址类型。");
  }

  const port = buffer.readUInt16BE(offset);
  offset += 2;
  return {
    host,
    port,
    pending: buffer.subarray(offset)
  };
};

const writeSocksReply = (socket: net.Socket, code: number) => {
  const reply = Buffer.from([0x05, code, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  return new Promise<void>((resolve) => {
    if (!socket.writable) {
      resolve();
      return;
    }
    socket.write(reply, () => resolve());
  });
};

const handleSocksConnection = (
  runtime: SshRuntime,
  tunnel: TunnelRuntime,
  socket: net.Socket
) => {
  let buffer = Buffer.alloc(0);
  let stage: "greeting" | "request" = "greeting";

  const fail = (message: string, replyCode = 0x01) => {
    tunnel.lastError = message;
    void writeSocksReply(socket, replyCode).finally(() => socket.destroy());
    emitTunnelsChanged(runtime);
  };

  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    try {
      if (stage === "greeting") {
        if (buffer.length < 2) {
          return;
        }
        const version = buffer[0];
        const methodCount = buffer[1];
        if (buffer.length < 2 + methodCount) {
          return;
        }
        const methods = buffer.subarray(2, 2 + methodCount);
        if (version !== 0x05 || !methods.includes(0x00)) {
          socket.write(Buffer.from([0x05, 0xff]), () => socket.destroy());
          return;
        }
        socket.write(Buffer.from([0x05, 0x00]));
        buffer = buffer.subarray(2 + methodCount);
        stage = "request";
      }

      if (stage === "request") {
        const parsed = parseSocksConnectRequest(buffer);
        if (!parsed) {
          return;
        }

        socket.off("data", onData);
        socket.pause();
        void forwardOut(
          runtime.client,
          sourceAddressForForward(socket),
          socket.remotePort ?? 0,
          parsed.host,
          parsed.port
        )
          .then(async (channel) => {
            await writeSocksReply(socket, 0x00);
            bindTunnelStreams(tunnel, socket, channel);
            if (parsed.pending.length > 0) {
              channel.write(parsed.pending);
            }
            socket.resume();
            emitTunnelsChanged(runtime);
          })
          .catch((error) => fail(getErrorMessage(error), 0x05));
      }
    } catch (error) {
      fail(getErrorMessage(error), 0x07);
    }
  };

  socket.on("data", onData);
  socket.once("error", (error) => {
    tunnel.lastError = error.message;
    socket.destroy();
    emitTunnelsChanged(runtime);
  });
};

const createBaseTunnel = (
  runtime: SshRuntime,
  request: TunnelCreateRequest,
  values: Pick<
    TunnelRuntime,
    "localHost" | "localPort" | "remoteHost" | "remotePort" | "targetHost" | "targetPort"
  >
): TunnelRuntime => ({
  id: randomUUID(),
  sessionId: runtime.id,
  type: request.type,
  name: request.name?.trim() || tunnelTypeLabel(request.type),
  status: "running",
  createdAt: Date.now(),
  connections: 0,
  bytesUp: 0,
  bytesDown: 0,
  sockets: new Set(),
  channels: new Set(),
  ...values
});

const createLocalTunnel = async (
  runtime: SshRuntime,
  request: TunnelCreateRequest
) => {
  const localHost = normalizeTunnelHost(request.localHost, "127.0.0.1");
  const localPort = normalizeTunnelPort(request.localPort, "本地监听端口", true);
  const targetHost = normalizeTunnelHost(request.targetHost, "127.0.0.1");
  const targetPort = normalizeTunnelPort(request.targetPort, "目标端口");
  const tunnel = createBaseTunnel(runtime, request, {
    localHost,
    localPort,
    targetHost,
    targetPort
  });

  const server = net.createServer((socket) => {
    void forwardOut(
      runtime.client,
      sourceAddressForForward(socket, localHost),
      socket.remotePort ?? 0,
      targetHost,
      targetPort
    )
      .then((channel) => {
        bindTunnelStreams(tunnel, socket, channel);
        emitTunnelsChanged(runtime);
      })
      .catch((error) => {
        tunnel.lastError = getErrorMessage(error);
        socket.destroy();
        emitTunnelsChanged(runtime);
      });
  });

  const assignedPort = await listenTcpServer(server, localHost, localPort);
  tunnel.localPort = assignedPort;
  tunnel.server = server;
  server.on("error", (error) => {
    tunnel.status = "error";
    tunnel.lastError = error.message;
    emitTunnelsChanged(runtime);
  });
  runtime.tunnels.set(tunnel.id, tunnel);
  emitTunnelsChanged(runtime);
  return toTunnelInfo(tunnel);
};

const createDynamicTunnel = async (
  runtime: SshRuntime,
  request: TunnelCreateRequest
) => {
  const localHost = normalizeTunnelHost(request.localHost, "127.0.0.1");
  const localPort = normalizeTunnelPort(request.localPort, "SOCKS 监听端口", true);
  const tunnel = createBaseTunnel(runtime, request, {
    localHost,
    localPort
  });

  const server = net.createServer((socket) => handleSocksConnection(runtime, tunnel, socket));
  const assignedPort = await listenTcpServer(server, localHost, localPort);
  tunnel.localPort = assignedPort;
  tunnel.server = server;
  server.on("error", (error) => {
    tunnel.status = "error";
    tunnel.lastError = error.message;
    emitTunnelsChanged(runtime);
  });
  runtime.tunnels.set(tunnel.id, tunnel);
  emitTunnelsChanged(runtime);
  return toTunnelInfo(tunnel);
};

const createRemoteTunnel = async (
  runtime: SshRuntime,
  request: TunnelCreateRequest
) => {
  const remoteHost = normalizeTunnelHost(request.remoteHost, "127.0.0.1");
  const remotePort = normalizeTunnelPort(request.remotePort, "远端监听端口", true);
  const targetHost = normalizeTunnelHost(request.targetHost, "127.0.0.1");
  const targetPort = normalizeTunnelPort(request.targetPort, "本地目标端口");
  const tunnel = createBaseTunnel(runtime, request, {
    remoteHost,
    remotePort,
    targetHost,
    targetPort
  });

  const assignedPort = await forwardIn(runtime.client, remoteHost, remotePort);
  tunnel.remotePort = assignedPort;
  runtime.tunnels.set(tunnel.id, tunnel);
  emitTunnelsChanged(runtime);
  return toTunnelInfo(tunnel);
};

const createTunnel = (runtime: SshRuntime, request: TunnelCreateRequest) => {
  switch (request.type) {
    case "local":
      return createLocalTunnel(runtime, request);
    case "remote":
      return createRemoteTunnel(runtime, request);
    case "dynamic":
      return createDynamicTunnel(runtime, request);
  }
};

const validateSecretKey = (key: string) => {
  const safeKey = key.trim();
  if (!/^[a-zA-Z0-9:._-]{1,160}$/.test(safeKey)) {
    throw new Error("无效的密钥名称。");
  }
  return safeKey;
};

const getSecretStorePath = () =>
  path.join(app.getPath("userData"), secretStoreFileName);

const getKnownHostsPath = () =>
  path.join(app.getPath("userData"), knownHostsFileName);

const sanitizeFileName = (value: string) => {
  const safeName = value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return safeName || "session";
};

const timestampForFileName = () =>
  new Date().toISOString().replace(/[:.]/g, "-");

const terminalLogDirectory = () =>
  path.join(app.getPath("documents"), "XShell NG Logs");

const appendTerminalLog = (sessionId: string, data: string) => {
  const stream = terminalLogs.get(sessionId);
  if (!stream || stream.destroyed) {
    return;
  }
  stream.write(data);
};

const stopTerminalLog = (sessionId: string) => {
  const stream = terminalLogs.get(sessionId);
  if (!stream) {
    return;
  }
  terminalLogs.delete(sessionId);
  stream.end();
};

const startTerminalLog = async (
  request: TerminalLogStartRequest
): Promise<TerminalLogStartResponse> => {
  stopTerminalLog(request.sessionId);

  const directory = terminalLogDirectory();
  await fs.promises.mkdir(directory, { recursive: true });
  const label = sanitizeFileName(
    `${request.profileName || request.username}@${request.host}`
  );
  const filePath = path.join(directory, `${timestampForFileName()}_${label}.log`);
  const stream = fs.createWriteStream(filePath, { flags: "a", encoding: "utf8" });
  terminalLogs.set(request.sessionId, stream);
  stream.write(
    `XShell NG terminal log\nSession: ${request.username}@${request.host}\nStarted: ${new Date().toISOString()}\n\n`
  );
  return { filePath };
};

const readSecretStore = async () => {
  try {
    const raw = await fs.promises.readFile(getSecretStorePath(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
};

const writeSecretStore = async (store: Record<string, string>) => {
  await fs.promises.mkdir(path.dirname(getSecretStorePath()), { recursive: true });
  await fs.promises.writeFile(
    getSecretStorePath(),
    JSON.stringify(store, null, 2),
    "utf8"
  );
};

const readKnownHosts = async () => {
  try {
    const raw = await fs.promises.readFile(getKnownHostsPath(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, KnownHostRecord>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
};

const writeKnownHosts = async (store: Record<string, KnownHostRecord>) => {
  await fs.promises.mkdir(path.dirname(getKnownHostsPath()), { recursive: true });
  await fs.promises.writeFile(
    getKnownHostsPath(),
    JSON.stringify(store, null, 2),
    "utf8"
  );
};

const encryptSecret = (value: string) => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("系统加密存储当前不可用，无法保存密码。");
  }
  return `safe:${safeStorage.encryptString(value).toString("base64")}`;
};

const decryptSecret = (value: string) => {
  if (value.startsWith("safe:")) {
    return safeStorage.decryptString(Buffer.from(value.slice(5), "base64"));
  }
  if (value.startsWith("plain:")) {
    return Buffer.from(value.slice(6), "base64").toString("utf8");
  }
  return undefined;
};

const knownHostId = (host: string, port: number) => {
  const safeHost = host.trim().toLowerCase();
  return port === 22 ? safeHost : `[${safeHost}]:${port}`;
};

const formatHostFingerprint = (key: Buffer) =>
  `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;

const readSshString = (buffer: Buffer, offset = 0) => {
  if (buffer.length < offset + 4) {
    return undefined;
  }

  const length = buffer.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + length;
  if (length <= 0 || end > buffer.length) {
    return undefined;
  }
  return buffer.subarray(start, end).toString("ascii");
};

const hostKeyAlgorithm = (key: Buffer) =>
  readSshString(key) || "unknown";

const confirmHostKey = async (
  win: BrowserWindow,
  profile: ConnectRequest["profile"],
  record: KnownHostRecord | undefined,
  fingerprint: string,
  keyAlgorithm: string
) => {
  const host = profile.host.trim();
  const port = profile.port;
  const changed = Boolean(record && record.fingerprint !== fingerprint);

  const result = await dialog.showMessageBox(win, {
    type: changed ? "warning" : "question",
    title: changed ? "SSH 主机密钥已改变" : "确认 SSH 主机密钥",
    message: changed
      ? `服务器 ${host}:${port} 的主机密钥已改变。`
      : `首次连接 ${host}:${port}，是否信任此服务器主机密钥？`,
    detail: changed
      ? [
          "如果你没有主动重装服务器或更换 SSH 主机密钥，请取消连接。",
          "",
          `当前指纹：${fingerprint}`,
          `已保存指纹：${record?.fingerprint ?? "无"}`,
          `密钥算法：${keyAlgorithm}`,
          record?.lastSeenAt ? `上次确认：${new Date(record.lastSeenAt).toLocaleString("zh-CN")}` : ""
        ]
          .filter(Boolean)
          .join("\n")
      : [
          "请确认这枚指纹与你的云服务器控制台或管理员提供的指纹一致。",
          "",
          `指纹：${fingerprint}`,
          `密钥算法：${keyAlgorithm}`
        ].join("\n"),
    buttons: changed ? ["取消连接", "更新并连接"] : ["取消连接", "信任并连接"],
    cancelId: 0,
    defaultId: 0,
    noLink: true
  });

  return result.response === 1;
};

const verifyAndStoreHostKey = async (
  win: BrowserWindow,
  profile: ConnectRequest["profile"],
  key: Buffer
) => {
  const host = profile.host.trim();
  const port = profile.port;
  const keyAlgorithm = hostKeyAlgorithm(key);
  const fingerprint = formatHostFingerprint(key);
  const id = knownHostId(host, port);
  const store = await readKnownHosts();
  const record = store[id];

  if (record?.fingerprint === fingerprint) {
    store[id] = {
      ...record,
      host,
      port,
      keyAlgorithm,
      lastSeenAt: new Date().toISOString()
    };
    await writeKnownHosts(store);
    return true;
  }

  const accepted = await confirmHostKey(win, profile, record, fingerprint, keyAlgorithm);
  if (!accepted) {
    return false;
  }

  const now = new Date().toISOString();
  store[id] = {
    host,
    port,
    keyAlgorithm,
    fingerprint,
    firstSeenAt: record?.firstSeenAt ?? now,
    lastSeenAt: now
  };
  await writeKnownHosts(store);
  return true;
};

const listKnownHostEntries = async (): Promise<KnownHostEntry[]> => {
  const store = await readKnownHosts();
  return Object.entries(store)
    .map(([id, record]) => ({
      id,
      host: record.host,
      port: record.port,
      keyAlgorithm: record.keyAlgorithm,
      fingerprint: record.fingerprint,
      firstSeenAt: record.firstSeenAt,
      lastSeenAt: record.lastSeenAt
    }))
    .sort((left, right) =>
      `${left.host}:${left.port}`.localeCompare(`${right.host}:${right.port}`, "zh-CN", {
        sensitivity: "base",
        numeric: true
      })
    );
};

const sanitizeProfileForExport = (profile: ProfileExportRequest["profiles"][number]) => ({
  ...profile,
  password: "",
  passphrase: "",
  rememberPassword: false
});

const coercePort = (value: unknown, fallback: number) => {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
};

const coerceKeepaliveInterval = (value: unknown) => {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 0 && seconds <= 300 ? seconds : 15;
};

const coerceReconnectLimit = (value: unknown) => {
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= 20 ? limit : 3;
};

const coerceProxyConfig = (
  value: unknown
): ProfileExportRequest["profiles"][number]["proxy"] => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as NonNullable<ProfileExportRequest["profiles"][number]["proxy"]>;
  if (candidate.type === "jump") {
    return typeof candidate.jumpProfileId === "string" && candidate.jumpProfileId
      ? {
          type: "jump",
          jumpProfileId: candidate.jumpProfileId
        }
      : undefined;
  }
  if (candidate.type === "socks5" || candidate.type === "http") {
    const host = typeof candidate.host === "string" ? candidate.host.trim() : "";
    return host
      ? {
          type: candidate.type,
          host,
          port: coercePort(candidate.port, candidate.type === "socks5" ? 1080 : 8080)
        }
      : undefined;
  }
  return undefined;
};

const coerceSavedTunnel = (value: unknown): SavedTunnelConfig | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<SavedTunnelConfig>;
  const type =
    candidate.type === "remote" || candidate.type === "dynamic" ? candidate.type : "local";
  const localPort = Number(candidate.localPort);
  const remotePort = Number(candidate.remotePort);
  const targetPort = Number(candidate.targetPort);
  return {
    id: typeof candidate.id === "string" && candidate.id ? candidate.id : randomUUID(),
    type,
    name:
      typeof candidate.name === "string" && candidate.name.trim()
        ? candidate.name.trim()
        : tunnelTypeLabel(type),
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
};

const coerceImportedProfile = (value: unknown): ProfileExportRequest["profiles"][number] | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<ProfileExportRequest["profiles"][number]>;
  const host = String(candidate.host ?? "").trim();
  const username = String(candidate.username ?? "").trim();
  if (!host || !username) {
    return undefined;
  }

  const port = Number(candidate.port ?? 22);
  const authMethod = candidate.authMethod === "privateKey" ? "privateKey" : "password";

  return {
    id: randomUUID(),
    name: String(candidate.name ?? `${username}@${host}`).trim() || `${username}@${host}`,
    group: String(candidate.group ?? "默认").trim() || "默认",
    host,
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 22,
    username,
    authMethod,
    password: "",
    rememberPassword: false,
    privateKeyPath: String(candidate.privateKeyPath ?? "").trim(),
    passphrase: "",
    color: typeof candidate.color === "string" ? candidate.color : undefined,
    tunnels: Array.isArray(candidate.tunnels)
      ? candidate.tunnels
          .map(coerceSavedTunnel)
          .filter((tunnel): tunnel is SavedTunnelConfig => Boolean(tunnel))
      : undefined,
    proxy: coerceProxyConfig(candidate.proxy),
    keepaliveInterval: coerceKeepaliveInterval(candidate.keepaliveInterval),
    autoReconnect: Boolean(candidate.autoReconnect),
    reconnectLimit: coerceReconnectLimit(candidate.reconnectLimit)
  };
};

const readProfilesFromDocument = (raw: string) => {
  const parsed = JSON.parse(raw) as unknown;
  const source = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { profiles?: unknown }).profiles)
      ? (parsed as { profiles: unknown[] }).profiles
      : [];

  return source
    .map(coerceImportedProfile)
    .filter((profile): profile is ProfileExportRequest["profiles"][number] => Boolean(profile));
};

const sendStatus = (
  runtime: SshRuntime,
  status: SshStatusEvent["status"],
  message: string
) => {
  if (!runtime.window.isDestroyed()) {
    runtime.window.webContents.send("ssh:status", {
      sessionId: runtime.id,
      status,
      message
    } satisfies SshStatusEvent);
  }
};

const sendWindowState = (win: BrowserWindow) => {
  if (!win.isDestroyed()) {
    win.webContents.send("window:state", {
      isFullScreen: win.isFullScreen(),
      isMaximized: win.isMaximized()
    });
  }
};

const setWindowFullScreen = (win: BrowserWindow, isFullScreen: boolean) => {
  if (win.isFullScreen() !== isFullScreen) {
    win.setFullScreen(isFullScreen);
  }
  sendWindowState(win);
  return win.isFullScreen();
};

const toggleWindowFullScreen = (win: BrowserWindow) =>
  setWindowFullScreen(win, !win.isFullScreen());

const toggleWindowMaximize = (win: BrowserWindow) => {
  if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
  sendWindowState(win);
  return win.isMaximized();
};

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 620,
    title: "XShell NG",
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: "#f3f4f6",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "../../renderer/index.html"));
  win.webContents.on("did-finish-load", () => {
    sendWindowState(win);
  });
  win.on("enter-full-screen", () => sendWindowState(win));
  win.on("leave-full-screen", () => sendWindowState(win));
  win.on("maximize", () => sendWindowState(win));
  win.on("unmaximize", () => sendWindowState(win));
  win.on("restore", () => sendWindowState(win));

  win.on("closed", () => {
    for (const runtime of sessions.values()) {
      if (runtime.window === win) {
        stopTerminalLog(runtime.id);
        closeRemoteEditSessionsForSession(runtime.id, "窗口已关闭，远端编辑已停止。");
        closeProxyResources(runtime);
        runtime.sftp?.end();
        runtime.stream?.destroy();
        runtime.client.end();
        sessions.delete(runtime.id);
      }
    }
  });

  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") {
      return;
    }

    if (input.key === "F11") {
      event.preventDefault();
      toggleWindowFullScreen(win);
      return;
    }

    if (input.key === "Escape" && win.isFullScreen()) {
      event.preventDefault();
      setWindowFullScreen(win, false);
      return;
    }

    if (isDevelopment) {
      if (input.control && input.shift && input.key.toLowerCase() === "i") {
        win.webContents.openDevTools({ mode: "detach" });
      }
    }
  });
};

const sendCommandToFocusedWindow = (command: string) => {
  const win = BrowserWindow.getFocusedWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send("app:command", command);
  }
};

const toggleFullScreenForFocusedWindow = () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win && !win.isDestroyed()) {
    toggleWindowFullScreen(win);
  }
};

const buildMenu = () => {
  const menu = Menu.buildFromTemplate([
    {
      label: "文件",
      submenu: [
        {
          label: "新建连接配置",
          accelerator: "Ctrl+N",
          click: () => sendCommandToFocusedWindow("new-session")
        },
        {
          label: "快速连接",
          accelerator: "Ctrl+Q",
          click: () => sendCommandToFocusedWindow("quick-connect")
        },
        { type: "separator" },
        {
          label: "导入连接配置",
          click: () => sendCommandToFocusedWindow("import-profiles")
        },
        {
          label: "导出连接配置",
          click: () => sendCommandToFocusedWindow("export-profiles")
        },
        { type: "separator" },
        { role: "quit", label: "退出" }
      ]
    },
    {
      label: "会话",
      submenu: [
        {
          label: "断开当前会话",
          click: () => sendCommandToFocusedWindow("disconnect-tab")
        },
        {
          label: "重新连接当前标签",
          accelerator: "Ctrl+Shift+R",
          click: () => sendCommandToFocusedWindow("reconnect-tab")
        },
        {
          label: "复制当前标签",
          click: () => sendCommandToFocusedWindow("duplicate-tab")
        },
        { type: "separator" },
        {
          label: "关闭标签",
          accelerator: "Ctrl+W",
          click: () => sendCommandToFocusedWindow("close-tab")
        }
      ]
    },
    {
      label: "编辑",
      submenu: [
        {
          label: "复制",
          accelerator: "Ctrl+C",
          click: () => sendCommandToFocusedWindow("copy")
        },
        {
          label: "粘贴",
          accelerator: "Ctrl+V",
          click: () => sendCommandToFocusedWindow("paste")
        },
        {
          label: "全选",
          accelerator: "Ctrl+A",
          click: () => sendCommandToFocusedWindow("select-all")
        },
        { type: "separator" },
        {
          label: "查找",
          accelerator: "Ctrl+F",
          click: () => sendCommandToFocusedWindow("open-search")
        },
        {
          label: "查找下一个",
          accelerator: "F3",
          click: () => sendCommandToFocusedWindow("search-next")
        },
        {
          label: "查找上一个",
          accelerator: "Shift+F3",
          click: () => sendCommandToFocusedWindow("search-previous")
        }
      ]
    },
    {
      label: "查看",
      submenu: [
        { role: "reload", label: "重新载入" },
        {
          label: "切换全屏",
          accelerator: "F11",
          click: toggleFullScreenForFocusedWindow
        },
        {
          label: "切换侧栏",
          accelerator: "Ctrl+B",
          click: () => sendCommandToFocusedWindow("toggle-sidebar")
        },
        ...(isDevelopment
          ? [{ role: "toggleDevTools" as const, label: "开发者工具" }]
          : [])
      ]
    },
    {
      label: "工具",
      submenu: [
        {
          label: "快速命令",
          click: () => sendCommandToFocusedWindow("open-quick-commands")
        },
        {
          label: "SFTP 文件传输",
          click: () => sendCommandToFocusedWindow("open-sftp")
        },
        {
          label: "SSH 隧道",
          click: () => sendCommandToFocusedWindow("open-tunnels")
        },
        {
          label: "主机密钥",
          click: () => sendCommandToFocusedWindow("open-known-hosts")
        },
        { type: "separator" },
        {
          label: "设置",
          click: () => sendCommandToFocusedWindow("open-preferences")
        }
      ]
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "关于 XShell NG",
          click: () => {
            dialog.showMessageBox({
              type: "info",
              title: "关于 XShell NG",
              message: "XShell NG",
              detail:
                "一个原创的标签式 SSH 客户端原型，目标是覆盖连接配置、标签式 SSH 会话和 SFTP 工作流。"
            });
          }
        }
      ]
    }
  ]);

  Menu.setApplicationMenu(menu);
};

const validateConnectRequest = (request: ConnectRequest) => {
  const { profile, proxyProfile } = request;
  validateSshProfile(profile, "SSH");
  const proxy = profile.proxy;
  if (proxy?.type === "jump") {
    if (!proxy.jumpProfileId || !proxyProfile) {
      throw new Error("请选择跳板连接配置。");
    }
    if (proxyProfile.id === profile.id) {
      throw new Error("跳板配置不能指向自身。");
    }
    validateSshProfile(proxyProfile, "跳板");
  }
  if (proxy?.type === "socks5" || proxy?.type === "http") {
    if (!proxy.host?.trim()) {
      throw new Error("请输入代理主机。");
    }
    const proxyPort = Number(proxy.port);
    if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
      throw new Error("代理端口必须在 1 到 65535 之间。");
    }
  }
};

const validateSshProfile = (profile: ConnectRequest["profile"], label: string) => {
  if (!profile.host.trim()) {
    throw new Error(`请输入${label}主机地址。`);
  }
  if (!profile.username.trim()) {
    throw new Error(`请输入${label}用户名。`);
  }
  if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) {
    throw new Error(`${label}端口必须在 1 到 65535 之间。`);
  }
  if (profile.authMethod === "password" && !profile.password) {
    throw new Error(`请输入${label}密码。`);
  }
  if (profile.authMethod === "privateKey" && !profile.privateKeyPath) {
    throw new Error(`请选择${label}私钥文件。`);
  }
};

const keepaliveIntervalMs = (seconds: number | undefined) => {
  if (!Number.isInteger(seconds) || seconds === undefined) {
    return 15000;
  }
  return seconds <= 0 ? 0 : Math.min(seconds, 300) * 1000;
};

const toConnectConfig = (request: ConnectRequest, win: BrowserWindow): ConnectConfig => {
  const { profile } = request;
  const keepaliveInterval = keepaliveIntervalMs(profile.keepaliveInterval);
  const config: ConnectConfig = {
    host: profile.host.trim(),
    port: profile.port,
    username: profile.username.trim(),
    readyTimeout: 20000,
    keepaliveInterval,
    keepaliveCountMax: 3,
    tryKeyboard: profile.authMethod === "password",
    hostVerifier: (key: Buffer, verify: VerifyCallback) => {
      void verifyAndStoreHostKey(win, profile, key)
        .then(verify)
        .catch(() => verify(false));
    }
  };

  if (profile.authMethod === "password") {
    config.password = profile.password;
  } else if (profile.privateKeyPath) {
    config.privateKey = fs.readFileSync(profile.privateKeyPath, "utf8");
    if (profile.passphrase) {
      config.passphrase = profile.passphrase;
    }
  }

  return config;
};

const configureKeyboardAuth = (client: Client, profile: ConnectRequest["profile"]) => {
  client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
    finish(prompts.map(() => profile.password ?? ""));
  });
};

const connectClientReady = (client: Client, config: ConnectConfig) =>
  new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      client.off("ready", onReady);
      client.off("error", onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    client.once("ready", onReady);
    client.once("error", onError);
    client.connect(config);
  });

const onceSocketData = (socket: net.Socket) =>
  new Promise<Buffer>((resolve, reject) => {
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (data: Buffer) => {
      cleanup();
      resolve(data);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("代理连接已关闭。"));
    };
    socket.once("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });

const readSocketUntil = (
  socket: net.Socket,
  isComplete: (buffer: Buffer) => boolean
) =>
  new Promise<Buffer>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (isComplete(buffer)) {
        cleanup();
        resolve(buffer);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("代理连接已关闭。"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });

const createTcpSocket = (host: string, port: number) =>
  new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };
    const onConnect = () => {
      cleanup();
      socket.setTimeout(0);
      resolve(socket);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => {
      cleanup();
      socket.destroy();
      reject(new Error("代理连接超时。"));
    };
    socket.setTimeout(20000);
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
  });

const encodeSocksHost = (host: string) => {
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    return Buffer.concat([
      Buffer.from([0x01]),
      Buffer.from(host.split(".").map((part) => Number(part)))
    ]);
  }
  const hostBuffer = Buffer.from(host, "utf8");
  if (hostBuffer.length > 255) {
    throw new Error("SOCKS5 代理目标主机名过长。");
  }
  return Buffer.concat([Buffer.from([0x03, hostBuffer.length]), hostBuffer]);
};

const connectSocksProxy = async (
  proxy: NonNullable<ConnectRequest["profile"]["proxy"]>,
  targetHost: string,
  targetPort: number
) => {
  if (!proxy.host || !proxy.port) {
    throw new Error("SOCKS5 代理配置无效。");
  }
  const socket = await createTcpSocket(proxy.host, proxy.port);
  try {
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    const method = await onceSocketData(socket);
    if (method.length < 2 || method[0] !== 0x05 || method[1] !== 0x00) {
      throw new Error("SOCKS5 代理不支持免认证连接。");
    }

    const hostPart = encodeSocksHost(targetHost);
    const portPart = Buffer.allocUnsafe(2);
    portPart.writeUInt16BE(targetPort, 0);
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), hostPart, portPart]));
    const response = await readSocketUntil(socket, (buffer) => {
      if (buffer.length < 5) {
        return false;
      }
      const addressLength =
        buffer[3] === 0x01
          ? 4
          : buffer[3] === 0x04
            ? 16
            : buffer[3] === 0x03
              ? buffer[4] + 1
              : 0;
      return addressLength > 0 && buffer.length >= 4 + addressLength + 2;
    });
    if (response.length < 2 || response[0] !== 0x05 || response[1] !== 0x00) {
      throw new Error(`SOCKS5 代理连接目标失败，响应码 ${response[1] ?? "未知"}。`);
    }
    const addressLength =
      response[3] === 0x01
        ? 4
        : response[3] === 0x04
          ? 16
          : response[3] === 0x03
            ? response[4] + 1
            : 0;
    const replyLength = 4 + addressLength + 2;
    if (response.length > replyLength) {
      socket.unshift(response.subarray(replyLength));
    }
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
};

const connectHttpProxy = async (
  proxy: NonNullable<ConnectRequest["profile"]["proxy"]>,
  targetHost: string,
  targetPort: number
) => {
  if (!proxy.host || !proxy.port) {
    throw new Error("HTTP 代理配置无效。");
  }
  const socket = await createTcpSocket(proxy.host, proxy.port);
  try {
    socket.write(
      [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
        "Proxy-Connection: Keep-Alive",
        "",
        ""
      ].join("\r\n")
    );
    const response = await readSocketUntil(
      socket,
      (buffer) => buffer.indexOf("\r\n\r\n") >= 0
    );
    const header = response.toString("latin1");
    if (!/^HTTP\/1\.[01] 2\d\d\b/.test(header)) {
      throw new Error("HTTP 代理 CONNECT 失败。");
    }
    const headerEnd = header.indexOf("\r\n\r\n");
    if (headerEnd >= 0) {
      const bodyOffset = headerEnd + 4;
      if (response.length > bodyOffset) {
        socket.unshift(response.subarray(bodyOffset));
      }
    }
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
};

const createProxySocket = async (
  request: ConnectRequest,
  win: BrowserWindow
): Promise<{ socket?: Readable & Writable; proxyClient?: Client }> => {
  const proxy = request.profile.proxy;
  if (!proxy) {
    return {};
  }

  const targetHost = request.profile.host.trim();
  const targetPort = request.profile.port;
  if (proxy.type === "jump") {
    if (!request.proxyProfile) {
      throw new Error("请选择跳板连接配置。");
    }
    const proxyClient = new Client();
    configureKeyboardAuth(proxyClient, request.proxyProfile);
    const proxyConfig = toConnectConfig(
      {
        profile: request.proxyProfile,
        terminal: request.terminal
      },
      win
    );
    await connectClientReady(proxyClient, proxyConfig);
    proxyClient.on("error", () => undefined);
    const socket = await forwardOut(
      proxyClient,
      "127.0.0.1",
      0,
      targetHost,
      targetPort
    );
    return { socket, proxyClient };
  }

  if (proxy.type === "socks5") {
    return { socket: await connectSocksProxy(proxy, targetHost, targetPort) };
  }

  if (proxy.type === "http") {
    return { socket: await connectHttpProxy(proxy, targetHost, targetPort) };
  }

  return {};
};

const sortEntries = (entries: FileListEntry[]) =>
  entries.sort((left, right) => {
    if (left.kind === "directory" && right.kind !== "directory") {
      return -1;
    }
    if (left.kind !== "directory" && right.kind === "directory") {
      return 1;
    }
    return left.name.localeCompare(right.name, "zh-CN", {
      sensitivity: "base",
      numeric: true
    });
  });

const localKind = (stats: fs.Stats): FileEntryKind => {
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isFile()) {
    return "file";
  }
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  return "other";
};

const remoteKind = (entry: FileEntryWithStats): FileEntryKind => {
  if (entry.attrs.isDirectory()) {
    return "directory";
  }
  if (entry.attrs.isFile()) {
    return "file";
  }
  if (entry.attrs.isSymbolicLink()) {
    return "symlink";
  }
  return "other";
};

const localParentPath = (directoryPath: string) => {
  const parentPath = path.dirname(directoryPath);
  return parentPath === directoryPath ? undefined : parentPath;
};

const remoteParentPath = (remotePath: string) => {
  if (!remotePath || remotePath === "/") {
    return undefined;
  }

  const parentPath = path.posix.dirname(remotePath);
  return parentPath === remotePath ? undefined : parentPath;
};

const joinRemotePath = (directoryPath: string, name: string) => {
  const safeName = name.trim();
  if (!safeName || safeName.includes("/") || safeName.includes("\\")) {
    throw new Error("名称不能包含路径分隔符。");
  }
  if (!directoryPath || directoryPath === ".") {
    return safeName;
  }
  if (directoryPath === "/") {
    return `/${safeName}`;
  }
  return `${directoryPath.replace(/\/+$/, "")}/${safeName}`;
};

const assertSafeName = (name: string) => {
  const safeName = name.trim();
  if (!safeName || safeName.includes("/") || safeName.includes("\\")) {
    throw new Error("名称不能包含路径分隔符。");
  }
  return safeName;
};

const getRuntime = (sessionId: string) => {
  const runtime = sessions.get(sessionId);
  if (!runtime) {
    throw new Error("当前 SSH 会话不可用，请先连接服务器。");
  }
  return runtime;
};

const getSftp = (sessionId: string) => {
  const runtime = getRuntime(sessionId);
  if (runtime.sftp) {
    return Promise.resolve(runtime.sftp);
  }

  return new Promise<SFTPWrapper>((resolve, reject) => {
    runtime.client.sftp((error, sftp) => {
      if (error) {
        reject(error);
        return;
      }

      runtime.sftp = sftp;
      sftp.on("close", () => {
        if (runtime.sftp === sftp) {
          runtime.sftp = undefined;
        }
      });
      resolve(sftp);
    });
  });
};

const sftpRealpath = (sftp: SFTPWrapper, targetPath: string) =>
  new Promise<string>((resolve, reject) => {
    sftp.realpath(targetPath, (error, absolutePath) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(absolutePath);
    });
  });

const sftpReaddir = (sftp: SFTPWrapper, targetPath: string) =>
  new Promise<FileEntryWithStats[]>((resolve, reject) => {
    sftp.readdir(targetPath, (error, entries) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(entries);
    });
  });

const sftpLstat = (sftp: SFTPWrapper, targetPath: string) =>
  new Promise<FileEntryWithStats["attrs"]>((resolve, reject) => {
    sftp.lstat(targetPath, (error, stats) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stats);
    });
  });

const trySftpLstat = async (sftp: SFTPWrapper, targetPath: string) => {
  try {
    return await sftpLstat(sftp, targetPath);
  } catch {
    return undefined;
  }
};

const pipeTransfer = (
  readable: Readable,
  writable: Writable,
  context: TransferContext,
  fileSize: number,
  onStep: (transferred: number, fileSize: number) => void
) =>
  new Promise<void>((resolve, reject) => {
    let transferred = 0;
    let settled = false;
    let abort!: () => void;
    let readableEnded = false;
    let writableDone = false;

    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      if (context.abortCurrent === abort) {
        context.abortCurrent = undefined;
      }

      readable.removeListener("data", handleData);
      readable.removeListener("end", handleReadableEnd);
      readable.removeListener("error", handleError);
      readable.removeListener("close", handleReadableClose);
      writable.removeListener("error", handleError);
      writable.removeListener("finish", handleFinish);
      writable.removeListener("close", handleWritableClose);

      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    abort = () => {
      const error = new TransferCanceledError();
      readable.destroy(error);
      writable.destroy(error);
      finish(error);
    };

    const handleData = (chunk: Buffer) => {
      transferred += chunk.length;
      onStep(transferred, fileSize);
      if (context.canceled) {
        abort();
      }
    };

    const finishIfFullyTransferred = () => {
      if (context.canceled) {
        finish(new TransferCanceledError());
        return;
      }
      if (readableEnded && writableDone && transferred >= fileSize) {
        onStep(fileSize, fileSize);
        finish();
      }
    };

    const handleError = (error: Error) => finish(error);
    const handleReadableEnd = () => {
      readableEnded = true;
      finishIfFullyTransferred();
    };
    const handleFinish = () => {
      writableDone = true;
      finishIfFullyTransferred();
    };
    const handleReadableClose = () => {
      if (!settled && context.canceled) {
        finish(new TransferCanceledError());
      }
    };
    const handleWritableClose = () => {
      writableDone = true;
      finishIfFullyTransferred();
    };

    assertTransferNotCanceled(context);
    context.abortCurrent = abort;
    readable.on("data", handleData);
    readable.on("end", handleReadableEnd);
    readable.on("error", handleError);
    readable.on("close", handleReadableClose);
    writable.on("error", handleError);
    writable.on("finish", handleFinish);
    writable.on("close", handleWritableClose);
    readable.pipe(writable);
  });

const sftpMkdir = (sftp: SFTPWrapper, remotePath: string) =>
  new Promise<void>((resolve, reject) => {
    sftp.mkdir(remotePath, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const sftpRename = (sftp: SFTPWrapper, sourcePath: string, targetPath: string) =>
  new Promise<void>((resolve, reject) => {
    sftp.rename(sourcePath, targetPath, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const sftpUnlink = (sftp: SFTPWrapper, remotePath: string) =>
  new Promise<void>((resolve, reject) => {
    sftp.unlink(remotePath, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const sftpRmdir = (sftp: SFTPWrapper, remotePath: string) =>
  new Promise<void>((resolve, reject) => {
    sftp.rmdir(remotePath, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const sftpRemove = async (sftp: SFTPWrapper, remotePath: string) => {
  const stats = await sftpLstat(sftp, remotePath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    await sftpUnlink(sftp, remotePath);
    return;
  }

  const entries = await sftpReaddir(sftp, remotePath);
  for (const entry of entries) {
    if (entry.filename === "." || entry.filename === "..") {
      continue;
    }

    await sftpRemove(sftp, joinRemotePath(remotePath, entry.filename));
  }

  await sftpRmdir(sftp, remotePath);
};

const ensureRemoteDirectory = async (sftp: SFTPWrapper, remoteDirectory: string) => {
  if (!remoteDirectory || remoteDirectory === "." || remoteDirectory === "/") {
    return;
  }

  const existing = await trySftpLstat(sftp, remoteDirectory);
  if (existing) {
    if (!existing.isDirectory()) {
      throw new Error(`远端路径不是目录：${remoteDirectory}`);
    }
    return;
  }

  await ensureRemoteDirectory(sftp, path.posix.dirname(remoteDirectory));
  await sftpMkdir(sftp, remoteDirectory);
};

const createTransferSummary = (): TransferSummary => ({
  files: 0,
  directories: 0,
  bytes: 0,
  skipped: 0
});

class TransferCanceledError extends Error {
  constructor() {
    super("传输已取消");
    this.name = "TransferCanceledError";
  }
}

interface TransferContext {
  webContents: WebContents;
  transferId: string;
  direction: TransferDirection;
  summary: TransferSummary;
  total: TransferSummary;
  currentPath?: string;
  activeFileBytes?: number;
  activeFileTransferred?: number;
  lastEmitAt: number;
  canceled: boolean;
  abortCurrent?: () => void;
}

const copyTransferSummary = (summary: TransferSummary): TransferSummary => ({
  files: summary.files,
  directories: summary.directories,
  bytes: summary.bytes,
  skipped: summary.skipped
});

const transferItemCount = (summary: TransferSummary) =>
  summary.files + summary.directories + summary.skipped;

const isTransferCanceledError = (error: unknown) =>
  error instanceof TransferCanceledError ||
  (error instanceof Error && error.name === "TransferCanceledError");

const assertTransferNotCanceled = (context?: TransferContext) => {
  if (context?.canceled) {
    throw new TransferCanceledError();
  }
};

const cancelTransfer = (context: TransferContext) => {
  if (context.canceled) {
    return;
  }

  context.canceled = true;
  context.abortCurrent?.();
};

const transferPercent = (context: TransferContext) => {
  if (context.total.bytes > 0) {
    return Math.min(
      100,
      Math.round(
        ((context.summary.bytes + (context.activeFileTransferred ?? 0)) /
          context.total.bytes) *
          100
      )
    );
  }

  const totalItems = transferItemCount(context.total);
  if (totalItems === 0) {
    return 0;
  }

  return Math.min(
    100,
    Math.round((transferItemCount(context.summary) / totalItems) * 100)
  );
};

const emitTransferProgress = (
  context: TransferContext,
  status: TransferProgressEvent["status"],
  message: string,
  options: { force?: boolean; currentPath?: string } = {}
) => {
  const now = Date.now();
  if (!options.force && status === "running" && now - context.lastEmitAt < 120) {
    return;
  }

  context.lastEmitAt = now;
  if (options.currentPath) {
    context.currentPath = options.currentPath;
  }

  context.webContents.send("sftp:transfer-progress", {
    transferId: context.transferId,
    direction: context.direction,
    status,
    message,
    summary: copyTransferSummary(context.summary),
    total: copyTransferSummary(context.total),
    currentPath: context.currentPath,
    activeFileBytes: context.activeFileBytes,
    activeFileTransferred: context.activeFileTransferred,
    percent: status === "completed" ? 100 : transferPercent(context)
  } satisfies TransferProgressEvent);
};

const scanLocalEntry = async (
  localPath: string,
  summary = createTransferSummary(),
  context?: TransferContext
) => {
  assertTransferNotCanceled(context);
  const stats = await fs.promises.lstat(localPath);
  if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
    summary.skipped += 1;
    return summary;
  }

  if (stats.isFile()) {
    summary.files += 1;
    summary.bytes += stats.size;
    return summary;
  }

  summary.directories += 1;
  const entries = await fs.promises.readdir(localPath);
  for (const entry of entries) {
    await scanLocalEntry(path.join(localPath, entry), summary, context);
  }
  return summary;
};

const scanRemoteEntry = async (
  sftp: SFTPWrapper,
  remotePath: string,
  summary = createTransferSummary(),
  context?: TransferContext
) => {
  assertTransferNotCanceled(context);
  const stats = await sftpLstat(sftp, remotePath);
  assertTransferNotCanceled(context);
  if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
    summary.skipped += 1;
    return summary;
  }

  if (stats.isFile()) {
    summary.files += 1;
    summary.bytes += stats.size;
    return summary;
  }

  summary.directories += 1;
  const entries = await sftpReaddir(sftp, remotePath);
  for (const entry of entries) {
    if (entry.filename === "." || entry.filename === "..") {
      continue;
    }
    await scanRemoteEntry(sftp, joinRemotePath(remotePath, entry.filename), summary, context);
  }
  return summary;
};

const normalizeConflictPolicy = (
  policy: SftpConflictPolicy | undefined
): SftpConflictPolicy => policy ?? "overwrite";

const splitNameExtension = (name: string) => {
  const extension = path.extname(name);
  const base = extension ? name.slice(0, -extension.length) : name;
  return { base: base || name, extension };
};

const uniqueLocalPath = async (directoryPath: string, name: string) => {
  const safeName = assertSafeName(name);
  const { base, extension } = splitNameExtension(safeName);
  for (let index = 1; index < 10000; index += 1) {
    const candidateName = index === 1 ? safeName : `${base} (${index})${extension}`;
    const candidatePath = path.join(directoryPath, candidateName);
    try {
      await fs.promises.lstat(candidatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { path: candidatePath, name: candidateName };
      }
      throw error;
    }
  }
  throw new Error(`无法生成不冲突的本地名称：${safeName}`);
};

const uniqueRemotePath = async (
  sftp: SFTPWrapper,
  remoteDirectory: string,
  name: string
) => {
  const safeName = assertSafeName(name);
  const parsed = path.posix.parse(safeName);
  const base = parsed.name || safeName;
  const extension = parsed.ext;
  for (let index = 1; index < 10000; index += 1) {
    const candidateName = index === 1 ? safeName : `${base} (${index})${extension}`;
    const candidatePath = joinRemotePath(remoteDirectory, candidateName);
    const existing = await trySftpLstat(sftp, candidatePath);
    if (!existing) {
      return { path: candidatePath, name: candidateName };
    }
  }
  throw new Error(`无法生成不冲突的远端名称：${safeName}`);
};

const resolveRemoteTarget = async (
  sftp: SFTPWrapper,
  remoteDirectory: string,
  targetName: string,
  kind: "file" | "directory",
  policy: SftpConflictPolicy,
  summary: TransferSummary,
  context?: TransferContext
) => {
  const remotePath = joinRemotePath(remoteDirectory, targetName);
  const existing = await trySftpLstat(sftp, remotePath);
  if (!existing) {
    return { path: remotePath, name: targetName, skipped: false };
  }

  if (policy === "skip") {
    summary.skipped += 1;
    context &&
      emitTransferProgress(context, "running", `跳过已存在的远端项目 ${targetName}`, {
        force: true
      });
    return { path: remotePath, name: targetName, skipped: true };
  }

  if (policy === "rename") {
    const unique = await uniqueRemotePath(sftp, remoteDirectory, targetName);
    context &&
      emitTransferProgress(context, "running", `已重命名远端目标为 ${unique.name}`, {
        force: true
      });
    return { path: unique.path, name: unique.name, skipped: false };
  }

  const existingKind = existing.isDirectory() && !existing.isSymbolicLink() ? "directory" : "file";
  if (existingKind !== kind) {
    throw new Error(`远端已存在不同类型项目：${remotePath}`);
  }
  return { path: remotePath, name: targetName, skipped: false };
};

const resolveLocalTarget = async (
  localDirectory: string,
  targetName: string,
  kind: "file" | "directory",
  policy: SftpConflictPolicy,
  summary: TransferSummary,
  context?: TransferContext
) => {
  const safeName = assertSafeName(targetName);
  const localPath = path.join(localDirectory, safeName);
  let existing: fs.Stats | undefined;
  try {
    existing = await fs.promises.lstat(localPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  if (!existing) {
    return { path: localPath, name: safeName, skipped: false };
  }

  if (policy === "skip") {
    summary.skipped += 1;
    context &&
      emitTransferProgress(context, "running", `跳过已存在的本地项目 ${safeName}`, {
        force: true
      });
    return { path: localPath, name: safeName, skipped: true };
  }

  if (policy === "rename") {
    const unique = await uniqueLocalPath(localDirectory, safeName);
    context &&
      emitTransferProgress(context, "running", `已重命名本地目标为 ${unique.name}`, {
        force: true
      });
    return { path: unique.path, name: unique.name, skipped: false };
  }

  const existingKind = existing.isDirectory() ? "directory" : "file";
  if (existingKind !== kind) {
    throw new Error(`本地已存在不同类型项目：${localPath}`);
  }
  return { path: localPath, name: safeName, skipped: false };
};

const uploadLocalEntry = async (
  sftp: SFTPWrapper,
  localPath: string,
  remoteDirectory: string,
  remoteName: string | undefined,
  summary: TransferSummary,
  context?: TransferContext,
  conflictPolicy: SftpConflictPolicy = "overwrite"
) => {
  assertTransferNotCanceled(context);
  const stats = await fs.promises.lstat(localPath);
  const targetName = remoteName || path.basename(localPath);

  if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
    summary.skipped += 1;
    context && emitTransferProgress(context, "running", `跳过 ${targetName}`, {
      currentPath: localPath
    });
    return;
  }

  if (stats.isFile()) {
    await ensureRemoteDirectory(sftp, remoteDirectory);
    const target = await resolveRemoteTarget(
      sftp,
      remoteDirectory,
      targetName,
      "file",
      conflictPolicy,
      summary,
      context
    );
    if (target.skipped) {
      return;
    }
    context && (context.activeFileBytes = stats.size);
    context && (context.activeFileTransferred = 0);
    context &&
      emitTransferProgress(context, "running", `正在上传 ${target.name}`, {
        force: true,
        currentPath: localPath
      });
    const remotePath = target.path;
    try {
      if (context) {
        assertTransferNotCanceled(context);
        const readable = fs.createReadStream(localPath);
        const writable = sftp.createWriteStream(remotePath);
        await pipeTransfer(
          readable,
          writable,
          context,
          stats.size,
          (transferred, fileSize) => {
            context.activeFileBytes = fileSize;
            context.activeFileTransferred = transferred;
            emitTransferProgress(context, "running", `正在上传 ${target.name}`);
          }
        );
      }
    } catch (error) {
      if (isTransferCanceledError(error)) {
        await sftpUnlink(sftp, remotePath).catch(() => undefined);
      }
      throw error;
    }
    summary.files += 1;
    summary.bytes += stats.size;
    context && (context.activeFileBytes = undefined);
    context && (context.activeFileTransferred = undefined);
    context &&
      emitTransferProgress(context, "running", `已上传 ${target.name}`, {
        force: true,
        currentPath: localPath
      });
    return;
  }

  await ensureRemoteDirectory(sftp, remoteDirectory);
  const target = await resolveRemoteTarget(
    sftp,
    remoteDirectory,
    targetName,
    "directory",
    conflictPolicy,
    summary,
    context
  );
  if (target.skipped) {
    return;
  }
  const targetDirectory = target.path;
  await ensureRemoteDirectory(sftp, targetDirectory);
  summary.directories += 1;
  context &&
    emitTransferProgress(context, "running", `已准备目录 ${target.name}`, {
      currentPath: localPath
    });

  const entries = await fs.promises.readdir(localPath);
  for (const entry of entries) {
    await uploadLocalEntry(
      sftp,
      path.join(localPath, entry),
      targetDirectory,
      entry,
      summary,
      context,
      conflictPolicy
    );
  }
};

const downloadRemoteEntry = async (
  sftp: SFTPWrapper,
  remotePath: string,
  localDirectory: string,
  localName: string | undefined,
  summary: TransferSummary,
  context?: TransferContext,
  conflictPolicy: SftpConflictPolicy = "overwrite"
) => {
  assertTransferNotCanceled(context);
  const stats = await sftpLstat(sftp, remotePath);
  const targetName = assertSafeName(localName || path.posix.basename(remotePath));

  if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
    summary.skipped += 1;
    context && emitTransferProgress(context, "running", `跳过 ${targetName}`, {
      currentPath: remotePath
    });
    return;
  }

  if (stats.isFile()) {
    await fs.promises.mkdir(localDirectory, { recursive: true });
    const target = await resolveLocalTarget(
      localDirectory,
      targetName,
      "file",
      conflictPolicy,
      summary,
      context
    );
    if (target.skipped) {
      return;
    }
    context && (context.activeFileBytes = stats.size);
    context && (context.activeFileTransferred = 0);
    context &&
      emitTransferProgress(context, "running", `正在下载 ${target.name}`, {
        force: true,
        currentPath: remotePath
      });
    const localPath = target.path;
    try {
      if (context) {
        assertTransferNotCanceled(context);
        const readable = sftp.createReadStream(remotePath);
        const writable = fs.createWriteStream(localPath);
        await pipeTransfer(
          readable,
          writable,
          context,
          stats.size,
          (transferred, fileSize) => {
            context.activeFileBytes = fileSize;
            context.activeFileTransferred = transferred;
            emitTransferProgress(context, "running", `正在下载 ${target.name}`);
          }
        );
      }
    } catch (error) {
      if (isTransferCanceledError(error)) {
        await fs.promises.rm(localPath, { force: true }).catch(() => undefined);
      }
      throw error;
    }
    summary.files += 1;
    summary.bytes += stats.size;
    context && (context.activeFileBytes = undefined);
    context && (context.activeFileTransferred = undefined);
    context &&
      emitTransferProgress(context, "running", `已下载 ${target.name}`, {
        force: true,
        currentPath: remotePath
      });
    return;
  }

  const target = await resolveLocalTarget(
    localDirectory,
    targetName,
    "directory",
    conflictPolicy,
    summary,
    context
  );
  if (target.skipped) {
    return;
  }
  const targetDirectory = target.path;
  await fs.promises.mkdir(targetDirectory, { recursive: true });
  summary.directories += 1;
  context &&
    emitTransferProgress(context, "running", `已准备目录 ${target.name}`, {
      currentPath: remotePath
    });

  const entries = await sftpReaddir(sftp, remotePath);
  for (const entry of entries) {
    if (entry.filename === "." || entry.filename === "..") {
      continue;
    }
    await downloadRemoteEntry(
      sftp,
      joinRemotePath(remotePath, entry.filename),
      targetDirectory,
      entry.filename,
      summary,
      context,
      conflictPolicy
    );
  }
};

const emitRemoteEditStatus = (
  session: RemoteEditSession,
  status: SftpEditStatusEvent["status"],
  message: string,
  savedAt?: string
) => {
  if (session.window.isDestroyed()) {
    return;
  }

  session.window.webContents.send("sftp:edit-status", {
    editId: session.editId,
    sessionId: session.sessionId,
    remotePath: session.remotePath,
    localPath: session.localPath,
    name: session.name,
    status,
    message,
    savedAt
  } satisfies SftpEditStatusEvent);
};

const downloadRemoteFile = async (
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string
) => {
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
  await pipeline(sftp.createReadStream(remotePath), fs.createWriteStream(localPath));
};

const uploadEditedFile = async (session: RemoteEditSession) => {
  if (session.saving) {
    session.pendingSave = true;
    return;
  }

  session.saving = true;
  session.pendingSave = false;
  emitRemoteEditStatus(session, "saving", `正在回传 ${session.name}`);

  try {
    const localStats = await fs.promises.stat(session.localPath);
    if (localStats.mtimeMs <= session.lastSavedMtimeMs + 2) {
      return;
    }

    const sftp = await getSftp(session.sessionId);
    await pipeline(
      fs.createReadStream(session.localPath),
      sftp.createWriteStream(session.remotePath)
    );
    session.lastSavedMtimeMs = localStats.mtimeMs;
    const savedAt = new Date().toISOString();
    emitRemoteEditStatus(session, "saved", `已回传 ${session.name}`, savedAt);
  } catch (error) {
    emitRemoteEditStatus(session, "error", `回传失败：${getErrorMessage(error)}`);
  } finally {
    session.saving = false;
    if (session.pendingSave) {
      session.pendingSave = false;
      session.saveTimer = setTimeout(() => {
        session.saveTimer = undefined;
        void uploadEditedFile(session);
      }, 700);
    }
  }
};

const scheduleRemoteEditSave = (editId: string) => {
  const session = remoteEditSessions.get(editId);
  if (!session) {
    return;
  }

  if (session.saveTimer) {
    clearTimeout(session.saveTimer);
  }
  session.saveTimer = setTimeout(() => {
    session.saveTimer = undefined;
    void uploadEditedFile(session);
  }, 700);
};

const closeRemoteEditSession = (editId: string, message = "远端编辑已关闭。") => {
  const session = remoteEditSessions.get(editId);
  if (!session) {
    return;
  }

  if (session.saveTimer) {
    clearTimeout(session.saveTimer);
  }
  session.watcher?.close();
  remoteEditSessions.delete(editId);
  emitRemoteEditStatus(session, "closed", message);
};

const closeRemoteEditSessionsForSession = (sessionId: string, message: string) => {
  const editIds = [...remoteEditSessions.values()]
    .filter((session) => session.sessionId === sessionId)
    .map((session) => session.editId);
  for (const editId of editIds) {
    closeRemoteEditSession(editId, message);
  }
};

const openRemoteEditSession = async (
  win: BrowserWindow,
  request: SftpEditOpenRequest
): Promise<SftpEditOpenResponse> => {
  const runtime = getRuntime(request.sessionId);
  const sftp = await getSftp(request.sessionId);
  const stats = await sftpLstat(sftp, request.remotePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("只能编辑远端普通文件。");
  }

  const editId = randomUUID();
  const remoteName = request.name || path.posix.basename(request.remotePath);
  const localName = sanitizeFileName(remoteName);
  const directoryPath = path.join(app.getPath("temp"), "xshell-ng-edits", runtime.id, editId);
  const localPath = path.join(directoryPath, localName);
  const openedAt = new Date().toISOString();

  const session: RemoteEditSession = {
    editId,
    sessionId: request.sessionId,
    remotePath: request.remotePath,
    localPath,
    directoryPath,
    localName,
    name: remoteName,
    window: win,
    saving: false,
    pendingSave: false,
    lastSavedMtimeMs: 0
  };

  emitRemoteEditStatus(session, "opening", `正在打开 ${remoteName}`);
  await downloadRemoteFile(sftp, request.remotePath, localPath);
  const localStats = await fs.promises.stat(localPath);
  session.lastSavedMtimeMs = localStats.mtimeMs;
  session.watcher = fs.watch(directoryPath, { persistent: false }, (_event, fileName) => {
    if (!fileName || fileName.toString() === localName) {
      scheduleRemoteEditSave(editId);
    }
  });
  remoteEditSessions.set(editId, session);

  const openError = await shell.openPath(localPath);
  if (openError) {
    closeRemoteEditSession(editId, `打开编辑器失败：${openError}`);
    throw new Error(openError);
  }

  emitRemoteEditStatus(session, "opened", `已打开 ${remoteName}`);
  return {
    editId,
    sessionId: request.sessionId,
    remotePath: request.remotePath,
    localPath,
    name: remoteName,
    openedAt
  };
};

ipcMain.handle(
  "ssh:connect",
  async (event, request: ConnectRequest): Promise<ConnectResponse> => {
    validateConnectRequest(request);

    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      throw new Error("无法找到当前窗口。");
    }
    const config = toConnectConfig(request, win);

    const id = randomUUID();
    const client = new Client();
    const runtime: SshRuntime = { id, client, window: win, tunnels: new Map() };
    sessions.set(id, runtime);

    configureKeyboardAuth(client, request.profile);

    client.on("tcp connection", (details, accept, reject) => {
      handleRemoteForwardConnection(runtime, details, accept, reject);
    });

    client.on("ready", () => {
      client.shell(
        {
          term: "xterm-256color",
          cols: request.terminal.cols,
          rows: request.terminal.rows
        },
        (error, stream) => {
          if (error) {
            sendStatus(runtime, "error", error.message);
            return;
          }

          runtime.stream = stream;
          sendStatus(runtime, "connected", "已连接");

          stream.on("data", (data: Buffer) => {
            appendTerminalLog(id, data.toString("utf8"));
            if (!win.isDestroyed()) {
              win.webContents.send("ssh:data", {
                sessionId: id,
                data: data.toString("utf8")
              });
            }
          });

          stream.stderr.on("data", (data: Buffer) => {
            appendTerminalLog(id, data.toString("utf8"));
            if (!win.isDestroyed()) {
              win.webContents.send("ssh:data", {
                sessionId: id,
                data: data.toString("utf8")
              });
            }
          });

          stream.on("close", () => {
            void closeAllTunnels(runtime);
            stopTerminalLog(id);
            closeRemoteEditSessionsForSession(id, "连接已关闭，远端编辑已停止。");
            closeProxyResources(runtime);
            sendStatus(runtime, "disconnected", "连接已关闭");
            sessions.delete(id);
          });
        }
      );
    });

    client.on("error", (error) => {
      void closeAllTunnels(runtime);
      stopTerminalLog(id);
      closeRemoteEditSessionsForSession(id, "SSH 会话出错，远端编辑已停止。");
      closeProxyResources(runtime);
      sendStatus(runtime, "error", error.message);
      sessions.delete(id);
    });

    client.on("close", () => {
      void closeAllTunnels(runtime);
      stopTerminalLog(id);
      closeRemoteEditSessionsForSession(id, "SSH 会话已断开，远端编辑已停止。");
      closeProxyResources(runtime);
      sendStatus(runtime, "disconnected", "SSH 会话已断开");
      sessions.delete(id);
    });

    sendStatus(runtime, "connecting", "正在连接");
    try {
      const proxyResources = await createProxySocket(request, win);
      if (proxyResources.socket) {
        config.sock = proxyResources.socket;
        runtime.proxySocket = proxyResources.socket;
      }
      if (proxyResources.proxyClient) {
        runtime.proxyClient = proxyResources.proxyClient;
      }
      client.connect(config);
    } catch (error) {
      runtime.proxySocket?.destroy();
      runtime.proxyClient?.end();
      sessions.delete(id);
      throw error;
    }

    return { sessionId: id };
  }
);

ipcMain.handle("ssh:disconnect", async (_event, sessionId: string) => {
  const runtime = sessions.get(sessionId);
  if (!runtime) {
    return;
  }

  await closeAllTunnels(runtime, { unforwardRemote: true });
  stopTerminalLog(sessionId);
  closeRemoteEditSessionsForSession(sessionId, "连接已断开，远端编辑已停止。");
  closeProxyResources(runtime);
  runtime.sftp?.end();
  runtime.stream?.end();
  runtime.client.end();
  sessions.delete(sessionId);
  sendStatus(runtime, "disconnected", "连接已断开");
});

ipcMain.handle(
  "tunnel:list",
  async (_event, request: TunnelListRequest): Promise<TunnelInfo[]> =>
    listTunnelInfos(getRuntime(request.sessionId))
);

ipcMain.handle(
  "tunnel:create",
  async (_event, request: TunnelCreateRequest): Promise<TunnelCreateResponse> => {
    const runtime = getRuntime(request.sessionId);
    return {
      tunnel: await createTunnel(runtime, request)
    };
  }
);

ipcMain.handle("tunnel:close", async (_event, request: TunnelCloseRequest) => {
  const runtime = getRuntime(request.sessionId);
  await closeTunnel(runtime, request.tunnelId, { unforwardRemote: true });
});

ipcMain.handle("window:toggle-full-screen", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    return false;
  }
  return toggleWindowFullScreen(win);
});

ipcMain.handle("window:exit-full-screen", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    return false;
  }
  return setWindowFullScreen(win, false);
});

ipcMain.handle("window:minimize", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.minimize();
  }
});

ipcMain.handle("window:toggle-maximize", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    return false;
  }
  return toggleWindowMaximize(win);
});

ipcMain.handle("window:close", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.close();
  }
});

ipcMain.on("ssh:input", (_event, request: SendDataRequest) => {
  sessions.get(request.sessionId)?.stream?.write(request.data);
});

ipcMain.on("ssh:resize", (_event, request: ResizeRequest) => {
  const stream = sessions.get(request.sessionId)?.stream;
  stream?.setWindow(request.rows, request.cols, 0, 0);
});

ipcMain.handle(
  "terminal-log:start",
  async (_event, request: TerminalLogStartRequest): Promise<TerminalLogStartResponse> => {
    getRuntime(request.sessionId);
    return startTerminalLog(request);
  }
);

ipcMain.handle("terminal-log:stop", async (_event, request: TerminalLogStopRequest) => {
  stopTerminalLog(request.sessionId);
});

ipcMain.handle(
  "known-hosts:list",
  async (): Promise<KnownHostListResponse> => ({
    entries: await listKnownHostEntries()
  })
);

ipcMain.handle("known-hosts:delete", async (_event, request: KnownHostDeleteRequest) => {
  const id = request.id.trim();
  if (!id) {
    throw new Error("主机密钥记录无效。");
  }

  const store = await readKnownHosts();
  delete store[id];
  await writeKnownHosts(store);
});

ipcMain.handle("known-hosts:clear", async () => {
  await writeKnownHosts({});
});

ipcMain.handle("clipboard:read-text", async () => clipboard.readText());

ipcMain.handle("clipboard:write-text", async (_event, text: string) => {
  clipboard.writeText(text);
});

ipcMain.handle("secret:set", async (_event, request: SecretSetRequest) => {
  const key = validateSecretKey(request.key);
  const store = await readSecretStore();
  store[key] = encryptSecret(request.value);
  await writeSecretStore(store);
});

ipcMain.handle(
  "secret:get",
  async (_event, request: SecretGetRequest): Promise<string | undefined> => {
    const key = validateSecretKey(request.key);
    const store = await readSecretStore();
    const encrypted = store[key];
    return encrypted ? decryptSecret(encrypted) : undefined;
  }
);

ipcMain.handle("secret:delete", async (_event, request: SecretDeleteRequest) => {
  const key = validateSecretKey(request.key);
  const store = await readSecretStore();
  delete store[key];
  await writeSecretStore(store);
});

ipcMain.handle(
  "profiles:export",
  async (_event, request: ProfileExportRequest): Promise<ProfileExportResponse> => {
    const result = await dialog.showSaveDialog({
      title: "导出连接配置",
      defaultPath: `xshell-ng-profiles-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "XShell NG profiles", extensions: ["json"] }]
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    const document = {
      app: "XShell NG",
      version: 1,
      exportedAt: new Date().toISOString(),
      profiles: request.profiles.map(sanitizeProfileForExport)
    };

    await fs.promises.writeFile(
      result.filePath,
      JSON.stringify(document, null, 2),
      "utf8"
    );
    return { canceled: false, filePath: result.filePath };
  }
);

ipcMain.handle("profiles:import", async (): Promise<ProfileImportResponse> => {
  const result = await dialog.showOpenDialog({
    title: "导入连接配置",
    properties: ["openFile"],
    filters: [{ name: "XShell NG profiles", extensions: ["json"] }]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, profiles: [] };
  }

  const filePath = result.filePaths[0];
  const raw = await fs.promises.readFile(filePath, "utf8");
  return {
    canceled: false,
    filePath,
    profiles: readProfilesFromDocument(raw)
  };
});

ipcMain.handle("key:select", async () => {
  const result = await dialog.showOpenDialog({
    title: "选择 SSH 私钥",
    properties: ["openFile"],
    filters: [
      { name: "SSH keys", extensions: ["pem", "key", "ppk", "openssh", "id_rsa"] },
      { name: "All files", extensions: ["*"] }
    ]
  });

  return result.canceled ? undefined : result.filePaths[0];
});

ipcMain.handle("local:home", async () => app.getPath("home"));

ipcMain.handle(
  "local:list",
  async (_event, request: LocalListRequest): Promise<FileListResponse> => {
    const directoryPath = path.resolve(request.path || app.getPath("home"));
    const entries = await fs.promises.readdir(directoryPath, {
      withFileTypes: true
    });

    const fileEntries = await Promise.all(
      entries.map(async (entry): Promise<FileListEntry | undefined> => {
        const entryPath = path.join(directoryPath, entry.name);
        try {
          const stats = await fs.promises.stat(entryPath);
          return {
            name: entry.name,
            path: entryPath,
            kind: localKind(stats),
            size: stats.size,
            modifiedAt: stats.mtimeMs
          };
        } catch {
          return undefined;
        }
      })
    );

    return {
      path: directoryPath,
      parentPath: localParentPath(directoryPath),
      entries: sortEntries(fileEntries.filter((entry): entry is FileListEntry => Boolean(entry)))
    };
  }
);

ipcMain.handle("local:mkdir", async (_event, request: LocalMkdirRequest) => {
  await fs.promises.mkdir(path.join(request.parentPath, assertSafeName(request.name)));
});

ipcMain.handle("local:rename", async (_event, request: LocalRenameRequest) => {
  const targetPath = path.join(path.dirname(request.path), assertSafeName(request.newName));
  await fs.promises.rename(request.path, targetPath);
});

ipcMain.handle("local:delete", async (_event, request: LocalDeleteRequest) => {
  const paths = [...new Set(request.paths.map((item) => path.resolve(item)))];
  if (paths.length === 0) {
    throw new Error("请选择要删除的本地项目。");
  }

  for (const targetPath of paths) {
    await fs.promises.rm(targetPath, {
      recursive: true,
      force: false
    });
  }
});

ipcMain.handle(
  "sftp:list",
  async (_event, request: SftpListRequest): Promise<FileListResponse> => {
    const sftp = await getSftp(request.sessionId);
    const requestedPath = request.path?.trim() || ".";
    const absolutePath = await sftpRealpath(sftp, requestedPath);
    const entries = await sftpReaddir(sftp, absolutePath);

    return {
      path: absolutePath,
      parentPath: remoteParentPath(absolutePath),
      entries: sortEntries(
        entries
          .filter((entry) => entry.filename !== "." && entry.filename !== "..")
          .map((entry) => ({
            name: entry.filename,
            path: joinRemotePath(absolutePath, entry.filename),
            kind: remoteKind(entry),
            size: entry.attrs.size,
            modifiedAt: entry.attrs.mtime ? entry.attrs.mtime * 1000 : undefined,
            permissions: entry.attrs.mode.toString(8).slice(-3)
          }))
      )
    };
  }
);

ipcMain.handle("sftp:upload", async (event, request: SftpUploadRequest) => {
  const summary = createTransferSummary();
  const total = createTransferSummary();
  const context: TransferContext = {
    webContents: event.sender,
    transferId: request.transferId || randomUUID(),
    direction: "upload",
    summary,
    total,
    lastEmitAt: 0,
    canceled: false
  };
  activeTransfers.set(context.transferId, context);

  emitTransferProgress(context, "preparing", "正在准备上传", {
    force: true,
    currentPath: request.localPath
  });

  try {
    const sftp = await getSftp(request.sessionId);
    const conflictPolicy = normalizeConflictPolicy(request.conflictPolicy);
    assertTransferNotCanceled(context);
    context.total = await scanLocalEntry(request.localPath, createTransferSummary(), context);
    emitTransferProgress(context, "preparing", "上传准备完成", {
      force: true,
      currentPath: request.localPath
    });
    await uploadLocalEntry(
      sftp,
      request.localPath,
      request.remoteDirectory,
      request.remoteName || path.basename(request.localPath),
      summary,
      context,
      conflictPolicy
    );
    emitTransferProgress(context, "completed", "上传完成", { force: true });
    return summary;
  } catch (error) {
    if (isTransferCanceledError(error) || context.canceled) {
      emitTransferProgress(context, "canceled", "上传已取消", { force: true });
      throw new TransferCanceledError();
    }
    emitTransferProgress(context, "error", getErrorMessage(error), { force: true });
    throw error;
  } finally {
    activeTransfers.delete(context.transferId);
  }
});

ipcMain.handle("sftp:download", async (event, request: SftpDownloadRequest) => {
  const remoteName = request.localName || path.posix.basename(request.remotePath);
  if (!remoteName) {
    throw new Error("无法识别远端文件名。");
  }

  const summary = createTransferSummary();
  const total = createTransferSummary();
  const context: TransferContext = {
    webContents: event.sender,
    transferId: request.transferId || randomUUID(),
    direction: "download",
    summary,
    total,
    lastEmitAt: 0,
    canceled: false
  };
  activeTransfers.set(context.transferId, context);

  emitTransferProgress(context, "preparing", "正在准备下载", {
    force: true,
    currentPath: request.remotePath
  });

  try {
    const localStats = await fs.promises.stat(request.localDirectory);
    if (!localStats.isDirectory()) {
      throw new Error("请选择本地目录作为下载目标。");
    }

    const sftp = await getSftp(request.sessionId);
    const conflictPolicy = normalizeConflictPolicy(request.conflictPolicy);
    assertTransferNotCanceled(context);
    context.total = await scanRemoteEntry(sftp, request.remotePath, createTransferSummary(), context);
    emitTransferProgress(context, "preparing", "下载准备完成", {
      force: true,
      currentPath: request.remotePath
    });
    await downloadRemoteEntry(
      sftp,
      request.remotePath,
      request.localDirectory,
      remoteName,
      summary,
      context,
      conflictPolicy
    );
    emitTransferProgress(context, "completed", "下载完成", { force: true });
    return summary;
  } catch (error) {
    if (isTransferCanceledError(error) || context.canceled) {
      emitTransferProgress(context, "canceled", "下载已取消", { force: true });
      throw new TransferCanceledError();
    }
    emitTransferProgress(context, "error", getErrorMessage(error), { force: true });
    throw error;
  } finally {
    activeTransfers.delete(context.transferId);
  }
});

ipcMain.handle(
  "sftp:cancel-transfer",
  async (_event, request: SftpCancelTransferRequest): Promise<boolean> => {
    const context = activeTransfers.get(request.transferId);
    if (!context) {
      return false;
    }

    cancelTransfer(context);
    emitTransferProgress(context, "canceled", "正在取消传输", { force: true });
    return true;
  }
);

ipcMain.handle("sftp:mkdir", async (_event, request: SftpMkdirRequest) => {
  const sftp = await getSftp(request.sessionId);
  await sftpMkdir(sftp, joinRemotePath(request.parentPath, request.name));
});

ipcMain.handle("sftp:delete", async (_event, request: SftpDeleteRequest) => {
  const sftp = await getSftp(request.sessionId);
  const items = request.items?.length
    ? request.items
    : request.path
      ? [{ path: request.path, kind: request.kind ?? "file" }]
      : [];

  if (items.length === 0) {
    throw new Error("请选择要删除的远端项目。");
  }

  for (const item of items) {
    await sftpRemove(sftp, item.path);
  }
});

ipcMain.handle("sftp:rename", async (_event, request: SftpRenameRequest) => {
  const sftp = await getSftp(request.sessionId);
  await sftpRename(
    sftp,
    request.path,
    joinRemotePath(path.posix.dirname(request.path), request.newName)
  );
});

ipcMain.handle(
  "sftp:edit-open",
  async (event, request: SftpEditOpenRequest): Promise<SftpEditOpenResponse> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      throw new Error("无法找到当前窗口。");
    }
    return openRemoteEditSession(win, request);
  }
);

ipcMain.handle("sftp:edit-close", async (_event, request: SftpEditCloseRequest) => {
  closeRemoteEditSession(request.editId);
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
