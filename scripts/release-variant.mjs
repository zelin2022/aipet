import { Script } from 'node:vm';
import { createHash } from 'node:crypto';
import hookCommands from '../src/core/hook-commands.cjs';

// Pins cover the complete removed interiors, so unrelated future code cannot
// silently disappear merely because the boundary lines still match.
const omittedPins = new Map([
  ['const usageCatalog = createSpriteCatalog({', '5335569b45b877a966e58b6c662b8a3b98d06cea56055200147d581cb9aec0fb'],
  ['  handle("aipet:sprite-usage",', 'a7fc6adfd7a59fd0fa82cfaf1d0b6e1fe48e268b6c75b4dabf052685a66b143a'],
  ['  await spriteUsage.load();', 'd67da1bbce7e8c3d3738d89e5438b1b292058728b89b1cf3b258d939d0d74c12'],
  ['  spriteUsage.pause();\n  // The aggregate uses bounded synchronous', '29bffe2ee01bdd69e65a207b9c9197ba2aafcd5fb49d02591e8075891a77b4cc'],
  ['  // Report loaded source images, never requested poses', 'a5a61ea39c083c79f5bd9bd4a2e0ea63c6bb9f4593b2cbdc31b066be359d70cb'],
  ['  <section id="view-usage"', '5bd0b70528a5884fddce01f8c65d18e290e06ed493f21a23becde34bc54ce359'],
]);

export const RELEASE_EXCLUDED = new Set([
  'src/core/sprite-usage.cjs', 'src/core/sprite-catalog.cjs',
  'renderer/sprite-usage.js', 'renderer/sprite-usage.css',
]);
export const RELEASE_HOOK_ROOT = 'C:/Aipet/resources/app';
export const RELEASE_TRANSFORMED = new Set([
  'src/main.cjs', 'src/preload.cjs', 'renderer/pet.js',
  'renderer/studio.js', 'renderer/studio.html', 'src/core/hook-commands.cjs',
  'integrations/claude-hooks.example.json', 'integrations/codex-hooks.example.json',
]);

// This deliberately narrow build transform fails on source drift. It does not
// edit the development edition or leave a runtime switch for the collector.
function replace(text, before, after = '', expected = 1) {
  const parts = text.split(before);
  if (parts.length !== expected + 1) throw new Error('Release source changed; review the no-counter transform.');
  return parts.join(after);
}
function omit(text, start, end) {
  const from = text.indexOf(start), to = text.indexOf(end, from + start.length);
  if (from < 0 || to < 0 || text.indexOf(start, from + start.length) !== -1
      || text.indexOf(end, to + end.length) !== -1) throw new Error('Release source boundaries changed; review the no-counter transform.');
  if (createHash('sha256').update(text.slice(from, to)).digest('hex') !== omittedPins.get(start)) throw new Error('Release omitted source changed; review the complete block before updating its pin.');
  return text.slice(0, from) + text.slice(to);
}

export function releaseSource(relative, source) {
  let text = source.replaceAll('\r\n', '\n');
  if (relative === 'src/main.cjs') {
    text = replace(text, '  powerMonitor,\n');
    text = replace(text, 'const { createSpriteUsage } = require("./core/sprite-usage.cjs");\n');
    text = replace(text, 'const { createSpriteCatalog } = require("./core/sprite-catalog.cjs");\n');
    text = omit(text, 'const usageCatalog = createSpriteCatalog({', 'const launch = launchSpec({');
    text = omit(text, '  handle("aipet:sprite-usage",', '  handle("aipet:startup",');
    text = omit(text, '  await spriteUsage.load();', '  debugControl = await debugLog.readDebugControl');
    text = omit(text, '  spriteUsage.pause();\n  // The aggregate uses bounded synchronous', '  quitting = true;');
    text = replace(text, '  clearInterval(usageSaveTimer);\n');
    text = replace(text, '      spriteUsage.pause();\n');
    text = replace(text, '    spriteUsage.pause();\n');
    text = replace(text, [
      '  win.on("hide", () => spriteUsage.pause());',
      '  win.on("minimize", () => spriteUsage.pause());',
      '  win.webContents.on("render-process-gone", () => spriteUsage.pause());',
      '  win.webContents.on("did-start-loading", () => spriteUsage.pause());', '',
    ].join('\n'));
    text = replace(text, '          getSpriteUsage: spriteUsageSnapshot,\n          flushSpriteUsage: () => spriteUsage.flush(),\n');
  } else if (relative === 'src/preload.cjs') {
    for (const line of [
      '    getSpriteUsage: () => ipcRenderer.invoke("aipet:sprite-usage"),\n',
      '    resetSpriteUsage: () => ipcRenderer.invoke("aipet:sprite-usage-reset"),\n',
      '    reportSpriteUsage: (items) => ipcRenderer.invoke("aipet:sprite-usage-report", items),\n',
    ]) text = replace(text, line);
  } else if (relative === 'renderer/pet.js') {
    text = omit(text, '  // Report loaded source images, never requested poses', '  function speak(slot) {');
    text = replace(text, '      reportUsage();\n');
    text = replace(text, '    reportUsage();\n');
    text = replace(text, "slot.img.addEventListener('error', () => { slot.mask = null; reportUsage(); });", "slot.img.addEventListener('error', () => { slot.mask = null; });");
  } else if (relative === 'renderer/studio.js') {
    text = replace(text, '  const spriteUsage = window.SpriteUsage.create({ api });\n');
    text = replace(text, '["companion", "activity", "usage", "connections", "privacy"]', '["companion", "activity", "connections", "privacy"]');
    text = replace(text, 'name === "usage" ? "SPRITE USAGE" : name.toUpperCase()', 'name.toUpperCase()');
    text = replace(text, '    spriteUsage.setVisible(name === "usage");\n');
  } else if (relative === 'renderer/studio.html') {
    text = replace(text, '<link rel="stylesheet" href="sprite-usage.css">');
    text = replace(text, '<script src="sprite-usage.js"></script>');
    text = replace(text, '    <button class="nav-item" data-view="usage"><span class="nav-icon">▤</span>Sprite usage</button>\n');
    text = omit(text, '  <section id="view-usage"', '  <section id="view-connections"');
    text = replace(text, 'Preferences, the latest activity metadata and sprite counters live here.', 'Preferences and the latest activity metadata live here.');
  } else if (relative === 'integrations/codex-hooks.example.json') {
    if (!text.includes('G:/workspace/aipet')) throw new Error('Release hook template changed; review relocation.');
    // Encoded Windows overrides must be rebuilt from the validated readable
    // invocation; replacing plaintext alone leaves a hidden development path.
    text = JSON.stringify(hookCommands.prepareHookExample('codex', text, RELEASE_HOOK_ROOT), null, 2) + '\n';
  } else if (relative === 'src/core/hook-commands.cjs' || relative === 'integrations/claude-hooks.example.json') {
    if (!text.includes('G:/workspace/aipet')) throw new Error('Release hook template changed; review relocation.');
    text = text.replaceAll('G:/workspace/aipet', RELEASE_HOOK_ROOT);
  }
  if (['src/main.cjs', 'src/preload.cjs', 'renderer/pet.js', 'renderer/studio.js', 'renderer/studio.html'].includes(relative)) {
    if (/sprite.?usage|usageCatalog|usageAssets|usageBlocks|usageSaveTimer|reportUsage|usagePending|usageSignature|usageReportedAt/i.test(text)) throw new Error(`Counter code remains in release: ${relative}`);
    if (/\.(?:cjs|js)$/.test(relative)) new Script(text, { filename: relative });
  }
  return text;
}
