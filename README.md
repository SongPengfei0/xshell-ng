# XShell NG

XShell NG 是一个面向 Windows 的桌面 SSH 客户端原型，使用 Electron、TypeScript、Vite、ssh2 和 xterm.js 构建。目标是提供经典 SSH 客户端的核心工作流：连接配置管理、标签式 SSH 会话、SFTP 文件传输、SSH 隧道和常用终端操作。

本项目不会复制商业软件的商标、图标或专有素材；界面采用原创实现，并尽量保留 Windows 用户熟悉的 SSH 客户端操作习惯。

## 概念定义

- 连接配置：保存下来的主机连接信息，包括主机、端口、用户名、认证方式、私钥路径、分组等。
- SSH 会话：由连接配置或快速连接发起的一次实际 SSH 连接。
- 标签页：承载一个正在运行或已断开的 SSH 会话。
- SFTP 通道：绑定到当前已连接 SSH 会话的文件传输通道。
- SSH 隧道：绑定到当前已连接 SSH 会话的端口转发能力。

## 当前功能

### SSH 连接

- 密码认证。
- 私钥认证和 passphrase。
- 首次连接 SSH 主机指纹确认。
- 主机密钥变更提示。
- 终端窗口尺寸同步。
- 断开当前会话。
- 当前标签重连。
- 多标签终端。
- 复制当前标签。
- 关闭标签。
- 全屏切换和退出全屏。

### 连接配置管理

- 新建、编辑、删除连接配置。
- 快速连接，不保存配置也可直接连接。
- 连接配置分组，默认分组为“默认”。
- 左侧连接配置搜索。
- 导入和导出 JSON 配置。
- 导出文件不包含密码或 passphrase。
- 勾选保存密码时使用 Electron `safeStorage` 加密保存，不写入前端配置。

### 终端

- xterm.js 终端渲染。
- 终端主题、字号、光标闪烁偏好。
- 终端输出查找。
- 查找支持大小写、整词、正则。
- `Ctrl+F` 打开查找。
- `F3` 查找下一个。
- `Shift+F3` 查找上一个。
- `Ctrl+V` 粘贴到当前 SSH 会话。
- `Ctrl+C` 在有终端选区时复制；无选区时发送 `^C` 中断远端进程。
- 菜单复制、粘贴、全选可用。

### SFTP 文件传输

- 基于当前 SSH 会话打开 SFTP 面板。
- 本地和远端双栏浏览。
- 双击目录进入。
- 路径栏跳转。
- 上级目录、刷新。
- 上传文件和目录。
- 下载文件和目录。
- 上传和下载递归目录。
- 新建本地目录和远端目录。
- 重命名本地项目和远端项目。
- 删除本地项目和远端项目。
- 本地和远端均支持 `Ctrl+左键` 多选。
- 本地和远端均支持批量删除。
- 远端多选下载会逐项加入下载队列。
- 传输队列。
- 取消等待中或进行中的传输。
- 传输进度、当前文件进度、总进度。
- 已修复上传大文件或 PDF 时进度卡在 99% 的收尾问题。

### SSH 隧道 / 端口转发

- 本地转发。
- 远端转发。
- SOCKS5 代理。
- 已连接 SSH 会话中新增隧道。
- 查看当前会话隧道。
- 停止隧道。
- 会话断开时自动清理隧道。
- 隧道列表显示连接数和上下行字节数。

已手工验证：

- Local forwarding：通过。
- Remote forwarding：通过。
- SOCKS5 代理：通过。

Remote forwarding 是否可用仍取决于服务器 SSHD 配置，例如 `AllowTcpForwarding` 和 `GatewayPorts`。

## 典型测试

### Local forwarding

在 XShell NG 隧道窗口创建：

```text
类型：本地转发
本地监听地址：127.0.0.1
本地监听端口：10022
远端目标主机：127.0.0.1
远端目标端口：22
```

Windows PowerShell：

```powershell
ssh -p 10022 <username>@127.0.0.1
```

能出现登录提示或登录成功即通过。

### SOCKS5 代理

在 XShell NG 隧道窗口创建：

```text
类型：SOCKS5 代理
本地 SOCKS 地址：127.0.0.1
本地 SOCKS 端口：1080
```

Windows PowerShell：

```powershell
curl.exe -v --socks5-hostname 127.0.0.1:1080 https://www.baidu.com
```

目标网站必须能从远端服务器访问。SOCKS5 的出口是远端服务器，不是 Windows 本机。

### Remote forwarding

Windows PowerShell 启动本地 HTTP 服务：

```powershell
node -e "require('http').createServer((req,res)=>res.end('hello from windows')).listen(18080,'127.0.0.1')"
```

在 XShell NG 隧道窗口创建：

```text
类型：远端转发
远端监听地址：127.0.0.1
远端监听端口：18081
本地目标主机：127.0.0.1
本地目标端口：18080
```

SSH 终端：

```bash
curl http://127.0.0.1:18081
```

预期输出：

```text
hello from windows
```

## 开发运行

```powershell
npm install
npm run dev
```

`npm run dev` 会先执行构建，再启动 Electron。

## 验证

```powershell
npm run typecheck
npm run build
npm audit --audit-level=moderate
```

Electron 启动烟测示例：

```powershell
$electron = Join-Path (Get-Location) 'node_modules\electron\dist\electron.exe'
$p = Start-Process -FilePath $electron -ArgumentList '.' -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 6
if ($p.HasExited) { Write-Error "Electron exited early with code $($p.ExitCode)"; exit 1 }
Stop-Process -Id $p.Id -Force
'Electron smoke launch passed'
```

当前构建可能出现 Vite 大 chunk 提醒，不影响运行。

## Windows 打包

```powershell
npm run pack
npm run dist:portable
npm run dist:win
```

- `npm run pack`：生成 `release/win-unpacked/XShell NG.exe`。
- `npm run dist:portable`：生成便携版 `release/XShell NG 0.1.0.exe`。
- `npm run dist:win`：生成安装包和便携版。

## 项目结构

```text
src/main/main.ts          Electron main 进程、SSH/SFTP/隧道/本地文件 IPC
src/main/preload.ts       安全暴露给 renderer 的桥接 API
src/shared/ipc.ts         main 和 renderer 共用的 IPC 类型
src/renderer/index.html   界面结构
src/renderer/renderer.ts  renderer 交互逻辑
src/renderer/styles.css   界面样式
```

## 已知限制和后续方向

- SSH 隧道配置尚未保存到连接配置中。
- 连接成功后尚未支持自动启动指定隧道。
- SFTP 尚未支持拖拽上传/下载。
- SFTP 尚未支持远端文件直接编辑并保存回传。
- SFTP 尚未支持 chmod/权限修改。
- 文件覆盖冲突策略仍较基础。
- 还没有终端日志记录功能。
- 还没有快速命令/命令片段功能。
- 还没有登录脚本或触发器功能。
