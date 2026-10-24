'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { PRESENTATION_STATES, GPT_REPLACEMENT_STATES, readCustomArtwork, pngSize, safeRelative, regularFile } = require('../src/core/artwork.cjs');
const source = path.resolve(__dirname, '../assets/custom/claude/wave-v1.png');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-artwork-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'claude'));
  const image = fs.readFileSync(source), dimensions = pngSize(image);
  const metadata = {
    schemaVersion: 1,
    output: { path: 'assets/custom/claude/pose.png', sha256: hash(image), bytes: image.length, ...dimensions, format: 'PNG', alphaPreserved: true },
    transparentBackgroundRequested: true, prompt: 'pose.prompt.txt', attribution: 'ATTRIBUTION.md',
    sourceArtworkLicense: 'CC BY-NC-SA 4.0', adaptationTerms: 'CC BY-NC-SA 4.0',
  };
  fs.writeFileSync(path.join(directory, 'claude/pose.png'), image);
  fs.writeFileSync(path.join(directory, 'claude/pose.provenance.json'), JSON.stringify(metadata));
  fs.writeFileSync(path.join(directory, 'claude/pose.prompt.txt'), 'Draw the approved character in a new pose.');
  fs.writeFileSync(path.join(directory, 'claude/ATTRIBUTION.md'), 'Preserve source attribution and rights caveat.');
  const pose = { character: 'claude', state: 'thinking', image: 'claude/pose.png', provenance: 'claude/pose.provenance.json', prompt: 'claude/pose.prompt.txt', attribution: 'claude/ATTRIBUTION.md', ...dimensions };
  const manifest = { schemaVersion: 1, poses: [pose], files: [] };
  function update() {
    manifest.files = ['pose.png', 'pose.provenance.json', 'pose.prompt.txt', 'ATTRIBUTION.md'].map(name => {
      const relative = `claude/${name}`, bytes = fs.readFileSync(path.join(directory, relative));
      return { path: relative, bytes: bytes.length, sha256: hash(bytes) };
    });
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  }
  update();
  return { directory, manifest, pose, metadata, update };
}

function addGptProfile(data) {
  fs.mkdirSync(path.join(data.directory, 'gpt'));
  const image = fs.readFileSync(source), dimensions = pngSize(image);
  const framing = { x: 12, y: 10, width: dimensions.width - 24, height: dimensions.height - 20, canvasWidth: dimensions.width, canvasHeight: dimensions.height };
  const metadata = { ...data.metadata, output: { ...data.metadata.output, path: 'assets/custom/gpt/pose.png', framing } };
  fs.writeFileSync(path.join(data.directory, 'gpt/pose.png'), image);
  fs.writeFileSync(path.join(data.directory, 'gpt/pose.provenance.json'), JSON.stringify(metadata));
  fs.writeFileSync(path.join(data.directory, 'gpt/pose.prompt.txt'), 'Redesign this pose with the approved silver and violet costume.');
  fs.writeFileSync(path.join(data.directory, 'gpt/ATTRIBUTION.md'), 'Preserve source attribution and rights caveat.');
  const poses = GPT_REPLACEMENT_STATES.map(state => ({ character: 'gpt', state, image: 'gpt/pose.png', provenance: 'gpt/pose.provenance.json', prompt: 'gpt/pose.prompt.txt', attribution: 'gpt/ATTRIBUTION.md', ...dimensions, framing: { ...framing } }));
  data.manifest.poses.push(...poses);
  data.manifest.profiles = { gpt: { mode: 'replace' } };
  const update = () => {
    data.update();
    for (const name of ['pose.png', 'pose.provenance.json', 'pose.prompt.txt', 'ATTRIBUTION.md']) {
      const relative = `gpt/${name}`, bytes = fs.readFileSync(path.join(data.directory, relative));
      data.manifest.files.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
    }
    fs.writeFileSync(path.join(data.directory, 'manifest.json'), JSON.stringify(data.manifest));
  };
  update();
  return { poses, metadata, framing, update };
}

test('custom artwork supplies validated local pose pools and an explicit package inventory', t => {
  const { directory } = fixture(t);
  const result = readCustomArtwork(directory, { strict: true, verifyInventory: true });
  assert.deepEqual(result.customPoses, { claude: { thinking: ['claude/pose.png'] }, gpt: {} });
  assert.equal(result.posesVerified, 1);
  assert.equal(result.files.length, 5);
  assert.deepEqual(result.images, [path.join(directory, 'claude/pose.png')]);
  assert.deepEqual(result.imagePins, [{ path: 'claude/pose.png', bytes: fs.statSync(source).size, sha256: hash(fs.readFileSync(source)) }]);
  assert.deepEqual(result.errors, []);
});

test('missing or tampered custom files fall back without affecting original artwork', t => {
  const { directory } = fixture(t);
  fs.appendFileSync(path.join(directory, 'claude/pose.png'), 'changed');
  const result = readCustomArtwork(directory);
  assert.equal(result.posesVerified, 0);
  assert.deepEqual(result.customPoses.claude, {});
  assert.deepEqual(result.images, []);
  assert.deepEqual(result.imagePins, []);
  assert.ok(result.errors.some(message => message.includes('hash mismatch')));
  assert.throws(() => readCustomArtwork(directory, { strict: true }), /hash mismatch/);
  fs.unlinkSync(path.join(directory, 'manifest.json'));
  assert.equal(readCustomArtwork(directory).posesVerified, 0);
  assert.deepEqual(readCustomArtwork(directory).imagePins, []);
});

test('image metadata and pinned documents must agree with the actual PNG', t => {
  const data = fixture(t);
  data.metadata.output.width++;
  fs.writeFileSync(path.join(data.directory, 'claude/pose.provenance.json'), JSON.stringify(data.metadata));
  data.update();
  assert.throws(() => readCustomArtwork(data.directory, { strict: true }), /provenance differs/);
  data.metadata.output.width--;
  data.metadata.prompt = '../outside.txt';
  fs.writeFileSync(path.join(data.directory, 'claude/pose.provenance.json'), JSON.stringify(data.metadata));
  data.update();
  assert.throws(() => readCustomArtwork(data.directory, { strict: true }), /Invalid custom artwork path/);
});

test('unknown characters, behavior states and remote or escaping paths never reach the renderer', t => {
  const data = fixture(t);
  for (const [key, value] of [['character', 'other'], ['state', 'execute'], ['image', 'https://example.com/pose.png'], ['image', 'claude/../private.png']]) {
    const previous = data.pose[key];
    data.pose[key] = value;
    data.update();
    assert.equal(readCustomArtwork(data.directory).images.length, 0);
    data.pose[key] = previous;
  }
  for (const value of ['../outside.png', 'claude/../../secret.png', 'C:/private.png', 'claude\\pose.png', 'claude/CON.png', 'claude/pose.png:secret']) assert.throws(() => safeRelative(value));
});

test('strict packaging verification refuses extra files and unpinned documents', t => {
  const data = fixture(t);
  fs.writeFileSync(path.join(data.directory, 'claude/unreviewed.png'), fs.readFileSync(source));
  assert.throws(() => readCustomArtwork(data.directory, { strict: true, verifyInventory: true }), /Unexpected custom artwork file/);
  fs.unlinkSync(path.join(data.directory, 'claude/unreviewed.png'));
  data.manifest.files = data.manifest.files.filter(file => !file.path.endsWith('.prompt.txt'));
  fs.writeFileSync(path.join(data.directory, 'manifest.json'), JSON.stringify(data.manifest));
  assert.throws(() => readCustomArtwork(data.directory, { strict: true }), /Unpinned custom artwork file/);
});

test('the complete custom set has a fixed byte budget before artwork buffers are read', t => {
  const data = fixture(t);
  data.manifest.files = Array.from({ length: 5 }, (_, index) => ({ path: `claude/large-${index}.png`, bytes: 32 * 1024 * 1024, sha256: 'a'.repeat(64) }));
  fs.writeFileSync(path.join(data.directory, 'manifest.json'), JSON.stringify(data.manifest));
  assert.throws(() => readCustomArtwork(data.directory, { strict: true }), /total byte budget/);
});

test('a complete GPT replacement exports all pools, matching blink and bounded framing without changing Claude append mode', t => {
  const data = fixture(t), gpt = addGptProfile(data);
  const result = readCustomArtwork(data.directory, { strict: true, verifyInventory: true });
  assert.equal(result.customModes.gpt, 'replace');
  assert.equal(result.customModes.claude, 'append');
  assert.deepEqual(Object.keys(result.customPoses.gpt), GPT_REPLACEMENT_STATES.filter(state => state !== 'idle-blink'));
  assert.equal(result.customBlink.gpt, 'gpt/pose.png');
  assert.deepEqual(result.customFraming.gpt['gpt/pose.png'], gpt.framing);
  assert.equal(result.posesVerified, GPT_REPLACEMENT_STATES.length + 1);
  assert.equal(result.customPoses.gpt['idle-blink'], undefined);
  assert.equal(PRESENTATION_STATES.has('idle-blink'), false, 'Blink resources are never activity or decoration states.');
  assert.deepEqual(result.customPoses.claude, { thinking: ['claude/pose.png'] });
});

test('optional social artwork can join a complete GPT costume without expanding required base states', t => {
  const data = fixture(t), gpt = addGptProfile(data);
  const basePoses = [...data.manifest.poses];
  for (const state of ['aloof', 'wink', 'smug', 'sip']) {
    assert.equal(PRESENTATION_STATES.has(state), true);
    assert.equal(GPT_REPLACEMENT_STATES.includes(state), false);
    data.manifest.poses.push({ ...gpt.poses[0], state });
  }
  gpt.update();
  const complete = readCustomArtwork(data.directory, { strict: true, verifyInventory: true });
  assert.equal(complete.customModes.gpt, 'replace');
  for (const state of ['aloof', 'wink', 'smug', 'sip']) assert.deepEqual(complete.customPoses.gpt[state], ['gpt/pose.png']);
  data.manifest.poses = basePoses;
  gpt.update();
  const withoutOptional = readCustomArtwork(data.directory, { strict: true, verifyInventory: true });
  assert.equal(withoutOptional.customModes.gpt, 'replace');
  for (const state of ['aloof', 'wink', 'smug', 'sip']) assert.equal(withoutOptional.customPoses.gpt[state], undefined);
});

test('a bounded presentation alias reuses one pinned image without duplicating artwork inventory', t => {
  const data = fixture(t), gpt = addGptProfile(data);
  const greeting = gpt.poses.find(pose => pose.state === 'greet');
  greeting.aliases = ['wink'];
  gpt.update();
  const result = readCustomArtwork(data.directory, { strict: true, verifyInventory: true });
  assert.deepEqual(result.customPoses.gpt.wink, result.customPoses.gpt.greet);
  assert.equal(result.posesVerified, GPT_REPLACEMENT_STATES.length + 1);
  assert.equal(result.images.length, GPT_REPLACEMENT_STATES.length + 1);
  assert.equal(result.customModes.gpt, 'replace');
  for (const aliases of [[], 'wink', ['wink', 'wink'], ['greet'], ['idle-blink'], ['execute'], ['wink', 'smug', 'sip', 'aloof', 'hum']]) {
    greeting.aliases = aliases;
    gpt.update();
    assert.throws(() => readCustomArtwork(data.directory, { strict: true }), /presentation aliases/);
  }
  delete greeting.aliases;
  const blink = gpt.poses.find(pose => pose.state === 'idle-blink');
  blink.aliases = ['wink'];
  gpt.update();
  assert.throws(() => readCustomArtwork(data.directory, { strict: true }), /presentation aliases/);
  delete blink.aliases;
  greeting.aliases = ['idle'];
  gpt.update();
  assert.throws(() => readCustomArtwork(data.directory, { strict: true }), /Duplicate custom artwork pose/);
});

test('missing GPT states or its matching blink disable the whole replacement while retaining valid Claude additions', t => {
  const data = fixture(t);
  addGptProfile(data);
  const complete = [...data.manifest.poses];
  for (const state of ['puffed', 'idle-blink']) {
    data.manifest.poses = complete.filter(pose => pose.character !== 'gpt' || pose.state !== state);
    fs.writeFileSync(path.join(data.directory, 'manifest.json'), JSON.stringify(data.manifest));
    const result = readCustomArtwork(data.directory);
    assert.equal(result.customModes.gpt, 'append');
    assert.deepEqual(result.customPoses.gpt, {});
    assert.deepEqual(result.customFraming.gpt, {});
    assert.equal(result.customBlink.gpt, undefined);
    assert.equal(result.posesVerified, 1);
    assert.deepEqual(result.images, [path.join(data.directory, 'claude/pose.png')]);
    assert.deepEqual(result.customPoses.claude, { thinking: ['claude/pose.png'] });
    assert.throws(() => readCustomArtwork(data.directory, { strict: true }), /Incomplete or invalid GPT replacement/);
  }
});

test('tampered GPT documents cannot leave a partially mixed costume active', t => {
  const data = fixture(t);
  addGptProfile(data);
  fs.appendFileSync(path.join(data.directory, 'gpt/pose.prompt.txt'), 'tampered');
  const result = readCustomArtwork(data.directory);
  assert.deepEqual(result.customPoses.gpt, {});
  assert.equal(result.customModes.gpt, 'append');
  assert.equal(result.customBlink.gpt, undefined);
  assert.equal(result.images.length, 1);
  assert.ok(result.errors.some(message => message.includes('hash mismatch')));
  assert.deepEqual(result.customPoses.claude, { thinking: ['claude/pose.png'] });
});

test('GPT additions require explicit replacement activation and known profile metadata', t => {
  const data = fixture(t);
  addGptProfile(data);
  delete data.manifest.profiles;
  fs.writeFileSync(path.join(data.directory, 'manifest.json'), JSON.stringify(data.manifest));
  assert.deepEqual(readCustomArtwork(data.directory).customPoses.gpt, {});
  assert.throws(() => readCustomArtwork(data.directory, { strict: true }), /Incomplete or invalid GPT replacement/);
  for (const profiles of [{ gpt: { mode: 'append' } }, { claude: { mode: 'replace' } }, { gpt: { mode: 'replace', command: 'no' } }]) {
    data.manifest.profiles = profiles;
    fs.writeFileSync(path.join(data.directory, 'manifest.json'), JSON.stringify(data.manifest));
    assert.throws(() => readCustomArtwork(data.directory, { strict: true }), /replacement profile/);
  }
});

test('GPT framing must be integer, local to the PNG canvas and pinned in its provenance', t => {
  const data = fixture(t), gpt = addGptProfile(data);
  for (const value of [{ ...gpt.framing, x: -1 }, { ...gpt.framing, width: 0 }, { ...gpt.framing, height: 1.5 }, { ...gpt.framing, canvasWidth: 1 }, { ...gpt.framing, width: gpt.framing.canvasWidth }, { ...gpt.framing, url: 'https://example.com/' }]) {
    gpt.poses[0].framing = value;
    fs.writeFileSync(path.join(data.directory, 'manifest.json'), JSON.stringify(data.manifest));
    assert.throws(() => readCustomArtwork(data.directory, { strict: true }), /framing/);
  }
  gpt.poses[0].framing = { ...gpt.framing, x: gpt.framing.x + 1, width: gpt.framing.width - 1 };
  fs.writeFileSync(path.join(data.directory, 'manifest.json'), JSON.stringify(data.manifest));
  assert.throws(() => readCustomArtwork(data.directory, { strict: true }), /framing provenance differs/);
});

test('authoring can validate a bounded candidate before replacing the active manifest', t => {
  const data = fixture(t), before = fs.readFileSync(path.join(data.directory, 'manifest.json'));
  const candidate = Buffer.from(JSON.stringify({ ...data.manifest, profiles: { gpt: { mode: 'replace' } } }));
  assert.throws(() => readCustomArtwork(data.directory, { strict: true, manifestBytes: candidate }), /Incomplete or invalid GPT replacement/);
  assert.deepEqual(fs.readFileSync(path.join(data.directory, 'manifest.json')), before);
  assert.throws(() => readCustomArtwork(data.directory, { strict: true, manifestBytes: Buffer.alloc(256 * 1024 + 1) }), /candidate custom artwork manifest/);
});

test('a concurrently growing artwork file is rejected with bounded reads and no readFile allocation', t => {
  const data = fixture(t);
  const filename = path.join(data.directory, 'claude/growing.prompt.txt');
  fs.writeFileSync(filename, 'small');
  let reads = 0, largestBuffer = 0;
  const io = {
    ...fs,
    readFileSync() { throw new Error('Unbounded file read attempted.'); },
    readSync(handle, buffer, offset, length, position) {
      largestBuffer = Math.max(largestBuffer, buffer.length);
      if (++reads === 1) fs.truncateSync(filename, 8 * 1024 * 1024);
      return fs.readSync(handle, buffer, offset, length, position);
    },
  };
  assert.throws(() => regularFile(data.directory, 'claude/growing.prompt.txt', 64, io), /changed while reading/);
  assert.ok(reads > 0 && largestBuffer <= 65, 'File growth cannot expand the configured allocation limit.');
  assert.equal(fs.statSync(filename).size, 8 * 1024 * 1024);
});

test('directory junctions cannot redirect artwork reads outside the asset root', t => {
  const data = fixture(t);
  const redirected = path.join(data.directory, 'claude-real');
  fs.renameSync(path.join(data.directory, 'claude'), redirected);
  try { fs.symlinkSync(redirected, path.join(data.directory, 'claude'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (error.code === 'EPERM') { t.skip('Host does not permit symlink creation.'); return; }
    throw error;
  }
  assert.throws(() => readCustomArtwork(data.directory, { strict: true }), /regular local directory/);
});

test('PNG headers must have bounded dimensions and native transparency', () => {
  const original = fs.readFileSync(source);
  assert.ok(pngSize(original).height > 64);
  assert.throws(() => pngSize(Buffer.from('not an image')), /PNG/);
  const oversized = Buffer.from(original);
  oversized.writeUInt32BE(100000, 16);
  assert.throws(() => pngSize(oversized), /bounded dimensions/);
  const opaque = Buffer.from(original);
  opaque[25] = 2;
  assert.throws(() => pngSize(opaque), /alpha channel/);
});
