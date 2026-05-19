# Changelog

All notable changes to XShell NG will be documented in this file.

The format loosely follows Keep a Changelog, and this project uses semantic versioning once public releases start.

## [Unreleased]

## [0.2.0] - 2026-05-19

### Added

- GitHub-ready open source project metadata and contribution documents.
- CI workflow for type checking and production build.
- Saved SSH tunnel configurations on connection profiles with optional auto-start.
- Automatic terminal logging preference with per-session log files.
- SFTP upload/download conflict policies for overwrite, skip, and rename.
- Quick commands / command snippets with local management and send-to-session support.
- Host key management UI for listing, deleting, and clearing trusted host keys.

### Changed

- Top-level menu and toolbar organization were reviewed for clearer session and tool grouping.

## [0.1.0] - 2026-05-19

### Added

- Password and private-key SSH authentication.
- Host key confirmation and change warning.
- Tabbed xterm.js terminal sessions.
- Connection profile management with import/export.
- Encrypted saved passwords through Electron `safeStorage`.
- SFTP two-pane file transfer with recursive upload/download.
- Transfer queue, progress reporting, and cancellation.
- Local forwarding, remote forwarding, and SOCKS5 dynamic forwarding.
