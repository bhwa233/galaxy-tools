[CmdletBinding()]
param([string]$BuildRoot)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $BuildRoot) { $BuildRoot = Join-Path $repoRoot 'local-build/spark233/native-traffic' }
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
$env:MSBuildEnableWorkloadResolver = 'false'
$project = Join-Path $repoRoot 'native/traffic/Verification/Traffic.Verification.csproj'
& dotnet build $project -c Release "-p:TrafficBuildRoot=$BuildRoot" "-p:RestorePackagesPath=$BuildRoot/nuget" --configfile (Join-Path $repoRoot 'native/traffic/NuGet.Config')
if ($LASTEXITCODE -ne 0) { throw 'Traffic verification build failed' }
$run = Join-Path $BuildRoot ('verification/' + [guid]::NewGuid().ToString())
$executable = Join-Path $BuildRoot 'bin/Traffic.Verification/Release/net48/spark233.Traffic.Verify.exe'
$report = & $executable $run
if ($LASTEXITCODE -ne 0) { throw 'Traffic native verification failed' }
$report | Set-Content -LiteralPath (Join-Path $run 'report.json') -Encoding utf8
$report
