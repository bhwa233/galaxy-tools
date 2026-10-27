# Notes plugin data engine

This package bundles the existing Markdown, metadata, attachment and reminder
engine into `backend.mjs`. The trusted Electron utility process runs this code;
the main process owns windows, OS notifications and the scoped trash bridge.
Updating the assembled plugin replaces the data engine and renderer together.

Version 0.1.2 keeps data format version 1. If a synchronous metadata commit fails,
the engine restores the previous Markdown bytes or removes the newly created
target, preserving the existing note and preventing duplicate IDs on rebuild.
If restoring the target also fails, both failures are reported. This does not
provide a multi-file transaction across a power loss.

`apps/desktop/electron/plugins/official/notes-data-contract.ts` defines the internal versioned
data protocol. Ordinary host calls use `NotesDataClient` through the live plugin
manager. Startup and final-save transports are restricted to the current owner;
final writes require a new durable preparation before release.

Settings renderers now send `config_patch` with only the edited fields; the host
merges them into its latest configuration and merges command shortcuts by command
ID. `dataDir` is excluded and still requires the migration transaction. The old
full-snapshot `config_save` request is rejected with `obsoleteClient`, so older
independent renderer archives need to be rebuilt/updated before their settings
pages can save. Reloading a page only helps when its installed archive already
contains the new client; this is not unchanged compatibility with older archives.

```sh
pnpm sdk:build
pnpm --filter @spark233/plugin-notes typecheck
pnpm --filter @spark233/plugin-notes build:backend
pnpm --filter @spark233/desktop exec tsc -p electron/tsconfig.json
node scripts/verify-notes-backend.mjs
```

The probe uses synthetic data under `local-build/`, real utility processes and a
controlled trash refusal/move. It does not operate the user's recycle bin.
Build the renderer and use the official assembly script for a complete archive:

```sh
pnpm --filter @spark233/desktop exec vite build
pnpm --filter @spark233/plugin-notes build
```

See [official package assembly](../README.md) and the
[current integration evidence](../../../Docs/evidence/spark233-notes-utility-integration.md).
