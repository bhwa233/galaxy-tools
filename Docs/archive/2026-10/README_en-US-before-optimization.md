# spark233

> Historical snapshot. Progress and acceptance statements describe earlier revisions. See the [current README](../../../README_en-US.md) for the current entry point.

Current work follows the [implementation baseline](spark233-remaining-implementation-2026-10-27.md): finish documentation, implement the complete batch, then verify it together. Historical candidates do not cover the current API 1.2, document allowlist and restore-boundary drafts.

spark233 is a Windows desktop launcher and plugin toolkit evolved from
[Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper). It uses
Electron 45, TypeScript, React 19, Vite 8 and shadcn/ui, targeting Windows 11 x64.
Implementation continues against the requirement audit. The Windows candidate
has passed its complete GUI smoke; final manual acceptance remains pending. The supported interface languages
are Simplified Chinese (`zh-CN`) and English (`en-US`).

The 2026-10-26 work integrates the notes utility engine, generic external-data
backup, private-root protection, crash recovery and field-only settings patches.
Type checks, lint, 33 test files/163 tests, real utility checks, seven main-process
checks and seven backup checks have passed. Windows `dist:win` also produced the
directory package and NSIS installer, resolving the earlier missing-native-payload
blocker. The same final input passed both the fixed-data run
`seeded-smoke-pQcL2D` and complete Windows GUI smoke
`c94c7be6-ea9b-4abe-a711-da40a9378cf0`, with actual process exit code 0.
The fixed ID, Markdown, attachments, reminders and layout were preserved,
completing P3.1 within its original scope. That checkpoint recorded 47/98
complete items. The current checklist includes ten newly adopted requirements and
records 60/108 complete items and 48 partial, unimplemented or pending items. Plugin release notes, download progress, per-task cancellation and bounded diagnostics are complete; see the [update feedback record](../../evidence/spark233-package-tasks-followup.md). IME, multiple displays, clean
installation and SYSTEM-service acceptance remain pending. See the
[current finalization record](../../evidence/spark233-notes-finalization.md) for
artifact identity and evidence boundaries.

Incremental queries, pinned entries, personal aliases, command hiding and optional keyword learning are now complete. Learning has a separate [finalization record](../../evidence/spark233-keyword-learning-followup.md): 175 tests, 66 artifact checks and complete Windows smoke passed. The earlier context-panel capture, resource and lifecycle checks passed: 20 scoped main/UI checks and their Windows candidate’s 179 tests, 74 artifact checks, fixed-data/full smoke and binder passed. Physical mouse, OS selection, focus return, IME and multiple displays remain pending; P3.17 stays unchecked. See the [context-panel record](../../evidence/spark233-context-panel-followup.md).
The new candidate passed 39 artifact checks, 167 tests, fixed-data smoke and a full Windows
smoke with actual exit 0. See the [preference finalization](../../evidence/spark233-launcher-preferences-followup.md).

Additional evidence covers native trust confirmation, notes disable/re-enable,
dictionary package updates, and clipboard editing/favorites/cleanup; see the
[workspace follow-up](../../evidence/spark233-workspace-lifecycle-followup.md).
Settings zoom, focus and accessible-control fixes have a separate
[UI record](../../evidence/spark233-settings-zoom-followup.md); complete manual
acceptance remains pending.

The default entry is a uTools-style launcher with keyword commands and dedicated
plugin modes. First launch presents onboarding without creating an empty note.
Later launches restore note layouts and remain in the tray. `Alt+Space` opens the
launcher by default; creating a note is a separate command.

Seven official plugins are organized as independent npm packages: notes,
screenshot capture, OCR, dictionary/translation, clipboard history, application
search, and file/content search. They are enabled by default; backends start on
demand, while clipboard recording starts with the application. Plugin management
supports the official offline catalog, registry packages, local `.tgz` archives, and immutable snapshots of
prebuilt development directories, with capability and version review,
enable/disable and uninstall. Updates are checked automatically and installed after user
confirmation. Third-party Node/native backends require explicit trust and run
with the current user's system permissions. Native-only extensions implement the
[managed protocol](../../native-plugin-protocol.md). The npm scope is provisional until
account ownership is verified; no public npm publication has been performed.

ScreenCapture and ImageReader provide screenshot/OCR integration. ECDICT provides
offline dictionary lookup; AI translation requires explicit execution and a
configured OpenAI-compatible service. Application search includes pinyin
matching. File search uses the Pulse filename service and Instant on-demand
content search; installing the service requires Windows administrator approval.
Clipboard features follow QcClip, including multi-format history, favorites,
tags, editing, batch merging, a gallery, a compact paste window and explicit
cleanup. The host coordinates consistent backup and recovery.

The [architecture](../../launcher-architecture.md) and
[implementation checklist](../../launcher-todo.md) define the complete first
release scope. The historical 2026-10-25 candidate passed its technology, plugin,
business integration, Windows directory-package and NSIS checks.
Controlled Markdown/image preservation and an unavailable-network run of all
seven plugins, the dictionary and OCR have evidence for that historical input. Its installer is about
200.33 MiB; application files plus expanded plugins total about 614.79 MiB before
user data, indexes and caches. See the [distribution record](../../evidence/spark233-packaging.md)
for exact hashes and measurement scope. Manual UI/IME/multi-display acceptance,
screenshot annotation, real clipboard paste, UAC/SYSTEM service and full-volume
behavior, and a pristine physically disconnected Windows installation remain
pending. The local installer is unsigned and has not been executed. MVP
validation reuses existing gates and a few representative real paths; no large
test suite was added.

Notes retain their Markdown files, images, categories, reminders, themes,
desktop windows and edge capsules. The former close button and Ctrl+W save and
collapse a note into an edge capsule. Capsules support floating, docking, shared
edge queues, a master queue control and previews without focus. Hidden notes can
be reopened through the tray; hiding is available in the context menu. Failed
saves keep the editor open. See [note and capsule behavior](../../../README.md) and
[remaining capsule acceptance limits](../../edge-capsules.md).

Use Node.js **26.12.1** and pnpm **12.15.0**, pinned in `.node-version` and
`package.json`. On Windows, dot-source `. ./scripts/use-toolchain.ps1` to select
the project's portable runtime without changing global Node. Electron's embedded
Node 24 is separate from this development toolchain. Windows GUI/native builds
require Windows tools; do not share `node_modules` between Windows and Linux.

If pnpm is missing, use the selected Node's npm to prepare an isolated toolchain.
npm 12 blocks package installation scripts by default, so approve pnpm and
rebuild its Windows launchers before selecting the toolchain again:

```powershell
npm.cmd install --prefix "$env:LOCALAPPDATA/spark233/toolchains/pnpm-v12.15.0" --save-exact --no-package-lock pnpm@12.15.0
npm.cmd --prefix "$env:LOCALAPPDATA/spark233/toolchains/pnpm-v12.15.0" install-scripts approve pnpm
npm.cmd --prefix "$env:LOCALAPPDATA/spark233/toolchains/pnpm-v12.15.0" rebuild pnpm
. ./scripts/use-toolchain.ps1
```

`approve` records script permission in this toolchain directory; `rebuild`
executes pnpm's installation script. These npm commands only prepare pnpm.
Project dependencies use pnpm, and the global toolchain stays untouched.

This is a pnpm workspace with one root `pnpm-lock.yaml`. Run the commands below
from the repository root. `apps/desktop` owns Electron, React and app configs;
`packages/sdk`, `packages/ui`, `packages/official/*` and `examples/plugins/*`
are separate workspaces. Declare dependencies in the workspace that uses them;
root dependencies are shared development tools. Use
`pnpm --filter @spark233/desktop <command>` for desktop-only tasks.
Desktop output lives in `apps/desktop/dist` and `apps/desktop/dist-electron`.
`dist-plugins`, `dist-host`, `release-electron` and `local-build` stay at the root.

```powershell
. ./scripts/use-toolchain.ps1
pnpm install --frozen-lockfile
pnpm dev
```

`dev` prepares the matching Electron runtime and seven offline plugin packages,
then starts Vite and Electron. React edits hot-reload; restart after changes to
`apps/desktop/electron/`. Native resources can require the Windows C++ toolchain when built
from source. End users do not run npm lifecycle scripts or compile plugins.

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm start
pnpm pack:win  # release-electron/win-unpacked
pnpm dist:win  # NSIS installer in release-electron
```

`pnpm build` assembles all seven packages into `dist-plugins/`; Windows builds
include them outside ASAR at `resources/plugins/`. See
[official plugin build instructions](../../../packages/official/README.md) for independent
plugin artifacts. Plain `pnpm pack` in a source directory does not assemble all
renderer, native and dictionary resources. Distribute the entire unpacked
application directory. Current installer and expanded plugin file sizes have
been measured in the [distribution record](../../evidence/spark233-packaging.md).
Planning estimates and the sum of plugin archives are not installed sizes;
user data, caches, indexes, service copies and rollback versions are separate.

The application identity is `spark233` / `com.spark233.desktop`. The former
upstream Tauri updater is disabled; plugin updates use the separate confirmation
flow. Code signing is not configured. Autostart is available for installed
builds. There are no legacy product aliases, automatic discovery or migration;
existing user files are retained.

Data locations:

- Configuration root: `%APPDATA%/spark233/`; host preferences are in
  `host/config.json`, onboarding state in `host/launcher.json`.
- Default note directory: `Documents/spark233`; subsequent launches use the
  `dataDir` saved by spark233. Note bodies remain independent `.md` files under
  `notes/`, with metadata, images, backgrounds, reminders and
  `electron-layout.json` in the note data directory.
- Exact plugin versions, state, business data and caches are under `plugins/` in
  the configuration root. Chromium uses the separate `electron-profile/`.
- For isolated development or checks, set `SPARK233_CONFIG_DIR` and
  `SPARK233_DATA_DIR` to `local-build/` or an explicit temporary directory.
  Windows smoke additionally requires `SPARK233_SMOKE=1`; reuse
  `pwsh -File scripts/smoke-windows.ps1`. Never use real notes or clipboard
  history for smoke/integration data.

The optional local MCP service is disabled by default. Enable it in settings,
choose read/append/full permissions and connect a client using
`<installation path> --mcp`. Its tools use the `spark233_` prefix. See
[MCP setup and permissions](../../mcp.md).

[Electron migration notes](../../electron-migration.md),
[earlier note acceptance items](electron-todo.md) and historical upstream
documentation under `Docs/upstream/` are retained. `src-tauri/`,
`scripts/legacy-tauri/` and `.github/legacy-tauri/` are historical references and
do not participate in current builds. The [MIT license](../../../LICENSE), upstream
attribution, font notices and third-party licenses are preserved.
