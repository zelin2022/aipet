import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assembleInstaller } from './installer/assemble.mjs';

const root = path.resolve(import.meta.dirname, '..');
if (process.platform !== 'win32' || process.arch !== 'x64' || process.argv.length !== 2) throw new Error('This release builder requires Windows x64 and no arguments.');
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(metadata.version)) throw new Error('A numeric release version is required.');
const releaseRoot = path.join(root, 'dist/release');
await mkdir(releaseRoot, { recursive: true });
const resolvedRoot = await realpath(root), resolvedRelease = await realpath(releaseRoot);
if (!resolvedRelease.startsWith(resolvedRoot + path.sep) || (await lstat(releaseRoot)).isSymbolicLink()) throw new Error('Release output must remain inside this workspace.');
const name = `Aipet-${metadata.version}-Windows-x64-no-counters`;
const archive = path.join(releaseRoot, name + '.zip');
try { await lstat(archive); throw new Error('This release archive already exists. Preserve it and choose a new version before rebuilding.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
async function run(executable, args) {
  const child = spawn(executable, args, { cwd: root, windowsHide: true, shell: false, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error('Release build or archive verification failed.');
}
await run(process.execPath, [path.join(root, 'scripts/package.mjs'), '--release']);
const staging = await mkdtemp(path.join(releaseRoot, '.installer-staging-'));
const source = path.join(staging, name), temporaryArchive = path.join(staging, name + '.zip');
try {
  const assembled = await assembleInstaller({ payloadDirectory: path.join(releaseRoot, 'payload/Aipet-win32-x64'), outputDirectory: source, version: metadata.version });
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/create-release-archive.ps1'), '-SourceDirectory', source, '-ArchivePath', temporaryArchive]);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(temporaryArchive)) digest.update(chunk);
  const sha256 = digest.digest('hex'), bytes = (await lstat(temporaryArchive)).size;
  await rename(temporaryArchive, archive);
  await writeFile(archive + '.sha256', `${sha256}  ${path.basename(archive)}\n`);
  const report = { version: metadata.version, edition: 'no-counters', platform: 'win32', arch: 'x64', createdAt: new Date().toISOString(), archive, bytes, sha256, payloadFiles: assembled.files, spriteUsageIncluded: false, perUserInstaller: true, externalRuntimeDependencies: [], optionalHookPrerequisite: 'Node.js 22 or newer at the reviewed hook path', remotePublication: false };
  await writeFile(path.join(releaseRoot, 'release-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Created offline installer ZIP: ${archive} (${(bytes / 1024 / 1024).toFixed(1)} MiB).`);
} finally {
  const relative = path.relative(releaseRoot, staging);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(staging).startsWith('.installer-staging-') || (await lstat(staging)).isSymbolicLink()) throw new Error('Refusing unsafe release staging cleanup.');
  const resolvedStaging = await realpath(staging);
  if (!resolvedStaging.startsWith(resolvedRelease + path.sep)) throw new Error('Release staging escaped its intended directory.');
  await rm(staging, { recursive: true, force: true });
}
