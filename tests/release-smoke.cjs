'use strict';
const { app, BrowserWindow, ipcMain, powerMonitor } = require('electron');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const targetRoot = process.env.AIPET_SMOKE_APP_ROOT;
const data = process.env.AIPET_TEST_DATA;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const started = Date.now();
const errors = [], usageCalls = [], channels = [];
const restore = [];
let instance, pet, studio;
let stamp = Date.now() - 1000;

async function invokeReviewedHook(provider, hook) {
  let executable, args, state;
  if (provider === 'codex') {
    const parsed = /^(?:"([^"]+)"|([^ ]+)) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(hook.commandWindows);
    assert.ok(parsed, 'The reviewed encoded command has only fixed PowerShell launch flags.');
    executable = parsed[1] || parsed[2];
    args = ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',parsed[3]];
    state = / -State ([a-z]+)$/.exec(Buffer.from(parsed[3], 'base64').toString('utf16le'))?.[1];
  } else {
    executable = hook.command;
    args = hook.args;
    state = args.at(-1);
  }
  assert.ok(path.isAbsolute(executable));
  assert.ok(['idle','thinking','reading','coding','tool','success','error','waiting','offline'].includes(state));
  const session = provider === 'claude' ? 'aipet-bundled-smoke-session' : 'anonymous';
  const sessionHash = createHash('sha256').update(`aipet-v1:${provider}:${session}`).digest('hex').slice(0,32);
  const filename = path.join(data, 'events', `${provider}-${sessionHash}.json`);
  const acceptedBefore = instance.getPollHealth().accepted[provider];
  const launchedAt = Date.now();
  let timedOut = false, overflow = false, stdout = '', stderr = '';
  const child = spawn(executable, args, {
    cwd: root, windowsHide: true, shell: false, stdio: ['ignore','pipe','pipe'],
    env: {
      ...process.env, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA,
      APPDATA: process.env.APPDATA, CLAUDE_CODE_SESSION_ID: 'aipet-bundled-smoke-session',
      // A clean destination need not expose node.exe through PATH.
      PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
    },
  });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 3000);
  child.stdout.on('data', bytes => { stdout += bytes.toString('utf8'); if (stdout.length > 4096) { overflow = true; child.kill(); } });
  child.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); if (stderr.length > 4096) { overflow = true; child.kill(); } });
  let code;
  try { code = await new Promise((resolve,reject) => { child.once('error',reject); child.once('close',resolve); }); }
  finally { clearTimeout(timer); }
  const elapsedMs = Date.now() - launchedAt;
  assert.equal(timedOut, false, `${provider}/${state} finishes within the actual three-second host deadline.`);
  assert.equal(overflow, false);
  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), '{}', 'The real bundled bridge returns passive hook output.');
  assert.equal(stderr, '');
  const stat = await fs.stat(filename);
  assert.ok(stat.size > 0 && stat.size <= 1024);
  const event = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.deepEqual(Object.keys(event).sort(), ['at','provider','session','state','version']);
  assert.equal(event.provider, provider);
  assert.equal(event.state, state);
  assert.equal(event.session, sessionHash);
  assert.ok(Date.parse(event.at) >= launchedAt - 1000, 'The helper writes fresh metadata into this test profile.');
  await instance.pollEvents();
  instance.refreshVisibility();
  await until(() => instance.getPollHealth().accepted[provider] > acceptedBefore, `${provider}/${state} metadata accepted by the running main process`);
  if (state === 'thinking') await until(async () => (await slots()).some(slot => slot.provider === provider && slot.state === 'thinking'), `${provider} real helper signal reaches the renderer`);
  return { provider, state, elapsedMs };
}

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
  const rawCodex = JSON.parse(fsSync.readFileSync(path.join(targetRoot, 'integrations/codex-hooks.example.json'), 'utf8'));
  const rawHandlers = Object.values(rawCodex.hooks).flat().flatMap(group=>group.hooks);
  assert.equal(rawHandlers.length, 10);
  for (const hook of rawHandlers) {
    const decoded = Buffer.from(hook.commandWindows.split(' -EncodedCommand ')[1], 'base64').toString('utf16le');
    assert.equal(decoded, hook.command.split(' -Command "')[1].slice(0,-1), 'Raw release readable and encoded legacy templates agree.');
    assert.ok(decoded.includes('C:/Aipet/resources/app/integrations/activity.mjs'));
    assert.ok(!decoded.includes('G:/workspace/aipet'));
  }
  for (const provider of ['claude','codex']) {
    setup[provider] = await run(`window.aipet.getSetup(${JSON.stringify(provider)})`);
    assert.equal(setup[provider].runtime, 'bundled', 'Installed setup uses its own verified runtime.');
    const value = JSON.parse(setup[provider].example);
    assert.ok(Object.values(value.hooks).some(groups=>groups.length),'Both target-machine AI hook examples are available.');
    const hooks = Object.values(value.hooks).flat().flatMap(group=>group.hooks);
    const commands = hooks.map(hook=>[hook.command,...(hook.args||[])].join(' '));
    assert.ok(commands.every(command=>command.includes(targetRoot.replaceAll('\\','/'))),'Generated bridge paths refer to the copied application.');
    assert.ok(!commands.some(command=>command.includes('G:/workspace/aipet/integrations/')),'Examples do not reference the development bridge.');
    assert.ok(!commands.some(command=>/nodejs|node\.exe/i.test(command)),'Installed UI examples do not require an external Node installation.');
    if(provider==='claude') for(const hook of hooks) {
      assert.deepEqual(hook.args, ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',targetRoot.replaceAll('\\','/')+'/integrations/activity-launch.ps1','-Provider','claude','-State',hook.args.at(-1)]);
      assert.equal(hook.onFailure,'continue');
    }
    for(const hook of hooks.filter(hook=>hook.commandWindows)) {
      const encoded = / -EncodedCommand ([a-zA-Z0-9+/=]+)$/.exec(hook.commandWindows);
      assert.ok(encoded,'Windows launchers retain their reviewed, encoded form.');
      const decoded=Buffer.from(encoded[1],'base64').toString('utf16le');
      assert.ok(decoded.includes(targetRoot.replaceAll('\\','/')+'/integrations/activity-launch.ps1'),'Encoded Windows bridge also refers to the copied helper.');
      assert.equal(decoded,hook.command.split(' -Command "')[1].slice(0,-1));
      assert.doesNotMatch(decoded,/G:\/workspace\/aipet\/integrations|nodejs|node\.exe/i);
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

  const bundledHooks = [];
  const codexHooks = Object.values(JSON.parse(setup.codex.example).hooks).flat().flatMap(group=>group.hooks);
  for(const hook of codexHooks) bundledHooks.push(await invokeReviewedHook('codex',hook));
  bundledHooks.push(await invokeReviewedHook('claude',JSON.parse(setup.claude.example).hooks.UserPromptSubmit[0].hooks[0]));

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
      const report={passed:true,releaseRoot:targetRoot,isolatedProfile:true,realRenderer:true,imagesDecoded:decoded,dualCompanions:true,greetings:true,interactions:true,setupRelocated:true,bundledRuntime:true,externalNodeRequired:false,rawEncodedPathsVerified:true,bundledHooks,hookHostDeadlineMs:3000,usageModulesOmitted:true,usageApiOmitted:true,usageIpcOmitted:true,usageUiOmitted:true,usageIoCalls:0,preexistingUsagePreserved:true,normalQuit:true,observationMilliseconds:Date.now()-started};
      fsSync.writeFileSync(path.join(root,'out/smoke/release.qa.json'),JSON.stringify(report,null,2)+'\n');
      try{fsSync.unlinkSync(path.join(root,'out/smoke/release.failure.txt'));}catch(error){if(error.code!=='ENOENT')throw error;}
      console.log(`No-counter release smoke passed: ${decoded} images decoded, ${bundledHooks.length} real bundled hooks work without external Node, dual pets and studio work, no counter APIs, IPC, UI, modules or storage calls (including normal quit).`);
    }catch(error){console.error(error.stack);app.exit(1);}
  });
  app.quit();
})().catch(error=>{
  for(const undo of restore.reverse())undo();
  fsSync.writeFileSync(path.join(root,'out/smoke/release.failure.txt'),error.stack+'\n');
  console.error(error.stack);
  app.exit(1);
});
