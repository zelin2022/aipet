$ErrorActionPreference = 'Stop'
# Only allowlisted process names and window geometry. No titles, arguments or text.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AipetForeground {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor; public Rect Work; public uint Flags; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
try { [void][AipetForeground]::SetThreadDpiAwarenessContext([IntPtr](-4)) } catch {}
$lastState = ''
while ($true) {
  $foreground = 'unknown'
  $running = @()
  $fullscreen = $null
  foreach ($candidate in @('codex', 'claude')) {
    $candidateProcesses = [System.Diagnostics.Process]::GetProcessesByName($candidate)
    try { if ($candidateProcesses.Length -gt 0) { $running += $candidate } }
    finally { foreach ($matchedProcess in $candidateProcesses) { $matchedProcess.Dispose() } }
  }
  try {
    $window = [AipetForeground]::GetForegroundWindow()
    [uint32]$foregroundId = 0
    [void][AipetForeground]::GetWindowThreadProcessId($window, [ref]$foregroundId)
    $foregroundProcess = [System.Diagnostics.Process]::GetProcessById($foregroundId)
    try {
      $processName = $foregroundProcess.ProcessName.ToLowerInvariant()
      if ($processName -eq 'codex' -or $processName -eq 'claude') { $foreground = $processName }
      if ($processName -ne 'explorer') {
        $rect = New-Object AipetForeground+Rect
        $monitor = New-Object AipetForeground+MonitorInfo
        $monitor.Size = [Runtime.InteropServices.Marshal]::SizeOf($monitor)
        $monitorHandle = [AipetForeground]::MonitorFromWindow($window, 2)
        if ([AipetForeground]::GetWindowRect($window, [ref]$rect) -and [AipetForeground]::GetMonitorInfo($monitorHandle, [ref]$monitor)) {
          $bounds = $monitor.Monitor
          if ($rect.Left -le $bounds.Left -and $rect.Top -le $bounds.Top -and $rect.Right -ge $bounds.Right -and $rect.Bottom -ge $bounds.Bottom) {
            $fullscreen = @{x=$bounds.Left;y=$bounds.Top;width=($bounds.Right-$bounds.Left);height=($bounds.Bottom-$bounds.Top)}
          }
        }
      }
    } finally { $foregroundProcess.Dispose() }
  } catch { $foreground = 'unknown' }
  $state = @{foreground=$foreground;running=@($running);fullscreen=$fullscreen} | ConvertTo-Json -Compress -Depth 3
  if ($state -ne $lastState) {
    [Console]::Out.WriteLine($state)
    [Console]::Out.Flush()
    $lastState = $state
  }
  Start-Sleep -Milliseconds 1200
}
