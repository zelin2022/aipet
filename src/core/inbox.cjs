'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { validateEvent, EVENT_TTL } = require('./activity.cjs');

const EVENT_FILE = /^(claude|codex)-([a-f0-9]{16,64})\.json$/;
const MAX_FILE_BYTES = 1024;
const MAX_FILES = 128;

function signature(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function payload(event) {
  return { version: event.version, provider: event.provider, state: event.state, session: event.session, at: event.at };
}

// Never use readFile here: a file can grow after its directory/stat checks.
async function readBounded(io, filename, before, limit) {
  let file;
  try {
    file = await io.open(filename, 'r');
    const opened = await file.stat();
    if (!opened.isFile() || opened.size < 2 || opened.size > limit
        || opened.dev !== before.dev || opened.ino !== before.ino) return null;
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit || (await file.stat()).size > limit) return null;
    try { return JSON.parse(buffer.subarray(0, size).toString('utf8')); }
    catch { return null; }
  } finally { await file?.close().catch(() => {}); }
}

class InboxReader {
  constructor(directory, { io = fs, maxFiles = MAX_FILES, maxBytes = MAX_FILE_BYTES } = {}) {
    this.directory = directory;
    this.io = io;
    this.maxFiles = maxFiles;
    this.maxBytes = maxBytes;
    this.cache = new Map();
    this.polling = false;
  }

  async removeUnchanged(filename, expected) {
    try {
      const current = await this.io.lstat(filename);
      if (current.isFile() && !current.isSymbolicLink() && signature(current) === expected) {
        await this.io.unlink(filename);
        return true;
      }
    } catch { /* A concurrent atomic replacement may already have removed it. */ }
    return false;
  }

  async poll(ingest, now = Date.now()) {
    if (this.polling) return { busy: true, accepted: 0, pruned: 0 };
    this.polling = true;
    const result = { busy: false, accepted: 0, pruned: 0 };
    try {
      const directory = await this.io.lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) return result;
      const entries = await this.io.readdir(this.directory, { withFileTypes: true });
      const valid = [];
      for (const entry of entries) {
        const match = EVENT_FILE.exec(entry.name);
        if (!entry.isFile() || !match) continue;
        const filename = path.join(this.directory, entry.name);
        try {
          const stat = await this.io.lstat(filename);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > this.maxBytes) continue;
          const stamp = signature(stat);
          const cached = this.cache.get(entry.name);
          const raw = cached?.signature === stamp ? cached.event : await readBounded(this.io, filename, stat, this.maxBytes);
          // Validate old events at their own timestamp to distinguish expiry from malformed input.
          const time = typeof raw?.at === 'string' ? Date.parse(raw.at) : NaN;
          const event = Number.isFinite(time) ? validateEvent(raw, time) : null;
          if (!event || event.provider !== match[1] || event.session !== match[2]) continue;
          if (now - event.time > EVENT_TTL) {
            if (await this.removeUnchanged(filename, stamp)) result.pruned++;
          } else if (event.time <= now + 60000) {
            valid.push({ name: entry.name, filename, signature: stamp, event });
          }
        } catch { /* Malformed files and atomic replacement races never stop a poll. */ }
      }
      // Consider every candidate before retaining newest events. Directory order must not
      // permanently starve new sessions after months of ordinary use.
      valid.sort((a, b) => b.event.time - a.event.time || a.name.localeCompare(b.name));
      for (const item of valid.slice(this.maxFiles)) {
        if (await this.removeUnchanged(item.filename, item.signature)) result.pruned++;
      }
      const retained = valid.slice(0, this.maxFiles);
      this.cache = new Map(retained.map(item => [item.name, { signature: item.signature, event: payload(item.event) }]));
      for (const item of retained.reverse()) if (ingest(payload(item.event), now)) result.accepted++;
      return result;
    } catch { return result; }
    finally { this.polling = false; }
  }
}

module.exports = { InboxReader, EVENT_FILE, MAX_FILE_BYTES, MAX_FILES, readBounded };
