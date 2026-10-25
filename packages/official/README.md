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

Select the repository's Node/npm runtime, install its lockfile dependencies and
build the current shared UI source once:

```powershell
. ./scripts/use-toolchain.ps1
npm ci
npm run build
```

After changing a plugin's UI source, `npm exec -- vite build` refreshes the host
renderer input without producing an installer. Build a complete single plugin:

```powershell
node scripts/build-official-plugins.mjs --plugin spark233.notes
node scripts/build-official-plugins.mjs --plugin spark233.clipboard --output C:/tmp/spark233-clipboard-artifact
```

The default single-plugin output is
`local-build/spark233/plugin-artifacts/<plugin-id>/`; it contains the `.tgz`, its
one-package integrity index and file/size records. A single build preserves the
standard `dist-plugins/index.json`. `--output` selects a dedicated output folder.

`npm run plugins:build` assembles the complete offline distribution and requires
exactly seven plugins. Native payloads and the fixed dictionary are validated or
prepared through their existing build entry points. Clipboard business code is
bundled into `backend.mjs` before assembly. No npm install lifecycle scripts run
on the user's computer.

The full default build also prepares `dist-host/command-matcher`: the existing
applications pinyin wrapper, pinned native matcher, resource hashes and licenses
with the same relative layout. Electron-builder copies it to
`resources/command-matcher` outside ASAR. This lets general launcher commands use
pinyin while the applications plugin is disabled or uninstalled. Single-plugin
builds leave this host resource unchanged.

Notes, clipboard, dictionary/translation and OCR archives carry their own
versioned renderer code and font licenses. Their two large shared UI fonts use
the stable host contract `spark233://shared/ui/v1/…`; the font bytes remain in the
host distribution once. `renderer/spark233-shared-ui.json` records that v1
dependency, and per-package `resources.json` records include it. KaTeX fonts and
all other renderer resources remain in each independent archive.

Use the assembled `.tgz` for local import, review and authorized publication. It
includes generated renderer/native/data resources that are absent from a clean
source folder. Bump the package version before distributing changed immutable
code. Actual npm publication requires separate explicit authorization.
