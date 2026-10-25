'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// The same sandboxed UI path runs against source, the copied app and the
// no-counter release. No host AI process or normal user profile is involved.
async function exerciseConnectCodex({ studio, pet = null, targetRoot, dataDirectory }) {
  assert.equal(process.env.AIPET_DESKTOP_TEST, '1');
  const profile = process.env.USERPROFILE;
  const codex = process.env.CODEX_HOME;
  assert.ok(profile && codex && path.isAbsolute(profile) && path.isAbsolute(codex));
  assert.equal(path.resolve(codex), path.join(path.resolve(profile), '.codex'), 'Connect smoke requires an explicit .codex under its test profile.');
  const relativeProfile = path.relative(os.tmpdir(), profile);
  assert.ok(relativeProfile && !relativeProfile.startsWith('..') && !path.isAbsolute(relativeProfile), 'The profile must be inside the temporary directory.');
  assert.ok(relativeProfile.split(path.sep).some(segment => /^aipet-(desktop|release)-test-/.test(segment)), 'Only the named disposable smoke profile may be edited.');
  assert.equal(path.resolve(targetRoot), path.resolve(process.env.AIPET_SMOKE_APP_ROOT));
  assert.equal(path.resolve(dataDirectory), path.resolve(process.env.AIPET_TEST_DATA));

  const configPath = path.join(codex, 'hooks.json');
  const settingsPath = path.join(codex, 'config.toml');
  await fs.mkdir(codex, { recursive: true });
  for (const file of [configPath, settingsPath]) await assert.rejects(fs.lstat(file), { code: 'ENOENT' }, 'The smoke fixture must begin in a fresh profile.');
  const run = source => studio.webContents.executeJavaScript(source);
  async function until(predicate, description) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await sleep(25);
    }
    throw new Error(`Timed out: ${description}`);
  }
  async function clickConnect() {
    await run('document.querySelector("#connect-codex").click()');
    await until(() => run('!document.querySelector("#connect-codex").disabled && !document.querySelector("#codex-connect-result").hidden'), 'Connect Codex UI result');
    return run('document.querySelector("#codex-connect-result").textContent');
  }

  const setup = await run('window.aipet.getSetup("codex")');
  const example = JSON.parse(setup.example);
  const oldOwnHandler = structuredClone(example.hooks.Stop[0].hooks[0]);
  const commandMarker = ' -Command "';
  const markerAt = oldOwnHandler.command.indexOf(commandMarker);
  assert.ok(markerAt > 0 && oldOwnHandler.command.endsWith('"'));
  const oldBody = oldOwnHandler.command.slice(markerAt + commandMarker.length, -1)
    .replaceAll(path.resolve(targetRoot).replaceAll('\\', '/'), 'C:/Aipet Smoke Old/resources/app');
  assert.ok(oldBody.includes('C:/Aipet Smoke Old/resources/app/integrations/activity'));
  oldOwnHandler.command = oldOwnHandler.command.slice(0, markerAt + commandMarker.length) + oldBody + '"';
  oldOwnHandler.commandWindows = oldOwnHandler.commandWindows.split(' -EncodedCommand ')[0]
    + ' -EncodedCommand ' + Buffer.from(oldBody, 'utf16le').toString('base64');
  const unrelated = { type: 'command', command: 'echo SYNTHETIC-UNRELATED-DO-NOT-EXECUTE', timeout: 17, enabled: false, customMetadata: { keep: true } };
  const futureGroup = { matcher: '^SyntheticNever$', hooks: [{ type: 'command', command: 'echo SYNTHETIC-FUTURE-DO-NOT-EXECUTE' }], description: 'future event metadata' };
  const original = {
    customSetting: { text: 'SYNTHETIC-PRESERVE-SETTINGS', list: [true, 7, 'untouched'] },
    hooks: {
      Stop: [{ hooks: [oldOwnHandler, unrelated], description: 'preserve mixed group metadata' }],
      SyntheticFutureEvent: [futureGroup],
    },
  };
  const originalBytes = Buffer.from(JSON.stringify(original, null, 4) + '\r\n');
  const tomlBytes = Buffer.from('# Synthetic settings: never an AI configuration from this workstation.\r\nmodel = "synthetic-never-run"\r\n');
  await fs.writeFile(configPath, originalBytes);
  await fs.writeFile(settingsPath, tomlBytes);
  const originalNames = await fs.readdir(codex);

  await run('document.querySelector("[data-view=connections]").click()');
  assert.equal(await run('document.querySelector("#view-connections").hidden'), false);
  assert.equal(await run('document.querySelector("#connect-codex").getBoundingClientRect().width > 0'), true);
  const badgeBefore = await run('document.querySelector("#codex-connected").textContent');
  assert.match(badgeBefore, /no (?:recent )?signal/i, 'Registration must be tested before synthetic activity arrives.');
  const text = await clickConnect();
  assert.match(text, /hooks are registered/);
  assert.match(text, /review and trust/);
  assert.equal(await run('document.querySelector("#codex-connect-result").classList.contains("error")'), false, text);
  assert.equal(await run('document.querySelector("#codex-connected").textContent'), badgeBefore, 'Writing a configuration must not invent activity or trust.');
  const mergedBytes = await fs.readFile(configPath);
  const merged = JSON.parse(mergedBytes.toString('utf8').replace(/^\uFEFF/, ''));
  assert.deepEqual(merged.customSetting, original.customSetting);
  assert.deepEqual(merged.hooks.SyntheticFutureEvent, original.hooks.SyntheticFutureEvent);
  assert.deepEqual(merged.hooks.Stop[0].hooks.find(handler => handler.command === unrelated.command), unrelated);
  assert.equal(merged.hooks.Stop[0].description, original.hooks.Stop[0].description);
  assert.deepEqual(await fs.readFile(settingsPath), tomlBytes, 'Connect never rewrites config.toml.');
  const allHandlers = Object.values(merged.hooks).flatMap(groups => groups.flatMap(group => group.hooks));
  const ownHandlers = allHandlers.filter(handler => handler.command?.includes('/integrations/activity'));
  assert.equal(ownHandlers.length, 10);
  assert.ok(ownHandlers.every(handler => handler.command.includes(path.resolve(targetRoot).replaceAll('\\', '/'))), 'All ten definitions point at this installation.');
  const namesAfter = await fs.readdir(codex);
  const backups = namesAfter.filter(name => !originalNames.includes(name));
  assert.equal(backups.length, 1, 'Exactly one backup and no scratch files remain after the merge.');
  assert.match(backups[0], /^hooks\.json\.aipet-backup-/);
  assert.deepEqual(await fs.readFile(path.join(codex, backups[0])), originalBytes, 'The backup preserves the exact original bytes.');

  const metadata = await fs.stat(configPath);
  const repeated = await clickConnect();
  assert.match(repeated, /already registered/);
  assert.deepEqual(await fs.readFile(configPath), mergedBytes);
  assert.equal((await fs.stat(configPath)).mtimeMs, metadata.mtimeMs, 'A repeated Connect does not rewrite existing hooks.');
  assert.deepEqual(await fs.readdir(codex), namesAfter, 'Repeated Connect creates no extra backup.');
  const escapePath = path.join(profile, 'renderer-cannot-select.json');
  await run(`window.aipet.connectCodex({configPath:${JSON.stringify(escapePath)},command:"echo SYNTHETIC"})`);
  await assert.rejects(fs.lstat(escapePath), { code: 'ENOENT' }, 'The renderer cannot select a destination path or command.');
  assert.deepEqual(await fs.readFile(configPath), mergedBytes);
  if (pet) assert.equal(await pet.webContents.executeJavaScript('window.aipet.connectCodex().then(()=>false,()=>true)'), true, 'The pet renderer cannot register AI hooks.');

  const malformed = Buffer.from('{"hooks": "SYNTHETIC-MALFORMED-NEVER-DISPLAY"');
  await fs.writeFile(configPath, malformed);
  const errorText = await clickConnect();
  assert.equal(await run('document.querySelector("#codex-connect-result").classList.contains("error")'), true, errorText);
  assert.ok(errorText.length > 0 && errorText.length <= 1000);
  assert.doesNotMatch(errorText, /SYNTHETIC-MALFORMED|SYNTHETIC-UNRELATED|EncodedCommand/);
  assert.deepEqual(await fs.readFile(configPath), malformed, 'Malformed settings remain untouched.');
  assert.deepEqual(await fs.readdir(codex), namesAfter, 'Rejected input creates no new backup or scratch file.');
  assert.deepEqual(await fs.readFile(settingsPath), tomlBytes);
  await fs.writeFile(configPath, mergedBytes);
  await clickConnect();
  return { isolatedProfile: true, clickRegistered: true, exactBackup: true, unrelatedSettingsPreserved: true, idempotent: true, pendingHostTrust: true, malformedInputPreserved: true, signalNotInvented: true };
}

module.exports = { exerciseConnectCodex };
