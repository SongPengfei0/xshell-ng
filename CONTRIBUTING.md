# Contributing to XShell NG

感谢你愿意改进 XShell NG。这个项目目前是一个 Windows 优先的 Electron SSH 客户端原型，变更应尽量保持小而清晰。

## 开发准备

```powershell
npm install
npm run dev
```

提交前至少运行：

```powershell
npm run typecheck
npm run build
```

如果改动涉及窗口启动、preload 或 IPC，建议再运行：

```powershell
npm run smoke
```

## 变更原则

- 优先沿用现有目录和 IPC 边界：`src/main`、`src/renderer`、`src/shared`。
- 不提交 `dist/`、`release/`、`node_modules/`、本地缓存或私有配置。
- 不提交真实服务器地址、用户名、密码、私钥、passphrase、已导出的连接配置。
- UI 文案默认使用简体中文；代码、类型和文件名默认使用英文。
- 对 SSH、SFTP、端口转发、密码存储相关改动，请说明验证方式。

## Pull Request

PR 描述建议包含：

- 改动目的。
- 主要实现点。
- 手工验证或命令验证结果。
- 对安全、兼容性、数据迁移的影响。

## Issue

提交问题时请尽量提供：

- Windows 版本、Node.js 版本、npm 版本。
- 操作步骤和实际表现。
- 相关截图或日志。
- 是否能用系统 OpenSSH / PowerShell 复现。
