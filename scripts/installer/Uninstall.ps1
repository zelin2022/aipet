param([string]$TestRoot)
. (Join-Path $PSScriptRoot 'Installer.Common.ps1')

try {
    $target = Assert-AipetPlainPath $PSScriptRoot
    $recordPath = Join-Path $target '.aipet-install.json'
    $record = Read-AipetJson $recordPath
    $locations = Get-AipetLocations $TestRoot
    if ($record.schemaVersion -ne 1 -or $record.product -ne 'Aipet-Personal' -or $record.installDirectory -ne $target -or $record.owner -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or $record.testRoot -ne $locations.TestRoot -or @($record.files).Count -gt 1027) { throw 'Installation ownership metadata is invalid. No files were removed.' }
    if ($TestRoot) { $null = Assert-AipetWithin $target $locations.TestRoot }
    $executable = Join-Path $target 'app\electron.exe'
    Assert-AipetNotRunning $executable
    $files = @()
    foreach ($file in $record.files) {
        if ($file.path -notmatch '^(?:app/|Uninstall\.cmd$|Uninstall\.ps1$|Installer\.Common\.ps1$)' -or $file.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid installed file record.' }
        $full = Get-AipetRelativeFile $target $file.path
        $null = Assert-AipetPlainPath $full
        $files += @{Path=$full; Hash=$file.sha256}
    }
    $startMenu = Join-Path $locations.StartMenu 'Aipet.lnk'
    $desktop = Join-Path $locations.Desktop 'Aipet.lnk'
    Remove-AipetShortcut $startMenu $executable
    if ($record.desktopShortcut) { Remove-AipetShortcut $desktop $executable }
    if ($locations.Registration) {
        if (Test-Path -LiteralPath $locations.Registration) {
            $registration = Read-AipetJson $locations.Registration
            if ($registration.InstallLocation -eq $target) { Remove-Item -LiteralPath $locations.Registration }
        }
    } elseif (Test-Path -LiteralPath $script:AipetRegistryPath) {
        $registration = Get-ItemProperty -LiteralPath $script:AipetRegistryPath
        if ($registration.InstallLocation -eq $target) { Remove-Item -LiteralPath $script:AipetRegistryPath -Recurse }
    }
    $retained = @()
    foreach ($file in $files) {
        if (Test-Path -LiteralPath $file.Path -PathType Leaf) {
            if ((Get-AipetHash $file.Path) -eq $file.Hash) { Remove-Item -LiteralPath $file.Path -Force }
            else { $retained += $file.Path }
        }
    }
    Remove-Item -LiteralPath $recordPath -Force
    # Delete empty directories only; added or modified files are always retained.
    $directories = New-Object 'Collections.Generic.HashSet[string]'
    foreach ($file in $files) {
        $directory = [IO.Path]::GetDirectoryName($file.Path)
        while ($directory -and $directory.StartsWith($target, [StringComparison]::OrdinalIgnoreCase)) {
            $null = $directories.Add($directory)
            if ($directory -eq $target) { break }
            $directory = [IO.Path]::GetDirectoryName($directory)
        }
    }
    foreach ($directory in @($directories) | Sort-Object Length -Descending) {
        if ((Test-Path -LiteralPath $directory -PathType Container) -and @(Get-ChildItem -LiteralPath $directory -Force).Count -eq 0) { Remove-Item -LiteralPath $directory }
    }
    Write-Host 'Aipet uninstalled. Your .aipet data and AI application settings were preserved.'
    if ($retained.Count) { Write-Host 'Modified application files were retained:'; $retained | ForEach-Object { Write-Host $_ } }
    exit 0
} catch { Write-Error -ErrorAction Continue $_; exit 1 }
