'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Script } = require('node:vm');
const root = path.resolve(__dirname, '..');

test('release transform physically removes counters while preserving the development edition', async () => {
  const { releaseSource, RELEASE_EXCLUDED } = await import('../scripts/release-variant.mjs');
  assert.equal(RELEASE_EXCLUDED.size, 4);
  for (const relative of ['src/main.cjs', 'src/preload.cjs', 'renderer/pet.js', 'renderer/studio.js', 'renderer/studio.html']) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(source, /sprite.?usage|reportUsage/i);
    const release = releaseSource(relative, source);
    assert.doesNotMatch(release, /sprite.?usage|reportUsage|usageSaveTimer/i);
    assert.equal(fs.readFileSync(path.join(root, relative), 'utf8'), source);
  }
  assert.throws(() => releaseSource('src/main.cjs', 'console.log("source changed");'), /review/i);
  const changedInterior = fs.readFileSync(path.join(root, 'src/main.cjs'), 'utf8').replace('const usageAssets = new Map', 'const unrelatedFutureFeature = true;\nconst usageAssets = new Map');
  assert.throws(() => releaseSource('src/main.cjs', changedInterior), /omitted source changed/);
});

test('release hook templates relocate together and preserve fixed bridge invocations', async () => {
  const { releaseSource, RELEASE_HOOK_ROOT } = await import('../scripts/release-variant.mjs');
  for (const relative of ['src/core/hook-commands.cjs', 'integrations/claude-hooks.example.json', 'integrations/codex-hooks.example.json']) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    const release = releaseSource(relative, source);
    assert.doesNotMatch(release, /G:\/workspace\/aipet/);
    assert.ok(release.includes(RELEASE_HOOK_ROOT));
    if (relative.endsWith('.json')) assert.ok(JSON.parse(release).hooks);
  }
});

test('raw release Codex examples and relocated setup agree in all encoded Windows commands', async () => {
  const { releaseSource, RELEASE_HOOK_ROOT } = await import('../scripts/release-variant.mjs');
  const relative = 'integrations/codex-hooks.example.json';
  const raw = releaseSource(relative, fs.readFileSync(path.join(root, relative), 'utf8'));
  const handlers = example => Object.values(example.hooks).flatMap(groups => groups.flatMap(group => group.hooks));
  function verify(example, expectedRoot) {
    const all = handlers(example);
    assert.equal(all.length, 10);
    for (const handler of all) {
      const encoded = handler.commandWindows.split(' -EncodedCommand ');
      assert.equal(encoded.length, 2);
      const decoded = Buffer.from(encoded[1], 'base64').toString('utf16le');
      const readable = handler.command.split(' -Command "')[1].slice(0, -1);
      assert.equal(decoded, readable);
      assert.ok(decoded.includes(`'${expectedRoot}/integrations/activity.mjs'`));
      assert.doesNotMatch(decoded, /G:\/workspace\/aipet/);
    }
  }
  verify(JSON.parse(raw), RELEASE_HOOK_ROOT);

  // Exercise the actual staged helper rather than the source helper: its
  // template sentinel has changed with the release's JSON example.
  const helper = releaseSource('src/core/hook-commands.cjs', fs.readFileSync(path.join(root, 'src/core/hook-commands.cjs'), 'utf8'));
  const sandbox = { module: { exports: {} }, require, Buffer };
  new Script(helper).runInNewContext(sandbox);
  const installedRoot = 'D:/Users/Another User/Local Apps/Aipet/app/resources/app';
  const displayed = sandbox.module.exports.prepareHookExample('codex', raw, installedRoot);
  verify(displayed, installedRoot);
  assert.ok(handlers(displayed).every(handler => !Buffer.from(handler.commandWindows.split(' -EncodedCommand ')[1], 'base64').toString('utf16le').includes(RELEASE_HOOK_ROOT)));
});
