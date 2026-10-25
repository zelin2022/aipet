param(
    [string]$AppDirectory,
    [string]$ProfileDirectory,
    [string]$CodexDirectory,
    [switch]$Probe
)
# Read-only by default. -Probe explicitly writes one content-free thinking
# event using this installation's bridge; no command from hooks.json is run.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Property($Value, [string]$Name) {
    if ($null -eq $Value) { return $null }
    $entry = $Value.PSObject.Properties[$Name]
    if ($entry) { return $entry.Value }
    return $null
}
function FullPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z]:[\\/]' -or $Value -match '[\x00-\x1f\x7f]') { throw 'An absolute local drive path is required.' }
    $full = [IO.Path]::GetFullPath($Value)
    if ($full -eq [IO.Path]::GetPathRoot($full)) { return $full }
    return $full.TrimEnd([char[]]'\/')
}
function PlainPath([string]$Value) {
    $cursor = FullPath $Value
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $entry = Get-Item -LiteralPath $cursor -Force
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked diagnostic input is not supported.' }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}
function ReadJson([string]$Filename, [int]$Maximum) {
    PlainPath $Filename
    $entry = Get-Item -LiteralPath $Filename -Force
    if ($entry.PSIsContainer -or $entry.Length -lt 1 -or $entry.Length -gt $Maximum) { throw 'Invalid diagnostic input size.' }
    $stream = [IO.File]::Open($Filename, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $bytes = New-Object byte[] ($Maximum + 1)
        $length = 0
        while ($length -lt $bytes.Length) {
            $count = $stream.Read($bytes, $length, $bytes.Length - $length)
            if (-not $count) { break }
            $length += $count
        }
        if ($length -ne $entry.Length -or $length -gt $Maximum) { throw 'Diagnostic input changed or exceeded its limit.' }
        return [Text.Encoding]::UTF8.GetString($bytes, 0, $length).TrimStart([char]0xfeff) | ConvertFrom-Json
    } finally { $stream.Dispose() }
}
function Normal([string]$Value) { return (FullPath $Value).Replace('\','/').TrimEnd('/').ToLowerInvariant() }
function ExistsFile([string]$Value) {
    try { return [IO.Path]::IsPathRooted($Value) -and (Test-Path -LiteralPath $Value -PathType Leaf) } catch { return $false }
}
function ParseBridge([string]$Script) {
    if ($Script -match "^& '(?<runtime>[^'\r\n]{1,512})' '(?<bridge>[^'\r\n]{1,1024}[\\/]integrations[\\/]activity[.]mjs)' --provider codex --state (?<state>idle|thinking|reading|coding|tool|success|error|waiting|offline) --hook$") {
        if ([IO.Path]::GetFileName($Matches.runtime) -ine 'node.exe') { return $null }
        try { $runtime = FullPath $Matches.runtime; $bridge = FullPath $Matches.bridge } catch { return $null }
        return @{ Runtime=$runtime; Bridge=$bridge; State=$Matches.state; Kind='external-node'; Launcher=$null }
    }
    if ($Script -match "^& '(?<launcher>[^'\r\n]{1,1024}[\\/]integrations[\\/]activity-launch[.]ps1)' -Provider codex -State (?<state>idle|thinking|reading|coding|tool|success|error|waiting|offline)$") {
        $state = $Matches.state
        try {
            $launcher = FullPath $Matches.launcher
            $integration = [IO.Path]::GetDirectoryName($launcher)
            $applicationRoot = [IO.Path]::GetDirectoryName($integration)
            $runtime = FullPath (Join-Path $applicationRoot '..\..\electron.exe')
            $bridge = FullPath (Join-Path $integration 'activity.mjs')
        } catch { return $null }
        return @{ Runtime=$runtime; Bridge=$bridge; State=$state; Kind='bundled-electron'; Launcher=$launcher }
    }
    return $null
}
function ParseCommand([string]$Command, [bool]$Encoded) {
    if (-not $Command -or $Command.Length -gt 12288) { return $null }
    $prefix = '^(?<quote>"?)(?<shell>[A-Za-z]:[\\/][^"\r\n]{1,512}powershell[.]exe)\k<quote> -NoLogo -NoProfile -NonInteractive (?:-ExecutionPolicy Bypass )?'
    if ($Encoded) {
        if ($Command -notmatch ($prefix + '-EncodedCommand (?<code>[A-Za-z0-9+/=]{4,8192})$')) { return $null }
        try {
            $shell = $Matches.shell
            $bytes = [Convert]::FromBase64String($Matches.code)
            if ($bytes.Length -gt 6144 -or $bytes.Length % 2) { return $null }
            $decoder = New-Object Text.UnicodeEncoding($false, $false, $true)
            $script = $decoder.GetString($bytes)
        } catch { return $null }
    } else {
        if ($Command -notmatch ($prefix + '-Command "(?<script>[^"\r\n]{1,3072})"$')) { return $null }
        $shell = $Matches.shell
        $script = $Matches.script
    }
    $parsed = ParseBridge $script
    if ($parsed) { $parsed.Shell = $shell }
    return $parsed
}
function LatestEvent([string]$Directory) {
    $result = @{ directoryExists=$false; inspected=0; latest=$null }
    try {
        PlainPath $Directory
        if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return $result }
        $result.directoryExists = $true
        $files = @(Get-ChildItem -LiteralPath $Directory -File -Force | Where-Object { $_.Name -match '^codex-[a-f0-9]{32}[.]json$' } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 32)
        foreach ($file in $files) {
            $result.inspected++
            try {
                $value = ReadJson $file.FullName 1024
                if ((@($value.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'at,provider,session,state,version') { continue }
                if ($value.version -ne 1 -or $value.provider -ne 'codex' -or $value.session -notmatch '^[a-f0-9]{32}$' -or $value.state -notmatch '^(idle|thinking|reading|coding|tool|success|error|waiting|offline)$') { continue }
                $at = [DateTimeOffset]::ParseExact($value.at, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
                if (-not $result.latest -or $value.at -gt $result.latest.at) { $result.latest = @{ state=$value.state; at=$value.at } }
            } catch { continue }
        }
    } catch { $result.unavailable = $true }
    return $result
}

try {
    if (-not $ProfileDirectory) { $ProfileDirectory = $env:USERPROFILE }
    $aipetProfile = FullPath $ProfileDirectory
    if (-not $AppDirectory) { $AppDirectory = Join-Path $env:LOCALAPPDATA 'Programs\Aipet\app\resources\app' }
    $application = FullPath $AppDirectory
    $configSource = 'profile-default'
    if ($CodexDirectory) { $configSource = 'explicit-directory' }
    elseif ($env:CODEX_HOME) { $CodexDirectory = $env:CODEX_HOME; $configSource = 'CODEX_HOME' }
    else { $CodexDirectory = Join-Path $aipetProfile '.codex' }
    $codex = FullPath $CodexDirectory
    $bridge = Join-Path $application 'integrations\activity.mjs'
    $bundledHelper = Join-Path $application 'integrations\activity-launch.ps1'
    $bundledRuntime = FullPath (Join-Path $application '..\..\electron.exe')
    $events = Join-Path $aipetProfile '.aipet\events'
    $standardNode = 'C:\Program Files\nodejs\node.exe'
    $detectedNode = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $node = if (ExistsFile $standardNode) { $standardNode } elseif ($detectedNode) { $detectedNode.Source } else { $null }
    $report = [ordered]@{
        diagnosticVersion=1; readOnly=(-not [bool]$Probe); configSource=$configSource
        installedBridgeExists=(ExistsFile $bridge); standardNodeExists=(ExistsFile $standardNode); nodeOnPath=[bool]$detectedNode
        bundledLauncherExists=(ExistsFile $bundledHelper); bundledRuntimeExists=(ExistsFile $bundledRuntime)
        hooksStatus='missing'; recognizedHookCount=0; unsupportedAipetCandidates=0; hooks=@(); events=(LatestEvent $events)
        probe=@{requested=[bool]$Probe; status='not-requested'}
    }
    $hookFile = Join-Path $codex 'hooks.json'
    if (Test-Path -LiteralPath $hookFile) {
        try {
            $config = ReadJson $hookFile 262144
            $hooks = Property $config 'hooks'
            if (-not $hooks -or $hooks -is [array] -or $hooks -is [string]) { throw 'Invalid hooks object.' }
            $count = 0
            foreach ($event in $hooks.PSObject.Properties) {
                foreach ($group in @($event.Value)) {
                    foreach ($handler in @(Property $group 'hooks')) {
                        if (++$count -gt 512) { throw 'Too many hook handlers.' }
                        if ((Property $handler 'type') -ne 'command') { continue }
                        $readable = ParseCommand (Property $handler 'command') $false
                        $windows = ParseCommand (Property $handler 'commandWindows') $true
                        $hasWindows = (Property $handler 'commandWindows') -is [string] -and (Property $handler 'commandWindows').Length -gt 0
                        $effective = if ($hasWindows) { $windows } else { $readable }
                        if (-not $readable -and -not $windows) {
                            $candidate = [string](Property $handler 'command') + ' ' + [string](Property $handler 'commandWindows')
                            if ($candidate -match 'integrations[\\/]activity[.]mjs' -and $candidate -match '--provider codex') { $report.unsupportedAipetCandidates++ }
                            continue
                        }
                        $report.recognizedHookCount++
                        $pathMatches = $false; $runtimeExists = $false; $bridgeExists = $false; $stale = $false; $placeholder = $false; $runtimeKind='unsupported'; $launcherExists=$null; $shellExists=$false
                        if ($effective) {
                            $effectiveBridge = Normal $effective.Bridge
                            $pathMatches = $effectiveBridge -eq (Normal $bridge)
                            $runtimeExists = ExistsFile $effective.Runtime
                            $shellExists = ExistsFile $effective.Shell
                            $bridgeExists = ExistsFile $effective.Bridge
                            $runtimeKind = $effective.Kind
                            if ($effective.Launcher) { $launcherExists = ExistsFile $effective.Launcher }
                            $stale = $effectiveBridge -eq 'g:/workspace/aipet/integrations/activity.mjs'
                            $placeholder = $effectiveBridge -eq 'c:/aipet/resources/app/integrations/activity.mjs'
                        }
                        $agree = if ($readable -and $windows) { (Normal $readable.Bridge) -eq (Normal $windows.Bridge) -and (Normal $readable.Runtime) -eq (Normal $windows.Runtime) -and $readable.State -eq $windows.State -and $readable.Kind -eq $windows.Kind } else { $null }
                        $eventName = if ($event.Name -match '^(SessionStart|SessionEnd|UserPromptSubmit|PreToolUse|PostToolUse|PermissionRequest|Stop|Interrupt)$') { $event.Name } else { 'other' }
                        $report.hooks += @{event=$eventName; usesWindowsOverride=$hasWindows; supportedEffectiveCommand=[bool]$effective; matchesInstalledBridge=$pathMatches; runtimeKind=$runtimeKind; referencedShellExists=$shellExists; referencedRuntimeExists=$runtimeExists; referencedBridgeExists=$bridgeExists; referencedLauncherExists=$launcherExists; readableMatchesWindows=$agree; staleDevelopmentPath=$stale; templatePlaceholderPath=$placeholder}
                    }
                }
            }
            $report.hooksStatus = 'read'
        } catch { $report.hooksStatus='invalid-or-unreadable'; $report.hooks=@(); $report.recognizedHookCount=0 }
    }
    if ($Probe) {
        $report.probe.status = 'prerequisite-missing'
        $useBundled = $report.bundledLauncherExists
        $probeRuntime = if ($useBundled) { if ($report.bundledRuntimeExists) { $bundledRuntime } else { $null } } else { $node }
        $report.probe.runtimeKind = if ($useBundled) { 'bundled-electron' } else { 'external-node' }
        if ($probeRuntime -and $report.installedBridgeExists) {
            PlainPath $bridge
            $package = ReadJson (Join-Path $application 'package.json') 16384
            if ((Property $package 'name') -ne 'aipet') { throw 'The selected application is not Aipet.' }
            $info = New-Object Diagnostics.ProcessStartInfo
            $info.FileName = $probeRuntime
            $info.Arguments = '"' + $bridge + '" --provider codex --state thinking'
            $info.UseShellExecute = $false; $info.CreateNoWindow = $true
            $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
            $info.EnvironmentVariables['USERPROFILE'] = $aipetProfile
            if ($useBundled) { $info.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1' }
            $process = New-Object Diagnostics.Process
            $process.StartInfo = $info
            $null = $process.Start()
            $discardOutput = $process.StandardOutput.ReadToEndAsync(); $discardError = $process.StandardError.ReadToEndAsync()
            try {
                if (-not $process.WaitForExit(5000)) { $process.Kill(); $report.probe.status='timed-out' }
                elseif ($process.ExitCode -ne 0) { $report.probe.status='bridge-failed' }
                else {
                    $after = LatestEvent $events
                    $report.probe.status = if ($after.latest -and $after.latest.state -eq 'thinking' -and (-not $report.events.latest -or $after.latest.at -gt $report.events.latest.at)) { 'event-written' } else { 'no-new-event' }
                    $report.events = $after
                }
            } finally { $process.Dispose() }
        }
    }
    $report | ConvertTo-Json -Depth 8
    exit 0
} catch {
    @{diagnosticVersion=1; status='diagnostic-unavailable'; detail='Check the selected local paths and file permissions. No configuration was changed.'} | ConvertTo-Json
    exit 1
}
