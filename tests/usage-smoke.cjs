'use strict';
const { app, BrowserWindow, powerMonitor } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const targetRoot = process.env.AIPET_SMOKE_APP_ROOT || root;
const data = process.env.AIPET_TEST_DATA;
const phase = process.env.AIPET_USAGE_PHASE;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const expectedFile = path.join(data, 'usage-smoke-expected.json');
const errors = [];
let instance, studio, pet;
let stamp = Date.now() - 1000;

async function until(predicate, description, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await predicate();
    if (result) return result;
    await sleep(35);
  }
  throw new Error(`Timed out: ${description}`);
}

function watch(win) {
  win.setOpacity(0);
  win.webContents.on('console-message', details => {
    if (details.level === 'error' && !/Content Security Policy|ERR_|security policy/i.test(details.message)) errors.push(details.message);
  });
  win.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer gone: ${details.reason}`));
}

const run = source => studio.webContents.executeJavaScript(source);
const runPet = source => pet.webContents.executeJavaScript(source);
const usage = () => run('window.aipet.getSpriteUsage()');

async function openStudio() {
  instance.openStudio();
  studio = instance.getStudio();
  watch(studio);
  studio.showInactive();
  await until(() => !studio.webContents.isLoading(), 'studio document load');
  await until(() => run('[...document.querySelectorAll("#character-picker img,#hero-art,#lab-art")].length===4 && [...document.querySelectorAll("#character-picker img,#hero-art,#lab-art")].every(image=>image.complete&&image.naturalWidth>0)'), 'studio artwork commits');
  assert.equal(await run('typeof window.require'), 'undefined');
  assert.equal(studio.webContents.getLastWebPreferences().sandbox, true);
}

async function petSlots() {
  return runPet(`Array.from(document.querySelectorAll('.companion-slot[data-provider]')).filter(slot=>!slot.hidden).map(slot=>({provider:slot.dataset.provider,state:slot.dataset.state,src:slot.querySelector('img').getAttribute('src'),loaded:slot.querySelector('img').complete&&slot.querySelector('img').naturalWidth>0}))`);
}

async function showPair() {
  instance.updateSettings({ reducedMotion:true, showBoth:true, followActivity:true });
  instance.acceptPresence({ foreground:'codex', running:['claude','codex'], fullscreen:null });
  instance.resumeAutomatic();
  pet = instance.getPet();
  watch(pet);
  await until(() => pet.isVisible() && !pet.webContents.isLoading(), 'desktop pet surface');
  await until(async () => {
    const slots = await petSlots();
    return slots.length === 2 && slots.every(slot=>slot.loaded) ? slots : null;
  }, 'both loaded companion images');
  return petSlots();
}

function ingest(provider, state) {
  stamp = Math.max(stamp + 1, Date.now());
  assert.equal(instance.activity.ingest({ version:1, provider, state, session:provider==='claude'?'1'.repeat(32):'2'.repeat(32), at:new Date(stamp).toISOString() }), true);
  instance.refreshVisibility();
}

async function setChoice(id, value) {
  await run(`(()=>{const input=document.querySelector(${JSON.stringify(id)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}

async function tableRows() {
  return run(`Array.from(document.querySelectorAll('#usage-rows tr[data-sprite-id]')).map(row=>({id:row.dataset.spriteId,count:row.querySelector('.usage-count').textContent,time:row.cells[3].textContent,share:row.querySelector('.usage-share').textContent,shareTitle:row.cells[4].title}))`);
}

function checkSnapshot(value, expectedImages) {
  assert.equal(value.rows.length, expectedImages, 'all bundled artwork gets a row, including zero-count and outside-rotation artwork');
  assert.equal(new Set(value.rows.map(row=>row.id)).size, expectedImages, 'aliases share a single physical asset row');
  assert.ok(value.rows.some(row=>!row.eligible && row.count===0), 'unused originals remain inspectable');
  assert.equal(value.totals.count, value.rows.reduce((sum,row)=>sum+row.count,0));
  assert.equal(value.totals.visibleMs, value.rows.reduce((sum,row)=>sum+row.visibleMs,0));
  for (const character of ['claude','gpt']) {
    const rows = value.rows.filter(row=>row.character===character);
    assert.equal(value.characters[character].count, rows.reduce((sum,row)=>sum+row.count,0));
    assert.equal(value.characters[character].visibleMs, rows.reduce((sum,row)=>sum+row.visibleMs,0));
    const totalShare = rows.reduce((sum,row)=>sum+row.timeShare,0);
    assert.ok(Math.abs(totalShare-(value.characters[character].visibleMs?1:0))<0.000001, 'time shares use the individual companion denominator');
    for (const row of rows) {
      assert.ok(Number.isSafeInteger(row.count) && row.count>=0);
      assert.ok(Number.isSafeInteger(row.visibleMs) && row.visibleMs>=0);
      assert.ok(row.timeShare>=0 && row.timeShare<=1);
      assert.match(row.hash,/^[a-f0-9]{64}$/);
      assert.match(row.url,/^\.\.\/assets\/(crosspet|custom)\//);
    }
  }
}

async function frozenTime(description, action, duration = 700) {
  await action();
  await sleep(70);
  const before = await usage();
  await sleep(duration);
  const after = await usage();
  assert.equal(after.totals.visibleMs,before.totals.visibleMs,description);
  return after;
}

(async () => {
  assert.equal(process.env.AIPET_DESKTOP_TEST,'1');
  assert.ok(data && path.isAbsolute(data));
  assert.ok(['collect','restart'].includes(phase));
  assert.ok(process.argv.includes('--background'));
  instance = await require(path.join(targetRoot,'src/main.cjs')).ready;
  assert.equal(BrowserWindow.getAllWindows().length,0,'background tests start dormant without AI hooks');
  await openStudio();
  const custom = JSON.parse(await fs.readFile(path.join(targetRoot,'assets/custom/manifest.json'),'utf8'));
  const expectedImages = 119 + custom.poses.length;
  const initial = await usage();
  checkSnapshot(initial,expectedImages);

  if (phase==='restart') {
    const expected = JSON.parse(await fs.readFile(expectedFile,'utf8'));
    assert.ok(expected.totals.count>0 && expected.totals.visibleMs>0,'first run saved real visible exposures');
    assert.deepEqual(initial.totals,expected.totals,'aggregates survive an actual Electron restart without adding offline time');
    assert.equal(initial.startedAt,expected.startedAt,'restart preserves the observation period');
    for (const row of initial.rows) {
      const before=expected.rows.find(entry=>entry.id===row.id);
      assert.equal(row.count,before.count);
      assert.equal(row.visibleMs,before.visibleMs);
    }
    await sleep(350);
    assert.deepEqual((await usage()).totals,expected.totals,'studio-only restart adds no exposures or pet time');
    const bytes=await fs.readFile(path.join(data,'sprite-usage.json'));
    assert.ok(bytes.length<256*1024,'persistent counter store is bounded');
    const saved=JSON.parse(bytes);
    assert.deepEqual(Object.keys(saved).sort(),['entries','savedAt','startedAt','version']);
    assert.equal(saved.entries.length,expectedImages);
    for(const entry of saved.entries) assert.deepEqual(Object.keys(entry).sort(),['count','hash','id','visibleMs']);
    const report={passed:true,packaged:targetRoot!==root,images:expectedImages,eligible:initial.rows.filter(row=>row.eligible).length,counts:initial.totals.count,persistedBytes:bytes.length,realRenderer:true,studioExcluded:true,visibilityPaused:true,blinkTracked:true,aliasAggregated:true,uiSortFilterReset:true,restartRetained:true};
    await fs.writeFile(path.join(root,'out/smoke',targetRoot===root?'sprite-usage.qa.json':'sprite-usage-packaged.qa.json'),JSON.stringify(report,null,2)+'\n');
    assert.deepEqual(errors,[]);
    console.log(`Sprite usage restart smoke passed: ${expectedImages} artwork rows, bounded private aggregate, exact persisted counts/time, no offline or studio time.`);
    return app.quit();
  }

  assert.equal(initial.totals.count,0,'studio hero and picker artwork are not counted');
  assert.equal(initial.totals.visibleMs,0);
  await run('document.querySelector("[data-view=usage]").click()');
  await until(async ()=>(await tableRows()).length===initial.rows.filter(row=>row.eligible).length,'eligible zero rows in usage table');
  await sleep(200);
  assert.deepEqual((await usage()).totals,{count:0,visibleMs:0},'usage thumbnails and reads do not count as pet displays');

  const slots = await showPair();
  const first = await until(async()=>{const value=await usage();return value.totals.count>=2?value:null;},'two actual desktop image exposures');
  assert.equal(first.totals.count,2,'one committed display per companion');
  for(const slot of slots) {
    const row=first.rows.find(row=>row.url===slot.src);
    assert.ok(row,`rendered ${slot.provider} image is registered`);
    assert.equal(row.count,1);
  }
  for(let index=0;index<10;index++)pet.webContents.send('aipet:changed',instance.snapshot());
  await sleep(700);
  const stable=await usage();
  assert.equal(stable.totals.count,2,'snapshot refreshes and visible-image heartbeats never recount the same display');
  for(const character of ['claude','gpt'])assert.ok(stable.characters[character].visibleMs-first.characters[character].visibleMs>=350,'two visible companions accrue time independently');
  const claudeAsset=stable.rows.find(row=>row.url===slots[0].src);
  assert.equal(await run(`window.aipet.reportSpriteUsage([{provider:'claude',sprite:${JSON.stringify(claudeAsset.id)}}]).then(()=>false,()=>true)`),true,'studio cannot forge pet display reports');
  assert.equal(await runPet('window.aipet.resetSpriteUsage().then(()=>false,()=>true)'),true,'pet cannot reset persistent usage');
  for(const input of [null,{},[{provider:'claude',sprite:'custom/claude/../../settings.json'}],[{provider:'codex',sprite:claudeAsset.id}],[{provider:'claude',sprite:claudeAsset.id,elapsed:9999}],Array.from({length:3},()=>({provider:'claude',sprite:claudeAsset.id}))]){
    assert.equal(await runPet(`window.aipet.reportSpriteUsage(${JSON.stringify(input)})`),false,'malformed, unknown, wrong-provider, elapsed or oversized reports are rejected');
  }
  assert.equal((await usage()).totals.count,stable.totals.count,'rejected IPC cannot create a display');

  // A source attribute alone is insufficient: a failed or still-unloaded
  // image must never become a recorded display. Restore the same source below.
  const gptBeforeFailure=stable.characters.gpt.count;
  await runPet(`(()=>{const image=document.querySelector('[data-provider=codex] img');image.src='../assets/custom/gpt/missing-usage-test.png';})()`);
  await until(()=>runPet(`(()=>{const image=document.querySelector('[data-provider=codex] img');return image.complete&&image.naturalWidth===0;})()`),'failed image decode');
  assert.equal((await usage()).characters.gpt.count,gptBeforeFailure,'failed image source never becomes an exposure');
  await runPet(`(async()=>{const image=document.querySelector('[data-provider=codex] img');image.src=${JSON.stringify(slots[1].src)};await image.decode();})()`);
  await until(async()=>{const entries=await petSlots();return entries[1].loaded;},'restored loaded image');
  const restored=await until(async()=>{const value=await usage();return value.characters.gpt.count>gptBeforeFailure?value:null;},'restored image exposure');

  ingest('claude','reading');
  await until(async()=>{const entries=await petSlots();return entries[0].state==='reading'&&entries[0].loaded;},'real Claude activity changes artwork');
  const changed=await until(async()=>{const value=await usage();return value.characters.claude.count===2?value:null;},'changed Claude artwork display');
  assert.equal(changed.characters.gpt.count,restored.characters.gpt.count,'Claude artwork change leaves Codex exposure count alone');

  // Minimize is test-only because the borderless companion normally disallows
  // minimizing. Its real native visibility events must still pause collection.
  pet.setMinimizable(true);
  await frozenTime('minimized desktop pets add no visible time',async()=>{pet.minimize();await until(()=>pet.isMinimized(),'native minimized state');});
  pet.restore();
  await until(()=>!pet.isMinimized(),'native restored state');
  await sleep(500);
  const beforeSuspend=await usage();
  await frozenTime('suspended computer adds no visible time',async()=>powerMonitor.emit('suspend'));
  powerMonitor.emit('resume');
  await sleep(500);
  assert.ok((await usage()).totals.visibleMs>beforeSuspend.totals.visibleMs,'native resume permits new visible time');

  // The closed eyelid is an actual loaded image, with its own short exposure.
  // Use the production art helper rather than inventing an activity event.
  ingest('claude','idle');ingest('codex','idle');
  await until(async()=>(await petSlots()).every(slot=>slot.state==='idle'&&slot.loaded),'idle artwork before blink');
  await runPet(`(async()=>{const character=(await window.aipet.getSnapshot()).characters.find(c=>c.id==='gpt'),image=document.querySelector('[data-provider=codex] img');await window.PetArt.setImage(image,character,'idle',window.PetArt.imagePath(character,'idle'));await image.decode();})()`);
  await sleep(90);
  const beforeBlink=await usage();
  await runPet(`(async()=>{const character=(await window.aipet.getSnapshot()).characters.find(c=>c.id==='gpt');window.PetArt.blink(document.querySelector('[data-provider=codex] img'),character);})()`);
  await until(async()=>{const value=await usage();return value.rows.some(row=>row.character==='gpt'&&row.blink&&row.count>0);},'actual custom blink exposure');
  await sleep(210);
  const afterBlink=await usage();
  const blink=afterBlink.rows.find(row=>row.character==='gpt'&&row.blink&&row.count>0);
  assert.equal(blink.count,1);
  assert.ok(blink.visibleMs>0 && blink.visibleMs<500,'blink accumulates its real short visible time');
  assert.ok(afterBlink.totals.count>=beforeBlink.totals.count+2,'closed eyes and restored open eyes each begin a visible exposure');

  const alias=afterBlink.rows.find(row=>row.character==='gpt'&&row.states.includes('greet')&&row.states.includes('wink'));
  assert.ok(alias,'greeting/wink aliases appear together on one asset row');
  const aliasBefore=alias.count;
  await runPet(`(async()=>{const character=(await window.aipet.getSnapshot()).characters.find(c=>c.id==='gpt'),image=document.querySelector('[data-provider=codex] img');await window.PetArt.setImage(image,character,'greet',${JSON.stringify(alias.url)});await image.decode();})()`);
  await until(async()=>(await usage()).rows.find(row=>row.id===alias.id).count===aliasBefore+1,'shared greeting asset display');
  await runPet(`(async()=>{const character=(await window.aipet.getSnapshot()).characters.find(c=>c.id==='gpt'),image=document.querySelector('[data-provider=codex] img');await window.PetArt.setImage(image,character,'wink',${JSON.stringify(alias.url)});})()`);
  assert.equal((await usage()).rows.find(row=>row.id===alias.id).count,aliasBefore+1,'a state alias with the same visible image does not add a display');

  const beforePreview=await usage();
  await run('window.aipet.preview("success")');
  const previewActivity=instance.snapshot().companions.find(companion=>companion.preview);
  assert.ok(previewActivity,'studio starts a real preview on its selected companion');
  await until(async()=>(await petSlots()).some(slot=>slot.provider===previewActivity.provider&&slot.state==='success'&&slot.loaded),'studio activity preview artwork');
  await sleep(70);
  const previewStart=await usage();
  await sleep(400);
  const previewEnd=await usage();
  assert.equal(previewEnd.characters[previewActivity.character].count,beforePreview.characters[previewActivity.character].count,'studio-triggered pet preview adds no recorded display');
  assert.equal(previewEnd.characters[previewActivity.character].visibleMs,previewStart.characters[previewActivity.character].visibleMs,'studio-triggered pet preview adds no visible pet time');

  const hidden=await frozenTime('hidden/destroyed pet renderers add no visible time',async()=>instance.hidePet());
  assert.equal(instance.getPet(),null);
  checkSnapshot(hidden,expectedImages);
  await run('document.querySelector("#usage-refresh").click()');
  await until(()=>run('document.querySelector("#usage-refresh").disabled===false'),'usage refresh settled');
  for(const row of await tableRows()){
    const expected=hidden.rows.find(entry=>entry.id===row.id);
    assert.equal(Number(row.count.replaceAll(',','')),expected.count,'ranking displays the exact raw count for its asset');
    assert.ok(row.share.endsWith('%'));
    assert.ok(row.shareTitle.includes(expected.character==='gpt'?'ChatGPT':'Claude'),'share explains its per-companion denominator');
    if(expected.blink&&expected.visibleMs>0&&expected.visibleMs<1000)assert.equal(row.time,'<1s','short blinks retain visible subsecond time in the UI');
  }
  for(const [sort,field,descending] of [['count','count',false],['time','visibleMs',false],['share','timeShare',false],['most-count','count',true],['most-time','visibleMs',true]]){
    await setChoice('#usage-sort',sort);
    const table=await tableRows(),lookup=new Map(hidden.rows.map(row=>[row.id,row]));
    assert.equal(table.length,hidden.rows.filter(row=>row.eligible).length);
    for(let index=1;index<table.length;index++){
      const difference=lookup.get(table[index].id)[field]-lookup.get(table[index-1].id)[field];
      assert.ok(descending?difference<=0:difference>=0,`${sort} ranks the actual aggregate`);
    }
  }
  await setChoice('#usage-scope','all');
  assert.equal((await tableRows()).length,expectedImages,'all-artwork mode exposes never-selected originals');
  await setChoice('#usage-character','gpt');
  assert.equal((await tableRows()).length,hidden.rows.filter(row=>row.character==='gpt').length,'character filter includes all ChatGPT artwork');
  await setChoice('#usage-character','claude');
  const claudeTable=await tableRows();
  assert.equal(claudeTable.length,hidden.rows.filter(row=>row.character==='claude').length);
  assert.equal(Number((await run('document.querySelector("#usage-total-count").textContent')).replaceAll(',','')),hidden.characters.claude.count);
  await setChoice('#usage-character','all');await setChoice('#usage-scope','eligible');await setChoice('#usage-sort','count');
  await run('window.scrollTo(0,0)');
  await until(()=>run(`Array.from(document.querySelectorAll('#usage-rows img')).filter(image=>{const box=image.getBoundingClientRect();return box.bottom>0&&box.top<innerHeight;}).every(image=>image.complete&&image.naturalWidth>0)`),'visible usage thumbnails');
  await fs.writeFile(path.join(root,'out/smoke',targetRoot===root?'sprite-usage-live.png':'sprite-usage-live-packaged.png'),(await studio.webContents.capturePage()).toPNG());

  await run('document.querySelector("#usage-reset-open").click()');
  assert.equal(await run('document.querySelector("#usage-reset-confirm").hidden'),false);
  assert.deepEqual((await usage()).totals,hidden.totals,'opening reset confirmation preserves counters');
  await run('document.querySelector("#usage-reset-cancel").click()');
  assert.equal(await run('document.querySelector("#usage-reset-confirm").hidden'),true);
  assert.deepEqual((await usage()).totals,hidden.totals,'canceling reset preserves counters');
  await run('document.querySelector("#usage-reset-open").click();document.querySelector("#usage-reset-confirm-button").click()');
  await until(()=>run('document.querySelector("#usage-reset-confirm").hidden'),'confirmed reset');
  const reset=await usage();
  assert.deepEqual(reset.totals,{count:0,visibleMs:0},'confirmed reset clears the hidden observation period');
  assert.ok(Date.parse(reset.startedAt)>=Date.parse(hidden.startedAt));

  // Leave nonzero data for a second real Electron process to verify persistence.
  await showPair();
  await until(async()=>(await usage()).totals.count===2,'new observation period after reset');
  await sleep(450);
  instance.hidePet();
  const saved=await usage();
  assert.ok(saved.totals.visibleMs>0);
  await fs.writeFile(expectedFile,JSON.stringify(saved)+'\n');
  assert.deepEqual(errors,[]);
  console.log(`Sprite usage collect smoke passed: ${expectedImages} bundled rows, real loaded commits, independent companions, deduplicated refreshes, blink/alias accounting, visibility pauses, and ranking/reset UI.`);
  app.quit();
})().catch(error=>{console.error(error);if(instance)instance.hidePet();app.exit(1);});
