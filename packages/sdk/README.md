# spark233 SDK

Local SDK under development. `@spark233/sdk` is a working package name, not a
claim that its npm scope has been registered. Publishing is a separate step.

A plugin is a prebuilt npm package with a `spark233` manifest in `package.json`.
The manifest is validated without running plugin code or npm lifecycle scripts.
`schemaVersion` is 1; the current host API is 1.2.0 and theme protocol is 1.0.0.
Package, plugin data and host API versions are independent.

Web entry paths, backend entry paths and native executable paths are relative to
the package root. A native or full Node backend is a trusted extension and needs
explicit approval for third-party packages. A separate process provides failure
isolation, not a Windows permission sandbox.

The host assigns runtime identity from its actual window/process binding.
Plugin-supplied IDs do not grant another plugin's capabilities or private data.
Image/file transfers use host-owned resource handles instead of private paths.

Build declarations and ESM with the repository's selected toolchain:

```powershell
pnpm sdk:build
```

This package contains the shared schemas, browser client, and native protocol
types used by the host. The browser client supports commands, hidden local
queries, capabilities, theme events, and save preparation. Native executables
implement the bounded [JSON-lines protocol](../../Docs/native-plugin-protocol.md);
they require explicit trust and keep save confirmation separate from process exit.
The host can import a prebuilt development directory as an immutable reviewed
snapshot, as well as local `.tgz` packages and compatible registry versions.

From host API 1.1, a command may declare `requiresPlugins: ["plugin.id"]`.
Each ID must also appear in the plugin's `dependencies` or `optionalDependencies`;
the version range comes from that declaration. Use an API range such as `^1.1.0`
when using this field. Commands disappear from the launcher and management page
when a required plugin is absent, disabled, failed or incompatible. Direct or
stale activation is rejected before the command runtime starts. This never
automatically enables the dependency or disables unrelated commands; an optional
dependency remains optional for the rest of the plugin.

Host API 1.2 / SDK 0.3 adds source-application commands. A command can declare
`sourceApplications: ["winword.exe", "excel.exe"]`; use `api: "^1.2.0"` when using
this field or the new `window` input/match kind. Rules contain 1–32 executable
basenames, are trimmed, lowercased and deduplicated, and reject full paths,
control characters and Windows filename separators. There are no wildcards.
Commands without this field retain their existing availability.

The host supplies `context.sourceApplication` from the captured source window.
It never contains a title, full executable path, process handle or HWND.
With no selected text/image/files, a `window` context has the shape
`{ kind: "window", sourceApplication: "winword.exe" }`; those three existing
context kinds can carry the same optional source metadata. Declare
`inputs: ["window"]` for a general source-window action, or combine the source
rule with an existing input kind to restrict a text/image/file action.
Source-restricted commands without a matching content input receive only the
window metadata, rather than gaining access to selected content implicitly.

The launcher applies source rules to ordinary results, aliases, pins, modes,
providers and secondary actions. Actual activation/query checks the declaration
again before cold startup and before dispatch. Missing or mismatching trusted
source metadata rejects a restricted command; renderer-supplied paths or source
names do not establish that context. The host-only dispatch guard is an in-memory
callback and is not part of IPC or this plugin protocol. Older commands that do
not opt into source/window features receive their original context shape,
without the new metadata or a window-only context.

For a data schema change, increment `spark233.dataVersion` and declare a prebuilt
`spark233.migration.entry`, such as `migrate.mjs`. Migration requires the
`node.backend` capability and explicit native trust even when the normal plugin
is Web-only or native-only. The module must export the named async function
`migrate(context: PluginMigrationContext): Promise<PluginMigrationResult>`.
The context supplies `fromDataVersion`, `toDataVersion`, `fromPluginVersion`,
`toPluginVersion`, `dataDir` and an `AbortSignal`. Transform and durably save the
owned data, then return `{dataVersion: context.toDataVersion}`. A missing entry,
failure or incorrect acknowledgement rejects the update. Do not use an ordinary
activation or backend factory as a migration handler.

The host stops the old runtime and backs up its data before running that module
in a separate utility process. It waits for successful acknowledgement and
process exit before constructing the ordinary backend. The module's default
factory is not called. Same-schema updates skip migration; schema downgrades and
unknown retained-data versions are rejected. Disabled updates still migrate and
perform initialization checks, then release the check runtime without business
startup activation or enabling the plugin. Ordinary backend factories receive
`context.startupCheckOnly` (default `false`); when it is `true`, validate resources
without starting business subscriptions or capture.

Committed data versions include the owning npm package name and survive uninstall
when data is kept. Another npm package cannot claim retained data through the
same plugin ID; explicitly deleting the old data releases that binding.
They participate in consistent backup/restore and migration-journal rollback.
An existing installed record can establish a baseline only after its package
identity and stored manifest hash are verified. Data without either that record
or committed version metadata is not silently adopted. Empty fresh data is
initialized at the new package's declared version.
