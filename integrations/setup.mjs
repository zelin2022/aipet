#!/usr/bin/env node
// Explicitly invoked configuration setup. Never called by the pet at startup.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import hookCommands from '../src/core/hook-commands.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER = path.join(ROOT, 'integrations', 'activity.mjs').replaceAll('\\', '/');
const PROVIDERS = ['claude', 'codex'];
const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function defaultConfigPath(provider) {
  if (!PROVIDERS.includes(provider)) throw new Error('Unknown provider.');
  return path.join(homedir(), `.${provider}`, provider === 'claude' ? 'settings.json' : 'hooks.json');
}

export function mergeHooks(config, fragment, adapter = ADAPTER, remove = false) {
  if (!object(config) || !object(fragment?.hooks) || (config.hooks !== undefined && !object(config.hooks))) throw new Error('Invalid hook configuration.');
  const normalizedAdapter = adapter.replaceAll('\\', '/');
  const key = handler => {
    if (!object(handler) || typeof handler.command !== 'string' || (handler.args !== undefined && (!Array.isArray(handler.args) || !handler.args.every(value => typeof value === 'string')))) return null;
    return JSON.stringify([handler.command.replaceAll('\\', '/'), (handler.args || []).map(value => value.replaceAll('\\', '/'))]);
  };
  const own = new Set(Object.values(fragment.hooks).flatMap(groups => groups.flatMap(group => group.hooks)).filter(handler => {
    const command = typeof handler.command === 'string' ? handler.command.replaceAll('\\', '/') : '';
    return command.includes(`'${normalizedAdapter}'`) || command.includes(`"${normalizedAdapter}"`)
      || (Array.isArray(handler.args) && handler.args.some(value => typeof value === 'string' && value.replaceAll('\\', '/') === normalizedAdapter));
  }).map(key).filter(Boolean));
  const next = structuredClone(config);
  const hooks = next.hooks || {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new Error('Invalid hook group.');
    hooks[event] = groups.flatMap(group => {
      if (!object(group) || !Array.isArray(group.hooks)) throw new Error('Invalid hook handler group.');
      // Match complete known invocations, including legacy commands without a
      // Windows override. Merely mentioning our path does not claim ownership.
      const remaining = group.hooks.filter(handler => !own.has(key(handler)));
      return remaining.length ? [{ ...group, hooks: remaining }] : [];
    });
    if (!hooks[event].length) delete hooks[event];
  }
  if (!remove) {
    for (const [event, groups] of Object.entries(fragment.hooks)) hooks[event] = [...(hooks[event] || []), ...structuredClone(groups)];
  }
  if (Object.keys(hooks).length || next.hooks !== undefined || !remove) next.hooks = hooks;
  return next;
}

export async function readPlan(provider, { configPath = defaultConfigPath(provider), remove = false } = {}) {
  if (!PROVIDERS.includes(provider) || !path.isAbsolute(configPath)) throw new Error('Invalid setup target.');
  if (/['"$`\r\n]/.test(ROOT)) throw new Error('Use a trusted installation path without shell metacharacters.');
  let original = '';
  let existed = false;
  try {
    const info = await lstat(configPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Configuration must be a regular file.');
    original = await readFile(configPath, 'utf8');
    existed = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = original.trim() ? JSON.parse(original.replace(/^\uFEFF/, '')) : {};
  const fragment = hookCommands.prepareHookExample(provider, await readFile(path.join(ROOT, 'integrations', `${provider}-hooks.example.json`), 'utf8'), ROOT);
  const next = mergeHooks(config, fragment, ADAPTER, remove);
  return {
    provider, configPath, original, originalHash: digest(original), existed, next,
    changed: JSON.stringify(config) !== JSON.stringify(next), remove,
    handlerCount: remove ? 0 : Object.values(fragment.hooks).flatMap(groups => groups.flatMap(group => group.hooks)).length,
  };
}

export async function applyPlan(plan) {
  const { configPath } = plan;
  if (!plan.changed) return { provider: plan.provider, configPath, changed: false, backupPath: null, handlerCount: plan.handlerCount };
  const current = await readFile(configPath, 'utf8').catch(error => { if (error.code === 'ENOENT' && !plan.existed) return ''; throw error; });
  if (digest(current) !== plan.originalHash) throw new Error('Configuration changed during setup; no changes applied.');
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const backupPath = plan.existed ? `${configPath}.aipet-backup-${timestamp}-${randomUUID().slice(0, 8)}` : null;
  if (backupPath) await copyFile(configPath, backupPath, constants.COPYFILE_EXCL);
  const temporary = `${configPath}.aipet-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(plan.next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const latest = await readFile(configPath, 'utf8').catch(error => { if (error.code === 'ENOENT' && !plan.existed) return ''; throw error; });
    if (digest(latest) !== plan.originalHash) throw new Error('Configuration changed during setup; no changes applied.');
    await rename(temporary, configPath);
  } finally { await unlink(temporary).catch(() => {}); }
  return { provider: plan.provider, configPath, changed: true, backupPath, handlerCount: plan.handlerCount, created: !plan.existed };
}

export async function main(args = process.argv.slice(2)) {
  const [action, provider] = args;
  if (!['plan', 'install', 'remove'].includes(action) || (provider && !PROVIDERS.includes(provider)) || args.length > 2) {
    process.stderr.write('Usage: node integrations/setup.mjs plan|install|remove [claude|codex]\n');
    return 1;
  }
  try {
    // Stage every target before applying any, so malformed configuration cannot cause a partial setup.
    const plans = await Promise.all((provider ? [provider] : PROVIDERS).map(value => readPlan(value, { remove: action === 'remove' })));
    for (const plan of plans) {
      const result = action === 'plan'
        ? { provider: plan.provider, configPath: plan.configPath, changed: plan.changed, existingFile: plan.existed, handlerCount: plan.handlerCount }
        : await applyPlan(plan);
      // Deliberately print only setup metadata, never existing settings or hook commands.
      process.stdout.write(JSON.stringify(result) + '\n');
    }
    return 0;
  } catch {
    process.stderr.write('Aipet setup stopped: configuration is invalid, changed concurrently, or could not be backed up/written. Existing configuration was not printed.\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
