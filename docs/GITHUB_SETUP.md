# GitHub Setup

Use this checklist when publishing the repository to GitHub.

## Prepare Local Repository

```powershell
git status
npm run typecheck
npm run build
```

Review the diff before the first public commit:

```powershell
git diff --stat
git diff
```

## Create GitHub Repository

Create an empty repository on GitHub, then add the remote:

```powershell
git remote add origin https://github.com/<owner>/xshell-ng.git
git branch -M main
git push -u origin main
```

If the repository already uses `master`, either keep it or rename it before pushing. The CI workflow listens to both `main` and `master`.

## Recommended Repository Settings

- Enable private vulnerability reporting.
- Protect the default branch after the first push.
- Require the CI workflow before merging pull requests.
- Disable publishing generated `release/` artifacts unless they are uploaded through GitHub Releases.
- Add repository topics such as `electron`, `ssh`, `sftp`, `terminal`, `windows`, `typescript`.

## Release Checklist

```powershell
npm ci
npm run typecheck
npm run build
npm run dist:portable
```

Attach packaged artifacts from `release/` to a GitHub Release instead of committing them.
