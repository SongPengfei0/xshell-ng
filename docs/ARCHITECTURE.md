# Architecture

XShell NG 是一个单窗口 Electron 桌面应用，主边界是 Electron main 进程、preload 桥接层、renderer UI 和共享 IPC 类型。

## 目录分层

```text
src/main/       Electron main 进程，拥有 Node.js、ssh2、文件系统和窗口能力
src/renderer/   浏览器端 UI、xterm.js、连接配置本地状态和交互逻辑
src/shared/     main 与 renderer 共用的 TypeScript 类型
docs/           面向贡献者和维护者的项目文档
.github/        GitHub CI、Issue 模板和 PR 模板
scripts/        本地验证脚本
```

## 运行时边界

- `src/main/main.ts` 负责 SSH 连接、SFTP、本地文件、隧道、菜单、窗口控制、主机密钥和安全密码存储。
- `src/main/preload.ts` 通过 `contextBridge` 暴露白名单 API，不让 renderer 直接访问 Node.js。
- `src/shared/ipc.ts` 定义请求、响应和事件类型，是 main 与 renderer 的契约。
- `src/renderer/renderer.ts` 管理标签页、终端实例、连接配置、SFTP 队列、隧道面板和偏好设置。

## 数据存储

- 连接配置保存在 renderer 的 `localStorage`。
- 勾选保存密码时，密码通过 main 进程写入 Electron `safeStorage` 加密文件。
- SSH known hosts 记录写入 Electron `userData` 目录。
- 导出连接配置时不会包含密码或 passphrase。

## 安全要点

- SSH 主机密钥首次连接需要确认，变更时会提示风险。
- Renderer 只能通过 preload 中暴露的白名单 API 调用 main 能力。
- 本地和远端删除操作都需要用户确认。
- 文件传输任务支持取消，并会尽量清理未完成文件。

## 当前取舍

Renderer 目前还是单文件状态机。这降低了早期原型的跨文件耦合成本，但后续可以在功能稳定后拆分为 `state`、`terminal`、`sftp`、`tunnels`、`profiles` 等模块。
