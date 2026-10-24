'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { describe, get, set, createRegistryAdapter, quoteWindowsArgument, RUN_KEY, APPROVAL_KEY, VALUE_NAME } = require('../src/core/startup.cjs');

const spec = { executable: "G:\\my apps\\Aipet's & companion\\Aipet.exe", args: [] };
function binary(state) { const bytes = Buffer.alloc(12); bytes.writeUInt32LE(state); return { type: 'REG_BINARY', data: bytes.toString('base64') }; }
function fakeRegistry({ run = null, approval = null } = {}) {
  const record = { run, approval }, writes = [], removes = [];
  return { record, writes, removes,
    read: async () => ({ ...record }),
    write: async command => { writes.push(command); record.run = { type: 'REG_SZ', data: command }; },
    remove: async () => { removes.push(VALUE_NAME); record.run = null; },
  };
}

test('descriptor preserves spaces, apostrophes and shell metacharacters as one quoted executable', () => {
  const descriptor = describe(spec);
  assert.equal(descriptor.command, `"${spec.executable}" "--background"`);
  assert.equal(descriptor.key, RUN_KEY);
  assert.equal(descriptor.scope, 'current-user');
  const development = describe({ executable: 'C:/Program Files/Electron/electron.exe', args: ['G:\\project with spaces\\', '--background', '--background'] });
  assert.deepEqual(development.args, ['G:\\project with spaces\\', '--background']);
  assert.equal(development.command, '"C:\\Program Files\\Electron\\electron.exe" "G:\\project with spaces\\\\" "--background"');
  assert.equal(quoteWindowsArgument(''), '""');
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"');
  assert.equal(quoteWindowsArgument('a\\"b'), '"a\\\\\\"b"');
});

test('unsafe or overlong launch configurations fail before any registry access', async () => {
  const registry = fakeRegistry();
  for (const invalid of [{ executable: 'Aipet.exe', args: [] }, { executable: '\\\\server\\share\\Aipet.exe', args: [] },
    { executable: 'C:\\Aipet.exe" --other', args: [] }, { executable: 'C:\\Aipet.exe', args: ['line\nbreak'] },
    { executable: 'C:\\Aipet.exe', args: 'bad' }, { executable: 'C:\\Aipet.exe', args: ['s'.repeat(260)] }]) {
    assert.throws(() => describe(invalid));
    const state = await set(true, invalid, { registry });
    assert.equal(state.status, 'unavailable');
  }
  assert.equal((await set('true', spec, { registry })).status, 'unavailable');
  assert.equal(registry.writes.length, 0);
  assert.equal(registry.removes.length, 0);
});

test('registration is read back, disable removes only our value and absent disable is idempotent', async () => {
  const registry = fakeRegistry();
  assert.equal((await get(spec, { registry })).status, 'disabled');
  const enabled = await set(true, spec, { registry });
  assert.equal(enabled.registered, true);
  assert.equal(enabled.matchesCurrentLaunch, true);
  assert.equal(enabled.enabled, true);
  assert.equal(registry.writes[0], describe(spec).command);
  const disabled = await set(false, spec, { registry });
  assert.equal(disabled.registered, false);
  assert.equal(disabled.enabled, false);
  await set(false, spec, { registry });
  assert.deepEqual(registry.removes, ['Aipet']);
});

test('Windows disabled/unknown approval is reported without overwriting the operating-system choice', async () => {
  const registry = fakeRegistry({ approval: binary(3) });
  let state = await set(true, spec, { registry });
  assert.equal(state.registered, true);
  assert.equal(state.status, 'blocked');
  assert.equal(state.enabled, false);
  assert.deepEqual(registry.record.approval, binary(3));
  registry.record.approval = binary(2);
  assert.equal((await get(spec, { registry })).status, 'enabled');
  registry.record.approval = binary(9);
  state = await get(spec, { registry });
  assert.equal(state.status, 'approval-unknown');
  assert.equal(state.enabled, false);
});

test('mismatched existing values and operation failures cannot leak unexpected registry data or claim success', async () => {
  const registry = fakeRegistry({ run: { type: 'REG_SZ', data: 'UNRELATED-SECRET-COMMAND' } });
  let state = await get(spec, { registry });
  assert.equal(state.status, 'different-launch');
  assert.equal(state.enabled, false);
  assert.ok(!JSON.stringify(state).includes('UNRELATED-SECRET-COMMAND'));
  registry.write = async () => { throw new Error('SECRET-FAILURE-DETAILS'); };
  state = await set(true, spec, { registry });
  assert.equal(state.enabled, false);
  assert.match(state.error, /Unable to change/);
  assert.ok(!JSON.stringify(state).includes('SECRET-FAILURE-DETAILS'));
  registry.read = async () => { throw new Error('SECRET-READ-DETAILS'); };
  state = await get(spec, { registry });
  assert.equal(state.registered, null);
  assert.equal(state.status, 'unavailable');
  assert.ok(!JSON.stringify(state).includes('SECRET-READ-DETAILS'));
  const silent = fakeRegistry(); silent.write = async () => {};
  assert.match((await set(true, spec, { registry: silent })).error, /could not be verified/);
});

test('rapid changes are serialized so the last requested preference wins', async () => {
  const registry = fakeRegistry();
  const write = registry.write;
  registry.write = async command => { await new Promise(resolve => setTimeout(resolve, 10)); await write(command); };
  const enabled = set(true, spec, { registry });
  const disabled = set(false, spec, { registry });
  assert.equal((await enabled).enabled, true);
  assert.equal((await disabled).registered, false);
  assert.equal(registry.record.run, null);
});

test('native adapter fixes registry scope/name, quotes via argument arrays and never modifies approval or policy', async () => {
  const calls = [];
  const spawnProcess = (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.end(executable.endsWith('powershell.exe') ? JSON.stringify({ run: null, approval: null }) : '');
      child.emit('close', 0);
    });
    return child;
  };
  const registry = createRegistryAdapter({ spawnProcess, platform: 'win32', systemRoot: 'C:\\Windows' });
  await registry.read(); await registry.write(describe(spec).command); await registry.remove();
  for (const call of calls) {
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.shell, false);
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
  }
  const script = Buffer.from(calls[0].args.at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes("GetValue('Aipet'"));
  assert.ok(!script.includes('SetValue') && !script.includes('DeleteValue'));
  assert.ok(!calls[0].args.includes('-ExecutionPolicy'));
  assert.deepEqual(calls[1].args, ['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', describe(spec).command, '/f', '/reg:64']);
  assert.deepEqual(calls[2].args, ['delete', RUN_KEY, '/v', VALUE_NAME, '/f', '/reg:64']);
  assert.ok(calls.slice(1).every(call => !call.args.includes(APPROVAL_KEY)));
});

test('desktop test mode cannot read or change the real registry without an injected adapter', async () => {
  const previous = process.env.AIPET_DESKTOP_TEST;
  process.env.AIPET_DESKTOP_TEST = '1';
  try {
    const state = await set(true, spec);
    assert.equal(state.enabled, false);
    assert.match(state.error, /disabled during desktop tests/);
    assert.equal((await get(spec)).registered, null);
  } finally {
    if (previous === undefined) delete process.env.AIPET_DESKTOP_TEST;
    else process.env.AIPET_DESKTOP_TEST = previous;
  }
});
