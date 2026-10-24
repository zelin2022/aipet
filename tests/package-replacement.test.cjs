const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const helper = import('../scripts/package-replacement.mjs');

async function fixture(run) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'aipet-package-replacement-'));
  const target = path.join(root, 'Aipet-win32-x64');
  const staged = path.join(root, '.aipet-staging-fixture', 'Aipet-win32-x64');
  try {
    await fs.mkdir(target);
    await fs.mkdir(staged, { recursive: true });
    await fs.writeFile(path.join(target, 'old.txt'), 'previous complete bundle');
    await fs.writeFile(path.join(staged, 'new.txt'), 'new complete bundle');
    await run({ root, target, staged });
  } finally {
    if (path.dirname(root) !== temporaryRoot || !path.basename(root).startsWith('aipet-package-replacement-')) throw new Error('Unexpected isolated fixture cleanup path.');
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('a locked existing directory fails before removing any previous bundle content', () => fixture(async ({ root, target, staged }) => {
  const { replaceBundle } = await helper;
  const locked = { ...fs, rename: async (source, destination) => {
    if (source === target) throw Object.assign(new Error('Simulated Windows CWD lock'), { code: 'EBUSY' });
    return fs.rename(source, destination);
  } };
  await assert.rejects(replaceBundle({ outputRoot: root, stagedOutput: staged, fs: locked }), /files were not removed/);
  assert.equal(await fs.readFile(path.join(target, 'old.txt'), 'utf8'), 'previous complete bundle');
  assert.equal(await fs.readFile(path.join(staged, 'new.txt'), 'utf8'), 'new complete bundle');
}));

test('failure installing a staged bundle rolls the previous bundle back intact', () => fixture(async ({ root, target, staged }) => {
  const { replaceBundle } = await helper;
  const failedInstall = { ...fs, rename: async (source, destination) => {
    if (source === staged) throw Object.assign(new Error('Simulated install failure'), { code: 'EACCES' });
    return fs.rename(source, destination);
  } };
  await assert.rejects(replaceBundle({ outputRoot: root, stagedOutput: staged, fs: failedInstall }), /previous bundle was restored/);
  assert.equal(await fs.readFile(path.join(target, 'old.txt'), 'utf8'), 'previous complete bundle');
  assert.equal(await fs.readFile(path.join(staged, 'new.txt'), 'utf8'), 'new complete bundle');
}));

test('successful replacement installs complete new contents and removes only the old backup', () => fixture(async ({ root, target, staged }) => {
  const { replaceBundle } = await helper;
  const result = await replaceBundle({ outputRoot: root, stagedOutput: staged });
  assert.equal(result.installed, true);
  assert.equal(result.retainedBackup, null);
  assert.equal(await fs.readFile(path.join(target, 'new.txt'), 'utf8'), 'new complete bundle');
  await assert.rejects(fs.stat(path.join(target, 'old.txt')), { code: 'ENOENT' });
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('.aipet-backup-')), false);
}));
