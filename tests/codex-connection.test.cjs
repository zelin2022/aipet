'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { prepareHookExample, prepareBundledHookExample } = require('../src/core/hook-commands.cjs');
const { CodexConnectionError, resolveCodexDirectory, mergeCodexHooks, connectCodex } = require('../src/core/codex-connection.cjs');
const template = fs.readFileSync(path.join(__dirname, '../integrations/codex-hooks.example.json'), 'utf8');
const current = () => prepareBundledHookExample('codex', template, 'D:/Programs/Aipet/app/resources/app');
const old = () => prepareHookExample('codex', template, 'G:/workspace/aipet');
const clone = value => JSON.parse(JSON.stringify(value));
const windows = process.platform === 'win32';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-codex-connect-'));
  const home = path.join(root, 'isolated-user', '.codex');
  fs.mkdirSync(home, {recursive:true});
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aipet-codex-connect-'));
    fs.rmSync(root, {recursive:true, force:true});
  });
  const config = path.join(home, 'hooks.json');
  const environment = {USERPROFILE:path.join(root, 'wrong-user'), CODEX_HOME:home};
  return {root,home,config,environment,connect:() => connectCodex({example:current(),environment})};
}

test('Codex config directory honors only absolute local Windows homes', () => {
  assert.equal(resolveCodexDirectory({USERPROFILE:'D:/Users/Another User'}), 'D:\\Users\\Another User\\.codex');
  assert.equal(resolveCodexDirectory({USERPROFILE:'D:/Users/Ignored',CODEX_HOME:'E:/Separate Codex'}), 'E:\\Separate Codex');
  for (const value of ['\\\\server\\share', '\\\\?\\C:\\home', 'C:relative', 'relative', '', 'C:/foo/../bar', 'C:/foo./bar', 'C:/aux/data', 'C:/x:stream', 'C:/with\nnewline']) {
    assert.throws(() => resolveCodexDirectory({USERPROFILE:value}), {code:'invalid-directory'});
  }
  assert.equal(resolveCodexDirectory({USERPROFILE:'D:/Users/Name',CODEX_HOME:''}), 'D:\\Users\\Name\\.codex');
});

test('Codex merge upgrades only fixed Aipet handlers and preserves mixed groups and policy metadata', () => {
  const previous = old();
  const originalHandler = previous.hooks.Stop[0].hooks[0];
  const unrelated = {type:'command',command:'echo DO-NOT-EXECUTE',disabled:true,timeout:37};
  originalHandler.disabled = true;
  originalHandler.timeout = 1;
  originalHandler.policy = {mode:'never-approve'};
  previous.hooks.Stop[0].description = 'Keep this group';
  previous.hooks.Stop[0].hooks.unshift(unrelated);
  previous.hooks.UnrelatedFutureEvent = [{matcher:'anything',hooks:[{type:'mcp',tool:'synthetic-only'}],disabled:true}];
  previous.setting = {keep:[true,'unchanged'],trust:{never:'modify'}};
  const untouched = clone(previous);
  const result = mergeCodexHooks(previous, current());
  assert.equal(result.hookCount,10);
  assert.equal(result.replacedCount,10);
  assert.equal(result.addedCount,0);
  assert.equal(result.configuration.hooks.Stop[0].description,'Keep this group');
  assert.deepEqual(result.configuration.setting,untouched.setting);
  assert.deepEqual(result.configuration.hooks.UnrelatedFutureEvent,untouched.hooks.UnrelatedFutureEvent);
  assert.deepEqual(result.configuration.hooks.Stop[0].hooks[0],unrelated);
  const replacement = result.configuration.hooks.Stop[0].hooks[1];
  assert.equal(replacement.command,current().hooks.Stop[0].hooks[0].command);
  assert.equal(replacement.disabled,true);
  assert.equal(replacement.timeout,1);
  assert.deepEqual(replacement.policy,{mode:'never-approve'});
  assert.deepEqual(previous,untouched);
  assert.equal(mergeCodexHooks(result.configuration,current()).changed,false);
});

test('Codex merge keeps ambiguous executable changes and mismatched matcher/state handlers', () => {
  const previous = old();
  const changedOverride = previous.hooks.Stop[0].hooks[0];
  changedOverride.commandWindows += ' --unexpected';
  const overrideCopy = clone(changedOverride);
  const policy = clone(previous.hooks.PreToolUse[0]);
  policy.matcher = 'CUSTOM-POLICY-MATCHER';
  previous.hooks.PreToolUse = [policy];
  previous.hooks.PermissionRequest[0].hooks[0].args = ['CUSTOM'];
  const permissionCopy = clone(previous.hooks.PermissionRequest[0]);
  previous.hooks.Interrupt[0].hooks[0].command_windows = 'echo custom override';
  const aliasCopy = clone(previous.hooks.Interrupt[0]);
  const result = mergeCodexHooks(previous,current());
  assert.deepEqual(result.configuration.hooks.Stop[0].hooks[0],overrideCopy);
  assert.equal(result.configuration.hooks.Stop.length,2);
  assert.deepEqual(result.configuration.hooks.PreToolUse[0],policy);
  assert.equal(result.configuration.hooks.PreToolUse.length,4);
  assert.deepEqual(result.configuration.hooks.PermissionRequest[0],permissionCopy);
  assert.equal(result.configuration.hooks.PermissionRequest.length,2);
  assert.deepEqual(result.configuration.hooks.Interrupt[0],aliasCopy);
  assert.equal(result.configuration.hooks.Interrupt.length,2);
  assert.equal(mergeCodexHooks(result.configuration,current()).changed,false);
});

test('Codex registration creates a missing local config, then repeated connect is byte/mtime stable', {skip:!windows}, t => {
  const f = fixture(t);
  fs.rmdirSync(f.home);
  const first = f.connect();
  assert.equal(first.status,'connected');
  assert.equal(first.addedCount,10);
  assert.equal(first.backupPath,null);
  assert.equal(first.configPath,f.config);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.config,'utf8')),current());
  const bytes = fs.readFileSync(f.config);
  const stamp = fs.statSync(f.config).mtimeMs;
  const second = f.connect();
  assert.equal(second.status,'unchanged');
  assert.equal(second.backupPath,null);
  assert.deepEqual(fs.readFileSync(f.config),bytes);
  assert.equal(fs.statSync(f.config).mtimeMs,stamp);
  assert.deepEqual(fs.readdirSync(f.home),['hooks.json']);
  assert.equal(fs.existsSync(path.join(f.root,'wrong-user')),false);
});

test('Codex registration keeps original backup bytes, BOM/newline style and separate settings/trust files', {skip:!windows}, t => {
  const f = fixture(t);
  const existing = {userSettings:{allow:false},...old()};
  existing.hooks.Stop[0].hooks.push({type:'command',command:'echo KEEP-PRIVATE-SENTINEL'});
  const before = Buffer.from('\ufeff'+JSON.stringify(existing,null,4).replaceAll('\n','\r\n')+'\r\n');
  fs.writeFileSync(f.config,before);
  const separate = ['config.toml','hook-trust.json'];
  for (const name of separate) fs.writeFileSync(path.join(f.home,name),'DO-NOT-READ-OR-CHANGE');
  const result = f.connect();
  assert.equal(result.status,'connected');
  assert.equal(result.replacedCount,10);
  assert.equal(result.addedCount,0);
  assert.equal(path.dirname(result.backupPath),f.home);
  assert.match(path.basename(result.backupPath),/^hooks\.json\.aipet-backup-/);
  assert.deepEqual(fs.readFileSync(result.backupPath),before);
  const after = fs.readFileSync(f.config,'utf8');
  assert.equal(after.charCodeAt(0),0xfeff);
  assert.ok(after.includes('\r\n'));
  assert.deepEqual(JSON.parse(after.slice(1)).userSettings,existing.userSettings);
  assert.deepEqual(JSON.parse(after.slice(1)).hooks.Stop[0].hooks[1],existing.hooks.Stop[0].hooks[1]);
  for (const name of separate) assert.equal(fs.readFileSync(path.join(f.home,name),'utf8'),'DO-NOT-READ-OR-CHANGE');
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE-SENTINEL|EncodedCommand|activity-launch/);
  assert.equal(f.connect().status,'unchanged');
  assert.equal(fs.readdirSync(f.home).filter(name=>name.startsWith('hooks.json.aipet-backup-')).length,1);
});

test('Codex registration refuses malformed, duplicate, hazardous or oversized JSON without backups', {skip:!windows}, t => {
  const f = fixture(t);
  for (const invalid of ['{"hooks":', '[]', '{"hooks":null}', '{"hooks":{"Stop":{}}}',
    '{"hooks":{},"hooks":{}}', '{"settings":{"x":1,"\\u0078":2}}', '{"__proto__":{}}', '{"constructor":{}}',
    '{"nested":'+ '['.repeat(34)+'0'+']'.repeat(34)+'}', '{"number":1e400}', '{"number":9007199254740993}',
    '{"number":1.234567890123456789}', '{"number":1e-9999}', '{"number":-0}', ' '.repeat(262145)]) {
    fs.writeFileSync(f.config,invalid);
    assert.throws(f.connect,error=>error instanceof CodexConnectionError && ['invalid-config','config-too-large'].includes(error.code));
    assert.equal(fs.readFileSync(f.config,'utf8'),invalid);
    assert.deepEqual(fs.readdirSync(f.home),['hooks.json']);
  }
});

test('Codex registration preserves representable decimal values across harmless exponent spellings', {skip:!windows}, t => {
  const f = fixture(t);
  fs.writeFileSync(f.config,'{"a":1.2500,"b":0.0000000000001,"c":1e+2,"d":-2.5e-3}');
  assert.equal(f.connect().status,'connected');
  const parsed = JSON.parse(fs.readFileSync(f.config,'utf8'));
  assert.deepEqual([parsed.a,parsed.b,parsed.c,parsed.d],[1.25,1e-13,100,-0.0025]);
});

test('Codex registration refuses linked files, hardlinks and junction directories', {skip:!windows}, t => {
  const f = fixture(t);
  const target = path.join(f.root,'must-not-change.json');
  fs.writeFileSync(target,'{}');
  fs.linkSync(target,f.config);
  assert.throws(f.connect,{code:'unsafe-path'});
  assert.equal(fs.readFileSync(target,'utf8'),'{}');
  fs.unlinkSync(f.config);
  const outside = path.join(f.root,'outside');
  fs.mkdirSync(outside);
  fs.rmdirSync(f.home);
  fs.symlinkSync(outside,f.home,'junction');
  assert.throws(f.connect,{code:'unsafe-path'});
  assert.deepEqual(fs.readdirSync(outside),[]);
});

test('Codex registration rejects a concurrent edit and keeps its exact pre-write backup', {skip:!windows}, t => {
  const f = fixture(t);
  const before = Buffer.from('{}\n');
  fs.writeFileSync(f.config,before);
  const realWrite = fs.writeFileSync;
  let intercepted = false;
  fs.writeFileSync = function(file,...args) {
    const result = realWrite.call(this,file,...args);
    if (!intercepted && typeof file === 'number' && fs.readdirSync(f.home).some(name=>name.endsWith('.tmp'))) {
      intercepted = true;
      realWrite(f.config,'{"concurrent":"preserve-me"}\n');
    }
    return result;
  };
  try { assert.throws(f.connect,{code:'config-changed'}); }
  finally { fs.writeFileSync = realWrite; }
  assert.equal(intercepted,true);
  assert.equal(fs.readFileSync(f.config,'utf8'),'{"concurrent":"preserve-me"}\n');
  const backups = fs.readdirSync(f.home).filter(name=>name.startsWith('hooks.json.aipet-backup-'));
  assert.equal(backups.length,1);
  assert.deepEqual(fs.readFileSync(path.join(f.home,backups[0])),before);
  assert.equal(fs.readdirSync(f.home).some(name=>name.endsWith('.tmp')||name.endsWith('.lock')),false);
});

test('Codex registration respects a concurrent setup lock without changing config', {skip:!windows}, t => {
  const f = fixture(t);
  fs.writeFileSync(f.config,'{}');
  fs.writeFileSync(path.join(f.home,'.aipet-connect.lock'),'someone else');
  assert.throws(f.connect,{code:'busy'});
  assert.equal(fs.readFileSync(f.config,'utf8'),'{}');
  assert.equal(fs.readFileSync(path.join(f.home,'.aipet-connect.lock'),'utf8'),'someone else');
  assert.equal(fs.readdirSync(f.home).length,2);
});

test('Codex registration leaves a read-only config intact and removes its owned temporary/lock files', {skip:!windows}, t => {
  const f = fixture(t);
  fs.writeFileSync(f.config,'{}\n');
  fs.chmodSync(f.config,0o444);
  try {
    assert.throws(f.connect,{code:'write-failed'});
    assert.equal(fs.readFileSync(f.config,'utf8'),'{}\n');
    assert.equal(fs.readdirSync(f.home).some(name=>name.endsWith('.tmp')||name.endsWith('.lock')),false);
  } finally { fs.chmodSync(f.config,0o666); }
});

test('Codex registration cleans up a partially written owned lock after an IO failure', {skip:!windows}, t => {
  const f = fixture(t);
  fs.writeFileSync(f.config,'{}');
  const realSync = fs.fsyncSync;
  fs.fsyncSync = () => { throw new Error('synthetic failure with no config content'); };
  try { assert.throws(f.connect,{code:'write-failed'}); }
  finally { fs.fsyncSync = realSync; }
  assert.equal(fs.readFileSync(f.config,'utf8'),'{}');
  assert.deepEqual(fs.readdirSync(f.home),['hooks.json']);
});
