#!/usr/bin/env node
// Independent, local-only activity bridge. Do not add content fields to this protocol.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import debugLog from '../src/core/debug-log.cjs';

export const MAX_INPUT_BYTES = 64 * 1024;
export const INPUT_TIMEOUT_MS = 750;
export const PROVIDERS = Object.freeze(['claude', 'codex']);
export const STATES = Object.freeze(['thinking', 'reading', 'coding', 'tool', 'success', 'error', 'waiting', 'idle', 'offline']);

const READING_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'read_file', 'list_dir', 'list_directory', 'search_files', 'view_image']);
const CODING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
const WAITING_NOTIFICATIONS = new Set(['permission_prompt', 'idle_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input', 'quota_auto_resume_stale']);

function validTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function defaultInbox(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    // Windows Store parents can virtualize LocalAppData writes. User-profile data is shared.
    const profile = env.USERPROFILE || homedir();
    if (typeof profile !== 'string' || !path.isAbsolute(profile)) throw new Error('absolute-profile-required');
    return path.join(profile, '.aipet', 'events');
  }
  if (platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'Aipet', 'events');
  return path.join(env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'Aipet', 'events');
}

function sessionHash(provider, session) {
  // A random provider session identifier becomes a pseudonym; original IDs never leave this process.
  const id = typeof session === 'string' && session.length > 0 && session.length <= 256 ? session : 'anonymous';
  return createHash('sha256').update(`aipet-v1:${provider}:${id}`).digest('hex').slice(0, 32);
}

export function createEvent(provider, state, session, at = new Date().toISOString()) {
  if (!PROVIDERS.includes(provider) || !STATES.includes(state)) throw new Error('invalid-event');
  if (!validTimestamp(at)) throw new Error('invalid-time');
  return { version: 1, provider, state, session: sessionHash(provider, session), at };
}

export function sessionFromEnvironment(provider, env = process.env) {
  // Claude documents this exact metadata variable for hook subprocesses. Do not
  // enumerate the environment or read stdin to separate concurrent Claude chats.
  if (provider !== 'claude') return undefined;
  const session = env.CLAUDE_CODE_SESSION_ID;
  return typeof session === 'string' && session.length > 0 && session.length <= 256
    ? session : undefined;
}

export function hookEvent(provider, payload, at) {
  if (!PROVIDERS.includes(provider) || !payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  let state;
  switch (payload.hook_event_name) {
    case 'SessionStart': state = 'idle'; break;
    case 'SessionEnd': state = 'offline'; break;
    case 'UserPromptSubmit': case 'PostToolUse': case 'PreCompact': case 'PostCompact': state = 'thinking'; break;
    case 'PreToolUse': {
      const tool = typeof payload.tool_name === 'string' ? payload.tool_name.replace(/^functions\./, '') : '';
      state = READING_TOOLS.has(tool) ? 'reading' : CODING_TOOLS.has(tool) ? 'coding' : 'tool';
      break;
    }
    case 'PermissionRequest': state = 'waiting'; break;
    case 'Stop': state = 'success'; break;
    case 'PostToolUseFailure': case 'StopFailure':
      // Codex currently documents no equivalent failure-only hook. Never infer failure from result text.
      if (provider === 'claude') state = 'error';
      break;
    case 'Interrupt': if (provider === 'codex') state = 'idle'; break;
    case 'Notification':
      if (provider === 'claude' && WAITING_NOTIFICATIONS.has(payload.notification_type)) state = 'waiting';
      break;
    default: return null;
  }
  return state ? createEvent(provider, state, payload.session_id, at) : null;
}

export async function writeEvent(event, inbox = defaultInbox()) {
  // Reconstruct the allowed shape instead of serializing a caller-controlled object.
  if (!event || event.version !== 1 || !PROVIDERS.includes(event.provider) || !STATES.includes(event.state)
      || typeof event.session !== 'string' || !/^[a-f0-9]{32}$/.test(event.session) || !validTimestamp(event.at)) {
    throw new Error('invalid-event');
  }
  if (!path.isAbsolute(inbox)) throw new Error('absolute-inbox-required');
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  if ((await lstat(inbox)).isSymbolicLink()) throw new Error('symlink-inbox');
  const sanitized = { version: 1, provider: event.provider, state: event.state, session: event.session, at: event.at };
  const destination = path.join(inbox, `${sanitized.provider}-${sanitized.session}.json`);
  const temporary = path.join(inbox, `.${sanitized.provider}-${randomBytes(12).toString('hex')}.tmp`);
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(sanitized) + '\n', 'utf8');
    await file.close();
    file = null;
    await rename(temporary, destination);
  } finally {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
  return destination;
}

export function parseArguments(args) {
  const options = {};
  const keys = new Map([['--source', 'source'], ['--provider', 'provider'], ['--state', 'state'], ['--inbox', 'inbox']]);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hook') {
      if (options.hook) throw new Error('invalid-arguments');
      options.hook = true;
      continue;
    }
    const key = keys.get(args[i]);
    const value = args[++i];
    if (!key || !value || value.startsWith('--') || options[key] !== undefined) throw new Error('invalid-arguments');
    options[key] = value;
  }
  if (options.source) {
    if (!PROVIDERS.includes(options.source) || options.provider || options.state) throw new Error('invalid-source');
  } else if (!PROVIDERS.includes(options.provider) || !STATES.includes(options.state)) {
    throw new Error('invalid-state');
  }
  if (options.inbox && !path.isAbsolute(options.inbox)) throw new Error('absolute-inbox-required');
  return options;
}

export function readHookInput(input, timeoutMs = INPUT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      input.pause();
      chunks = [];
      resolve(value);
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_INPUT_BYTES) return finish(null);
      chunks.push(buffer);
    };
    const onEnd = () => {
      try { finish(JSON.parse(Buffer.concat(chunks, size).toString('utf8'))); }
      catch { finish(null); }
    };
    const onError = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    input.resume();
  });
}

export async function main(args = process.argv.slice(2)) {
  const hookMode = args.includes('--source') || args.includes('--hook');
  const at = new Date().toISOString();
  let event, inbox;
  const bounded = async (operation, milliseconds) => {
    let timer;
    try { return await Promise.race([operation, new Promise(resolve => { timer = setTimeout(() => resolve(null), milliseconds); })]); }
    finally { clearTimeout(timer); }
  };
  const recordDebug = async phase => {
    if (!event || !inbox) return;
    try {
      const directory = path.dirname(inbox);
      const control = await bounded(debugLog.readDebugControl(directory), 100);
      if (!debugLog.isDebugActive(control)) return;
      // Only an explicitly enabled capture may pseudonymize this process's cwd.
      // Never open project files or inspect a hook payload for debug correlation.
      const workspace = debugLog.workspaceScope(process.cwd());
      await bounded(debugLog.appendDebug(directory, { phase, provider: event.provider, state: event.state, eventAt: event.at, workspace }), 250);
    } catch { /* Debugging must never affect an AI hook or disclose its input. */ }
  };
  try {
    const options = parseArguments(args);
    event = options.source
      ? hookEvent(options.source, await readHookInput(process.stdin), at)
      : createEvent(options.provider, options.state, sessionFromEnvironment(options.provider), at);
    inbox = options.inbox || defaultInbox();
    if (event) {
      await recordDebug('hook-invoked');
      try {
        await writeEvent(event, inbox);
      } catch {
        await recordDebug('hook-write-failed');
        throw new Error('activity-write-failed');
      }
      await recordDebug('hook-written');
    }
    // Empty JSON is passive for both providers, including Codex's Stop event.
    if (hookMode) process.stdout.write('{}\n');
    return 0;
  } catch {
    if (hookMode) {
      // A pet must never reject a prompt, approve a tool, or fail an AI task.
      process.stdout.write('{}\n');
      return 0;
    }
    process.stderr.write('Aipet: could not write activity. Check provider, state, and inbox.\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const code = await main();
  // Explicit exit also closes unread oversized stdin without waiting for a sender.
  process.exit(code);
}
