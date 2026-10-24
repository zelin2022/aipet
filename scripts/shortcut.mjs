// Preview by default. --install creates only two per-user shortcuts; --test uses a temporary folder.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('Aipet shortcuts require Windows.');
const flags = process.argv.slice(2);
if (flags.some(flag => !['--install', '--test'].includes(flag)) || new Set(flags).size !== flags.length || flags.length > 1) throw new Error('Use no argument to preview, --install to create, or --test for temporary verification.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distribution = path.join(root, 'dist', 'Aipet-win32-x64');
const target = path.join(distribution, 'electron.exe');
const icon = path.join(distribution, 'resources', 'app', 'renderer', 'icon.ico');
const vendorSha256 = '8e84549b05d27d444da2957653200d1e0ac287eff0fc5722b92835b9e0821a59';

function powershell(request) {
  // Values are inert UTF-8 JSON data inside Base64. No path is interpolated into executable code.
  const data = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
if ($request.action -eq 'programs') {
  @{ programs = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs) } | ConvertTo-Json -Compress
  exit 0
}
if ($request.action -ne 'write') { throw 'Unknown shortcut operation' }
$shell = New-Object -ComObject WScript.Shell
foreach ($item in $request.items) {
  if ([IO.File]::Exists($item.destination)) {
    $existing = $shell.CreateShortcut($item.destination)
    if (-not [string]::Equals($existing.TargetPath, $item.target, [StringComparison]::OrdinalIgnoreCase)) {
      throw ('Refusing to overwrite an existing shortcut with a different target: ' + $item.destination)
    }
  }
}
$results = @(foreach ($item in $request.items) {
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.destination)) | Out-Null
  $link = $shell.CreateShortcut($item.destination)
  $link.TargetPath = $item.target
  $link.Arguments = $item.arguments
  $link.WorkingDirectory = $item.workingDirectory
  $link.IconLocation = $item.icon + ',0'
  $link.Description = 'Aipet desktop companion'
  $link.WindowStyle = 1
  $link.Save()
  $readBack = $shell.CreateShortcut($item.destination)
  if (-not [string]::Equals($readBack.TargetPath, $item.target, [StringComparison]::OrdinalIgnoreCase) -or $readBack.Arguments -ne $item.arguments -or -not [string]::Equals($readBack.WorkingDirectory, $item.workingDirectory, [StringComparison]::OrdinalIgnoreCase) -or -not [string]::Equals($readBack.IconLocation, $item.icon + ',0', [StringComparison]::OrdinalIgnoreCase)) {
    throw ('Shortcut read-back verification failed: ' + $item.destination)
  }
  @{ destination = $item.destination; target = $readBack.TargetPath; arguments = $readBack.Arguments; workingDirectory = $readBack.WorkingDirectory; icon = $readBack.IconLocation; verified = $true }
})
ConvertTo-Json -InputObject $results -Depth 4 -Compress
`;
  const command = Buffer.from(script, 'utf16le').toString('base64');
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command], { windowsHide: true, encoding: 'utf8', shell: false, timeout: 20000, maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `Shortcut operation failed (${result.status})`);
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}

function item(destination) { return { destination, target, arguments: '--background', workingDirectory: distribution, icon }; }
async function validateBundle() {
  for (const file of [target, icon]) {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Expected a regular packaged file: ${file}`);
  }
  const hash = createHash('sha256').update(await readFile(target)).digest('hex');
  assert.equal(hash, vendorSha256, 'Shortcut target must be the pinned original Electron runtime');
}
async function validateDestinations(items) {
  for (const entry of items) {
    let metadata;
    try { metadata = await lstat(entry.destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) throw new Error(`Refusing a non-regular shortcut destination: ${entry.destination}`);
  }
}

if (flags[0] === '--test') {
  await validateBundle();
  const temporaryRoot = path.resolve(os.tmpdir());
  const testDirectory = await mkdtemp(path.join(temporaryRoot, 'aipet-shortcut-test-'));
  try {
    const destination = path.join(testDirectory, 'Aipet.lnk');
    const result = powershell({ action: 'write', items: [item(destination)] });
    assert.equal(result.length, 1);
    assert.equal(result[0].verified, true);
    assert.equal((await lstat(destination)).isFile(), true);
    console.log(JSON.stringify({ test: 'shortcut-com-readback', passed: true, result }));
  } finally {
    const relative = path.relative(temporaryRoot, testDirectory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(testDirectory).startsWith('aipet-shortcut-test-')) throw new Error('Refusing unexpected temporary shortcut cleanup path.');
    await rm(testDirectory, { recursive: true, force: true });
  }
} else {
  const { programs } = powershell({ action: 'programs' });
  if (typeof programs !== 'string' || !path.isAbsolute(programs)) throw new Error('Cannot resolve the current user Start Menu Programs folder.');
  const items = [item(path.join(root, 'dist', 'Aipet.lnk')), item(path.join(programs, 'Aipet.lnk'))];
  if (flags[0] === '--install') {
    await validateBundle();
    await validateDestinations(items);
    const result = powershell({ action: 'write', items });
    console.log(JSON.stringify({ installed: true, startupEnabled: false, shortcuts: result }, null, 2));
  } else {
    console.log(JSON.stringify({ installed: false, commandToCreate: 'node scripts/shortcut.mjs --install', startupEnabled: false, shortcuts: items }, null, 2));
  }
}
