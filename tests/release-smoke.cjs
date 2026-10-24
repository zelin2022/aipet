'use strict';
const { app, BrowserWindow, ipcMain, powerMonitor } = require('electron');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const targetRoot = process.env.AIPET_SMOKE_APP_ROOT;
const data = process.env.AIPET_TEST_DATA;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const started = Date.now();
const errors = [], usageCalls = [], channels = [];
const restore = [];
let instance, pet, studio;
let stamp = Date.now() - 1000;

async function until(predicate, description, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await sleep(40);
  }
  throw new Error(`Timed out: ${description}`);
}

function watch(win) {
  win.setOpacity(0);
  win.showInactive();
  win.webContents.on('console-message', details => {
    if (details.level === 'error' && !/Content Security Policy|ERR_|security policy/i.test(details.message)) errors.push(details.message);
  });
  win.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer gone: ${details.reason}`));
}

const run = source => studio.webContents.executeJavaScript(source);
const runPet = source => pet.webContents.executeJavaScript(source);
async function loaded(win) {
  await until(() => !win.webContents.isLoading(), 'renderer document ready');
  await until(() => win.webContents.executeJavaScript('[...document.images].filter(image=>image.loading!=="lazy").every(image=>image.complete&&image.naturalWidth>0)'), 'all committed visible images decode');
}

async function slots() {
  return runPet(`Array.from(document.querySelectorAll('.companion-slot[data-provider]')).filter(slot=>!slot.hidden).map(slot=>({provider:slot.dataset.provider,state:slot.dataset.state,src:slot.querySelector('img').getAttribute('src'),loaded:slot.querySelector('img').complete&&slot.querySelector('img').naturalWidth>0}))`);
}

function ingest(provider, state) {
  stamp = Math.max(stamp + 1, Date.now());
  assert.equal(instance.activity.ingest({ version:1, provider, state, session:provider==='claude'?'1'.repeat(32):'2'.repeat(32), at:new Date(stamp).toISOString() }), true);
  instance.refreshVisibility();
}

function observeUsageIO() {
  const matches = value => {
    if (Buffer.isBuffer(value)) value = value.toString();
    if (value instanceof URL) value = value.pathname;
    return typeof value === 'string' && /(?:^|[\\/])sprite-usage(?:[.\\/-]|$)/i.test(value);
  };
  for (const [label, object, methods] of [
    ['sync', fsSync, ['readFileSync','writeFileSync','appendFileSync','openSync','existsSync','statSync','lstatSync','renameSync','unlinkSync']],
    ['async', fs, ['readFile','writeFile','appendFile','open','access','stat','lstat','rename','unlink']],
  ]) for (const name of methods) {
    const original = object[name];
    object[name] = function(...args) {
      if (args.some(matches)) usageCalls.push(`${label}.${name}`);
      return Reflect.apply(original, this, args);
    };
    restore.push(() => { object[name] = original; });
  }
  const originalHandle = ipcMain.handle;
  ipcMain.handle = function(channel, ...args) {
    channels.push(channel);
    return Reflect.apply(originalHandle, this, [channel, ...args]);
  };
  restore.push(() => { ipcMain.handle = originalHandle; });
}

(async () => {
  assert.equal(process.env.AIPET_DESKTOP_TEST, '1');
  assert.ok(targetRoot && data && path.isAbsolute(data));
  assert.notEqual(path.resolve(targetRoot), root);
  assert.equal(data, path.join(process.env.USERPROFILE, '.aipet'), 'Renderer test uses only its isolated machine profile.');
  for (const relative of ['src/core/sprite-usage.cjs','src/core/sprite-catalog.cjs','renderer/sprite-usage.js','renderer/sprite-usage.css']) {
    assert.throws(()=>fsSync.statSync(path.join(targetRoot,relative)), {code:'ENOENT'}, `${relative} must be omitted from release`);
  }
  for (const relative of ['src/main.cjs','src/preload.cjs','renderer/pet.js','renderer/studio.js','renderer/studio.html']) {
    assert.doesNotMatch(fsSync.readFileSync(path.join(targetRoot,relative),'utf8'), /sprite-usage|getSpriteUsage|reportSpriteUsage|resetSpriteUsage|usageSaveTimer|usageBlocks|data-view=["']usage["']/, `${relative} contains no usage collector or UI`);
  }
  const originalSentinel = fsSync.readFileSync(path.join(data,'sprite-usage.json'));
  observeUsageIO();
  instance = await require(path.join(targetRoot,'src/main.cjs')).ready;
  assert.equal(BrowserWindow.getAllWindows().length,0,'Release starts dormant in tray.');
  assert.equal(typeof instance.getSpriteUsage,'undefined');
  assert.equal(typeof instance.flushSpriteUsage,'undefined');
  assert.ok(!channels.some(channel=>/sprite.?usage/i.test(channel)),'No usage IPC handlers are installed.');

  instance.openStudio();
  studio = instance.getStudio();
  watch(studio);
  await loaded(studio);
  assert.equal(await run('typeof window.require'),'undefined');
  assert.equal(studio.webContents.getLastWebPreferences().sandbox,true);
  assert.equal(studio.webContents.getLastWebPreferences().contextIsolation,true);
  assert.equal(await run('Object.keys(window.aipet).some(key=>/sprite.?usage/i.test(key))'),false,'Sandbox bridge exposes no usage methods.');
  assert.equal(await run('Boolean(document.querySelector("[data-view=usage],#view-usage,#usage-rows"))'),false,'Studio has no usage navigation or panel.');

  const setup = {};
  for (const provider of ['claude','codex']) {
    setup[provider] = await run(`window.aipet.getSetup(${JSON.stringify(provider)})`);
    const value = JSON.parse(setup[provider].example);
    assert.ok(Object.values(value.hooks).some(groups=>groups.length),'Both target-machine AI hook examples are available.');
    const hooks = Object.values(value.hooks).flat().flatMap(group=>group.hooks);
    const commands = hooks.map(hook=>[hook.command,...(hook.args||[])].join(' '));
    assert.ok(commands.every(command=>command.includes(targetRoot.replaceAll('\\','/'))),'Generated bridge paths refer to the copied application.');
    assert.ok(!commands.some(command=>command.includes('G:/workspace/aipet/integrations/')),'Examples do not reference the development bridge.');
    for(const hook of hooks.filter(hook=>hook.commandWindows)) {
      const encoded = / -EncodedCommand ([a-zA-Z0-9+/=]+)$/.exec(hook.commandWindows);
      assert.ok(encoded,'Windows launchers retain their reviewed, encoded form.');
      assert.ok(Buffer.from(encoded[1],'base64').toString('utf16le').includes(targetRoot.replaceAll('\\','/')),'Encoded Windows bridge also refers to the copied application.');
    }
  }
  instance.updateSettings({reducedMotion:false,showBoth:true,followActivity:true});
  instance.acceptPresence({foreground:'codex',running:['claude','codex'],fullscreen:null});
  instance.resumeAutomatic();
  pet = instance.getPet();
  watch(pet);
  await loaded(pet);
  await until(async()=>{const value=await slots();return value.length===2&&value.every(slot=>slot.loaded);},'two actual pets render');
  assert.ok((await slots()).every(slot=>slot.state==='greet'),'Both companions greet when first detected.');
  assert.equal(await runPet('Object.keys(window.aipet).some(key=>/sprite.?usage/i.test(key))'),false);
  instance.updateSettings({reducedMotion:true});
  ingest('claude','reading');
  ingest('codex','coding');
  await until(async()=>{const value=await slots();return value.length===2&&value[0].state==='reading'&&value[1].state==='coding'&&value.every(slot=>slot.loaded);},'both characters react to independent metadata');
  await runPet('window.aipet.interact("pat","claude")');
  await until(async()=>(await slots())[0].state==='pat','pet interaction remains connected');

  // Do not bypass sandboxing or import a provider process. Every bundled image
  // is decoded by the same browser image pipeline used by the two pet windows.
  const original = JSON.parse(await fs.readFile(path.join(targetRoot,'assets/crosspet/provenance.json'),'utf8'));
  const custom = JSON.parse(await fs.readFile(path.join(targetRoot,'assets/custom/manifest.json'),'utf8'));
  const paths = [
    ...original.files.filter(file=>/\.(png|webp)$/i.test(file.destination)).map(file=>'../assets/crosspet/'+file.destination.replaceAll('\\','/')),
    ...custom.files.filter(file=>/\.(png|webp)$/i.test(file.path)).map(file=>'../assets/custom/'+file.path),
  ];
  assert.equal(paths.length,176,'The transfer release retains all original and custom artwork.');
  const decoded = await run(`(async()=>{const results=[];for(const source of ${JSON.stringify(paths)}){const image=new Image();image.src=source;await image.decode();if(!image.naturalWidth||!image.naturalHeight)throw new Error('Empty artwork: '+source);results.push(source);}return results.length;})()`);
  assert.equal(decoded,paths.length);

  await run('document.querySelector("[data-view=connections]").click();document.querySelector("[data-provider=codex]").click()');
  await until(()=>run('!document.querySelector("#setup-panel").hidden'),'connection setup remains usable');
  await run('document.querySelector("#close-setup").click();document.querySelector("[data-view=privacy]").click()');
  await until(()=>run('!document.querySelector("#view-privacy").hidden'),'privacy view remains usable');
  await fs.writeFile(path.join(root,'out/smoke/release-studio.png'),(await studio.webContents.capturePage()).toPNG());
  powerMonitor.emit('suspend');
  powerMonitor.emit('resume');
  instance.hidePet();
  await until(()=>!instance.getPet()||!instance.getPet().isVisible(),'explicit hide remains available');
  instance.showPet();
  pet=instance.getPet();watch(pet);await loaded(pet);
  await fs.writeFile(path.join(root,'out/smoke/release-pets.png'),(await pet.webContents.capturePage()).toPNG());

  // Keep the real main process and renderer alive past the development build's
  // 30-second persistence interval, so a leftover collector cannot hide here.
  while(Date.now()-started<31500)await sleep(200);
  assert.deepEqual(errors,[],'No renderer errors');
  assert.deepEqual(usageCalls,[],'No counter storage method is touched at startup, while visible, or during suspend/hide/resume.');
  assert.ok(!Object.keys(require.cache).some(file=>/[\\/]sprite-(?:usage|catalog)\.cjs$/.test(file)),'No collector module was executed.');

  app.once('will-quit',()=>{
    try {
      assert.deepEqual(usageCalls,[],'Normal quit performs no counter IO.');
      for(const undo of restore.reverse())undo();
      assert.deepEqual(fsSync.readFileSync(path.join(data,'sprite-usage.json')),originalSentinel,'Existing private counters are untouched.');
      assert.deepEqual(fsSync.readdirSync(data).filter(name=>/sprite.?usage/i.test(name)),['sprite-usage.json'],'No counter scratch file is created.');
      const report={passed:true,releaseRoot:targetRoot,isolatedProfile:true,realRenderer:true,imagesDecoded:decoded,dualCompanions:true,greetings:true,interactions:true,setupRelocated:true,usageModulesOmitted:true,usageApiOmitted:true,usageIpcOmitted:true,usageUiOmitted:true,usageIoCalls:0,preexistingUsagePreserved:true,normalQuit:true,observationMilliseconds:Date.now()-started};
      fsSync.writeFileSync(path.join(root,'out/smoke/release.qa.json'),JSON.stringify(report,null,2)+'\n');
      try{fsSync.unlinkSync(path.join(root,'out/smoke/release.failure.txt'));}catch(error){if(error.code!=='ENOENT')throw error;}
      console.log(`No-counter release smoke passed: ${decoded} images decoded, dual pets and studio work, no counter APIs, IPC, UI, modules or storage calls (including normal quit).`);
    }catch(error){console.error(error.stack);app.exit(1);}
  });
  app.quit();
})().catch(error=>{
  for(const undo of restore.reverse())undo();
  fsSync.writeFileSync(path.join(root,'out/smoke/release.failure.txt'),error.stack+'\n');
  console.error(error.stack);
  app.exit(1);
});
