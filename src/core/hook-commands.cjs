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

module.exports = { prepareHookExample };
