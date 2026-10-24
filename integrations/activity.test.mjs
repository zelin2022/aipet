import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createEvent, defaultInbox, hookEvent, MAX_INPUT_BYTES, parseArguments, readHookInput, sessionFromEnvironment, writeEvent } from './activity.mjs';

const adapter = fileURLToPath(new URL('./activity.mjs', import.meta.url));
const at = '2026-10-23T12:00:00.000Z';

test('Windows inbox uses the absolute user profile and ignores LocalAppData virtualization', () => {
  const profile = path.resolve(tmpdir(), 'aipet-profile-test');
  const expected = path.join(profile, '.aipet', 'events');
  assert.equal(defaultInbox({ USERPROFILE: profile, LOCALAPPDATA: path.resolve(tmpdir(), 'different-package-cache') }, 'win32'), expected);
  assert.equal(defaultInbox({ USERPROFILE: profile }, 'win32'), expected);
  assert.ok(path.isAbsolute(defaultInbox({ USERPROFILE: false, LOCALAPPDATA: 'relative' }, 'win32')));
  assert.throws(() => defaultInbox({ USERPROFILE: 'relative-profile' }, 'win32'), /absolute-profile/);
  assert.throws(() => defaultInbox({ USERPROFILE: true }, 'win32'), /absolute-profile/);
});

test('hook payload reduces to the exact content-free schema', () => {
  const secret = 'SECRET-CONVERSATION-CREDENTIAL-CODE';
  const event = hookEvent('claude', {
    session_id: secret, hook_event_name: 'PreToolUse', tool_name: 'Read',
    prompt: secret, cwd: secret, transcript_path: secret, tool_input: { path: secret },
    tool_response: secret, credentials: secret, extra: secret,
  }, at);
  assert.deepEqual(Object.keys(event), ['version', 'provider', 'state', 'session', 'at']);
  assert.equal(event.state, 'reading');
  assert.match(event.session, /^[a-f0-9]{32}$/);
  assert.ok(!JSON.stringify(event).includes(secret));
  assert.notEqual(event.session, createEvent('codex', 'reading', secret, at).session);
});

test('fixed Claude hooks separate chats using only the documented environment metadata', async () => {
  const inbox = await mkdtemp(path.join(tmpdir(), 'aipet-claude-sessions-'));
  const secret = 'SYNTHETIC-INPUT-MUST-STAY-UNREAD';
  try {
    for (const [session, state] of [['session-a', 'coding'], ['session-b', 'success']]) {
      const result = spawnSync(process.execPath, [adapter, '--provider', 'claude', '--state', state, '--hook', '--inbox', inbox], {
        env: { ...process.env, CLAUDE_CODE_SESSION_ID: session }, input: secret,
        encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, '{}\n');
      assert.equal(result.stderr, '');
    }
    const files = await readdir(inbox);
    assert.equal(files.length, 2, 'One chat finishing must not overwrite another chat’s working event.');
    const events = await Promise.all(files.map(name => readFile(path.join(inbox, name), 'utf8')));
    assert.deepEqual(events.map(value => JSON.parse(value).state).sort(), ['coding', 'success']);
    assert.ok(events.every(value => !value.includes(secret) && !value.includes('session-a') && !value.includes('session-b')));
    const allowedOnly = new Proxy({ CLAUDE_CODE_SESSION_ID: 'session-c' }, {
      get(target, key) { assert.equal(key, 'CLAUDE_CODE_SESSION_ID'); return target[key]; },
      ownKeys() { throw new Error('Environment enumeration is forbidden.'); },
    });
    assert.equal(sessionFromEnvironment('claude', allowedOnly), 'session-c');
    assert.equal(sessionFromEnvironment('codex', allowedOnly), undefined);
    for (const invalid of [undefined, null, true, '', 'x'.repeat(257)])
      assert.equal(sessionFromEnvironment('claude', { CLAUDE_CODE_SESSION_ID: invalid }), undefined);
  } finally { await rm(inbox, { recursive: true, force: true }); }
});

test('maps documented lifecycle metadata without reading tool arguments or output', () => {
  const event = (provider, name, extra = {}) => hookEvent(provider, { hook_event_name: name, ...extra }, at)?.state;
  assert.equal(event('codex', 'UserPromptSubmit'), 'thinking');
  assert.equal(event('codex', 'PreToolUse', { tool_name: 'apply_patch' }), 'coding');
  assert.equal(event('codex', 'PreToolUse', { tool_name: 'functions.apply_patch' }), 'coding');
  assert.equal(event('claude', 'PreToolUse', { tool_name: 'Grep' }), 'reading');
  assert.equal(event('claude', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'cat secret' } }), 'tool');
  assert.equal(event('claude', 'PreToolUse', { tool_name: 'unrecognized-tool' }), 'tool');
  assert.equal(event('claude', 'PostToolUseFailure'), 'error');
  assert.equal(event('claude', 'StopFailure'), 'error');
  assert.equal(event('codex', 'PostToolUseFailure'), undefined);
  assert.equal(event('codex', 'PostToolUse', { tool_response: 'Error: secret' }), 'thinking');
  assert.equal(event('claude', 'PermissionRequest'), 'waiting');
  assert.equal(event('claude', 'Notification', { notification_type: 'permission_prompt' }), 'waiting');
  assert.equal(event('claude', 'Notification', { notification_type: 'auth_success' }), undefined);
  assert.equal(event('codex', 'Stop'), 'success');
  assert.equal(event('codex', 'Interrupt'), 'idle');
  assert.equal(event('claude', 'SessionEnd'), 'offline');
  assert.equal(event('codex', 'ArbitraryEvent'), undefined);
  assert.equal(hookEvent('other', {}), null);
});

test('input is bounded, malformed input is discarded, and idle pipes time out', async () => {
  const stream = new PassThrough();
  const result = readHookInput(stream);
  stream.end(Buffer.alloc(MAX_INPUT_BYTES + 1, 's'));
  assert.equal(await result, null);
  const broken = new PassThrough();
  const malformed = readHookInput(broken);
  broken.end('{invalid');
  assert.equal(await malformed, null);
  assert.equal(await readHookInput(new PassThrough(), 10), null);
});

test('invalid CLI arguments and untrusted state cannot choose arbitrary output', () => {
  assert.throws(() => parseArguments(['--provider', 'claude', '--state', '../secret']));
  assert.throws(() => parseArguments(['--provider', 'other', '--state', 'idle']));
  assert.throws(() => parseArguments(['--source', 'claude', '--state', 'idle']));
  assert.throws(() => parseArguments(['--source', 'codex', '--source', 'claude']));
  assert.throws(() => parseArguments(['--provider', 'codex', '--state', 'idle', '--inbox', 'relative']));
  assert.throws(() => createEvent('codex', 'arbitrary', 'id', at));
  assert.throws(() => createEvent('codex', 'thinking', 'id', '2026-10-23'));
  assert.throws(() => createEvent('codex', 'thinking', 'id', '2026-02-31T12:00:00.000Z'));
});

test('atomic writer strips extra fields, overwrites one session, and leaves no temporary files', async () => {
  const inbox = await mkdtemp(path.join(tmpdir(), 'aipet-adapter-'));
  try {
    const event = createEvent('codex', 'tool', '../../raw-session', at);
    const file = await writeEvent({ ...event, prompt: 'DO-NOT-PERSIST' }, inbox);
    await writeEvent({ ...event, state: 'success' }, inbox);
    assert.equal((await readdir(inbox)).length, 1);
    assert.equal(path.dirname(file), inbox);
    const saved = await readFile(file, 'utf8');
    assert.equal(JSON.parse(saved).state, 'success');
    assert.ok(!saved.includes('DO-NOT-PERSIST'));
    assert.ok(!saved.includes('../../raw-session'));
    await assert.rejects(writeEvent({ ...event, session: '../escape' }, inbox));
    await assert.rejects(writeEvent({ ...event, provider: 'other' }, inbox));
  } finally { await rm(inbox, { recursive: true, force: true }); }
});

test('CLI is passive, never prints hook secrets, and drops invalid or oversized input', async () => {
  const inbox = await mkdtemp(path.join(tmpdir(), 'aipet-adapter-cli-'));
  try {
    const secret = 'SYNTHETIC-SECRET-NEVER-LOG';
    const result = spawnSync(process.execPath, [adapter, '--source', 'claude', '--inbox', inbox], {
      input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'session', last_assistant_message: secret }), encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '{}\n');
    assert.equal(result.stderr, '');
    const before = await readdir(inbox);
    for (const input of ['{invalid', 's'.repeat(MAX_INPUT_BYTES + 1)]) {
      const invalid = spawnSync(process.execPath, [adapter, '--source', 'codex', '--inbox', inbox], { input, encoding: 'utf8', timeout: 5000 });
      assert.equal(invalid.status, 0);
      assert.equal(invalid.stdout, '{}\n');
      assert.equal(invalid.stderr, '');
    }
    assert.deepEqual(await readdir(inbox), before);
    assert.ok(!(await readFile(path.join(inbox, before[0]), 'utf8')).includes(secret));
    const invalidArguments = spawnSync(process.execPath, [adapter, '--source', 'codex', '--state', 'unknown'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(invalidArguments.status, 0);
    assert.equal(invalidArguments.stdout, '{}\n');
    const fixed = spawnSync(process.execPath, [adapter, '--provider', 'codex', '--state', 'reading', '--hook', '--inbox', inbox], {
      input: 'arbitrary secret input that is not even JSON', encoding: 'utf8', timeout: 5000,
    });
    assert.equal(fixed.status, 0);
    assert.equal(fixed.stdout, '{}\n');
    assert.equal(fixed.stderr, '');
    assert.equal((await readdir(inbox)).length, 2);
  } finally { await rm(inbox, { recursive: true, force: true }); }
});

test('recommended examples use fixed states, trusted executables, and disjoint common-tool matchers', async () => {
  for (const provider of ['claude', 'codex']) {
    const example = JSON.parse(await readFile(new URL(`./${provider}-hooks.example.json`, import.meta.url), 'utf8'));
    for (const groups of Object.values(example.hooks)) {
      for (const group of groups) {
        for (const handler of group.hooks) {
          if (provider === 'claude') {
            assert.equal(handler.command, 'C:/Program Files/nodejs/node.exe');
            assert.equal(handler.args[0], 'G:/workspace/aipet/integrations/activity.mjs');
            assert.equal(handler.args[1], '--provider');
            assert.equal(handler.args[2], provider);
            assert.equal(handler.args.at(-1), '--hook');
            assert.equal(handler.onFailure, 'continue');
          } else {
            assert.match(handler.command, /^C:\/Windows\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoLogo -NoProfile -NonInteractive -Command "& 'C:\/Program Files\/nodejs\/node\.exe' 'G:\/workspace\/aipet\/integrations\/activity\.mjs' /);
            assert.ok(handler.command.includes(`--provider ${provider}`));
            assert.ok(handler.command.endsWith('--hook"'));
            const encoded = handler.commandWindows.split(' -EncodedCommand ');
            assert.equal(encoded.length, 2);
            assert.equal(encoded[0], handler.command.split(' -Command ')[0]);
            assert.equal(Buffer.from(encoded[1], 'base64').toString('utf16le'), handler.command.split(' -Command "')[1].slice(0, -1));
          }
          assert.ok(!JSON.stringify(handler).includes('--source'));
          assert.ok(!JSON.stringify(handler).includes('$'));
          assert.ok(handler.timeout <= 3);
        }
      }
    }
    for (const tool of ['Read', 'Grep', 'Edit', 'Write', 'Bash', 'mcp__example__arbitrary']) {
      assert.equal(example.hooks.PreToolUse.filter(group => new RegExp(group.matcher).test(tool)).length, 1, tool);
    }
    if (provider === 'codex') {
      for (const tool of ['exec_command', 'shell_command', 'shell', 'write_stdin', 'functions.exec', 'functions.exec_command', 'functions.apply_patch', 'functions.view_image']) {
        assert.equal(example.hooks.PreToolUse.filter(group => new RegExp(group.matcher).test(tool)).length, 1, tool);
      }
    }
    assert.ok(!example.hooks.PreToolUse.some(group => group.matcher.includes('(?!')));
  }
});

test('Windows examples launch their own bridge through exec, cmd, PowerShell, and installed Git Bash', { skip: process.platform !== 'win32' }, async () => {
  const inbox = await mkdtemp(path.join(tmpdir(), 'aipet shell launch '));
  try {
    const claude = JSON.parse(await readFile(new URL('./claude-hooks.example.json', import.meta.url), 'utf8')).hooks.UserPromptSubmit[0].hooks[0];
    const result = spawnSync(claude.command, [...claude.args, '--inbox', inbox], { input: 'synthetic ignored payload', encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '{}\n');
    assert.equal(result.stderr, '');
    const codex = JSON.parse(await readFile(new URL('./codex-hooks.example.json', import.meta.url), 'utf8')).hooks.UserPromptSubmit[0].hooks[0];
    // Inject an isolated diagnostic destination inside the fixed inner PowerShell command.
    const command = codex.command.slice(0, -1) + ` --inbox '${inbox.replaceAll('\\', '/')}'"`;
    const encodedParts = codex.commandWindows.split(' -EncodedCommand ');
    const encodedScript = Buffer.from(encodedParts[1], 'base64').toString('utf16le') + ` --inbox '${inbox.replaceAll('\\', '/')}'`;
    const windowsCommand = encodedParts[0] + ' -EncodedCommand ' + Buffer.from(encodedScript, 'utf16le').toString('base64');
    const hosts = [
      ['cmd', 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', `"${command}"`], { windowsVerbatimArguments: true }],
      ['PowerShell', 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {}],
      ['Windows override via cmd standard arguments', 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', windowsCommand], {}],
    ];
    const bash = 'C:/Program Files/Git/bin/bash.exe';
    if (existsSync(bash)) {
      hosts.push(['Git Bash', bash, ['--noprofile', '--norc', '-c', command], {}]);
    }
    for (const [label, executable, args, options] of hosts) {
      const launched = spawnSync(executable, args, { ...options, input: 'synthetic ignored payload', encoding: 'utf8', timeout: 10000 });
      assert.equal(launched.status, 0, `${label}: ${launched.stderr || launched.error}`);
      assert.equal(launched.stdout, '{}\n', label);
      assert.equal(launched.stderr, '', label);
    }
    const files = await readdir(inbox);
    assert.equal(files.length, 2);
    for (const file of files) assert.equal(JSON.parse(await readFile(path.join(inbox, file), 'utf8')).state, 'thinking');
  } finally { await rm(inbox, { recursive: true, force: true }); }
});
