'use strict';
const path = require('node:path');

const EXAMPLE_ROOT = 'G:/workspace/aipet';
const POWERSHELL = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const NODE = 'C:/Program Files/nodejs/node.exe';
const PREFIX = `${POWERSHELL} -NoLogo -NoProfile -NonInteractive`;
const STATES = new Set(['idle', 'thinking', 'reading', 'coding', 'tool', 'success', 'error', 'waiting', 'offline']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function prepareHookExample(provider, text, root) {
  if (!['claude', 'codex'].includes(provider) || typeof text !== 'string'
      || typeof root !== 'string' || !path.win32.isAbsolute(root)
      || /['"$`\r\n\0%!?^|<>]/.test(root)) throw new Error('Invalid hook example.');
  const normalized = path.win32.resolve(root).replaceAll('\\', '/').replace(/\/+$/, '');
  const example = JSON.parse(text.replaceAll(EXAMPLE_ROOT, normalized));
  if (!object(example) || !object(example.hooks)) throw new Error('Invalid hook example.');
  for (const groups of Object.values(example.hooks)) {
    if (!Array.isArray(groups)) throw new Error('Invalid hook example.');
    for (const group of groups) {
      if (!object(group) || !Array.isArray(group.hooks)) throw new Error('Invalid hook example.');
      for (const handler of group.hooks) {
        if (!object(handler) || handler.type !== 'command') throw new Error('Invalid hook example.');
        if (provider !== 'codex') continue;
        if (typeof handler.command !== 'string' || !handler.command.startsWith(`${PREFIX} -Command "`) || !handler.command.endsWith('"')) throw new Error('Invalid hook example.');
        const script = handler.command.slice(`${PREFIX} -Command "`.length, -1);
        const state = / --state ([a-z]+) --hook$/.exec(script)?.[1];
        const expected = `& '${NODE}' '${normalized}/integrations/activity.mjs' --provider codex --state ${state} --hook`;
        // Encode only our fixed bridge invocation; arbitrary shell bodies and
        // pre-existing overrides never become executable through this helper.
        if (!STATES.has(state) || script !== expected) throw new Error('Invalid hook example.');
        handler.commandWindows = `${PREFIX} -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
      }
    }
  }
  return example;
}

function prepareBundledHookExample(provider, text, root, powershellPath) {
  // Validate the original fixed bridge invocation before deriving states. Never
  // turn an arbitrary existing command body into an executable helper hook.
  const example = prepareHookExample(provider, text, root);
  const normalized = path.win32.resolve(root).replaceAll('\\', '/').replace(/\/+$/, '');
  const shell = powershellPath === undefined
    ? path.win32.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
    : powershellPath;
  if (typeof shell !== 'string' || shell.length > 2048 || !path.win32.isAbsolute(shell)
      || path.win32.basename(shell).toLowerCase() !== 'powershell.exe'
      || /['"$`\r\n\0%!?^|<>]/.test(shell)) throw new Error('Invalid bundled hook PowerShell path.');
  const powershell = path.win32.resolve(shell).replaceAll('\\', '/');
  const launcher = `${normalized}/integrations/activity-launch.ps1`;
  const executable = powershell.includes(' ') ? `"${powershell}"` : powershell;
  // The override is confined to this child process and does not change saved
  // Windows policy. Host trust still applies to each generated hook definition.
  const prefix = `${executable} -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass`;
  for (const groups of Object.values(example.hooks)) for (const group of groups) for (const handler of group.hooks) {
    let state;
    if (provider === 'codex') {
      if (handler.args !== undefined) throw new Error('Invalid bundled hook example.');
      state = / --state ([a-z]+) --hook"$/.exec(handler.command)?.[1];
    } else {
      state = handler.args?.[4];
      const expected = [`${normalized}/integrations/activity.mjs`, '--provider', 'claude', '--state', state, '--hook'];
      if (handler.command !== NODE || JSON.stringify(handler.args) !== JSON.stringify(expected)) throw new Error('Invalid bundled hook example.');
    }
    if (!STATES.has(state)) throw new Error('Invalid bundled hook example.');
    handler.timeout = 3;
    if (provider === 'codex') {
      const script = `& '${launcher}' -Provider codex -State ${state}`;
      handler.command = `${prefix} -Command "${script}"`;
      handler.commandWindows = `${prefix} -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
    } else {
      handler.command = powershell;
      handler.args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-Provider', 'claude', '-State', state];
      handler.onFailure = 'continue';
      delete handler.commandWindows;
    }
  }
  return example;
}

module.exports = { prepareHookExample, prepareBundledHookExample };
