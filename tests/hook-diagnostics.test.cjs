'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const windows = process.platform === 'win32';
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const script = path.join(root, 'scripts/diagnose-codex-hooks.ps1');
const prefix = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoLogo -NoProfile -NonInteractive';
const forward = value => value.replaceAll('\\', '/');
const invocation = (runtime, bridge, state = 'thinking') => `& '${forward(runtime)}' '${forward(bridge)}' --provider codex --state ${state} --hook`;
const handler = (readable, encoded = readable) => ({type:'command', command:`${prefix} -Command "${readable}"`, commandWindows:`${prefix} -EncodedCommand ${Buffer.from(encoded, 'utf16le').toString('base64')}`});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aipet-hook-diagnostics-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('aipet-hook-diagnostics-'));
    await fs.rm(directory, {recursive:true, force:true});
  });
  const profile = path.join(directory, 'isolated-profile');
  const app = path.join(directory, 'installed-app/resources/app');
  const codex = path.join(profile, '.codex');
  const events = path.join(profile, '.aipet/events');
  await fs.mkdir(path.join(app, 'integrations'), {recursive:true});
  await fs.mkdir(path.join(app, 'src/core'), {recursive:true});
  await fs.mkdir(codex, {recursive:true});
  await fs.mkdir(events, {recursive:true});
  await fs.copyFile(path.join(root,'integrations/activity.mjs'), path.join(app,'integrations/activity.mjs'));
  await fs.copyFile(path.join(root,'src/core/debug-log.cjs'), path.join(app,'src/core/debug-log.cjs'));
  await fs.copyFile(path.join(root,'src/core/activity.cjs'), path.join(app,'src/core/activity.cjs'));
  await fs.writeFile(path.join(app,'package.json'), '{"name":"aipet","version":"0.1.0"}\n');
  const bridge = path.join(app, 'integrations/activity.mjs');
  const configPath = path.join(codex, 'hooks.json');
  const run = (probe = false, options = []) => {
    const result = spawnSync(powershell, ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-AppDirectory',app,'-ProfileDirectory',profile,'-CodexDirectory',codex,...(probe?['-Probe']:[]),...options], {windowsHide:true, encoding:'utf8', timeout:15000, env:{...process.env,USERPROFILE:profile,LOCALAPPDATA:profile,APPDATA:profile,CODEX_HOME:codex}});
    assert.equal(result.error, undefined);
    return {...result, parsed:JSON.parse(result.stdout)};
  };
  return {directory, profile, app, codex, events, bridge, configPath, run};
}

test('Codex hook diagnostics distinguish stale encoded paths without exposing commands or other settings', {skip:!windows}, async t => {
  const {bridge,configPath,events,run} = await fixture(t);
  const current = invocation(process.execPath, bridge);
  const old = invocation('C:/Program Files/nodejs/node.exe', 'G:/workspace/aipet/integrations/activity.mjs');
  const config = {secret:'SYNTHETIC-NEVER-PRINT', hooks:{Stop:[{hooks:[handler(current),handler(current,old),{type:'command',command:'echo SYNTHETIC-NEVER-PRINT'}]}]}};
  const original = JSON.stringify(config);
  await fs.writeFile(configPath,original);
  const event = {version:1,provider:'codex',state:'coding',session:'1'.repeat(32),at:new Date(Date.now()-60000).toISOString()};
  await fs.writeFile(path.join(events,`codex-${event.session}.json`),JSON.stringify(event));
  const result = run();
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.equal(result.parsed.readOnly,true);
  assert.equal(result.parsed.recognizedHookCount,2);
  assert.equal(result.parsed.hooks[0].matchesInstalledBridge,true);
  assert.equal(result.parsed.hooks[0].referencedRuntimeExists,true);
  assert.equal(result.parsed.hooks[0].referencedShellExists,true);
  assert.equal(result.parsed.hooks[0].readableMatchesWindows,true);
  assert.equal(result.parsed.hooks[1].staleDevelopmentPath,true);
  assert.equal(result.parsed.hooks[1].matchesInstalledBridge,false);
  assert.equal(result.parsed.hooks[1].readableMatchesWindows,false);
  assert.deepEqual(result.parsed.events.latest,{at:event.at,state:'coding'});
  assert.doesNotMatch(result.stdout,/SYNTHETIC-NEVER-PRINT|G:\/workspace|isolated-profile|installed-app|EncodedCommand|activity\.mjs/);
  assert.equal(await fs.readFile(configPath,'utf8'),original);
  assert.deepEqual(await fs.readdir(events),[`codex-${event.session}.json`]);
});

test('Codex diagnostics reject malformed or oversized input and probe only the selected own bridge', {skip:!windows}, async t => {
  const {configPath,events,run} = await fixture(t);
  await fs.writeFile(configPath,'{"hooks":');
  let result=run(); assert.equal(result.status,0); assert.equal(result.parsed.hooksStatus,'invalid-or-unreadable');
  await fs.writeFile(configPath,'x'.repeat(262145));
  result=run(); assert.equal(result.status,0); assert.equal(result.parsed.hooksStatus,'invalid-or-unreadable');
  await fs.unlink(configPath);
  result=run(); assert.equal(result.parsed.hooksStatus,'missing'); assert.deepEqual(await fs.readdir(events),[]);
  result=run(true); assert.equal(result.status,0,result.stdout+result.stderr);
  assert.equal(result.parsed.probe.status,'event-written');
  assert.equal(result.parsed.events.latest.state,'thinking');
  assert.equal((await fs.readdir(events)).length,1);
  await assert.rejects(fs.stat(configPath),{code:'ENOENT'});
  assert.doesNotMatch(result.stdout,/isolated-profile|installed-app|activity\.mjs|EncodedCommand/);
});

test('Codex diagnostics recognize bundled helpers and report the selected runtime without exposing paths', {skip:!windows}, async t => {
  const {app,configPath,run} = await fixture(t);
  const helper=path.join(app,'integrations/activity-launch.ps1');
  const vendor=path.resolve(app,'../../electron.exe');
  await fs.writeFile(helper,'# metadata-only fixture, never executed');
  await fs.writeFile(vendor,'metadata-only fixture, never executed');
  const scriptBody=`& '${forward(helper)}' -Provider codex -State thinking`;
  const bundledPrefix='"D:/System Root/System32/WindowsPowerShell/v1.0/powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass';
  const good={type:'command',command:`${bundledPrefix} -Command "${scriptBody}"`,commandWindows:`${bundledPrefix} -EncodedCommand ${Buffer.from(scriptBody,'utf16le').toString('base64')}`};
  await fs.writeFile(configPath,JSON.stringify({hooks:{UserPromptSubmit:[{hooks:[good]}]}}));
  const result=run();
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.equal(result.parsed.bundledLauncherExists,true);
  assert.equal(result.parsed.bundledRuntimeExists,true);
  assert.equal(result.parsed.recognizedHookCount,1);
  assert.equal(result.parsed.hooks[0].runtimeKind,'bundled-electron');
  assert.equal(result.parsed.hooks[0].matchesInstalledBridge,true);
  assert.equal(result.parsed.hooks[0].referencedRuntimeExists,true);
  assert.equal(result.parsed.hooks[0].referencedShellExists,false);
  assert.equal(result.parsed.hooks[0].referencedLauncherExists,true);
  assert.equal(result.parsed.hooks[0].readableMatchesWindows,true);
  assert.doesNotMatch(result.stdout,/isolated-profile|installed-app|activity-launch|EncodedCommand/);
});
