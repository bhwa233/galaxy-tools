[CmdletBinding()]
param([string]$BuildRoot)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $BuildRoot) { $BuildRoot = Join-Path $repoRoot 'local-build/spark233/native-clipboard' }
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
$pinned = @{
    '@crosscopy/clipboard' = 'sha512-h/LlfI5t/xsxLr63g3Os0mjoeITj7/8x8Goy5PZ+f4bk3DDgc1r5VXO462U3e8/+LjHixtvS9sTk/MoKEwSutw=='
    '@crosscopy/clipboard-win32-x64-msvc' = 'sha512-GZ0i9XoPYQV5DhTQWiHjArE3ZTuovHmHNL7yE6Pm/91icOtrm9Mk9tVnpU/rQR9bzOn3MqN8+AFsp5NKZqTg7Q=='
}
foreach ($name in $pinned.Keys) {
    $metadata = Invoke-RestMethod ('https://registry.npmjs.org/' + [Uri]::EscapeDataString($name))
    $version = $metadata.versions.'0.3.6'
    if ($version.dist.integrity -ne $pinned[$name]) { throw "Registry integrity changed: $name" }
    [ordered]@{ latestObserved = $metadata.'dist-tags'.latest; observedUtc = (Get-Date).ToUniversalTime().ToString('o'); package = $version } |
        ConvertTo-Json -Depth 15 | Set-Content -LiteralPath (Join-Path $BuildRoot (($name -replace '[@/]', '-') + '.metadata.json')) -Encoding utf8
}
. (Join-Path $repoRoot 'scripts/use-toolchain.ps1')
$manifest = Join-Path $BuildRoot 'package.json'
if (-not (Test-Path -LiteralPath $manifest)) {
    @{ private = $true } | ConvertTo-Json | Set-Content -LiteralPath $manifest -Encoding utf8
}
& pnpm.cmd --dir $BuildRoot --ignore-workspace add --ignore-scripts --save-exact '@crosscopy/clipboard@0.3.6'
if ($LASTEXITCODE -ne 0) { throw 'Isolated clipboard package installation failed' }
$lock = Get-Content -LiteralPath (Join-Path $BuildRoot 'pnpm-lock.yaml') -Raw
foreach ($name in $pinned.Keys) {
    if (-not $lock.Contains("resolution: {integrity: $($pinned[$name])}")) { throw "Installed lock integrity mismatch: $name" }
}
