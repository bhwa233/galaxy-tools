# spark233 SDK

Local SDK under development. `@spark233/sdk` is a working package name, not a
claim that its npm scope has been registered. Publishing is a separate step.

Browser pages with an explicitly granted `node.backend` capability can call their
current backend using `client.capability("node.backend", "invoke", { commandId,
parameters })`. Only the same plugin's public headless commands are accepted;
internal commands, window commands and commands requiring file/image/window or
host-observed source context are rejected. Requests use the current owner and
existing scoped task cancellation, with bounded JSON input/output and owner
checks before dispatch and before returning. The host never falls back to
`activate` or starts a different plugin through this operation.

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

### Global shortcuts and system tray actions

Every declared public command can be assigned a global shortcut in the host's
**Settings → Keyboard shortcuts** page. The plugin's Functions page links to
that page with the plugin selected. These bindings are owned by the host, survive
plugin updates, and are released when the command becomes unavailable. Prefer
these user-controlled bindings over registering fixed accelerators yourself.

Declare optional system tray actions in `spark233.tray`:

```json
{
  "tray": [
    { "id": "open", "commandId": "open", "order": 0 },
    {
      "id": "pause",
      "commandId": "toggle-recording",
      "title": "Pause recording",
      "type": "checkbox",
      "group": "recording",
      "order": 10,
      "translations": { "zh-CN": { "title": "暂停记录" } }
    }
  ]
}
```

Each item must have a unique local ID and reference this plugin's declared
public command; internal commands and commands owned by another plugin are
rejected. There are at most 32 items per plugin. `title` defaults to the localized
command title, `type` defaults to `normal`, and `order` defaults to zero. Group
changes insert separators inside the plugin's submenu. The host owns the root
menu, including settings and save-before-quit. Users can hide and reorder items
and plugin groups in **Settings → System tray**. These preferences survive
disable/re-enable; an unavailable plugin contributes no executable menu items.

Checkboxes initially display unchecked. Publish the actual state at startup and
whenever the underlying setting changes. A browser plugin declares and obtains
the `tray` capability, then calls:

```js
await client.capability("tray", "update", {
  id: "pause",
  checked: true,
  enabled: true,
});
```

Trusted Node backends use their existing context event transport:
`context.emit("tray-state", { id: "pause", checked: true })`. Native runtimes
can send the equivalent `tray-state` event through their existing event protocol.
State updates can target only the current instance's declared items. `checked`
is valid only on a checkbox; `enabled` is valid on either item type. Partial
updates preserve the other state fields. Updates never grant new commands or
override user visibility preferences. State is discarded when the instance is
released; stale instances cannot update a replacement's menu. The host does not
optimistically change checkbox state when activation fails or is still pending.

The seven official plugin packages include tray declarations. Existing installs
can explicitly update them from the newer bundled packages in plugin management;
the host does not silently replace installed plugin data or modify user profiles.

## Plugin presentation (host API 1.3)

New declarations require `spark233.host: ">=0.0.1 <1"` or a narrower compatible
0.x host range. Older manifests without them remain valid. SDK npm and host API
versions are independent.

| Field                                | Contract                                                                                                                                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui.icon`                            | `{ png, ico?, monochrome? }`, relative package paths. PNG serves UI/native windows; ICO serves Windows Shell. Set `monochrome: true` for symbolic icons that follow the UI primary color; other icons retain their original colors. |
| `ui.windows.<profile>`               | Own HTML `entry`, localized `title`, icon override, `size`, `minSize`, `resizable`, `maximizable`, `taskbar`, `reuse`, `presentation`.                                                                                              |
| `commands[].window`                  | A profile declared by this plugin. The generic Web runtime opens its entry on activation.                                                                                                                                           |
| `commands[].launcher.role`           | `entry` (at most one), `action`, `keyword-only`, `hidden`. Internal commands can only be hidden. Omitted declarations retain generic legacy behavior.                                                                               |
| `commands[].launcher.input`          | `query` uses current launcher text; `context` prefers captured context.                                                                                                                                                             |
| `commands[].launcher.withInput`      | Keeps an entry alongside applicable actions when input is present.                                                                                                                                                                  |
| `commands[].launcher.preferSentence` | Ranks an applicable action for sentence input, without executing it.                                                                                                                                                                |
| `commands[].progress`                | `{ title, cancelCommand, translations? }`; cancellation stays visible until the original action settles. The cancel command must be public and belong to this plugin.                                                               |

See `examples/plugins/hello-web/package.json`: no launcher source registration
is required. `reuse` defaults to singleton; `document` uses activation
`parameters.documentId` when supplied, otherwise a new document identity.
`presentation` defaults to standard. Titles fall back to the localized plugin
name; window icons inherit `ui.icon`. Dimensions are constrained to the display.
Existing official window geometry takes priority. `legacyLabels` migrates old
official window labels.

Host API 1.5 adds `ui.windows.<profile>.titleBar: "custom"` for a frameless Web
window. Declare `api: ">=1.5.0 <2.0.0"`; omitted or `"native"` retains the system
title bar. `client.window.minimize()`, `toggleMaximize()` and `isMaximized()` act
only on the calling plugin's declared custom window and accept no target or
options. Maximize respects both `resizable` and `maximizable`. `client.close()`
keeps the existing save-before-close lifecycle. Use native CSS drag regions for
title bar movement and exclude controls with `app-region: no-drag`.

HTML/icon paths are confined to the package, including symlink resolution.
Icons are signature checked, limited to 1 MiB and PNG 1024 pixels per side.
Ship resources in the package's `files` list. Declarations never grant arbitrary
BrowserWindow options, AppUserModelIDs, permissions or lifecycle overrides.
The host assigns stable plugin AppIDs and protects native titles from HTML.

Public defaults belong in the manifest; private static navigation/filter
defaults belong in the plugin's `config/` directory. History, credentials and
user preferences remain in private runtime stores and are never bundled.
Official renderers have their own `renderer/main.tsx`, shared shell and desktop
bridge. Generic Web plugins keep the restricted browser SDK and save protocol;
they do not gain access to the official desktop bridge.

## Desktop cards (host API 1.4)

Desktop cards are templates under `ui.widgets`; users create durable instances
of those templates. A widget-only plugin does not need a dummy page or backend.
Declare `api: ">=1.4.0 <2.0.0"`; broad ranges including older APIs are rejected.
Old plugins without widgets keep their existing contracts.

```json
{
  "ui": {
    "theme": "^1.0.0",
    "widgets": {
      "clock": {
        "kind": "declarative",
        "title": "Clock",
        "template": "widgets/clock.json",
        "size": { "width": 240, "height": 80 },
        "clickThrough": true,
        "interactive": false,
        "data": { "time": { "source": "host", "provider": "host.clock", "format": "text" } }
      }
    }
  }
}
```

The JSON template is a bounded tree of `stack`, `text`, `number`, `progress`,
`icon`, `sparkline`, `rank-list` and `button` nodes. It contains no scripts, raw HTML, CSS or
expressions. The host validates the template, data formats and referenced action
IDs before execution. A clock template may use:

```json
{
  "version": 1,
  "padding": 12,
  "background": "card",
  "root": {
    "type": "text",
    "value": { "dataKey": "time" },
    "size": "title",
    "tone": "default",
    "maxLines": 1
  }
}
```

Custom Web templates instead use `kind:"web", entry:"widgets/example/index.html"`.
They run in a separate restricted shell. Import the standalone browser module
with `import { connectWidget } from "/__sdk__/widget.js"`, then await
`connectWidget()` and use `onInit`, `onData`, `onVisibility`, `onSize`, `invoke`,
`openMain`, `resize` and `dispose`. It exposes no Node, file, network, native or
arbitrary window API. A Web card may still trigger its plugin's explicitly
declared actions, so the action list is part of the trust summary.

`commands` is the public-command allowlist; `actions` maps public action IDs to
`{mode:"query"|"action"|"open-main", commandId, entryId?}`. Headless query/action
commands cannot reference window commands or require captured files/images/window
context. A Web card's `openMain(actionId)` requires its own user activation, then
offers a 10-second candidate in the trusted host shell. The user must click the
shell's "Open main page" button before the host dispatches that command; child
messages cannot supply this confirmation. Cancelling, expiry, editing, hiding
or retiring the owner/load generation prevents pending navigation. Passive cards may
declare query subscriptions but cannot invoke user actions. Backend/native data
binds `event` and `subscriptionAction`; the latter must reference a query action.
Data events contain `{widgetInstanceId,values:{...}}` and must come from the
declared source and native entry. The host supplies action parameters as
`{widgetInstanceId,input}`; business configuration remains in the plugin dataDir.

Templates are limited to 32 KiB, 64 nodes and depth 4; complete display frames to
16 KiB, 16 keys and 480 series samples. Invalid frames are rejected whole, not
truncated. Null means unavailable. The host owns geometry, input mode and
lifecycle; disabling removes live views and subscriptions while retaining saved
instances. Updating or reloading revokes old owner/load-generation ports and
requests. Package paths and PNG resources are confined and checked at install.

Declarative widgets may optionally declare `desktopInteractions` for a host-owned
primary `open-main` action, a hover template and native desktop preferences/menu.
The primary command must also appear in the widget's public `commands` allowlist;
the window profile belongs to that command, not to the action. This mode uses
trusted pointer input, separates dragging from clicking and keeps temporary hover,
edge-hide and drag geometry outside durable layouts. Existing widgets retain
their original interaction behavior.

`format:"rows"` binds a `rank-list` to at most three display-only records
`{id,label,valueText,iconId?}`. A template has at most two lists and a frame at most
six total rows. URLs, paths and arbitrary fields are rejected. Upload/download
tones use the host's orange/green semantic colors. A matching backend/native event
may include a separate `icons` dictionary with PNG Base64 values, bound to the
same current owner and widget instance. Attachments are limited to six images,
64 KiB decoded per image, 256×256 pixels and 256 KiB decoded total, and cannot
override static resource IDs. They do not relax the 16 KiB widget data frame.
