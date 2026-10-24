"use strict";
const { app, BrowserWindow, screen } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = process.env.AIPET_SMOKE_APP_ROOT || path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function visible(instance) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (instance.getPet()?.isVisible()) return;
    await sleep(50);
  }
  throw new Error("Pet did not become visible");
}
(async () => {
  const instance = await require(path.join(root, "src/main.cjs")).ready;
  assert.equal(instance.getPet(), undefined);
  assert.equal(instance.getStudio(), undefined);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  assert.equal(instance.snapshot().visibility.reason, "dormant");
  instance.acceptPresence({
    foreground: "codex",
    running: ["codex"],
    fullscreen: null,
  });
  await visible(instance);
  assert.equal(instance.snapshot().activity.character, "gpt");
  const display = screen.getDisplayMatching(
    instance.getPet().getBounds(),
  ).bounds;
  instance.acceptPresence({
    foreground: "unknown",
    running: ["codex"],
    fullscreen: display,
  });
  assert.equal(instance.getPet(), null);
  assert.equal(instance.snapshot().visibility.reason, "fullscreen");
  instance.acceptPresence({
    foreground: "unknown",
    running: ["codex"],
    fullscreen: null,
  });
  await visible(instance);
  assert.equal(instance.snapshot().activity.character, "gpt");
  instance.hidePet();
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  instance.acceptPresence({
    foreground: "claude",
    running: ["claude"],
    fullscreen: null,
  });
  assert.equal(instance.getPet(), null);
  assert.equal(instance.snapshot().visibility.reason, "hidden");
  instance.resumeAutomatic();
  await visible(instance);
  instance.activity.sessions.clear();
  instance.acceptPresence({
    foreground: "unknown",
    running: [],
    fullscreen: null,
  });
  instance.presence.lastSeen = -Infinity;
  instance.refreshVisibility();
  assert.equal(instance.getPet(), null);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  const at = new Date().toISOString();
  instance.activity.ingest({
    version: 1,
    provider: "claude",
    state: "thinking",
    session: "1234567890abcdef1234567890abcdef",
    at,
  });
  instance.refreshVisibility();
  await visible(instance);
  assert.equal(instance.snapshot().activity.state, "thinking");
  const original = instance.snapshot().settings.position;
  instance.showPet(true);
  assert.ok(Number.isInteger(instance.snapshot().settings.position.x));
  assert.ok(original);
  const enabled = await instance.setStartup(true);
  assert.equal(enabled.startup.enabled, true);
  assert.equal((await instance.setStartup(false)).startup.enabled, false);
  console.log(
    "Lifecycle smoke passed: zero-window tray dormancy, process/hook wake, fullscreen suppression, manual hide, automatic resume, disposal, recovery and isolated startup toggle.",
  );
  app.exit(0);
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
