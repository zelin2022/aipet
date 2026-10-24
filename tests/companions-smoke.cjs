'use strict';
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const targetRoot = process.env.AIPET_SMOKE_APP_ROOT || root;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [];
let instance;
let stamp = Date.now() - 1000;

async function until(predicate, description, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${description}`);
}

async function readyPet() {
  const pet = instance.getPet();
  assert.ok(pet, 'presence creates one companion window');
  // Keep this owned test surface out of view and leave focus untouched.
  pet.setOpacity(0);
  pet.webContents.on('console-message', details => {
    if (details.level === 'error' && !/Content Security Policy|ERR_|security policy/i.test(details.message)) errors.push(details.message);
  });
  pet.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer gone: ${details.reason}`));
  await until(() => pet.isVisible() && !pet.webContents.isLoading(), 'companion renderer load');
  await until(() => pet.webContents.executeJavaScript('[...document.images].length > 0 && [...document.images].every(image => image.complete && image.naturalWidth > 0)'), 'original character image decoding');
  return pet;
}

function companions() {
  return instance.snapshot().companions.map(({ provider, character, state }) => ({ provider, character, state }));
}

function presence(running, foreground = 'unknown') {
  assert.equal(instance.acceptPresence({ foreground, running, fullscreen: null }), true);
}

function ingest(provider, state) {
  const session = provider === 'claude' ? '11111111111111111111111111111111' : '22222222222222222222222222222222';
  stamp = Math.max(stamp + 1, Date.now());
  assert.equal(instance.activity.ingest({ version: 1, provider, state, session, at: new Date(stamp).toISOString() }), true);
  instance.refreshVisibility();
}

async function rendered(pet, expected) {
  await until(async () => {
    const value = await pet.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.companion-slot[data-provider]')).filter(slot => getComputedStyle(slot).display !== 'none').map(slot => ({provider: slot.dataset.provider, state: (slot.querySelector('[data-state]') || slot).dataset.state, loaded: [...slot.querySelectorAll('img')].every(image => image.complete && image.naturalWidth > 0)}))`);
    return value.length === expected.length && value.every((slot, index) => slot.provider === expected[index].provider && slot.state === expected[index].state && slot.loaded);
  }, 'independent companion states and images');
}

async function opaquePoints(pet) {
  return pet.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.companion-slot[data-provider]')).map(slot => {
    const image=slot.querySelector('img'),canvas=document.createElement('canvas');
    canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const context=canvas.getContext('2d');context.drawImage(image,0,0);
    const alpha=context.getImageData(0,0,canvas.width,canvas.height).data;
    const {scale,left,top,crop}=window.PetArt.sourceGeometry(image);
    for(let y=Math.max(crop.y,Math.floor(canvas.height/2));y<crop.y+crop.height;y++)for(let x=Math.max(crop.x,Math.floor(canvas.width/2));x<crop.x+crop.width;x++)if(alpha[(y*canvas.width+x)*4+3]>200)return {provider:slot.dataset.provider,x:Math.floor(left+(x+.5)*scale),y:Math.floor(top+(y+.5)*scale)};
    return null;
  })`);
}

function contained(bounds, workArea) {
  return bounds.x >= workArea.x && bounds.y >= workArea.y && bounds.x + bounds.width <= workArea.x + workArea.width && bounds.y + bounds.height <= workArea.y + workArea.height;
}

(async () => {
  assert.equal(process.env.AIPET_DESKTOP_TEST, '1');
  assert.ok(process.env.AIPET_TEST_DATA);
  assert.ok(process.argv.includes('--background'));
  instance = await require(path.join(targetRoot, 'src/main.cjs')).ready;
  assert.equal(BrowserWindow.getAllWindows().length, 0, 'dormant startup has no renderer windows');
  assert.equal(instance.snapshot().settings.showBoth, true);
  instance.updateSettings({ reducedMotion: true });

  presence(['claude', 'codex'], 'codex');
  let pet = await readyPet();
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'two companions share one secure native window');
  assert.equal(pet.getBounds().width, 680);
  assert.equal(pet.getBounds().height, 410);
  assert.deepEqual(companions(), [
    { provider: 'claude', character: 'claude', state: 'idle' },
    { provider: 'codex', character: 'gpt', state: 'idle' },
  ]);
  await rendered(pet, companions());
  const layout = await pet.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.companion-slot[data-provider]')).map(slot => {const image=slot.querySelector('img'),rect=slot.getBoundingClientRect();return {provider:slot.dataset.provider,left:rect.left,right:rect.right,src:image.getAttribute('src')};})`);
  assert.equal(layout.length, 2);
  assert.ok(layout[0].right <= layout[1].left + 1, 'companion slots sit side by side');
  assert.ok(layout[0].src.includes('/claude/') && layout[1].src.includes('/gpt/'), 'each provider uses its own character artwork');
  assert.equal(pet.webContents.getLastWebPreferences().sandbox, true);
  assert.equal(pet.webContents.getLastWebPreferences().contextIsolation, true);

  const fullscreenDisplay = screen.getDisplayMatching(pet.getBounds()).bounds;
  assert.equal(instance.acceptPresence({ foreground: 'unknown', running: ['claude', 'codex'], fullscreen: fullscreenDisplay }), true);
  assert.equal(instance.getPet(), null, 'fullscreen suppression disposes both companions together');
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  assert.equal(instance.snapshot().visibility.reason, 'fullscreen');
  presence(['claude', 'codex'], 'codex');
  pet = await readyPet();
  assert.equal(pet.getBounds().width, 680);
  assert.equal(instance.snapshot().companions.length, 2, 'clearing fullscreen restores both companions');
  await rendered(pet, companions());

  ingest('claude', 'reading');
  ingest('codex', 'coding');
  await rendered(pet, companions());
  assert.deepEqual(companions().map(value => value.state), ['reading', 'coding']);
  assert.equal(instance.snapshot().activity.provider, 'codex');
  await pet.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await fs.writeFile(path.join(root, 'out/smoke/companions.png'), (await pet.webContents.capturePage()).toPNG());
  ingest('claude', 'success');
  assert.deepEqual(companions().map(value => value.state), ['success', 'coding'], 'one completion leaves the other provider busy');
  await rendered(pet, companions());
  const before = pet.getBounds();
  presence(['codex', 'claude'], 'claude');
  assert.equal(instance.snapshot().activity.provider, 'claude');
  assert.deepEqual(companions().map(value => value.provider), ['claude', 'codex'], 'foreground changes keep slot order stable');
  assert.deepEqual(pet.getBounds(), before, 'foreground changes do not move the group');
  await rendered(pet, companions());

  const points = await opaquePoints(pet);
  assert.equal(points.length, 2);
  assert.ok(points.every(Boolean), 'both character images provide an opaque hit point');
  const hits = [];
  const onHit = (_event, hit) => hits.push(hit);
  ipcMain.on('aipet:hit', onHit);
  try {
    for (const point of points) {
      pet.webContents.sendInputEvent({ type: 'mouseMove', x: 0, y: 0 });
      await sleep(80);
      const start = hits.length;
      pet.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
      await until(() => hits.slice(start).includes(true), `${point.provider} source-alpha hit`);
      pet.webContents.sendInputEvent({ type: 'mouseMove', x: 0, y: 0 });
      await until(() => hits.slice(start).includes(false), `${point.provider} transparent margin click-through`);
    }
  } finally {
    ipcMain.removeListener('aipet:hit', onHit);
  }

  await pet.webContents.executeJavaScript('window.aipet.interact("pat", "claude")');
  await rendered(pet, [
    { provider: 'claude', state: 'pat' },
    { provider: 'codex', state: 'coding' },
  ]);
  await until(async () => pet.webContents.executeJavaScript('document.querySelector(".companion-slot[data-provider=claude]").classList.contains("speaking")'), 'individual companion speech');
  assert.equal(await pet.webContents.executeJavaScript('document.querySelector(".companion-slot[data-provider=codex]").classList.contains("speaking")'), false, 'patting Claude leaves Codex interaction unchanged');
  await rendered(pet, companions());

  const dragArea = screen.getDisplayMatching(pet.getBounds()).workArea;
  pet.setPosition(dragArea.x - 40, dragArea.y - 40);
  await pet.webContents.executeJavaScript('window.aipet.drag("end")');
  await until(() => contained(pet.getBounds(), dragArea), 'drag end clamps the whole group');
  assert.equal(pet.getBounds().width, 680);

  instance.updateSettings({ size: 70 });
  assert.equal(pet.getBounds().width, 476);
  assert.equal(pet.getBounds().height, 287);
  pet.setPosition(-50000, -50000);
  screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), ['workArea']);
  assert.ok(screen.getAllDisplays().some(display => contained(pet.getBounds(), display.workArea)), 'whole group recovers onto a display');
  instance.updateSettings({ size: 100 });
  instance.showPet(true);
  assert.ok(screen.getAllDisplays().some(display => contained(pet.getBounds(), display.workArea)), 'bring home fits the whole group');

  instance.openStudio();
  const studio = instance.getStudio();
  studio.setOpacity(0);
  await until(() => !studio.webContents.isLoading(), 'companion studio load');
  await until(() => studio.webContents.executeJavaScript('document.querySelector("#show-both").checked'), 'studio shows the enabled pair preference');
  await studio.webContents.executeJavaScript('document.querySelector("#show-both").click()');
  await until(() => !instance.snapshot().settings.showBoth, 'studio toggle selects one companion');
  assert.equal(instance.snapshot().companions.length, 1);
  assert.equal(pet.getBounds().width, 340);
  await rendered(pet, companions());
  await studio.webContents.executeJavaScript('document.querySelector("#show-both").click()');
  await until(() => instance.snapshot().settings.showBoth, 'studio toggle restores both companions');
  assert.equal(instance.snapshot().companions.length, 2);
  assert.equal(pet.getBounds().width, 680);
  await rendered(pet, companions());
  instance.updateSettings({ followActivity: false, character: 'gpt' });
  assert.deepEqual(companions().map(value => value.character), ['gpt'], 'manual character pin stays a single companion');
  assert.equal(pet.getBounds().width, 340);
  await rendered(pet, companions());
  await until(() => studio.webContents.executeJavaScript('document.querySelector("#show-both").disabled'), 'studio explains that a manual character pin is single');
  instance.updateSettings({ followActivity: true });
  await until(() => studio.webContents.executeJavaScript('!document.querySelector("#show-both").disabled'), 'following AI enables the pair preference');
  studio.destroy();
  presence(['claude', 'codex'], 'codex');
  assert.equal(instance.snapshot().companions.length, 2);
  instance.hidePet();
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  presence(['claude', 'codex'], 'claude');
  assert.equal(instance.getPet(), null, 'manual hide suppresses both companions');
  instance.resumeAutomatic();
  pet = await readyPet();
  assert.equal(instance.snapshot().companions.length, 2);
  assert.equal(pet.getBounds().width, 680);

  instance.activity.sessions.clear();
  presence(['claude'], 'claude');
  assert.deepEqual(companions().map(value => value.provider), ['claude']);
  assert.equal(pet.getBounds().width, 340, 'closing one provider shrinks to one companion');
  await rendered(pet, companions());
  presence(['codex'], 'codex');
  assert.deepEqual(companions().map(value => value.character), ['gpt']);
  await rendered(pet, companions());
  presence([], 'unknown');
  instance.presence.lastSeen = -Infinity;
  instance.refreshVisibility();
  assert.equal(BrowserWindow.getAllWindows().length, 0, 'closing both returns to zero-window tray dormancy');
  ingest('claude', 'reading');
  ingest('codex', 'thinking');
  pet = await readyPet();
  assert.equal(instance.snapshot().companions.length, 2, 'fresh hook metadata can wake both providers without process presence');
  assert.equal(pet.getBounds().width, 680);
  await rendered(pet, companions());
  assert.deepEqual(errors, []);
  instance.hidePet();
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  console.log('Companions smoke passed: two original characters in one window, independent activity, stable ordering, alpha click-through for both, resize/recovery, fullscreen suppression/restore, single-provider transitions, manual pin/hide/resume and hook-only wake.');
  app.exit(0);
})().catch(error => {
  console.error(error);
  app.exit(1);
});
