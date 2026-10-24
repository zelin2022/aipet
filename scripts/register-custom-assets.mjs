// Explicit authoring allowlist. This reads local artwork, writes its manifest, then verifies it.
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { pngSize, readCustomArtwork, safeRelative, regularFile } = require('../src/core/artwork.cjs');
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/custom');
if (process.argv.slice(2).some(argument => argument !== '--enable-gpt')) throw new Error('Only --enable-gpt is supported.');
const current = JSON.parse(regularFile(directory, 'manifest.json', 256 * 1024).toString('utf8'));
const enableGPT = process.argv.includes('--enable-gpt') || current.profiles?.gpt?.mode === 'replace';
const plannedClaude = [
  ['greet', 'wave-v1'],
  ['thinking', 'thinking-curious-v1'],
  ['thinking', 'thinking-focused-v1'],
  ['pat', 'pat-lean-v1'],
  ['pat', 'pat-content-v1'],
  ['coaxed', 'coaxed-affection-v1'],
  ['hairplay', 'hairplay-v1'],
  ['reading', 'reading-studious-v1'],
  ['reading', 'reading-page-turn-v1'],
  ['coding', 'coding-quill-v1'],
  ['coding', 'coding-review-v1'],
  ['tool', 'tool-inspect-v1'],
  ['tool', 'tool-adjust-v1'],
];
const plannedGPT = [
  ['idle', 'idle-v1'], ['idle', 'idle-2-v1'], ['idle', 'idle-3-v1'],
  ['thinking', 'thinking-v1'], ['thinking', 'thinking-2-v1'], ['thinking', 'thinking-curious-v1'], ['thinking', 'thinking-focused-v1'],
  ['reading', 'reading-v1'], ['reading', 'reading-studious-v1'], ['reading', 'reading-page-turn-v1'],
  ['coding', 'writing-v1'], ['coding', 'coding-quill-v1'], ['coding', 'coding-review-v1'],
  ['tool', 'running-v1'], ['tool', 'tool-inspect-v1'], ['tool', 'tool-adjust-v1'],
  ['success', 'happy-v1'], ['error', 'oops-v1'], ['waiting', 'asking-v1'], ['waiting', 'listening-v1'], ['sleeping', 'sleeping-v1'],
  ['pat', 'pat-v1'], ['pat', 'forgiven-v1'], ['pat', 'pat-lean-v1'], ['pat', 'pat-content-v1'],
  ['poke', 'surprised-v1'], ['hum', 'hum-v1'], ['stretch', 'stretch-v1'], ['yawn', 'yawn-v1'],
  ['greet', 'greet-morning-v1'], ['greet', 'greet-afternoon-v1'], ['greet', 'greet-evening-v1'], ['greet', 'greet-wave-v1'],
  ['coaxed', 'coaxed-v1'], ['coaxed', 'coaxed-2-v1'], ['puffed', 'puffed-v1'], ['hairplay', 'hairplay-v1'],
  ['idle-blink', 'idle-blink-v1'],
];
// These social poses are independent additions, never completeness requirements
// for the base GPT replacement costume. Each may be registered once reviewed.
const plannedSocial = {
  claude: [['aloof', 'aloof-look-away-v1'], ['wink', 'wink-v1'], ['sip', 'black-tea-v1']],
  gpt: [['aloof', 'aloof-look-away-v1'], ['smug', 'smug-v1'], ['sip', 'white-monster-v1']],
};
const planned = [
  ...plannedClaude.map(([state, stem]) => ['claude', state, stem, false]),
  ...(enableGPT ? plannedGPT.map(([state, stem]) => ['gpt', state, stem, true]) : []),
  ...Object.entries(plannedSocial).flatMap(([character, entries]) => character === 'gpt' && !enableGPT ? [] : entries.map(([state, stem]) => [character, state, stem, false])),
];
const poses = [], pins = new Map();
function pin(relative) {
  safeRelative(relative);
  const bytes = regularFile(directory, relative, relative.endsWith('.png') ? 32 * 1024 * 1024 : 256 * 1024);
  pins.set(relative, { path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  return bytes;
}
for (const [character, state, stem, required] of planned) {
  const image = `${character}/${stem}.png`;
  if (!existsSync(path.join(directory, ...image.split('/')))) {
    if (required) throw new Error(`Complete GPT profile requires ${image}.`);
    continue;
  }
  const { width, height } = pngSize(pin(image));
  const provenance = `${character}/${stem}.provenance.json`;
  const metadata = JSON.parse(pin(provenance).toString('utf8'));
  const prompt = `${character}/${metadata.prompt}`, attribution = `${character}/${metadata.attribution}`;
  pin(prompt); pin(attribution);
  // This existing greeting visibly winks; reuse its image for the social action.
  const aliases = character === 'gpt' && stem === 'greet-morning-v1' ? ['wink'] : undefined;
  poses.push({ character, state, ...(aliases ? { aliases } : {}), image, provenance, prompt, attribution, width, height, ...(metadata.output?.framing ? { framing: metadata.output.framing } : {}) });
}
const manifest = { schemaVersion: 1, ...(enableGPT ? { profiles: { gpt: { mode: 'replace' } } } : {}), poses, files: [...pins.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')) };
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
// Validate the complete candidate before replacing the last known registration.
readCustomArtwork(directory, { strict: true, verifyInventory: true, manifestBytes });
writeFileSync(path.join(directory, 'manifest.json'), manifestBytes);
console.log(`Registered and verified ${poses.length} explicit custom images (${enableGPT ? 'Claude additions and complete GPT replacement' : 'Claude additions'}).`);
