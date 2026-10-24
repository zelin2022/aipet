'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const BASE_PRESENTATION_STATES = ['idle', 'thinking', 'reading', 'coding', 'tool', 'success', 'error', 'waiting', 'sleeping', 'pat', 'poke', 'hum', 'stretch', 'yawn', 'greet', 'coaxed', 'puffed', 'hairplay'];
const PRESENTATION_STATES = new Set([...BASE_PRESENTATION_STATES, 'aloof', 'wink', 'smug', 'sip']);
// A matching blink is an image resource, never a host activity or decoration state.
const GPT_REPLACEMENT_STATES = Object.freeze([...BASE_PRESENTATION_STATES, 'idle-blink']);
const CHARACTERS = new Set(['claude', 'gpt']);
const MAX_MANIFEST = 256 * 1024;
const MAX_IMAGE = 32 * 1024 * 1024;
// Thirteen Claude additions plus the complete 38-image GPT costume need more than
// the former 64 MiB limit. Keep one fixed aggregate bound, including documents.
const MAX_TOTAL = 128 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function safeRelative(relative) {
  if (typeof relative !== 'string' || relative.length > 180 || !/^(claude|gpt)\/[a-zA-Z0-9_-]+\.(png|provenance\.json|prompt\.txt|md)$/.test(relative)) throw new Error('Invalid custom artwork path.');
  const name = path.posix.basename(relative).split('.')[0];
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) throw new Error('Reserved custom artwork path.');
  return relative;
}

function regularFile(directory, relative, maximum, io = fs) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_IMAGE) throw new Error('Invalid custom artwork byte limit.');
  const root = path.resolve(directory);
  const full = path.resolve(root, ...relative.split('/'));
  if (path.relative(root, full).startsWith('..') || path.isAbsolute(path.relative(root, full))) throw new Error('Custom artwork path escapes its directory.');
  // Reject links in the complete path, including an assets directory redirected by a junction.
  const ancestry = [];
  for (let current = path.dirname(full); ; current = path.dirname(current)) {
    ancestry.push(current);
    if (path.dirname(current) === current) break;
  }
  for (const current of ancestry.reverse()) {
    const entry = io.lstatSync(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Custom artwork directory is not a regular local directory.');
  }
  const entry = io.lstatSync(full);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maximum || entry.size < 1) throw new Error('Custom artwork file is not a bounded regular file.');
  const stamp = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  let handle;
  try {
    handle = io.openSync(full, 'r');
    const opened = io.fstatSync(handle);
    if (!opened.isFile() || stamp(opened) !== stamp(entry)) throw new Error('Custom artwork file changed before reading.');
    // The allocation and all reads stay bounded even when another process grows the file.
    // One extra byte detects growth without retaining the growing remainder.
    const buffer = Buffer.alloc(entry.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = io.readSync(handle, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = io.fstatSync(handle), current = io.lstatSync(full);
    if (length !== entry.size || length > maximum || !current.isFile() || current.isSymbolicLink() || stamp(after) !== stamp(entry) || stamp(current) !== stamp(entry)) throw new Error('Custom artwork file changed while reading.');
    return buffer.subarray(0, length);
  } finally {
    if (handle !== undefined) io.closeSync(handle);
  }
}

function pngSize(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Custom artwork must be a PNG with an IHDR header.');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 64 || height < 64 || width > 8192 || height > 8192 || width * height > 16 * 1024 * 1024 || ![4, 6].includes(bytes[25]) || ![8, 16].includes(bytes[24])) throw new Error('Custom artwork needs bounded dimensions and a native alpha channel.');
  return { width, height };
}

function relatedPath(image, value) {
  if (typeof value !== 'string') throw new Error('Missing custom artwork document path.');
  // Provenance stores filenames relative to itself; manifest paths are relative to assets/custom.
  return safeRelative(`${path.posix.dirname(image)}/${value}`);
}

function framing(value, dimensions) {
  const keys = ['x', 'y', 'width', 'height', 'canvasWidth', 'canvasHeight'];
  if (!value || Object.keys(value).sort().join(',') !== [...keys].sort().join(',') || !keys.every(key => Number.isSafeInteger(value[key]))
    || value.x < 0 || value.y < 0 || value.width < 1 || value.height < 1
    || value.canvasWidth !== dimensions.width || value.canvasHeight !== dimensions.height
    || value.x + value.width > dimensions.width || value.y + value.height > dimensions.height) throw new Error('Invalid custom artwork framing.');
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

function readCustomArtwork(directory, { strict = false, verifyInventory = false, manifestBytes } = {}) {
  const empty = { customPoses: { claude: {}, gpt: {} }, customModes: { claude: 'append', gpt: 'append' }, customBlink: {}, customFraming: { claude: {}, gpt: {} }, images: [], imagePins: [], files: [], posesVerified: 0, errors: [] };
  const fail = error => {
    if (strict) throw error;
    empty.errors.push(error.message);
  };
  let manifest, files;
  try {
    if (manifestBytes !== undefined && (!Buffer.isBuffer(manifestBytes) || manifestBytes.length < 1 || manifestBytes.length > MAX_MANIFEST)) throw new Error('Invalid candidate custom artwork manifest.');
    manifest = JSON.parse((manifestBytes || regularFile(directory, 'manifest.json', MAX_MANIFEST)).toString('utf8'));
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.poses) || !Array.isArray(manifest.files) || manifest.poses.length > 64 || manifest.files.length > 256) throw new Error('Invalid custom artwork manifest.');
    if (manifest.profiles !== undefined && (!manifest.profiles || Array.isArray(manifest.profiles) || typeof manifest.profiles !== 'object'
      || Object.keys(manifest.profiles).some(key => key !== 'gpt')
      || (manifest.profiles.gpt !== undefined && (!manifest.profiles.gpt || Object.keys(manifest.profiles.gpt).join(',') !== 'mode' || manifest.profiles.gpt.mode !== 'replace')))) throw new Error('Invalid custom artwork replacement profile.');
    files = new Map();
    for (const file of manifest.files) {
      safeRelative(file.path);
      if (files.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > (file.path.endsWith('.png') ? MAX_IMAGE : MAX_MANIFEST) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid custom artwork file pin.');
      files.set(file.path, file);
    }
    if ([...files.values()].reduce((total, file) => total + file.bytes, 0) > MAX_TOTAL) throw new Error('Custom artwork exceeds the total byte budget.');
  } catch (error) { fail(error); return empty; }
  const verified = new Map(), used = new Set(), poseKeys = new Set();
  function pinned(relative) {
    safeRelative(relative);
    const pin = files.get(relative);
    if (!pin) throw new Error(`Unpinned custom artwork file: ${relative}`);
    if (!verified.has(relative)) {
      const bytes = regularFile(directory, relative, relative.endsWith('.png') ? MAX_IMAGE : MAX_MANIFEST);
      if (bytes.length !== pin.bytes || digest(bytes) !== pin.sha256) throw new Error(`Custom artwork hash mismatch: ${relative}`);
      verified.set(relative, bytes);
    }
    used.add(relative);
    return verified.get(relative);
  }
  for (const pose of manifest.poses) {
    try {
      if (!pose || !CHARACTERS.has(pose.character) || (!PRESENTATION_STATES.has(pose.state) && !(pose.character === 'gpt' && pose.state === 'idle-blink')) || typeof pose.image !== 'string' || !pose.image.startsWith(`${pose.character}/`) || !pose.image.endsWith('.png')) throw new Error('Unknown custom artwork character or presentation state.');
      if (pose.aliases !== undefined && (!Array.isArray(pose.aliases) || pose.aliases.length < 1 || pose.aliases.length > 4 || pose.state === 'idle-blink'
        || new Set(pose.aliases).size !== pose.aliases.length || pose.aliases.some(state => state === pose.state || !PRESENTATION_STATES.has(state)))) throw new Error('Invalid custom artwork presentation aliases.');
      const states = [pose.state, ...(pose.aliases || [])];
      for (const state of states) {
        const key = `${pose.character}/${state}/${pose.image}`;
        if (poseKeys.has(key)) throw new Error('Duplicate custom artwork pose.');
        poseKeys.add(key);
      }
      const image = pinned(pose.image), dimensions = pngSize(image);
      if (pose.width !== dimensions.width || pose.height !== dimensions.height) throw new Error(`Custom artwork dimensions differ: ${pose.image}`);
      if (!pose.provenance.endsWith('.json') || !pose.prompt.endsWith('.txt') || !pose.attribution.endsWith('.md')) throw new Error('Invalid custom artwork document types.');
      const provenance = JSON.parse(pinned(pose.provenance).toString('utf8'));
      pinned(pose.prompt); pinned(pose.attribution);
      if (provenance.schemaVersion !== 1 || provenance.output?.path !== `assets/custom/${pose.image}` || provenance.output.sha256 !== digest(image) || provenance.output.bytes !== image.length || provenance.output.width !== dimensions.width || provenance.output.height !== dimensions.height || provenance.output.format !== 'PNG' || provenance.output.alphaPreserved !== true || provenance.transparentBackgroundRequested !== true || relatedPath(pose.image, provenance.prompt) !== pose.prompt || relatedPath(pose.image, provenance.attribution) !== pose.attribution || typeof provenance.sourceArtworkLicense !== 'string' || typeof provenance.adaptationTerms !== 'string') throw new Error(`Custom artwork provenance differs: ${pose.image}`);
      if (pose.framing !== undefined || pose.character === 'gpt') {
        const bounds = framing(pose.framing, dimensions);
        if (JSON.stringify(bounds) !== JSON.stringify(framing(provenance.output.framing, dimensions))) throw new Error(`Custom artwork framing provenance differs: ${pose.image}`);
        empty.customFraming[pose.character][pose.image] = bounds;
      }
      if (pose.state === 'idle-blink') {
        if (empty.customBlink[pose.character]) throw new Error('Duplicate custom artwork blink image.');
        empty.customBlink[pose.character] = pose.image;
      } else for (const state of states) (empty.customPoses[pose.character][state] ||= []).push(pose.image);
      empty.images.push(path.resolve(directory, ...pose.image.split('/')));
      empty.posesVerified++;
    } catch (error) { fail(error); }
  }
  try {
    if (used.size !== files.size) throw new Error('Custom artwork manifest contains unused file pins.');
    if (verifyInventory) {
      const expected = new Set(['manifest.json', ...files.keys()]);
      function visit(relative = '') {
        const here = path.join(directory, ...relative.split('/'));
        for (const entry of fs.readdirSync(here, { withFileTypes: true })) {
          const child = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory() && !relative && CHARACTERS.has(entry.name)) visit(child);
          else if (!entry.isFile() || entry.isSymbolicLink() || !expected.delete(child)) throw new Error(`Unexpected custom artwork file: ${child}`);
        }
      }
      visit();
      if (expected.size) throw new Error('Custom artwork files are missing.');
    }
  } catch (error) { fail(error); }
  // A costume is atomic: no work, interaction, idle or blink pose may fall back
  // into a different outfit. Partly copied or damaged profiles keep the complete
  // imported GPT set; valid independent Claude additions remain available.
  const gptPoses = Object.keys(empty.customPoses.gpt).length || empty.customBlink.gpt;
  if (manifest.profiles?.gpt || gptPoses) {
    const complete = manifest.profiles?.gpt?.mode === 'replace' && empty.errors.length === 0
      && GPT_REPLACEMENT_STATES.every(state => state === 'idle-blink' ? Boolean(empty.customBlink.gpt) : empty.customPoses.gpt[state]?.length);
    if (complete) empty.customModes.gpt = 'replace';
    else {
      fail(new Error('Incomplete or invalid GPT replacement artwork; using the original GPT set.'));
      empty.posesVerified -= empty.images.filter(image => path.relative(directory, image).split(path.sep)[0] === 'gpt').length;
      empty.images = empty.images.filter(image => path.relative(directory, image).split(path.sep)[0] !== 'gpt');
      empty.customPoses.gpt = {};
      empty.customFraming.gpt = {};
      delete empty.customBlink.gpt;
    }
  }
  empty.files = ['manifest.json', ...files.keys()];
  // Reuse this validated inventory for local counters without rereading a possibly
  // damaged or replaced manifest and defeating the original-art fallback.
  empty.imagePins = empty.images.map(image => ({ ...files.get(path.relative(directory, image).split(path.sep).join('/')) }));
  return empty;
}

module.exports = { PRESENTATION_STATES, GPT_REPLACEMENT_STATES, readCustomArtwork, pngSize, safeRelative, regularFile };
