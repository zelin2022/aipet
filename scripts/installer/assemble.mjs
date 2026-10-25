import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const templates = path.dirname(fileURLToPath(import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function assembleInstaller({ payloadDirectory, outputDirectory, version }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid installer version.');
  const source = path.resolve(payloadDirectory);
  const output = path.resolve(outputDirectory);
  if (source === output || output.startsWith(source + path.sep) || source.startsWith(output + path.sep)) throw new Error('Installer source and output must be separate directories.');
  try { await lstat(output); throw new Error('Installer output already exists.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!(await lstat(source)).isDirectory() || (await lstat(source)).isSymbolicLink()) throw new Error('Unsafe installer payload root.');
  const files = [];
  async function copy(relative = '') {
    for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (!/^[A-Za-z0-9_. -]+(?:[\\/][A-Za-z0-9_. -]+)*$/.test(child) || child.split(path.sep).some(segment => segment === '.' || segment === '..')) throw new Error(`Unsupported installer path: ${child}`);
      const information = await lstat(path.join(source, child));
      if (information.isSymbolicLink()) throw new Error('Links and junctions cannot be installed.');
      if (information.isDirectory()) { await copy(child); continue; }
      if (!information.isFile()) throw new Error('Only regular payload files can be installed.');
      const destination = path.join(output, 'payload', child);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(source, child), destination);
      const bytes = await readFile(destination);
      files.push({ path: child.split(path.sep).join('/'), bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
  await mkdir(output, { recursive: true });
  await copy();
  if (files.length < 10 || files.length > 1024 || !files.some(file => file.path === 'electron.exe') || !files.some(file => file.path === 'resources/app/package.json')) throw new Error('Incomplete installer payload.');
  for (const name of ['Install.cmd','Install.ps1','Uninstall.cmd','Uninstall.ps1','Installer.Common.ps1','README-INSTALL.txt']) await copyFile(path.join(templates, name), path.join(output, name));
  await copyFile(path.join(templates, '../diagnose-codex-hooks.ps1'), path.join(output, 'Diagnose-Codex.ps1'));
  const manifest = { schemaVersion: 1, edition: 'no-counters', version, platform: 'win32', arch: 'x64', files: files.sort((a,b) => a.path.localeCompare(b.path)) };
  await writeFile(path.join(output, 'installer-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { outputDirectory: output, files: files.length, bytes: files.reduce((sum,file) => sum + file.bytes, 0), manifest };
}
