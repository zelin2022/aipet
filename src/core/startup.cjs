'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVAL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const VALUE_NAME = 'Aipet';
const MAX_COMMAND_LENGTH = 260;

// Fixed, independent, read-only query. No user text, launch path, shell expansion,
// profile or script-policy change is interpolated into this program.
const QUERY_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$taskRegistry = $null
try {
  $taskRegistry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
  $taskRead = {
    param([string] $taskSubkey)
    $taskKey = $taskRegistry.OpenSubKey($taskSubkey, $false)
    if ($null -eq $taskKey) { return $null }
    try {
      $taskData = $taskKey.GetValue('Aipet', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if ($null -eq $taskData) { return $null }
      $taskKind = $taskKey.GetValueKind('Aipet').ToString()
      switch ($taskKind) {
        'String' { return @{ type = 'REG_SZ'; data = [string] $taskData } }
        'Binary' { return @{ type = 'REG_BINARY'; data = [Convert]::ToBase64String([byte[]] $taskData) } }
        default { return @{ type = 'OTHER'; data = $null } }
      }
    } finally { $taskKey.Dispose() }
  }
  $taskResult = @{
    run = (& $taskRead 'Software\\Microsoft\\Windows\\CurrentVersion\\Run')
    approval = (& $taskRead 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run')
  }
  [Console]::Out.WriteLine(($taskResult | ConvertTo-Json -Compress -Depth 4))
} catch {
  [Console]::Error.WriteLine('startup-query-failed')
  exit 1
} finally { if ($null -ne $taskRegistry) { $taskRegistry.Dispose() } }
`;

function quoteWindowsArgument(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid startup argument.');
  let result = '"', slashes = 0;
  for (const character of value) {
    if (character === '\\') { slashes++; continue; }
    result += '\\'.repeat(character === '"' ? slashes * 2 + 1 : slashes) + character;
    slashes = 0;
  }
  return result + '\\'.repeat(slashes * 2) + '"';
}

function describe(launchSpec) {
  if (!launchSpec || typeof launchSpec !== 'object' || Array.isArray(launchSpec)
      || typeof launchSpec.executable !== 'string' || !/^[a-z]:[\\/]/i.test(launchSpec.executable)
      || /["<>|?*\x00-\x1f\x7f]/.test(launchSpec.executable)
      || !/\.exe$/i.test(launchSpec.executable) || !Array.isArray(launchSpec.args)
      || launchSpec.args.length > 16
      || launchSpec.args.some(arg => typeof arg !== 'string' || arg.length > 1024 || /[\x00-\x1f\x7f]/.test(arg))) {
    throw new Error('Invalid startup launch configuration.');
  }
  const executable = path.win32.normalize(launchSpec.executable);
  const args = [...launchSpec.args.filter(arg => arg !== '--background'), '--background'];
  const command = [executable, ...args].map(quoteWindowsArgument).join(' ');
  if (command.length > MAX_COMMAND_LENGTH) throw new Error('Startup command exceeds the Windows Run limit of 260 characters.');
  return { key: RUN_KEY, valueName: VALUE_NAME, scope: 'current-user', executable, args, command };
}

function runBounded(spawnProcess, executable, args) {
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, output = Buffer.alloc(0);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(new Error('Windows startup operation failed.'));
      else resolve(value);
    };
    try {
      child = spawnProcess(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      timer = setTimeout(() => { child.kill(); finish(true); }, 5000);
      child.stdout.on('data', chunk => {
        if (settled) return;
        if (output.length + chunk.length > 16384) { child.kill(); finish(true); return; }
        output = Buffer.concat([output, chunk]);
      });
      // Discard registry command diagnostics; never expose an unexpected stored value.
      child.stderr.resume();
      child.on('error', () => finish(true));
      child.on('close', code => finish(code !== 0, output.toString('utf8').trim()));
    } catch { finish(true); }
  });
}

function createRegistryAdapter({ spawnProcess = spawn, platform = process.platform, systemRoot = process.env.SystemRoot || 'C:\\Windows' } = {}) {
  if (platform !== 'win32') throw new Error('Windows startup is available only on Windows.');
  const reg = path.win32.join(systemRoot, 'System32', 'reg.exe');
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return {
    async read() {
      const result = await runBounded(spawnProcess, powershell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(QUERY_SCRIPT, 'utf16le').toString('base64')]);
      let record;
      try { record = JSON.parse(result); } catch { throw new Error('Windows startup query returned invalid data.'); }
      if (!record || typeof record !== 'object' || !Object.hasOwn(record, 'run') || !Object.hasOwn(record, 'approval')) throw new Error('Windows startup query returned invalid data.');
      return record;
    },
    async write(command) {
      if (typeof command !== 'string' || command.length > MAX_COMMAND_LENGTH || /[\x00-\x1f\x7f]/.test(command)) throw new Error('Invalid startup command.');
      await runBounded(spawnProcess, reg, ['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', command, '/f', '/reg:64']);
    },
    async remove() {
      await runBounded(spawnProcess, reg, ['delete', RUN_KEY, '/v', VALUE_NAME, '/f', '/reg:64']);
    },
  };
}

function approvalState(value) {
  if (value === null) return 'enabled';
  if (value?.type !== 'REG_BINARY' || typeof value.data !== 'string' || !/^[a-z0-9+/]*={0,2}$/i.test(value.data)) return 'unknown';
  const bytes = Buffer.from(value.data, 'base64');
  if (bytes.length !== 12) return 'unknown';
  const state = bytes.readUInt32LE(0);
  if (state === 0 || state === 2) return 'enabled';
  if (state === 3) return 'disabled';
  return 'unknown';
}

function unavailable(descriptor, error, supported = true) {
  return { supported, registered: null, matchesCurrentLaunch: null, enabled: false,
    status: 'unavailable', approval: 'unknown', command: descriptor?.command || null,
    key: RUN_KEY, valueName: VALUE_NAME, error };
}

function adapter(options) {
  if (options.registry) return options.registry;
  if (process.env.AIPET_DESKTOP_TEST === '1') throw new Error('Startup access is disabled during desktop tests.');
  return createRegistryAdapter();
}

async function get(launchSpec, options = {}) {
  let descriptor;
  try { descriptor = describe(launchSpec); }
  catch { return unavailable(null, 'Invalid startup launch configuration.'); }
  try {
    const values = await adapter(options).read();
    const registered = values.run !== null;
    const matchesCurrentLaunch = registered && values.run?.type === 'REG_SZ' && values.run.data === descriptor.command;
    const approval = approvalState(values.approval);
    const status = !registered ? 'disabled' : !matchesCurrentLaunch ? 'different-launch'
      : approval === 'disabled' ? 'blocked' : approval === 'unknown' ? 'approval-unknown' : 'enabled';
    return { supported: true, registered, matchesCurrentLaunch, enabled: status === 'enabled',
      status, approval, command: descriptor.command, key: RUN_KEY, valueName: VALUE_NAME, error: null };
  } catch {
    return unavailable(descriptor, process.env.AIPET_DESKTOP_TEST === '1' && !options.registry
      ? 'Startup access is disabled during desktop tests.' : 'Unable to read Windows startup registration.', process.platform === 'win32' || Boolean(options.registry));
  }
}

async function apply(enabled, launchSpec, options = {}) {
  let descriptor;
  try { descriptor = describe(launchSpec); }
  catch { return unavailable(null, 'Invalid startup launch configuration.'); }
  if (typeof enabled !== 'boolean') return unavailable(descriptor, 'Startup preference must be a boolean.');
  let registry;
  try {
    registry = adapter(options);
    if (enabled) await registry.write(descriptor.command);
    else if ((await registry.read()).run !== null) await registry.remove();
  } catch {
    const state = await get(launchSpec, options);
    return { ...state, error: process.env.AIPET_DESKTOP_TEST === '1' && !options.registry
      ? 'Startup access is disabled during desktop tests.' : 'Unable to change Windows startup registration.' };
  }
  const state = await get(launchSpec, { ...options, registry });
  if (!state.error && (enabled ? !state.matchesCurrentLaunch : state.registered)) {
    return { ...state, error: 'Windows startup change could not be verified.' };
  }
  return state;
}

let mutation = Promise.resolve();
function set(enabled, launchSpec, options = {}) {
  const pending = mutation.then(() => apply(enabled, launchSpec, options));
  mutation = pending.catch(() => {});
  return pending;
}

module.exports = { describe, get, set, createRegistryAdapter, quoteWindowsArgument, approvalState, RUN_KEY, APPROVAL_KEY, VALUE_NAME };
