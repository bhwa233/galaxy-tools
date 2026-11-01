[CmdletBinding()]
param(
  [string]$BuildRoot,
  [string]$StageDirectory,
  [switch]$UpdateLock
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $BuildRoot) { $BuildRoot = Join-Path $repoRoot 'local-build/spark233/native-traffic' }
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
if (-not $StageDirectory) { $StageDirectory = Join-Path $BuildRoot 'stage' }
$StageDirectory = [IO.Path]::GetFullPath($StageDirectory)
New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
if (Test-Path -LiteralPath $StageDirectory) {
  if (@(Get-ChildItem -LiteralPath $StageDirectory -Force).Count -gt 0) {
    $previous = Join-Path $StageDirectory 'resources.json'
    if (-not (Test-Path -LiteralPath $previous)) { throw "Refusing to overwrite an unrelated directory: $StageDirectory" }
  }
}
$env:MSBuildEnableWorkloadResolver = 'false'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$packages = Join-Path $BuildRoot 'nuget'
$sourceRoot = Join-Path $repoRoot 'native/traffic'
$projects = @('Core', 'Client', 'Service', 'Setup')
foreach ($project in $projects) {
  $projectPath = Join-Path $sourceRoot "$project/Traffic.$project.csproj"
  $restoreArguments = @('restore', $projectPath, '--configfile', (Join-Path $sourceRoot 'NuGet.Config'), '--packages', $packages, "-p:TrafficBuildRoot=$BuildRoot")
  if (-not $UpdateLock) { $restoreArguments += '--locked-mode' }
  & dotnet @restoreArguments
  if ($LASTEXITCODE -ne 0) { throw "Traffic $project restore failed" }
  & dotnet build $projectPath -c Release --no-restore "-p:TrafficBuildRoot=$BuildRoot" "-p:RestorePackagesPath=$packages"
  if ($LASTEXITCODE -ne 0) { throw "Traffic $project build failed" }
}

# Inventory generated outputs first. Existing files outside the previous inventory are never deleted.
$inventory = [ordered]@{}
foreach ($project in @('Client', 'Service', 'Setup')) {
  $output = Join-Path $BuildRoot "bin/Traffic.$project/Release/net48"
  foreach ($file in Get-ChildItem -LiteralPath $output -Recurse -File) {
    if ($file.Extension -in '.pdb', '.xml') { continue }
    $relative = $file.FullName.Substring($output.TrimEnd('\','/').Length + 1).Replace('\', '/')
    if ($relative.StartsWith('runtimes/') -or $relative.StartsWith('x86/') -or $relative.StartsWith('arm64/')) { continue }
    $relative = $file.Name
    if ($inventory.Contains($relative) -and (Get-FileHash -LiteralPath $inventory[$relative]).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash) { throw "Conflicting runtime file: $relative" }
    $inventory[$relative] = $file.FullName
  }
}
$sqliteNative = Join-Path $packages 'sqlitepclraw.lib.e_sqlite3/2.1.13/runtimes/win-x64/native/e_sqlite3.dll'
if (-not (Test-Path -LiteralPath $sqliteNative)) { throw 'Pinned SQLite x64 native dependency is missing' }
$inventory['e_sqlite3.dll'] = $sqliteNative

if (Test-Path -LiteralPath (Join-Path $StageDirectory 'resources.json')) {
  $previousInventory = Get-Content -LiteralPath (Join-Path $StageDirectory 'resources.json') -Raw | ConvertFrom-Json
  foreach ($oldFile in $previousInventory.files) {
    $oldRelative = if ($oldFile.name) { $oldFile.name } else { $oldFile.path }
    if ($oldRelative -and -not $oldRelative.StartsWith('licenses/') -and -not $inventory.Contains($oldRelative)) {
      $oldTarget = [IO.Path]::GetFullPath((Join-Path $StageDirectory $oldRelative))
      if (-not $oldTarget.StartsWith($StageDirectory.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Previous resource inventory escaped staging' }
      if (Test-Path -LiteralPath $oldTarget -PathType Leaf) { Remove-Item -LiteralPath $oldTarget -Force }
    }
  }
}
New-Item -ItemType Directory -Path $StageDirectory -Force | Out-Null
$licenseRoot = Join-Path $StageDirectory 'licenses'
New-Item -ItemType Directory -Path $licenseRoot -Force | Out-Null
$licenses = @()
$lock = Get-Content -LiteralPath (Join-Path $sourceRoot 'Core/packages.lock.json') -Raw | ConvertFrom-Json
$dependencyGroup = $lock.dependencies.PSObject.Properties | Select-Object -First 1
foreach ($dependency in $dependencyGroup.Value.PSObject.Properties) {
  if ($dependency.Name -like 'Microsoft.NETFramework.ReferenceAssemblies*') { continue }
  $packageDirectory = Join-Path $packages ($dependency.Name.ToLowerInvariant() + '/' + $dependency.Value.resolved)
  $nuspecPath = @(Get-ChildItem -LiteralPath $packageDirectory -Filter '*.nuspec' -File)[0].FullName
  [xml]$nuspec = Get-Content -LiteralPath $nuspecPath -Raw
  $license = $nuspec.package.metadata.license
  $licenses += [ordered]@{ name = $dependency.Name; version = $dependency.Value.resolved; license = [string]$license.InnerText; licenseUrl = [string]$nuspec.package.metadata.licenseUrl }
  $noticePath = Join-Path $licenseRoot ($dependency.Name + '.nuspec')
  Copy-Item -LiteralPath $nuspecPath -Destination $noticePath -Force
  foreach ($notice in Get-ChildItem -LiteralPath $packageDirectory -File | Where-Object Name -Match '(?i)^(license|notice|copying)') {
    Copy-Item -LiteralPath $notice.FullName -Destination (Join-Path $licenseRoot ($dependency.Name + '-' + $notice.Name)) -Force
  }
  if ($license.type -eq 'file') {
    $licenseFile = Join-Path $packageDirectory $license.InnerText
    if (Test-Path -LiteralPath $licenseFile) { Copy-Item -LiteralPath $licenseFile -Destination (Join-Path $licenseRoot ($dependency.Name + '-LICENSE.txt')) -Force }
  }
}
foreach ($entry in $inventory.GetEnumerator()) {
  $target = Join-Path $StageDirectory $entry.Key
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  Copy-Item -LiteralPath $entry.Value -Destination $target -Force
}
[IO.File]::WriteAllText((Join-Path $StageDirectory 'licenses/dependencies.json'), ($licenses | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
$files = @($inventory.Keys | ForEach-Object {
  $stagedFile = Get-Item -LiteralPath (Join-Path $StageDirectory $_)
  [pscustomobject][ordered]@{ name = $_; bytes = $stagedFile.Length; sha256 = (Get-FileHash -LiteralPath $stagedFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
} | Sort-Object { $_.name })
$inputs = [ordered]@{}
$inputFiles = @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File | Where-Object { $_.FullName -notmatch '[\\/](bin|obj)[\\/]' -and ($_.Extension -in '.cs', '.csproj', '.props', '.manifest' -or $_.Name -in 'packages.lock.json', 'NuGet.Config') })
$inputFiles += Get-Item -LiteralPath $PSCommandPath
foreach ($inputFile in $inputFiles | Sort-Object FullName) {
  $relativeInput = $inputFile.FullName.Substring($repoRoot.TrimEnd('\','/').Length + 1).Replace('\','/')
  $inputs[$relativeInput] = (Get-FileHash -LiteralPath $inputFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}
$manifest = [ordered]@{ protocol = 1; runtime = 'net48'; architecture = 'x64'; version = '1.0.0'; entryName = 'spark233.TrafficClient.exe'; inputs = $inputs; files = $files }
[IO.File]::WriteAllText((Join-Path $StageDirectory 'resources.json'), ($manifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
[ordered]@{ stageDirectory = $StageDirectory; files = $files.Count; bytes = ($files | Measure-Object -Property bytes -Sum).Sum; runtime = 'net48-x64'; lockedRestore = -not $UpdateLock } | ConvertTo-Json
