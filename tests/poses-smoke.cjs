'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const targetRoot = process.env.AIPET_SMOKE_APP_ROOT || root;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [];
let instance, pet;
let stamp = Date.now() - 1000;

async function until(predicate, description, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${description}`);
}

const run = source => pet.webContents.executeJavaScript(source);

async function slots() {
  return run(`(async()=>{const snapshot=await window.aipet.getSnapshot();return Array.from(document.querySelectorAll('.companion-slot[data-provider]'))
    .filter(slot => !slot.hidden).map(slot => ({
      provider:slot.dataset.provider, state:slot.dataset.state,
      src:slot.querySelector('img').getAttribute('src'),
      loaded:slot.querySelector('img').complete && slot.querySelector('img').naturalWidth > 0 &&
        window.PetPoses.candidates(snapshot.characters.find(character=>character.provider===slot.dataset.provider),slot.dataset.state).includes(slot.querySelector('img').getAttribute('src'))
    }));})()`);
}

async function rendered(expected) {
  await until(async () => {
    const value = await slots();
    return value.length === expected.length && value.every((slot, index) =>
      slot.provider === expected[index].provider && slot.state === expected[index].state && slot.loaded);
  }, `rendered ${expected.map(value => `${value.provider}:${value.state}`).join(', ')}`);
  return slots();
}

function ingest(provider, state) {
  const session = provider === 'claude' ? '11111111111111111111111111111111' : '22222222222222222222222222222222';
  stamp = Math.max(stamp + 1, Date.now());
  assert.equal(instance.activity.ingest({ version:1, provider, state, session, at:new Date(stamp).toISOString() }), true);
  instance.refreshVisibility();
}

async function advance(milliseconds) {
  await run(`window.__poseTestClock.advance(${milliseconds})`);
  // Only renderer time advances. Main-process activity validation and the host
  // clock are untouched; the normal renderer interval still performs the work.
  await sleep(650);
}

async function checkAlphaHit(provider) {
  const points = await run(`(() => {
    const image=document.querySelector('.companion-slot[data-provider=${provider}] img');
    const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
    const context=canvas.getContext('2d');context.drawImage(image,0,0);
    const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
    const {scale,left,top,crop}=window.PetArt.sourceGeometry(image);
    for(let y=Math.max(crop.y,Math.floor(canvas.height/3));y<crop.y+crop.height;y++)
      for(let x=Math.max(crop.x,Math.floor(canvas.width/3));x<crop.x+crop.width;x++)
        if(pixels[(y*canvas.width+x)*4+3]>200)
          return {opaque:{x:Math.floor(left+(x+.5)*scale),y:Math.floor(top+(y+.5)*scale)},clear:{x:0,y:0}};
    return null;
  })()`);
  assert.ok(points, `${provider} pose contains an opaque hit point`);
  const hits = [];
  const onHit = (_event, hit) => hits.push(hit);
  ipcMain.on('aipet:hit', onHit);
  try {
    pet.webContents.sendInputEvent({ type:'mouseMove', ...points.clear });
    await sleep(80);
    const start = hits.length;
    pet.webContents.sendInputEvent({ type:'mouseMove', ...points.opaque });
    await until(() => hits.slice(start).includes(true), `${provider} new image alpha hit mask`);
    pet.webContents.sendInputEvent({ type:'mouseMove', ...points.clear });
    await until(() => hits.slice(start).includes(false), `${provider} transparent margin click-through`);
  } finally { ipcMain.removeListener('aipet:hit', onHit); }
}

(async () => {
  assert.equal(process.env.AIPET_DESKTOP_TEST, '1');
  assert.ok(process.env.AIPET_TEST_DATA);
  assert.ok(process.argv.includes('--background'));
  instance = await require(path.join(targetRoot, 'src/main.cjs')).ready;
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  instance.updateSettings({ reducedMotion:true });
  assert.equal(instance.acceptPresence({ foreground:'codex', running:['claude','codex'], fullscreen:null }), true);
  pet = instance.getPet();
  assert.ok(pet);
  pet.setOpacity(0);
  pet.webContents.on('console-message', details => {
    if (details.level === 'error' && !/Content Security Policy|ERR_|security policy/i.test(details.message)) errors.push(details.message);
  });
  pet.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer gone: ${details.reason}`));
  await until(() => !pet.webContents.isLoading(), 'initial renderer');
  // Install a deterministic clock before production scripts run, without adding
  // a production test API, disabling sandboxing, or invoking host AI hooks.
  pet.webContents.debugger.attach('1.3');
  await pet.webContents.debugger.sendCommand('Page.enable');
  await pet.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source:`(() => {
    let now=Date.now(),random=0.31;Date.now=()=>now;
    window.__poseTestClock=Object.freeze({advance:milliseconds=>(now+=milliseconds),random:value=>(random=value)});
    Math.random=()=>random;
  })();` });
  pet.webContents.reload();
  await until(() => !pet.webContents.isLoading(), 'deterministic renderer reload');
  await rendered([{provider:'claude',state:'idle'},{provider:'codex',state:'idle'}]);
  assert.equal(await run('typeof window.__poseTestClock'), 'object');
  assert.equal(pet.webContents.getLastWebPreferences().sandbox, true);

  instance.updateSettings({reducedMotion:false});
  assert.equal(instance.acceptPresence({foreground:'codex',running:['codex'],fullscreen:null}),true);
  await sleep(400);
  await advance(3100);
  await rendered([{provider:'codex',state:'idle'}]);
  await sleep(400);
  assert.equal((await slots())[0].state,'idle','moving Codex into the first slot does not restart its greeting');
  assert.equal(instance.acceptPresence({foreground:'codex',running:['claude','codex'],fullscreen:null}),true);
  await rendered([{provider:'claude',state:'greet'},{provider:'codex',state:'idle'}]);
  await advance(2700);
  await rendered([{provider:'claude',state:'idle'},{provider:'codex',state:'idle'}]);

  ingest('claude','thinking');
  ingest('codex','coding');
  instance.updateSettings({reducedMotion:false});
  const initial = await rendered([{provider:'claude',state:'thinking'},{provider:'codex',state:'coding'}]);
  for(let index=0;index<8;index++) pet.webContents.send('aipet:changed',instance.snapshot());
  await sleep(350);
  assert.deepEqual((await slots()).map(value=>value.src), initial.map(value=>value.src), 'snapshot refreshes preserve the selected pose');
  await advance(30000);
  const rotated = await rendered([{provider:'claude',state:'thinking'},{provider:'codex',state:'coding'}]);
  assert.notEqual(rotated[0].src, initial[0].src, 'sustained thinking rotates to a different pose after its dwell');
  const gpt = instance.snapshot().characters.find(value=>value.id==='gpt');
  if(gpt.customMode==='replace') assert.notEqual(rotated[1].src,initial[1].src,'Codex independently rotates its new coding variants during sustained work');
  else assert.equal(rotated[1].src, initial[1].src, 'a single Codex coding pose remains stable');
  await checkAlphaHit('claude');

  const workPoses = {
    reading: ['reading-studious-v1', 'reading-page-turn-v1'],
    coding: ['coding-quill-v1', 'coding-review-v1'],
    tool: ['tool-inspect-v1', 'tool-adjust-v1'],
  };
  for (const [state, names] of Object.entries(workPoses)) {
    await run('window.__poseTestClock.random(0)');
    ingest('claude', state);
    const start = await rendered([{provider:'claude',state},{provider:'codex',state:'coding'}]);
    const pool = await run(`(async()=>window.PetPoses.candidates((await window.aipet.getSnapshot()).characters.find(character=>character.id==='claude'),${JSON.stringify(state)}))()`);
    assert.equal(pool.length, 3, `${state} has its original pose plus two custom variants`);
    for (const name of names) assert.ok(pool.some(value=>value.endsWith(`/claude/${name}.png`)), `${state} includes ${name}`);
    for (let index=0;index<8;index++) pet.webContents.send('aipet:changed',instance.snapshot());
    await sleep(350);
    assert.deepEqual((await slots()).map(value=>value.src),start.map(value=>value.src),`${state} remains stable across snapshot refreshes`);
    await advance(30000);
    const next = await rendered([{provider:'claude',state},{provider:'codex',state:'coding'}]);
    assert.notEqual(next[0].src,start[0].src,`sustained ${state} rotates without a new activity event`);
    assert.equal(next[1].state,'coding',`${state} rotation preserves Codex's independent activity`);
    await checkAlphaHit('claude');
    await run('window.__poseTestClock.random(0.99)');
    await advance(30000);
    const third = await rendered([{provider:'claude',state},{provider:'codex',state:'coding'}]);
    assert.deepEqual(new Set([start[0].src,next[0].src,third[0].src]),new Set(pool),`${state} can render every original and custom variant`);
    assert.equal(third[1].state,'coding',`${state} variety remains independent of Codex`);
    await checkAlphaHit('claude');
  }
  await run('window.__poseTestClock.random(0.31)');

  if(gpt.customMode==='replace') {
    const coverage=await run(`(async()=>{
      const snapshot=await window.aipet.getSnapshot(),gpt=snapshot.characters.find(c=>c.id==='gpt'),claude=snapshot.characters.find(c=>c.id==='claude');
      return Object.keys(window.PetPoses.poses).map(state=>({state,gpt:window.PetPoses.candidates(gpt,state,false),claude:window.PetPoses.candidates(claude,state,false).length}));
    })()`);
    assert.equal(coverage.length,22,'the GPT restyle supports the eighteen base states and four optional social states');
    for(const {state,gpt:pool,claude:count} of coverage) {
      assert.equal(pool.length,count,`${state} reaches Claude pose parity`);
      assert.ok(pool.every(value=>value.startsWith('../assets/custom/gpt/')),`${state} never mixes the original costume into the restyle`);
    }
    instance.updateSettings({reducedMotion:true});
    ingest('claude','idle');
    for(const state of ['idle','thinking','reading','coding','tool','waiting','success','error']) {
      ingest('codex',state);
      const value=await rendered([{provider:'claude',state:'idle'},{provider:'codex',state}]);
      assert.ok(value[1].src.startsWith('../assets/custom/gpt/'),`${state} displays only the approved GPT restyle`);
      const frame=await run(`(()=>{const image=document.querySelector('[data-provider="codex"] img');return {viewBox:image.style.objectViewBox,geometry:window.PetArt.sourceGeometry(image),width:image.naturalWidth,height:image.naturalHeight};})()`);
      assert.ok(frame.viewBox.startsWith('inset('),`${state} normalizes transparent image padding`);
      assert.equal(frame.geometry.crop.canvasWidth,frame.width);
      assert.equal(frame.geometry.crop.canvasHeight,frame.height);
      await checkAlphaHit('codex');
    }
    ingest('codex','idle');
    await rendered([{provider:'claude',state:'idle'},{provider:'codex',state:'idle'}]);
    const blink=await run(`(async()=>{
      const character=(await window.aipet.getSnapshot()).characters.find(c=>c.id==='gpt'),image=document.querySelector('[data-provider="codex"] img');
      await window.PetArt.setImage(image,character,'idle',window.PetArt.imagePath(character,'idle'));
      const before=image.getAttribute('src'),expected='../assets/custom/'+character.customBlink;
      const loaded=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Matching custom blink did not load')),1500);image.addEventListener('load',function done(){if(image.getAttribute('src')===expected){clearTimeout(timer);image.removeEventListener('load',done);resolve();}});});
      window.PetArt.blink(image,character);await loaded;const closed=image.getAttribute('src');
      await new Promise(resolve=>setTimeout(resolve,170));
      return {before,closed,after:image.getAttribute('src'),expected};
    })()`);
    assert.equal(blink.closed,blink.expected,'the restyled canonical idle uses only its matching custom blink');
    assert.equal(blink.after,blink.before,'blink restores the same new-style idle');
    ingest('codex','coding');
    instance.updateSettings({reducedMotion:false});
  }

  await run('window.aipet.interact("pat","claude")');
  const pat = await rendered([{provider:'claude',state:'pat'},{provider:'codex',state:'coding'}]);
  ingest('claude','reading');
  ingest('claude','coding');
  const stillPat = await rendered([{provider:'claude',state:'pat'},{provider:'codex',state:'coding'}]);
  assert.equal(stillPat[0].src, pat[0].src, 'incoming activity does not restart a brief petting pose');
  assert.equal(stillPat[1].src, pat[1].src, 'petting one provider leaves the other pose unchanged');
  await advance(3100);
  await rendered([{provider:'claude',state:'coding'},{provider:'codex',state:'coding'}]);

  await run('window.__poseTestClock.random(0.99);window.aipet.interact("pat","claude")');
  const secondPat = await rendered([{provider:'claude',state:'pat'},{provider:'codex',state:'coding'}]);
  const claude = instance.snapshot().characters.find(value=>value.id==='claude');
  if (claude.customPoses?.pat?.length) {
    assert.notEqual(secondPat[0].src,pat[0].src,'successive petting reactions avoid immediately repeating the same artwork');
    assert.ok(secondPat[0].src.includes('/custom/'),'the alternate petting pose uses the custom asset pool');
    await checkAlphaHit('claude');
  }
  await run('window.__poseTestClock.random(0.31)');
  ingest('claude','error');
  await rendered([{provider:'claude',state:'error'},{provider:'codex',state:'coding'}]);

  ingest('claude','idle');
  await rendered([{provider:'claude',state:'idle'},{provider:'codex',state:'coding'}]);
  await advance(80000);
  await until(async () => (await slots())[0].state !== 'idle', 'an occasional independent idle action');
  const playful = (await slots())[0];
  assert.notEqual(playful.state,'sleeping');
  await advance(50000);
  await rendered([{provider:'claude',state:'puffed'},{provider:'codex',state:'coding'}]);
  ingest('claude','idle');
  await rendered([{provider:'claude',state:'idle'},{provider:'codex',state:'coding'}]);
  ingest('claude','reading');
  await rendered([{provider:'claude',state:'reading'},{provider:'codex',state:'coding'}]);

  instance.updateSettings({reducedMotion:true});
  ingest('claude','idle');
  const quiet = await rendered([{provider:'claude',state:'idle'},{provider:'codex',state:'coding'}]);
  await advance(180000);
  const stillQuiet = await rendered([{provider:'claude',state:'idle'},{provider:'codex',state:'coding'}]);
  assert.equal(stillQuiet[0].src,quiet[0].src,'reduced motion suppresses automatic pose rotations and idle actions');
  assert.equal(await run('document.body.classList.contains("reduced-motion")'),true);
  for (const state of Object.keys(workPoses)) {
    ingest('claude',state);
    const start = await rendered([{provider:'claude',state},{provider:'codex',state:'coding'}]);
    await advance(60000);
    const held = await rendered([{provider:'claude',state},{provider:'codex',state:'coding'}]);
    assert.deepEqual(held.map(value=>value.src),start.map(value=>value.src),`reduced motion holds ${state} without automatic rotation`);
  }

  const decode = await run(`(async () => {
    const snapshot=await window.aipet.getSnapshot(),paths=new Set(),custom=new Set();
    for(const character of snapshot.characters){
      for(const path of Object.values(character.poses))paths.add('../assets/crosspet/'+path);
      for(const candidates of Object.values(character.customPoses||{}))for(const path of candidates){
        paths.add('../assets/custom/'+path);custom.add('../assets/custom/'+path);
      }
      if(character.customBlink){paths.add('../assets/custom/'+character.customBlink);custom.add('../assets/custom/'+character.customBlink);}
    }
    let transparent=0;
    for(const path of paths){
      const image=new Image();image.src=path;await image.decode();
      if(!image.naturalWidth||!image.naturalHeight)throw new Error('Empty image: '+path);
      if(custom.has(path)){
        const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
        const context=canvas.getContext('2d');context.drawImage(image,0,0);
        const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
        let clear=false,solid=false;for(let i=3;i<pixels.length;i+=4){clear||=pixels[i]===0;solid||=pixels[i]>200;if(clear&&solid)break;}
        if(!clear||!solid)throw new Error('Custom pose lacks transparent background or visible character: '+path);
        transparent++;
      }
    }
    return {decoded:paths.size,custom:custom.size,transparent};
  })()`);
  const customManifest=JSON.parse(await fs.readFile(path.join(targetRoot,'assets/custom/manifest.json'),'utf8'));
  assert.equal(decode.decoded,119+customManifest.poses.length,'all original and approved custom images decode in the sandboxed renderer');
  assert.equal(decode.custom,customManifest.poses.length,'every approved custom image, including the matching restyled blink, is available');
  assert.equal(decode.transparent,decode.custom,'every custom runtime image preserves a transparent background');
  await fs.writeFile(path.join(root,'out/smoke/poses.png'),(await pet.webContents.capturePage()).toPNG());
  const galleryPaths=Object.values(workPoses).flat().map(name=>`claude/${name}.png`);
  assert.equal(galleryPaths.length,6);
  for(const relative of galleryPaths) assert.ok(Object.values(claude.customPoses||{}).flat().includes(relative),`work gallery asset is registered: ${relative}`);
  if(galleryPaths.length){
    const galleryFile=path.join(root,'out/smoke/claude-work-poses.html');
    const rows=[['#eeece8','#38353b','LIGHT'],['#252831','#eeece8','DARK']].map(([background,color,label])=>
      `<section style="background:${background};color:${color}">${galleryPaths.map(relative=>{
        const source=pathToFileURL(path.join(targetRoot,'assets/custom',relative)).href;
        const caption=path.basename(relative).replace('-v1.png','');
        return `<article><img src="${source}" alt="${caption}"><span>${caption} · ${label}</span></article>`;
      }).join('')}</section>`).join('');
    await fs.writeFile(galleryFile,`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';img-src file:;style-src 'unsafe-inline';connect-src 'none'"><style>*{box-sizing:border-box}html,body{margin:0;overflow:hidden}main{width:100vw;height:100vh;display:grid;grid-template-rows:1fr 1fr}section{display:grid;grid-template-columns:repeat(${galleryPaths.length},1fr)}article{min-width:0;display:flex;align-items:center;justify-content:flex-end;flex-direction:column;padding:8px 6px 12px;border-right:1px solid #8883}img{display:block;width:100%;height:260px;object-fit:contain;object-position:center bottom}span{height:24px;padding-top:7px;font:11px Segoe UI,sans-serif;text-align:center}</style></head><body><main>${rows}</main></body></html>`);
    // A separate ephemeral session keeps this test-only gallery outside the
    // production renderer's file allowlist and does not add any runtime IPC.
    const galleryWindow=new BrowserWindow({width:1440,height:650,frame:false,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'aipet-pose-gallery'}});
    await galleryWindow.loadFile(galleryFile);
    galleryWindow.setOpacity(0);galleryWindow.showInactive();
    await galleryWindow.webContents.executeJavaScript('Promise.all([...document.images].map(image=>image.decode())).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
    await fs.writeFile(path.join(root,'out/smoke/claude-work-poses.png'),(await galleryWindow.webContents.capturePage()).toPNG());
    galleryWindow.destroy();
  }
  const socialStates=['aloof','wink','smug','sip'];
  const socialCharacters=instance.snapshot().characters.filter(character=>['claude','gpt'].includes(character.id));
  const socialCards=socialCharacters.flatMap(character=>socialStates.map(state=>({character:character.id,name:character.id==='gpt'?'ChatGPT':'Claude',state})));
  const socialFile=path.join(root,'out/smoke/social-poses.html');
  const socialRows=[['#eeece8','#38353b','Light'],['#252831','#eeece8','Dark']].map(([background,color,label])=>
    `<section style="background:${background};color:${color}">${socialCards.map(card=>`<article><img data-character="${card.character}" data-state="${card.state}"><span>${card.name} · ${card.state}<br>${label}</span></article>`).join('')}</section>`).join('');
  const rendererBase=pathToFileURL(path.join(targetRoot,'renderer')+path.sep).href;
  await fs.writeFile(socialFile,`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';img-src file:;script-src file:;style-src 'unsafe-inline';base-uri file:;connect-src 'none'"><base href="${rendererBase}"><style>*{box-sizing:border-box}html,body{margin:0;overflow:hidden}main{width:100vw;height:100vh;display:grid;grid-template-rows:1fr 1fr}section{display:grid;grid-template-columns:repeat(8,1fr)}article{min-width:0;display:flex;align-items:center;justify-content:flex-end;flex-direction:column;padding:8px 6px 12px;border-right:1px solid #8883}img{display:block;width:100%;height:260px;object-fit:contain;object-position:center bottom}span{height:36px;padding-top:7px;font:11px Segoe UI,sans-serif;text-align:center}</style><script src="pose-selector.js"></script><script src="shared.js"></script></head><body><main>${socialRows}</main></body></html>`);
  const socialWindow=new BrowserWindow({width:1760,height:650,frame:false,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'aipet-social-gallery'}});
  await socialWindow.loadFile(socialFile);
  socialWindow.setOpacity(0);socialWindow.showInactive();
  const socialRender=await socialWindow.webContents.executeJavaScript(`(async()=>{
    const characters=${JSON.stringify(socialCharacters)},results=[];
    for(const image of document.images){
      const character=characters.find(item=>item.id===image.dataset.character),state=image.dataset.state;
      const selected=window.PetArt.candidates(character,state,false)[0];
      if(!selected)throw new Error('Missing social pose: '+character.id+'/'+state);
      const committed=await window.PetArt.setImage(image,character,state,selected);
      await image.decode();
      const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
      const context=canvas.getContext('2d');context.drawImage(image,0,0);
      const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
      let clear=false,solid=false;for(let index=3;index<pixels.length;index+=4){clear||=pixels[index]===0;solid||=pixels[index]>200;if(clear&&solid)break;}
      results.push({character:character.id,state,selected,committed,width:image.naturalWidth,height:image.naturalHeight,clear,solid,alt:image.alt,framing:!!image.style.objectViewBox});
    }
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    return results;
  })()`);
  assert.equal(socialRender.length,16,'all four social states render for both characters on light and dark');
  for(const result of socialRender){
    assert.equal(result.committed,true,`${result.character}/${result.state} uses the actual PetArt image commit`);
    assert.ok(result.width>64&&result.height>64&&result.clear&&result.solid,`${result.character}/${result.state} contains a visible transparent character`);
    assert.ok(result.alt.length>0,`${result.character}/${result.state} has an accessible label`);
    if(result.character==='gpt')assert.equal(result.framing,true,`${result.state} keeps approved GPT framing`);
  }
  const socialScreenshot=path.join(root,'out/smoke/social-poses.png');
  await fs.writeFile(socialScreenshot,(await socialWindow.webContents.capturePage()).toPNG());
  await fs.writeFile(path.join(root,'out/smoke/social-poses.qa.json'),JSON.stringify({schemaVersion:1,rendered:socialRender,screenshot:socialScreenshot},null,2)+'\n');
  socialWindow.destroy();
  pet.webContents.debugger.detach();
  assert.deepEqual(errors,[]);
  instance.hidePet();
  console.log(`Pose smoke passed: stable snapshots, sustained thinking/reading/coding/tool variety, independent providers, pair/single-provider greeting recovery, brief petting and latest-activity restoration, prompt error/idle interruption, two-minute local pout and new-activity cancellation, reduced motion, updated source-alpha hit masks, and ${decode.decoded} decoded images (${decode.custom} transparent custom poses); ${galleryPaths.length} Claude work poses and all eight social poses captured on light/dark backgrounds.`);
  app.exit(0);
})().catch(error=>{console.error(error);app.exit(1);});
