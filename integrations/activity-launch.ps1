param([string]$Provider, [string]$State)
# Fixed metadata-only launcher for the bundled, unmodified Electron runtime.
# It never reads the AI host's stdin, installs hooks, or changes its environment.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$child = $null
try {
    if ($args.Count -ne 0 -or @('claude','codex') -cnotcontains $Provider -or @('idle','thinking','reading','coding','tool','success','error','waiting','offline') -cnotcontains $State) { throw 'Invalid activity label.' }
    # Use .NET directly to avoid first-use PowerShell module loading inside the
    # host's three-second deadline, especially on a newly installed computer.
    $runtime = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..\..\..\electron.exe'))
    $bridge = [IO.Path]::Combine($PSScriptRoot, 'activity.mjs')
    foreach ($file in @($runtime, $bridge)) {
        $attributes = [IO.File]::GetAttributes($file)
        if (($attributes -band [IO.FileAttributes]::Directory) -or ($attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'A regular bundled file is required.' }
    }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $runtime
    $start.Arguments = '"' + $bridge + '" --provider ' + $Provider + ' --state ' + $State + ' --hook'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
    $child = [Diagnostics.Process]::new()
    $child.StartInfo = $start
    if (-not $child.Start()) { throw 'Activity subprocess did not start.' }
    # Discard output as streams, without retaining diagnostics or host content.
    $outputDrain = $child.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
    $errorDrain = $child.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
    $child.StandardInput.Close()
    # Host hooks have a three-second deadline, including PowerShell startup.
    if (-not $child.WaitForExit(1800)) {
        $child.Kill()
        $null = $child.WaitForExit(100)
    }
} catch {
    # An unavailable pet bridge must never reject a prompt or an AI operation.
} finally {
    if ($child) {
        try { if (-not $child.HasExited) { $child.Kill(); $null = $child.WaitForExit(100) } } catch {}
        $child.Dispose()
    }
}
[Console]::Out.Write("{}`n")
exit 0
