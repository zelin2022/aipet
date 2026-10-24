'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { candidates, createController } = require('../renderer/pose-selector.js');
const characters = require('../assets/crosspet/manifest.json').characters;
const claude = characters.find(character => character.id === 'claude');
const gpt = characters.find(character => character.id === 'gpt');
const noWelcome = { allowWelcome: false };

test('complete replacement profiles use only the approved style in every state and fallback', () => {
  const { poses } = require('../renderer/pose-selector.js');
  const custom = { ...gpt, customMode: 'replace', customPoses: Object.fromEntries(Object.keys(poses).map(state => [state, [`gpt/${state}-violet.png`]])) };
  for (const state of Object.keys(poses)) assert.deepEqual(candidates(custom, state), [`../assets/custom/gpt/${state}-violet.png`]);
  assert.deepEqual(candidates(custom, 'unknown'), ['../assets/custom/gpt/idle-violet.png']);
  assert.deepEqual(candidates({ ...custom, customPoses: { idle: ['gpt/idle-violet.png'], thinking: ['../outside.png', 'https://bad/remote.png'] } }, 'thinking'), ['../assets/custom/gpt/idle-violet.png']);
  assert.deepEqual(candidates({ ...custom, customPoses: {} }, 'thinking'), []);
  assert.ok(candidates({ ...custom, customMode: 'append' }, 'thinking').some(value => value.includes('/crosspet/')));
});

test('pools retain original aliases and variants, add only available expressions and safe custom art', () => {
  assert.equal(candidates(claude, 'thinking').length, 2);
  assert.equal(candidates(claude, 'idle').length, 3);
  assert.equal(candidates(claude, 'pat').length, 2);
  assert.ok(candidates(claude, 'waiting').some(path => path.endsWith('/listening.webp')));
  assert.equal(candidates(claude, 'hairplay', false).length, 0);
  assert.deepEqual(candidates(claude, 'smug', false), ['../assets/crosspet/' + claude.poses.proud]);
  const custom = { ...claude, customPoses: { thinking: ['claude/thinking-v1.png', '../secrets.png', 'C:/outside.png', 'https://bad/image.png'] } };
  assert.equal(candidates(custom, 'thinking').length, 3);
  assert.ok(candidates(custom, 'thinking').includes('../assets/custom/claude/thinking-v1.png'));
  assert.deepEqual(candidates(claude, 'unknown'), candidates(claude, 'idle'));
});

test('identical snapshots stay stable; state re-entry and slow rotation avoid immediate pose repeats', () => {
  let time = 0;
  const controller = createController({ ...noWelcome, now: () => time, random: () => 0 });
  const initial = controller.update('claude', claude, 'thinking');
  for (time = 1; time < 17000; time += 1000) assert.deepEqual(controller.update('claude', claude, 'thinking'), initial);
  time = 19000;
  const rotated = controller.update('claude', claude, 'thinking');
  assert.notEqual(rotated.path, initial.path);
  controller.update('claude', claude, 'coding');
  assert.notEqual(controller.update('claude', claude, 'thinking').path, rotated.path);
});

test('reading, coding and tools use every available pose without changing the activity state', () => {
  for (const state of ['reading', 'coding', 'tool']) {
    let time = 0, sample = 0;
    const character = { ...claude, customPoses: { [state]: [`claude/${state}-a.png`, `claude/${state}-b.png`] } };
    const pool = candidates(character, state);
    assert.equal(pool.length, 3);
    const controller = createController({ ...noWelcome, now: () => time, random: () => sample });
    const seen = [];
    for (let index = 0; index < 3; index++) {
      time = index * 26000;
      sample = index ? 0.9 : 0;
      const pose = controller.update('claude', character, state);
      assert.equal(pose.state, state);
      assert.ok(pool.includes(pose.path));
      if (seen.length) assert.notEqual(pose.path, seen.at(-1));
      seen.push(pose.path);
      time += 1000;
      assert.deepEqual(controller.update('claude', character, state), pose);
    }
    assert.deepEqual(new Set(seen), new Set(pool));
  }
});

test('busy pose holds last 18–26 seconds and gentler motion keeps sustained work stable', () => {
  for (const state of ['reading', 'coding', 'tool']) {
    const character = { ...claude, customPoses: { [state]: [`claude/${state}-a.png`, `claude/${state}-b.png`] } };
    for (const [sample, duration] of [[0, 18000], [1, 26000]]) {
      let time = 0;
      const controller = createController({ ...noWelcome, now: () => time, random: () => sample });
      const initial = controller.update('claude', character, state);
      time = duration - 1;
      assert.deepEqual(controller.update('claude', character, state), initial);
      time = duration;
      const rotated = controller.update('claude', character, state);
      assert.equal(rotated.state, state);
      assert.notEqual(rotated.path, initial.path);
      time += 100000;
      assert.deepEqual(controller.update('claude', character, state, { reducedMotion: true }), rotated);
      assert.equal(controller.update('claude', character, 'success', { reducedMotion: true }).state, 'success');
    }
  }
});

test('busy pose rotation deadlines remain independent for each provider', () => {
  let time = 0;
  const controller = createController({ ...noWelcome, now: () => time, random: () => 0 });
  const character = { ...claude, customPoses: { reading: ['claude/reading-extra.png'] } };
  const secondCharacter = { ...gpt, customPoses: { thinking: ['gpt/thinking-extra.png'] } };
  const first = controller.update('claude', character, 'reading');
  time = 10000;
  const second = controller.update('codex', secondCharacter, 'thinking');
  time = 18000;
  assert.notEqual(controller.update('claude', character, 'reading').path, first.path);
  assert.deepEqual(controller.update('codex', secondCharacter, 'thinking'), second);
  time = 28000;
  assert.notEqual(controller.update('codex', secondCharacter, 'thinking').path, second.path);
});

test('selection history and interactions remain independent across providers', () => {
  let time = 0;
  const controller = createController({ ...noWelcome, now: () => time, random: () => 0 });
  const first = controller.update('codex', gpt, 'thinking');
  controller.update('claude', claude, 'idle');
  controller.interact('claude', 'pat');
  assert.equal(controller.update('claude', claude, 'idle').state, 'pat');
  time = 2000;
  assert.deepEqual(controller.update('codex', gpt, 'thinking'), first);
  assert.equal(controller.update('claude', claude, 'coding').state, 'pat');
  time = 3100;
  assert.equal(controller.update('claude', claude, 'tool').state, 'tool');
});

test('petting returns to latest activity and new critical signals interrupt it immediately', () => {
  for (const state of ['success', 'error', 'waiting']) {
    let time = 0;
    const controller = createController({ ...noWelcome, now: () => time, random: () => 0 });
    controller.update('claude', claude, 'thinking'); controller.interact('claude', 'pat');
    assert.equal(controller.update('claude', claude, 'coding').state, 'pat');
    assert.equal(controller.update('claude', claude, state).state, state);
  }
});

test('idle actions use available unused poses, stop on activity and avoid consecutive action repeats', () => {
  let time = 0;
  const controller = createController({ ...noWelcome, now: () => time, random: () => 0 });
  controller.update('claude', claude, 'idle');
  time = 45000;
  const first = controller.update('claude', claude, 'idle');
  assert.equal(first.state, 'hum');
  assert.equal(controller.update('claude', claude, 'reading').state, 'reading');
  time = 46000; controller.update('claude', claude, 'idle');
  time = 91000;
  assert.equal(controller.update('claude', claude, 'idle').state, 'stretch');
  // Affectionate antics only use available art; pouting has its own attention timer.
  const affectionate = { ...claude, poses: { idle: claude.poses.idle, coaxed: claude.poses.coaxed, puffed: claude.poses.puffed }, poseVariants: {} };
  const other = createController({ ...noWelcome, now: () => time, random: () => 0 });
  other.update('claude', affectionate, 'idle'); time += 45000;
  assert.equal(other.update('claude', affectionate, 'idle').state, 'coaxed');
});

test('greetings run only on idle appearance or wake and yield to actual work', () => {
  let time = 0;
  const controller = createController({ now: () => time, random: () => 0 });
  assert.equal(controller.update('claude', claude, 'idle').state, 'greet');
  time = 2700; assert.equal(controller.update('claude', claude, 'idle').state, 'idle');
  assert.equal(controller.update('claude', claude, 'sleeping').state, 'sleeping');
  assert.equal(controller.update('claude', claude, 'idle').state, 'greet');
  assert.equal(controller.update('claude', claude, 'coding').state, 'coding');
  controller.update('claude', claude, 'idle', { visible: false });
  assert.equal(controller.update('claude', claude, 'thinking').state, 'thinking');
});

test('gentler motion disables decorative rotation, greetings and antics but preserves deliberate petting', () => {
  let time = 0;
  const controller = createController({ now: () => time, random: () => 0 });
  const settings = { reducedMotion: true };
  const initial = controller.update('claude', claude, 'idle', settings);
  assert.equal(initial.state, 'idle');
  time = 100000;
  assert.deepEqual(controller.update('claude', claude, 'idle', settings), initial);
  controller.interact('claude', 'pat');
  assert.equal(controller.update('claude', claude, 'idle', settings).state, 'pat');
  time += 3100;
  assert.equal(controller.update('claude', claude, 'idle', settings).state, 'idle');
});

test('optional social poses appear only as available idle antics and yield immediately to work', () => {
  for (const state of ['aloof', 'wink', 'smug', 'sip']) {
    let time = 0;
    const character = { ...claude, poses: { idle: claude.poses.idle }, poseVariants: {}, customPoses: { [state]: [`claude/${state}.png`] } };
    const controller = createController({ ...noWelcome, now: () => time, random: () => 0 });
    controller.update('claude', character, 'idle');
    const busy = controller.update('codex', gpt, 'coding');
    time = 45000;
    assert.equal(controller.update('claude', character, 'idle').state, state);
    assert.equal(controller.update('codex', gpt, 'coding').state, busy.state);
    assert.equal(controller.update('claude', character, 'thinking').state, 'thinking');
    assert.deepEqual(candidates({ ...character, customPoses: {} }, state, false), []);
  }
});

const quietPouter = { ...claude, poses: { idle: claude.poses.idle, puffed: claude.poses.puffed }, poseVariants: {} };

test('a brief pout follows two minutes of visible idle time and cannot repeat sooner than two minutes', () => {
  let time = 0;
  const controller = createController({ ...noWelcome, now: () => time, random: () => 0 });
  controller.update('claude', quietPouter, 'idle');
  time = 119999; assert.equal(controller.update('claude', quietPouter, 'idle').state, 'idle');
  time = 120000; assert.equal(controller.update('claude', quietPouter, 'idle').state, 'puffed');
  time = 123600; assert.equal(controller.update('claude', quietPouter, 'idle').state, 'idle');
  time = 239999; assert.equal(controller.update('claude', quietPouter, 'idle').state, 'idle');
  time = 240000; assert.equal(controller.update('claude', quietPouter, 'idle').state, 'puffed');
});

test('petting resets only that companion’s attention countdown', () => {
  let time = 0;
  const controller = createController({ ...noWelcome, now: () => time, random: () => 0 });
  controller.update('claude', quietPouter, 'idle'); controller.update('codex', quietPouter, 'idle');
  time = 100000; controller.interact('claude', 'pat');
  assert.equal(controller.update('claude', quietPouter, 'idle').state, 'pat');
  time = 120000;
  assert.equal(controller.update('claude', quietPouter, 'idle').state, 'idle');
  assert.equal(controller.update('codex', quietPouter, 'idle').state, 'puffed');
  time = 219999; assert.equal(controller.update('claude', quietPouter, 'idle').state, 'idle');
  time = 220000; assert.equal(controller.update('claude', quietPouter, 'idle').state, 'puffed');
});

test('hidden time, work and gentler motion never accumulate ignored time', () => {
  let time = 0;
  const controller = createController({ ...noWelcome, now: () => time, random: () => 0 });
  controller.update('claude', quietPouter, 'idle');
  time = 60000; controller.update('claude', quietPouter, 'idle', { visible: false });
  time = 600000; assert.equal(controller.update('claude', quietPouter, 'idle').state, 'idle');
  time = 719999; assert.equal(controller.update('claude', quietPouter, 'idle').state, 'idle');
  time = 720000; assert.equal(controller.update('claude', quietPouter, 'idle').state, 'puffed');
  assert.equal(controller.update('claude', quietPouter, 'coding').state, 'coding');
  time = 900000; assert.equal(controller.update('claude', quietPouter, 'coding').state, 'coding');
  assert.equal(controller.update('claude', quietPouter, 'idle').state, 'idle');
  time = 1019999; assert.equal(controller.update('claude', quietPouter, 'idle').state, 'idle');
  time = 1020000; assert.equal(controller.update('claude', quietPouter, 'idle').state, 'puffed');
  assert.equal(controller.update('claude', quietPouter, 'idle', { reducedMotion: true }).state, 'idle');
  time = 2000000; assert.equal(controller.update('claude', quietPouter, 'idle', { reducedMotion: true }).state, 'idle');
  assert.equal(controller.update('claude', quietPouter, 'idle').state, 'idle');
});

test('new activity metadata cancels a pout even if the activity badge remains idle', () => {
  let time = 0;
  const controller = createController({ ...noWelcome, now: () => time, random: () => 0 });
  const first = { activityAt: '2026-10-24T10:00:00.000Z' };
  const next = { activityAt: '2026-10-24T10:02:00.000Z' };
  controller.update('claude', quietPouter, 'idle', first);
  time = 120000; assert.equal(controller.update('claude', quietPouter, 'idle', first).state, 'puffed');
  assert.equal(controller.update('claude', quietPouter, 'idle', next).state, 'idle');
  time = 239999; assert.equal(controller.update('claude', quietPouter, 'idle', next).state, 'idle');
  time = 240000; assert.equal(controller.update('claude', quietPouter, 'idle', next).state, 'puffed');
});
