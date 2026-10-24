// The importer owns the offline byte/hash and scope checks; keep one verification implementation.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = spawnSync(process.execPath, [fileURLToPath(new URL('./import-assets.mjs', import.meta.url)), '--verify'], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
else {
  const custom = spawnSync(process.execPath, [fileURLToPath(new URL('./verify-custom-assets.mjs', import.meta.url))], { stdio: 'inherit', windowsHide: true });
  if (custom.error) throw custom.error;
  process.exitCode = custom.status ?? 1;
}
