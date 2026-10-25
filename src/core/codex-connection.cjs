'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const MAX_BYTES = 256 * 1024;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const STATES = new Set(['idle', 'thinking', 'reading', 'coding', 'tool', 'success', 'error', 'waiting', 'offline']);
const MESSAGES = Object.freeze({
  'invalid-directory': 'Codex needs a local, absolute Windows configuration directory.',
  'unsafe-path': 'The Codex hook path contains a link or an unsafe filesystem entry. No hooks were changed.',
  'invalid-config': 'Codex hooks.json is not a supported JSON object. Repair it manually before connecting.',
  'config-too-large': 'Codex hooks.json is too large to update safely. No hooks were changed.',
  'invalid-example': 'Aipet could not prepare its fixed Codex hooks. No hooks were changed.',
  'busy': 'Another Aipet connection is in progress. Try again after it finishes.',
  'config-changed': 'Codex hooks.json changed during setup. No hooks were replaced; try again.',
  'write-failed': 'Aipet could not safely save Codex hooks. Check file permissions and try again.',
});

class CodexConnectionError extends Error {
  constructor(code) { super(MESSAGES[code] || MESSAGES['write-failed']); this.name = 'CodexConnectionError'; this.code = own(MESSAGES, code) ? code : 'write-failed'; }
}
function fail(code) { throw new CodexConnectionError(code); }

function localDirectory(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^[a-z]:[\\/]/i.test(value)
      || /[\x00-\x1f\x7f<>"|?*]/.test(value) || value.slice(2).includes(':')) fail('invalid-directory');
  const parts = value.slice(3).split(/[\\/]/).filter(Boolean);
  if (parts.some(part => part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('invalid-directory');
  return path.win32.resolve(value);
}

function resolveCodexDirectory(environment = process.env) {
  if (environment.CODEX_HOME !== undefined && environment.CODEX_HOME !== '') return localDirectory(environment.CODEX_HOME);
  const profile = localDirectory(environment.USERPROFILE);
  return path.win32.join(profile, '.codex');
}

// Inspect every existing ancestor. In particular, a junction for CODEX_HOME or
// hooks.json must never redirect this deliberately narrow write elsewhere.
function safeDirectory(directory, create = false) {
  const root = path.win32.parse(directory).root;
  let current = root;
  for (const part of ['', ...directory.slice(root.length).split('\\').filter(Boolean)]) {
    if (part) current = path.win32.join(current, part);
    let info;
    try { info = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT') fail('unsafe-path');
      if (!create) return;
      try { fs.mkdirSync(current); info = fs.lstatSync(current); }
      catch { fail('write-failed'); }
    }
    if (info.isSymbolicLink() || !info.isDirectory()) fail('unsafe-path');
  }
}

function readConfig(file) {
  let link;
  try { link = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; fail('unsafe-path'); }
  if (!link.isFile() || link.isSymbolicLink() || link.nlink !== 1) fail('unsafe-path');
  if (link.size > MAX_BYTES) fail('config-too-large');
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== link.dev || opened.ino !== link.ino) fail('unsafe-path');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let used = 0, read;
    do { read = fs.readSync(descriptor, bytes, used, bytes.length - used, null); used += read; } while (read && used < bytes.length);
    if (used > MAX_BYTES) fail('config-too-large');
    const after = fs.fstatSync(descriptor);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || used !== opened.size) fail('config-changed');
    return bytes.subarray(0, used);
  } catch (error) { if (error instanceof CodexConnectionError) throw error; fail('unsafe-path'); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function decimalIdentity(token) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(token);
  if (!match) fail('invalid-config');
  const fraction = match[3] || '';
  const exponent = match[4] || '0';
  if (exponent.replace(/^[+-]?0*/, '').length > 6) fail('invalid-config');
  const digits = (match[2] + fraction).replace(/^0+/, '');
  if (!digits) return match[1] + '0';
  const trimmed = digits.replace(/0+$/, '');
  return `${match[1]}${trimmed}e${Number(exponent) - fraction.length + digits.length - trimmed.length}`;
}

// JSON.parse accepts duplicate keys and silently drops all but the last value.
// Refuse ambiguous documents instead of losing an unrelated host setting.
function parseConfig(bytes) {
  let text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail('invalid-config');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let index = 0, tokens = 0;
  function white() { while (/\s/.test(text[index] || '') && index < text.length) index++; }
  function string() {
    const start = index++;
    while (index < text.length) {
      const char = text[index++];
      if (char === '\\') index++;
      else if (char === '"') return JSON.parse(text.slice(start, index));
    }
    fail('invalid-config');
  }
  function value(depth) {
    if (depth > 32 || ++tokens > 50000) fail('invalid-config');
    white();
    if (text[index] === '"') { string(); return; }
    if (text[index] === '{') {
      index++; white(); const keys = new Set();
      if (text[index] === '}') { index++; return; }
      while (index < text.length) {
        white(); if (text[index] !== '"') fail('invalid-config');
        const key = string();
        if (keys.has(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) fail('invalid-config');
        keys.add(key); white(); if (text[index++] !== ':') fail('invalid-config');
        value(depth + 1); white(); const delimiter = text[index++];
        if (delimiter === '}') return;
        if (delimiter !== ',') fail('invalid-config');
      }
    } else if (text[index] === '[') {
      index++; white(); if (text[index] === ']') { index++; return; }
      while (index < text.length) {
        value(depth + 1); white(); const delimiter = text[index++];
        if (delimiter === ']') return;
        if (delimiter !== ',') fail('invalid-config');
      }
    } else {
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(index));
      if (!match) fail('invalid-config');
      if (/^[-\d]/.test(match[0])) {
        const numeric = Number(match[0]);
        if (!Number.isFinite(numeric) || (Number.isInteger(numeric) && !Number.isSafeInteger(numeric))
            || decimalIdentity(match[0]) !== decimalIdentity(String(numeric))) fail('invalid-config');
      }
      index += match[0].length; return;
    }
    fail('invalid-config');
  }
  try {
    value(0); white(); if (index !== text.length) fail('invalid-config');
    const parsed = JSON.parse(text);
    if (!object(parsed) || (own(parsed, 'hooks') && !object(parsed.hooks))) fail('invalid-config');
    if (parsed.hooks) for (const groups of Object.values(parsed.hooks)) {
      if (!Array.isArray(groups)) fail('invalid-config');
      for (const group of groups) if (!object(group) || !Array.isArray(group.hooks)
          || group.hooks.some(handler => !object(handler))) fail('invalid-config');
    }
    return parsed;
  } catch (error) { if (error instanceof CodexConnectionError) throw error; fail('invalid-config'); }
}

function describeHandler(handler) {
  if (!object(handler) || handler.type !== 'command' || own(handler, 'args') || own(handler, 'command_windows') || typeof handler.command !== 'string'
      || handler.command.length > 16000) return null;
  const match = /^((?:"[A-Za-z]:\/[^"\r\n]*\/powershell\.exe"|[A-Za-z]:\/[^"\r\n ]*\/powershell\.exe) -NoLogo -NoProfile -NonInteractive(?: -ExecutionPolicy Bypass)?) -Command "([^"\r\n]+)"$/.exec(handler.command);
  if (!match) return null;
  const [, prefix, script] = match;
  if (handler.commandWindows !== undefined) {
    if (typeof handler.commandWindows !== 'string') return null;
    const expected = `${prefix} -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
    if (handler.commandWindows !== expected) return null;
  }
  const bundled = /^& '([A-Za-z]:\/[^'"$`\r\n\0%!?^|<>]+)\/integrations\/activity-launch\.ps1' -Provider codex -State ([a-z]+)$/.exec(script);
  const legacy = /^& 'C:\/Program Files\/nodejs\/node\.exe' '([A-Za-z]:\/[^'"$`\r\n\0%!?^|<>]+)\/integrations\/activity\.mjs' --provider codex --state ([a-z]+) --hook$/.exec(script);
  const invocation = bundled || legacy;
  if (!invocation || !STATES.has(invocation[2])) return null;
  try { localDirectory(invocation[1]); } catch { return null; }
  return {state:invocation[2]};
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function sameMatcher(left, right) { return own(left, 'matcher') === own(right, 'matcher') && left.matcher === right.matcher; }

function mergeCodexHooks(existing, example) {
  let desired;
  try { desired = parseConfig(Buffer.from(JSON.stringify(example), 'utf8')); }
  catch { fail('invalid-example'); }
  if (!desired.hooks || Object.keys(desired).some(key => key !== 'hooks')) fail('invalid-example');
  let merged;
  try { merged = parseConfig(Buffer.from(JSON.stringify(existing), 'utf8')); }
  catch { fail('invalid-config'); }
  if (!own(merged, 'hooks')) merged.hooks = {};
  let hookCount = 0, replacedCount = 0, addedCount = 0;
  for (const [event, groups] of Object.entries(desired.hooks)) {
    if (!own(merged.hooks, event)) merged.hooks[event] = [];
    for (const generatedGroup of groups) {
      if (generatedGroup.hooks.length !== 1) fail('invalid-example');
      const generated = generatedGroup.hooks[0];
      const fixed = describeHandler(generated);
      if (!fixed) fail('invalid-example');
      hookCount++;
      let found = false;
      for (const group of merged.hooks[event]) {
        if (!sameMatcher(group, generatedGroup)) continue;
        for (let index = 0; index < group.hooks.length; index++) {
          const handler = group.hooks[index];
          if (describeHandler(handler)?.state !== fixed.state) continue;
          found = true;
          // Only executable definitions change. Preserve disabled flags,
          // timeouts, policy metadata, and all surrounding matcher groups.
          const updated = {...handler, command:generated.command, commandWindows:generated.commandWindows};
          if (!own(updated, 'timeout')) updated.timeout = generated.timeout;
          if (JSON.stringify(updated) !== JSON.stringify(handler)) replacedCount++;
          group.hooks[index] = updated;
        }
      }
      if (!found) { merged.hooks[event].push(clone(generatedGroup)); addedCount++; }
    }
  }
  if (hookCount !== 10) fail('invalid-example');
  return {configuration:merged, hookCount, replacedCount, addedCount,
    changed:JSON.stringify(merged) !== JSON.stringify(existing)};
}

function writeExclusive(file, bytes) {
  let descriptor, created = false, completed = false;
  try {
    descriptor = fs.openSync(file, 'wx', 0o600); created = true;
    fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined; completed = true;
  } finally {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
    if (created && !completed) { try { fs.unlinkSync(file); } catch {} }
  }
}

function connectCodex({example, environment = process.env} = {}) {
  const directory = resolveCodexDirectory(environment);
  const configPath = path.win32.join(directory, 'hooks.json');
  const lockPath = path.win32.join(directory, '.aipet-connect.lock');
  let locked = false, temporaryPath = null;
  try {
    safeDirectory(directory);
    const before = readConfig(configPath);
    const current = before === null ? {} : parseConfig(before);
    const merged = mergeCodexHooks(current, example);
    if (!merged.changed) return {status:'unchanged', hookCount:merged.hookCount, replacedCount:0, addedCount:0, configPath, backupPath:null};
    const bom = before?.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? '\ufeff' : '';
    const newline = before?.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
    const output = Buffer.from(bom + (JSON.stringify(merged.configuration, null, 2) + '\n').replaceAll('\n', newline), 'utf8');
    if (output.length > MAX_BYTES) fail('config-too-large');
    safeDirectory(directory, true);
    try { writeExclusive(lockPath, Buffer.from('Aipet hook registration\n')); locked = true; }
    catch (error) { if (error.code === 'EEXIST') fail('busy'); throw error; }
    safeDirectory(directory);
    const lockedCurrent = readConfig(configPath);
    if ((before === null) !== (lockedCurrent === null) || (before !== null && !before.equals(lockedCurrent))) fail('config-changed');
    const suffix = `${new Date().toISOString().replaceAll(/[-:.]/g, '')}-${randomBytes(8).toString('hex')}`;
    const backupPath = before === null ? null : path.win32.join(directory, `hooks.json.aipet-backup-${suffix}`);
    if (backupPath) writeExclusive(backupPath, before);
    temporaryPath = path.win32.join(directory, `.hooks.json.aipet-${suffix}.tmp`);
    writeExclusive(temporaryPath, output);
    safeDirectory(directory);
    const finalCurrent = readConfig(configPath);
    if ((before === null) !== (finalCurrent === null) || (before !== null && !before.equals(finalCurrent))) fail('config-changed');
    fs.renameSync(temporaryPath, configPath); temporaryPath = null;
    return {status:'connected', hookCount:merged.hookCount, replacedCount:merged.replacedCount,
      addedCount:merged.addedCount, configPath, backupPath};
  } catch (error) { if (error instanceof CodexConnectionError) throw error; fail('write-failed'); }
  finally {
    if (temporaryPath) { try { fs.unlinkSync(temporaryPath); } catch {} }
    if (locked) { try { fs.unlinkSync(lockPath); } catch {} }
  }
}

module.exports = { CodexConnectionError, resolveCodexDirectory, mergeCodexHooks, connectCodex };
