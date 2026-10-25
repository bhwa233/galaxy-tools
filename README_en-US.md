# spark233

spark233 is a Windows desktop launcher and plugin toolkit evolved from
[Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper). It uses
Electron 45, TypeScript, React 19, Vite 8 and shadcn/ui, targeting Windows 11 x64.
The current implementation and requirement audit are complete; final manual acceptance
remains scheduled separately. The supported interface languages
are Simplified Chinese (`zh-CN`) and English (`en-US`).

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
[managed protocol](Docs/native-plugin-protocol.md). The npm scope is provisional until
account ownership is verified; no public npm publication has been performed.

ScreenCapture and ImageReader provide screenshot/OCR integration. ECDICT provides
offline dictionary lookup; AI translation requires explicit execution and a
configured OpenAI-compatible service. Application search includes pinyin
matching. File search uses the Pulse filename service and Instant on-demand
content search; installing the service requires Windows administrator approval.
Clipboard features follow QcClip, including multi-format history, favorites,
tags, editing, batch merging, a gallery, a compact paste window and explicit
cleanup. The host coordinates consistent backup and recovery.

The [architecture](Docs/launcher-architecture.md) and
[implementation checklist](Docs/launcher-todo.md) define the complete first
release scope. Technology upgrades, plugin and business integration, the Windows
directory package and NSIS installer have passed the current automated checks.
Controlled Markdown/image preservation and an unavailable-network run of all
seven plugins, the dictionary and OCR have evidence. The installer is about
200.33 MiB; application files plus expanded plugins total about 614.79 MiB before
user data, indexes and caches. See the [distribution record](Docs/evidence/spark233-packaging.md)
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
saves keep the editor open. See [note and capsule behavior](README.md) and
[remaining capsule acceptance limits](Docs/edge-capsules.md).

Use Node.js **26.12.1** and npm **12.2.1**, pinned in `.node-version` and
`package.json`. On Windows, dot-source `. ./scripts/use-toolchain.ps1` to select
the project's portable runtime without changing global Node. Electron's embedded
Node 24 is separate from this development toolchain. Windows GUI/native builds
require Windows tools; do not share `node_modules` between Windows and Linux.

```powershell
. ./scripts/use-toolchain.ps1
npm ci
npm run dev
```

`dev` prepares the matching Electron runtime and seven offline plugin packages,
then starts Vite and Electron. React edits hot-reload; restart after changes to
`electron/`. Native resources can require the Windows C++ toolchain when built
from source. End users do not run npm lifecycle scripts or compile plugins.

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm start
npm run pack:win  # release-electron/win-unpacked
npm run dist:win  # NSIS installer in release-electron
```

`npm run build` assembles all seven packages into `dist-plugins/`; Windows builds
include them outside ASAR at `resources/plugins/`. See
[official plugin build instructions](packages/official/README.md) for independent
plugin artifacts. Plain `npm pack` in a source directory does not assemble all
renderer, native and dictionary resources. Distribute the entire unpacked
application directory. Current installer and expanded plugin file sizes have
been measured in the [distribution record](Docs/evidence/spark233-packaging.md).
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
[MCP setup and permissions](Docs/mcp.md).

[Electron migration notes](Docs/electron-migration.md),
[earlier note acceptance items](Docs/electron-todo.md) and historical upstream
documentation under `Docs/upstream/` are retained. `src-tauri/`,
`scripts/legacy-tauri/` and `.github/legacy-tauri/` are historical references and
do not participate in current builds. The [MIT license](LICENSE), upstream
attribution, font notices and third-party licenses are preserved.
