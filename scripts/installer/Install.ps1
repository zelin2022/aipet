param(
    [string]$InstallDirectory,
    [switch]$DesktopShortcut,
    [switch]$Launch,
    [string]$TestRoot
)
. (Join-Path $PSScriptRoot 'Installer.Common.ps1')

try {
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'Aipet requires 64-bit Windows.' }
    $locations = Get-AipetLocations $TestRoot
    if (-not $InstallDirectory) { $InstallDirectory = Join-Path $locations.Programs 'Aipet' }
    $target = Assert-AipetPlainPath $InstallDirectory
    if ($TestRoot) { $null = Assert-AipetWithin $target $locations.TestRoot }
    $parent = [IO.Path]::GetDirectoryName($target)
    if (-not $parent -or $target -eq [IO.Path]::GetPathRoot($target)) { throw 'Choose a dedicated application directory.' }
    if (Test-Path -LiteralPath $target) { throw 'The install directory already exists. Uninstall the previous copy or choose an unused directory.' }
    $source = Assert-AipetPlainPath (Join-Path $PSScriptRoot 'payload')
    $manifest = Read-AipetJson (Join-Path $PSScriptRoot 'installer-manifest.json')
    if ($manifest.schemaVersion -ne 1 -or $manifest.edition -ne 'no-counters' -or $manifest.version -notmatch '^\d+\.\d+\.\d+$' -or @($manifest.files).Count -lt 10 -or @($manifest.files).Count -gt 1024) { throw 'Invalid installer manifest.' }
    $expected = @{}
    foreach ($file in $manifest.files) {
        $sourceFile = Get-AipetRelativeFile $source $file.path
        $null = Assert-AipetPlainPath $sourceFile
        if ($expected.ContainsKey($file.path) -or $file.sha256 -notmatch '^[a-f0-9]{64}$' -or -not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) { throw 'Invalid or missing package file.' }
        $entry = Get-Item -LiteralPath $sourceFile
        if ($entry.Length -ne $file.bytes -or (Get-AipetHash $sourceFile) -ne $file.sha256) { throw "Package checksum mismatch: $($file.path)" }
        $expected[$file.path] = $true
    }
    # Check directory entries before recursive enumeration to reject junction traversal.
    $queue = New-Object 'Collections.Generic.Queue[string]'
    $queue.Enqueue($source)
    $actual = 0
    while ($queue.Count) {
        foreach ($entry in Get-ChildItem -LiteralPath $queue.Dequeue() -Force) {
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Package links and junctions are forbidden.' }
            if ($entry.PSIsContainer) { $queue.Enqueue($entry.FullName); continue }
            $relative = $entry.FullName.Substring($source.Length + 1).Replace('\','/')
            if (-not $expected.ContainsKey($relative)) { throw "Unexpected package file: $relative" }
            $actual++
        }
    }
    if ($actual -ne $expected.Count -or -not $expected.ContainsKey('electron.exe') -or -not $expected.ContainsKey('resources/app/package.json')) { throw 'Incomplete application payload.' }
    $startMenu = Join-Path $locations.StartMenu 'Aipet.lnk'
    $desktop = Join-Path $locations.Desktop 'Aipet.lnk'
    foreach ($shortcut in @($startMenu) + $(if ($DesktopShortcut) { @($desktop) } else { @() })) {
        $null = Assert-AipetPlainPath $shortcut
        if (Test-Path -LiteralPath $shortcut) { throw "An existing shortcut would be overwritten: $shortcut" }
    }
    if ($locations.Registration) {
        if (Test-Path -LiteralPath $locations.Registration) { throw 'An Aipet install is already registered.' }
    } elseif (Test-Path -LiteralPath $script:AipetRegistryPath) { throw 'An Aipet install is already registered. Uninstall it first.' }
    $null = New-Item -ItemType Directory -Path $parent -Force
    $null = Assert-AipetPlainPath $parent
    $staging = Join-Path $parent ('.Aipet-install-' + [guid]::NewGuid().ToString('N'))
    $null = Assert-AipetWithin $staging $parent
    $null = New-Item -ItemType Directory -Path $staging
    $appDirectory = Join-Path $staging 'app'
    $null = New-Item -ItemType Directory -Path $appDirectory
    $ownedFiles = @()
    foreach ($file in $manifest.files) {
        $destination = Get-AipetRelativeFile $appDirectory $file.path
        $null = New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force
        Copy-Item -LiteralPath (Get-AipetRelativeFile $source $file.path) -Destination $destination
        if ((Get-AipetHash $destination) -ne $file.sha256) { throw 'Copied application checksum mismatch.' }
        $ownedFiles += @{path=('app/' + $file.path); sha256=$file.sha256}
    }
    foreach ($name in @('Uninstall.cmd','Uninstall.ps1','Installer.Common.ps1')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $staging $name)
        $ownedFiles += @{path=$name; sha256=(Get-AipetHash (Join-Path $staging $name))}
    }
    $record = @{schemaVersion=1; product='Aipet-Personal'; edition='no-counters'; version=$manifest.version; installDirectory=$target; owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; testRoot=$locations.TestRoot; desktopShortcut=[bool]$DesktopShortcut; files=$ownedFiles}
    Write-AipetJson (Join-Path $staging '.aipet-install.json') $record
    $null = Assert-AipetPlainPath $staging
    $null = Assert-AipetPlainPath $target
    if (Test-Path -LiteralPath $target) { throw 'The install destination appeared while preparing files. Nothing was overwritten.' }
    Move-Item -LiteralPath $staging -Destination $target
    $staging = $null
    $executable = Join-Path $target 'app\electron.exe'
    $icon = Join-Path $target 'app\resources\app\renderer\icon.ico'
    New-AipetShortcut $startMenu $executable $icon
    if ($DesktopShortcut) { New-AipetShortcut $desktop $executable $icon }
    $uninstallCommand = '"' + (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') + '" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $target 'Uninstall.ps1') + '"'
    $registration = @{DisplayName='Aipet (personal, no counters)'; DisplayVersion=$manifest.version; Publisher='Aipet personal project'; InstallLocation=$target; DisplayIcon=$icon; UninstallString=$uninstallCommand; NoModify=1; NoRepair=1}
    if ($locations.Registration) { Write-AipetJson $locations.Registration $registration }
    else {
        $null = New-Item -Path $script:AipetRegistryPath -Force
        foreach ($name in $registration.Keys) {
            $kind = if ($registration[$name] -is [int]) { 'DWord' } else { 'String' }
            $null = New-ItemProperty -LiteralPath $script:AipetRegistryPath -Name $name -Value $registration[$name] -PropertyType $kind -Force
        }
    }
    Write-Host "Installed Aipet to $target"
    Write-Host 'Open Aipet from Start. Its tray menu can show the pet, connect your AI tools, or exit.'
    Write-Host 'No startup entry was created. No AI hooks or settings were changed.'
    if ($Launch) { Start-Process -FilePath $executable -ArgumentList '--background' -WorkingDirectory ([IO.Path]::GetDirectoryName($executable)) -WindowStyle Hidden | Out-Null }
    exit 0
} catch {
    Write-Error -ErrorAction Continue $_
    if (Get-Variable staging -ErrorAction SilentlyContinue) {
        if ($staging -and (Test-Path -LiteralPath $staging)) {
            Write-Host "Incomplete staging directory retained for inspection: $staging"
        }
    }
    if (Get-Variable target -ErrorAction SilentlyContinue) {
        if (Test-Path -LiteralPath (Join-Path $target 'Uninstall.cmd')) { Write-Host "If files were installed, run $(Join-Path $target 'Uninstall.cmd') to remove them." }
    }
    exit 1
}
