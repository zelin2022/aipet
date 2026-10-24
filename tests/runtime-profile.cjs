'use strict';
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '..');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = n => Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
let ownedHelper;
const safetyDeadline = setTimeout(() => {
  if (ownedHelper) ownedHelper.kill();
  console.error('Runtime profile exceeded its internal deadline.');
  app.exit(1);
}, 140000);
app.on('before-quit', () => clearTimeout(safetyDeadline));

function runJson(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let data = Buffer.alloc(0), done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(null); }, 12000);
    child.stdout.on('data', chunk => { if (data.length + chunk.length > 16384) { child.kill(); finish(null); } else data = Buffer.concat([data, chunk]); });
    child.stderr.resume();
    child.on('error', () => finish(null));
    child.on('close', code => { if (code !== 0) return finish(null); try { finish(JSON.parse(data.toString('utf8').trim())); } catch { finish(null); } });
  });
}

async function networkSnapshot() {
  const pids = app.getAppMetrics().map(item => item.pid).filter(pid => Number.isSafeInteger(pid) && pid > 0);
  if (!pids.length) return { status: 'unavailable', reason: 'No owned process IDs.', checkedProcesses: 0 };
  // Numeric IDs originate exclusively in this Electron application's own metrics.
  // No system-wide connection query, remote address or port is serialized.
  const result = await runJson(`
$ErrorActionPreference = 'Stop'
$taskPids = [uint32[]] @(${pids.join(',')})
try {
  if (!(Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) -or !(Get-Command Get-NetUDPEndpoint -ErrorAction SilentlyContinue)) { throw 'cmdlets-unavailable' }
  $taskTcp = @()
  $taskUdp = @()
  try { $taskTcp = @(Get-NetTCPConnection -OwningProcess $taskPids -ErrorAction Stop) }
  catch { if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw } }
  try { $taskUdp = @(Get-NetUDPEndpoint -OwningProcess $taskPids -ErrorAction Stop) }
  catch { if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw } }
  @{status='ok';checkedProcesses=$taskPids.Length;tcpConnections=$taskTcp.Length;tcpEstablished=@($taskTcp | Where-Object State -eq Established).Length;tcpListening=@($taskTcp | Where-Object State -eq Listen).Length;udpEndpoints=$taskUdp.Length} | ConvertTo-Json -Compress
} catch { @{status='unavailable';reason='NetTCPIP query failed or access was denied';checkedProcesses=$taskPids.Length} | ConvertTo-Json -Compress }
`);
  return result || { status: 'unavailable', reason: 'NetTCPIP query timed out or returned invalid output.', checkedProcesses: pids.length };
}

function metrics() {
  return app.getAppMetrics().map(item => ({ pid: item.pid, type: item.type,
    cpuPercent: round(item.cpu.percentCPUUsage), cpuSeconds: item.cpu.cumulativeCPUUsage ?? null,
    workingSetKiB: item.memory.workingSetSize, privateBytesKiB: item.memory.privateBytes ?? null }));
}

async function phase(instance, name, expectedWindows, expectedCompanions = 1) {
  await sleep(2000);
  const initial = metrics(), started = performance.now();
  const samples = [];
  for (let index = 0; index < 5; index++) {
    await sleep(1000);
    const processes = metrics();
    samples.push({ elapsedMs: round(performance.now() - started), windows: BrowserWindow.getAllWindows().length,
      cpuPercentSum: round(processes.reduce((sum, item) => sum + item.cpuPercent, 0)),
      workingSetMiB: round(processes.reduce((sum, item) => sum + item.workingSetKiB, 0) / 1024), processes });
  }
  const elapsedMs = performance.now() - started, final = samples.at(-1).processes;
  const stable = initial.length === final.length && initial.every(item => final.some(other => other.pid === item.pid));
  let previous = { elapsedMs: 0, processes: initial }, cpuSeconds = 0, cpuMeasuredMs = 0, counterAnomalyIntervals = 0;
  for (const sample of samples) {
    const comparable = sample.processes.length === previous.processes.length && sample.processes.every(item => {
      const before = previous.processes.find(other => other.pid === item.pid);
      return before && Number.isFinite(item.cpuSeconds) && Number.isFinite(before.cpuSeconds) && item.cpuSeconds >= before.cpuSeconds;
    });
    if (comparable) {
      cpuSeconds += sample.processes.reduce((sum, item) => sum + item.cpuSeconds - previous.processes.find(other => other.pid === item.pid).cpuSeconds, 0);
      cpuMeasuredMs += sample.elapsedMs - previous.elapsedMs;
    } else counterAnomalyIntervals++;
    previous = sample;
  }
  const cpuSamples = samples.filter(sample => sample.processes.every(item => Number.isFinite(item.cpuPercent) && item.cpuPercent >= 0));
  assert.equal(BrowserWindow.getAllWindows().length, expectedWindows, `${name}: unexpected BrowserWindow count`);
  if (expectedWindows) assert.equal(instance.snapshot().companions.length, expectedCompanions, `${name}: unexpected companion count`);
  const result = { name, warmupMs: 2000, elapsedMs: round(elapsedMs), expectedWindows,
    sourceState: instance.snapshot().activity.state, visibility: instance.snapshot().visibility,
    renderedCompanionCount: expectedWindows ? instance.snapshot().companions.length : 0,
    sourceCompanions: instance.snapshot().companions.map(({ provider, character, state }) => ({ provider, character, state })),
    settings: { ...instance.snapshot().settings }, stableProcessSet: stable, initialMetrics: initial, samples,
    summary: {
      electronCpuPercentMean: cpuSamples.length ? round(cpuSamples.reduce((sum, item) => sum + item.cpuPercentSum, 0) / cpuSamples.length) : null,
      electronCpuPercentMax: cpuSamples.length ? round(Math.max(...cpuSamples.map(item => item.cpuPercentSum))) : null,
      singleCoreCpuPercent: cpuMeasuredMs ? round(cpuSeconds / (cpuMeasuredMs / 1000) * 100) : null,
      machineCpuPercent: cpuMeasuredMs ? round(cpuSeconds / (cpuMeasuredMs / 1000) * 100 / os.cpus().length) : null,
      cpuMeasuredMs: round(cpuMeasuredMs), counterAnomalyIntervals,
      workingSetMiBMean: round(samples.reduce((sum, item) => sum + item.workingSetMiB, 0) / samples.length),
      workingSetMiBPeak: Math.max(...samples.map(item => item.workingSetMiB)),
      privateBytesMiBMean: round(samples.reduce((sum, item) => sum + item.processes.reduce((bytes, process) => bytes + (process.privateBytesKiB || 0), 0) / 1024, 0) / samples.length),
      processCountLast: final.length,
    }, network: await networkSnapshot() };
  // The profile needs appearance/behavior settings, not the user's desktop coordinates.
  delete result.settings.position;
  console.log(`Profile ${name}: ${result.summary.workingSetMiBMean} MiB summed working set; ${result.summary.singleCoreCpuPercent ?? result.summary.electronCpuPercentMean}% CPU; ${expectedWindows} windows, ${result.renderedCompanionCount} companions; network ${result.network.status}.`);
  return result;
}

async function helperStats(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return runJson(`
$ErrorActionPreference='Stop'
try {
  $taskProcess=[System.Diagnostics.Process]::GetProcessById(${pid})
  try { @{cpuMilliseconds=$taskProcess.TotalProcessorTime.TotalMilliseconds;workingSetBytes=$taskProcess.WorkingSet64} | ConvertTo-Json -Compress }
  finally { $taskProcess.Dispose() }
} catch { exit 1 }
`);
}

async function profileHelper() {
  const spawnedAt = performance.now();
  let messages = 0, firstMessageMs = null, stderrBytes = 0, buffer = '', exited = false;
  ownedHelper = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'src/foreground.ps1')], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const helper = ownedHelper;
  helper.on('error', () => { exited = true; }); helper.on('exit', () => { exited = true; });
  helper.stderr.on('data', chunk => { stderrBytes += chunk.length; });
  helper.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 4096) { buffer = ''; return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { if (require('../src/core/presence.cjs').validatePresence(JSON.parse(line))) { messages++; if (firstMessageMs === null) firstMessageMs = round(performance.now() - spawnedAt); } } catch {}
    }
  });
  try {
    const deadline = performance.now() + 5000;
    while (!messages && !exited && performance.now() < deadline) await sleep(100);
    if (!messages || exited) return { status: 'unavailable', reason: 'Owned helper did not emit valid metadata.', stderrBytes };
    await sleep(2000);
    const before = await helperStats(helper.pid), started = performance.now();
    await sleep(5000);
    const after = await helperStats(helper.pid), durationMs = performance.now() - started;
    if (!before || !after || exited) return { status: 'unavailable', reason: 'Owned helper process metrics were unavailable.', stderrBytes };
    return { status: 'ok', firstMessageMs, validMetadataMessages: messages, stderrBytes,
      sampledMs: round(durationMs), singleCoreCpuPercent: round((after.cpuMilliseconds - before.cpuMilliseconds) / durationMs * 100),
      machineCpuPercent: round((after.cpuMilliseconds - before.cpuMilliseconds) / durationMs * 100 / os.cpus().length),
      workingSetMiB: round(after.workingSetBytes / 1024 / 1024),
      method: 'Exact owned helper PID, TotalProcessorTime delta and WorkingSet64; startup compilation excluded.' };
  } finally {
    helper.kill(); ownedHelper = null;
    if (!exited) await Promise.race([new Promise(resolve => helper.once('exit', resolve)), sleep(2000)]);
  }
}

(async () => {
  assert.equal(process.env.AIPET_DESKTOP_TEST, '1');
  assert.ok(process.env.AIPET_TEST_DATA);
  assert.equal(process.env.USERPROFILE, process.env.AIPET_TEST_DATA, 'profile must redirect the Windows user profile to its isolated temporary directory');
  assert.ok(process.argv.includes('--background'));
  const instance = await require('../src/main.cjs').ready;
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  instance.acceptPresence({ foreground: 'unknown', running: [], fullscreen: null });
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  const report = { schemaVersion: 1, measuredAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    os: os.version(), versions: { app: metadata.version, harnessApp: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    machine: { logicalCpuCount: os.cpus().length, totalMemoryMiB: Math.round(os.totalmem() / 1024 / 1024) },
    method: { testMode: true, isolatedInbox: true, isolatedUserProfile: true, command: 'Electron test harness --background', samplesPerPhase: 5, sampleIntervalMs: 1000, warmupMs: 2000,
      cpu: 'app.getAppMetrics percentCPUUsage sum and stable-PID cumulativeCPUUsage delta; single-core percentage is CPU seconds / wall seconds * 100.',
      memory: 'Sum of per-process workingSetSize in KiB / 1024; shared pages can be counted repeatedly.',
      network: 'Per-phase Windows NetTCPIP snapshots restricted by -OwningProcess to current app.getAppMetrics PIDs; counts only, no packet capture.',
      caveats: ['No tray or startup query in TEST mode; foreground helper measured separately.', 'Renderer backgroundThrottling is false in TEST mode.', 'Non-monotonic or missing cumulative CPU counter intervals are excluded and counted; negative framework percentages remain only in raw samples.', 'Five-second phase samples on a shared development machine are not long-duration benchmarks.', 'Connection snapshots cannot prove absence of short-lived traffic, DNS packets or all runtime network activity.'] }, phases: [] };
  report.phases.push(await phase(instance, 'dormant_initial', 0));
  instance.showPet();
  report.phases.push(await phase(instance, 'pet_idle', 1));
  const bridge = await import(pathToFileURL(path.join(root, 'integrations/activity.mjs')).href);
  const file = await bridge.writeEvent(bridge.createEvent('codex', 'coding', 'isolated-runtime-profile'), path.join(instance.dataDirectory, 'events'));
  await instance.pollEvents();
  assert.equal(instance.snapshot().activity.state, 'coding');
  report.phases.push(await phase(instance, 'pet_coding', 1));
  const claudeFile = await bridge.writeEvent(bridge.createEvent('claude', 'reading', 'isolated-duet-profile'), path.join(instance.dataDirectory, 'events'));
  assert.equal(instance.acceptPresence({ foreground: 'codex', running: ['claude', 'codex'], fullscreen: null }), true);
  await instance.pollEvents();
  assert.deepEqual(instance.snapshot().companions.map(({provider, state}) => ({provider, state})), [
    {provider:'claude', state:'reading'}, {provider:'codex', state:'coding'}
  ]);
  const duetDeadline = performance.now() + 5000;
  let duetRendered = false;
  while (!duetRendered && performance.now() < duetDeadline) {
    duetRendered = await instance.getPet().webContents.executeJavaScript(`Array.from(document.querySelectorAll('.companion-slot[data-provider]')).filter(slot => !slot.hidden).length === 2 && [...document.images].every(image => image.complete && image.naturalWidth > 0)`);
    if (!duetRendered) await sleep(50);
  }
  assert.equal(duetRendered, true, 'both original character images must render before measuring duet activity');
  report.phases.push(await phase(instance, 'pet_duet_reading_coding', 1, 2));
  await fs.unlink(claudeFile);
  for (const [key, event] of instance.activity.sessions) if (event.provider === 'claude') instance.activity.sessions.delete(key);
  assert.equal(instance.acceptPresence({ foreground: 'codex', running: ['codex'], fullscreen: null }), true);
  instance.updateSettings({ reducedMotion: true });
  report.phases.push(await phase(instance, 'pet_reduced_motion', 1));
  await fs.unlink(file);
  instance.activity.sessions.clear(); instance.presence.lastSeen = -Infinity;
  instance.acceptPresence({ foreground: 'unknown', running: [], fullscreen: null });
  instance.resumeAutomatic();
  report.phases.push(await phase(instance, 'dormant_return', 0));
  report.foregroundHelper = await profileHelper();
  report.completedAt = new Date().toISOString();
  await fs.mkdir(path.join(root, 'out'), { recursive: true });
  await fs.writeFile(path.join(root, 'out/performance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Runtime profile saved to out/performance.json. Helper: ${report.foregroundHelper.status}.`);
  app.quit();
})().catch(error => {
  if (ownedHelper) ownedHelper.kill();
  console.error('Runtime profile failed:', error.message);
  app.exit(1);
});
