Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:AipetRegistryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Aipet-Personal'

function Get-AipetFullPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'A path is required.' }
    return [IO.Path]::GetFullPath($Path).TrimEnd([char[]]'\/')
}

function Assert-AipetWithin([string]$Path, [string]$Root) {
    $full = Get-AipetFullPath $Path
    $base = Get-AipetFullPath $Root
    if (-not $full.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Path is outside the intended directory: $full" }
    return $full
}

function Assert-AipetPlainPath([string]$Path) {
    $full = Get-AipetFullPath $Path
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $entry = Get-Item -LiteralPath $cursor -Force
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Links and junctions are not supported: $cursor" }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    return $full
}

function Get-AipetRelativeFile([string]$Root, [string]$Relative) {
    if ($Relative -notmatch '^[A-Za-z0-9_. -]+(?:/[A-Za-z0-9_. -]+)*$' -or $Relative.Split('/') -contains '..' -or $Relative.Split('/') -contains '.') { throw "Invalid package path: $Relative" }
    return Assert-AipetWithin (Join-Path $Root $Relative.Replace('/', [IO.Path]::DirectorySeparatorChar)) $Root
}

function Get-AipetHash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Read-AipetJson([string]$Path) {
    $null = Assert-AipetPlainPath $Path
    $file = Get-Item -LiteralPath $Path -Force
    if ($file.PSIsContainer -or $file.Length -gt 1048576) { throw 'Invalid or oversized installer metadata.' }
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Write-AipetJson([string]$Path, $Value) {
    $text = $Value | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($Path, $text + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
}

function Get-AipetLocations([string]$TestRoot) {
    if ($TestRoot) {
        $root = Assert-AipetPlainPath $TestRoot
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'TestRoot must already exist.' }
        return @{ Programs=(Join-Path $root 'Programs'); StartMenu=(Join-Path $root 'StartMenu'); Desktop=(Join-Path $root 'Desktop'); Registration=(Join-Path $root 'registration.json'); TestRoot=$root }
    }
    return @{ Programs=(Join-Path $env:LOCALAPPDATA 'Programs'); StartMenu=[Environment]::GetFolderPath('Programs'); Desktop=[Environment]::GetFolderPath('DesktopDirectory'); Registration=$null; TestRoot='' }
}

function New-AipetShortcut([string]$Path, [string]$Executable, [string]$Icon) {
    $null = Assert-AipetPlainPath $Path
    if (Test-Path -LiteralPath $Path) { throw "An existing shortcut would be overwritten: $Path" }
    $null = New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($Path)) -Force
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($Path)
    $link.TargetPath = $Executable
    $link.Arguments = '--background'
    $link.WorkingDirectory = [IO.Path]::GetDirectoryName($Executable)
    $link.Description = 'Aipet desktop companion'
    $link.IconLocation = $Icon + ',0'
    $link.Save()
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) | Out-Null
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
}

function Remove-AipetShortcut([string]$Path, [string]$Executable) {
    $null = Assert-AipetPlainPath $Path
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($Path)
    $matches = [string]::Equals($link.TargetPath, $Executable, [StringComparison]::OrdinalIgnoreCase)
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) | Out-Null
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
    if ($matches) { Remove-Item -LiteralPath $Path -Force }
}

function Assert-AipetNotRunning([string]$Executable) {
    # Inspect only image paths, never process command lines or window titles.
    foreach ($process in @(Get-Process -Name electron -ErrorAction SilentlyContinue)) {
        try { $image = $process.Path } catch { continue }
        if ([string]::Equals($image, $Executable, [StringComparison]::OrdinalIgnoreCase)) { throw 'Exit this installed Aipet from its tray menu, then try again.' }
    }
}
