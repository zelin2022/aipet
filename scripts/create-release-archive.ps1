param([Parameter(Mandatory=$true)][string]$SourceDirectory, [Parameter(Mandatory=$true)][string]$ArchivePath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
function Get-ReleaseHash([string]$FilePath) {
    $stream = [IO.File]::OpenRead($FilePath)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','') }
    finally { $stream.Dispose(); $hash.Dispose() }
}
$source = [IO.Path]::GetFullPath($SourceDirectory).TrimEnd([char[]]'\/')
$archive = [IO.Path]::GetFullPath($ArchivePath)
if (-not (Test-Path -LiteralPath $source -PathType Container) -or (Test-Path -LiteralPath $archive)) { throw 'Expected a source directory and a new archive path.' }
if ($archive.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'The archive cannot be inside its source.' }
$expected = @{}
$queue = New-Object 'Collections.Generic.Queue[string]'
$queue.Enqueue($source)
while ($queue.Count) {
    foreach ($file in Get-ChildItem -LiteralPath $queue.Dequeue() -Force) {
        if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Release archive cannot contain links.' }
        if ($file.PSIsContainer) { $queue.Enqueue($file.FullName); continue }
        $relative = $file.FullName.Substring($source.Length + 1).Replace('\','/')
        $expected[$relative] = @{Length=$file.Length; Hash=(Get-ReleaseHash $file.FullName); Path=$file.FullName}
    }
}
if ($expected.Count -lt 10 -or $expected.Count -gt 1024) { throw 'Unexpected release file inventory.' }
# Explicit entry names avoid the backslash ZIP names emitted by some Windows
# .NET Framework builds. Each archive path uses the portable '/' separator.
$zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($relative in $expected.Keys | Sort-Object) {
        $entry = $zip.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
        $inputStream = [IO.File]::OpenRead($expected[$relative].Path)
        $outputStream = $entry.Open()
        try { $inputStream.CopyTo($outputStream) }
        finally { $inputStream.Dispose(); $outputStream.Dispose() }
    }
} finally { $zip.Dispose() }
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    $seen = @{}
    foreach ($entry in $zip.Entries) {
        if ($entry.FullName.EndsWith('/')) { continue }
        if ($seen.ContainsKey($entry.FullName) -or -not $expected.ContainsKey($entry.FullName)) { throw 'Archive inventory mismatch.' }
        $pin = $expected[$entry.FullName]
        if ($entry.Length -ne $pin.Length) { throw 'Archive size mismatch.' }
        $stream = $entry.Open()
        $hash = [Security.Cryptography.SHA256]::Create()
        try { $actual = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','') }
        finally { $stream.Dispose(); $hash.Dispose() }
        if ($actual -ne $pin.Hash) { throw 'Archive content mismatch.' }
        $seen[$entry.FullName] = $true
    }
    if ($seen.Count -ne $expected.Count) { throw 'Archive is missing release files.' }
} finally { $zip.Dispose() }
Write-Output "Verified all $($expected.Count) archived files against their staged SHA-256 hashes."
