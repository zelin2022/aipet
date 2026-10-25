import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyPlan, mergeHooks, readPlan } from './setup.mjs';
import hookCommands from '../src/core/hook-commands.cjs';

const adapter = 'G:/workspace/aipet/integrations/activity.mjs';
const own = { type: 'command', command: 'C:/node.exe', args: [adapter, '--provider', 'claude', '--state', 'offline', '--hook'] };
const other = { type: 'command', command: 'some-existing-user-hook --secret SYNTHETIC' };
const fragment = { hooks: { SessionEnd: [{ hooks: [own] }] } };

test('setup preserves unrelated settings and hooks, and is idempotent', () => {
  const config = { env: { SYNTHETIC_SECRET: 'never-print' }, unrelated: true, hooks: { SessionStart: [{ matcher: 'startup', hooks: [other] }], SessionEnd: [{ hooks: [own, other] }] } };
  const next = mergeHooks(config, fragment, adapter);
  assert.deepEqual(next.env, config.env);
  assert.deepEqual(next.hooks.SessionStart, config.hooks.SessionStart);
  assert.deepEqual(next.hooks.SessionEnd, [{ hooks: [other] }, { hooks: [own] }]);
  assert.deepEqual(mergeHooks(next, fragment, adapter), next);
  assert.deepEqual(config.hooks.SessionEnd[0].hooks, [own, other]);
  const removed = mergeHooks(next, fragment, adapter, true);
  assert.deepEqual(removed.hooks.SessionEnd, [{ hooks: [other] }]);
});

test('setup backs up exact original bytes, preserves secrets without reporting them, and detects concurrent edits', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aipet-setup-'));
  const configPath = path.join(directory, 'settings.json');
  const original = '{"env":{"SYNTHETIC_SECRET":"never-print"},"unrelated":true}\n';
  try {
    await writeFile(configPath, original);
    const plan = await readPlan('claude', { configPath });
    assert.equal(plan.changed, true);
    const report = await applyPlan(plan);
    assert.equal(await readFile(report.backupPath, 'utf8'), original);
    assert.ok(!JSON.stringify(report).includes('never-print'));
    const installed = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(installed.env.SYNTHETIC_SECRET, 'never-print');
    assert.equal(installed.hooks.SessionEnd[0].hooks[0].args.at(-2), 'offline');
    assert.equal((await readPlan('claude', { configPath })).changed, false);
    const removal = await readPlan('claude', { configPath, remove: true });
    await writeFile(configPath, '{"userEdited":true}');
    await assert.rejects(applyPlan(removal), /changed/);
    assert.equal(await readFile(configPath, 'utf8'), '{"userEdited":true}');
    assert.equal((await readdir(directory)).filter(name => name.endsWith('.tmp')).length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('setup creates only the requested config file when absent and rejects malformed hook structures', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aipet-setup-new-'));
  try {
    const configPath = path.join(directory, 'hooks.json');
    const report = await applyPlan(await readPlan('codex', { configPath }));
    assert.equal(report.created, true);
    assert.equal(report.backupPath, null);
    assert.deepEqual(await readdir(directory), ['hooks.json']);
    assert.throws(() => mergeHooks({ hooks: { Stop: 'invalid' } }, fragment, adapter));
    assert.throws(() => mergeHooks({ hooks: [] }, fragment, adapter));
    await writeFile(configPath, '{malformed');
    await assert.rejects(readPlan('codex', { configPath }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Windows overrides are regenerated after trusted relocation and never encode another command body', async () => {
  const source = await readFile(new URL('./codex-hooks.example.json', import.meta.url), 'utf8');
  const relocated = 'X:/Aipet Space/Companion';
  const prepared = hookCommands.prepareHookExample('codex', source, relocated);
  for (const handler of Object.values(prepared.hooks).flatMap(groups => groups.flatMap(group => group.hooks))) {
    const script = Buffer.from(handler.commandWindows.split(' -EncodedCommand ')[1], 'base64').toString('utf16le');
    assert.equal(script, handler.command.split(' -Command "')[1].slice(0, -1));
    assert.ok(script.includes(`'${relocated}/integrations/activity.mjs'`));
    assert.ok(!script.includes('G:/workspace/aipet'));
  }
  const overridden = JSON.parse(source);
  overridden.hooks.Stop[0].hooks[0].commandWindows = 'untrusted unsupported command';
  assert.match(hookCommands.prepareHookExample('codex', JSON.stringify(overridden), relocated).hooks.Stop[0].hooks[0].commandWindows, / -EncodedCommand [A-Za-z0-9+/=]+$/);
  const arbitrary = JSON.parse(source);
  arbitrary.hooks.Stop[0].hooks[0].command = arbitrary.hooks.Stop[0].hooks[0].command.slice(0, -1) + '; Write-Output BAD"';
  assert.throws(() => hookCommands.prepareHookExample('codex', JSON.stringify(arbitrary), relocated));
  assert.throws(() => hookCommands.prepareHookExample('codex', source.replaceAll('C:/Program Files/nodejs/node.exe', 'C:/unsupported.exe'), relocated));
  assert.throws(() => hookCommands.prepareHookExample('codex', source, 'relative'));
  assert.throws(() => hookCommands.prepareHookExample('codex', source, 'X:/unsafe$path'));
});

test('legacy and Windows override handlers merge exactly without claiming unrelated path mentions', async () => {
  const source = await readFile(new URL('./codex-hooks.example.json', import.meta.url), 'utf8');
  const prepared = hookCommands.prepareHookExample('codex', source, 'G:/workspace/aipet');
  const legacy = structuredClone(prepared);
  for (const handler of Object.values(legacy.hooks).flatMap(groups => groups.flatMap(group => group.hooks))) delete handler.commandWindows;
  const unrelated = [
    { type: 'command', command: `C:/tool.exe --explain ${adapter}.other`, commandWindows: 'unrelated-windows-hook' },
    { type: 'command', command: `echo '${adapter}'` },
  ];
  legacy.hooks.Stop.push({ hooks: unrelated });
  const merged = mergeHooks(legacy, prepared, adapter);
  const all = Object.values(merged.hooks).flatMap(groups => groups.flatMap(group => group.hooks));
  assert.equal(all.filter(handler => handler.commandWindows?.includes(' -EncodedCommand ')).length, 10);
  assert.deepEqual(merged.hooks.Stop[0].hooks, unrelated);
  assert.deepEqual(mergeHooks(merged, prepared, adapter), merged);
  assert.deepEqual(mergeHooks(merged, prepared, adapter, true), { hooks: { Stop: [{ hooks: unrelated }] } });
});

test('bundled Codex hooks use only the local helper with identical readable and Windows commands', async () => {
  const source = await readFile(new URL('./codex-hooks.example.json', import.meta.url), 'utf8');
  const relocated = 'D:/Users/Another User/Apps/Aipet/app/resources/app';
  const powershell = 'D:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  const legacy = hookCommands.prepareHookExample('codex', source, relocated);
  const prepared = hookCommands.prepareBundledHookExample('codex', source, relocated, powershell);
  const handlers = Object.values(prepared.hooks).flatMap(groups => groups.flatMap(group => group.hooks));
  assert.equal(handlers.length, 10);
  for (const handler of handlers) {
    const script = Buffer.from(handler.commandWindows.split(' -EncodedCommand ')[1], 'base64').toString('utf16le');
    assert.equal(script, handler.command.split(' -Command "')[1].slice(0, -1));
    assert.match(script, /^& '[^']+\/integrations\/activity-launch\.ps1' -Provider codex -State [a-z]+$/);
    assert.ok(script.includes(`'${relocated}/integrations/activity-launch.ps1'`));
    assert.ok(handler.command.startsWith(powershell + ' -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass '));
    assert.equal(handler.timeout, 3);
    assert.doesNotMatch(script, /node\.exe|activity\.mjs|G:\/workspace\/aipet/);
  }
  assert.deepEqual(hookCommands.prepareHookExample('codex', source, relocated), legacy, 'Bundled generation leaves legacy source behavior unchanged.');
});

test('bundled Claude hooks preserve fixed states and passive failures through absolute PowerShell arguments', async () => {
  const source = await readFile(new URL('./claude-hooks.example.json', import.meta.url), 'utf8');
  const relocated = 'D:/Users/Another User/Apps/Aipet/app/resources/app';
  const powershell = 'D:/System Root/System32/WindowsPowerShell/v1.0/powershell.exe';
  const legacy = hookCommands.prepareHookExample('claude', source, relocated);
  const prepared = hookCommands.prepareBundledHookExample('claude', source, relocated, powershell);
  const all = value => Object.values(value.hooks).flatMap(groups => groups.flatMap(group => group.hooks));
  const original = all(legacy), handlers = all(prepared);
  assert.equal(handlers.length, original.length);
  for (const [index, handler] of handlers.entries()) {
    assert.equal(handler.command, powershell);
    assert.deepEqual(handler.args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `${relocated}/integrations/activity-launch.ps1`, '-Provider', 'claude', '-State', original[index].args[4]]);
    assert.equal(handler.onFailure, 'continue');
    assert.equal(handler.timeout, 3);
    assert.equal(handler.commandWindows, undefined);
  }
  assert.deepEqual(hookCommands.prepareHookExample('claude', source, relocated), legacy);
});

test('bundled hook generation rejects arbitrary legacy commands and unsafe PowerShell destinations', async () => {
  const codexSource = await readFile(new URL('./codex-hooks.example.json', import.meta.url), 'utf8');
  const claudeSource = await readFile(new URL('./claude-hooks.example.json', import.meta.url), 'utf8');
  const root = 'D:/Apps/Aipet/resources/app';
  for (const powershell of ['relative/powershell.exe', 'D:/other.exe', 'D:/bad$path/powershell.exe', 'D:/bad"path/powershell.exe']) {
    assert.throws(() => hookCommands.prepareBundledHookExample('codex', codexSource, root, powershell), /Invalid bundled hook PowerShell path/);
  }
  const extraCodexArgs = JSON.parse(codexSource);
  extraCodexArgs.hooks.Stop[0].hooks[0].args = ['untrusted'];
  assert.throws(() => hookCommands.prepareBundledHookExample('codex', JSON.stringify(extraCodexArgs), root), /Invalid bundled hook example/);
  const alteredClaude = JSON.parse(claudeSource);
  alteredClaude.hooks.Stop[0].hooks[0].args.push('; Invoke-Expression BAD');
  assert.throws(() => hookCommands.prepareBundledHookExample('claude', JSON.stringify(alteredClaude), root), /Invalid bundled hook example/);
  const alteredCommand = JSON.parse(claudeSource);
  alteredCommand.hooks.Stop[0].hooks[0].command = 'C:/unsupported.exe';
  assert.throws(() => hookCommands.prepareBundledHookExample('claude', JSON.stringify(alteredCommand), root), /Invalid bundled hook example/);
  assert.throws(() => hookCommands.prepareBundledHookExample('codex', codexSource, 'D:/unsafe$root'), /Invalid hook example/);
});

test('bundled default PowerShell follows this machine SystemRoot and quotes spaces', async () => {
  const source = await readFile(new URL('./codex-hooks.example.json', import.meta.url), 'utf8');
  const previous = process.env.SystemRoot;
  try {
    process.env.SystemRoot = 'E:/System Root';
    const prepared = hookCommands.prepareBundledHookExample('codex', source, 'D:/Apps/Aipet/resources/app');
    const handlers = Object.values(prepared.hooks).flatMap(groups => groups.flatMap(group => group.hooks));
    for (const handler of handlers) {
      assert.ok(handler.command.startsWith('"E:/System Root/System32/WindowsPowerShell/v1.0/powershell.exe" '));
      assert.ok(handler.commandWindows.startsWith('"E:/System Root/System32/WindowsPowerShell/v1.0/powershell.exe" '));
    }
  } finally {
    if (previous === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previous;
  }
});
