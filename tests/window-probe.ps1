param(
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y,
  [Parameter(Mandatory=$true)][ValidatePattern('^\d{1,20}$')][string]$PetHandle,
  [Parameter(Mandatory=$true)][ValidatePattern('^\d{1,20}$')][string]$FixtureHandle
)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AipetOwnWindowProbe {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor; public Rect Work; public uint Flags; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
}
'@
  try { [void][AipetOwnWindowProbe]::SetThreadDpiAwarenessContext([IntPtr](-4)) } catch {}
  $taskPoint = New-Object AipetOwnWindowProbe+Point
  $taskPoint.X = $X
  $taskPoint.Y = $Y
  $taskHit = [AipetOwnWindowProbe]::WindowFromPoint($taskPoint)
  $taskRoot = [AipetOwnWindowProbe]::GetAncestor($taskHit, 2)
  $taskPet = New-Object IntPtr ([long]::Parse($PetHandle))
  $taskFixture = New-Object IntPtr ([long]::Parse($FixtureHandle))
  $taskForeground = [AipetOwnWindowProbe]::GetForegroundWindow()
  $taskRect = New-Object AipetOwnWindowProbe+Rect
  $taskMonitor = New-Object AipetOwnWindowProbe+MonitorInfo
  $taskMonitor.Size = [Runtime.InteropServices.Marshal]::SizeOf([type][AipetOwnWindowProbe+MonitorInfo])
  $taskGeometry = [AipetOwnWindowProbe]::GetWindowRect($taskFixture, [ref]$taskRect) -and [AipetOwnWindowProbe]::GetMonitorInfo([AipetOwnWindowProbe]::MonitorFromWindow($taskFixture, 2), [ref]$taskMonitor)
  $taskCoversMonitor = $taskGeometry -and $taskRect.Left -le $taskMonitor.Monitor.Left -and $taskRect.Top -le $taskMonitor.Monitor.Top -and $taskRect.Right -ge $taskMonitor.Monitor.Right -and $taskRect.Bottom -ge $taskMonitor.Monitor.Bottom
  # Emit only comparisons with supplied owned handles. Never serialize another
  # window's handle, title, process identity, content or geometry.
  @{
    hitPet = ($taskPet -ne [IntPtr]::Zero -and $taskRoot -eq $taskPet)
    hitFixture = ($taskRoot -eq $taskFixture)
    foregroundFixture = ($taskForeground -eq $taskFixture)
    fixtureGeometryAvailable = $taskGeometry
    fixtureCoversMonitor = $taskCoversMonitor
  } | ConvertTo-Json -Compress
} catch { [Console]::Error.WriteLine('owned-window-probe-unavailable'); exit 1 }
