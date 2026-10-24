const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const windows = process.platform === 'win32';
const root = path.resolve(__dirname, '..');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aipet-installer-test-'));
  t.after(async () => {
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('aipet-installer-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const source = path.join(temporary, 'source');
  await fs.mkdir(path.join(source, 'resources', 'app', 'renderer'), { recursive: true });
  for (const [name, text] of [
    ['electron.exe', 'test executable - never launched'],
    ['resources/app/package.json', '{"name":"aipet","version":"0.1.0"}'],
    ['resources/app/renderer/icon.ico', 'test icon'],
    ...Array.from({ length: 8 }, (_, index) => [`resources/app/asset-${index}.txt`, `asset ${index}`]),
  ]) await fs.writeFile(path.join(source, name), text);
  const archive = path.join(temporary, 'archive');
  const { assembleInstaller } = await import(pathToFileURL(path.join(root, 'scripts', 'installer', 'assemble.mjs')));
  await assembleInstaller({ payloadDirectory: source, outputDirectory: archive, version: '0.1.0' });
  const testRoot = path.join(temporary, 'isolated-user');
  await fs.mkdir(testRoot);
  const installDirectory = path.join(testRoot, 'Programs', 'Aipet');
  const run = (script, args = []) => spawnSync(powershell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-TestRoot', testRoot, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return { temporary, archive, testRoot, installDirectory, run };
}

test('offline installer installs and uninstalls only its own isolated files', { skip: !windows, timeout: 120000 }, async t => {
  const { archive, testRoot, installDirectory, run } = await fixture(t);
  const userData = path.join(testRoot, '.aipet');
  await fs.mkdir(userData);
  await fs.writeFile(path.join(userData, 'settings.json'), 'keep preferences');
  const installed = run(path.join(archive, 'Install.ps1'), ['-DesktopShortcut']);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.equal(await fs.readFile(path.join(installDirectory, 'app', 'electron.exe'), 'utf8'), 'test executable - never launched');
  assert.ok((await fs.stat(path.join(testRoot, 'StartMenu', 'Aipet.lnk'))).size > 0);
  assert.ok((await fs.stat(path.join(testRoot, 'Desktop', 'Aipet.lnk'))).size > 0);
  const registration = JSON.parse(await fs.readFile(path.join(testRoot, 'registration.json'), 'utf8'));
  assert.equal(registration.InstallLocation, installDirectory);
  assert.equal(registration.DisplayName, 'Aipet (personal, no counters)');
  assert.equal(registration.NoModify, 1);
  assert.ok(registration.UninstallString.includes(path.join(installDirectory, 'Uninstall.ps1')));
  const duplicate = run(path.join(archive, 'Install.ps1'));
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stdout + duplicate.stderr, /already\s+exists/);
  const changed = path.join(installDirectory, 'app', 'resources', 'app', 'asset-0.txt');
  const added = path.join(installDirectory, 'personal-note.txt');
  await fs.writeFile(changed, 'user edited this file');
  await fs.writeFile(added, 'user added this file');
  const removed = run(path.join(installDirectory, 'Uninstall.ps1'));
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  await assert.rejects(fs.stat(path.join(installDirectory, 'app', 'electron.exe')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(testRoot, 'StartMenu', 'Aipet.lnk')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(testRoot, 'Desktop', 'Aipet.lnk')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(testRoot, 'registration.json')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(changed, 'utf8'), 'user edited this file');
  assert.equal(await fs.readFile(added, 'utf8'), 'user added this file');
  assert.equal(await fs.readFile(path.join(userData, 'settings.json'), 'utf8'), 'keep preferences');
});

test('offline clean uninstall removes its installation directory without touching adjacent files', { skip: !windows, timeout: 120000 }, async t => {
  const { archive, testRoot, installDirectory, run } = await fixture(t);
  const adjacent = path.join(testRoot, 'Programs', 'other-application.txt');
  const installed = run(path.join(archive, 'Install.ps1'));
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  await fs.writeFile(adjacent, 'not Aipet');
  await assert.rejects(fs.stat(path.join(testRoot, 'Desktop', 'Aipet.lnk')), { code: 'ENOENT' });
  const removed = run(path.join(installDirectory, 'Uninstall.ps1'));
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  await assert.rejects(fs.stat(installDirectory), { code: 'ENOENT' });
  assert.equal(await fs.readFile(adjacent, 'utf8'), 'not Aipet');
});

test('offline uninstaller rejects tampered paths before deleting any installed files', { skip: !windows, timeout: 120000 }, async t => {
  const { archive, testRoot, installDirectory, run } = await fixture(t);
  const installed = run(path.join(archive, 'Install.ps1'));
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const recordPath = path.join(installDirectory, '.aipet-install.json');
  const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  record.files[0].path = 'app/../../outside.txt';
  await fs.writeFile(recordPath, JSON.stringify(record));
  const removed = run(path.join(installDirectory, 'Uninstall.ps1'));
  assert.equal(removed.status, 1);
  assert.match(removed.stdout + removed.stderr, /Invalid\s+package path/);
  assert.ok(await fs.stat(path.join(installDirectory, 'app', 'electron.exe')));
  assert.ok(await fs.stat(path.join(testRoot, 'registration.json')));
});

test('offline installer rejects corrupt or additional payload files before installing', { skip: !windows, timeout: 120000 }, async t => {
  const { archive, testRoot, installDirectory, run } = await fixture(t);
  const executable = path.join(archive, 'payload', 'electron.exe');
  const original = await fs.readFile(executable);
  await fs.writeFile(executable, 'corrupt');
  const corrupt = run(path.join(archive, 'Install.ps1'));
  assert.equal(corrupt.status, 1);
  assert.match(corrupt.stdout + corrupt.stderr, /checksum mismatch/);
  await assert.rejects(fs.stat(installDirectory), { code: 'ENOENT' });
  await fs.writeFile(executable, original);
  await fs.writeFile(path.join(archive, 'payload', 'unexpected.txt'), 'unexpected');
  const extra = run(path.join(archive, 'Install.ps1'));
  assert.equal(extra.status, 1);
  assert.match(extra.stdout + extra.stderr, /Unexpected package file/);
  await assert.rejects(fs.stat(path.join(testRoot, 'registration.json')), { code: 'ENOENT' });
});

test('offline installer rejects traversal paths and test destinations outside its isolation root', { skip: !windows, timeout: 120000 }, async t => {
  const { temporary, archive, testRoot, installDirectory, run } = await fixture(t);
  const outside = path.join(temporary, 'outside');
  const escaped = run(path.join(archive, 'Install.ps1'), ['-InstallDirectory', outside]);
  assert.equal(escaped.status, 1);
  assert.match(escaped.stdout + escaped.stderr, /outside the intended\s+directory/);
  await assert.rejects(fs.stat(outside), { code: 'ENOENT' });
  const manifestPath = path.join(archive, 'installer-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.files[0].path = '../outside.txt';
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const traversal = run(path.join(archive, 'Install.ps1'));
  assert.equal(traversal.status, 1);
  assert.match(traversal.stdout + traversal.stderr, /Invalid package path/);
  await assert.rejects(fs.stat(installDirectory), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(testRoot, 'registration.json')), { code: 'ENOENT' });
});
