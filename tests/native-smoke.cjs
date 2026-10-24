'use strict';
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { validatePresence } = require('../src/core/presence.cjs');
const root = path.resolve(__dirname, '..');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fixture, helper, instance;
const report = { schemaVersion: 1, measuredAt: new Date().toISOString(), status: 'running', checks: {}, limitations: [] };

async function cleanup() {
  if (helper) { helper.kill(); helper = null; }
  if (instance) instance.hidePet();
  if (fixture && !fixture.isDestroyed()) fixture.destroy();
}
const deadline = setTimeout(() => { cleanup().finally(() => app.exit(1)); }, 54000);
app.on('before-quit', () => clearTimeout(deadline));

async function until(predicate, timeout = 4000) {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) { if (await predicate()) return true; await sleep(80); }
  return false;
}
function handle(win) { return win ? win.getNativeWindowHandle().readBigUInt64LE().toString() : '0'; }
async function probe(point, pet = instance?.getPet()) {
  const physical = screen.dipToScreenPoint(point);
  return new Promise(resolve => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tests/window-probe.ps1'), '-X', String(physical.x), '-Y', String(physical.y), '-PetHandle', handle(pet), '-FixtureHandle', handle(fixture)], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(null); }, 5000);
    child.stderr.resume();
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); if (output.length > 2048) { child.kill(); finish(null); } });
    child.on('error', () => finish(null));
    child.on('close', code => { try { const value = JSON.parse(output); finish(code === 0 && ['hitPet', 'hitFixture', 'foregroundFixture'].every(key => typeof value[key] === 'boolean') ? value : null); } catch { finish(null); } });
  });
}
function contained(bounds, workArea) {
  return bounds.x >= workArea.x && bounds.y >= workArea.y && bounds.x + bounds.width <= workArea.x + workArea.width && bounds.y + bounds.height <= workArea.y + workArea.height;
}
function near(a, b) { return ['x', 'y', 'width', 'height'].every(key => Math.abs(a[key] - b[key]) <= 2); }

(async () => {
  if (process.env.AIPET_DESKTOP_TEST !== '1' || !process.env.AIPET_TEST_DATA || !process.argv.includes('--background')) throw new Error('Native QA requires an isolated background test instance.');
  instance = await require('../src/main.cjs').ready;
  report.initialWindows = BrowserWindow.getAllWindows().length;
  if (report.initialWindows !== 0) throw new Error('Background test created an unexpected window.');
  const displays = screen.getAllDisplays();
  report.displays = displays.map(display => ({ id: display.id, scaleFactor: display.scaleFactor, bounds: display.bounds, workArea: display.workArea }));
  report.monitorCount = displays.length;
  report.mixedDpiAvailable = new Set(displays.map(display => display.scaleFactor)).size > 1;
  if (!report.mixedDpiAvailable) report.limitations.push('Multiple differing monitor scale factors were unavailable; mixed-DPI behavior is not verified.');
  report.limitations.push('No physical display unplug/reconnect was performed; recovery invokes the real handler through a synthetic display-metrics event.');
  report.limitations.push('WindowFromPoint verifies native hit-test targets; no global mouse click or keyboard event is sent.');
  const routing = [];
  // This also removes animated transforms from source-alpha coordinate mapping.
  instance.updateSettings({ reducedMotion: true, fullscreenHide: false, autoDormant: true, followActivity: true, showBoth: true, edgeDock: false });
  instance.acceptPresence({ foreground: 'unknown', running: ['claude', 'codex'], fullscreen: null });
  instance.showPet();
  const pet = instance.getPet();
  if (!await until(() => !pet.webContents.isLoading())) throw new Error('Pet renderer did not load.');
  if (!await until(() => pet.webContents.executeJavaScript("[...document.querySelectorAll('.companion-slot:not([hidden])')].map(slot=>slot.dataset.provider).sort().join(',')==='claude,codex'"))) throw new Error('Both test companion slots did not render.');
  await pet.webContents.executeJavaScript('Promise.all([...document.images].map(image => image.decode().catch(() => {})))');
  const petSize = pet.getBounds();
  fixture = new BrowserWindow({ show: false, width: petSize.width, height: petSize.height, frame: false, resizable: true, fullscreenable: true, skipTaskbar: true, alwaysOnTop: true, focusable: false, backgroundColor: '#33404a', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false } });
  fixture.setOpacity(0.02);
  await fixture.loadURL('about:blank');
  for (const display of displays) {
    const area = display.workArea;
    if (area.width < petSize.width + 40 || area.height < petSize.height + 40) { routing.push({ displayId: display.id, status: 'inconclusive', reason: 'Monitor work area is too small for the duo fixture.' }); continue; }
    const bounds = { x: area.x + Math.min(80, area.width - petSize.width), y: area.y + Math.min(60, area.height - petSize.height), width: petSize.width, height: petSize.height };
    fixture.setBounds(bounds); fixture.showInactive(); fixture.moveTop();
    pet.setBounds(bounds); pet.showInactive(); pet.moveTop();
    await sleep(150);
    const points = await pet.webContents.executeJavaScript(`(() => {
      const slots=[...document.querySelectorAll('.companion-slot:not([hidden])')];
      const opaque=slots.map(slot=>{
        const image=slot.querySelector('.character-art'),canvas=document.createElement('canvas');
        canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const context=canvas.getContext('2d');context.drawImage(image,0,0);
        const alpha=context.getImageData(0,0,canvas.width,canvas.height).data;
        const {scale,left,top,crop}=window.PetArt.sourceGeometry(image);
        const margin=Math.max(2,Math.ceil(2/scale)),solid=(x,y)=>alpha[(y*canvas.width+x)*4+3]>200;
        for(let y=Math.max(crop.y+margin,Math.floor(canvas.height/2));y<crop.y+crop.height-margin;y++)for(let x=Math.max(crop.x+margin,Math.floor(canvas.width/2));x<crop.x+crop.width-margin;x++)if(solid(x,y)&&[-margin,margin].every(dx=>[-margin,margin].every(dy=>solid(x+dx,y+dy))))return {provider:slot.dataset.provider,x:Math.floor(left+(x+.5)*scale),y:Math.floor(top+(y+.5)*scale)};
        return null;
      });
      const first=slots[0].querySelector('.character-art').getBoundingClientRect(),second=slots[1].querySelector('.character-art').getBoundingClientRect();
      return {opaque,gap:{x:Math.floor((first.right+second.left)/2),y:Math.floor((Math.max(first.top,second.top)+Math.min(first.bottom,second.bottom))/2)}};
    })()`);
    if (points.opaque.length !== 2 || points.opaque.some(point => !point) || points.opaque.map(point => point.provider).sort().join(',') !== 'claude,codex') throw new Error('An opaque source-art fixture point was unavailable for one of the companions.');
    const providers = [];
    for (const opaque of points.opaque) {
      pet.webContents.sendInputEvent({ type: 'mouseMove', x: opaque.x, y: opaque.y });
      await sleep(180);
      const result = await probe({ x: bounds.x + opaque.x, y: bounds.y + opaque.y }, pet);
      providers.push({ provider: opaque.provider, opaqueHitsPet: result?.hitPet ?? null });
    }
    pet.webContents.sendInputEvent({ type: 'mouseMove', ...points.gap });
    await sleep(180);
    const gapResult = await probe({ x: bounds.x + points.gap.x, y: bounds.y + points.gap.y }, pet);
    pet.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 });
    await sleep(180);
    const blankResult = await probe({ x: bounds.x + 4, y: bounds.y + 4 }, pet);
    const conclusive = providers.every(item => typeof item.opaqueHitsPet === 'boolean') && gapResult && blankResult;
    routing.push({ displayId: display.id, scaleFactor: display.scaleFactor, status: !conclusive ? 'inconclusive' : providers.every(item => item.opaqueHitsPet) && gapResult.hitFixture && blankResult.hitFixture ? 'passed' : 'failed', providers, gapHitsFixture: gapResult?.hitFixture ?? null, blankHitsFixture: blankResult?.hitFixture ?? null });
  }
  report.checks.nativeRouting = routing;
  pet.setPosition(-50000, -50000);
  screen.emit('display-metrics-changed', {}, displays[0], ['workArea']);
  await sleep(120);
  const recovered = pet.getBounds();
  report.checks.displayRecovery = { status: displays.some(display => contained(recovered, display.workArea)) ? 'passed' : 'failed', method: 'Owned native window moved offscreen; application display-metrics handler invoked; resulting actual bounds checked against current work areas.' };

  // The only deliberately foregrounded window is this test's near-transparent
  // blank fixture. Closing it lets Windows restore prior focus naturally.
  instance.hidePet();
  fixture.setFocusable(true); fixture.show(); fixture.focus();
  let latest = null, messages = 0, buffer = '';
  helper = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'src/foreground.ps1')], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  helper.stderr.resume(); helper.on('error', () => {});
  helper.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8'); if (buffer.length > 4096) { buffer = ''; return; }
    let newline; while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { const value = JSON.parse(line); if (validatePresence(value)) { latest = value; messages++; } } catch {}
    }
  });
  const windowed = await until(() => latest && latest.fullscreen === null);
  const focusBefore = await probe({ x: fixture.getBounds().x + 10, y: fixture.getBounds().y + 10 }, null);
  fixture.setFullScreen(true); fixture.focus();
  const nativeTransition = await until(() => fixture.isFullScreen(), 2000);
  const fullscreen = await until(() => latest?.fullscreen !== null && latest?.fullscreen !== undefined);
  const bounds = fixture.getBounds();
  const focusDuring = await probe({ x: bounds.x + 10, y: bounds.y + 10 }, null);
  const reported = latest?.fullscreen ? screen.screenToDipRect(null, latest.fullscreen) : null;
  const expected = screen.getDisplayMatching(bounds).bounds;
  fixture.setFullScreen(false);
  const restored = await until(() => latest && latest.fullscreen === null);
  const ownForeground = focusBefore?.foregroundFixture && focusDuring?.foregroundFixture;
  report.checks.nativeFullscreen = { status: !focusBefore || !focusDuring || !ownForeground || !windowed || !nativeTransition || !focusDuring.fixtureCoversMonitor ? 'inconclusive' : fullscreen && reported && near(reported, expected) && restored ? 'passed' : 'failed', ownedFixtureForeground: Boolean(ownForeground), nativeTransition, fixtureCoversMonitor: focusDuring?.fixtureCoversMonitor ?? null, fixtureGeometryAvailable: focusDuring?.fixtureGeometryAvailable ?? null, detectedFullscreen: Boolean(fullscreen), matchesOwnMonitor: Boolean(reported && near(reported, expected)), clearsAfterWindowed: Boolean(restored), validHelperMessages: messages };
  await cleanup();
  report.finalWindows = BrowserWindow.getAllWindows().length;
  const statuses = [...routing.map(item => item.status), report.checks.displayRecovery.status, report.checks.nativeFullscreen.status];
  report.status = statuses.includes('failed') || report.finalWindows !== 0 ? 'failed' : statuses.includes('inconclusive') ? 'inconclusive' : 'passed';
  report.completedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, 'out/native-qa.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Native QA ${report.status}: ${report.monitorCount} monitor(s); routing ${routing.map(item => item.status).join(', ')}; fullscreen ${report.checks.nativeFullscreen.status}; final windows ${report.finalWindows}.`);
  app.exit(report.status === 'passed' ? 0 : report.status === 'inconclusive' ? 2 : 1);
})().catch(async error => {
  await cleanup(); report.status = 'failed'; report.error = error.message;
  await fs.writeFile(path.join(root, 'out/native-qa.json'), JSON.stringify(report, null, 2) + '\n').catch(() => {});
  console.error('Native QA failed:', error.message); app.exit(1);
});
