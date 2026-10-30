# Official spark233 plugin artifacts

These seven packages are assembled locally before distribution. The npm scope
is provisional until account ownership is verified; the build does not publish.

| Plugin ID               | Source directory |
| ----------------------- | ---------------- |
| `spark233.notes`        | `notes`          |
| `spark233.screenshot`   | `screenshot`     |
| `spark233.ocr`          | `ocr`            |
| `spark233.translation`  | `translation`    |
| `spark233.clipboard`    | `clipboard`      |
| `spark233.applications` | `applications`   |
| `spark233.search`       | `search`         |

All seven plugins have representative functional cases in the existing Vitest
runner. Run `pnpm test`, or filter them with
`pnpm test packages/official apps/desktop/electron/plugins/official`. Coverage and controlled
OS/provider boundaries are recorded in the [functional test report](../../Docs/archive/2026-10/spark233-plugin-functional-tests-2026-10-27.md).

Select the repository's Node/pnpm runtime, install its lockfile dependencies and
build the current shared UI source once:

```powershell
. ./scripts/use-toolchain.ps1
pnpm install --frozen-lockfile
pnpm build
```

Each renderer plugin builds its own `renderer/main.tsx` from its declared entry.
Changing plugin UI requires rebuilding that plugin; rebuilding the host renderer
alone does not refresh plugin archives. Build a complete single plugin:

```powershell
pnpm --filter @spark233/plugin-notes build
node scripts/build-official-plugins.mjs --plugin spark233.clipboard --output C:/tmp/spark233-clipboard-artifact
```

The default single-plugin output is
`local-build/spark233/plugin-artifacts/<plugin-id>/`; it contains the `.tgz`, its
one-package integrity index and file/size records. A single build preserves the
standard `dist-plugins/index.json`. `--output` selects a dedicated output folder.

`pnpm plugins:build` assembles the complete offline distribution and requires
exactly seven plugins. Native payloads and the fixed dictionary are validated or
prepared through their existing build entry points. Notes and clipboard business code is
bundled into each package’s `backend.mjs` before assembly. No npm install lifecycle scripts run
on the user's computer.

The full default build also prepares `dist-host/command-matcher`: the existing
applications pinyin wrapper, pinned native matcher, resource hashes and licenses
with the same relative layout. Electron-builder copies it to
`resources/command-matcher` outside ASAR. This lets general launcher commands use
pinyin while the applications plugin is disabled or uninstalled. Single-plugin
builds leave this host resource unchanged.

Notes, clipboard, search, screenshot history, dictionary/translation and OCR archives carry their own
versioned renderer code and font licenses. Their two large shared UI fonts use
the stable host contract `spark233://shared/ui/v1/…`; the font bytes remain in the
host distribution once. `renderer/spark233-shared-ui.json` records that v1
dependency, and per-package `resources.json` records include it. KaTeX fonts and
all other renderer resources remain in each independent archive.

Use the assembled `.tgz` for local import, review and authorized publication. It
includes generated renderer/native/data resources that are absent from a clean
source folder. Bump the package version before distributing changed immutable
code. Actual npm publication requires separate explicit authorization.

`--renderer <directory>` accepts prebuilt input with one folder per plugin ID,
such as `<directory>/spark233.search/index.html`; it no longer accepts a shared
host renderer. Normal builds reject launcher/host-router imports in the Vite
module graph and emit `renderer/spark233-renderer.json` with the owner identity.
Icons/window defaults live in plugin manifests; private static UI defaults live
under each plugin's `config/` directory.
