// Exercises only the separately built personal-transfer release. Development
// remains usage-enabled and the normal user's profile is never opened.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const targetRoot = process.env.AIPET_RELEASE_APP_ROOT || path.join(root, 'dist/release/payload/Aipet-win32-x64/resources/app');
assert.notEqual(path.resolve(targetRoot), root, 'The release test must never alter or target the development profile.');
await readFile(path.join(targetRoot, 'src/main.cjs'));
await mkdir(path.join(root, 'out/smoke'), { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'aipet-release-test-'));
const data = path.join(profile, '.aipet');
await mkdir(data);
const sentinel = '{"existingUserData":"must remain byte-for-byte unchanged","version":0}\r\n';
await writeFile(path.join(data, 'sprite-usage.json'), sentinel);
const child = spawn(require('electron'), [path.join(root, 'tests/release-smoke.cjs'), '--background'], {
  cwd: root,
  windowsHide: true,
  env: {
    ...process.env,
    USERPROFILE: profile,
    LOCALAPPDATA: profile,
    APPDATA: profile,
    CODEX_HOME: path.join(profile, '.codex'),
    AIPET_DESKTOP_TEST: '1',
    AIPET_TEST_DATA: data,
    AIPET_SMOKE_APP_ROOT: targetRoot,
  },
  stdio: 'inherit',
});
let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  console.error('No-counter release smoke exceeded its 75-second deadline.');
  child.kill();
}, 75000);
const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
clearTimeout(timeout);
assert.equal(await readFile(path.join(data, 'sprite-usage.json'), 'utf8'), sentinel, 'Normal quit must preserve preexisting counters.');
assert.deepEqual((await readdir(data)).filter(name => /sprite.?usage/i.test(name)), ['sprite-usage.json'], 'Release must create no counter or scratch store.');
process.exitCode = !timedOut && typeof result === 'number' ? result : 1;
