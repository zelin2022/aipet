"use strict";
const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  screen,
  globalShortcut,
  session,
  powerMonitor,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { spawn } = require("node:child_process");
const { Activity, STATES } = require("./core/activity.cjs");
const { sanitizeSettings, clampBounds } = require("./core/settings.cjs");
const { InboxReader } = require("./core/inbox.cjs");
const { Presence } = require("./core/presence.cjs");
const startup = require("./core/startup.cjs");
const { launchSpec } = require("./core/deployment.cjs");
const { dataDirectory, eventDirectories } = require("./core/data.cjs");
const diagnostics = require("./core/diagnostics.cjs");
const debugLog = require("./core/debug-log.cjs");
const { prepareHookExample, prepareBundledHookExample } = require("./core/hook-commands.cjs");
const { readCustomArtwork } = require("./core/artwork.cjs");
const { createSpriteUsage } = require("./core/sprite-usage.cjs");
const { createSpriteCatalog } = require("./core/sprite-catalog.cjs");
const ROOT = path.resolve(__dirname, "..");
const TEST = process.env.AIPET_DESKTOP_TEST === "1" && !app.isPackaged;
const BACKGROUND = process.argv.includes("--background");
const DATA = TEST ? process.env.AIPET_TEST_DATA : dataDirectory();
app.setPath("userData", DATA);
app.setAppUserModelId("personal.aipet.desktop");
for (const flag of [
  "disable-background-networking",
  "disable-component-update",
  "disable-domain-reliability",
  "disable-sync",
])
  app.commandLine.appendSwitch(flag);
app.commandLine.appendSwitch(
  "disable-features",
  "MediaRouter,OptimizationHints,AutofillServerCommunication",
);
let pet,
  petReady = false,
  studio,
  tray,
  settings,
  foreground,
  foregroundBuffer = "",
  quitting = false,
  saveTimer,
  pollTimer,
  dragTimer,
  dockSide = null;
let preview = null,
  foregroundStatus = "off",
  shortcutAvailable = false,
  lastBroadcast = "";
let startupState = { enabled: false, registered: false, error: null };
let debugControl = null,
  debugRendererTimer,
  debugActivationTimer,
  debugWrites = Promise.resolve(),
  debugPending = 0,
  lastDebugMain = "",
  lastDebugRenderer = "";
const DEBUG_DOM_PROBE = "Array.from(document.querySelectorAll('.companion-slot[data-provider]')).filter(slot => !slot.hidden).slice(0, 2).map(slot => ({provider: slot.dataset.provider, state: slot.dataset.state}))";
function hasDebugArgument(args) {
  return args.some((arg) => typeof arg === "string" && (arg === "--aipet-debug" || arg.startsWith("--aipet-debug=")));
}
function debugRequest(args) {
  const flags = args.filter((arg) => typeof arg === "string" && (arg === "--aipet-debug" || arg.startsWith("--aipet-debug=")));
  const match = flags.length === 1 && /^--aipet-debug=(start|stop):([a-f0-9]{32})$/.exec(flags[0]);
  if (match) return { action: match[1], nonce: match[2] };
  const window = flags.length === 1 && /^--aipet-debug=window:([a-f0-9]{32}):(\d{13}):(\d{13})$/.exec(flags[0]);
  if (!window) return null;
  try { return { action: "window", nonce: window[1], startsAt: new Date(Number(window[2])).toISOString(), expiresAt: new Date(Number(window[3])).toISOString() }; }
  catch { return null; }
}
function debugging() {
  return debugLog.isDebugActive(debugControl, Date.now());
}
function armDebugActivation() {
  clearTimeout(debugActivationTimer);
  if (!debugControl?.enabled || !settings) return;
  if (debugging()) {
    lastDebugMain = "";
    lastDebugRenderer = "";
    recordDebugSnapshot(snapshot());
    return;
  }
  const delay = Date.parse(debugControl.startsAt) - Date.now();
  if (!Number.isFinite(delay) || delay <= 0) return;
  const nonce = debugControl.nonce;
  debugActivationTimer = setTimeout(() => {
    if (!quitting && debugControl?.nonce === nonce) armDebugActivation();
  }, Math.min(delay + 2, 2147483647));
}
function recordDebug(phase, provider, state, eventAt = null) {
  if (!debugging() || debugPending >= 64) return;
  const nonce = debugControl.nonce;
  debugPending++;
  debugWrites = debugWrites.then(() => debugging() && debugControl.nonce === nonce
    ? debugLog.appendDebug(DATA, { phase, provider, state, workspace: null, eventAt }) : false)
    .catch(() => {}).finally(() => { debugPending--; });
}
function recordDebugSnapshot(value) {
  if (!debugging()) return;
  const companions = value.companions.slice(0, 2).map(({ provider, state, sessions }) => ({
    provider, state,
    eventAt: (Array.isArray(sessions) ? sessions : []).filter((item) => item.provider === provider)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]?.at || null,
  }));
  const signature = JSON.stringify(companions.map(({ provider, state }) => ({ provider, state })));
  if (signature === lastDebugMain) return;
  lastDebugMain = signature;
  for (const item of companions) recordDebug("main-state", item.provider, item.state, item.eventAt);
  clearTimeout(debugRendererTimer);
  const nonce = debugControl.nonce;
  debugRendererTimer = setTimeout(async () => {
    const win = pet;
    if (!debugging() || debugControl.nonce !== nonce || !win || win.isDestroyed()
      || win.webContents.isDestroyed() || win.webContents.isLoading()) return;
    let timer;
    try {
      const result = await Promise.race([
        win.webContents.executeJavaScript(DEBUG_DOM_PROBE),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), 750); }),
      ]);
      if (!debugging() || debugControl.nonce !== nonce || !Array.isArray(result) || result.length > 2) return;
      if (!result.every((item) => item && Object.keys(item).sort().join(",") === "provider,state"
        && ["claude", "codex"].includes(item.provider) && typeof item.state === "string")) return;
      const rendered = JSON.stringify(result);
      if (rendered === lastDebugRenderer) return;
      lastDebugRenderer = rendered;
      for (const item of result) recordDebug("renderer-state", item.provider, item.state, companions.find((candidate) => candidate.provider === item.provider)?.eventAt || null);
    } catch {} finally { clearTimeout(timer); }
  }, 120);
}
async function requestDebug(action, nonce) {
  if (!["start", "stop"].includes(action) || !/^[a-f0-9]{32}$/.test(nonce || "")) return null;
  debugControl = await debugLog.setDebug(DATA, { enabled: action === "start", nonce });
  clearTimeout(debugActivationTimer);
  clearTimeout(debugRendererTimer);
  lastDebugMain = "";
  lastDebugRenderer = "";
  if (action === "start") recordDebugSnapshot(snapshot());
  return debugControl;
}
async function requestDebugWindow(nonce, startsAt, expiresAt) {
  if (!/^[a-f0-9]{32}$/.test(nonce || "")) return null;
  debugControl = await debugLog.setDebugWindow(DATA, { nonce, startsAt, expiresAt });
  clearTimeout(debugRendererTimer);
  lastDebugMain = "";
  lastDebugRenderer = "";
  armDebugActivation();
  return debugControl;
}
let visibility = {
  show: false,
  reason: "dormant",
  mode: "auto",
  providers: [],
};
const pollHealth = {
  lastStartedAt: null,
  lastFinishedAt: null,
  accepted: { claude: 0, codex: 0 },
  failure: "none",
};
const activity = new Activity(),
  presence = new Presence();
const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, "assets/crosspet/manifest.json"), "utf8"),
);
const customArtwork = readCustomArtwork(path.join(ROOT, "assets/custom"));
const customImages = new Set(customArtwork.images);
const characters = manifest.characters.filter((c) =>
  ["claude", "gpt"].includes(c.id),
).map((character) => ({
  ...character,
  customPoses: customArtwork.customPoses[character.id] || {},
  customMode: customArtwork.customModes[character.id],
  customBlink: customArtwork.customBlink[character.id] || null,
  customFraming: customArtwork.customFraming[character.id] || {},
}));
const eventDir = path.join(DATA, "events"),
  inboxes = eventDirectories(DATA, process.env, TEST).map(
    (directory) => new InboxReader(directory),
  );
const usageCatalog = createSpriteCatalog({
  characters,
  originals: JSON.parse(fs.readFileSync(path.join(ROOT, "assets/crosspet/provenance.json"), "utf8")).files,
  custom: customArtwork.imagePins,
});
const usageAssets = new Map(usageCatalog.map(asset => [asset.id, asset]));
const spriteUsage = createSpriteUsage({ directory: DATA, catalog: usageCatalog });
const usageBlocks = new Set();
let usageSaveTimer;
function usageVisible() {
  return !quitting && !usageBlocks.size && pet && !pet.isDestroyed() && pet.isVisible() && !pet.isMinimized();
}
function spriteUsageSnapshot() {
  if (!usageVisible()) spriteUsage.pause();
  return spriteUsage.snapshot();
}
function acceptSpriteUsage(items) {
  if (!Array.isArray(items) || items.length > 2) return false;
  if (!usageVisible()) { spriteUsage.pause(); return false; }
  const expected = new Map(companionActivities().companions.filter(item => !item.preview).map(item => [item.provider || (item.character === 'gpt' ? 'codex' : 'claude'), item.character]));
  const slots = [], seen = new Set();
  for (const item of items) {
    if (!item || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'provider,sprite'
      || !['claude', 'codex'].includes(item.provider) || seen.has(item.provider)
      || typeof item.sprite !== 'string' || item.sprite.length > 180) return false;
    const asset = usageAssets.get(item.sprite);
    if (!asset || asset.character !== expected.get(item.provider)) return false;
    seen.add(item.provider); slots.push({ slot: item.provider, id: item.sprite });
  }
  return spriteUsage.observe(slots);
}
const launch = launchSpec({
  packaged: app.isPackaged,
  executable: process.execPath,
  appDirectory: ROOT,
});
function companionCount() {
  return settings?.showBoth &&
    settings.followActivity &&
    ["claude", "codex"].every((provider) =>
      visibility.providers.includes(provider),
    )
    ? 2
    : 1;
}
function bundledHookRuntime() {
  // Packaged hooks use the same shipped vendor runtime on every computer.
  // Source development retains its existing explicit Node hook definitions.
  const executable = path.resolve(ROOT, "../..", "electron.exe");
  return path.basename(ROOT) === "app" && path.basename(path.dirname(ROOT)) === "resources"
    && fs.existsSync(executable) ? executable : null;
}
function companionActivities() {
  let current = activity.snapshot(settings, characters);
  if (settings.followActivity && visibility.providers.length === 1)
    current =
      activity.snapshotForProvider(visibility.providers[0], characters) ||
      current;
  if (preview && Date.now() < preview.until) {
    current.state = preview.state;
    current.preview = true;
  }
  const companions =
    companionCount() === 2
      ? ["claude", "codex"].map((provider) =>
          activity.snapshotForProvider(provider, characters),
        )
      : [current];
  if (companions.length === 2 && current.preview) {
    const target = companions.find(
      (item) => item.provider === current.provider,
    );
    if (target) {
      target.state = current.state;
      target.preview = true;
    }
  }
  return { current, companions };
}
function snapshot() {
  const { current, companions } = companionActivities();
  return {
    settings,
    activity: current,
    companions,
    characters,
    hidden: !pet || !pet.isVisible(),
    visibility,
    startup: startupState,
    dockSide,
    foregroundStatus,
    shortcutAvailable,
    dataDirectory: DATA,
    eventDirectory: eventDir,
    eventDirectories: inboxes.map((reader) => reader.directory),
    version: app.getVersion(),
  };
}
function broadcast(force = false) {
  if (!settings) return;
  const value = snapshot(),
    serialized = JSON.stringify(value);
  recordDebugSnapshot(value);
  if (!force && serialized === lastBroadcast) return;
  lastBroadcast = serialized;
  for (const win of [pet, studio])
    if (win && !win.isDestroyed()) win.webContents.send("aipet:changed", value);
  if (tray)
    tray.setToolTip(
      `Aipet · ${visibility.reason === "dormant" ? "Waiting for Claude Code or Codex" : visibility.reason === "hidden" ? "Hidden — resume from tray" : visibility.reason === "fullscreen" ? "Quiet during fullscreen" : "Keeping you company"}`,
    );
}
function persistNow() {
  if (!settings) return;
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(
      path.join(DATA, "settings.json.tmp"),
      JSON.stringify(settings, null, 2),
    );
    fs.renameSync(
      path.join(DATA, "settings.json.tmp"),
      path.join(DATA, "settings.json"),
    );
  } catch {}
}
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 200);
}
function secureWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
}
function webPreferences() {
  return {
    preload: path.join(__dirname, "preload.cjs"),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    webviewTag: false,
    spellcheck: false,
    backgroundThrottling: !TEST,
  };
}
function petBounds(reset = false) {
  const display =
    settings.position && !reset
      ? screen.getDisplayNearestPoint(settings.position)
      : screen.getPrimaryDisplay();
  const wa = display.workArea;
  const count = companionCount();
  const scale = Math.min(
    settings.size / 100,
    wa.width / (340 * count),
    wa.height / 410,
  );
  const width = Math.round(340 * count * scale),
    height = Math.round(410 * scale);
  const preferred =
    settings.position && !reset
      ? settings.position
      : { x: wa.x + wa.width - width - 32, y: wa.y + wa.height - height - 10 };
  return { ...clampBounds(preferred, wa, width, height), width, height };
}
function placePet(reset = false) {
  const bounds = petBounds(reset);
  if (pet && !pet.isDestroyed()) {
    const previous = pet.getBounds();
    if (
      !reset &&
      !dragTimer &&
      (previous.width !== bounds.width || previous.height !== bounds.height)
    ) {
      const area = screen.getDisplayMatching(bounds).workArea;
      Object.assign(
        bounds,
        clampBounds(
          {
            x: previous.x + previous.width - bounds.width,
            y: previous.y + previous.height - bounds.height,
          },
          area,
          bounds.width,
          bounds.height,
        ),
      );
    }
    if (
      ["x", "y", "width", "height"].some((key) => previous[key] !== bounds[key])
    )
      pet.setBounds(bounds);
  }
  const changed =
    settings.position?.x !== bounds.x || settings.position?.y !== bounds.y;
  settings.position = { x: bounds.x, y: bounds.y };
  if (changed) persist();
}
function createPet() {
  if (pet && !pet.isDestroyed()) return pet;
  const win = new BrowserWindow({
    ...petBounds(),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: settings.alwaysOnTop,
    backgroundColor: "#00000000",
    webPreferences: webPreferences(),
  });
  pet = win;
  petReady = false;
  secureWindow(win);
  placePet();
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(ROOT, "renderer/pet.html"));
  win.once("ready-to-show", () => {
    if (pet !== win) return;
    petReady = true;
    if (debugging()) lastDebugMain = "";
    refreshVisibility();
  });
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      hidePet();
    }
  });
  win.on("closed", () => {
    if (pet === win) {
      spriteUsage.pause();
      pet = null;
      petReady = false;
    }
  });
  win.on("hide", () => spriteUsage.pause());
  win.on("minimize", () => spriteUsage.pause());
  win.webContents.on("render-process-gone", () => spriteUsage.pause());
  win.webContents.on("did-start-loading", () => spriteUsage.pause());
  return win;
}
function refreshVisibility() {
  if (!settings || quitting) return;
  visibility = presence.decide({
    settings,
    activityProviders: activity.presentProviders(
      Date.now(),
      foregroundStatus === "on" ? 10000 : undefined,
    ),
    bounds: pet && !pet.isDestroyed() ? pet.getBounds() : petBounds(),
    preview: !!preview && Date.now() < preview.until,
  });
  if (visibility.show) {
    createPet();
    if (!dragTimer) placePet();
    if (petReady && !pet.isVisible()) pet.showInactive();
  } else if (pet && !pet.isDestroyed()) {
    spriteUsage.pause();
    if (dragTimer) finishDrag();
    pet.destroy();
    pet = null;
    petReady = false;
  }
  broadcast();
}
function showPet(reset = false) {
  presence.setMode("shown");
  if (reset) {
    dockSide = null;
    placePet(true);
    persist();
  }
  refreshVisibility();
  broadcast(true);
}
function hidePet() {
  presence.setMode("hidden");
  preview = null;
  refreshVisibility();
  broadcast(true);
}
function resumeAutomatic() {
  presence.setMode("auto");
  refreshVisibility();
  broadcast(true);
}
function openStudio() {
  if (studio && !studio.isDestroyed()) {
    studio.show();
    studio.focus();
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    width: Math.min(1120, area.width),
    height: Math.min(860, area.height),
    minWidth: Math.min(920, area.width),
    minHeight: Math.min(680, area.height),
    show: false,
    title: "Aipet · Companion studio",
    backgroundColor: "#13161b",
    autoHideMenuBar: true,
    icon: path.join(ROOT, "renderer/icon.png"),
    webPreferences: webPreferences(),
  });
  studio = win;
  secureWindow(win);
  win.loadFile(path.join(ROOT, "renderer/studio.html"));
  win.once("ready-to-show", () => {
    if (!TEST) win.show();
  });
  win.on("closed", () => {
    studio = null;
  });
}
function contextMenu(provider) {
  if (provider !== undefined && !["claude", "codex"].includes(provider)) return;
  Menu.buildFromTemplate([
    {
      label:
        visibility.reason === "dormant"
          ? "Waiting for Claude Code or Codex"
          : visibility.reason === "hidden"
            ? "Pet hidden until you resume"
            : "Companion is awake",
      enabled: false,
    },
    { label: "Open companion studio", click: openStudio },
    { label: "Bring pet home", click: () => showPet(true) },
    {
      label: pet?.isVisible()
        ? "Hide pet · Ctrl+Alt+P"
        : "Show pet · Ctrl+Alt+P",
      click: () => (pet?.isVisible() ? hidePet() : showPet()),
    },
    { label: "Resume automatic wake/sleep", click: resumeAutomatic },
    { type: "separator" },
    { label: "Pat on the head", click: () => interact("pat", provider) },
    { label: "Play", click: () => interact("poke", provider) },
    {
      label: "Wait in tray for AI",
      type: "checkbox",
      checked: settings.autoDormant,
      click: (item) => updateSettings({ autoDormant: item.checked }),
    },
    {
      label: "Follow AI activity",
      type: "checkbox",
      checked: settings.followActivity,
      click: (item) => updateSettings({ followActivity: item.checked }),
    },
    {
      label: "Show both when both apps are open",
      type: "checkbox",
      checked: settings.showBoth,
      enabled: settings.followActivity,
      click: (item) => updateSettings({ showBoth: item.checked }),
    },
    {
      label: "Start at Windows sign-in",
      type: "checkbox",
      checked: startupState.registered,
      click: (item) => setStartup(item.checked).catch(() => {}),
    },
    {
      label: "Character",
      submenu: characters.map((c) => ({
        label: c.id === "gpt" ? "ChatGPT" : c.name,
        type: "radio",
        checked: settings.character === c.id,
        click: () => updateSettings({ character: c.id, followActivity: false }),
      })),
    },
    { type: "separator" },
    { label: "Quit Aipet", click: () => app.quit() },
  ]).popup();
}
function interact(action, provider) {
  if (!["pat", "poke"].includes(action)) return;
  if (provider !== undefined && !["claude", "codex"].includes(provider)) return;
  const { current, companions } = companionActivities();
  const target = provider || current.provider;
  if (!companions.some((item) => item.provider === target)) return;
  activity.touchProvider(target);
  preview = null;
  if (!pet?.isVisible()) showPet();
  pet?.webContents.send("aipet:interaction", { action, provider: target });
  broadcast(true);
}
function updateSettings(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("Invalid settings");
  const allowed = [
    "character",
    "followActivity",
    "showBoth",
    "foregroundEnabled",
    "autoDormant",
    "fullscreenHide",
    "alwaysOnTop",
    "edgeDock",
    "reducedMotion",
    "size",
  ];
  const filtered = Object.fromEntries(
    Object.entries(patch).filter(([key]) => allowed.includes(key)),
  );
  const previous = settings;
  settings = sanitizeSettings(
    { ...settings, ...filtered },
    characters.map((c) => c.id),
  );
  if (pet) {
    pet.setAlwaysOnTop(settings.alwaysOnTop, "floating");
    if (settings.size !== previous.size) placePet();
  }
  if (!settings.edgeDock) dockSide = null;
  if (
    [
      "foregroundEnabled",
      "followActivity",
      "autoDormant",
      "fullscreenHide",
    ].some((key) => settings[key] !== previous[key])
  )
    startForeground();
  if (settings.character !== previous.character) {
    preview = null;
    activity.touch();
  }
  persist();
  refreshVisibility();
  broadcast(true);
  return snapshot();
}
async function setStartup(enabled) {
  if (typeof enabled !== "boolean") throw new Error("Invalid startup choice");
  startupState = TEST
    ? { enabled, registered: enabled, error: null }
    : await startup.set(enabled, launch);
  broadcast(true);
  return snapshot();
}
function acceptPresence(value, physical = false) {
  const previous = presence.metadata.running;
  if (!presence.update(value)) return false;
  if (physical && presence.metadata.fullscreen)
    presence.metadata.fullscreen = screen.screenToDipRect(
      null,
      presence.metadata.fullscreen,
    );
  activity.setRunning(presence.metadata.running);
  for (const provider of presence.metadata.running)
    if (!previous.includes(provider)) activity.touchProvider(provider);
  activity.setForeground(
    settings.followActivity ? presence.metadata.foreground : null,
  );
  foregroundStatus = "on";
  refreshVisibility();
  return true;
}
function startForeground() {
  if (foreground) {
    foreground.kill();
    foreground = null;
  }
  foregroundBuffer = "";
  activity.setForeground(null);
  activity.setRunning([]);
  presence.metadata = { foreground: null, running: [], fullscreen: null };
  const needed =
    settings.foregroundEnabled &&
    (settings.followActivity ||
      settings.autoDormant ||
      settings.fullscreenHide);
  foregroundStatus = needed ? "unavailable" : "off";
  if (!needed || process.platform !== "win32" || TEST) return;
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  const child = spawn(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(__dirname, "foreground.ps1"),
    ],
    { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "ignore"] },
  );
  foreground = child;
  child.stdout.on("data", (chunk) => {
    if (foreground !== child) return;
    foregroundBuffer += chunk.toString("utf8");
    if (foregroundBuffer.length > 4096) {
      foregroundBuffer = "";
      return;
    }
    let newline;
    while ((newline = foregroundBuffer.indexOf("\n")) >= 0) {
      const line = foregroundBuffer.slice(0, newline).trim();
      foregroundBuffer = foregroundBuffer.slice(newline + 1);
      if (line.length > 1024) continue;
      try {
        acceptPresence(JSON.parse(line), true);
      } catch {}
    }
  });
  const unavailable = () => {
    if (foreground === child) {
      foreground = null;
      foregroundStatus = "unavailable";
      activity.setForeground(null);
      activity.setRunning([]);
      presence.metadata = { foreground: null, running: [], fullscreen: null };
      refreshVisibility();
    }
  };
  child.on("error", unavailable);
  child.on("exit", unavailable);
}
async function pollEvents() {
  pollHealth.lastStartedAt = new Date().toISOString();
  try {
    const results = await Promise.all(
      inboxes.map((reader) =>
        reader.poll((event, now) => {
          const accepted = activity.ingest(event, now);
          if (accepted) {
            pollHealth.accepted[event.provider] = Math.min(
              2147483647,
              pollHealth.accepted[event.provider] + 1,
            );
            recordDebug("inbox-accepted", event.provider, event.state, event.at);
          }
          return accepted;
        }),
      ),
    );
    if (results.some((result) => !result.busy)) refreshVisibility();
    pollHealth.failure = "none";
    return results;
  } catch {
    pollHealth.failure = "poll-error";
    throw new Error("poll-error");
  } finally {
    pollHealth.lastFinishedAt = new Date().toISOString();
  }
}
async function tick(reschedule = true) {
  if (quitting) return;
  try {
    await pollEvents();
  } catch {
    // A transient polling or window failure must not stop future activity updates.
  } finally {
    if (reschedule && !quitting)
      pollTimer = setTimeout(tick, visibility.show || studio ? 750 : 2000);
  }
}
async function requestStatus(requestId) {
  const value = await diagnostics.collectDiagnostics({
    requestId,
    pollHealth,
    providerEvents: activity.events(Date.now()),
    companions: snapshot().companions,
    pet,
    visibility,
    windowCount: [pet, studio].filter((win) => win && !win.isDestroyed()).length,
  });
  await diagnostics.writeStatus(DATA, value);
  return value;
}
function finishDrag() {
  clearInterval(dragTimer);
  dragTimer = null;
  if (!pet || pet.isDestroyed()) return;
  const bounds = pet.getBounds(),
    wa = screen.getDisplayMatching(bounds).workArea;
  const position = clampBounds(bounds, wa, bounds.width, bounds.height);
  dockSide = settings.edgeDock
    ? position.x <= wa.x + 18
      ? "left"
      : position.x + bounds.width >= wa.x + wa.width - 18
        ? "right"
        : null
    : null;
  pet.setPosition(position.x, position.y);
  settings.position = position;
  persist();
  broadcast(true);
}
function startDrag() {
  if (dragTimer || !pet) return;
  dockSide = null;
  broadcast(true);
  const start = screen.getCursorScreenPoint(),
    bounds = pet.getBounds(),
    since = Date.now();
  pet.setIgnoreMouseEvents(false);
  dragTimer = setInterval(() => {
    if (!pet || Date.now() - since > 20000) return finishDrag();
    const point = screen.getCursorScreenPoint();
    pet.setPosition(bounds.x + point.x - start.x, bounds.y + point.y - start.y);
  }, 16);
}
function installIpc() {
  const valid = (event) =>
    [pet, studio].some(
      (win) =>
        win &&
        !win.isDestroyed() &&
        event.sender === win.webContents &&
        event.senderFrame === win.webContents.mainFrame,
    );
  const handle = (name, fn) =>
    ipcMain.handle(name, (event, ...args) => {
      if (!valid(event)) throw new Error("Untrusted sender");
      return fn(event, ...args);
    });
  const on = (name, fn) =>
    ipcMain.on(name, (event, ...args) => {
      if (valid(event)) fn(event, ...args);
    });
  handle("aipet:snapshot", () => snapshot());
  handle("aipet:sprite-usage", () => spriteUsageSnapshot());
  handle("aipet:sprite-usage-reset", async (event) => {
    if (!studio || event.sender !== studio.webContents) throw new Error("Untrusted sender");
    if (!usageVisible()) spriteUsage.pause();
    spriteUsage.reset();
    await spriteUsage.flush();
    return spriteUsageSnapshot();
  });
  handle("aipet:sprite-usage-report", (event, items) => {
    if (!pet || event.sender !== pet.webContents) throw new Error("Untrusted sender");
    return acceptSpriteUsage(items);
  });
  handle("aipet:startup", (_event, enabled) => setStartup(enabled));
  handle("aipet:setup", (_event, provider) => {
    if (!["claude", "codex"].includes(provider))
      throw new Error("Unknown provider");
    const bundled = bundledHookRuntime();
    return {
      runtime: bundled ? "bundled" : "node",
      example:
        JSON.stringify(
          (bundled ? prepareBundledHookExample : prepareHookExample)(
            provider,
            fs.readFileSync(
              path.join(ROOT, "integrations", `${provider}-hooks.example.json`),
              "utf8",
            ),
            ROOT,
          ),
          null,
          2,
        ) + "\n",
      guide: fs.readFileSync(path.join(ROOT, "docs/integrations.md"), "utf8"),
    };
  });
  handle("aipet:settings", (_event, patch) => updateSettings(patch));
  handle("aipet:preview", (_event, state) => {
    if ((!STATES.has(state) || state === "offline") && state !== "sleeping")
      throw new Error("Unknown state");
    preview = { state, until: Date.now() + 8000 };
    if (presence.mode === "hidden") presence.setMode("auto");
    refreshVisibility();
    broadcast(true);
    return snapshot();
  });
  on("aipet:studio", openStudio);
  on("aipet:show", () => showPet());
  on("aipet:home", () => showPet(true));
  on("aipet:hide", hidePet);
  on("aipet:auto", resumeAutomatic);
  on("aipet:menu", (_event, provider) => contextMenu(provider));
  on("aipet:interact", (_event, action, provider) =>
    interact(action, provider),
  );
  on("aipet:hit", (event, hit) => {
    if (
      pet &&
      event.sender === pet.webContents &&
      typeof hit === "boolean" &&
      !dragTimer
    )
      pet.setIgnoreMouseEvents(!hit, { forward: true });
  });
  on("aipet:drag", (event, phase) => {
    if (!pet || event.sender !== pet.webContents) return;
    if (phase === "start") startDrag();
    else if (phase === "end") finishDrag();
  });
}
async function boot() {
  if (process.platform !== "win32")
    throw new Error("Aipet currently supports Windows only.");
  fs.mkdirSync(eventDir, { recursive: true });
  await spriteUsage.load();
  try { if (powerMonitor.getSystemIdleState(1) === 'locked') usageBlocks.add('lock'); } catch {}
  for (const [event, block, paused] of [['suspend', 'suspend', true], ['resume', 'suspend', false], ['lock-screen', 'lock', true], ['unlock-screen', 'lock', false]]) {
    powerMonitor.on(event, () => {
      if (paused) usageBlocks.add(block); else usageBlocks.delete(block);
      spriteUsage.pause();
      if (paused) void spriteUsage.flush();
    });
  }
  usageSaveTimer = setInterval(() => { if (!quitting) void spriteUsage.flush(); }, 30000);
  debugControl = await debugLog.readDebugControl(DATA).catch(() => null);
  let stored = null;
  try {
    for (const directory of [
      DATA,
      ...inboxes.map((reader) => path.dirname(reader.directory)),
    ]) {
      const file = path.join(directory, "settings.json");
      try {
        const stat = fs.lstatSync(file);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 16384) {
          stored = JSON.parse(fs.readFileSync(file, "utf8"));
          break;
        }
      } catch {}
    }
  } catch {}
  settings = sanitizeSettings(
    stored,
    characters.map((c) => c.id),
  );
  armDebugActivation();
  placePet();
  persist();
  if (TEST && !BACKGROUND) presence.setMode("shown");
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
  ses.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const candidate = fileURLToPath(details.url);
      allowed = [
        path.join(ROOT, "renderer") + path.sep,
        path.join(ROOT, "assets/crosspet") + path.sep,
      ].some((prefix) => path.resolve(candidate).startsWith(prefix)) || customImages.has(path.resolve(candidate));
    } catch {}
    callback({ cancel: !allowed });
  });
  installIpc();
  if (!TEST) {
    tray = new Tray(
      nativeImage.createFromPath(path.join(ROOT, "renderer/icon.png")),
    );
    tray.on("right-click", () => contextMenu());
    tray.on("click", openStudio);
    tray.on("double-click", () => showPet(true));
    shortcutAvailable = globalShortcut.register("CommandOrControl+Alt+P", () =>
      pet?.isVisible() ? hidePet() : showPet(),
    );
    startupState = await startup.get(launch);
  }
  startForeground();
  await tick(false);
  pollTimer = setTimeout(tick, visibility.show ? 750 : 2000);
  screen.on("display-removed", () => {
    placePet();
    refreshVisibility();
  });
  screen.on("display-metrics-changed", () => {
    if (!dragTimer) {
      placePet();
      refreshVisibility();
    }
  });
  if (
    (!BACKGROUND && !stored) ||
    process.argv.includes("--studio") ||
    (TEST && !BACKGROUND)
  )
    openStudio();
  return {
    getPet: () => pet,
    getStudio: () => studio,
    snapshot,
    pollEvents,
    updateSettings,
    showPet,
    hidePet,
    resumeAutomatic,
    openStudio,
    activity,
    presence,
    acceptPresence,
    refreshVisibility,
    setStartup,
    requestStatus,
    ...(TEST
      ? {
          runTickOnce: () => tick(false),
          getPollHealth: () => ({
            ...pollHealth,
            accepted: { ...pollHealth.accepted },
          }),
          requestDebug,
          requestDebugWindow,
          getSpriteUsage: spriteUsageSnapshot,
          flushSpriteUsage: () => spriteUsage.flush(),
        }
      : {}),
    dataDirectory: DATA,
  };
}
app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  spriteUsage.pause();
  // The aggregate uses bounded synchronous file operations inside flush, so the
  // final atomic write completes before this quit listener returns.
  void spriteUsage.flush();
  quitting = true;
  clearInterval(usageSaveTimer);
  clearTimeout(pollTimer);
  clearInterval(dragTimer);
  clearTimeout(saveTimer);
  clearTimeout(debugRendererTimer);
  clearTimeout(debugActivationTimer);
  if (foreground) foreground.kill();
  globalShortcut.unregisterAll();
  persistNow();
});
// These launcher processes have not booted or created resources to clean up.
// Exit immediately: app.quit() before ready can leave a headless process alive.
if (
  (diagnostics.hasStatusArgument(process.argv) || hasDebugArgument(process.argv)) &&
  !fs.existsSync(DATA)
)
  app.exit(0);
else if (!TEST && !app.requestSingleInstanceLock()) app.exit(0);
else if (
  process.argv.includes("--quit") ||
  diagnostics.hasStatusArgument(process.argv) || hasDebugArgument(process.argv)
)
  app.exit(0);
else {
  app.on("second-instance", (_event, args) => {
    if (hasDebugArgument(args)) {
      const request = debugRequest(args);
      const requestId = diagnostics.requestIdFromArguments(args);
      module.exports.ready.then(async () => {
        if (request && requestId === request.nonce) {
          if (request.action === "window") await requestDebugWindow(request.nonce, request.startsAt, request.expiresAt);
          else await requestDebug(request.action, request.nonce);
        }
        if (requestId) await requestStatus(requestId);
      }).catch(() => {});
      return;
    }
    if (diagnostics.hasStatusArgument(args)) {
      const requestId = diagnostics.requestIdFromArguments(args);
      if (requestId)
        module.exports.ready.then(() => requestStatus(requestId)).catch(() => {});
      return;
    }
    if (args.includes("--quit")) return app.quit();
    if (args.includes("--background")) return;
    if (args.includes("--resume")) return resumeAutomatic();
    showPet(true);
    openStudio();
  });
  module.exports.ready = app.whenReady().then(boot);
}
