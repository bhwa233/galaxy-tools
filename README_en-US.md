# spark233

A Windows 11 x64 desktop launcher and plugin toolkit with notes, screenshots, OCR, translation and an offline dictionary, clipboard history, application entries and file search. The interface supports Simplified Chinese and English.

Built with Electron 45, React 19, TypeScript, Vite and a pnpm workspace. Start with the [documentation index](Docs/README.md) for architecture, protocols and acceptance requirements. [简体中文](README.md)

## Development

Use **Node.js 26.13.0 and pnpm 12.16.1**, pinned in `.node-version` and `package.json`. Electron's embedded Node runtime is managed separately.

Use nvm to install and select Node 26.13.0. In Git Bash, source `scripts/use-toolchain.sh`; in PowerShell, dot-source `scripts/use-toolchain.ps1`. These prefer nvm's Node; on Windows, `nvm use` changes its shared Node link. See the [Chinese setup instructions](README.md#开发) for preparing pnpm with npm 12.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`dev` prepares the SDK, Electron and official plugin resources. `dev:web` serves the frontend only; desktop features require the preload bridge. Keep Windows and WSL dependency installations separate.

## Validation and packaging

Run heavyweight checks serially:

```sh
pnpm typecheck
pnpm lint
pnpm fmt --check
pnpm test
pnpm --filter @spark233/desktop exec playwright install chromium --only-shell
pnpm test:ui
```

On Windows, use PowerShell 7 (`pwsh`) and prepare CMake, Ninja and Python 3.12, then run `scripts/prepare-windows-resources.ps1` to download, verify and build pinned native dependencies. `pnpm pack:win` creates `release-electron/win-unpacked/`; `pnpm dist:win` creates the NSIS installer. Distribute the complete portable directory. End users do not compile resources or run npm lifecycle scripts.

The [PR workflow](.github/workflows/pulls.yml) runs checks. The [packaging workflow](.github/workflows/build-artifacts.yml) explicitly prepares native and dictionary resources. Local checks and builds do not establish physical-device, UAC, SYSTEM-service or installer acceptance; those requirements remain in the [implementation checklist](Docs/launcher-todo.md).

## Data and permissions

Host configuration, plugin installation state and plugin data have separate owners. Failed saves retain the current draft and prevent document switching. Notes cannot change host administration or MCP settings. Backup restore cannot silently expand plugin permissions or executable-code trust. MCP is disabled by default; see [its configuration and permissions](Docs/mcp.md).

Application identity: `spark233` / `com.spark233.desktop`. Digital signing is not configured. See [official plugins](packages/official/README.md) and [third-party notices](THIRD_PARTY_NOTICES.md) for resource provenance and licenses.

Derived from [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper), with attribution and licensing retained. Historical upstream material is in [Docs/upstream](Docs/upstream/); the current build uses Electron.
