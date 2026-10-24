'use strict';
const { app, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const targetRoot = process.env.AIPET_SMOKE_APP_ROOT || root;
const errors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function loaded(win) {
  if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  await Promise.race([(async()=>{
    // setImage decodes its request before committing src. Wait for the committed
    // images as well, rather than treating an initially empty src as decoded.
    while(!await win.webContents.executeJavaScript('[...document.images].every(image=>image.complete&&image.naturalWidth>0)')) await sleep(25);
    await win.webContents.executeJavaScript('Promise.all([...document.images].map(img => img.decode()))');
  })(), sleep(5000).then(() => { throw new Error('Image decode timed out: ' + win.webContents.getURL()); })]);
}
(async () => {
  const instance = await require(path.join(targetRoot, 'src/main.cjs')).ready;
  const pet = instance.getPet(), studio = instance.getStudio();
  // A visible, zero-opacity native surface keeps compositor frames current without
  // flashing test windows or taking focus. capturePage ignores window opacity.
  for (const win of [pet, studio]) { win.setOpacity(0); win.showInactive(); }
  for (const win of [pet, studio]) {
    win.webContents.on('console-message', details => { if (details.level === 'error' && !/Content Security Policy|ERR_|security policy/i.test(details.message)) errors.push(details.message); });
    win.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer gone: ${details.reason}`));
  }
  await Promise.all([loaded(pet), loaded(studio)]);
  const run = source => studio.webContents.executeJavaScript(source);
  assert.equal(await run('typeof window.require'), 'undefined');
  assert.equal(await run('typeof window.process'), 'undefined');
  assert.equal(studio.webContents.getLastWebPreferences().sandbox, true);
  assert.equal(studio.webContents.getLastWebPreferences().contextIsolation, true);
  assert.equal(await run('document.querySelectorAll(".character-card").length'), 2);
  assert.equal(await run('document.querySelectorAll(".state-button").length'), 9);
  assert.equal(await run('[...document.images].every(i => i.complete && i.naturalWidth > 0)'), true);
  const gptProfile = instance.snapshot().characters.find(character => character.id === 'gpt');
  if (gptProfile.customMode === 'replace') {
    assert.equal(await run('document.querySelector("[data-character=gpt] img").getAttribute("src")'), '../assets/custom/' + gptProfile.customPoses.idle[0], 'the character picker honors the approved GPT restyle');
    assert.ok((await run('document.querySelector("[data-character=gpt] img").style.objectViewBox')).startsWith('inset('), 'the picker applies the verified image framing');
  }
  assert.equal(await run('window.aipet.getSetup("codex").then(x => JSON.parse(x.example).hooks.Stop.length)'), 1);
  assert.equal(await run('window.aipet.getSetup("evil").then(()=>false,()=>true)'), true);
  assert.equal(await run('window.aipet.preview("shell").then(()=>false,()=>true)'), true);
  assert.equal(await run('fetch("https://example.com").then(()=>false,()=>true)'), true);
  const privateFile = pathToFileURL(path.join(targetRoot, 'src/main.cjs')).href;
  assert.equal(await run(`fetch(${JSON.stringify(privateFile)}).then(()=>false,()=>true)`), true);
  const before = studio.webContents.getURL();
  await run('window.open("https://example.com")');
  assert.equal(studio.webContents.getURL(), before);
  await run('document.querySelector("[data-character=gpt]").click()');
  await sleep(180);
  assert.equal(instance.snapshot().settings.character, 'gpt');
  assert.equal(instance.snapshot().settings.followActivity, false);
  if (gptProfile.customMode === 'replace') {
    await loaded(studio);
    assert.ok((await run('document.querySelector("#hero-art").getAttribute("src")')).startsWith('../assets/custom/gpt/'), 'the default studio preview honors the approved GPT restyle');
  }
  await run('window.aipet.updateSettings({size:999,secret:"discarded",position:{x:-99999,y:-99999}})');
  assert.equal(instance.snapshot().settings.size, 140);
  assert.equal(instance.snapshot().settings.secret, undefined);
  await run('window.aipet.updateSettings({size:100,character:"claude",followActivity:true})');
  const { createEvent, writeEvent } = await import(pathToFileURL(path.join(targetRoot, 'integrations/activity.mjs')).href);
  await writeEvent(createEvent('codex', 'coding', 'synthetic-smoke-only'), path.join(instance.dataDirectory, 'events'));
  await instance.pollEvents();
  await sleep(150);
  assert.equal(instance.snapshot().activity.provider, 'codex');
  assert.equal(instance.snapshot().activity.state, 'coding');
  assert.equal(await run('document.querySelector("#hero-stage").dataset.state'), 'coding');
  await run('window.aipet.preview("success")');
  await sleep(200);
  assert.equal(instance.snapshot().activity.preview, true);
  await run('document.querySelector("[data-view=activity]").click()');
  await loaded(studio); await sleep(200);
  assert.equal(await run('document.querySelector("#view-activity").hidden'), false);
  await fs.writeFile(path.join(root, 'out/smoke/activity.png'), (await studio.webContents.capturePage()).toPNG());
  await run('document.querySelector("[data-view=connections]").click(); document.querySelector("[data-provider=codex]").click()');
  await sleep(200);
  assert.equal(await run('document.querySelector("#setup-panel").hidden'), false);
  assert.ok((await run('document.querySelector("#setup-example").textContent')).includes('--provider codex'));
  await run('document.querySelector("#close-setup").click(); document.querySelector("[data-view=privacy]").click()');
  await sleep(200);
  await fs.writeFile(path.join(root, 'out/smoke/privacy.png'), (await studio.webContents.capturePage()).toPNG());
  await run('document.querySelector("[data-view=companion]").click(); window.aipet.updateSettings({character:"claude",followActivity:false})');
  await sleep(8200); // Verify previews relinquish control; capture the normal live companion.
  assert.equal(instance.snapshot().activity.preview, undefined);
  await loaded(studio);
  await sleep(200);
  await fs.writeFile(path.join(root, 'out/smoke/studio.png'), (await studio.webContents.capturePage()).toPNG());
  await loaded(pet);
  await fs.writeFile(path.join(root, 'out/smoke/pet.png'), (await pet.webContents.capturePage()).toPNG());
  const hits = [];
  const onHit = (_event, hit) => hits.push(hit);
  ipcMain.on('aipet:hit', onHit);
  pet.webContents.sendInputEvent({ type:'mouseMove', x:170, y:200 });
  await sleep(100);
  pet.webContents.sendInputEvent({ type:'mouseMove', x:0, y:0 });
  await sleep(100);
  ipcMain.removeListener('aipet:hit', onHit);
  assert.ok(hits.includes(true) && hits.includes(false), 'opaque sprite and transparent corner produce different hit-test IPC');
  await run('window.aipet.interact("pat")');
  await sleep(120);
  assert.equal(await pet.webContents.executeJavaScript('document.body.dataset.state'), 'pat');
  assert.equal(await pet.webContents.executeJavaScript('document.body.classList.contains("speaking")'), true);
  assert.equal(await run('[...document.querySelectorAll("button,input")].filter(x => x.getBoundingClientRect().right > innerWidth + 1).length'), 0);
  instance.showPet(); assert.equal(instance.snapshot().hidden, false);
  instance.hidePet(); assert.equal(instance.snapshot().hidden, true);
  assert.deepEqual(errors, []);
  console.log('Desktop smoke passed: real Electron renderers, 2 characters, 9 states, live inbox, setup, isolated preferences, sandbox, IPC validation, blocked network/private files, visibility and screenshots.');
  app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
