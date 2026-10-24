'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
