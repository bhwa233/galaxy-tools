# spark233 search native boundary

This directory builds the selected Pulse backend at commit
`c4fe01ed82fe091f495f531972a854aa32caac2b`. The production plugin uses
`spark233.Search.exe`; the separate `spark233_search_probe.exe` retains the P1V
fixture diagnostics.

```powershell
pwsh -File scripts/native-search/build.ps1
pwsh -File scripts/native-search/smoke.ps1
# Production plugin chain after compiling Electron:
. ./scripts/use-toolchain.ps1
pnpm --filter @spark233/desktop exec tsc -p electron/tsconfig.json
pnpm --filter @spark233/desktop exec electron ../../scripts/native-search/production-smoke.cjs
```

The build uses the prepared MSVC environment, CMake and Ninja. The shared portable
toolchain defaults to `%LOCALAPPDATA%/spark233/toolchains`; `-ToolchainSetup`,
`-CMakeExecutable` and `-NinjaExecutable` can select other existing installations.
`-PrepareOnly` exports and namespaces the pinned source without compiling it.
`-SourceRepository` can reuse an existing checkout; otherwise the script clones
the upstream repository. `-BuildRoot` selects another isolated build directory.

`build.ps1` exports the committed source without modifying the original checkout,
records the archive SHA-256 and adapted files in `source-manifest.json`, then
compiles explicit search targets. It reuses upstream's CMake graph, query
protocol, Instant client, process jobs, per-caller visibility checks and
permission fixture. The file-manager UI is neither built nor launched.

Runtime identities are changed to the `spark233` namespace, including
`spark233Index`, `spark233.Index.exe`, `spark233ContentSearch`, local lock names,
data roots and `SPARK233_*` environment variables. The C++ `pulse` namespace and
compile-time feature macros remain upstream implementation details. The original
LICENSE and third-party notices remain in the exported source. Upstream is
Apache-2.0: <https://github.com/jimmgreen/pulse>.

`SPARK233_SEARCH_PROFILE_ROOT` and `SPARK233_SEARCH_MACHINE_ROOT` explicitly
override native known-folder paths during smoke runs; changing `LOCALAPPDATA`
alone does not redirect `SHGetFolderPath`. `SPARK233_DOCUMENT_ADMISSION_DIR`
and `SPARK233_CONTENT_TIMING_DIR` similarly isolate parser locks and timing logs.

The smoke runner creates all files, profiles, cache/index data and logs beneath
`local-build/spark233/native-search/runs/`. It starts an explicitly scoped
`--test-host` process, exercises actual filename queries, reuses the upstream
restricted-token/NTFS ACL check, and runs two representative Instant queries with
one cancellation/replacement check. It shuts down and checks child-agent cleanup.
It does not install a service or index user disks. Service installation and
full-volume MFT/USN validation remain part of the P5 Windows integration.

Instant mode reads matching bodies when queried; it does not start the legacy
background content writer. SQLite remains an upstream implementation dependency
for optional caches and per-query result spools; this adapter does not substitute
FTS5 for Instant.

The CLI is a P1V diagnostic entry, with tagged UTF-8 output:

```text
spark233_search_probe filename <spark233 fixture pipe> <needle>
spark233_search_probe shutdown <spark233 fixture pipe>
spark233_search_probe content <absolute fixture folder> <absolute isolated profile> <needle> [--exercise-cancel]
```

The production boundary accepts `--request <absolute request.json>` with protocol
1, immutable owner and session identity, action, mode, query, optional directory,
offset/limit and a host-provided profile. It atomically publishes `result.json`
beside the request. The adapter validates owner/session and bounded results,
creates opaque result selections/cursors, and replaces old queries cooperatively
through `cancel.request`. Current-user Instant agents stop before the task exits;
the shared filename service is not stopped on an individual query.

The production build disables upstream's profile-walk fallback. Missing services
produce an installation action. Installation requires a host confirmation followed
by Windows UAC; its fixed helper stages only known sibling binaries into a fresh
protected Program Files directory before invoking the upstream SCM installer.
Existing protected roots must have Administrator/SYSTEM ownership, reparse paths
are rejected, and copied files inherit destination security. Source package
paths are never registered as a LocalSystem service binary. Actual UAC/SYSTEM
installation and upgrade remain untested until an explicitly authorized machine
integration run; the isolated production smoke declines installation.
