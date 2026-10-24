'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inflateRawSync } = require('node:zlib');
const script = path.resolve(__dirname, '../scripts/create-release-archive.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const run = (source, archive) => spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-SourceDirectory', source, '-ArchivePath', archive], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-archive-test-'));
  t.after(() => {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('aipet-archive-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const source = path.join(directory, 'source'); fs.mkdirSync(source);
  fs.mkdirSync(path.join(source, 'nested folder'));
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(source, 'nested folder', `file-${i}.txt`), `Preserve exact bytes ${i}: \u00e9\r\n`.repeat(i + 1));
  return { source, archive: path.join(directory, 'release.zip'), directory };
}
test('Windows release ZIP uses portable entry names and preserves every byte', { skip: process.platform !== 'win32' }, t => {
  const { source, archive } = fixture(t);
  const result = run(source, archive);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const zip = fs.readFileSync(archive), names = [];
  let cursor = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(cursor >= 0);
  while (zip.readUInt32LE(cursor) === 0x02014b50) {
    const nameLength = zip.readUInt16LE(cursor + 28), name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    assert.doesNotMatch(name, /\\/);
    const local = zip.readUInt32LE(cursor + 42), size = zip.readUInt32LE(cursor + 20), method = zip.readUInt16LE(cursor + 10);
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const payload = zip.subarray(start, start + size);
    assert.ok(method === 0 || method === 8);
    assert.deepEqual(method === 8 ? inflateRawSync(payload) : payload, fs.readFileSync(path.join(source, name)));
    names.push(name);
    cursor += 46 + nameLength + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
  }
  assert.equal(names.length, 10);
  assert.equal(new Set(names).size, 10);
  assert.notEqual(run(source, archive).status, 0, 'An existing archive cannot be overwritten.');
});
test('release archive rejects directory junctions before walking their targets', { skip: process.platform !== 'win32' }, t => {
  const { source, archive, directory } = fixture(t);
  const outside = path.join(directory, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'preserve');
  fs.symlinkSync(outside, path.join(source, 'redirect'), 'junction');
  const result = run(source, archive);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /cannot contain links/);
  assert.equal(fs.existsSync(archive), false);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'preserve');
});
