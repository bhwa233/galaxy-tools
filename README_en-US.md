# Floral Notepaper — Electron migration

The active desktop runtime is now Electron 45 with TypeScript, React 19 and Vite 8. The first supported target is Windows 11 x64. See the [current setup and packaging instructions](README.md) and [migration notes](Docs/electron-migration.md).

Use Node.js 24: `npm ci`, then `npm run dev`. Run `npm run build` and `npm start` for production assets, `npm run pack:win` for a Windows application directory, or `npm run dist:win` for NSIS.

Markdown files, image directories and current floral metadata remain compatible. Notes are saved before their windows are destroyed; hidden notes can be reopened through the tray. The upstream Tauri updater is disabled. Native mouse/IME/multi-monitor acceptance remains separate from build and integration checks.

Historical upstream documentation is preserved under `Docs/upstream/`. The MIT license and upstream attribution are retained.
