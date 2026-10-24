#!/usr/bin/env node
// Our importer reads declarative data and image bytes. It never imports or executes upstream code.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'assets', 'crosspet');
const repository = 'https://github.com/lokicorvus/crosspet';
const commit = '6e98970f6ff9b44e8ac85215241cabcd78f67d92';
const selectedCharacters = new Set(['claude', 'gpt']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const safePath = relative => {
  if (relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe relative asset path: ${relative}`);
  }
  return path.join(destination, ...relative.split('/'));
};

if (process.argv.includes('--verify')) {
  const provenance = JSON.parse(await readFile(path.join(destination, 'provenance.json'), 'utf8'));
  if (provenance.upstream.commit !== commit) throw new Error('Unexpected provenance commit');
  for (const file of provenance.files) {
    const local = safePath(file.destination);
    if (!(await lstat(local)).isFile()) throw new Error(`Not a regular asset file: ${file.destination}`);
    const bytes = await readFile(local);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`Asset changed: ${file.destination}`);
  }
  const manifestBytes = await readFile(path.join(destination, 'manifest.json'));
  if (sha256(manifestBytes) !== provenance.manifestSha256) throw new Error('Normalized manifest changed');
  const manifest = JSON.parse(manifestBytes);
  const knownFiles = new Set(provenance.files.map(file => file.destination));
  if (manifest.characters.length !== selectedCharacters.size || manifest.characters.some(character => !selectedCharacters.has(character.id))) {
    throw new Error('Asset manifest must contain only the selected Claude and GPT characters');
  }
  for (const character of manifest.characters) {
    for (const asset of Object.values(character.poses)) {
      safePath(asset);
      if (!knownFiles.has(asset)) throw new Error(`Untracked pose: ${asset}`);
    }
  }
  const expectedFiles = new Set([...knownFiles, 'manifest.json', 'provenance.json']);
  async function verifyDirectory(relative = '') {
    for (const entry of await readdir(relative ? safePath(relative) : destination, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await verifyDirectory(child);
      else if (!entry.isFile() || !expectedFiles.has(child)) throw new Error(`Unexpected asset file: ${child}`);
    }
  }
  await verifyDirectory();
  console.log(`Verified ${provenance.files.length} original files and ${manifest.characters.length} character manifests.`);
  process.exit(0);
}

const source = path.resolve(process.argv[2] || path.join(root, '.reference', 'crosspet'));
const actualCommit = execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (actualCommit !== commit) throw new Error(`Expected upstream ${commit}; found ${actualCommit}. Review a revision before updating the pin.`);
const changes = execFileSync('git', ['-C', source, 'status', '--porcelain', '--untracked-files=all', '--', 'characters/claude', 'characters/gpt', 'characters/LICENSE.md', 'LICENSE'], { encoding: 'utf8' }).trim();
if (changes) throw new Error('Refusing to import modified upstream character or license files.');
const upstream = { repository, commit, tree: `${repository}/tree/${commit}` };
const files = [];
await mkdir(destination, { recursive: true });

async function preserve(sourceRelative, destinationRelative) {
  const original = path.join(source, ...sourceRelative.split('/'));
  if (!(await lstat(original)).isFile()) throw new Error(`Refusing non-regular source file: ${sourceRelative}`);
  const target = safePath(destinationRelative);
  await mkdir(path.dirname(target), { recursive: true });
  const bytes = await readFile(original);
  await copyFile(original, target);
  if (sha256(await readFile(target)) !== sha256(bytes)) throw new Error(`Copy verification failed: ${sourceRelative}`);
  files.push({ source: sourceRelative, destination: destinationRelative, bytes: bytes.length, sha256: sha256(bytes) });
  return bytes;
}

await preserve('LICENSE', 'UPSTREAM_LICENSE.txt');
await preserve('characters/LICENSE.md', 'characters/LICENSE.md');
const entries = (await readdir(path.join(source, 'characters'), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
const originals = new Map();
for (const entry of entries) {
  if (entry.name === 'LICENSE.md') continue;
  if (!selectedCharacters.has(entry.name)) continue;
  if (!entry.isDirectory() || !/^[a-z0-9-]+$/.test(entry.name)) throw new Error(`Unexpected character entry: ${entry.name}`);
  const characterDirectory = path.join(source, 'characters', entry.name);
  const characterFiles = (await readdir(characterDirectory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  let metadata;
  const poseVariants = {};
  const exactPoses = {};
  for (const file of characterFiles) {
    if (!file.isFile() || !(file.name === 'character.json' || /^[a-z0-9_-]+\.webp$/.test(file.name))) {
      throw new Error(`Unexpected character file: ${entry.name}/${file.name}`);
    }
    const relative = `characters/${entry.name}/${file.name}`;
    const bytes = await preserve(relative, relative);
    if (file.name === 'character.json') {
      metadata = JSON.parse(bytes.toString('utf8'));
    } else {
      if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') throw new Error(`Not a WebP image: ${relative}`);
      const stem = file.name.slice(0, -5);
      exactPoses[stem] = relative;
      if (stem === 'idle-blink') continue;
      const pose = stem.replace(/-\d+$/, '');
      (poseVariants[pose] ||= []).push(relative);
    }
  }
  if (!metadata || typeof metadata.name !== 'string') throw new Error(`Invalid declarative character metadata: ${entry.name}`);
  originals.set(entry.name, { metadata, poseVariants, exactPoses });
}

for (const id of selectedCharacters) {
  if (!originals.has(id)) throw new Error(`Missing selected upstream character: ${id}`);
}

const characters = [...originals].map(([id, { metadata, poseVariants, exactPoses }]) => {
  const provider = id === 'gpt' ? 'codex' : id;
  const poses = { ...exactPoses };
  for (const [pose, variants] of Object.entries(poseVariants)) poses[pose] ||= variants[0];
  return {
    id,
    name: metadata.name,
    provider,
    accent: /^#[a-f0-9]{6}$/i.test(metadata.accent || '') ? metadata.accent : '#8f9cb8',
    egg: false,
    poses,
    poseVariants,
    sourceData: `characters/${id}/character.json`,
  };
});
const manifest = { schemaVersion: 1, upstream, characters };
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
await writeFile(path.join(destination, 'manifest.json'), manifestBytes);
const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
const provenance = { schemaVersion: 1, upstream, license: 'CC-BY-NC-SA-4.0 (character artwork and designs, subject to upstream rights caveat)', manifestSha256: sha256(manifestBytes), fileCount: files.length, totalBytes, files };
await writeFile(path.join(destination, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`Imported ${files.length} original files (${totalBytes.toLocaleString('en')} bytes), ${characters.length} characters. Upstream code was not run.`);
