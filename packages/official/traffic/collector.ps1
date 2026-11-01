param([Parameter(Mandatory=$true)][int]$OwnerProcessId)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ownerProcess = [System.Diagnostics.Process]::GetProcessById($OwnerProcessId)
$null = $ownerProcess.Handle
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$discoveredAt = -30000L
$physicalIds = @{}
try {
  while (-not $ownerProcess.HasExited) {
    $started = $clock.ElapsedMilliseconds
    try {
      if ($started - $discoveredAt -ge 30000) {
        $found = @{}
        foreach ($adapter in Get-NetAdapter -Physical -IncludeHidden -ErrorAction Stop) {
          $found[$adapter.InterfaceGuid.ToString().Trim('{}').ToLowerInvariant()] = $true
        }
        $physicalIds = $found
        $discoveredAt = $started
      }
      $adapters = @()
      foreach ($adapter in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
        $id = $adapter.Id.Trim('{}').ToLowerInvariant()
        if (-not $physicalIds.ContainsKey($id) -or $adapter.OperationalStatus -ne 'Up') { continue }
        $properties = $adapter.GetIPProperties()
        $index = 0
        try { $index = $properties.GetIPv4Properties().Index } catch { $index = $properties.GetIPv6Properties().Index }
        $addresses = @($properties.UnicastAddresses | ForEach-Object { $_.Address.ToString() })
        $statistics = $adapter.GetIPStatistics()
        $adapters += @{
          id=$id; index=$index; name=$adapter.Name; description=$adapter.Description
          addresses=$addresses; rx=$statistics.BytesReceived.ToString([Globalization.CultureInfo]::InvariantCulture)
          tx=$statistics.BytesSent.ToString([Globalization.CultureInfo]::InvariantCulture)
        }
      }
      $frame = @{ at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); elapsedMs=$clock.ElapsedMilliseconds; adapters=$adapters }
      [Console]::Out.WriteLine(($frame | ConvertTo-Json -Depth 5 -Compress))
      [Console]::Out.Flush()
    } catch {
      [Console]::Out.WriteLine((@{ at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); elapsedMs=$clock.ElapsedMilliseconds; error=$_.Exception.Message } | ConvertTo-Json -Compress))
      [Console]::Out.Flush()
    }
    $remaining = 1000 - ($clock.ElapsedMilliseconds - $started)
    if ($remaining -gt 0) { Start-Sleep -Milliseconds $remaining }
  }
} finally { $ownerProcess.Dispose() }
