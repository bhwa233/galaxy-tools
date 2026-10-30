# spark233 file search

Official Windows x64 plugin using Pulse's filename index service and ephemeral
Instant content agents. Build the native payload with
`pwsh -File scripts/native-search/build.ps1`; the script stages only the selected
production binaries and upstream licenses in this package.

The host asks for explicit confirmation before opening Windows UAC. The elevated
helper installs the service from a protected Program Files directory; SYSTEM never
executes code from the user-writable plugin store. Declining either confirmation
is retryable. Ordinary searches never elevate. Without the service they return an
installation action and do not silently walk the user profile.

Content search shares enabled supported volumes and exclusions with the filename
service and additionally excludes host private data. It reads text/Markdown/code
as the current user, one query at a time, without a persistent content-body index.
The native boundary supports cancellation and bounded pages. A packaged version
is immutable; query profiles and temporary request/result files belong in the
host-provided data/cache directories.

Upstream: https://github.com/jimmgreen/pulse, pinned commit
`c4fe01ed82fe091f495f531972a854aa32caac2b` (Apache-2.0).

The search workspace supports a directory for the current query without changing
the global index scope. Both filename and content queries retain existing private
root and access checks. Recent searches and saved conditions are kept in the
plugin's `workspace-history.json` (up to 50 each); they store query conditions,
never result-selection handles, and run a fresh query when reused. Clearing
recents preserves saved conditions.
