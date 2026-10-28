[CmdletBinding()]
# Requires an interactive Windows desktop. The isolated sessions never save captured pixels.
param(
    [string]$Executable = (Join-Path $PSScriptRoot '../../local-build/spark233/native-capture-p4/build/ScreenCapture.exe'),
    [string]$OutputRoot = (Join-Path $PSScriptRoot '../../local-build/spark233/pin-regression')
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class PinProbe {
    public delegate bool Callback(IntPtr hwnd, IntPtr arg);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr arg);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("gdi32.dll")] public static extern uint GetPixel(IntPtr dc, int x, int y);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp);
    public static IntPtr[] Windows(uint owner) {
        var list = new List<IntPtr>();
        EnumWindows((h, p) => { uint id; GetWindowThreadProcessId(h, out id); if (id == owner && IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
        return list.ToArray();
    }
    public static string Title(IntPtr h) { var b = new StringBuilder(256); GetWindowText(h, b, b.Capacity); return b.ToString(); }
    public static Rect Bounds(IntPtr h) { Rect r; if (!GetWindowRect(h, out r)) throw new Exception("GetWindowRect failed"); return r; }
    public static void Mouse(IntPtr h, int msg, int x, int y) { PostMessage(h, (uint)msg, IntPtr.Zero, (IntPtr)((y << 16) | (x & 65535))); }
    public static uint[] Samples(IntPtr h) {
        var r = Bounds(h); var dc = GetDC(IntPtr.Zero); var pixels = new uint[81];
        try { for (int i = 0; i < pixels.Length; i++) pixels[i] = GetPixel(dc, r.left + 100 + i, r.top + 80); }
        finally { ReleaseDC(IntPtr.Zero, dc); }
        return pixels;
    }
}
'@

$exe = [IO.Path]::GetFullPath($Executable)
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
New-Item -ItemType Directory -Force $OutputRoot | Out-Null
function Wait-Window([int]$pidValue, [scriptblock]$predicate) {
    for ($i = 0; $i -lt 100; $i++) {
        foreach ($h in [PinProbe]::Windows($pidValue)) {
            $r = [PinProbe]::Bounds($h)
            if (& $predicate $h $r) { return $h }
        }
        Start-Sleep -Milliseconds 50
    }
    throw 'Timed out waiting for screenshot window'
}
function Click-At([IntPtr]$h, [int]$x, [int]$y) {
    [PinProbe]::Mouse($h, 0x200, $x, $y)
    [PinProbe]::Mouse($h, 0x201, $x, $y)
    [PinProbe]::Mouse($h, 0x202, $x, $y)
    Start-Sleep -Milliseconds 350
}
function Run-Scenario([bool]$annotate) {
    $id = [Guid]::NewGuid().ToString('N')
    $dir = Join-Path $OutputRoot "session-$id"
    New-Item -ItemType Directory $dir | Out-Null
    $process = Start-Process -FilePath $exe -PassThru -ArgumentList @('--auto-quit=true', "--spark233-session=$id", ('"--spark233-session-dir={0}"' -f $dir), '--spark233-ocr-enabled=false')
    try {
        $cap = Wait-Window $process.Id { param($h,$r) [PinProbe]::Title($h) -eq 'Screen Capture' }
        [PinProbe]::Mouse($cap, 0x201, 120, 120)
        [PinProbe]::Mouse($cap, 0x200, 520, 420)
        [PinProbe]::Mouse($cap, 0x202, 520, 420)
        $tool = Wait-Window $process.Id { param($h,$r) $h -ne $cap -and ($r.right-$r.left) -gt 180 -and ($r.bottom-$r.top) -lt 100 }
        $rect = [PinProbe]::Bounds($tool)
        $dpi = [PinProbe]::GetDpiForWindow($tool) / 96.0
        if ($annotate) {
            Click-At $tool ([int](16*$dpi)) ([int](16*$dpi))
            $pin = Wait-Window $process.Id { param($h,$r) ($r.right-$r.left) -ge 390 -and ($r.right-$r.left) -le 410 -and ($r.bottom-$r.top) -ge 290 -and ($r.bottom-$r.top) -le 310 }
            $tool = Wait-Window $process.Id { param($h,$r) $h -ne $pin -and ($r.right-$r.left) -gt 300 -and ($r.bottom-$r.top) -lt 100 }
            $rect = [PinProbe]::Bounds($tool)
            $dpi = [PinProbe]::GetDpiForWindow($tool) / 96.0
            $before = [PinProbe]::Samples($pin)
            Click-At $tool ([int](16*$dpi)) ([int](16*$dpi))
            [PinProbe]::Mouse($pin, 0x201, 80, 80)
            [PinProbe]::Mouse($pin, 0x200, 200, 160)
            [PinProbe]::Mouse($pin, 0x202, 200, 160)
            Start-Sleep -Milliseconds 500
            $marked = [PinProbe]::Samples($pin)
            $changed = @(0..80 | Where-Object { $before[$_] -ne $marked[$_] })
            if ($changed.Count -lt 10) { throw 'The annotation did not render' }
        }
        Click-At $tool ([int](($rect.right-$rect.left)-112*$dpi)) ([int](16*$dpi))
        $pin = Wait-Window $process.Id { param($h,$r) ($r.right-$r.left) -ge 390 -and ($r.right-$r.left) -le 410 -and ($r.bottom-$r.top) -ge 290 -and ($r.bottom-$r.top) -le 310 }
        if ([PinProbe]::IsWindowVisible($tool)) { throw 'Pin button left the toolbar visible' }
        if (([PinProbe]::GetWindowLongPtr($pin,-20).ToInt64() -band 8) -eq 0) { throw 'Pinned image is not topmost' }
        if ($annotate) {
            $afterPin = [PinProbe]::Samples($pin)
            $retained = @($changed | Where-Object { $marked[$_] -eq $afterPin[$_] })
            if ($retained.Count -lt 10) { throw 'Pinning did not retain the annotation' }
        }
        [PinProbe]::Mouse($pin, 0x204, 40, 40)
        [PinProbe]::Mouse($pin, 0x205, 40, 40)
        $restored = Wait-Window $process.Id { param($h,$r) $h -ne $pin -and ($r.right-$r.left) -gt 300 -and ($r.bottom-$r.top) -lt 100 }
        if ($restored -eq [IntPtr]::Zero) { throw 'Right-click did not restore editing toolbar' }
        [PinProbe]::PostMessage($pin, 0x100, [IntPtr]27, [IntPtr]::Zero) | Out-Null
        if (!$process.WaitForExit(5000)) { throw 'Screenshot process did not exit after Escape' }
        if ($process.ExitCode -ne 0) { throw "Screenshot process exited $($process.ExitCode)" }
        Write-Output "PASS: $(if ($annotate) {'annotation retained'} else {'selection'}) pin, topmost, restore, exit"
    } finally {
        if (!$process.HasExited) {
            $request = "$id`:$($process.Id):cancel"
            [IO.File]::WriteAllText((Join-Path $dir 'cancel.request'), $request)
            if (!$process.WaitForExit(5000)) { Write-Warning "Probe process $($process.Id) did not exit" }
        }
    }
}
Run-Scenario $false
Run-Scenario $true
