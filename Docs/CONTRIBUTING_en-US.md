[简体中文](../CONTRIBUTING.md) | [繁體中文](CONTRIBUTING_zh-HK.md) | **English**

# Contributing Guide

Thank you for your interest in Floral Notepaper! This guide will help you get started with contributing to the project.

## Development Environment Setup

### Dependencies and workspace

Use Node.js **26.12.1** and pnpm **12.15.0**. The current desktop runtime is Electron, targeting Windows 11 x64. Windows native plugin builds may require the C++ toolchain; the archived Tauri/Rust instructions do not apply to this build.

Follow the [current setup guide](../README_en-US.md) to select the project toolchain without replacing global Node. Run these commands from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm build
pnpm pack:win
```

`apps/desktop` contains the Electron and React app; `packages/sdk`, `packages/ui`, `packages/official/*` and `examples/plugins/*` are independent workspaces. Declare dependencies in their owning workspace and maintain the single root `pnpm-lock.yaml`. Shared development tools live at the root. Use `pnpm --filter @spark233/desktop <command>` for app-only tasks.

## Branch & Commit Conventions

This project follows the [Conventional Commits](https://www.conventionalcommits.org/) specification.

### Commit Message Format

```
<type>: <brief description>
```

Common types:

| type       | Description                                    |
| ---------- | ---------------------------------------------- |
| `feat`     | New feature                                    |
| `fix`      | Bug fix                                        |
| `docs`     | Documentation changes                          |
| `style`    | Formatting (no logic changes)                  |
| `refactor` | Code refactoring (neither new feature nor fix) |
| `perf`     | Performance optimization                       |
| `test`     | Adding or modifying tests                      |
| `chore`    | Build, CI, dependencies, and other miscellanea |
| `ci`       | CI/CD configuration changes                    |
| `revert`   | Revert a commit                                |

### Branch Naming

Branch names should correspond to the commit type: `feat/description`, `fix/description`, `refactor/description`, etc.

Examples:

- `feat/note-tagging` → new feature branch
- `fix/startup-crash` → bug fix branch

## Code Style & Testing

Before submitting a PR, ensure all local checks pass. It's a good idea to run them before each commit as well to avoid CI failures:

```bash
pnpm typecheck
pnpm lint
pnpm fmt --check
pnpm test
pnpm build
```

## Pull Request Process

1. **Search** [existing PRs](https://github.com/Achilng/floral-notepaper/pulls) first to avoid duplicate work
2. Fork this repository and create your feature/fix branch from `main`
3. Once development is complete, ensure all local checks pass
4. Submit a PR to the `main` branch, filling out all sections of the **PR template**
5. CI must pass (build + lint + tests)

   > Note: CI runs against the merged result of your PR branch and `main` (`refs/pull/<number>/merge`), not your branch's original commits.

6. At least one maintainer must **approve the review** before merging
7. Maintainers use **squash merge**; remote branches are automatically deleted after merging

PR titles should also follow Conventional Commits, e.g. `feat: add note tagging feature`.

## Feedback

- Report a bug: [Submit an Issue](https://github.com/Achilng/floral-notepaper/issues/new?template=bug.yml)
- Feature request: [Submit an Issue](https://github.com/Achilng/floral-notepaper/issues/new?template=enhancement.yml)
- General discussion: [GitHub Discussions](https://github.com/Achilng/floral-notepaper/discussions)
