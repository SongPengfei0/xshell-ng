# Development

## Prerequisites

- Windows 10/11.
- Node.js 22 or newer.
- npm 10 or newer.

## Install

```powershell
npm install
```

The committed `.npmrc` uses a local npm cache folder and an Electron mirror to make Windows installs more reliable in mainland China. Maintainers can adjust it locally if they prefer the official registry and Electron CDN.

## Run

```powershell
npm run dev
```

The dev script builds both TypeScript targets and then starts Electron.

## Validate

```powershell
npm run typecheck
npm run build
npm run smoke
npm run audit:moderate
```

`npm run smoke` starts Electron, waits briefly, and fails if the app exits early.

## Package

```powershell
npm run pack
npm run dist:portable
npm run dist:win
```

Build outputs are written to `release/` and must not be committed.

## Git Hygiene

- Generated folders are ignored: `dist/`, `release/`, `node_modules/`, `.npm-cache/`.
- Keep commits focused. Separate UI-only work from SSH/SFTP/tunnel behavior changes where practical.
- Include validation commands in PR descriptions.
