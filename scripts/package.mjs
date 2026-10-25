import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIcon } from './make-icon.mjs';
import { replaceBundle } from './package-replacement.mjs';
import artwork from '../src/core/artwork.cjs';
import { RELEASE_EXCLUDED, RELEASE_TRANSFORMED, releaseSource } from './release-variant.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = process.argv.includes('--release');
if (process.argv.slice(2).some(argument => argument !== '--release') || process.argv.slice(2).length > 1) throw new Error('Unsupported package arguments.');
const outputRoot = path.join(root, release ? 'dist/release/payload' : 'dist');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const includedFiles = new Map();
const runtimeFiles = new Map();
const runtimeVersion = '45.0.0';
const runtimeExecutableSha256 = '8e84549b05d27d444da2957653200d1e0ac287eff0fc5722b92835b9e0821a59';
const runtimeRoot = path.join(root, 'node_modules', 'electron', 'dist');
if (process.platform !== 'win32') throw new Error('Aipet packaging is supported on Windows only.');
if (process.arch !== 'x64') throw new Error('This build targets Windows x64. Run the pinned toolchain on Windows x64.');
const verification = spawnSync(process.execPath, [path.join(root, 'scripts', 'verify-assets.mjs')], { stdio: 'inherit', windowsHide: true });
if (verification.error) throw verification.error;
if (verification.status !== 0) throw new Error('Asset verification failed; refusing to package.');
await makeIcon();
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (Object.keys(metadata.dependencies || {}).length) throw new Error('Review runtime dependencies before changing the dependency-free package allowlist.');
const installedElectron = JSON.parse(await readFile(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'));
if (metadata.devDependencies.electron !== runtimeVersion || installedElectron.version !== runtimeVersion || (await readFile(path.join(runtimeRoot, 'version'), 'utf8')).trim() !== runtimeVersion) throw new Error('Review and pin the official vendor runtime before upgrading Electron.');
if (digest(await readFile(path.join(runtimeRoot, 'electron.exe'))) !== runtimeExecutableSha256) throw new Error('Installed Electron executable differs from the pinned vendor runtime. Reinstall the locked official dependency.');
await mkdir(outputRoot, { recursive: true });
if ((await lstat(outputRoot)).isSymbolicLink()) throw new Error('Refusing a symbolic link as the package output directory.');
const intendedOutput = path.join(outputRoot, 'Aipet-win32-x64');
if (path.dirname(intendedOutput) !== outputRoot) throw new Error('Unexpected package output path.');
try {
  if (!(await lstat(intendedOutput)).isDirectory() || (await lstat(intendedOutput)).isSymbolicLink()) throw new Error('Refusing an unsafe existing package output.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const staging = await mkdtemp(path.join(outputRoot, '.aipet-staging-'));
const distribution = path.join(staging, 'Aipet-win32-x64');
const appStaging = path.join(distribution, 'resources', 'app');
let preserveStaging = false;

async function copy(relative, sourceRelative = relative) {
  const source = path.join(root, sourceRelative);
  const destination = path.join(appStaging, relative);
  if (!(await lstat(source)).isFile()) throw new Error(`Only regular project files may be packaged: ${relative}`);
  await mkdir(path.dirname(destination), { recursive: true });
  if (release && RELEASE_TRANSFORMED.has(relative.split(path.sep).join('/'))) {
    await writeFile(destination, releaseSource(relative.split(path.sep).join('/'), await readFile(source, 'utf8')), 'utf8');
  } else await copyFile(source, destination);
  includedFiles.set(path.normalize(relative), digest(await readFile(destination)));
}
async function copyRuntime(relative = '') {
  for (const entry of await readdir(path.join(runtimeRoot, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    // The standard Electron sample loader is replaced by our resources/app payload.
    if (child === path.join('resources', 'default_app.asar')) continue;
    if (entry.isDirectory()) await copyRuntime(child);
    else if (entry.isFile()) {
      const source = path.join(runtimeRoot, child);
      const destination = path.join(distribution, child);
      const expectedHash = digest(await readFile(source));
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
      if (digest(await readFile(destination)) !== expectedHash) throw new Error(`Vendor runtime copy differs from its installed source: ${child}`);
      runtimeFiles.set(child, expectedHash);
    } else throw new Error(`Refusing non-regular vendor runtime entry: ${child}`);
  }
}
async function copyTree(relative, extensions) {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (release && RELEASE_EXCLUDED.has(child.split(path.sep).join('/'))) continue;
    if (['node_modules', 'tests', '.reference', '.git'].includes(entry.name) || entry.name.startsWith('.')) throw new Error(`Unexpected directory in package allowlist: ${child}`);
    if (entry.isDirectory()) await copyTree(child, extensions);
    else if (entry.isFile() && extensions.has(path.extname(entry.name)) && !/\.(test|spec)\./i.test(entry.name)) await copy(child);
    else throw new Error(`Unexpected file in package allowlist: ${child}`);
  }
}
async function treeSize(directory) {
  let files = 0, bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) { const nested = await treeSize(child); files += nested.files; bytes += nested.bytes; }
    else if (entry.isFile()) { files++; bytes += (await stat(child)).size; }
    else throw new Error(`Unexpected packaged filesystem entry: ${child}`);
  }
  return { files, bytes };
}
async function auditBundle(directory) {
  const appDirectory = path.join(directory, 'resources', 'app');
  const found = new Set();
  async function scan(relative = '') {
    for (const entry of await readdir(path.join(appDirectory, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await scan(child);
      else if (entry.isFile()) found.add(child);
      else throw new Error(`Non-regular packaged application entry: ${child}`);
    }
  }
  await scan();
  if (found.size !== includedFiles.size || [...includedFiles.keys()].some(file => !found.has(file))) throw new Error('Packaged file inventory differs from the explicit staging allowlist.');
  for (const relative of found) {
    if (/(^|[\\/])(node_modules|tests|\.reference|scripts)([\\/]|$)|\.(test|spec)\./i.test(relative)) throw new Error(`Forbidden packaged file: ${relative}`);
    if (relative !== 'package.json' && digest(await readFile(path.join(appDirectory, relative))) !== includedFiles.get(relative)) throw new Error(`Packaged file differs from staged source: ${relative}`);
  }
  const packageJson = JSON.parse(await readFile(path.join(appDirectory, 'package.json'), 'utf8'));
  if (packageJson.devDependencies || packageJson.scripts || Object.keys(packageJson.dependencies || {}).length) throw new Error('Development tooling or unexpected runtime dependencies bundled.');
  if (release && [...RELEASE_EXCLUDED].some(relative => found.has(path.normalize(relative)))) throw new Error('Counter module bundled in the no-counter release.');
  const assetRoot = path.join(appDirectory, 'assets', 'crosspet');
  const provenance = JSON.parse(await readFile(path.join(assetRoot, 'provenance.json'), 'utf8'));
  for (const asset of provenance.files) {
    const bytes = await readFile(path.join(assetRoot, asset.destination));
    if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256) throw new Error(`Packaged original asset mismatch: ${asset.destination}`);
  }
  if (digest(await readFile(path.join(assetRoot, 'manifest.json'))) !== provenance.manifestSha256) throw new Error('Packaged normalized asset manifest mismatch.');
  const custom = artwork.readCustomArtwork(path.join(appDirectory, 'assets', 'custom'), { strict: true, verifyInventory: true });
  for (const [relative, expectedHash] of runtimeFiles) {
    if (digest(await readFile(path.join(directory, relative))) !== expectedHash) throw new Error(`Vendor runtime was modified during packaging: ${relative}`);
  }
  const executable = await readFile(path.join(directory, 'electron.exe'));
  const peOffset = executable.readUInt32LE(60);
  if (executable.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0' || executable.readUInt16LE(peOffset + 4) !== 0x8664 || executable.readUInt16LE(peOffset + 24 + 68) !== 2) throw new Error('Expected a Windows x64 GUI executable.');
  if (digest(executable) !== runtimeExecutableSha256) throw new Error('Portable executable does not exactly match the original vendor Electron binary.');
  return { appFilesVerified: found.size, originalAssetsVerified: provenance.files.length, customPosesVerified: custom.posesVerified, customFilesVerified: custom.files.length, runtimeFilesVerified: runtimeFiles.size, vendorBinaryPreserved: true, iconEmbedded: false, executableSha256: digest(executable) };
}

try {
  await copyRuntime();
  await copyTree('src', new Set(['.cjs', '.ps1']));
  await copyTree('renderer', new Set(['.html', '.js', '.css', '.png', '.ico']));
  if (release) {
    for (const target of ['docs/release-windows.md', 'docs/integrations.md', 'docs/assets.md']) await copy(target, 'docs/release-windows.md');
  } else await copyTree('docs', new Set(['.md']));
  const provenance = JSON.parse(await readFile(path.join(root, 'assets', 'crosspet', 'provenance.json'), 'utf8'));
  for (const asset of [...provenance.files.map(file => file.destination), 'manifest.json', 'provenance.json']) await copy(path.join('assets', 'crosspet', asset));
  const custom = artwork.readCustomArtwork(path.join(root, 'assets', 'custom'), { strict: true, verifyInventory: true });
  for (const relative of custom.files) await copy(path.join('assets', 'custom', ...relative.split('/')));
  for (const relative of ['integrations/activity.mjs', 'integrations/activity-launch.ps1', 'integrations/claude-hooks.example.json', 'integrations/codex-hooks.example.json', 'package.json', 'THIRD_PARTY_NOTICES.md']) await copy(relative);
  if (release) await copy('README.md', 'scripts/release/README.md');
  else { await copy('README.md'); await copy('package-lock.json'); }
  const appMetadata = { ...metadata };
  delete appMetadata.devDependencies;
  delete appMetadata.scripts;
  if (release) appMetadata.aipetEdition = 'no-sprite-usage';
  await writeFile(path.join(appStaging, 'package.json'), `${JSON.stringify(appMetadata, null, 2)}\n`);
  const deployment = { schemaVersion: 1, mode: 'electron-portable', edition: release ? 'no-sprite-usage' : 'personal-development', executable: 'electron.exe', arguments: ['--background'], workingDirectory: '.', appDirectory: 'resources/app', icon: 'resources/app/renderer/icon.ico', vendorBinaryPreserved: true };
  await writeFile(path.join(distribution, 'deployment.json'), `${JSON.stringify(deployment, null, 2)}\n`);
  const checksums = JSON.parse(await readFile(path.join(root, 'node_modules', 'electron', 'checksums.json'), 'utf8'));
  const archiveName = `electron-v${runtimeVersion}-win32-x64.zip`;
  const runtimeProvenance = { schemaVersion: 1, package: 'electron', version: runtimeVersion, source: `https://github.com/electron/electron/releases/tag/v${runtimeVersion}`, distributionArchive: { name: archiveName, expectedSha256: checksums[archiveName] }, executable: { path: 'electron.exe', sha256: runtimeExecutableSha256, modified: false }, excludedVendorSample: 'resources/default_app.asar', files: [...runtimeFiles].map(([relative, sha256]) => ({ path: relative.split(path.sep).join('/'), sha256 })) };
  await writeFile(path.join(distribution, 'runtime-provenance.json'), `${JSON.stringify(runtimeProvenance, null, 2)}\n`);
  const audit = await auditBundle(distribution);
  const size = await treeSize(distribution);
  let replacement;
  try { replacement = await replaceBundle({ outputRoot, stagedOutput: distribution }); }
  catch (error) { preserveStaging = error.preserveStaging === true; throw error; }
  if (replacement.cleanupWarning) console.warn(replacement.cleanupWarning);
  const report = { version: metadata.version, electronVersion: runtimeVersion, platform: 'win32', arch: 'x64', mode: deployment.mode, edition: deployment.edition, asar: false, executable: path.join(intendedOutput, deployment.executable), arguments: deployment.arguments, ...size, ...audit, ...(replacement.retainedBackup ? { retainedBackup: replacement.retainedBackup } : {}) };
  await writeFile(path.join(outputRoot, 'package-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Packaged original Electron runtime + Aipet: ${report.executable} (${(size.bytes / 1024 / 1024).toFixed(1)} MiB; ${size.files} files).`);
} finally {
  // mkdtemp supplies the leaf name. Never remove anything outside this task's staging root.
  const relative = path.relative(outputRoot, staging);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(staging).startsWith('.aipet-staging-')) throw new Error('Refusing unexpected staging cleanup path.');
  if (!preserveStaging) await rm(staging, { recursive: true, force: true });
}
